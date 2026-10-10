import { canonicalize, sha256, signPayload } from './crypto.js';
import { buildVerifiedPdf } from './stamp.js';

export const verifyUrlFor = (cfg, id) => `${cfg.publicUrl}/verify/${id}`;

// What the QR carries, as a link to this portal: the certificate ID, document hash and signature, plus the
// key details (name, roll number, marks, year) so whoever scans it can compare them with the paper in front
// of them. The details are cross-checked against the signed registry record on every verification.
export function qrTextFor(cfg, id, documentHash, signature, details = {}) {
  const params = new URLSearchParams({ h: documentHash, s: signature });
  const extra = { n: details.studentName, r: details.rollNo, m: details.marks, y: details.graduationYear };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  return `${verifyUrlFor(cfg, id)}?${params}`;
}

async function registerOnce({ store, keys, cfg }, { file, type, fileName, details, actor }) {
  const id = await store.nextCertificateId(`DEG-${details.department}-${details.graduationYear}-`);
  const documentHash = sha256(file);
  const issuedAt = new Date().toISOString();
  const payload = canonicalize({
    v: 2,
    certificateId: id,
    institution: cfg.institutionName,
    studentName: details.studentName,
    rollNo: details.rollNo,
    program: details.program,
    department: details.department,
    graduationYear: details.graduationYear,
    marks: details.marks || undefined, // left out (not signed as empty) when the registrar gave none
    documentHash,
    issuedAt,
  });
  const signature = signPayload(keys.privateKey, payload);

  const stamped = await buildVerifiedPdf(
    file,
    type,
    {
      certificateId: id,
      institution: cfg.institutionName,
      ...details,
      issuedAt,
      documentHash,
      signature,
      keyId: keys.keyId,
      portalUrl: cfg.publicUrl,
    },
    qrTextFor(cfg, id, documentHash, signature, details),
  );

  await store.insertCertificate(
    {
      id,
      student_name: details.studentName,
      roll_no: details.rollNo,
      program: details.program,
      department: details.department,
      graduation_year: details.graduationYear,
      payload,
      signature,
      key_id: keys.keyId,
      document_hash: documentHash,
      document_type: type,
      document_name: fileName ?? null,
      stamped_hash: sha256(stamped),
      issued_at: issuedAt,
      issued_by: actor,
    },
    file,
    stamped,
  );
  return id;
}

// With SQL, another server instance may claim the same sequence number between our read and insert.
// The ID is printed inside the PDF, so on a clash we redo the whole thing with the next number.
async function register(ctx, input) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await registerOnce(ctx, input);
    } catch (e) {
      if (e.code === 'duplicate-file') {
        const err = new Error('This exact file is already registered.');
        err.status = 409;
        throw err;
      }
      if (e.code !== 'duplicate-id' || attempt >= 5) throw e;
    }
  }
}

// Within one instance, serialise registrations so they don't race each other at all.
let queue = Promise.resolve();
export function registerCertificate(ctx, input) {
  const run = queue.then(() => register(ctx, input));
  queue = run.catch(() => {});
  return run;
}
