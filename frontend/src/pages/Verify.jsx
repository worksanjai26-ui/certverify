import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { api, loadVerifier } from '../api.js';
import { FileDrop, Loading } from '../components/ui.jsx';
import VerdictView, { VerdictBanner } from '../components/VerdictView.jsx';
import VerifierForm, { VerifierLine } from '../components/VerifierForm.jsx';

// The QR link's query: h = hash, s = signature, n/r/m/y = name, roll number, marks, year.
const QR_PARAMS = { h: 'qrHash', s: 'qrSignature', n: 'qrName', r: 'qrRoll', m: 'qrMarks', y: 'qrYear' };

// Handles every way in: /verify/:id?h=&s=&n=… (QR scan), /verify/:id (typed ID), /verify with a file in state.
export default function Verify() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const qrHash = params.get('h');
  const qrSignature = params.get('s');
  const qrQuery = params.toString(); // stable key for the effect below
  const initialFile = location.state?.file ?? null;

  const [verifier, setVerifier] = useState(loadVerifier);
  const [editingVerifier, setEditingVerifier] = useState(false);
  const [file, setFile] = useState(initialFile);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(
    async (withFile) => {
      setLoading(true);
      setError(null);
      const form = new FormData();
      if (id) form.append('certificateId', id);
      for (const [param, field] of Object.entries(QR_PARAMS)) {
        const value = params.get(param);
        if (value) form.append(field, value);
      }
      form.append('verifierName', verifier.name);
      form.append('verifierOrganization', verifier.organization);
      if (verifier.email) form.append('verifierEmail', verifier.email);
      if (withFile) form.append('file', withFile);
      try {
        setResult(await api('/verify', { method: 'POST', form }));
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, qrQuery, verifier],
  );

  // Each check is logged for the registrar, so run once per target + verifier
  // (StrictMode re-runs effects in development; the ref survives that).
  const lastRun = useRef(null);
  useEffect(() => {
    if (!verifier || editingVerifier || (!id && !initialFile)) return;
    const key = JSON.stringify([id, qrQuery, verifier]);
    if (lastRun.current === key) return;
    lastRun.current = key;
    run(file);
    // File uploads after the first check call run() directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, qrQuery, verifier, editingVerifier]);

  if (!id && !initialFile) return <Navigate to="/" replace />;

  if (!verifier || editingVerifier) {
    return (
      <div className="stack">
        {qrHash && (
          <div className="callout small">
            <strong>QR code read.</strong> Certificate <code>{id}</code>
            {params.get('n') && (
              <>
                {' '}
                for <strong>{params.get('n')}</strong>
                {params.get('m') && <> ({params.get('m')})</>}
              </>
            )}{' '}
            is ready to be checked against the registry.
          </div>
        )}
        <VerifierForm
          initial={verifier}
          onDone={(v) => {
            setVerifier(v);
            setEditingVerifier(false);
          }}
          onCancel={verifier ? () => setEditingVerifier(false) : undefined}
        />
      </div>
    );
  }

  const method = file ? 'document' : qrHash ? 'QR code' : 'certificate ID';

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Link to="/" className="small">
          ← Verify another certificate
        </Link>
        <VerifierLine verifier={verifier} onChange={() => setEditingVerifier(true)} />
      </div>

      {loading && <Loading label={`Cross-checking the ${method} against the registry…`} />}

      {!loading && error && (
        <div className="stack">
          <VerdictBanner verdict="unable" certificateId={id?.toUpperCase()} message={error.message} />
          <div>
            <button className="btn" onClick={() => run(file)}>
              Try again
            </button>
          </div>
        </div>
      )}

      {!loading && !error && result && (
        <>
          <VerdictView result={result} verifier={verifier} />
          {/* After an ID/QR check, offer the full document comparison. */}
          {!file && ['verified', 'tampered', 'review'].includes(result.verdict) && result.certificateId && (
            <div className="card">
              <div className="card-title">Recommended: check the document itself</div>
              <p className="small muted">
                The ID or QR only proves the record exists. Upload the certificate PDF the candidate gave you and every
                page will be compared with the registered copy.
              </p>
              <FileDrop
                onFile={(f) => {
                  setFile(f);
                  run(f);
                }}
                accept="application/pdf,.pdf,image/png,image/jpeg"
                title="Drop the PDF here or click to choose"
              />
            </div>
          )}
          <p className="small muted" style={{ textAlign: 'center' }}>
            Verified on <strong>{window.location.host}</strong>. Only trust results shown on this portal.
          </p>
        </>
      )}
    </div>
  );
}
