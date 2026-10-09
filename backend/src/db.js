import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

// Thin async wrapper so the rest of the code reads `await db.get(sql, ...args)`.
function wrap(client) {
  const exec = (sql, args) => client.execute({ sql, args: args.map((a) => a ?? null) });
  return {
    get: async (sql, ...args) => toObjects(await exec(sql, args))[0],
    all: async (sql, ...args) => toObjects(await exec(sql, args)),
    run: (sql, ...args) => exec(sql, args),
    close: () => client.close(),
  };
}

// Turso in production (TURSO_DATABASE_URL); a local SQLite file otherwise. Same SQL either way.
export async function openDb(cfg) {
  let url = cfg.databaseUrl;
  if (!url) {
    if (cfg.onVercel) throw new Error('TURSO_DATABASE_URL is not set. Vercel has no persistent disk for a local database.');
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    url = pathToFileURL(path.join(cfg.dataDir, 'certverify.db')).href;
  }
  const local = url.startsWith('file:');
  // The web client is pure fetch, so serverless bundles need no native binaries.
  const { createClient } = await import(local ? '@libsql/client' : '@libsql/client/web');
  const client = createClient({ url, authToken: cfg.databaseAuthToken ?? undefined });
  if (local) await client.execute('PRAGMA journal_mode = WAL');
  await client.executeMultiple(SCHEMA);
  return wrap(client);
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
