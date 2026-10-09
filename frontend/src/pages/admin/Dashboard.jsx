import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useNewIds, usePolling } from '../../api.js';
import { Badge, Empty, ErrorBox, Loading } from '../../components/ui.jsx';
import { VerificationTable } from './Verifications.jsx';

const VERDICT_COLORS = {
  verified: 'var(--ok)',
  not_found: 'var(--ink-2)',
  invalid_signature: 'var(--bad)',
  tampered: '#d0675a',
  revoked: '#c9a53c',
};

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState(null);
  const [error, setError] = useState(null);
  const fresh = useNewIds(recent);

  usePolling(async () => {
    try {
      const [s, v] = await Promise.all([api('/admin/stats'), api('/admin/verifications?limit=8')]);
      setStats(s);
      setRecent(v.verifications);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, 5000);

  if (!stats) return error ? <ErrorBox error={error} /> : <Loading />;
  const maxVerdict = Math.max(1, ...stats.verdicts.map((v) => v.n));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Overview</div>
          <h1>Dashboard</h1>
        </div>
        <Link className="btn primary" to="/admin/upload">
          + Upload certificate
        </Link>
      </div>

      <div className="grid grid-4">
        <div className="card stat">
          <div className="label">Certificates registered</div>
          <div className="value">{stats.certificates.total}</div>
          <div className="small muted">
            {stats.certificates.active} active · {stats.certificates.revoked} revoked
          </div>
        </div>
        <div className="card stat">
          <div className="label">Verifications</div>
          <div className="value">{stats.verifications.total}</div>
          <div className="small muted">all time</div>
        </div>
        <div className="card stat">
          <div className="label">Verifications today</div>
          <div className="value" style={{ color: 'var(--rust-ink)' }}>
            {stats.verifications.today}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Verifying organisations</div>
          <div className="value">{stats.verifications.organisations}</div>
        </div>
      </div>

      <div>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>
            Latest verifications <span className="live-dot" title="Live" />
          </h2>
          <Link to="/admin/verifications" className="small">
            All verifications →
          </Link>
        </div>
        {recent ? <VerificationTable rows={recent} fresh={fresh} /> : <Loading />}
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-title">Verification outcomes</div>
          {stats.verdicts.length === 0 ? (
            <Empty>No employer checks yet.</Empty>
          ) : (
            stats.verdicts.map((v) => (
              <div className="bar-row" key={v.verdict}>
                <Badge value={v.verdict} verdict />
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${(v.n / maxVerdict) * 100}%`, background: VERDICT_COLORS[v.verdict] || 'var(--ink-3)' }}
                  />
                </div>
                <strong style={{ textAlign: 'right' }}>{v.n}</strong>
              </div>
            ))
          )}
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Spikes in <em>Tampered</em> or <em>Invalid signature</em> can mean forged copies are circulating.
          </p>
        </div>
        <div className="card">
          <div className="card-title">Quick actions</div>
          <div className="stack" style={{ gap: 10 }}>
            <Link className="btn ghost block" to="/admin/upload">
              Upload a scanned certificate
            </Link>
            <Link className="btn ghost block" to="/admin/certificates?status=active">
              Find &amp; revoke a certificate
            </Link>
            <Link className="btn ghost block" to="/admin/verifications">
              Review who verified
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
