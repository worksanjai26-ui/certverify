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
          <h1>Upload the certificate you were given. We'll check every page.</h1>
          <p className="lead">
            We read the QR code on the certificate's verification page, find the institution's signed record, and
            compare your document with the registered copy page by page. Any alteration, swapped page or fake QR is
            reported here, and the college is notified.
          </p>
        </div>

        <div className="card stack">
          <div>
            <div className="card-title">1 · Upload the certificate</div>
            <FileDrop
              onFile={(file) => navigate('/verify', { state: { file } })}
              accept="application/pdf,.pdf,image/png,image/jpeg"
              title="Drop the certificate PDF here, or click to choose"
              hint="The PDF you received (both pages), or a photo of its QR page. Files are checked, never stored."
            />
          </div>
          <div>
            <div className="card-title">Or check by ID / QR only</div>
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
            <Link className="btn ghost block" to="/scan" style={{ marginTop: 10 }}>
              Scan the QR code with your camera
            </Link>
          </div>
        </div>
      </section>

      <div className="eyebrow">What we check</div>
      <div className="flow">
        <div className="card">
          <h3>Locate</h3>
          <p className="muted small">
            The QR code on the verification page points to the certificate's record in the college's registry.
          </p>
        </div>
        <div className="card">
          <h3>Authenticate</h3>
          <p className="muted small">
            The record's digital signature must be the institution's, and the QR's hash and signature must match it
            exactly.
          </p>
        </div>
        <div className="card">
          <h3>Compare</h3>
          <p className="muted small">
            Every page of your document is compared with the registered copy. Edited, swapped, added or missing pages
            are reported as malpractice.
          </p>
        </div>
      </div>
    </>
  );
}
