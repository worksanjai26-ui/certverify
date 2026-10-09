import express from 'express';
import multer from 'multer';
import { normalizeId, verifyCertificate } from '../verify.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    }),
  );

  // One endpoint for every route in: QR (id + hash + signature), typed ID, and/or the file itself.
  router.post('/verify', upload.single('file'), (req, res) => {
    const b = req.body ?? {};
    const verifier = parseVerifier(b);
    if (verifier.error) return res.status(400).json({ error: verifier.error });

    const certificateId = text(b.certificateId, 60);
    const qrHash = text(b.qrHash, 200);
    const qrSignature = text(b.qrSignature, 200);
    if (!certificateId && !req.file) {
      return res.status(400).json({ error: 'Scan the QR code, enter a certificate ID, or upload the certificate file.' });
    }

    const result = verifyCertificate(db, keys, { certificateId, qrHash, qrSignature, file: req.file?.buffer });
    const method = [qrHash || qrSignature ? 'QR scan' : certificateId ? 'Certificate ID' : null, req.file ? 'file' : null]
      .filter(Boolean)
      .join(' + ');

    db.prepare(
      `INSERT INTO verifications (at, cert_id, verdict, method, verifier_name, verifier_org, verifier_email, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      result.checkedAt,
      result.certificateId ?? null,
      result.verdict,
      method,
      verifier.name,
      verifier.org,
      verifier.email ?? null,
      req.ip ?? null,
      String(req.get('user-agent') ?? '').slice(0, 300) || null,
    );
    res.json(result);
  });

  // Raw signed record, for independent verification with the public key.
  router.get('/records/:id', (req, res) => {
    const row = db
      .prepare('SELECT id, payload, signature, key_id, status FROM certificates WHERE id = ?')
      .get(normalizeId(req.params.id));
    if (!row) return res.status(404).json({ error: 'Certificate not found.' });
    res.json({ id: row.id, payload: row.payload, signature: row.signature, keyId: row.key_id, status: row.status });
  });

  return router;
}
