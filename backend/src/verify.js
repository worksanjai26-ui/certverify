import { sha256, verifySignature } from './crypto.js';
import { comparePages, readDocument, registeredPages } from './document.js';

// Decision flow: located? -> signature valid? -> QR matches registry? -> revoked? -> document matches? -> Verified
const STEPS = {
  found: 'Certificate located in the registry',
  signature: "Institution's digital signature is valid",
  qr: 'QR code hash and signature match the registry',
  revocation: 'Certificate has not been revoked',
  file: 'Document matches the registered copy',
};

const PAGE_ROLE = { certificate: 'Certificate page', verification: 'Verification (QR) page', extra: 'Extra page' };

export const normalizeId = (id) => String(id ?? '').trim().toUpperCase();

function newSteps() {
  return Object.fromEntries(
    Object.entries(STEPS).map(([key, label]) => [key, { key, label, status: 'not_run', detail: null }]),
  );
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

// The registered PDF itself is only fetched when a document needs comparing.
async function findRow(store, id, fileHash) {
  if (id) return store.getCertificate(id);
  if (fileHash) return store.findCertificateByFileHash(fileHash);
  return undefined;
}

export async function verifyCertificate(store, keys, { certificateId, qrHash, qrSignature, file }) {
  const steps = newSteps();
  const findings = [];
  const flag = (severity, code, message) => findings.push({ severity, code, message });
  const evidence = {};
  const fileHash = file ? sha256(file) : null;
  if (fileHash) evidence.computedFileHash = fileHash;

  // 1. Read the uploaded document and find the certificate it claims to be.
  const doc = file ? await readDocument(file) : null;
  const loc = doc?.locator ?? null;
  const document = doc && {
    kind: doc.kind,
    readable: doc.readable,
    pageCount: doc.pages.length,
    locator: loc && { source: loc.source, page: loc.page, id: loc.id ?? null },
    comparison: null,
  };

  let id = certificateId ? normalizeId(certificateId) : null;
  let locatedBy = id ? (qrHash || qrSignature ? 'QR scan' : 'Certificate ID') : null;
  const where = loc && `${loc.source === 'qr' ? 'The QR code' : 'The printed certificate details'} on page ${loc.page}`;

  if (loc?.foreign) {
    flag('high', 'foreign-qr', `${where} links to another website (${loc.raw.slice(0, 80)}) instead of this portal. Treat the document as forged.`);
  }
  if (loc?.id && id && loc.id !== id) {
    flag('high', 'id-mismatch', `${where} belongs to certificate ${loc.id}, not ${id}. The document was swapped or altered.`);
  }
  if (!id && loc?.id) {
    id = loc.id;
    locatedBy = loc.source === 'qr' ? `QR code on page ${loc.page}` : `printed details on page ${loc.page}`;
  }
  // QR data: what the employer scanned wins; otherwise what was read from the document.
  const fromDoc = loc?.id && loc.id === id;
  const qr = {
    hash: qrHash ?? (fromDoc ? loc.hash : null),
    signature: qrSignature ?? (fromDoc ? loc.signature : null),
  };
  if (qr.hash) evidence.qrHash = qr.hash;
  if (qr.signature) evidence.qrSignature = qr.signature;

  const row = await findRow(store, id, id ? null : fileHash);
  if (!id && row) locatedBy = 'exact file match';

  const finish = (verdict, extra = {}) => ({
    verdict,
    certificateId: row?.id ?? id ?? null,
    checkedAt: new Date().toISOString(),
    steps: Object.values(steps),
    findings,
    malpractice: findings.some((f) => f.severity === 'high' || f.severity === 'medium'),
    document,
    evidence,
    ...extra,
  });

  if (!row) {
    steps.found.status = 'fail';
    if (loc?.id && !certificateId) {
      steps.found.detail = `${where} points to ${loc.id}, which this institution never registered.`;
      flag('high', 'unknown-id', `${where} refers to certificate ${loc.id}, which does not exist in the registry. The document is likely forged.`);
    } else if (id) {
      steps.found.detail = 'No certificate with this ID has been registered by the institution.';
    } else {
      steps.found.detail = doc?.readable
        ? 'No CertVerify QR code or registered file matches this document.'
        : 'The file could not be read and does not match any registered file.';
      if (doc) flag('info', 'no-qr', 'No CertVerify QR code was found in the document, so it could not be located in the registry.');
    }
    return finish('not_found');
  }
  steps.found.status = 'pass';
  steps.found.detail = `Located ${row.id} by ${locatedBy}.`;

  // 2. The registry record must carry a valid institution signature.
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
    flag('high', 'registry-signature', `The registry record for ${row.id} fails its signature check: it was edited after registration.`);
    return finish('invalid_signature');
  }
  steps.signature.status = 'pass';
  steps.signature.detail = `Ed25519 signature verified with institution key ${row.key_id}.`;
  const certificate = publicDetails(payload);

  // 3. Cross-check the QR's hash and signature with the registry.
  if (qr.hash || qr.signature) {
    const source = qrHash || qrSignature ? 'scanned QR code' : loc.source === 'qr' ? `QR code on page ${loc.page}` : `printed details on page ${loc.page}`;
    if (qr.hash && qr.hash !== row.document_hash) {
      steps.qr.status = 'fail';
      steps.qr.detail = `The hash in the ${source} differs from the registered document.`;
      flag('high', 'qr-hash', `The hash in the ${source} does not match ${row.id}. The QR was altered or copied from another certificate.`);
      return finish('tampered', { certificate });
    }
    if (qr.signature && qr.signature !== row.signature) {
      steps.qr.status = 'fail';
      steps.qr.detail = `The signature in the ${source} is not the institution's signature for this certificate.`;
      flag('high', 'qr-signature', `The signature in the ${source} is forged: it is not the institution's signature for ${row.id}.`);
      return finish('invalid_signature', { certificate });
    }
    steps.qr.status = 'pass';
    steps.qr.detail = `Hash and signature in the ${source} are identical to the registry record.`;
  } else {
    steps.qr.status = 'skipped';
    steps.qr.detail = 'No QR data to compare (certificate ID entered or file matched directly).';
  }

  // 4. Revocation.
  if (row.status === 'revoked') {
    steps.revocation.status = 'fail';
    steps.revocation.detail = `Revoked on ${row.revoked_at}${row.revoke_reason ? ` (${row.revoke_reason})` : ''}.`;
    if (file || qr.hash) flag('medium', 'revoked', `A revoked certificate (${row.id}) was presented for verification.`);
    return finish('revoked', { certificate, revocation: { revokedAt: row.revoked_at, reason: row.revoke_reason } });
  }
  steps.revocation.status = 'pass';
  steps.revocation.detail = 'Registry status is active.';

  // 5. Compare the uploaded document with the registered copy.
  if (!file) {
    steps.file.status = 'skipped';
    steps.file.detail = 'No document uploaded. Compare the registry details below with the document you were given.';
    return finish(findings.length ? 'tampered' : 'verified', { certificate });
  }
  if (fileHash === row.stamped_hash || fileHash === row.document_hash) {
    steps.file.status = 'pass';
    steps.file.detail =
      fileHash === row.stamped_hash
        ? 'Byte-for-byte identical to the verified PDF issued by the registrar.'
        : 'Byte-for-byte identical to the original scan the registrar uploaded.';
    if (document) document.comparison = { identicalFile: true, rows: [] };
    return finish(findings.some((f) => f.severity === 'high') ? 'tampered' : 'verified', { certificate });
  }

  if (doc.kind === 'pdf' && doc.readable) {
    const registered = await registeredPages(row.stamped_hash, async () => (await store.getCertificateFile(row.id, 'stamped')).file);
    const { rows, rasterised } = comparePages(doc.pages, registered);
    document.comparison = { identicalFile: false, registeredPageCount: registered.length, rows };

    if (rows.every((r) => r.status === 'match')) {
      steps.file.status = 'pass';
      steps.file.detail = 'Every page matches the registered copy. The file was re-saved, but its content is unchanged.';
      flag('info', 'resaved', 'The file was re-saved after issue, but every page is unchanged.');
      return finish(findings.some((f) => f.severity === 'high') ? 'tampered' : 'verified', { certificate });
    }
    if (rasterised && !findings.some((f) => f.severity === 'high')) {
      steps.file.status = 'skipped';
      steps.file.detail = 'This is a printed-and-scanned copy, so its pages cannot be compared automatically.';
      flag('info', 'rescanned', 'The QR code is genuine, but this is a scanned or photographed copy. Compare it visually with the registered copy.');
      return finish('review', { certificate });
    }
    steps.file.status = 'fail';
    const bad = rows.filter((r) => r.status !== 'match');
    steps.file.detail = `${bad.length} of ${rows.length} page(s) differ from the registered copy.`;
    for (const r of bad) {
      const what = PAGE_ROLE[r.role];
      const msg =
        r.status === 'altered'
          ? `${what} ${r.page} has been modified compared with the registered copy.`
          : r.status === 'missing'
            ? `${what} ${r.page} is missing from the uploaded document.`
            : `Page ${r.page} was added; it is not part of the registered certificate.`;
      flag('high', `page-${r.status}`, msg);
    }
    return finish('tampered', { certificate });
  }

  if (doc.kind === 'image' && doc.readable) {
    steps.file.status = 'skipped';
    steps.file.detail = 'An image cannot be compared byte-for-byte with the registered PDF.';
    if (!findings.some((f) => f.severity === 'high')) {
      flag('info', 'image-upload', 'The QR code was checked, but this is a photo or image. Compare it visually with the registered copy.');
      return finish('review', { certificate });
    }
    return finish('tampered', { certificate });
  }

  steps.file.status = 'fail';
  steps.file.detail = 'The uploaded file could not be read as a PDF or image.';
  flag('medium', 'unreadable', 'The uploaded file is damaged or not a PDF/JPG/PNG, so it could not be compared with the registered copy.');
  return finish('tampered', { certificate });
}
