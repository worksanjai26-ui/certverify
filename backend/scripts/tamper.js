// Demo helper for showing the failure paths of the verification flow.
//
//   npm run tamper -- export DEG-CSE-2026-001             write the verified PDF (scan + QR page)   -> "Verified"
//   npm run tamper -- file   DEG-CSE-2026-001             write an altered copy of that PDF        -> "Tampered file"
//   npm run tamper -- record DEG-CSE-2026-001 rollNo=X    edit the registry row without re-signing -> "Invalid signature"
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { canonicalize } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { normalizeId } from '../src/verify.js';

const [mode, rawId, ...edits] = process.argv.slice(2);
const id = normalizeId(rawId);
if (!['record', 'file', 'export'].includes(mode) || !id) {
  console.error('Usage: npm run tamper -- <export|file|record> <CERT-ID> [field=value ...]');
  process.exit(1);
}

const db = await openDb(config);
const row = await db.get('SELECT id, payload, stamped FROM certificates WHERE id = ?', id);
if (!row) {
  console.error(`No certificate ${id} in ${config.databaseUrl ? 'the Turso database' : config.dataDir}`);
  process.exit(1);
}

if (mode === 'record') {
  const payload = JSON.parse(row.payload);
  const changes = edits.length ? edits : ['studentName=Someone Else'];
  for (const edit of changes) {
    const [key, ...rest] = edit.split('=');
    const value = rest.join('=');
    payload[key] = value !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
  }
  await db.run('UPDATE certificates SET payload = ? WHERE id = ?', canonicalize(payload), id);
  console.log(`Edited registry record ${id}: ${changes.join(', ')} (signature left unchanged).`);
} else {
  const out = path.join(config.dataDir, mode === 'file' ? `${id}-tampered.pdf` : `${id}-verified.pdf`);
  let bytes = Buffer.from(row.stamped);
  // Appending a comment keeps the PDF readable but changes its SHA-256 completely.
  if (mode === 'file') bytes = Buffer.concat([bytes, Buffer.from('\n% edited after issue\n')]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(`Wrote ${out}`);
}
db.close();
