import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CERT_ID_RE } from '../api.js';
import { FileDrop } from '../components/ui.jsx';

export default function Home() {
  const navigate = useNavigate();
  const [id, setId] = useState('');
  const [idError, setIdError] = useState('');

  function submit(e) {
    e.preventDefault();
    const clean = id.trim().toUpperCase();
    if (!CERT_ID_RE.test(clean)) {
      setIdError('Certificate IDs look like DEG-CSE-2026-001. It is printed on the last page of the certificate.');
      return;
    }
    navigate(`/verify/${encodeURIComponent(clean)}`);
  }

  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">Employer verification</div>
          <h1>Check a degree certificate against the college's signed record.</h1>
          <p className="lead">
            Every certificate registered by the college has a verification page at the end with a QR code. Scan it, or
            type the certificate ID, and we cross-check its hash and digital signature with the official registry.
          </p>
          <div className="row">
            <Link className="btn primary" to="/scan">
              Scan QR code
            </Link>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Verify by certificate ID</div>
          <form onSubmit={submit} className="stack" style={{ gap: 10 }}>
            <div className="search-bar">
              <input
                aria-label="Certificate ID"
                placeholder="e.g. DEG-CSE-2026-001"
                value={id}
                onChange={(e) => {
                  setId(e.target.value);
                  setIdError('');
                }}
              />
              <button className="btn">Verify</button>
            </div>
            {idError && <div className="small" style={{ color: 'var(--bad)' }}>{idError}</div>}
          </form>
          <div className="card-title" style={{ marginTop: 22 }}>
            Or verify the PDF itself
          </div>
          <FileDrop
            onFile={(file) => navigate('/verify', { state: { file } })}
            accept="application/pdf,.pdf,image/png,image/jpeg"
            title="Drop the certificate PDF here"
            hint="Its SHA-256 fingerprint is matched against the registry. The file is hashed, never stored."
          />
        </div>
      </section>

      <div className="eyebrow">How it works</div>
      <div className="flow">
        <div className="card">
          <h3>Registrar uploads the scan</h3>
          <p className="muted small">
            The college uploads the scanned degree certificate. It gets a unique certificate ID and a SHA-256 hash, and
            is signed with the institution's private key.
          </p>
        </div>
        <div className="card">
          <h3>QR page is attached</h3>
          <p className="muted small">
            The ID, hash and signature are encoded in a QR code on a page added after the scan. The signed record is
            stored in the official registry.
          </p>
        </div>
        <div className="card">
          <h3>You cross-verify</h3>
          <p className="muted small">
            We check the ID exists, the signature is valid, the QR's hash and signature match the registry, and it
            hasn't been revoked. The registrar is told who verified.
          </p>
        </div>
      </div>
    </>
  );
}
