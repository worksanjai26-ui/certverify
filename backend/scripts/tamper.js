// Demo helper for showing the failure paths of the verification flow.
//
//   npm run tamper -- export DEG-CSE-2026-001             write the verified PDF (scan + QR page)   -> "Verified"
//   npm run tamper -- file   DEG-CSE-2026-001 ["text"]    forge page 1, keep the genuine QR page   -> "Tampered" + admin alert
//   npm run tamper -- record DEG-CSE-2026-001 rollNo=X    edit the registry row without re-signing -> "Invalid signature"
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { config } from '../src/config.js';
import { canonicalize } from '../src/crypto.js';
import { openStore, storageLabel } from '../src/store/index.js';
import { normalizeId } from '../src/verify.js';

const [mode, rawId, ...edits] = process.argv.slice(2);
const id = normalizeId(rawId);
if (!['record', 'file', 'export'].includes(mode) || !id) {
  console.error('Usage: npm run tamper -- <export|file|record> <CERT-ID> [field=value ...]');
  process.exit(1);
}

const store = await openStore(config);
const row = await store.getCertificate(id);
if (!row) {
  console.error(`No certificate ${id} in the ${storageLabel(config)} storage`);
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
  await store.updateCertificatePayload(id, canonicalize(payload));
  console.log(`Edited registry record ${id}: ${changes.join(', ')} (signature left unchanged).`);
} else {
  const out = path.join(config.dataDir, mode === 'file' ? `${id}-tampered.pdf` : `${id}-verified.pdf`);
  let bytes = (await store.getCertificateFile(id, 'stamped')).file;
  if (mode === 'file') {
    // Forge the certificate page the way a cheater would: write over it, keep the genuine QR page.
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    page.drawRectangle({ x: 40, y: 40, width: 260, height: 34, color: rgb(1, 1, 1) });
    page.drawText(edits[0] ?? 'CGPA 9.99 / 10 (First Class)', { x: 48, y: 52, size: 14, font, color: rgb(0.1, 0.1, 0.1) });
    bytes = Buffer.from(await doc.save());
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(`Wrote ${out}`);
}
store.close();
