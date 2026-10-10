// End-to-end tests against a real server and a throwaway registry, once per storage backend.
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
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { openStore, parseServiceAccount } from '../src/store/index.js';
import { SqlStore } from '../src/store/sql.js';
import { FakeFirestore, increment } from './fake-firestore.js';
import { buildVerifiedPdf } from '../src/stamp.js';
import { compareMarks, compareName, comparePaper, compareRoll, compareYear, editDistance } from '../src/paper.js';
import { certificatePageImage } from '../src/document.js';

const OCR_PAYLOAD = { studentName: 'Kavya Nair', rollNo: '21CSE777', marks: '77%', graduationYear: 2026 };

describe('paper comparison (OCR text against the signed record)', () => {
  test('fuzzy name matching tolerates OCR errors within 2 edits per word', () => {
    assert.equal(editDistance('KAVYA', 'KALYA'), 1);
    const fuzzy = compareName('Student Name: Kalya Nar\n', OCR_PAYLOAD.studentName);
    assert.equal(fuzzy.match, true);
    assert.equal(compareName('Name: Ravi Kumar VERMA', 'Kavya Nair').match, false, 'a different name is a mismatch');
    assert.equal(compareName('Student Name: KavyaNair', 'Kavya Nair').match, false, 'glued words still count via edits');
  });

  test('O/0 and I/1 confusion is treated as the same character', () => {
    assert.equal(compareRoll('Roll No: 21CSEO77', '21CSE077').match, true, 'letter O read as zero');
    assert.equal(compareRoll('Roll No : 21-CSE-777', '21CSE777').match, true, 'spaces and hyphens ignored');
    assert.equal(compareRoll('Roll No: 21CSE999', '21CSE777').match, false);
    assert.equal(compareYear('Passed in year 2O26', '2026').match, true, 'O read as zero in a year');
  });

  test('marks match exactly and a conflicting percentage is a conflict', () => {
    assert.equal(compareMarks('Aggregate: 77%', '77%').match, true);
    assert.equal(compareMarks('Aggregate: 77 %', '77%').match, true, 'a space before % is tolerated');
    const conflicted = compareMarks('Percentage: 90%', '77%');
    assert.equal(conflicted.match, false);
    assert.equal(conflicted.conflicts.length, 1);
    assert.equal(conflicted.conflicts[0].paper, '90%');

    const both = compareMarks('Percentage: 77% (rechecked 90%)', '77%');
    assert.equal(both.match, true, 'the genuine 77% is present…');
    assert.equal(both.conflicts.length, 1, '…but the 90% is still a conflict');
  });

  test('CGPA values compare the same way as percentages', () => {
    assert.equal(compareMarks('CGPA: 8.5', '8.5 CGPA').match, true);
    const conflicted = compareMarks('CGPA 9.0, First Class', '8.5 CGPA');
    assert.equal(conflicted.match, false);
    assert.equal(conflicted.conflicts[0].paper, 'CGPA 9.0');
  });

  test('non-numeric results are matched verbatim', () => {
    assert.equal(compareMarks('Result: FIRST CLASS with Distinction', 'First Class').match, true);
    assert.equal(compareMarks('Result: Pass', 'First Class').match, false);
  });

  test('a verification-page photo is never trusted as the certificate', () => {
    const paper = comparePaper('Certificate Verification Page\nStudent name: Kavya Nair\nMarks: 77%', OCR_PAYLOAD);
    assert.equal(paper.verificationPage, true);
  });

  test('readable text with every detail matching gives a clean comparison', () => {
    const paper = comparePaper('DEGREE CERTIFICATE\nKavya Nair\nRoll: 21CSE777\nTotal: 77%\nYear 2026', OCR_PAYLOAD);
    assert.equal(paper.readable, true);
    assert.equal(paper.verificationPage, false);
    assert.equal(paper.conflicts.length, 0);
    assert.ok(paper.fields.every((f) => f.match));
  });

  test('a paper that says 90% produces a marks conflict', () => {
    const paper = comparePaper('DEGREE CERTIFICATE\nKavya Nair\n21CSE777\nPercentage: 90%\n2026', OCR_PAYLOAD);
    assert.equal(paper.readable, true);
    assert.ok(paper.conflicts.some((c) => c.field === 'marks' && c.paper === '90%' && c.registry === '77%'));
  });

  test('empty or short OCR is not readable', () => {
    assert.equal(comparePaper('', OCR_PAYLOAD).readable, false);
    assert.equal(comparePaper('Blurry scan', OCR_PAYLOAD).readable, false);
  });
});

function defineSuite(label, makeOverrides) {
  describe(label, () => {
    let ctx, server, base, token;
    const VERIFIER = { verifierName: 'Priya Shah', verifierOrganization: 'Acme Hiring Ltd', verifierEmail: 'priya@acme.test' };

    // Deterministic stand-in for Tesseract: a given image buffer always "reads" as the text it was set to.
    // This keeps the suite offline and fast; the real engine is exercised separately.
    function makeOcrStub() {
      const map = new Map();
      const stub = async (buf) => map.get(sha256(buf)) ?? '';
      stub.override = (buf, text) => map.set(sha256(buf), text);
      return stub;
    }
    const ocrStub = makeOcrStub();

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
    // What the verify page sends after a QR scan.
    const qrFields = (qrText) => {
      const u = new URL(qrText);
      const p = (k) => u.searchParams.get(k) ?? undefined;
      return {
        certificateId: u.pathname.split('/').pop(),
        qrHash: p('h'),
        qrSignature: p('s'),
        qrName: p('n'),
        qrRoll: p('r'),
        qrMarks: p('m'),
        qrYear: p('y'),
      };
    };

    before(async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certverify-test-'));
      ctx = await createApp({ dataDir, publicUrl: 'http://portal.test', ocr: ocrStub, ...makeOverrides() });
      server = ctx.app.listen(0);
      await once(server, 'listening');
      base = `http://127.0.0.1:${server.address().port}/api`;
      const login = await call('POST', '/admin/login', { body: { email: ctx.cfg.adminEmail, password: ctx.cfg.adminPassword } });
      assert.equal(login.status, 200);
      token = login.data.token;
    });

    after(() => {
      server?.close();
      ctx?.store.close();
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

      test("a large scan (over Firestore's 1 MB document limit) round-trips intact", async () => {
        const noise = new PNG({ width: 900, height: 900 });
        crypto.randomFillSync(noise.data);
        const big = PNG.sync.write(noise);
        assert.ok(big.length > 2_000_000, `scan is ${big.length} bytes`);
        const r = await register(big, {}, 'big.png');
        const original = await call('GET', `/admin/certificates/${r.certificate.id}/file?version=original`);
        assert.equal(sha256(original.data), sha256(big));
        assert.equal((await verify({}, r.pdf)).data.verdict, 'verified');
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
        const row = await ctx.store.getCertificate(r.certificate.id);
        const forged = canonicalize({ ...JSON.parse(row.payload), studentName: 'Someone Else' });
        await ctx.store.updateCertificatePayload(r.certificate.id, forged);
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

    describe('QR details (copied-QR scenario)', () => {
      // Puts a screenshot of a genuine QR onto a brand-new fake certificate page.
      async function fakeCertificateWithQr(qrText, fakeText) {
        const doc = await PDFDocument.create();
        const page = doc.addPage([595, 842]);
        const font = await doc.embedFont(StandardFonts.HelveticaBold);
        page.drawText(fakeText, { x: 60, y: 720, size: 18, font });
        const qr = await doc.embedPng(await QRCode.toBuffer(qrText, { width: 500 }));
        page.drawImage(qr, { x: 360, y: 60, width: 180, height: 180 });
        return Buffer.from(await doc.save());
      }

      test('the QR carries name, roll number, marks and year, and they match the signed record', async () => {
        const r = await register(await scannedPdf('U'), { studentName: 'Kavya Nair', rollNo: '21CSE777', marks: '77%' });
        const u = new URL(r.qrText);
        assert.equal(u.searchParams.get('m'), '77%');
        assert.equal(u.searchParams.get('n'), 'Kavya Nair');
        assert.equal(r.certificate.marks, '77%');
        assert.equal(JSON.parse((await ctx.store.getCertificate(r.certificate.id)).payload).marks, '77%', 'marks are signed');

        const res = (await verify(qrFields(r.qrText))).data;
        assert.equal(res.verdict, 'verified');
        assert.equal(res.certificate.marks, '77%');
        assert.deepEqual(
          res.qrDetails.map((d) => [d.field, d.qr, d.match]),
          [
            ['name', 'Kavya Nair', true],
            ['roll', '21CSE777', true],
            ['marks', '77%', true],
            ['year', '2026', true],
          ],
        );
      });

      test('a QR whose marks were edited (77% -> 90%) is tampered', async () => {
        const r = await register(await scannedPdf('V'), { marks: '77%' });
        const res = (await verify({ ...qrFields(r.qrText), qrMarks: '90%' })).data;
        assert.equal(res.verdict, 'tampered');
        assert.equal(res.malpractice, true);
        assert.ok(res.findings.some((f) => f.code === 'qr-details' && f.message.includes('"90%"') && f.message.includes('"77%"')));
        assert.equal(res.qrDetails.find((d) => d.field === 'marks').match, false);
      });

      test('a genuine QR screenshot pasted onto a fake certificate is caught when the document is uploaded', async () => {
        const r = await register(await scannedPdf('W'), { studentName: 'Kavya Nair', marks: '77%' });
        const fake = await fakeCertificateWithQr(r.qrText, 'DEGREE CERTIFICATE - Kavya Nair - 90% Distinction');
        const res = (await verify({}, fake)).data;
        assert.equal(res.certificateId, r.certificate.id, 'the copied QR still leads to the genuine record');
        assert.equal(res.verdict, 'tampered');
        assert.equal(res.malpractice, true);
        assert.equal(res.qrDetails.find((d) => d.field === 'marks').qr, '77%', 'the output shows what the QR really says');
        assert.ok(res.alertId);
      });

      test('a verifier can report that the paper differs from the QR, which alerts the registrar', async () => {
        const r = await register(await scannedPdf('X'), { marks: '77%' });
        const report = await call('POST', '/report-mismatch', {
          auth: false,
          body: { ...VERIFIER, certificateId: r.certificate.id, shownDetails: 'Certificate shows 90%' },
        });
        assert.equal(report.status, 201);
        const alerts = (await call('GET', `/admin/alerts?certId=${r.certificate.id}`)).data.alerts;
        assert.ok(alerts.some((a) => a.id === report.data.alertId && a.findings[0].code === 'reported-mismatch'));
        assert.match(alerts[0].findings[0].message, /90%/);

        assert.equal((await call('POST', '/report-mismatch', { auth: false, body: { ...VERIFIER, certificateId: 'DEG-CSE-2026-998' } })).status, 404);
        assert.equal((await call('POST', '/report-mismatch', { auth: false, body: { certificateId: r.certificate.id } })).status, 400);
      });

      test('certificates registered without marks still verify (marks are optional)', async () => {
        const r = await register(await scannedPdf('Y'));
        assert.equal(new URL(r.qrText).searchParams.get('m'), null);
        assert.equal((await verify(qrFields(r.qrText))).data.verdict, 'verified');
      });
    });

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

    describe('photo of the whole certificate (scan everything)', () => {
      // A photo of the certificate: the QR code on it locates the record, and the printed details must match it.
      const photoOf = async (qrText) => QRCode.toBuffer(qrText, { width: 600 });

      test('a genuine photo whose printed details match the registry is Verified', async () => {
        const r = await register(await scannedPdf('Z1'), { studentName: 'Kavya Nair', rollNo: '21CSE777', marks: '77%' });
        const photo = await photoOf(r.qrText);
        ocrStub.override(photo, 'DEGREE CERTIFICATE\nStudent Name: Kavya Nair\nRoll No: 21CSE777\nAggregate: 77%\nYear: 2026');
        const res = (await verify({}, photo)).data;
        assert.equal(res.verdict, 'verified');
        assert.equal(res.malpractice, false);
        assert.ok(res.findings.some((f) => f.code === 'paper-check'));
        assert.equal(res.paper.fields.find((f) => f.field === 'marks').match, true);
        assert.equal(res.paper.conflicts.length, 0);
      });

      test('a genuine QR on a paper that says 90% is flagged as a fake and alerts the registrar', async () => {
        const r = await register(await scannedPdf('Z2'), { studentName: 'Kavya Nair', rollNo: '21CSE777', marks: '77%' });
        const photo = await photoOf(r.qrText);
        ocrStub.override(photo, 'DEGREE CERTIFICATE\nName: Kavya Nair\nRoll: 21CSE777\nAggregate: 90%\nYear: 2026');
        const res = (await verify({}, photo)).data;
        assert.equal(res.verdict, 'tampered');
        assert.equal(res.malpractice, true);
        assert.equal(res.certificateId, r.certificate.id, 'the photocopied QR still points at the genuine record');
        assert.ok(res.findings.some((f) => f.code === 'qr-paper-mismatch' && f.severity === 'high'));
        assert.ok(res.paper.conflicts.some((c) => c.paper === '90%' && c.registry === '77%'));
        assert.ok(res.alertId, 'the registrar is alerted');
      });

      test('a genuine QR on someone else\u2019s certificate is caught by the name check', async () => {
        const r = await register(await scannedPdf('Z3'), { studentName: 'Kavya Nair', rollNo: '21CSE777', marks: '77%' });
        const photo = await photoOf(r.qrText);
        ocrStub.override(photo, 'DEGREE CERTIFICATE\nName: Ravi Kumar\nRoll: 21CSE777\nAggregate: 77%\nYear: 2026');
        const res = (await verify({}, photo)).data;
        assert.equal(res.verdict, 'tampered');
        assert.ok(res.findings.some((f) => f.code === 'qr-paper-mismatch' && /Student name/.test(f.message)));
      });

      test('a scanned PDF claiming different marks (99% vs the registered 90) under a genuine QR is a fake certificate', async () => {
        const r = await register(await scannedPdf('Z6'), { studentName: 'ragav K', rollNo: '23CS334', marks: '90', graduationYear: 2002 });
        // A brand-new PDF whose certificate page is a scan (an embedded image, no text layer), carrying
        // the genuine QR on its last page. Page comparison alone can only say "this is a rescan".
        const doc = await PDFDocument.create();
        const certPage = doc.addPage([595, 842]);
        const scanImage = await doc.embedPng(await QRCode.toBuffer(`fabricated scan for ${r.certificate.id}`, { width: 500 }));
        certPage.drawImage(scanImage, { x: 60, y: 350, width: 400, height: 400 });
        const qrImage = await doc.embedPng(await QRCode.toBuffer(r.qrText, { width: 500 }));
        const qrPage = doc.addPage([595, 842]);
        qrPage.drawImage(qrImage, { x: 120, y: 120, width: 300, height: 300 });
        const pdf = Buffer.from(await doc.save());

        // OCR reads the certificate page that was scanned in: it says 99%, the registry says 90.
        const pageImage = await certificatePageImage(pdf);
        assert.ok(pageImage, 'the scanned certificate page is decoded so it can be read by OCR');
        assert.equal(await certificatePageImage(await scannedPdf('plain text page')), null, 'a text-only page has nothing to OCR');
        ocrStub.override(pageImage, 'DEGREE CERTIFICATE\nStudent Name: ragav K\nRoll No: 23CS334\nAggregate: 99%\nYear: 2002');

        const res = (await verify({}, pdf)).data;
        assert.equal(res.certificateId, r.certificate.id, 'the genuine OCR still leads to the genuine record');
        assert.equal(res.verdict, 'tampered');
        assert.equal(res.malpractice, true);
        assert.ok(res.findings.some((f) => f.code === 'qr-paper-mismatch' && f.severity === 'high'));
        assert.ok(res.paper.conflicts.some((c) => c.paper === '99%' && c.registry === '90'));
        assert.ok(res.alertId, 'the registrar is alerted');
      });

      test('a scanned PDF of the genuine certificate passes the text check but is still sent to a visual review', async () => {
        const r = await register(await scannedPdf('Z7'), { studentName: 'ragav K', rollNo: '23CS334', marks: '90', graduationYear: 2002 });
        const doc = await PDFDocument.create();
        const certPage = doc.addPage([595, 842]);
        const scanImage = await doc.embedPng(await QRCode.toBuffer(`genuine scan for ${r.certificate.id}`, { width: 500 }));
        certPage.drawImage(scanImage, { x: 60, y: 350, width: 400, height: 400 });
        const qrImage = await doc.embedPng(await QRCode.toBuffer(r.qrText, { width: 500 }));
        const qrPage = doc.addPage([595, 842]);
        qrPage.drawImage(qrImage, { x: 120, y: 120, width: 300, height: 300 });
        const pdf = Buffer.from(await doc.save());
        const pageImage = await certificatePageImage(pdf);
        ocrStub.override(pageImage, 'DEGREE CERTIFICATE\nStudent Name: ragav K\nRoll No: 23CS334\nAggregate: 90%\nYear: 2002');
        const res = (await verify({}, pdf)).data;
        assert.equal(res.verdict, 'review', 'a rescanned copy gets a visual check, not a green Verified');
        assert.equal(res.malpractice, false);
        assert.ok(res.findings.some((f) => f.code === 'rescanned'));
      });

      test('a photo of the verification page is sent for a visual check, never trusted', async () => {
        const r = await register(await scannedPdf('Z4'), { studentName: 'Kavya Nair', marks: '77%' });
        const photo = await photoOf(r.qrText);
        ocrStub.override(photo, 'Certificate Verification Page\nStudent name: Kavya Nair\nMarks: 77%\nYear: 2026');
        const res = (await verify({}, photo)).data;
        assert.equal(res.verdict, 'review');
        assert.equal(res.paper.verificationPage, true);
        assert.ok(res.findings.some((f) => f.code === 'verification-page'));
      });

      test('a photo with unreadable text is sent for a visual check with a retake hint', async () => {
        const r = await register(await scannedPdf('Z5'), { marks: '77%' });
        const photo = await photoOf(r.qrText);
        ocrStub.override(photo, 'DLT CWZ'); // Tesseract garbage
        const res = (await verify({}, photo)).data;
        assert.equal(res.verdict, 'review');
        assert.equal(res.malpractice, false);
        assert.ok(res.findings.some((f) => f.code === 'image-unreadable'));
      });
    });

    describe('deployment configuration', () => {
      test('on Vercel without INSTITUTION_PRIVATE_KEY, one key is generated into the database and reused', async () => {
        const a = await resolveKeys({ onVercel: true }, ctx.store);
        const b = await resolveKeys({ onVercel: true }, ctx.store);
        assert.equal(a.keyId, b.keyId);
      });

      test('the signing key can come from INSTITUTION_PRIVATE_KEY as PEM or base64', async () => {
        const pem = fs.readFileSync(privateKeyPath(ctx.cfg.dataDir), 'utf8');
        for (const value of [pem, pem.replace(/\n/g, '\\n'), Buffer.from(pem).toString('base64')]) {
          const keys = loadKeys({ privateKey: value, onVercel: true });
          assert.equal(keys.keyId, ctx.keys.keyId, 'same key, so existing signatures keep verifying');
        }
      });

      test('without Turso, a fresh SQLite file plus a database-held key works (Vercel temporary storage)', async () => {
        assert.throws(() => loadKeys({ onVercel: true }), /INSTITUTION_PRIVATE_KEY/);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certverify-ephemeral-'));
        const db = await SqlStore.open({ dataDir: dir });
        const keys = await resolveKeys({ onVercel: true }, db);
        assert.equal((await resolveKeys({ onVercel: true }, db)).keyId, keys.keyId);
        db.close();
        assert.equal((await call('GET', '/institution', { auth: false })).data.storage, 'persistent');
      });

      test('uploads over the size limit get a clear 413', async () => {
        const small = await createApp({ ...makeOverrides(), dataDir: ctx.cfg.dataDir, maxUploadMb: 0.01 });
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
          small.store.close();
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
  });
}

describe('Firebase configuration', () => {
  const fakeServiceAccount = () => ({
    type: 'service_account',
    project_id: 'certverify-test',
    client_email: 'svc@certverify-test.iam.gserviceaccount.com',
    private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });

  test('FIREBASE_SERVICE_ACCOUNT is accepted as JSON or base64, and must be a service-account key', () => {
    const sa = fakeServiceAccount();
    assert.equal(parseServiceAccount(JSON.stringify(sa)).project_id, 'certverify-test');
    assert.equal(parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString('base64')).client_email, sa.client_email);
    assert.throws(() => parseServiceAccount('{"project_id":"x"}'), /service-account key/);
  });

  test('a service-account key selects the real Firestore client (no network until first use)', async () => {
    const store = await openStore({ firebaseServiceAccount: JSON.stringify(fakeServiceAccount()) });
    assert.equal(store.kind, 'firestore');
    assert.equal(typeof store.fs.collection, 'function');
  });
});

defineSuite('storage: SQLite', () => ({}));
defineSuite('storage: Firestore (in-memory)', () => ({ firestore: new FakeFirestore(), firestoreIncrement: increment }));
