# CertVerify: handoff notes

*Written 10 Oct 2026, when the Claude weekly limit reached 97%. Hand this file to the next session, or to anyone continuing the work.*

## What it is

A degree certificate verification portal.

- **Registrar** (admin): uploads a scanned degree certificate (PDF/JPG/PNG, up to 4 MB on Vercel) plus the student's details and marks. The server assigns an ID (`DEG-<DEPT>-<YEAR>-<NNN>`), takes the SHA-256 of the scan, and signs the record with Ed25519. It then appends a **verification page with a QR code** after the scan.
- **Employer** (public): uploads the certificate they were given, scans its QR, or types the ID. The portal cross-checks everything against the signed registry record, compares every page with the registered copy, and reports malpractice in red. Every check is logged with the verifier's name and organisation.
- **Admin panel**: live verifications feed, **Alerts** for malpractice (with acknowledge), certificates (revoke), audit log, light/dark theme.

## Where everything is

| Thing | Location |
| --- | --- |
| Project folder | `C:\Users\asksa\Documents\certverify` (outside OneDrive on purpose) |
| GitHub | https://github.com/worksanjai26-ui/certverify (branch `main`) |
| Live site | https://certverify-zeta.vercel.app (Vercel team **PROXIMA DYNAMICS**, project `certverify`) |
| Admin panel | `/admin`. The login is `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `backend/.env.example` (the public seed defaults) |
| Live database | **Firebase Firestore**, via the `FIREBASE_SERVICE_ACCOUNT` secret in Vercel (Production) |
| Local database and signing key | `backend/data/` (git-ignored; never commit or delete casually: it holds the private key) |

## Run, test, deploy

```bash
cd C:\Users\asksa\Documents\certverify
npm install          # first time only
npm run dev          # http://localhost:5173 (web) + http://localhost:4000 (API)
npm test             # 104 tests; the whole suite runs on SQLite AND on a Firestore stand-in
npx vercel deploy --prod --yes      # deploy (CLI is signed in as worksanjai26)
git push                            # GitHub
```

Demo helpers: `npm run sample -- "Name" ROLLNO` makes a fake scan. `npm run tamper -- file <ID>` forges page 1 (to test "Tampered"). `npm run tamper -- record <ID> field=value` edits the database without re-signing (to test "Invalid signature").

## State right now (end of 10 Oct 2026)

- **"Scan the whole certificate" is implemented and tested (104/104).** A photo or a printed-and-scanned PDF now has its certificate page OCR'd (tesseract.js) and compared against the signed record. Matching details with a rescanned/photo copy → still **Needs visual check** (amber, no alert). A conflicting detail (e.g. paper says 99%, registry says 90) → **Tampered / fake certificate** + `qr-paper-mismatch` alert, even when the QR is genuine.
- **Deployed to Vercel:** everything, including marks in the QR, the copied-QR report button, and the whole-certificate OCR.
- **GitHub is 1 commit behind:** local commit `1f4886b` ("Put key details in the QR…") is **not pushed** yet. Run `git push`.
- **Untracked files:** `HANDOFF.md`, `backend/src/ocr.js` (new), `backend/src/paper.js` (new), `eng.traineddata` (23 MB, do not commit). OCR traineddata lives at `backend/data/tessdata/` (git-ignored); on Vercel it is re-downloaded on cold start into the temp dir.
- **Live test files:** `backend/data/kavya-genuine-verified.pdf`, `kavya-fake-90-percent.pdf`, plus the 2002 pair in `Downloads/` (`DEG-CSE-2002-001-verified.pdf`, genuine, issued live; `backend/data/FAKE-DEG-CSE-2002-001-with-copied-qr.pdf`, fake: genuine QR + 99 marks). The 2002 certificate exists **only** in the live Firestore (local SQLite has DEG-CSE-2026-001..005), so those two are tested against the live site after `git push` + deploy.

## How verification decides (backend/src/verify.js)

1. **Locate:** by ID, by the QR read from the uploaded PDF's last page (`document.js`, jsQR), or by an exact file-hash match. A QR pointing to an unregistered ID → **Not found** + alert.
2. **Registry signature** (Ed25519 over the canonical record) → **Invalid signature** + alert if the DB was edited.
3. **QR cross-check:** `h` = document hash, `s` = signature, `n/r/m/y` = name/roll/marks/year must equal the signed record → **Tampered** / **Invalid signature** + alert.
4. **Revoked** → **Revoked** + alert.
5. **Page comparison** (uploads only): page fingerprints vs. the registered PDF → edited/swapped/added/missing page = **Tampered** + alert. A photo or rescanned copy gives **Needs visual check** (no alert; a signed 30-minute link to the registered copy is offered).
6. **Copy of the whole certificate (photo or scanned PDF):** the certificate page is OCR'd (`document.js` → `certificatePageImage`, `ocr.js` → tesseract.js) and compared with the signed record (`paper.js` `comparePaper`). All match → **Needs visual check** (it is still a re-scan, not the original file). Any conflict (name/roll/**marks exact**/year, plus conflicting percentages or CGPAs) → **Tampered / fake certificate** + `qr-paper-mismatch` alert. The verification page's own text is never trusted. Unreadable → retake hint.
7. **Copied genuine QR on a fake paper:** the upload path catches it via page comparison; the whole-certificate check catches it via the printed text. The scan-only path shows "What this QR code says" and the **"certificate shows different details"** button (`POST /api/report-mismatch`) → alert.

## Code map

- `backend/src/store/`: storage behind one interface. `firestore.js` (production: scans in <1 MB chunks, transactions for numbering, no composite indexes), `sql.js` (local SQLite / optional Turso), `index.js` picks one: `FIREBASE_SERVICE_ACCOUNT` > `TURSO_DATABASE_URL` > SQLite file. On Vercel with neither, it falls back to temporary storage with a "Demo mode" banner, which is unreliable.
- `backend/src/register.js`: issuing (ID, sign, stamp PDF, QR text). `stamp.js`: builds the verification page. `document.js`: reads uploads (QR, page fingerprints, `certificatePageImage` for the scanned certificate page). `ocr.js`: tesseract.js wrapper (traineddata from `backend/data/tessdata/`, or `os.tmpdir()` on Vercel). `paper.js`: `comparePaper` — name fuzzy (O/0, I/1, ≤2 edits), roll normalised, marks exact + conflict scanning, year normalised, verification-page detection. `verify.js`: the decision flow above.
- `backend/src/routes/public.js` (`/api/verify`, `/api/report-mismatch`, `/api/registered/:id`, `/api/institution`) and `routes/admin.js` (certificates, verifications, alerts, stats, audit).
- `frontend/src/`: React + Vite. `pages/Home.jsx` (upload first), `pages/Verify.jsx`, `components/VerdictView.jsx` (findings, QR-details panel, page table), `pages/admin/*` (Dashboard, Alerts, Upload, Certificates, Verifications, Audit).
- `backend/test/portal.test.js` + `fake-firestore.js`.

## Open items / ideas

- [x] `git push` the local commit `1f4886b`.
- [x] **"Scan the whole certificate"** (photo or scanned PDF: OCR the certificate page, compare with the signed record, `qr-paper-mismatch` alert on conflict, "Needs visual check" when matching or unreadable). Done 10 Oct; 2 new e2e tests in `portal.test.js`.
- [ ] **Change the admin password** (the default is public on GitHub). Note: the account already exists in Firebase, so setting `ADMIN_EMAIL`/`ADMIN_PASSWORD` in Vercel alone won't change it. The seed only runs when no user exists. A small "change password" feature, or updating the user from env on start, is needed.
- [ ] Optional: set `INSTITUTION_PRIVATE_KEY` in Vercel (safer than the key Firestore generated). This must be done **before** issuing real certificates, because changing the key later breaks old signatures.
- [ ] Optional: connect GitHub to Vercel (`vercel git connect`) so every push deploys.
- [ ] Known limit: QR details (`n/r/m/y`) aren't signed on their own; they're trusted only via the online cross-check.
- [ ] OCR at deploy time: `eng.traineddata` (~10.9 MB) is re-downloaded into the Vercel temp dir on each cold start. If cold starts get slow, pre-warm or move OCR to a background/streaming path.
- [ ] **Scan-only wording (user asked 10 Oct):** a genuine QR pasted on a fake paper still shows a green "Verified" when only scanned. Change the scan-only verdict to something like **"QR genuine: compare details with the paper"** (amber, not green), and keep full "Verified" for uploaded documents whose pages match. Touch `verify.js` (a new verdict, e.g. `qr_genuine`, when there's no file), `VerdictView.jsx` (VERDICTS map) and `ui.jsx` (badge tone), then update the tests.

## Things the user asked for (keep doing)

- **Never delete files.** Copy and verify, then tell the user which paths they can delete themselves.
- Keep code projects **outside OneDrive** (OneDrive's free 5 GB was full and caused sync errors).
- Admin email/password stay as the seed defaults unless the user says otherwise.

## Housekeeping left on this PC (for the user to decide)

- `C:\Users\asksa\OneDrive\Desktop\multiscenario_computervision`: old OmniSight duplicate restored by OneDrive (~4.2 GB still cloud-only). The real project is in `C:\Users\asksa\Documents\multiscenario_computervision`.
- `C:\Users\asksa\Documents\OneDrive-duplicate-multiscenario_computervision`: a partial copy (~0.7 GB) from the interrupted move.
- `frontend/dist-check-old/`: a stray build folder (git-ignored).
- OneDrive still shows red ✕ until its cloud storage is under 5 GB (delete the duplicate in OneDrive and empty the OneDrive recycle bin, or upgrade storage).
