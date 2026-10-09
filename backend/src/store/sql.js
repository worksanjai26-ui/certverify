// Storage on SQLite (local file / Vercel temp disk) or Turso, through the small db wrapper in ../db.js.
// Every method returns plain objects whose fields match the column names (snake_case).
import { openDb } from '../db.js';

const VERDICTS = ['verified', 'tampered', 'invalid_signature', 'revoked', 'review', 'not_found'];

// Columns for lists and detail views; leaves out the two file blobs.
const CERT_COLUMNS = `id, student_name, roll_no, program, department, graduation_year, payload, signature, key_id,
  document_hash, document_type, document_name, stamped_hash, status, issued_at, issued_by, revoked_at, revoke_reason, revoked_by`;

export const uniqueViolation = (e, column) => /UNIQUE constraint failed/i.test(e?.message) && e.message.includes(column);

export class SqlStore {
  kind = 'sql';

  static async open(cfg) {
    const s = new SqlStore();
    s.db = await openDb(cfg);
    return s;
  }

  close() {
    this.db.close();
  }

  // ---- users & sessions ----
  getUserByEmail(email) {
    return this.db.get('SELECT * FROM users WHERE email = ?', email);
  }

  async ensureAdmin({ email, name, passwordHash }) {
    if ((await this.db.get('SELECT COUNT(*) AS n FROM users')).n > 0) return false;
    // OR IGNORE: two cold-starting instances may both get here.
    const r = await this.db.run(
      'INSERT OR IGNORE INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
      email,
      name,
      passwordHash,
      new Date().toISOString(),
    );
    return r.rowsAffected > 0;
  }

  async createSession(tokenHash, user, expiresAt) {
    await this.db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
    await this.db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', tokenHash, user.id, expiresAt);
  }

  getSession(tokenHash) {
    return this.db.get(
      'SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      tokenHash,
    );
  }

  async deleteSession(tokenHash) {
    await this.db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }

  // ---- settings ----
  async getOrInitSetting(key, initialValue) {
    await this.db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', key, initialValue);
    return (await this.db.get('SELECT value FROM settings WHERE key = ?', key)).value;
  }

  // ---- certificates ----
  async nextCertificateId(prefix) {
    const last = await this.db.get('SELECT id FROM certificates WHERE id LIKE ? ORDER BY id DESC LIMIT 1', `${prefix}%`);
    const n = last ? Number(last.id.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(n).padStart(3, '0')}`;
  }

  // Throws { code: 'duplicate-file' } or { code: 'duplicate-id' } on clashes.
  async insertCertificate(c, original, stamped) {
    try {
      await this.db.run(
        `INSERT INTO certificates (id, student_name, roll_no, program, department, graduation_year, payload, signature, key_id,
           document_hash, document_type, document_name, original, stamped_hash, stamped, status, issued_at, issued_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        c.id,
        c.student_name,
        c.roll_no,
        c.program,
        c.department,
        c.graduation_year,
        c.payload,
        c.signature,
        c.key_id,
        c.document_hash,
        c.document_type,
        c.document_name,
        original,
        c.stamped_hash,
        stamped,
        c.issued_at,
        c.issued_by,
      );
    } catch (e) {
      if (uniqueViolation(e, 'document_hash')) throw Object.assign(new Error('duplicate file'), { code: 'duplicate-file' });
      if (uniqueViolation(e, 'certificates.id')) throw Object.assign(new Error('duplicate id'), { code: 'duplicate-id' });
      throw e;
    }
  }

  getCertificate(id) {
    return this.db.get(`SELECT ${CERT_COLUMNS} FROM certificates WHERE id = ?`, id);
  }

  findCertificateByFileHash(hash) {
    return this.db.get(`SELECT ${CERT_COLUMNS} FROM certificates WHERE document_hash = ? OR stamped_hash = ?`, hash, hash);
  }

  async getCertificateFile(id, version) {
    const col = version === 'original' ? 'original' : 'stamped';
    const row = await this.db.get(`SELECT id, document_type, ${col} AS file FROM certificates WHERE id = ?`, id);
    return row && { id: row.id, document_type: row.document_type, file: Buffer.from(row.file) };
  }

  listCertificates({ q = '', status = null } = {}) {
    const like = `%${q.toLowerCase()}%`;
    return this.db.all(
      `SELECT ${CERT_COLUMNS},
              (SELECT COUNT(*) FROM verifications v WHERE v.cert_id = c.id) AS verification_count
       FROM certificates c
       WHERE (lower(id) LIKE ? OR lower(roll_no) LIKE ? OR lower(student_name) LIKE ?)
         AND (? IS NULL OR status = ?)
       ORDER BY issued_at DESC`,
      like,
      like,
      like,
      status,
      status,
    );
  }

  // Returns 'ok', 'missing' or 'already'.
  async revokeCertificate(id, { at, reason, by }) {
    const row = await this.db.get('SELECT status FROM certificates WHERE id = ?', id);
    if (!row) return 'missing';
    if (row.status === 'revoked') return 'already';
    await this.db.run(
      `UPDATE certificates SET status = 'revoked', revoked_at = ?, revoke_reason = ?, revoked_by = ? WHERE id = ?`,
      at,
      reason,
      by,
      id,
    );
    return 'ok';
  }

  async updateCertificatePayload(id, payload) {
    await this.db.run('UPDATE certificates SET payload = ? WHERE id = ?', payload, id);
  }

  // ---- verifications ----
  async addVerification(v) {
    const r = await this.db.run(
      `INSERT INTO verifications (at, cert_id, verdict, method, verifier_name, verifier_org, verifier_email, ip, user_agent, malpractice, findings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.at,
      v.cert_id,
      v.verdict,
      v.method,
      v.verifier_name,
      v.verifier_org,
      v.verifier_email,
      v.ip,
      v.user_agent,
      v.malpractice ? 1 : 0,
      v.findings,
    );
    return Number(r.lastInsertRowid);
  }

  listVerifications({ after = 0, verdict = null, certId = null, q = null, limit = 200 } = {}) {
    const like = q ? `%${q.toLowerCase()}%` : null;
    return this.db.all(
      `SELECT * FROM verifications
       WHERE id > ?
         AND (? IS NULL OR verdict = ?)
         AND (? IS NULL OR cert_id = ?)
         AND (? IS NULL OR lower(verifier_name) LIKE ? OR lower(verifier_org) LIKE ? OR lower(cert_id) LIKE ?)
       ORDER BY id DESC LIMIT ?`,
      after,
      verdict,
      verdict,
      certId,
      certId,
      like,
      like,
      like,
      like,
      limit,
    );
  }

  async verificationCounts(after = 0) {
    const r = await this.db.get(
      'SELECT COALESCE(SUM(id > ?), 0) AS n, COALESCE(MAX(id), 0) AS latest FROM verifications',
      after,
    );
    return { newCount: r.n, latestId: r.latest };
  }

  // ---- alerts ----
  async addAlert(a) {
    const r = await this.db.run(
      `INSERT INTO alerts (at, verification_id, cert_id, verdict, severity, title, findings, verifier_name, verifier_org, verifier_email, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.at,
      a.verification_id,
      a.cert_id,
      a.verdict,
      a.severity,
      a.title,
      a.findings,
      a.verifier_name,
      a.verifier_org,
      a.verifier_email,
      a.ip,
    );
    return Number(r.lastInsertRowid);
  }

  listAlerts({ status = 'all', certId = null, limit = 200 } = {}) {
    return this.db.all(
      `SELECT * FROM alerts
       WHERE (? = 'all' OR (? = 'open' AND acknowledged_at IS NULL) OR (? = 'acknowledged' AND acknowledged_at IS NOT NULL))
         AND (? IS NULL OR cert_id = ?)
       ORDER BY id DESC LIMIT ?`,
      status,
      status,
      status,
      certId,
      certId,
      limit,
    );
  }

  alertCounts() {
    return this.db.get(
      `SELECT COALESCE(SUM(acknowledged_at IS NULL), 0) AS open,
              COALESCE(SUM(acknowledged_at IS NULL AND severity = 'high'), 0) AS openHigh,
              COALESCE(MAX(id), 0) AS latestId
       FROM alerts`,
    );
  }

  async ackAlert(id, { at, by, note }) {
    const r = await this.db.run(
      'UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ?, note = ? WHERE id = ? AND acknowledged_at IS NULL',
      at,
      by,
      note,
      id,
    );
    return r.rowsAffected > 0;
  }

  // ---- registrar audit log ----
  async addAudit({ action, certId = null, detail = null, actor = null, ip = null }) {
    await this.db.run(
      'INSERT INTO audit_events (at, action, cert_id, detail, actor, ip) VALUES (?, ?, ?, ?, ?, ?)',
      new Date().toISOString(),
      action,
      certId,
      detail,
      actor,
      ip,
    );
  }

  listAudit({ action = null, certId = null, limit = 200 } = {}) {
    return this.db.all(
      `SELECT * FROM audit_events WHERE (? IS NULL OR action = ?) AND (? IS NULL OR cert_id = ?) ORDER BY id DESC LIMIT ?`,
      action,
      action,
      certId,
      certId,
      limit,
    );
  }

  // ---- dashboard ----
  async stats(startOfDayIso) {
    const [certificates, verifications, verdicts, alerts] = await Promise.all([
      this.db.get(
        `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'revoked'), 0) AS revoked
         FROM certificates`,
      ),
      this.db.get(
        `SELECT COUNT(*) AS total, COALESCE(SUM(at >= ?), 0) AS today, COUNT(DISTINCT lower(verifier_org)) AS organisations
         FROM verifications`,
        startOfDayIso,
      ),
      this.db.all('SELECT verdict, COUNT(*) AS n FROM verifications GROUP BY verdict ORDER BY n DESC'),
      this.db.get(
        `SELECT COUNT(*) AS total, COALESCE(SUM(acknowledged_at IS NULL), 0) AS open,
                COALESCE(SUM(acknowledged_at IS NULL AND severity = 'high'), 0) AS openHigh
         FROM alerts`,
      ),
    ]);
    return { certificates, verifications, verdicts: verdicts.filter((v) => VERDICTS.includes(v.verdict) || v.n), alerts };
  }
}
