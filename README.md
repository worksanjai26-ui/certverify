# CertVerify: Digital Degree Certificate Verification

The college registrar **uploads the scanned copy of a degree certificate**. The portal then does the following:

1. Gives it a unique **certificate ID** (`DEG-<DEPT>-<YEAR>-<NNN>`).
2. Computes a **SHA-256 hash** of the scan.
3. Signs the record with the institution's **Ed25519 digital signature**.
4. Encodes the ID, hash and signature in a **QR code** on a new page added after the scan.

Employers scan that QR code, or type the certificate ID, on the public page. The portal **cross-verifies** it against
the database, and **every verification, with who did it, shows up live on the registrar's console.**

> **QR = pointer. Hash = consistency. Signature + registry = authenticity.**

| Layer    | Stack |
| -------- | ----- |
| Frontend | React 18 + Vite, React Router, `html5-qrcode` (camera and photo scanning) |
| Backend  | Node.js 22.13+ / Express 5, built-in `node:sqlite`, built-in `node:crypto` (Ed25519, SHA-256, scrypt) |
| PDF / QR | `pdf-lib` (appends the verification page to the scan), `qrcode` |

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

17 end-to-end tests run against a real server and a throwaway database.

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

### Employer: verify (public page)

The employer can scan the QR code (phone camera or `/scan`), type the certificate ID, or drop the PDF.
Before the check runs, they enter their **name and organisation** (email optional), which the registrar will see.

The decision flow runs in [`backend/src/verify.js`](backend/src/verify.js):

```
ID found in registry?                 ──no──►  Not found
Institution signature valid?          ──no──►  Invalid signature   (registry row edited without re-signing)
QR hash = registered hash?            ──no──►  Tampered            (QR altered, or copied from another certificate)
QR signature = registered signature?  ──no──►  Invalid signature   (forged QR)
Revoked?                              ──yes─►  Revoked             (even with the genuine QR or PDF)
File supplied & hash matches?         ──no──►  Tampered            (file edited or re-saved)
                                              Verified
```

The QR step is skipped when the employer types the ID, and the file step is skipped when they don't upload one. A
network error or timeout shows **Unable to verify**, which is never a verdict on the certificate itself.

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
6. **Edited file:** run `npm run tamper -- file DEG-CSE-2026-001` and upload `backend/data/DEG-CSE-2026-001-tampered.pdf` on the verify page → **Tampered**.
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
| GET  | `/api/admin/stats`, `/api/admin/audit` | ✓ | Dashboard numbers, registrar audit log |

## Security notes and what's next

- **The signature covers the document hash.** A forger can't swap in their own scan and hash without the private key.
- **Copied QR codes are caught.** A QR copied onto a different document still shows the *registered* student's details, and its hash won't match an uploaded file.
- **Look-alike sites are flagged.** The `/scan` page refuses QR links that point to other domains.
- **Verifier details are self-reported.** They are not proof of identity. For stronger accountability, add email OTP before showing the result.
- **Before production:** keep the signing key in an HSM/KMS, sign revocation records, add multiple registrar accounts with roles, serve over HTTPS, and set up backups.
