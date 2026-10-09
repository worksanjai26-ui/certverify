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
import { canonicalize, loadKeys, privateKeyPath, resolveKeys, sha256 } from '../src/crypto.js';
import { openDb } from '../src/db.js';
import { buildVerifiedPdf } from '../src/stamp.js';

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

  test('uploading the verified PDF or the original scan gives Verified', async () => {
    const scan = await scannedPdf('J');
    const r = await register(scan);
    assert.equal((await verify({ certificateId: r.certificate.id }, r.pdf)).data.verdict, 'verified');
    assert.equal((await verify({ certificateId: r.certificate.id }, scan)).data.verdict, 'verified');
    assert.equal((await verify({}, r.pdf)).data.certificateId, r.certificate.id, 'file alone finds the certificate');
  });

  test('bytes appended without changing any page count as re-saved, not tampered', async () => {
    const r = await register(await scannedPdf('J2'));
    const resaved = Buffer.concat([r.pdf, Buffer.from('\n% edited\n')]);
    const res = (await verify({}, resaved)).data;
    assert.equal(res.verdict, 'verified');
    assert.ok(res.findings.some((f) => f.code === 'resaved'));
    assert.equal(res.malpractice, false);
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

// ---- Document comparison: the employer uploads what they were given ----
async function editPage(pdf, index, text = 'FORGED CGPA 9.99') {
  const d = await PDFDocument.load(pdf);
  d.getPage(index).drawText(text, { x: 60, y: 60, size: 18, font: await d.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await d.save());
}

async function combine(...picks) {
  const out = await PDFDocument.create();
  for (const [pdf, index] of picks) {
    const [page] = await out.copyPages(await PDFDocument.load(pdf), [index]);
    out.addPage(page);
  }
  return Buffer.from(await out.save());
}

const openAlerts = async () => (await call('GET', '/admin/alerts?status=open')).data.alerts;

describe('document verification and malpractice', () => {
  test('the QR on the last page locates the certificate and every page is compared', async () => {
    const r = await register(await scannedPdf('M'));
    const res = (await verify({}, r.pdf)).data;
    assert.equal(res.verdict, 'verified');
    assert.equal(res.document.locator.source, 'qr');
    assert.equal(res.document.locator.page, 2);
    assert.equal(res.steps.find((s) => s.key === 'qr').status, 'pass');
    assert.equal(res.malpractice, false);
  });

  test('a re-saved copy with identical pages is compared page by page and passes', async () => {
    const r = await register(await scannedPdf('N'));
    const resaved = Buffer.from(await (await PDFDocument.load(r.pdf)).save());
    assert.notEqual(sha256(resaved), sha256(r.pdf));
    const res = (await verify({}, resaved)).data;
    assert.equal(res.verdict, 'verified');
    assert.deepEqual(res.document.comparison.rows.map((x) => x.status), ['match', 'match']);
  });

  test('an edited certificate page is tampered, named in the output, and alerts the admin', async () => {
    const r = await register(await scannedPdf('O'));
    const before = (await openAlerts()).length;
    const res = (await verify({ verifierName: 'Eve Mallory', verifierOrganization: 'Shady Corp' }, await editPage(r.pdf, 0))).data;
    assert.equal(res.verdict, 'tampered');
    assert.equal(res.malpractice, true);
    assert.equal(res.certificateId, r.certificate.id);
    assert.deepEqual(res.document.comparison.rows.map((x) => x.status), ['altered', 'match']);
    assert.ok(res.findings.some((f) => f.code === 'page-altered' && /Certificate page 1/.test(f.message)));
    assert.ok(res.alertId);

    const alerts = await openAlerts();
    assert.equal(alerts.length, before + 1);
    assert.equal(alerts[0].cert_id, r.certificate.id);
    assert.equal(alerts[0].verifier_name, 'Eve Mallory');
    assert.equal(alerts[0].severity, 'high');
    assert.ok(alerts[0].findings.length >= 1);
  });

  test('an edited verification (QR) page is tampered', async () => {
    const r = await register(await scannedPdf('P'));
    const res = (await verify({}, await editPage(r.pdf, 1, 'Approved'))).data;
    assert.equal(res.verdict, 'tampered');
    assert.deepEqual(res.document.comparison.rows.map((x) => x.status), ['match', 'altered']);
  });

  test("a genuine QR page stapled to someone else's certificate is caught", async () => {
    const a = await register(await scannedPdf('Q1'));
    const b = await register(await scannedPdf('Q2'));
    const res = (await verify({}, await combine([a.pdf, 0], [b.pdf, 1]))).data;
    assert.equal(res.certificateId, b.certificate.id, 'the QR leads to B');
    assert.equal(res.verdict, 'tampered', "but page 1 is A's certificate");
    assert.equal(res.document.comparison.rows[0].status, 'altered');
  });

  test('an added or removed page is caught', async () => {
    const r = await register(await scannedPdf('R'));
    const extra = await combine([r.pdf, 0], [r.pdf, 1], [r.pdf, 0]);
    const added = (await verify({}, extra)).data;
    assert.equal(added.verdict, 'tampered');
    assert.ok(added.findings.some((f) => f.code === 'page-extra'));

    const onlyQrPage = await combine([r.pdf, 1]);
    const removed = (await verify({ certificateId: r.certificate.id }, onlyQrPage)).data;
    assert.equal(removed.verdict, 'tampered');
  });

  test('a fake certificate whose QR points to an unregistered ID is flagged as forged', async () => {
    const fakeId = 'DEG-CSE-2026-777';
    const fake = await buildVerifiedPdf(
      await scannedPdf('fake'),
      'application/pdf',
      {
        certificateId: fakeId,
        institution: 'Demo Institute of Technology',
        studentName: 'Faker',
        rollNo: 'X1',
        program: 'B.Tech',
        department: 'CSE',
        graduationYear: 2026,
        issuedAt: new Date().toISOString(),
        documentHash: sha256('x'),
        signature: 'A'.repeat(86),
        keyId: 'deadbeef',
        portalUrl: 'http://portal.test',
      },
      `http://portal.test/verify/${fakeId}?h=${sha256('x')}&s=${'A'.repeat(86)}`,
    );
    const res = (await verify({}, fake)).data;
    assert.equal(res.verdict, 'not_found');
    assert.equal(res.malpractice, true);
    assert.ok(res.findings.some((f) => f.code === 'unknown-id'));
    assert.ok((await openAlerts()).some((a) => a.findings.some((f) => f.code === 'unknown-id')));
  });

  test('a photo of the QR is checked but sent for visual review, with the registered copy', async () => {
    const r = await register(await scannedPdf('S'));
    const photo = await QRCode.toBuffer(r.qrText, { width: 600 });
    const res = (await verify({}, photo)).data;
    assert.equal(res.verdict, 'review');
    assert.equal(res.steps.find((s) => s.key === 'qr').status, 'pass');
    assert.ok(res.registeredCopyUrl);

    const copy = await fetch(base.replace(/\/api$/, '') + res.registeredCopyUrl);
    assert.equal(copy.status, 200);
    assert.equal(sha256(Buffer.from(await copy.arrayBuffer())), sha256(r.pdf));
    const forgedLink = await fetch(base.replace(/\/api$/, '') + res.registeredCopyUrl.replace(/sig=.*/, 'sig=nope'));
    assert.equal(forgedLink.status, 403);
  });

  test('a typed ID alone never reveals the registered copy', async () => {
    const res = (await verify({ certificateId: 'DEG-CSE-2026-001' })).data;
    assert.equal(res.registeredCopyUrl, undefined);
  });

  test('presenting a revoked certificate raises an alert', async () => {
    const r = await register(await scannedPdf('T'));
    await call('POST', `/admin/certificates/${r.certificate.id}/revoke`, { body: { reason: 'Degree withdrawn' } });
    const res = (await verify({}, r.pdf)).data;
    assert.equal(res.verdict, 'revoked');
    assert.equal(res.malpractice, true);
    assert.ok((await openAlerts()).some((a) => a.cert_id === r.certificate.id && a.severity === 'medium'));
  });

  test('the registrar can acknowledge an alert', async () => {
    const [first] = await openAlerts();
    const before = (await call('GET', '/admin/alerts/count')).data.open;
    const ack = await call('POST', `/admin/alerts/${first.id}/ack`, { body: { note: 'Called the employer' } });
    assert.equal(ack.status, 200);
    assert.equal((await call('GET', '/admin/alerts/count')).data.open, before - 1);
    assert.equal((await call('POST', `/admin/alerts/${first.id}/ack`, { body: {} })).status, 404);
    assert.equal((await call('GET', '/admin/alerts', { auth: false })).status, 401);
  });
});

describe('deployment configuration', () => {
  test('on Vercel without INSTITUTION_PRIVATE_KEY, one key is generated into the database and reused', async () => {
    const a = await resolveKeys({ onVercel: true }, ctx.db);
    const b = await resolveKeys({ onVercel: true }, ctx.db);
    assert.equal(a.keyId, b.keyId);
  });

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
