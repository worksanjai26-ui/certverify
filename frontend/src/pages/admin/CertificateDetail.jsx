import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, downloadCertificateFile, formatDate, openCertificateFile, useNewIds, usePolling } from '../../api.js';
import { Badge, CopyButton, ErrorBox, Loading } from '../../components/ui.jsx';
import { AuditTable } from './Audit.jsx';
import { VerificationTable } from './Verifications.jsx';

export default function CertificateDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const fresh = useNewIds(data?.verifications);

  const load = useCallback(async () => {
    try {
      setData(await api(`/admin/certificates/${encodeURIComponent(id)}`));
    } catch (e) {
      setError(e);
    }
  }, [id]);

  // Keeps the "who verified" list live while the page is open.
  usePolling(load, 5000, [id]);

  async function revoke(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/certificates/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: { reason } });
      setConfirming(false);
      setReason('');
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const c = data.certificate;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <Link to="/admin/certificates" className="small">
            ← All certificates
          </Link>
          <h1 style={{ fontFamily: 'var(--mono)', fontSize: '1.6rem', marginTop: 6 }}>{c.id}</h1>
        </div>
        <div className="row">
          <Badge value={c.status} />
          <button className="btn primary" onClick={() => downloadCertificateFile(c.id).catch(setError)}>
            Download verified PDF
          </button>
          <button className="btn ghost" onClick={() => openCertificateFile(c.id).catch(setError)}>
            Preview
          </button>
          <button className="btn ghost" onClick={() => downloadCertificateFile(c.id, 'original').catch(setError)}>
            Original scan
          </button>
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-title">Signed record</div>
          <p className="holder-name">{c.studentName}</p>
          <p className="muted small">Roll / register no. {c.rollNo}</p>
          <dl className="details">
            <dt>Degree</dt>
            <dd>{c.program}</dd>
            <dt>Department</dt>
            <dd>{c.department}</dd>
            <dt>Year of graduation</dt>
            <dd>{c.graduationYear}</dd>
            <dt>Registered</dt>
            <dd>
              {formatDate(c.issuedAt, true)} by {c.issuedBy}
            </dd>
            <dt>Scanned file</dt>
            <dd className="small">
              {c.documentName || '—'} ({c.documentType})
            </dd>
            {c.status === 'revoked' && (
              <>
                <dt>Revoked</dt>
                <dd>
                  {formatDate(c.revokedAt, true)} by {c.revokedBy}
                  <div className="small muted">{c.revokeReason}</div>
                </dd>
              </>
            )}
            <dt>Document hash</dt>
            <dd className="hash">{c.documentHash}</dd>
            <dt>Verified PDF hash</dt>
            <dd className="hash">{c.stampedHash}</dd>
            <dt>Signature</dt>
            <dd className="hash">{c.signature}</dd>
            <dt>Signing key</dt>
            <dd className="mono">{c.keyId}</dd>
          </dl>
        </div>

        <div className="stack">
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="card-title" style={{ textAlign: 'left' }}>
              QR code (verification page)
            </div>
            <div className="qr-frame">
              <img src={data.qr} alt={`QR code for ${c.id}`} />
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              Encodes ID, hash and signature as a link to the portal.
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <CopyButton text={data.qrText} label="Copy QR link" />
              <a className="btn ghost sm" href={new URL(data.qrText).pathname + new URL(data.qrText).search} target="_blank" rel="noreferrer">
                Test verify ↗
              </a>
            </div>
          </div>

          {c.status === 'active' && (
            <div className="card">
              <div className="card-title" style={{ color: 'var(--bad)' }}>
                Revoke certificate
              </div>
              {!confirming ? (
                <>
                  <p className="small muted">
                    Employers will see <strong>Revoked</strong> from now on, even with the genuine PDF and QR code. This
                    cannot be undone.
                  </p>
                  <button className="btn ghost" onClick={() => setConfirming(true)}>
                    Revoke…
                  </button>
                </>
              ) : (
                <form className="stack" style={{ gap: 10 }} onSubmit={revoke}>
                  <label className="field">
                    Reason (shown to employers)
                    <input
                      autoFocus
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Uploaded with the wrong scan"
                      required
                    />
                  </label>
                  <div className="row">
                    <button className="btn danger" disabled={busy || !reason.trim()}>
                      {busy ? 'Revoking…' : `Revoke ${c.id}`}
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
          <ErrorBox error={error} />
        </div>
      </div>

      {data.alerts?.length > 0 && (
        <div className="alert-banner" role="alert">
          <span>
            ⚠ {data.alerts.length} malpractice alert{data.alerts.length === 1 ? '' : 's'} for this certificate (
            {data.alerts.filter((a) => !a.acknowledged_at).length} open). Latest: {data.alerts[0].title}
          </span>
          <Link className="btn danger sm" to="/admin/alerts">
            Review alerts
          </Link>
        </div>
      )}

      <div>
        <h2>
          Who verified this certificate <span className="live-dot" title="Live" />{' '}
          <span className="small muted">({data.verifications.length})</span>
        </h2>
        <VerificationTable rows={data.verifications} showCert={false} fresh={fresh} />
      </div>

      <div>
        <h2>Registrar history</h2>
        <AuditTable events={data.history} showCert={false} />
      </div>
    </div>
  );
}
