import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'certverify.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function seed(db, cfg) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      cfg.adminEmail,
      'Registrar',
      hashPassword(cfg.adminPassword),
      new Date().toISOString(),
    );
    console.log(`[seed] created registrar account ${cfg.adminEmail} (password from ADMIN_PASSWORD / .env.example)`);
  }
}

// Registrar actions (sign-in, uploads, revocations). Public checks go to `verifications`.
export function audit(db, { action, certId = null, detail = null, actor = null, ip = null }) {
  db.prepare('INSERT INTO audit_events (at, action, cert_id, detail, actor, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
    new Date().toISOString(),
    action,
    certId ?? null,
    detail ?? null,
    actor ?? null,
    ip ?? null,
  );
}
