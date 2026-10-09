import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, markVerificationsSeen, timeAgo, useNewIds, usePolling } from '../../api.js';
import { Badge, Empty, ErrorBox, Loading } from '../../components/ui.jsx';

const VERDICT_OPTIONS = ['verified', 'tampered', 'invalid_signature', 'revoked', 'review', 'not_found'];

export function VerificationTable({ rows, showCert = true, fresh = new Set() }) {
  if (!rows.length) return <Empty>No verifications yet. They appear here as soon as someone checks a certificate.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Verified by</th>
            {showCert && <th>Certificate</th>}
            <th>Result</th>
            <th>Method</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.id} className={fresh.has(v.id) ? 'fresh' : undefined}>
              <td style={{ whiteSpace: 'nowrap' }} title={formatDate(v.at, true)}>
                {timeAgo(v.at)}
              </td>
              <td>
                <strong>{v.verifier_name}</strong>
                <div className="small">{v.verifier_org}</div>
                {v.verifier_email && (
                  <a className="small" href={`mailto:${v.verifier_email}`}>
                    {v.verifier_email}
                  </a>
                )}
              </td>
              {showCert && (
                <td>
                  {v.cert_id ? (
                    <Link to={`/admin/certificates/${v.cert_id}`} className="mono">
                      {v.cert_id}
                    </Link>
                  ) : (
                    <span className="muted small">unknown file</span>
                  )}
                </td>
              )}
              <td>
                <Badge value={v.verdict} verdict />
                {v.malpractice ? (
                  <div className="small" style={{ color: 'var(--bad)', fontWeight: 600, marginTop: 4 }}>
                    ⚠ Malpractice
                  </div>
                ) : null}
              </td>
              <td className="small">{v.method}</td>
              <td className="small muted" title={v.user_agent || ''}>
                {v.ip || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Verifications() {
  const [verdict, setVerdict] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const fresh = useNewIds(rows);

  usePolling(
    async () => {
      try {
        const params = new URLSearchParams({ limit: '300' });
        if (verdict) params.set('verdict', verdict);
        if (query) params.set('q', query);
        const d = await api(`/admin/verifications?${params}`);
        setRows(d.verifications);
        setError(null);
        setUpdatedAt(new Date());
        markVerificationsSeen(d.latestId);
      } catch (e) {
        setError(e);
      }
    },
    5000,
    [verdict, query],
  );

  const flagged = rows?.filter((r) => r.verdict !== 'verified').length ?? 0;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Public verification activity</div>
          <h1>Verifications</h1>
        </div>
        <span className="small muted">
          <span className="live-dot" /> Live · updates every 5 s{updatedAt && ` · ${updatedAt.toLocaleTimeString()}`}
        </span>
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <input
          style={{ flex: '1 1 260px' }}
          placeholder="Search verifier, organisation or certificate ID"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select style={{ width: 190 }} value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          <option value="">All results</option>
          {VERDICT_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v.replace('_', ' ')}
            </option>
          ))}
        </select>
        <button className="btn">Search</button>
      </form>

      {rows && flagged > 0 && !verdict && (
        <div className="callout small">
          <strong>{flagged} check{flagged === 1 ? '' : 's'} did not pass.</strong> Tampered or invalid-signature results
          can mean a forged copy is circulating; contact the verifier if needed.
        </div>
      )}
      <ErrorBox error={error} />
      {rows ? <VerificationTable rows={rows} fresh={fresh} /> : !error && <Loading />}
    </div>
  );
}
