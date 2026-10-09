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
  review: {
    tone: 'warn',
    icon: '◐',
    title: 'Needs visual check',
    lead: 'The QR code is genuine, but this copy is a scan or photo, so its pages cannot be compared automatically. Compare it with the registered copy.',
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

const SEVERITY = {
  high: { label: 'Malpractice', tone: 'bad' },
  medium: { label: 'Warning', tone: 'warn' },
  info: { label: 'Note', tone: 'muted' },
};

// The "output area": what was found, in plain words, worst first.
export function Findings({ result }) {
  const order = { high: 0, medium: 1, info: 2 };
  const items = [...(result.findings ?? [])].sort((a, b) => order[a.severity] - order[b.severity]);
  if (!items.length) return null;
  return (
    <div className={`card findings${result.malpractice ? ' malpractice' : ''}`}>
      <div className="card-title">{result.malpractice ? '⚠ Malpractice detected' : 'Notes'}</div>
      <ul className="finding-list">
        {items.map((f, i) => (
          <li key={i}>
            <span className={`badge tone-${SEVERITY[f.severity].tone}`}>{SEVERITY[f.severity].label}</span>
            <span>{f.message}</span>
          </li>
        ))}
      </ul>
      {result.malpractice && (
        <p className="small" style={{ margin: '12px 0 0' }}>
          <strong>The institution's registrar has been notified</strong>
          {result.alertId ? ` (alert #${result.alertId})` : ''}. Do not accept this document.
        </p>
      )}
    </div>
  );
}

const PAGE_STATUS = {
  match: { label: 'Matches', tone: 'ok' },
  altered: { label: 'Modified', tone: 'bad' },
  missing: { label: 'Missing', tone: 'bad' },
  extra: { label: 'Added', tone: 'bad' },
};
const PAGE_ROLE = { certificate: 'Certificate (scan)', verification: 'Verification page (QR)', extra: 'Not in registered copy' };

// Uploaded document vs registered copy, page by page.
export function DocumentComparison({ result }) {
  const d = result.document;
  if (!d) return null;
  const located = d.locator
    ? `Found ${d.locator.id ?? 'a QR code'} from the ${d.locator.source === 'qr' ? 'QR code' : 'printed details'} on page ${d.locator.page}.`
    : 'No CertVerify QR code was found in the document.';
  return (
    <div className="card">
      <div className="card-title">Your document vs. the registered copy</div>
      <p className="small muted" style={{ marginTop: 0 }}>
        {d.kind === 'pdf' ? `PDF, ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}.` : d.kind === 'image' ? 'Image file.' : 'Unrecognised file.'}{' '}
        {located}
      </p>
      {d.comparison?.identicalFile && (
        <div className="success-box">Byte-for-byte identical to the copy the registrar issued.</div>
      )}
      {d.comparison?.rows?.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th>Registered as</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {d.comparison.rows.map((r) => (
                <tr key={r.page}>
                  <td>{r.page}</td>
                  <td>{PAGE_ROLE[r.role]}</td>
                  <td>
                    <span className={`badge tone-${PAGE_STATUS[r.status].tone}`}>{PAGE_STATUS[r.status].label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.registeredCopyUrl && (
        <div className="row" style={{ marginTop: 14 }}>
          <a className="btn ghost sm" href={result.registeredCopyUrl} target="_blank" rel="noreferrer">
            Open the registered copy ↗
          </a>
          <span className="small muted">Compare it side by side with the document you were given. Link valid for 30 minutes.</span>
        </div>
      )}
    </div>
  );
}

export default function VerdictView({ result }) {
  const c = result.certificate;
  const e = result.evidence;
  return (
    <div className="stack">
      <VerdictBanner verdict={result.verdict} certificateId={result.certificateId} checkedAt={result.checkedAt} />
      <Findings result={result} />
      <DocumentComparison result={result} />

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
