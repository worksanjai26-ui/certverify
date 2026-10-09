# CertVerify: Digital Degree Certificate Verification

The college registrar **uploads the scanned copy of a degree certificate**. The portal then does the following:

1. Gives it a unique **certificate ID** (`DEG-<DEPT>-<YEAR>-<NNN>`).
2. Computes a **SHA-256 hash** of the scan.
3. Signs the record with the institution's **Ed25519 digital signature**.
4. Encodes the ID, hash and signature in a **QR code** on a new page added after the scan.

Employers scan that QR code, or type the certificate ID, on the public page. The portal **cross-verifies** it against
the database, and **every verification, with who did it, shows up live on the registrar's console.**

| Layer    | Stack |
| -------- | ----- |
| Frontend | React 18 + Vite, React Router, `html5-qrcode` (camera and photo scanning), light/dark themes |
| Backend  | Node.js 22 / Express 5, built-in `node:crypto` (Ed25519, SHA-256, scrypt) |
| Storage  | **Firebase Cloud Firestore** in production (scans stored in <1 MB chunks, so the free Spark plan is enough); a local SQLite file in development. Turso also supported |
| PDF / QR | `pdf-lib` (appends the verification page to the scan), `qrcode` |
| Hosting  | Vercel: static React build + one serverless function for `/api` |

## Quick start

```bash
npm install
npm run dev
```

- Public portal: http://localhost:5173
- Registrar console: http://localhost:5173/admin. The seed login is in [`backend/.env.example`](backend/.env.example). Change it before any real use.
- A sample "scanned" certificate to upload: `npm run sample -- "Aarav Menon" 21CSE001` writes `samples/sample-degree-scan-21CSE001.pdf`.

On first run the backend creates `backend/data/`, which holds the SQLite database and the institution's Ed25519 key pair.
To start over, stop the server and delete that folder.

**QR codes and phones.** `PUBLIC_URL` in `backend/.env` is the address written into every QR code. To scan with a
phone, set it to your laptop's network address (e.g. `http://192.168.1.20:5173`) **before** uploading certificates.
Live camera scanning in the browser needs HTTPS or localhost. A phone's own camera app, or "upload a photo of the QR"
on `/scan`, works anywhere.

```bash
npm test
```

71 end-to-end tests run against a real server. The full suite runs twice: once on SQLite, and once on an in-memory
Firestore stand-in (`backend/test/fake-firestore.js`) that enforces Firestore's rules: the 1 MiB document limit,
reads before writes in transactions, and no composite indexes needed.

## Deploy to Vercel

Vercel has no permanent disk, so production storage lives elsewhere:

| What | Where in production | Env var |
| ---- | ------------------- | ------- |
| Everything: certificates, scans, verifications, alerts, sessions | Firebase Cloud Firestore | `FIREBASE_SERVICE_ACCOUNT` (**required**) |
| Institution signing key | generated once on first start and kept in Firestore; or your own | `INSTITUTION_PRIVATE_KEY` (optional) |
| Registrar login (created on first request) | defaults to the seed login in `backend/.env.example` | `ADMIN_EMAIL`, `ADMIN_PASSWORD` (optional) |

**1. Create the Firebase project and database** (free Spark plan):
1. At https://console.firebase.google.com, click **Create a project**, e.g. `certverify`. Google Analytics isn't needed.
2. Go to **Build → Firestore Database → Create database**. Choose **Production mode** and a location near your users (e.g. `asia-south1`, Mumbai).
3. Go to **⚙ Project settings → Service accounts → Generate new private key**. This downloads a JSON file. Treat it like a password.

**2. Give Vercel the key.** In *Vercel → Project → Settings → Environment Variables*, add `FIREBASE_SERVICE_ACCOUNT`. Its value is the **entire contents** of that JSON file (or base64 of it). Choose *Production* and mark it *Sensitive*.

**3. Deploy.** Run `npx vercel deploy --prod`. Then open `https://<project>.vercel.app/admin`, sign in, and upload a
certificate. `/api/institution` reports `"backend": "firebase"` when it's connected.

Production mode's security rules block every browser from reading Firestore directly. Only the server, using the
service-account key, can read or write. Every query is designed to need **no composite indexes**, so nothing has to
be configured in the Firebase console beyond creating the database.

Without `FIREBASE_SERVICE_ACCOUNT` (or Turso's `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`), Vercel falls back to
temporary per-instance storage and shows a **Demo mode** banner. In that mode sign-in and data are unreliable, because
each server copy has its own data.

**Optional settings:**
- `INSTITUTION_PRIVATE_KEY`: bring your own signing key (`npm run key:export` prints the local one). Otherwise the server generates one into the database the first time it starts. Keeping the key in an env var is safer, because a database leak then doesn't expose it.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`: the registrar login. Without them, the seed login from `.env.example` is used. That login is public on GitHub, so set your own before real use.
- `INSTITUTION_NAME` and `PUBLIC_URL`: `PUBLIC_URL` defaults to the production domain.

Limits on Vercel:
- **Scan size:** uploads are capped at **4 MB**, because Vercel rejects request bodies over 4.5 MB. Scan at 150–200 dpi or compress the PDF.
- **QR address:** QR codes point at `PUBLIC_URL`. Certificates issued before a domain change keep the old link.
- **Login lockout:** the failed-login counter is kept separately by each server instance.

If the site shows "The server is not configured correctly", open *Vercel → Project → Logs*. The first line names the
missing variable.

## The flow

### Registrar: upload (`/admin/upload`)

1. Drop the scanned degree certificate (PDF, JPG or PNG, up to 15 MB). The file type is checked from its bytes, not its name.
2. Enter the details printed on it: student name, roll/register number, degree, department code, year of graduation.
3. The portal then:
   - computes the **document hash**, the SHA-256 of the scan exactly as uploaded;
   - assigns the **certificate ID**;
   - builds a canonical JSON record (ID, details, document hash, timestamp) and signs it with the institution's Ed25519 private key to make the **digital signature**;
   - encodes ID + hash + signature in a **QR code**, as a link: `PUBLIC_URL/verify/<ID>?h=<hash>&s=<signature>`;
   - appends a **verification page** after the scan, carrying the QR, ID, details, hash and signature in text form;
   - stores the original scan, the verified PDF and the signed record. Uploading the same scan twice is refused.
4. The registrar downloads the **verified PDF** (scan + QR page) and gives it to the student.

### Employer: verify the document (public page)

The main path is to **upload the certificate you were given**. Typing the ID or scanning the QR still works, but it
only proves that the record exists. Before the check runs, the employer enters their **name and organisation** (email
optional), which the registrar will see.

[`backend/src/document.js`](backend/src/document.js) reads the upload. It decodes the QR code on the verification page,
falling back to the ID, hash and signature printed as text. That **locates** the registry record. Then
[`backend/src/verify.js`](backend/src/verify.js) runs:

```
QR / ID found in registry?            ──no──►  Not found           (QR to an unregistered ID = forged → alert)
Institution signature valid?          ──no──►  Invalid signature   (registry row edited without re-signing → alert)
QR hash = registered hash?            ──no──►  Tampered            (QR altered or copied → alert)
QR signature = registered signature?  ──no──►  Invalid signature   (forged QR → alert)
Revoked?                              ──yes─►  Revoked             (revoked certificate presented → alert)
Every page = registered copy?         ──no──►  Tampered            (page edited / swapped / added / missing → alert)
                                              Verified
```

**Page comparison.** Each page is fingerprinted from what it actually draws: its decoded content streams plus the
images and forms it uses. That fingerprint is compared with the registered verified PDF. A file that was only re-saved
still passes, while any edit to a page fails. The result shows a page-by-page table ("Certificate (scan): Modified",
"Verification page (QR): Matches").

**Visual check.** A photo, or a printed-and-rescanned copy, can't be compared byte for byte. If its QR is genuine, the
verdict is **Needs visual check**. A signed, 30-minute link then opens the **registered copy** for a side-by-side look.
That link is only offered to someone who uploaded the document or scanned its QR.

**Output area.** Every finding is listed in plain words. Malpractice is shown in red, together with a note that the
registrar has been notified. A network error or timeout shows **Unable to verify**, which is never a verdict on the
certificate itself.

### Registrar: malpractice alerts (`/admin/alerts`)

Every check that finds malpractice (tampered, forged or copied QR, unknown ID, revoked) creates an **alert**. Each alert
records the findings, the certificate, and who presented the document (name, organisation, email, IP).

Alerts show up in three places, all updating every 5 seconds: a red count badge on the **Alerts** menu item, a banner on
the Dashboard and on the certificate's page, and the browser tab title. The registrar **acknowledges** each alert with
an optional note, and that action is written to the audit log.

### Registrar: who verified (`/admin/verifications`, Dashboard, each certificate's page)

Every public check is stored with the verifier's name, organisation and email, plus the certificate, result, method
(QR scan / certificate ID / file), time and IP. The console polls every 5 seconds. New checks flash in the table, and
the sidebar shows an unseen-count badge. Each certificate's page lists everyone who has verified it.

## Demo script (≈3 minutes)

1. `npm run sample -- "Aarav Menon" 21CSE001`. Then sign in → **Upload certificate** → drop the sample scan, enter the same details → **Generate**.
2. **Download verified PDF** and open it: page 1 is the scan, page 2 is the QR verification page.
3. Scan the QR with your phone (or click **Test verify** on the certificate page), then enter a name and organisation → **Verified**, with the QR checks passing.
4. Switch back to the registrar console: the check appears in **Verifications** within 5 seconds.
5. **Forged QR:** in the verify URL, change one character of `h=` → **Tampered**.
6. **Forged certificate page:** run `npm run tamper -- file DEG-CSE-2026-001`. This overwrites page 1 and keeps the genuine QR page. Upload `backend/data/DEG-CSE-2026-001-tampered.pdf` on the home page → **Tampered**, "Certificate page 1 has been modified". **Alerts** in the admin panel lights up red.
7. **Revoked:** on the certificate page, choose *Revoke* → re-scan → **Revoked**.
8. **Database edit:** run `npm run tamper -- record DEG-CSE-2026-001 studentName=Someone` → **Invalid signature**, with details hidden.

## API

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET  | `/api/institution` | — | Name, public key, fingerprint |
| POST | `/api/verify` | — | Multipart: `certificateId`, `qrHash`, `qrSignature`, `file` (any combination) plus `verifierName`, `verifierOrganization`, `verifierEmail` |
| GET  | `/api/records/:id` | — | Raw signed record, for independent checking |
| POST | `/api/admin/login` | — | Returns a bearer token (8 h) |
| POST | `/api/admin/certificates` | ✓ | Multipart: `file` + details → ID, hash, signature, QR |
| GET  | `/api/admin/certificates[/:id]` | ✓ | List / detail (with QR and verification history) |
| GET  | `/api/admin/certificates/:id/file[?version=original]` | ✓ | Verified PDF, or the original scan |
| POST | `/api/admin/certificates/:id/revoke` | ✓ | Revoke with a reason |
| GET  | `/api/admin/verifications[?after=&verdict=&q=]` | ✓ | Public verification feed |
| GET  | `/api/admin/verifications/count?after=` | ✓ | Unseen count for the live badge |
| GET  | `/api/registered/:id?exp=&sig=` | signed link | Registered copy, for side-by-side comparison (link from a verification) |
| GET  | `/api/admin/alerts[?status=open\|acknowledged\|all]` | ✓ | Malpractice alerts |
| GET  | `/api/admin/alerts/count` | ✓ | Open alert count for the badge |
| POST | `/api/admin/alerts/:id/ack` | ✓ | Acknowledge with an optional note |
| GET  | `/api/admin/stats`, `/api/admin/audit` | ✓ | Dashboard numbers, registrar audit log |

## Security notes and what's next

- **The signature covers the document hash.** A forger can't swap in their own scan and hash without the private key.
- **Copied QR codes are caught.** A QR copied onto a different document still shows the *registered* student's details, and its hash won't match an uploaded file.
- **Look-alike sites are flagged.** The `/scan` page refuses QR links that point to other domains.
- **Verifier details are self-reported.** They are not proof of identity. For stronger accountability, add email OTP before showing the result.
- **Before production:** keep the signing key in an HSM/KMS, sign revocation records, add multiple registrar accounts with roles, serve over HTTPS, and set up backups.
