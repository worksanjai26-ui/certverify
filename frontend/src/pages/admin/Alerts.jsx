import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, timeAgo, useNewIds, usePolling } from '../../api.js';
import { Badge, Empty, ErrorBox, Loading } from '../../components/ui.jsx';

function AlertCard({ alert, fresh, onAcked }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const acked = Boolean(alert.acknowledged_at);

  async function ack(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/alerts/${alert.id}/ack`, { method: 'POST', body: { note } });
      onAcked();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card alert-card ${acked ? 'acked' : alert.severity}${fresh ? ' fresh-card' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="row" style={{ gap: 8 }}>
            <Badge value={alert.severity} />
            <Badge value={alert.verdict} verdict />
            <span className="small muted">
              Alert #{alert.id} · <span title={formatDate(alert.at, true)}>{timeAgo(alert.at)}</span>
            </span>
          </div>
          <h3 style={{ margin: '8px 0 4px' }}>{alert.title}</h3>
        </div>
        {alert.cert_id && (
          <Link className="btn ghost sm" to={`/admin/certificates/${alert.cert_id}`}>
            {alert.cert_id} →
          </Link>
        )}
      </div>

      <ul className="finding-list" style={{ margin: '10px 0' }}>
        {alert.findings.map((f, i) => (
          <li key={i}>
            <Badge value={f.severity} />
            <span className="small">{f.message}</span>
          </li>
        ))}
      </ul>

      <dl className="details small">
        <dt>Presented by</dt>
        <dd>
          {alert.verifier_name} · {alert.verifier_org}
          {alert.verifier_email && (
            <>
              {' '}
              · <a href={`mailto:${alert.verifier_email}`}>{alert.verifier_email}</a>
            </>
          )}
        </dd>
        <dt>Source</dt>
        <dd className="muted">{alert.ip || '—'}</dd>
        {acked && (
          <>
            <dt>Acknowledged</dt>
            <dd>
              {formatDate(alert.acknowledged_at, true)} by {alert.acknowledged_by}
              {alert.note && <div className="muted">{alert.note}</div>}
            </dd>
          </>
        )}
      </dl>

      {!acked && (
        <form className="row" style={{ marginTop: 12 }} onSubmit={ack}>
          <input
            style={{ flex: '1 1 240px' }}
            placeholder="Note (optional), e.g. Contacted employer, reported to police"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
          />
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : 'Acknowledge'}
          </button>
        </form>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

export default function Alerts() {
  const [status, setStatus] = useState('open');
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const fresh = useNewIds(alerts);

  usePolling(
    async () => {
      try {
        const d = await api(`/admin/alerts?status=${status}`);
        setAlerts(d.alerts);
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    5000,
    [status, tick],
  );

  const refresh = () => {
    setTick((t) => t + 1);
    window.dispatchEvent(new Event('certverify:alerts'));
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Malpractice reported by the verification portal</div>
          <h1>Alerts</h1>
        </div>
        <div className="row">
          <span className="small muted">
            <span className="live-dot" /> Live
          </span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 170 }}>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="all">All alerts</option>
          </select>
        </div>
      </div>
      <p className="small muted" style={{ marginTop: -8 }}>
        An alert is raised whenever someone presents a document that was altered, carries a forged or copied QR code,
        points to a certificate that doesn't exist, or has been revoked.
      </p>
      <ErrorBox error={error} />
      {!alerts && !error && <Loading />}
      {alerts && alerts.length === 0 && (
        <div className="card">
          <Empty>{status === 'open' ? 'No open alerts. Nothing suspicious has been presented.' : 'No alerts.'}</Empty>
        </div>
      )}
      {alerts?.map((a) => (
        <AlertCard key={a.id} alert={a} fresh={fresh.has(a.id)} onAcked={refresh} />
      ))}
    </div>
  );
}
