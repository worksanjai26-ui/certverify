import { Link } from 'react-router-dom';
import { formatDate } from '../api.js';
import { CopyButton } from './ui.jsx';

export const VERDICTS = {
  verified: {
    tone: 'ok',
    icon: '✓',
    title: 'Verified',
    lead: 'Registered and signed by the institution, still active, and consistent with the official registry.',
  },
  not_found: {
    tone: 'neutral',
    icon: '?',
    title: 'Not found',
    lead: 'The institution has no certificate matching this. Treat the document as unverified.',
  },
  invalid_signature: {
    tone: 'bad',
    icon: '✕',
    title: 'Invalid signature',
    lead: "The signature does not match the institution's record. Do not rely on this certificate; contact the registrar.",
  },
  revoked: {
    tone: 'warn',
    icon: '!',
    title: 'Revoked',
    lead: 'This certificate was registered but has since been revoked by the institution. It is no longer valid.',
  },
  tampered: {
    tone: 'bad',
    icon: '✕',
    title: 'Tampered',
    lead: "What you supplied doesn't match the document the institution registered. It has been altered or copied.",
  },
  unable: {
    tone: 'muted',
    icon: '…',
    title: 'Unable to verify',
    lead: 'The check could not be completed. This is not a verdict on the certificate. Try again shortly.',
  },
};

const STEP_ICON = { pass: '✓', fail: '✕', skipped: '–', not_run: '' };

export function StepList({ steps }) {
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.key} className={s.status}>
          <span className={`step-dot step-${s.status}`}>{STEP_ICON[s.status]}</span>
          <div>
            <div className="label">
              {s.label}
              {s.status === 'not_run' && <span className="small muted"> · not reached</span>}
              {s.status === 'skipped' && <span className="small muted"> · not applicable</span>}
            </div>
            {s.detail && <div className="detail">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function VerdictBanner({ verdict, certificateId, checkedAt, message }) {
  const v = VERDICTS[verdict] || VERDICTS.unable;
  return (
    <div className={`verdict tone-${v.tone}`} role="status" aria-live="polite">
      <div className="verdict-icon" aria-hidden="true">
        {v.icon}
      </div>
      <div>
        <h1>{v.title}</h1>
        <p>{message || v.lead}</p>
        <div className="meta">
          {certificateId && (
            <>
              Certificate <code>{certificateId}</code> ·{' '}
            </>
          )}
          {checkedAt ? `Checked ${formatDate(checkedAt, true)}` : 'Not checked'}
        </div>
      </div>
    </div>
  );
}

function HashRow({ label, value, compareTo }) {
  if (!value) return null;
  const mismatch = compareTo && compareTo !== value;
  return (
    <>
      <dt>{label}</dt>
      <dd className="hash" style={mismatch ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>
        {value}
        {mismatch && <div className="small">≠ registry</div>}
      </dd>
    </>
  );
}

export default function VerdictView({ result }) {
  const c = result.certificate;
  const e = result.evidence;
  return (
    <div className="stack">
      <VerdictBanner verdict={result.verdict} certificateId={result.certificateId} checkedAt={result.checkedAt} />

      <div className="grid grid-2">
        <div className="card">
          <div className="card-title">Cross-verification checks</div>
          <StepList steps={result.steps} />
        </div>

        {c ? (
          <div className="card">
            <div className="card-title">Official registry record</div>
            <p className="holder-name">{c.studentName}</p>
            <p className="muted small" style={{ marginBottom: 14 }}>
              Roll / register no. {c.rollNo}
            </p>
            <dl className="details">
              <dt>Degree</dt>
              <dd>{c.program}</dd>
              <dt>Department</dt>
              <dd>{c.department}</dd>
              <dt>Year of graduation</dt>
              <dd>{c.graduationYear}</dd>
              <dt>Institution</dt>
              <dd>{c.institution}</dd>
              <dt>Registered</dt>
              <dd>{formatDate(c.issuedAt)}</dd>
              {result.revocation && (
                <>
                  <dt>Revoked</dt>
                  <dd>
                    {formatDate(result.revocation.revokedAt)}
                    {result.revocation.reason && ` (${result.revocation.reason})`}
                  </dd>
                </>
              )}
            </dl>
            <div className="callout small" style={{ marginTop: 16 }}>
              <strong>Compare details.</strong> Check that this name, roll number and degree match the scanned
              certificate you were given and the candidate's ID.
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="card-title">What to do next</div>
            {result.verdict === 'invalid_signature' ? (
              <p>
                Registry details are hidden because they can't be trusted. Report certificate{' '}
                <code>{result.certificateId}</code> to the institution's registrar.
              </p>
            ) : (
              <p>
                Check the certificate ID for typos, or scan the QR code on the last page of the certificate. If you
                scanned a QR code, make sure the page you landed on is this portal.
              </p>
            )}
            <Link to="/" className="btn ghost">
              Check another certificate
            </Link>
          </div>
        )}
      </div>

      {e && Object.keys(e).length > 0 && (
        <details className="card evidence">
          <summary>Cryptographic evidence</summary>
          <dl className="details">
            {e.algorithm && (
              <>
                <dt>Algorithm</dt>
                <dd>{e.algorithm}</dd>
                <dt>Signing key ID</dt>
                <dd>
                  <code>{e.keyId}</code>
                </dd>
              </>
            )}
            <HashRow label="Registered document hash" value={e.documentHash} />
            <HashRow label="Hash in QR code" value={e.qrHash} compareTo={e.documentHash} />
            <HashRow label="Your file's hash" value={e.computedFileHash} />
            {e.signature && (
              <>
                <dt>Registered signature</dt>
                <dd className="hash">
                  {e.signature} <CopyButton text={e.signature} />
                </dd>
              </>
            )}
            <HashRow label="Signature in QR code" value={e.qrSignature} compareTo={e.signature} />
          </dl>
        </details>
      )}
    </div>
  );
}
