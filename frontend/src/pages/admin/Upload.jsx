import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadCertificateFile, openCertificateFile } from '../../api.js';
import { useInstitution } from '../../components/Layouts.jsx';
import { CopyButton, ErrorBox, FileDrop } from '../../components/ui.jsx';

const BLANK = {
  studentName: '',
  rollNo: '',
  program: 'Bachelor of Technology',
  department: '',
  graduationYear: String(new Date().getFullYear()),
  marks: '',
};
const ACCEPT = 'application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png';

function ScanPreview({ file }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url) return null;
  return file.type === 'application/pdf' ? (
    <iframe title="Scan preview" src={url} className="scan-preview" />
  ) : (
    <img alt="Scan preview" src={url} className="scan-preview" />
  );
}

export default function Upload() {
  const [file, setFile] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  // The server's limit (4 MB on Vercel, 15 MB locally).
  const maxMb = useInstitution()?.maxUploadMb ?? 4;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function pick(f) {
    setError(null);
    if (!/^(application\/pdf|image\/(png|jpeg))$/.test(f.type) && !/\.(pdf|png|jpe?g)$/i.test(f.name)) {
      setError(new Error('Upload the scan as a PDF, JPG or PNG.'));
      return;
    }
    if (f.size > maxMb * 1024 * 1024) {
      setError(new Error(`The scan is larger than ${maxMb} MB. Scan at 150–200 dpi or compress the PDF.`));
      return;
    }
    setFile(f);
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) {
      setError(new Error('Choose the scanned certificate first.'));
      return;
    }
    setBusy(true);
    setError(null);
    const body = new FormData();
    Object.entries(form).forEach(([k, v]) => body.append(k, v));
    body.append('file', file);
    try {
      setDone(await api('/admin/certificates', { method: 'POST', form: body, timeout: 60000 }));
      setFile(null);
      setForm(BLANK);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const c = done.certificate;
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <div className="eyebrow">Registered</div>
            <h1>Certificate secured</h1>
          </div>
        </div>
        <div className="card">
          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <div>
              <div className="success-box" style={{ marginBottom: 16 }}>
                Hashed, signed and stored. A verification page with the QR code was added after the scan.
              </div>
              <p className="holder-name">{c.studentName}</p>
              <p className="muted">
                {c.program} · {c.department} · {c.graduationYear}
                {c.marks && <> · <strong>{c.marks}</strong></>}
              </p>
              <dl className="details">
                <dt>Certificate ID</dt>
                <dd className="mono">
                  {c.id} <CopyButton text={c.id} />
                </dd>
                <dt>Document hash (SHA-256)</dt>
                <dd className="hash">{c.documentHash}</dd>
                <dt>Digital signature (Ed25519)</dt>
                <dd className="hash">{c.signature}</dd>
                <dt>Signing key</dt>
                <dd className="mono">{c.keyId}</dd>
              </dl>
              <div className="row" style={{ marginTop: 18 }}>
                <button className="btn primary" onClick={() => downloadCertificateFile(c.id).catch(setError)}>
                  Download verified PDF
                </button>
                <button className="btn ghost" onClick={() => openCertificateFile(c.id).catch(setError)}>
                  Preview
                </button>
                <Link className="btn ghost" to={`/admin/certificates/${c.id}`}>
                  View record
                </Link>
                <button className="btn ghost" onClick={() => setDone(null)}>
                  Upload another
                </button>
              </div>
              <p className="small muted" style={{ marginTop: 12 }}>
                Give the student the <strong>verified PDF</strong> (scan + QR page). Employers can scan the QR code or
                enter the certificate ID on the public portal.
              </p>
              <ErrorBox error={error} />
            </div>
            <div style={{ textAlign: 'center' }}>
              <div className="qr-frame">
                <img src={done.qr} alt={`QR code for ${c.id} containing its hash and signature`} />
              </div>
              <p className="small muted">Encodes the certificate ID, document hash and signature.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Register a degree certificate</div>
          <h1>Upload certificate</h1>
        </div>
      </div>

      <form className="grid grid-2" style={{ alignItems: 'start' }} onSubmit={submit}>
        <div className="card stack">
          <div className="card-title">1 · Scanned copy</div>
          {file ? (
            <>
              <ScanPreview file={file} />
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small">
                  <strong>{file.name}</strong> · {(file.size / 1024).toFixed(0)} KB
                </span>
                <button type="button" className="btn ghost sm" onClick={() => setFile(null)}>
                  Replace
                </button>
              </div>
            </>
          ) : (
            <FileDrop
              onFile={pick}
              accept={ACCEPT}
              title="Drop the scanned degree certificate here"
              hint={`PDF, JPG or PNG, up to ${maxMb} MB`}
            />
          )}
        </div>

        <div className="card stack">
          <div className="card-title">2 · Certificate details</div>
          <p className="small muted" style={{ margin: 0 }}>
            Enter the details exactly as printed on the certificate. Employers see them when they verify, to compare
            against the scan.
          </p>
          <label className="field">
            Student name
            <input value={form.studentName} onChange={set('studentName')} required maxLength={120} />
          </label>
          <label className="field">
            Roll / register number
            <input value={form.rollNo} onChange={set('rollNo')} required maxLength={30} placeholder="21CSE001" />
          </label>
          <label className="field">
            Degree
            <input value={form.program} onChange={set('program')} required maxLength={150} />
          </label>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <label className="field">
              Department code <span className="hint">Used in the ID</span>
              <input
                value={form.department}
                onChange={set('department')}
                required
                maxLength={5}
                placeholder="CSE"
                style={{ textTransform: 'uppercase' }}
              />
            </label>
            <label className="field">
              Year of graduation
              <input type="number" min="1950" max="2100" value={form.graduationYear} onChange={set('graduationYear')} required />
            </label>
          </div>
          <label className="field">
            Marks / percentage / CGPA{' '}
            <span className="hint">As printed, e.g. "77%" or "8.2 CGPA, First Class". Signed and shown in the QR code.</span>
            <input value={form.marks} onChange={set('marks')} maxLength={60} placeholder="77%" />
          </label>
          <ErrorBox error={error} />
          {error?.data?.existingId && (
            <Link to={`/admin/certificates/${error.data.existingId}`} className="small">
              Open {error.data.existingId} →
            </Link>
          )}
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Hashing, signing & stamping…' : 'Generate ID, hash, signature & QR'}
          </button>
          <p className="small muted" style={{ margin: 0 }}>
            The scan is hashed with SHA-256 and signed with the institution's Ed25519 key. The certificate ID, hash and
            signature are encoded in a QR code on a new page added after the scan.
          </p>
        </div>
      </form>
    </div>
  );
}
