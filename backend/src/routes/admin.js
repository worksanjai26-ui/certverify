import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { audit } from '../db.js';
import { sha256 } from '../crypto.js';
import { qrTextFor, registerCertificate, verifyUrlFor } from '../register.js';
import { ACCEPTED_TYPES, detectType } from '../stamp.js';
import { normalizeId } from '../verify.js';

const norm = (s) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const alertJson = (a) => ({ ...a, findings: JSON.parse(a.findings || '[]') });

// Columns for lists and detail views; leaves out the two file blobs.
const CERT_COLUMNS = `id, payload, signature, key_id, document_hash, document_type, document_name, stamped_hash,
  status, issued_at, issued_by, revoked_at, revoke_reason, revoked_by`;

function summarize(row) {
  const p = JSON.parse(row.payload);
  return {
    id: row.id,
    studentName: p.studentName,
    rollNo: p.rollNo,
    program: p.program,
    department: p.department,
    graduationYear: p.graduationYear,
    institution: p.institution,
    status: row.status,
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    revokedBy: row.revoked_by,
    documentHash: row.document_hash,
    documentType: row.document_type,
    documentName: row.document_name,
    stampedHash: row.stamped_hash,
    signature: row.signature,
    keyId: row.key_id,
  };
}

function parseDetails(b) {
  const d = {
    studentName: norm(b.studentName),
    rollNo: norm(b.rollNo).toUpperCase(),
    program: norm(b.program),
    department: norm(b.department).toUpperCase(),
    graduationYear: Number(b.graduationYear),
  };
  const errors = [];
  if (d.studentName.length < 2 || d.studentName.length > 120) errors.push('Student name is required.');
  if (!/^[A-Z0-9/-]{2,30}$/.test(d.rollNo)) errors.push('Roll / register number must be 2-30 letters, digits, / or -.');
  if (d.program.length < 2 || d.program.length > 150) errors.push('Degree is required.');
  if (!/^[A-Z]{2,5}$/.test(d.department)) errors.push('Department code must be 2-5 letters (e.g. CSE).');
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(d.graduationYear) || d.graduationYear < 1950 || d.graduationYear > maxYear)
    errors.push(`Year of graduation must be between 1950 and ${maxYear}.`);
  return errors.length ? { error: errors.join(' ') } : d;
}

export function adminRouter(ctx) {
  const { db, auth, cfg } = ctx;
  const router = express.Router();
  const scanUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.floor(cfg.maxUploadMb * 1024 * 1024), files: 1 },
  });

  async function certificateResponse(id) {
    const row = await db.get(`SELECT ${CERT_COLUMNS} FROM certificates WHERE id = ?`, id);
    if (!row) return null;
    const qrText = qrTextFor(cfg, row.id, row.document_hash, row.signature);
    return {
      certificate: summarize(row),
      verifyUrl: verifyUrlFor(cfg, row.id),
      qrText,
      qr: await QRCode.toDataURL(qrText, { errorCorrectionLevel: 'M', margin: 1, width: 320 }),
    };
  }

  router.post('/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    const result = await auth.login(email, password, req.ip);
    if (result.error) {
      await audit(db, { action: 'login_failed', detail: String(email ?? '').slice(0, 120), ip: req.ip });
      return res.status(result.status).json({ error: result.error });
    }
    await audit(db, { action: 'login', actor: result.user.email, ip: req.ip });
    res.json(result);
  });

  router.use(auth.requireAdmin);

  router.get('/me', (req, res) => res.json({ user: req.user }));

  router.post('/logout', async (req, res) => {
    await auth.logout(req.tokenHash);
    res.json({ ok: true });
  });

  router.get('/stats', async (req, res) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [certificates, verifications, verdicts, alerts] = await Promise.all([
      db.get(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status = 'active'), 0) AS active,
                COALESCE(SUM(status = 'revoked'), 0) AS revoked
         FROM certificates`,
      ),
      db.get(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(at >= ?), 0) AS today,
                COUNT(DISTINCT lower(verifier_org)) AS organisations
         FROM verifications`,
        startOfDay.toISOString(),
      ),
      db.all('SELECT verdict, COUNT(*) AS n FROM verifications GROUP BY verdict ORDER BY n DESC'),
      db.get(
        `SELECT COUNT(*) AS total, COALESCE(SUM(acknowledged_at IS NULL), 0) AS open,
                COALESCE(SUM(acknowledged_at IS NULL AND severity = 'high'), 0) AS openHigh
         FROM alerts`,
      ),
    ]);
    res.json({ certificates, verifications, verdicts, alerts });
  });

  // ---- Certificates ----
  router.get('/certificates', async (req, res) => {
    const q = `%${norm(req.query.q).toLowerCase()}%`;
    const status = ['active', 'revoked'].includes(req.query.status) ? req.query.status : null;
    const rows = await db.all(
      `SELECT ${CERT_COLUMNS},
              (SELECT COUNT(*) FROM verifications v WHERE v.cert_id = c.id) AS verification_count
       FROM certificates c
       WHERE (lower(id) LIKE ? OR lower(roll_no) LIKE ? OR lower(student_name) LIKE ?)
         AND (? IS NULL OR status = ?)
       ORDER BY issued_at DESC`,
      q,
      q,
      q,
      status,
      status,
    );
    res.json({
      certificates: rows.map((r) => ({ ...summarize(r), verificationCount: r.verification_count })),
    });
  });

  // Upload a scanned degree certificate: hash it, sign it, give it an ID, append the QR page.
  router.post('/certificates', scanUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Attach the scanned certificate (PDF, JPG or PNG).' });
    const type = detectType(req.file.buffer);
    if (!type) {
      return res.status(400).json({ error: 'Unsupported file. Upload the scan as a PDF, JPG or PNG.' });
    }
    const details = parseDetails(req.body ?? {});
    if (details.error) return res.status(400).json({ error: details.error });

    const existing = await db.get('SELECT id FROM certificates WHERE document_hash = ?', sha256(req.file.buffer));
    if (existing) {
      return res
        .status(409)
        .json({ error: `This exact file is already registered as ${existing.id}.`, existingId: existing.id });
    }

    const id = await registerCertificate(ctx, {
      file: req.file.buffer,
      type,
      fileName: req.file.originalname?.slice(0, 200),
      details,
      actor: req.user.email,
    });
    await audit(db, {
      action: 'register',
      certId: id,
      detail: `${ACCEPTED_TYPES[type]} scan, ${(req.file.size / 1024).toFixed(0)} KB`,
      actor: req.user.email,
      ip: req.ip,
    });
    res.status(201).json(await certificateResponse(id));
  });

  router.get('/certificates/:id', async (req, res) => {
    const data = await certificateResponse(normalizeId(req.params.id));
    if (!data) return res.status(404).json({ error: 'Certificate not found.' });
    const id = data.certificate.id;
    const [verifications, history, alerts] = await Promise.all([
      db.all('SELECT * FROM verifications WHERE cert_id = ? ORDER BY id DESC LIMIT 200', id),
      db.all('SELECT * FROM audit_events WHERE cert_id = ? ORDER BY id DESC LIMIT 50', id),
      db.all('SELECT * FROM alerts WHERE cert_id = ? ORDER BY id DESC LIMIT 50', id),
    ]);
    res.json({ ...data, verifications, history, alerts: alerts.map(alertJson) });
  });

  // ?version=original returns the scan exactly as uploaded; default is the scan + QR page.
  router.get('/certificates/:id/file', async (req, res) => {
    const original = req.query.version === 'original';
    const row = await db.get(
      `SELECT id, document_type, ${original ? 'original' : 'stamped'} AS file FROM certificates WHERE id = ?`,
      normalizeId(req.params.id),
    );
    if (!row) return res.status(404).json({ error: 'Certificate not found.' });
    const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[row.document_type];
    res.set('Content-Type', original ? row.document_type : 'application/pdf');
    res.set(
      'Content-Disposition',
      `${req.query.inline ? 'inline' : 'attachment'}; filename="${row.id}${original ? `-original.${ext}` : '-verified.pdf'}"`,
    );
    res.send(Buffer.from(row.file));
  });

  router.post('/certificates/:id/revoke', async (req, res) => {
    const id = normalizeId(req.params.id);
    const reason = String(req.body?.reason ?? '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: 'A reason is required to revoke a certificate.' });
    const row = await db.get('SELECT status FROM certificates WHERE id = ?', id);
    if (!row) return res.status(404).json({ error: 'Certificate not found.' });
    if (row.status === 'revoked') return res.status(409).json({ error: 'Certificate is already revoked.' });
    await db.run(
      `UPDATE certificates SET status = 'revoked', revoked_at = ?, revoke_reason = ?, revoked_by = ? WHERE id = ?`,
      new Date().toISOString(),
      reason,
      req.user.email,
      id,
    );
    await audit(db, { action: 'revoke', certId: id, detail: reason, actor: req.user.email, ip: req.ip });
    res.json({ ok: true });
  });

  // ---- Public verification activity (live feed for the registrar) ----
  router.get('/verifications', async (req, res) => {
    const after = Number(req.query.after) || 0;
    const verdict = req.query.verdict ? String(req.query.verdict) : null;
    const certId = req.query.certId ? normalizeId(req.query.certId) : null;
    const q = req.query.q ? `%${norm(req.query.q).toLowerCase()}%` : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const [rows, latest] = await Promise.all([
      db.all(
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
        q,
        q,
        q,
        q,
        limit,
      ),
      db.get('SELECT COALESCE(MAX(id), 0) AS id FROM verifications'),
    ]);
    res.json({ verifications: rows, latestId: latest.id });
  });

  router.get('/verifications/count', async (req, res) => {
    const after = Number(req.query.after) || 0;
    const r = await db.get(
      `SELECT COALESCE(SUM(id > ?), 0) AS n, COALESCE(MAX(id), 0) AS latest FROM verifications`,
      after,
    );
    res.json({ newCount: r.n, latestId: r.latest });
  });

  // ---- Malpractice alerts ----
  router.get('/alerts', async (req, res) => {
    const status = ['open', 'acknowledged'].includes(req.query.status) ? req.query.status : 'all';
    const certId = req.query.certId ? normalizeId(req.query.certId) : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const rows = await db.all(
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
    res.json({ alerts: rows.map(alertJson) });
  });

  router.get('/alerts/count', async (req, res) => {
    const r = await db.get(
      `SELECT COALESCE(SUM(acknowledged_at IS NULL), 0) AS open,
              COALESCE(SUM(acknowledged_at IS NULL AND severity = 'high'), 0) AS openHigh,
              COALESCE(MAX(id), 0) AS latestId
       FROM alerts`,
    );
    res.json(r);
  });

  router.post('/alerts/:id/ack', async (req, res) => {
    const id = Number(req.params.id);
    const note = String(req.body?.note ?? '').trim().slice(0, 500) || null;
    const r = await db.run(
      'UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ?, note = ? WHERE id = ? AND acknowledged_at IS NULL',
      new Date().toISOString(),
      req.user.email,
      note,
      id,
    );
    if (!r.rowsAffected) return res.status(404).json({ error: 'Alert not found or already acknowledged.' });
    await audit(db, { action: 'alert_ack', detail: `Alert #${id}${note ? `: ${note}` : ''}`, actor: req.user.email, ip: req.ip });
    res.json({ ok: true });
  });

  router.get('/audit', async (req, res) => {
    const action = req.query.action ? String(req.query.action) : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const rows = await db.all(
      'SELECT * FROM audit_events WHERE (? IS NULL OR action = ?) ORDER BY id DESC LIMIT ?',
      action,
      action,
      limit,
    );
    res.json({ events: rows });
  });

  return router;
}
