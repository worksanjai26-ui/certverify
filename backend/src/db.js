import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './crypto.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  student_name TEXT NOT NULL,
  roll_no TEXT NOT NULL,
  program TEXT NOT NULL,
  department TEXT NOT NULL,
  graduation_year INTEGER NOT NULL,
  payload TEXT NOT NULL,              -- canonical JSON that was signed (includes document_hash)
  signature TEXT NOT NULL,            -- Ed25519 over payload, base64url
  key_id TEXT NOT NULL,
  document_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the scanned copy exactly as uploaded
  document_type TEXT NOT NULL,
  document_name TEXT,
  original BLOB NOT NULL,             -- the scanned copy as uploaded
  stamped_hash TEXT NOT NULL,         -- SHA-256 of the scan + QR verification page
  stamped BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  issued_at TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS certificates_stamped_hash ON certificates(stamped_hash);
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  cert_id TEXT,
  verdict TEXT NOT NULL,
  method TEXT NOT NULL,
  verifier_name TEXT NOT NULL,
  verifier_org TEXT NOT NULL,
  verifier_email TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS verifications_cert ON verifications(cert_id);
-- Raised when a verification finds malpractice; the registrar acknowledges them in the admin panel.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  verification_id INTEGER,
  cert_id TEXT,
  verdict TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  findings TEXT NOT NULL,             -- JSON array of { severity, code, message }
  verifier_name TEXT,
  verifier_org TEXT,
  verifier_email TEXT,
  ip TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS alerts_open ON alerts(acknowledged_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  cert_id TEXT,
  detail TEXT,
  actor TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_cert ON audit_events(cert_id);
`;

const toObjects = (rs) => rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])));
const nullify = (args) => args.map((a) => a ?? null);

// Both backends expose the same small async API: `await db.get(sql, ...args)`, all, run, exec, close.

// Turso / libSQL over HTTP (pure fetch, so serverless bundles need no native binaries).
async function openTurso(cfg) {
  const { createClient } = await import('@libsql/client/web');
  const client = createClient({ url: cfg.databaseUrl, authToken: cfg.databaseAuthToken ?? undefined });
  const execute = (sql, args) => client.execute({ sql, args: nullify(args) });
  return {
    get: async (sql, ...args) => toObjects(await execute(sql, args))[0],
    all: async (sql, ...args) => toObjects(await execute(sql, args)),
    run: async (sql, ...args) => {
      const r = await execute(sql, args);
      return { rowsAffected: r.rowsAffected, lastInsertRowid: r.lastInsertRowid };
    },
    exec: (sql) => client.executeMultiple(sql),
    close: () => client.close(),
  };
}

// A SQLite file on local disk, via Node's built-in driver: backend/data locally,
// the instance's temporary directory on Vercel when no Turso database is configured.
async function openFile(cfg) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const sqlite = new DatabaseSync(path.join(cfg.dataDir, 'certverify.db'));
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return {
    get: async (sql, ...args) => sqlite.prepare(sql).get(...nullify(args)),
    all: async (sql, ...args) => sqlite.prepare(sql).all(...nullify(args)),
    run: async (sql, ...args) => {
      const r = sqlite.prepare(sql).run(...nullify(args));
      return { rowsAffected: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    exec: async (sql) => sqlite.exec(sql),
    close: () => sqlite.close(),
  };
}

export async function openDb(cfg) {
  const db = cfg.databaseUrl ? await openTurso(cfg) : await openFile(cfg);
  await db.exec(SCHEMA);
  await migrate(db);
  return db;
}

// Columns added after the first release; existing databases get them on startup.
const ADDED_COLUMNS = [
  ['verifications', 'malpractice', 'INTEGER NOT NULL DEFAULT 0'],
  ['verifications', 'findings', 'TEXT'],
];

async function migrate(db) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    if (!cols.some((c) => c.name === column)) {
      try {
        await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (e) {
        if (!/duplicate column/i.test(e.message)) throw e; // another instance got there first
      }
    }
  }
}

export async function seed(db, cfg) {
  if ((await db.get('SELECT COUNT(*) AS n FROM users')).n === 0) {
    // OR IGNORE: two cold-starting instances may both get here.
    const r = await db.run(
      'INSERT OR IGNORE INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
      cfg.adminEmail,
      'Registrar',
      hashPassword(cfg.adminPassword),
      new Date().toISOString(),
    );
    if (r.rowsAffected) console.log(`[seed] created registrar account ${cfg.adminEmail} (password from ADMIN_PASSWORD)`);
  }
}

// Registrar actions (sign-in, uploads, revocations). Public checks go to `verifications`.
export function audit(db, { action, certId = null, detail = null, actor = null, ip = null }) {
  return db.run(
    'INSERT INTO audit_events (at, action, cert_id, detail, actor, ip) VALUES (?, ?, ?, ?, ?, ?)',
    new Date().toISOString(),
    action,
    certId ?? null,
    detail ?? null,
    actor ?? null,
    ip ?? null,
  );
}
