// End-to-end tests against a real server and a throwaway registry.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import { createApp } from '../src/app.js';
import { canonicalize, loadKeys, privateKeyPath, sha256 } from '../src/crypto.js';
import { openDb } from '../src/db.js';

let ctx, server, base, token;
const VERIFIER = { verifierName: 'Priya Shah', verifierOrganization: 'Acme Hiring Ltd', verifierEmail: 'priya@acme.test' };

async function call(method, url, { body, form, auth = true } = {}) {
  const headers = {};
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: form ?? (body && JSON.stringify(body)) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

function formOf(fields, file, name = 'scan.pdf') {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) form.append(k, String(v));
  if (file) form.append('file', new Blob([file]), name);
  return form;
}

// Stand-ins for a scanner's output: a one-page PDF and a PNG image.
async function scannedPdf(label) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText(`Scanned degree certificate: ${label}`, { x: 50, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await doc.save());
}
const scannedPng = (label) => QRCode.toBuffer(`scan of ${label}`, { width: 400 });

let seq = 0;
async function register(scan, overrides = {}, name = 'scan.pdf') {
  seq += 1;
  const res = await call('POST', '/admin/certificates', {
    form: formOf(
      {
        studentName: `Student ${seq}`,
        rollNo: `21CSE${String(seq).padStart(3, '0')}`,
        program: 'Bachelor of Technology',
        department: 'CSE',
        graduationYear: 2026,
        ...overrides,
      },
      scan,
      name,
    ),
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const pdf = (await call('GET', `/admin/certificates/${res.data.certificate.id}/file`)).data;
  return { ...res.data, pdf };
}

const verify = (fields, file) => call('POST', '/verify', { form: formOf({ ...VERIFIER, ...fields }, file), auth: false });
const qrFields = (qrText) => {
  const u = new URL(qrText);
  return { certificateId: u.pathname.split('/').pop(), qrHash: u.searchParams.get('h'), qrSignature: u.searchParams.get('s') };
};

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certverify-test-'));
  ctx = await createApp({ dataDir, publicUrl: 'http://portal.test' });
  server = ctx.app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await call('POST', '/admin/login', { body: { email: ctx.cfg.adminEmail, password: ctx.cfg.adminPassword } });
  assert.equal(login.status, 200);
  token = login.data.token;
});

after(() => {
  server?.close();
  ctx?.db.close();
});

describe('registrar upload', () => {
  test('a scanned PDF gets an ID, hash, signature and a QR page appended', async () => {
    const scan = await scannedPdf('A');
    const r = await register(scan, { studentName: 'Aarav Menon', rollNo: '21CSE900' });
    assert.equal(r.certificate.id, 'DEG-CSE-2026-001');
    assert.equal(r.certificate.documentHash, sha256(scan));
    assert.match(r.certificate.signature, /^[A-Za-z0-9_-]{86}$/);

    const out = await PDFDocument.load(r.pdf);
    assert.equal(out.getPageCount(), 2, 'scan page + verification page');

    const qr = qrFields(r.qrText);
    assert.equal(qr.certificateId, r.certificate.id);
    assert.equal(qr.qrHash, sha256(scan));
    assert.equal(qr.qrSignature, r.certificate.signature);
  });

  test('a scanned image (PNG) becomes a 2-page PDF', async () => {
    const r = await register(await scannedPng('B'), {}, 'scan.png');
    assert.equal((await PDFDocument.load(r.pdf)).getPageCount(), 2);
    assert.equal(r.certificate.documentType, 'image/png');
  });

  test('the original scan is kept byte-for-byte', async () => {
    const scan = await scannedPdf('C');
    const r = await register(scan);
    const original = await call('GET', `/admin/certificates/${r.certificate.id}/file?version=original`);
    assert.equal(sha256(original.data), sha256(scan));
  });

  test('the same scan cannot be registered twice', async () => {
    const scan = await scannedPdf('D');
    await register(scan);
    const again = await call('POST', '/admin/certificates', {
      form: formOf({ studentName: 'X Y', rollNo: 'R1', program: 'B.Tech', department: 'CSE', graduationYear: 2026 }, scan),
    });
    assert.equal(again.status, 409);
  });

  test('non-scan files and missing details are rejected', async () => {
    const fields = { studentName: 'X Y', rollNo: 'R1', program: 'B.Tech', department: 'CSE', graduationYear: 2026 };
    const txt = await call('POST', '/admin/certificates', { form: formOf(fields, Buffer.from('hello'), 'a.pdf') });
    assert.equal(txt.status, 400);
    const noName = await call('POST', '/admin/certificates', {
      form: formOf({ ...fields, studentName: '' }, await scannedPdf('E')),
    });
    assert.equal(noName.status, 400);
  });

  test('registrar endpoints require sign-in', async () => {
    assert.equal((await call('GET', '/admin/certificates', { auth: false })).status, 401);
    assert.equal((await call('GET', '/admin/verifications', { auth: false })).status, 401);
  });
});

describe('public verification', () => {
  test('scanning the genuine QR gives Verified', async () => {
    const r = await register(await scannedPdf('F'), { studentName: 'Diya Raman' });
    const res = await verify(qrFields(r.qrText));
    assert.equal(res.data.verdict, 'verified');
    assert.equal(res.data.steps.find((s) => s.key === 'qr').status, 'pass');
    assert.equal(res.data.certificate.studentName, 'Diya Raman');
  });

  test('entering the certificate ID gives Verified (QR check skipped)', async () => {
    const res = await verify({ certificateId: 'deg-cse-2026-001' });
    assert.equal(res.data.verdict, 'verified');
    assert.equal(res.data.steps.find((s) => s.key === 'qr').status, 'skipped');
  });

  test('a QR whose hash was altered is rejected as tampered', async () => {
    const r = await register(await scannedPdf('G'));
    const qr = qrFields(r.qrText);
    const res = await verify({ ...qr, qrHash: sha256('forged') });
    assert.equal(res.data.verdict, 'tampered');
  });

  test('a QR with a forged signature is rejected', async () => {
    const r = await register(await scannedPdf('H'));
    const qr = qrFields(r.qrText);
    const res = await verify({ ...qr, qrSignature: qr.qrSignature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) });
    assert.equal(res.data.verdict, 'invalid_signature');
  });

  test("a QR copied onto someone else's certificate does not verify", async () => {
    const a = await register(await scannedPdf('I1'));
    const b = await register(await scannedPdf('I2'));
    const res = await verify({ ...qrFields(b.qrText), certificateId: a.certificate.id });
    assert.equal(res.data.verdict, 'tampered');
  });

  test('uploading the verified PDF or the original scan gives Verified; an edited one is Tampered', async () => {
    const scan = await scannedPdf('J');
    const r = await register(scan);
    assert.equal((await verify({ certificateId: r.certificate.id }, r.pdf)).data.verdict, 'verified');
    assert.equal((await verify({ certificateId: r.certificate.id }, scan)).data.verdict, 'verified');
    assert.equal((await verify({}, r.pdf)).data.certificateId, r.certificate.id, 'file alone finds the certificate');

    const edited = Buffer.concat([r.pdf, Buffer.from('\n% edited\n')]);
    assert.equal((await verify({ certificateId: r.certificate.id }, edited)).data.verdict, 'tampered');
    assert.equal((await verify({}, edited)).data.verdict, 'not_found');
  });

  test('unknown ID shows Not found', async () => {
    const res = await verify({ certificateId: 'DEG-CSE-2026-999' });
    assert.equal(res.data.verdict, 'not_found');
    assert.equal(res.data.certificate, undefined);
  });

  test('registry edits without re-signing give Invalid signature and hide details', async () => {
    const r = await register(await scannedPdf('K'));
    const row = await ctx.db.get('SELECT payload FROM certificates WHERE id = ?', r.certificate.id);
    const forged = canonicalize({ ...JSON.parse(row.payload), studentName: 'Someone Else' });
    await ctx.db.run('UPDATE certificates SET payload = ? WHERE id = ?', forged, r.certificate.id);
    const res = await verify(qrFields(r.qrText));
    assert.equal(res.data.verdict, 'invalid_signature');
    assert.equal(res.data.certificate, undefined);
  });

  test('a revoked certificate is never shown as valid', async () => {
    const r = await register(await scannedPdf('L'));
    const revoke = await call('POST', `/admin/certificates/${r.certificate.id}/revoke`, { body: { reason: 'Issued in error' } });
    assert.equal(revoke.status, 200);
    assert.equal((await verify(qrFields(r.qrText))).data.verdict, 'revoked');
    assert.equal((await verify(qrFields(r.qrText), r.pdf)).data.verdict, 'revoked');
  });

  test('verifier name and organisation are required', async () => {
    const res = await call('POST', '/verify', { form: formOf({ certificateId: 'DEG-CSE-2026-001' }), auth: false });
    assert.equal(res.status, 400);
  });
});

describe('deployment configuration', () => {
  test('the signing key can come from INSTITUTION_PRIVATE_KEY as PEM or base64', async () => {
    const pem = fs.readFileSync(privateKeyPath(ctx.cfg.dataDir), 'utf8');
    for (const value of [pem, pem.replace(/\n/g, '\\n'), Buffer.from(pem).toString('base64')]) {
      const keys = loadKeys({ privateKey: value, onVercel: true });
      assert.equal(keys.keyId, ctx.keys.keyId, 'same key, so existing signatures keep verifying');
    }
  });

  test('on Vercel, missing key or database settings fail loudly instead of using temporary storage', async () => {
    assert.throws(() => loadKeys({ onVercel: true }), /INSTITUTION_PRIVATE_KEY/);
    await assert.rejects(openDb({ onVercel: true }), /TURSO_DATABASE_URL/);
  });

  test('uploads over the size limit get a clear 413', async () => {
    const small = await createApp({ dataDir: ctx.cfg.dataDir, maxUploadMb: 0.01 });
    const s = small.app.listen(0);
    await once(s, 'listening');
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/api/verify`, {
        method: 'POST',
        body: formOf({ ...VERIFIER, certificateId: 'DEG-CSE-2026-001' }, Buffer.alloc(50_000)),
      });
      assert.equal(res.status, 413);
      assert.match((await res.json()).error, /larger than/);
    } finally {
      s.close();
      small.db.close();
    }
  });
});

describe('registrar sees who verified', () => {
  test('every public check appears in the verifications feed with the verifier', async () => {
    const before = (await call('GET', '/admin/verifications/count?after=0')).data.latestId;
    await verify({ certificateId: 'DEG-CSE-2026-001', verifierName: 'Ravi Kumar', verifierOrganization: 'Globex' });

    const count = await call('GET', `/admin/verifications/count?after=${before}`);
    assert.equal(count.data.newCount, 1);

    const feed = await call('GET', `/admin/verifications?after=${before}`);
    const v = feed.data.verifications[0];
    assert.equal(v.cert_id, 'DEG-CSE-2026-001');
    assert.equal(v.verifier_name, 'Ravi Kumar');
    assert.equal(v.verifier_org, 'Globex');
    assert.equal(v.verdict, 'verified');
    assert.equal(v.method, 'Certificate ID');

    const detail = await call('GET', '/admin/certificates/DEG-CSE-2026-001');
    assert.ok(detail.data.verifications.some((x) => x.verifier_name === 'Ravi Kumar'));
    const list = await call('GET', '/admin/certificates?q=DEG-CSE-2026-001');
    assert.ok(list.data.certificates[0].verificationCount >= 2);
  });
});
