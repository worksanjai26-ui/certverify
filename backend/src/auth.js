import crypto from 'node:crypto';
import { checkPassword, sha256 } from './crypto.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export function createAuth(db, cfg) {
  // Per server instance; on Vercel each warm instance keeps its own count.
  const failures = new Map();

  async function login(email, password, ip) {
    const key = ip || 'unknown';
    const now = Date.now();
    let f = failures.get(key);
    if (f && now - f.first > WINDOW_MS) f = undefined;
    if (f && f.count >= MAX_FAILURES) {
      return { status: 429, error: 'Too many failed attempts. Try again in a few minutes.' };
    }

    const user = await db.get('SELECT * FROM users WHERE email = ?', String(email ?? '').trim().toLowerCase());
    if (!user || !checkPassword(String(password ?? ''), user.password_hash)) {
      f = f ?? { count: 0, first: now };
      f.count += 1;
      failures.set(key, f);
      return { status: 401, error: 'Invalid email or password.' };
    }
    failures.delete(key);

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + cfg.sessionHours * 3600 * 1000).toISOString();
    await db.run('DELETE FROM sessions WHERE expires_at < ?', new Date(now).toISOString());
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), user.id, expiresAt);
    return { token, user: { id: user.id, email: user.email, name: user.name } };
  }

  async function requireAdmin(req, res, next) {
    const match = (req.get('authorization') || '').match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: 'Sign in required.' });
    const tokenHash = sha256(match[1]);
    const s = await db.get(
      `SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      tokenHash,
    );
    if (!s || s.expires_at < new Date().toISOString()) {
      return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
    }
    req.user = { id: s.id, email: s.email, name: s.name };
    req.tokenHash = tokenHash;
    next();
  }

  const logout = (tokenHash) => db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);

  return { login, requireAdmin, logout };
}
