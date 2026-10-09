import { sha256, verifySignature } from './crypto.js';

// Decision flow: ID found? -> signature valid? -> QR matches registry? -> revoked? -> file hash matches? -> Verified
const STEPS = {
  found: 'Certificate ID exists in the registry',
  signature: "Institution's digital signature is valid",
  qr: 'QR code hash and signature match the registry',
  revocation: 'Certificate has not been revoked',
  file: 'Supplied file matches the registered hash',
};

export const normalizeId = (id) => String(id ?? '').trim().toUpperCase();

function newSteps() {
  return Object.fromEntries(
    Object.entries(STEPS).map(([key, label]) => [key, { key, label, status: 'not_run', detail: null }]),
  );
}

function build(verdict, certificateId, steps, extra = {}) {
  return { verdict, certificateId, checkedAt: new Date().toISOString(), steps: Object.values(steps), ...extra };
}

export function publicDetails(p) {
  return {
    certificateId: p.certificateId,
    institution: p.institution,
    studentName: p.studentName,
    rollNo: p.rollNo,
    program: p.program,
    department: p.department,
    graduationYear: p.graduationYear,
    issuedAt: p.issuedAt,
  };
}

// Leaves out the two file blobs; verification only needs their hashes.
const ROW_COLUMNS = 'id, payload, signature, key_id, document_hash, stamped_hash, status, revoked_at, revoke_reason';

async function findRow(db, id, fileHash) {
  if (id) return db.get(`SELECT ${ROW_COLUMNS} FROM certificates WHERE id = ?`, id);
  if (fileHash) {
    return db.get(`SELECT ${ROW_COLUMNS} FROM certificates WHERE document_hash = ? OR stamped_hash = ?`, fileHash, fileHash);
  }
  return undefined;
}

export async function verifyCertificate(db, keys, { certificateId, qrHash, qrSignature, file }) {
  const id = certificateId ? normalizeId(certificateId) : null;
  const fileHash = file ? sha256(file) : null;
  const steps = newSteps();
  const evidence = {};
  if (fileHash) evidence.computedFileHash = fileHash;
  if (qrHash) evidence.qrHash = qrHash;
  if (qrSignature) evidence.qrSignature = qrSignature;

  const row = await findRow(db, id, fileHash);
  if (!row) {
    steps.found.status = 'fail';
    steps.found.detail = id
      ? 'No certificate with this ID has been registered by the institution.'
      : 'No registered certificate matches this exact file. It may be altered or never registered. Verify with the QR code or certificate ID instead.';
    return build('not_found', id, steps, { evidence });
  }
  steps.found.status = 'pass';
  if (!id) steps.found.detail = `Located certificate ${row.id} from the file's hash.`;

  let payload = null;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    /* handled as a signature failure */
  }
  Object.assign(evidence, {
    algorithm: 'Ed25519',
    keyId: row.key_id,
    documentHash: row.document_hash,
    signature: row.signature,
  });

  const knownKey = row.key_id === keys.keyId;
  const signatureOk =
    knownKey &&
    payload !== null &&
    payload.certificateId === row.id &&
    payload.documentHash === row.document_hash &&
    verifySignature(keys.publicKey, row.payload, row.signature);
  if (!signatureOk) {
    steps.signature.status = 'fail';
    steps.signature.detail = knownKey
      ? 'The registry record no longer matches the institution signature. It was changed after registration.'
      : 'The record was signed with a key this institution does not recognise.';
    return build('invalid_signature', row.id, steps, { evidence });
  }
  steps.signature.status = 'pass';
  steps.signature.detail = `Ed25519 signature verified with institution key ${row.key_id}.`;

  const certificate = publicDetails(payload);

  // Cross-check what the QR code carries against the registry.
  if (qrHash || qrSignature) {
    if (qrHash !== row.document_hash) {
      steps.qr.status = 'fail';
      steps.qr.detail =
        'The hash inside the QR code differs from the registered document. The QR was altered or copied from another certificate.';
      return build('tampered', row.id, steps, { certificate, evidence });
    }
    if (qrSignature !== row.signature) {
      steps.qr.status = 'fail';
      steps.qr.detail = "The signature inside the QR code is not the institution's signature for this certificate.";
      return build('invalid_signature', row.id, steps, { certificate, evidence });
    }
    steps.qr.status = 'pass';
    steps.qr.detail = 'Hash and signature in the QR code are identical to the registry record.';
  } else {
    steps.qr.status = 'skipped';
    steps.qr.detail = id ? 'Certificate ID entered manually; no QR data to compare.' : 'Located by file; no QR data to compare.';
  }

  if (row.status === 'revoked') {
    steps.revocation.status = 'fail';
    steps.revocation.detail = `Revoked on ${row.revoked_at}${row.revoke_reason ? ` (${row.revoke_reason})` : ''}.`;
    return build('revoked', row.id, steps, {
      certificate,
      evidence,
      revocation: { revokedAt: row.revoked_at, reason: row.revoke_reason },
    });
  }
  steps.revocation.status = 'pass';
  steps.revocation.detail = 'Registry status is active.';

  if (fileHash) {
    if (fileHash !== row.document_hash && fileHash !== row.stamped_hash) {
      steps.file.status = 'fail';
      steps.file.detail = 'The SHA-256 of the supplied file differs from the registered scan and the issued PDF.';
      return build('tampered', row.id, steps, { certificate, evidence });
    }
    steps.file.status = 'pass';
    steps.file.detail =
      fileHash === row.document_hash
        ? 'Identical to the original scanned copy the registrar uploaded.'
        : 'Identical to the verified PDF issued by the registrar.';
  } else {
    steps.file.status = 'skipped';
    steps.file.detail = 'No file supplied. Compare the registry details below with the document you were given.';
  }

  return build('verified', row.id, steps, { certificate, evidence });
}
