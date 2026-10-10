import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../api.js';
import { CopyButton, ErrorBox } from './ui.jsx';

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

// A genuine QR can be screenshotted onto a fake certificate. The software can't see the paper in the
// verifier's hand, so it shows exactly what the QR / registry says and lets the verifier report a mismatch.
export function CompareWithPaper({ result, verifier }) {
  const c = result.certificate;
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState('');
  const [state, setState] = useState({ busy: false, alertId: null, error: null });
  if (!c) return null;

  const rows = result.qrDetails?.length
    ? result.qrDetails
    : [
        ['Student name', c.studentName],
        ['Roll / register no.', c.rollNo],
        ['Marks / result', c.marks],
        ['Year of graduation', c.graduationYear],
      ]
        .filter(([, v]) => v != null && v !== '')
        .map(([label, v]) => ({ label, qr: null, registry: String(v), match: true }));
  const fromQr = Boolean(result.qrDetails?.length);

  async function report(e) {
    e.preventDefault();
    setState({ busy: true, alertId: null, error: null });
    try {
      const r = await api('/report-mismatch', {
        method: 'POST',
        body: {
          certificateId: result.certificateId,
          shownDetails: shown,
          verifierName: verifier?.name,
          verifierOrganization: verifier?.organization,
          verifierEmail: verifier?.email,
        },
      });
      setState({ busy: false, alertId: r.alertId, error: null });
    } catch (err) {
      setState({ busy: false, alertId: null, error: err });
    }
  }

  return (
    <div className="card compare-card">
      <div className="card-title">{fromQr ? 'What this QR code says' : 'What the registry says'}: compare with the paper</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Detail</th>
              {fromQr && <th>In the QR code</th>}
              <th>Official registry</th>
              {fromQr && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.label}>
                <td className="small muted">{d.label}</td>
                {fromQr && <td className="compare-value">{d.qr}</td>}
                <td className="compare-value">{d.registry ?? '—'}</td>
                {fromQr && (
                  <td>
                    <span className={`badge tone-${d.match ? 'ok' : 'bad'}`}>{d.match ? 'Matches' : 'Edited'}</span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="callout small" style={{ marginTop: 14 }}>
        <strong>The certificate in front of you must show exactly these details.</strong> If its name, roll number or
        marks are different (for example the paper says 90% but this says 77%), a genuine QR code has been copied onto
        a fake certificate. Do not accept it.
      </div>

      {state.alertId ? (
        <div className="error-box" style={{ marginTop: 12 }}>
          Reported. The registrar has been notified (alert #{state.alertId}). Do not accept this certificate.
        </div>
      ) : !open ? (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn danger sm" onClick={() => setOpen(true)}>
            ✕ The certificate shows different details
          </button>
          <span className="small muted">Report it to the college.</span>
        </div>
      ) : (
        <form className="stack" style={{ gap: 10, marginTop: 12 }} onSubmit={report}>
          <label className="field">
            What does the certificate in front of you show? <span className="hint">Optional, e.g. "90%, First Class"</span>
            <input value={shown} onChange={(e) => setShown(e.target.value)} maxLength={300} autoFocus />
          </label>
          <div className="row">
            <button className="btn danger" disabled={state.busy}>
              {state.busy ? 'Reporting…' : 'Report to the registrar'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <ErrorBox error={state.error} />
        </form>
      )}
    </div>
  );
}

// What the OCR read from a photo of the whole certificate, compared field by field with the registry.
// A genuine QR pasted onto a paper with different details is exactly the fake this catches.
export function PaperComparison({ paper }) {
  if (!paper) return null;
  if (paper.verificationPage) {
    return (
      <div className="card" style={{ borderColor: 'var(--warn)' }}>
        <div className="card-title">The photo shows the verification page, not the certificate</div>
        <p>
          This page is printed by the registrar and already carries the genuine details, so matching it proves
          nothing — a faker can paste a genuine QR onto it. Take a photo of the certificate page itself, then check
          it again.
        </p>
      </div>
    );
  }
  if (!paper.readable) return null;
  const conflicting = paper.conflicts ?? [];
  return (
    <div className={`card${conflicting.length ? ' compare-card' : ''}`} style={conflicting.length ? { borderColor: 'var(--bad)' } : undefined}>
      <div className="card-title">{conflicting.length ? '⚠ The certificate text disagrees with the registry' : 'What the certificate says vs. the registry'}</div>
      <p className="small muted" style={{ marginTop: 0 }}>
        These details were read from the photo of your certificate. A genuine QR code is worthless if the paper beside
        it shows different details.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Detail</th>
              <th>On the certificate (read from photo)</th>
              <th>Official registry</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {paper.fields.map((d) => {
              const missing = d.paper == null;
              return (
                <tr key={d.field}>
                  <td className="small muted">{d.label}</td>
                  <td className="compare-value">{d.paper ?? '—'}</td>
                  <td className="compare-value">{d.registry ?? '—'}</td>
                  <td>
                    <span className={`badge tone-${d.match ? 'ok' : missing ? 'warn' : 'bad'}`}>{d.match ? 'Matches' : missing ? 'Not found' : 'Differs'}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {conflicting.length > 0 && (
        <div className="error-box" style={{ marginTop: 12 }}>
          <strong>Fake certificate suspected:</strong> the details printed on this paper disagree with the genuine QR
          code and registry. A QR stamp was likely copied onto a fake certificate. Do not accept it; the registrar has
          been notified.
        </div>
      )}
    </div>
  );
}

export default function VerdictView({ result, verifier }) {
  const c = result.certificate;
  const e = result.evidence;
  return (
    <div className="stack">
      <VerdictBanner verdict={result.verdict} certificateId={result.certificateId} checkedAt={result.checkedAt} />
      <Findings result={result} />
      <CompareWithPaper result={result} verifier={verifier} />
      <PaperComparison paper={result.paper} />
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
              {c.marks && (
                <>
                  <dt>Marks / result</dt>
                  <dd>
                    <strong>{c.marks}</strong>
                  </dd>
                </>
              )}
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
