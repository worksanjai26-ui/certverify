import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { sha256 } from '../crypto.js';
import { qrTextFor, registerCertificate, verifyUrlFor } from '../register.js';
import { ACCEPTED_TYPES, detectType } from '../stamp.js';
import { normalizeId } from '../verify.js';

const norm = (s) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const alertJson = (a) => ({ ...a, findings: JSON.parse(a.findings || '[]') });
const clampLimit = (v) => Math.min(Math.max(Number(v) || 200, 1), 1000);

function summarize(row) {
  const p = JSON.parse(row.payload);
  return {
    id: row.id,
    studentName: p.studentName,
    rollNo: p.rollNo,
    program: p.program,
    department: p.department,
    graduationYear: p.graduationYear,
    marks: p.marks ?? null,
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
    // Free text as printed on the certificate: "77%", "8.2 CGPA", "First Class with Distinction".
    marks: norm(b.marks),
  };
  const errors = [];
  if (d.marks.length > 60) errors.push('Marks / result must be at most 60 characters.');
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
  const { store, auth, cfg } = ctx;
  const router = express.Router();
  const scanUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.floor(cfg.maxUploadMb * 1024 * 1024), files: 1 },
  });

  async function certificateResponse(id) {
    const row = await store.getCertificate(id);
    if (!row) return null;
    const qrText = qrTextFor(cfg, row.id, row.document_hash, row.signature, JSON.parse(row.payload));
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
      await store.addAudit({ action: 'login_failed', detail: String(email ?? '').slice(0, 120), ip: req.ip });
      return res.status(result.status).json({ error: result.error });
    }
    await store.addAudit({ action: 'login', actor: result.user.email, ip: req.ip });
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
    res.json(await store.stats(startOfDay.toISOString()));
  });

  // ---- Certificates ----
  router.get('/certificates', async (req, res) => {
    const status = ['active', 'revoked'].includes(req.query.status) ? req.query.status : null;
    const rows = await store.listCertificates({ q: norm(req.query.q), status });
    res.json({ certificates: rows.map((r) => ({ ...summarize(r), verificationCount: r.verification_count })) });
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

    const existing = await store.findCertificateByFileHash(sha256(req.file.buffer));
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
    await store.addAudit({
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
    const certId = data.certificate.id;
    const [verifications, history, alerts] = await Promise.all([
      store.listVerifications({ certId, limit: 200 }),
      store.listAudit({ certId, limit: 50 }),
      store.listAlerts({ certId, limit: 50 }),
    ]);
    res.json({ ...data, verifications, history, alerts: alerts.map(alertJson) });
  });

  // ?version=original returns the scan exactly as uploaded; default is the scan + QR page.
  router.get('/certificates/:id/file', async (req, res) => {
    const original = req.query.version === 'original';
    const row = await store.getCertificateFile(normalizeId(req.params.id), original ? 'original' : 'stamped');
    if (!row) return res.status(404).json({ error: 'Certificate not found.' });
    const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[row.document_type];
    res.set('Content-Type', original ? row.document_type : 'application/pdf');
    res.set(
      'Content-Disposition',
      `${req.query.inline ? 'inline' : 'attachment'}; filename="${row.id}${original ? `-original.${ext}` : '-verified.pdf'}"`,
    );
    res.send(row.file);
  });

  router.post('/certificates/:id/revoke', async (req, res) => {
    const id = normalizeId(req.params.id);
    const reason = String(req.body?.reason ?? '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: 'A reason is required to revoke a certificate.' });
    const outcome = await store.revokeCertificate(id, { at: new Date().toISOString(), reason, by: req.user.email });
    if (outcome === 'missing') return res.status(404).json({ error: 'Certificate not found.' });
    if (outcome === 'already') return res.status(409).json({ error: 'Certificate is already revoked.' });
    await store.addAudit({ action: 'revoke', certId: id, detail: reason, actor: req.user.email, ip: req.ip });
    res.json({ ok: true });
  });

  // ---- Public verification activity (live feed for the registrar) ----
  router.get('/verifications', async (req, res) => {
    const [verifications, counts] = await Promise.all([
      store.listVerifications({
        after: Number(req.query.after) || 0,
        verdict: req.query.verdict ? String(req.query.verdict) : null,
        certId: req.query.certId ? normalizeId(req.query.certId) : null,
        q: req.query.q ? norm(req.query.q) : null,
        limit: clampLimit(req.query.limit),
      }),
      store.verificationCounts(0),
    ]);
    res.json({ verifications, latestId: counts.latestId });
  });

  router.get('/verifications/count', async (req, res) => {
    res.json(await store.verificationCounts(Number(req.query.after) || 0));
  });

  // ---- Malpractice alerts ----
  router.get('/alerts', async (req, res) => {
    const status = ['open', 'acknowledged'].includes(req.query.status) ? req.query.status : 'all';
    const alerts = await store.listAlerts({
      status,
      certId: req.query.certId ? normalizeId(req.query.certId) : null,
      limit: clampLimit(req.query.limit),
    });
    res.json({ alerts: alerts.map(alertJson) });
  });

  router.get('/alerts/count', async (req, res) => {
    res.json(await store.alertCounts());
  });

  router.post('/alerts/:id/ack', async (req, res) => {
    const id = Number(req.params.id);
    const note = String(req.body?.note ?? '').trim().slice(0, 500) || null;
    const ok = Number.isInteger(id) && (await store.ackAlert(id, { at: new Date().toISOString(), by: req.user.email, note }));
    if (!ok) return res.status(404).json({ error: 'Alert not found or already acknowledged.' });
    await store.addAudit({ action: 'alert_ack', detail: `Alert #${id}${note ? `: ${note}` : ''}`, actor: req.user.email, ip: req.ip });
    res.json({ ok: true });
  });

  router.get('/audit', async (req, res) => {
    const events = await store.listAudit({
      action: req.query.action ? String(req.query.action) : null,
      limit: clampLimit(req.query.limit),
    });
    res.json({ events });
  });

  return router;
}
