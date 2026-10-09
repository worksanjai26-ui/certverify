import { canonicalize, sha256, signPayload } from './crypto.js';
import { buildVerifiedPdf } from './stamp.js';

function nextId(db, department, year) {
  const prefix = `DEG-${department}-${year}-`;
  const last = db.prepare('SELECT id FROM certificates WHERE id LIKE ? ORDER BY id DESC LIMIT 1').get(`${prefix}%`);
  const n = last ? Number(last.id.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(3, '0')}`;
}

export const verifyUrlFor = (cfg, id) => `${cfg.publicUrl}/verify/${id}`;

// Everything the QR carries: certificate ID, document hash and signature, as a link to this portal.
export const qrTextFor = (cfg, id, documentHash, signature) =>
  `${verifyUrlFor(cfg, id)}?h=${documentHash}&s=${signature}`;

async function register({ db, keys, cfg }, { file, type, fileName, details, actor }) {
  const id = nextId(db, details.department, details.graduationYear);
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

  db.prepare(
    `INSERT INTO certificates (id, student_name, roll_no, program, department, graduation_year, payload, signature, key_id,
       document_hash, document_type, document_name, original, stamped_hash, stamped, status, issued_at, issued_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
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

// Serialise registrations so two uploads can't claim the same sequence number.
let queue = Promise.resolve();
export function registerCertificate(ctx, input) {
  const run = queue.then(() => register(ctx, input));
  queue = run.catch(() => {});
  return run;
}
