import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, formatDate } from '../../api.js';
import { Badge, Empty, ErrorBox, Loading } from '../../components/ui.jsx';

export default function Certificates() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const status = params.get('status') || '';
  const [query, setQuery] = useState(q);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    api(`/admin/certificates?${new URLSearchParams({ q, status })}`)
      .then((d) => alive && setRows(d.certificates))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [q, status]);

  const update = (next) => setParams(Object.fromEntries(Object.entries({ q, status, ...next }).filter(([, v]) => v)));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Registry</div>
          <h1>Certificates</h1>
        </div>
        <Link className="btn primary" to="/admin/upload">
          + Upload certificate
        </Link>
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: query.trim() });
        }}
      >
        <input
          style={{ flex: '1 1 260px' }}
          placeholder="Search by ID, roll number or name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select style={{ width: 160 }} value={status} onChange={(e) => update({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="revoked">Revoked</option>
        </select>
        <button className="btn">Search</button>
      </form>

      <ErrorBox error={error} />
      {!rows && !error && <Loading />}
      {rows && rows.length === 0 && (
        <div className="card">
          <Empty>
            No certificates found. <Link to="/admin/upload">Upload the first scan.</Link>
          </Empty>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Certificate ID</th>
                <th>Student</th>
                <th>Degree</th>
                <th>Year</th>
                <th>Status</th>
                <th>Verified</th>
                <th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/admin/certificates/${c.id}`)}>
                  <td className="mono">
                    <Link to={`/admin/certificates/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      {c.id}
                    </Link>
                  </td>
                  <td>
                    {c.studentName}
                    <div className="small muted">{c.rollNo}</div>
                  </td>
                  <td className="small">
                    {c.program}
                    <div className="muted">{c.department}</div>
                  </td>
                  <td>{c.graduationYear}</td>
                  <td>
                    <Badge value={c.status} />
                  </td>
                  <td>{c.verificationCount}×</td>
                  <td className="small">{formatDate(c.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
