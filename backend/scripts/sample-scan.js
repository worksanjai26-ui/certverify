// Creates a stand-in "scanned" degree certificate for demos: samples/sample-degree-scan.pdf
//   npm run sample -- "Aarav Menon" 21CSE001
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { backendRoot } from '../src/config.js';

const [name = 'Aarav Menon', roll = '21CSE001'] = process.argv.slice(2);
const doc = await PDFDocument.create();
const page = doc.addPage([841.89, 595.28]);
const serif = await doc.embedFont(StandardFonts.TimesRomanBold);
const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
const sans = await doc.embedFont(StandardFonts.Helvetica);
const W = page.getWidth();
const center = (text, y, font, size) =>
  page.drawText(text, { x: (W - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color: rgb(0.15, 0.12, 0.1) });

page.drawRectangle({ x: 0, y: 0, width: W, height: 595.28, color: rgb(0.98, 0.96, 0.9) });
page.drawRectangle({ x: 22, y: 22, width: W - 44, height: 551, borderColor: rgb(0.45, 0.3, 0.1), borderWidth: 4 });
center('DEMO INSTITUTE OF TECHNOLOGY', 500, serif, 26);
center('Degree Certificate', 455, italic, 22);
center('This is to certify that', 400, italic, 16);
center(name, 360, serif, 32);
center(`Register No. ${roll}`, 330, sans, 12);
center('has been admitted to the degree of', 295, italic, 16);
center('Bachelor of Technology in Computer Science and Engineering', 262, serif, 20);
center('in the year 2026, having passed the prescribed examinations.', 232, italic, 14);
page.drawText('Registrar', { x: 120, y: 110, size: 12, font: sans });
page.drawText('Vice-Chancellor', { x: W - 220, y: 110, size: 12, font: sans });

const out = path.resolve(backendRoot, '..', 'samples', `sample-degree-scan-${roll}.pdf`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await doc.save());
console.log(`Wrote ${out}`);
