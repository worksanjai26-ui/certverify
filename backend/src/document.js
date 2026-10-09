// Reads an uploaded certificate: finds the CertVerify QR code (or the printed ID/hash) to locate the
// registry record, and fingerprints every page so it can be compared with the registered copy.
import crypto from 'node:crypto';
import jpeg from 'jpeg-js';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { detectType } from './stamp.js';

const ID_RE = /DEG-[A-Z]{2,5}-\d{4}-\d{3,}/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^[A-Za-z0-9_-]+$/;
const MAX_QR_PIXELS = 2200 * 2200;

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------- QR text

// Accepts our verify URL (…/verify/<ID>?h=<hash>&s=<signature>) or a bare certificate ID.
export function parseQrText(text) {
  const t = String(text ?? '').trim();
  const bare = t.match(new RegExp(`^${ID_RE.source}$`));
  if (bare) return { id: bare[0], raw: t };
  try {
    const url = new URL(t);
    const m = url.pathname.match(/\/verify\/([^/?#]+)\/?$/);
    if (!m) return { foreign: true, raw: t };
    return {
      id: decodeURIComponent(m[1]).toUpperCase(),
      hash: url.searchParams.get('h') || null,
      signature: url.searchParams.get('s') || null,
      origin: url.origin,
      raw: t,
    };
  } catch {
    return { foreign: true, raw: t };
  }
}

// ---------------------------------------------------------------- image decoding

function downscale(rgba, width, height) {
  if (width * height <= MAX_QR_PIXELS) return { data: rgba, width, height };
  const f = Math.sqrt((width * height) / MAX_QR_PIXELS);
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y * f);
    for (let x = 0; x < w; x++) {
      const si = (sy * width + Math.floor(x * f)) * 4;
      out.set(rgba.subarray(si, si + 4), (y * w + x) * 4);
    }
  }
  return { data: out, width: w, height: h };
}

function findQr(rgba, width, height) {
  const img = downscale(rgba, width, height);
  const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return hit?.data ?? null;
}

function rgbaFromImageFile(buf, type) {
  if (type === 'image/png') {
    const png = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return { data: new Uint8ClampedArray(img.data.buffer), width: img.width, height: img.height };
}

// ---------------------------------------------------------------- PDF internals

const resolve = (ctx, obj) => (obj instanceof PDFRef ? ctx.lookup(obj) : obj);

function filtersOf(dict) {
  const f = dict.get(PDFName.of('Filter'));
  if (!f) return [];
  return f instanceof PDFArray ? f.asArray().map(String) : [String(f)];
}

const OPAQUE_FILTERS = ['/DCTDecode', '/JPXDecode', '/CCITTFaxDecode', '/JBIG2Decode'];

// Decoded bytes where pdf-lib can decode them (so a re-compressed but unchanged stream still matches).
function streamBytes(stream) {
  const filters = filtersOf(stream.dict);
  const opaque = filters.find((f) => OPAQUE_FILTERS.includes(f));
  if (opaque) return { bytes: stream.getContents(), encoding: opaque };
  try {
    return { bytes: decodePDFRawStream(stream).decode(), encoding: 'raw' };
  } catch {
    return { bytes: stream.getContents(), encoding: 'undecoded' };
  }
}

const numberOf = (dict, key) => {
  const v = dict.get(PDFName.of(key));
  return v && typeof v.asNumber === 'function' ? v.asNumber() : undefined;
};

function componentsOf(ctx, dict) {
  const cs = resolve(ctx, dict.get(PDFName.of('ColorSpace')));
  if (!cs) return 1;
  if (cs instanceof PDFArray) {
    const kind = String(cs.get(0));
    if (kind === '/ICCBased') return numberOf(resolve(ctx, cs.get(1)).dict, 'N') ?? null;
    if (kind === '/CalRGB') return 3;
    if (kind === '/CalGray') return 1;
    return null; // Indexed, Separation, … not needed for QR codes
  }
  return { '/DeviceGray': 1, '/DeviceRGB': 3, '/DeviceCMYK': 4 }[String(cs)] ?? null;
}

function rgbaFromPdfImage(ctx, stream) {
  const d = stream.dict;
  const { bytes, encoding } = streamBytes(stream);
  if (encoding === '/DCTDecode') {
    const img = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { data: new Uint8ClampedArray(img.data.buffer), width: img.width, height: img.height };
  }
  if (encoding !== 'raw') return null;
  const w = numberOf(d, 'Width');
  const h = numberOf(d, 'Height');
  const bpc = numberOf(d, 'BitsPerComponent') ?? 8;
  const comps = componentsOf(ctx, d);
  if (!w || !h || !comps) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (bpc === 1 && comps === 1) {
    const row = Math.ceil(w / 8);
    if (bytes.length < row * h) return null;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = (bytes[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        rgba.set([v, v, v, 255], (y * w + x) * 4);
      }
    return { data: rgba, width: w, height: h };
  }
  if (bpc !== 8 || bytes.length < w * h * comps) return null;
  for (let i = 0, p = 0; i < w * h; i++, p += comps) {
    let r, g, b;
    if (comps === 1) r = g = b = bytes[p];
    else if (comps === 3) [r, g, b] = [bytes[p], bytes[p + 1], bytes[p + 2]];
    else {
      const k = 1 - bytes[p + 3] / 255;
      [r, g, b] = [0, 1, 2].map((j) => 255 * (1 - bytes[p + j] / 255) * k);
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { data: rgba, width: w, height: h };
}

function collectXObjects(ctx, resources, out, depth = 0) {
  if (!(resources instanceof PDFDict) || depth > 4) return;
  const xo = resolve(ctx, resources.get(PDFName.of('XObject')));
  if (!(xo instanceof PDFDict)) return;
  for (const [, ref] of xo.entries()) {
    const s = resolve(ctx, ref);
    if (!(s instanceof PDFRawStream)) continue;
    const sub = String(s.dict.get(PDFName.of('Subtype')));
    if (sub === '/Image') out.images.push(s);
    else if (sub === '/Form') {
      out.forms.push(s);
      collectXObjects(ctx, resolve(ctx, s.dict.get(PDFName.of('Resources'))), out, depth + 1);
    }
  }
}

function pageParts(doc, page) {
  const ctx = doc.context;
  const contents = resolve(ctx, page.node.get(PDFName.of('Contents')));
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => resolve(ctx, r)) : contents ? [contents] : [];
  const contentBytes = streams.filter((s) => s instanceof PDFRawStream).map((s) => streamBytes(s).bytes);
  const out = { images: [], forms: [] };
  collectXObjects(ctx, page.node.Resources(), out);
  return { ctx, contentBytes, ...out };
}

// Name-independent fingerprint of what a page draws: its content streams plus the images/forms it uses.
function fingerprint(parts) {
  const h = crypto.createHash('sha256');
  for (const c of parts.contentBytes) h.update(c);
  h.update(parts.images.map((s) => sha(streamBytes(s).bytes)).sort().join(','));
  h.update(parts.forms.map((s) => sha(streamBytes(s).bytes)).sort().join(','));
  return h.digest('hex');
}

// Text drawn with Tj (pdf-lib writes hex strings; other tools use literal strings).
function extractText(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  const out = [];
  for (const m of s.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)) out.push(Buffer.from(m[1].replace(/\s/g, ''), 'hex').toString('latin1'));
  for (const m of s.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(m[1].replace(/\\(.)/g, '$1'));
  return out.map((t) => t.trim()).filter(Boolean);
}

// Fallback locator: the verification page also prints the ID, hash and signature as text.
function locatorFromText(texts) {
  const id = texts.map((t) => t.match(ID_RE)?.[0]).find(Boolean);
  if (!id) return null;
  const hash = texts.find((t) => HASH_RE.test(t)) ?? null;
  let signature = null;
  const at = texts.findIndex((t) => /DIGITAL SIGNATURE/i.test(t));
  if (at >= 0) {
    const parts = [];
    for (let i = at + 1; i < texts.length && SIG_RE.test(texts[i]); i++) parts.push(texts[i]);
    signature = parts.join('') || null;
  }
  return { id, hash, signature };
}

// ---------------------------------------------------------------- public API

async function readPdf(buf) {
  let doc;
  try {
    doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return { kind: 'pdf', readable: false, pages: [] };
  }
  const parts = doc.getPages().map((p) => pageParts(doc, p));
  const pages = parts.map((p) => ({
    fingerprint: fingerprint(p),
    hasText: p.contentBytes.some((c) => extractText(c).length > 0),
    hasImages: p.images.length > 0,
  }));

  // The QR sits on the last page, so search from the back.
  let locator = null;
  let textLocator = null;
  for (let i = parts.length - 1; i >= 0 && !locator; i--) {
    for (const img of parts[i].images) {
      let rgba = null;
      try {
        rgba = rgbaFromPdfImage(parts[i].ctx, img);
      } catch {
        /* undecodable image: skip */
      }
      const text = rgba && findQr(rgba.data, rgba.width, rgba.height);
      if (text) {
        const q = parseQrText(text);
        locator = { ...q, source: 'qr', page: i + 1 };
        break;
      }
    }
    if (!textLocator) {
      const t = locatorFromText(parts[i].contentBytes.flatMap(extractText));
      if (t) textLocator = { ...t, source: 'text', page: i + 1 };
    }
  }
  return { kind: 'pdf', readable: true, pages, locator: locator?.id ? locator : textLocator ?? locator };
}

function readImage(buf, type) {
  let rgba;
  try {
    rgba = rgbaFromImageFile(buf, type);
  } catch {
    return { kind: 'image', readable: false, pages: [] };
  }
  const text = findQr(rgba.data, rgba.width, rgba.height);
  return { kind: 'image', readable: true, pages: [], locator: text ? { ...parseQrText(text), source: 'qr', page: 1 } : null };
}

export async function readDocument(buf) {
  const type = detectType(buf);
  if (type === 'application/pdf') return readPdf(buf);
  if (type) return readImage(buf, type);
  return { kind: 'unknown', readable: false, pages: [] };
}

// The registered verified PDF never changes, so its page fingerprints can be cached per instance.
const registeredCache = new Map();
export async function registeredPages(certId, stampedBuf) {
  if (!registeredCache.has(certId)) {
    if (registeredCache.size > 200) registeredCache.clear();
    registeredCache.set(certId, (await readPdf(stampedBuf)).pages);
  }
  return registeredCache.get(certId);
}

// Page-by-page comparison of an uploaded PDF with the registered verified PDF
// (scan pages first, verification page last).
export function comparePages(uploaded, registered) {
  const lastReg = registered.length - 1;
  const rows = [];
  for (let i = 0; i < Math.max(uploaded.length, registered.length); i++) {
    const role = i < lastReg ? 'certificate' : i === lastReg ? 'verification' : 'extra';
    const u = uploaded[i];
    const r = registered[i];
    const status = !u ? 'missing' : !r ? 'extra' : u.fingerprint === r.fingerprint ? 'match' : 'altered';
    rows.push({ page: i + 1, role, status });
  }
  // A printed-and-rescanned copy turns every page into a picture: nothing can match byte-for-byte,
  // and that is not proof of tampering on its own.
  const verificationPage = uploaded[Math.min(lastReg, uploaded.length - 1)];
  const rasterised =
    uploaded.length > 0 &&
    rows.every((r) => r.status !== 'match') &&
    uploaded.every((p) => p.hasImages && !p.hasText) &&
    verificationPage !== undefined;
  return { rows, rasterised };
}
