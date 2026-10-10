import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';

const A4 = [595.28, 841.89];
const INK = rgb(0.114, 0.122, 0.141);
const RUST = rgb(0.71, 0.325, 0.165);
const GREY = rgb(0.38, 0.4, 0.43);

export const ACCEPTED_TYPES = { 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG' };

// Trust the file's bytes, not its name or the browser's MIME type.
export function detectType(buf) {
  if (buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  return null;
}

// Standard PDF fonts only cover Latin-1.
const safe = (s) => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

function wrap(text, font, size, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of safe(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function chunk(str, n) {
  return str.match(new RegExp(`.{1,${n}}`, 'g')) ?? [''];
}

async function loadScan(original, type) {
  if (type === 'application/pdf') {
    try {
      return await PDFDocument.load(original, { updateMetadata: false });
    } catch (e) {
      const err = new Error(
        /encrypt/i.test(e.message)
          ? 'This PDF is password-protected or encrypted. Upload an unprotected scan.'
          : 'This PDF could not be read. Re-export the scan and try again.',
      );
      err.status = 400;
      throw err;
    }
  }
  const doc = await PDFDocument.create();
  const img = type === 'image/png' ? await doc.embedPng(original) : await doc.embedJpg(original);
  const [pw, ph] = img.width > img.height ? [A4[1], A4[0]] : A4;
  const page = doc.addPage([pw, ph]);
  const margin = 18;
  const scale = Math.min((pw - 2 * margin) / img.width, (ph - 2 * margin) / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  return doc;
}

// Returns the scanned copy with a verification page (QR + ID + hash + signature) appended.
export async function buildVerifiedPdf(original, type, record, qrText) {
  const doc = await loadScan(original, type);
  const scanPages = doc.getPageCount();
  doc.setTitle(`Degree certificate ${record.certificateId}`);
  doc.setSubject('Scanned degree certificate with institution verification page');
  doc.setProducer('CertVerify');
  doc.setKeywords(['CertVerify', record.certificateId]);

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const monoBold = await doc.embedFont(StandardFonts.CourierBold);

  const page = doc.addPage(A4);
  const [W, H] = A4;
  const left = 50;
  const width = W - 100;

  page.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: RUST });
  page.drawRectangle({ x: 24, y: 24, width: W - 48, height: H - 58, borderColor: INK, borderWidth: 0.75 });

  let y = H - 64;
  page.drawText(safe(record.institution).toUpperCase(), { x: left, y, size: 10, font: bold, color: RUST });
  y -= 30;
  page.drawText('Certificate Verification Page', { x: left, y, size: 22, font: bold, color: INK });
  y -= 20;
  const intro = `This page was added by the registrar to the scanned degree certificate on the preceding ${
    scanPages === 1 ? 'page' : `${scanPages} pages`
  }. Scan the QR code to check it against the institution's official registry. The QR shows the student's name, roll number and marks: they must match the certificate.`;
  for (const line of wrap(intro, regular, 10, width)) {
    page.drawText(line, { x: left, y, size: 10, font: regular, color: GREY });
    y -= 14;
  }

  const qrPng = await QRCode.toBuffer(qrText, { errorCorrectionLevel: 'M', margin: 1, width: 640 });
  const qr = await doc.embedPng(qrPng);
  const qrSize = 230;
  y -= qrSize + 12;
  page.drawImage(qr, { x: (W - qrSize) / 2, y, width: qrSize, height: qrSize });
  y -= 16;
  const scanLabel = 'Scan to verify';
  page.drawText(scanLabel, { x: (W - bold.widthOfTextAtSize(scanLabel, 11)) / 2, y, size: 11, font: bold, color: INK });
  y -= 34;

  const rows = [
    ['Certificate ID', record.certificateId, monoBold],
    ['Student name', record.studentName],
    ['Roll / register no.', record.rollNo],
    ['Degree', record.program],
    ['Department', record.department],
    ['Year of graduation', String(record.graduationYear)],
    ...(record.marks ? [['Marks / result', record.marks, bold]] : []),
    ['Registered on', new Date(record.issuedAt).toUTCString().replace(' GMT', ' UTC')],
    ['Signing key ID', record.keyId, mono],
  ];
  for (const [label, value, font = regular] of rows) {
    page.drawText(label, { x: left, y, size: 9, font: bold, color: GREY });
    page.drawText(safe(value), { x: left + 130, y, size: 10, font, color: INK });
    y -= 17;
  }

  y -= 8;
  page.drawText('DOCUMENT HASH (SHA-256 of the scanned copy)', { x: left, y, size: 8, font: bold, color: RUST });
  y -= 13;
  page.drawText(record.documentHash, { x: left, y, size: 8.5, font: mono, color: INK });
  y -= 22;
  page.drawText('DIGITAL SIGNATURE (Ed25519, base64url)', { x: left, y, size: 8, font: bold, color: RUST });
  for (const part of chunk(record.signature, 60)) {
    y -= 13;
    page.drawText(part, { x: left, y, size: 8.5, font: mono, color: INK });
  }

  y -= 26;
  const note =
    `No QR scanner? Visit ${record.portalUrl} and enter the certificate ID. The QR code only points to the registry: ` +
    'a certificate is authentic only when the portal confirms it.';
  for (const line of wrap(note, regular, 8.5, width)) {
    page.drawText(line, { x: left, y, size: 8.5, font: regular, color: GREY });
    y -= 12;
  }

  return Buffer.from(await doc.save());
}
