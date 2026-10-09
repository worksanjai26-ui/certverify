import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../../api.js';
import { Empty, ErrorBox, Loading } from '../../components/ui.jsx';

const ACTIONS = {
  register: 'Certificate registered',
  revoke: 'Certificate revoked',
  login: 'Sign in',
  login_failed: 'Failed sign in',
};

export function AuditTable({ events, showCert = true }) {
  if (!events.length) return <Empty>No events yet.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Event</th>
            {showCert && <th>Certificate</th>}
            <th>By</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{formatDate(e.at, true)}</td>
              <td>{ACTIONS[e.action] || e.action}</td>
              {showCert && (
                <td>
                  {e.cert_id ? (
                    <Link to={`/admin/certificates/${e.cert_id}`} className="mono">
                      {e.cert_id}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
              )}
              <td className="small">{e.actor || <span className="muted">{e.ip || '—'}</span>}</td>
              <td className="small muted">{e.detail || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Audit() {
  const [action, setAction] = useState('');
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setEvents(null);
    api(`/admin/audit${action ? `?action=${action}` : ''}`)
      .then((d) => setEvents(d.events))
      .catch(setError);
  }, [action]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Registrar accountability</div>
          <h1>Audit log</h1>
          <p className="small muted" style={{ margin: 0 }}>
            Sign-ins, uploads and revocations. Public checks are under <Link to="/admin/verifications">Verifications</Link>.
          </p>
        </div>
        <select value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 220 }}>
          <option value="">All events</option>
          {Object.entries(ACTIONS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={error} />
      {events ? <AuditTable events={events} /> : !error && <Loading />}
    </div>
  );
}
