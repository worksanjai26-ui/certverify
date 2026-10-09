import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { normalizeId, verifyCertificate } from '../verify.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VIEW_TTL_MS = 30 * 60 * 1000;

const text = (v, max) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};

// Every check must say who is verifying; the registrar sees this in the Verifications feed.
function parseVerifier(b) {
  const name = text(b.verifierName, 100);
  const org = text(b.verifierOrganization, 150);
  const email = text(b.verifierEmail, 200);
  if (!name || name.length < 2) return { error: 'Enter your name to verify a certificate.' };
  if (!org || org.length < 2) return { error: 'Enter your organisation to verify a certificate.' };
  if (email && !EMAIL_RE.test(email)) return { error: 'That email address does not look valid.' };
  return { name, org, email };
}

export function publicRouter({ db, keys, cfg }) {
  const router = express.Router();
  // Short-lived signed links to the registered copy, keyed off the institution key.
  const viewSecret = crypto
    .createHash('sha256')
    .update(keys.privateKey.export({ type: 'pkcs8', format: 'der' }))
    .update('registered-copy-v1')
    .digest();
  const viewToken = (id, exp) => crypto.createHmac('sha256', viewSecret).update(`${id}.${exp}`).digest('base64url');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.floor(cfg.maxUploadMb * 1024 * 1024), files: 1 } });

  router.get('/health', (req, res) => res.json({ ok: true }));

  // Published trust anchor: anyone can check signatures without the secret key.
  router.get('/institution', (req, res) =>
    res.json({
      name: cfg.institutionName,
      portalUrl: cfg.publicUrl,
      algorithm: 'Ed25519',
      keyId: keys.keyId,
      fingerprint: keys.fingerprint,
      publicKeyPem: keys.publicKeyPem,
      maxUploadMb: cfg.maxUploadMb,
      storage: cfg.ephemeral ? 'temporary' : 'persistent',
    }),
  );

  // One endpoint for every route in: QR (id + hash + signature), typed ID, and/or the file itself.
  router.post('/verify', upload.single('file'), async (req, res) => {
    const b = req.body ?? {};
    const verifier = parseVerifier(b);
    if (verifier.error) return res.status(400).json({ error: verifier.error });

    const certificateId = text(b.certificateId, 60);
    const qrHash = text(b.qrHash, 200);
    const qrSignature = text(b.qrSignature, 200);
    if (!certificateId && !req.file) {
      return res.status(400).json({ error: 'Scan the QR code, enter a certificate ID, or upload the certificate file.' });
    }

    const result = await verifyCertificate(db, keys, { certificateId, qrHash, qrSignature, file: req.file?.buffer });
    const method =
      [qrHash || qrSignature ? 'QR scan' : certificateId ? 'Certificate ID' : null, req.file ? 'document upload' : null]
        .filter(Boolean)
        .join(' + ') +
      (!certificateId && result.document?.locator?.source === 'qr' ? ' (QR read from file)' : '');

    const notable = result.findings.filter((f) => f.severity !== 'info');
    const v = await db.run(
      `INSERT INTO verifications (at, cert_id, verdict, method, verifier_name, verifier_org, verifier_email, ip, user_agent, malpractice, findings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      result.checkedAt,
      result.certificateId,
      result.verdict,
      method,
      verifier.name,
      verifier.org,
      verifier.email,
      req.ip,
      String(req.get('user-agent') ?? '').slice(0, 300) || null,
      result.malpractice ? 1 : 0,
      result.findings.length ? JSON.stringify(result.findings) : null,
    );

    // Malpractice reaches the registrar as an alert in the admin panel.
    if (result.malpractice) {
      const severity = notable.some((f) => f.severity === 'high') ? 'high' : 'medium';
      const alert = await db.run(
        `INSERT INTO alerts (at, verification_id, cert_id, verdict, severity, title, findings, verifier_name, verifier_org, verifier_email, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        result.checkedAt,
        Number(v.lastInsertRowid),
        result.certificateId,
        result.verdict,
        severity,
        notable[0].message.slice(0, 300),
        JSON.stringify(notable),
        verifier.name,
        verifier.org,
        verifier.email,
        req.ip,
      );
      result.alertId = Number(alert.lastInsertRowid);
    }

    // Someone holding the document (file or its QR) may open the registered copy to compare visually.
    if (result.certificate && (req.file || qrHash)) {
      const exp = Date.now() + VIEW_TTL_MS;
      result.registeredCopyUrl = `/api/registered/${result.certificateId}?exp=${exp}&sig=${viewToken(result.certificateId, exp)}`;
    }
    res.json(result);
  });

  router.get('/registered/:id', async (req, res) => {
    const id = normalizeId(req.params.id);
    const exp = Number(req.query.exp);
    const sig = String(req.query.sig ?? '');
    const expected = viewToken(id, exp);
    const valid =
      exp > Date.now() &&
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!valid) return res.status(403).json({ error: 'This link has expired. Verify the document again to get a new one.' });
    const row = await db.get('SELECT stamped FROM certificates WHERE id = ?', id);
    if (!row) return res.status(404).json({ error: 'Certificate not found.' });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${id}-registered.pdf"`);
    res.set('Cache-Control', 'private, no-store');
    res.send(Buffer.from(row.stamped));
  });

  // Raw signed record, for independent verification with the public key.
  router.get('/records/:id', async (req, res) => {
    const row = await db.get(
      'SELECT id, payload, signature, key_id, status FROM certificates WHERE id = ?',
      normalizeId(req.params.id),
    );
    if (!row) return res.status(404).json({ error: 'Certificate not found.' });
    res.json({ id: row.id, payload: row.payload, signature: row.signature, keyId: row.key_id, status: row.status });
  });

  return router;
}
