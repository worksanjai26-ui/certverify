import { canonicalize, sha256, signPayload } from './crypto.js';
import { buildVerifiedPdf } from './stamp.js';

async function nextId(db, department, year) {
  const prefix = `DEG-${department}-${year}-`;
  const last = await db.get('SELECT id FROM certificates WHERE id LIKE ? ORDER BY id DESC LIMIT 1', `${prefix}%`);
  const n = last ? Number(last.id.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(3, '0')}`;
}

export const verifyUrlFor = (cfg, id) => `${cfg.publicUrl}/verify/${id}`;

// Everything the QR carries: certificate ID, document hash and signature, as a link to this portal.
export const qrTextFor = (cfg, id, documentHash, signature) =>
  `${verifyUrlFor(cfg, id)}?h=${documentHash}&s=${signature}`;

const isUniqueViolation = (e, column) => /UNIQUE constraint failed/i.test(e?.message) && e.message.includes(column);

async function registerOnce({ db, keys, cfg }, { file, type, fileName, details, actor }) {
  const id = await nextId(db, details.department, details.graduationYear);
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
    qrTextFor(cfg, id, documentHash, signature),
  );

  await db.run(
    `INSERT INTO certificates (id, student_name, roll_no, program, department, graduation_year, payload, signature, key_id,
       document_hash, document_type, document_name, original, stamped_hash, stamped, status, issued_at, issued_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    id,
    details.studentName,
    details.rollNo,
    details.program,
    details.department,
    details.graduationYear,
    payload,
    signature,
    keys.keyId,
    documentHash,
    type,
    fileName ?? null,
    file,
    sha256(stamped),
    stamped,
    issuedAt,
    actor,
  );
  return id;
}

// Another server instance may claim the same sequence number between our read and insert.
// The ID is printed inside the PDF, so on a clash we redo the whole thing with the next number.
async function register(ctx, input) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await registerOnce(ctx, input);
    } catch (e) {
      if (isUniqueViolation(e, 'document_hash')) {
        const err = new Error('This exact file is already registered.');
        err.status = 409;
        throw err;
      }
      if (!isUniqueViolation(e, 'certificates.id') || attempt >= 5) throw e;
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
