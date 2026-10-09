import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, getLastSeenVerification, markVerificationsSeen, usePolling } from '../api.js';
import { useAuth } from '../auth.jsx';
import ThemeToggle from './ThemeToggle.jsx';

function Brand({ institution }) {
  return (
    <Link to="/" className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <path d="M3 8.5l3 3L13 4.5" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </svg>
      </span>
      <span>
        CertVerify
        <small>{institution || 'Degree verification'}</small>
      </span>
    </Link>
  );
}

export function useInstitution() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    api('/institution').then(setInfo).catch(() => {});
  }, []);
  return info;
}

// Shown when the server runs without a permanent database (Vercel without Turso).
function DemoStorageBanner({ info }) {
  if (info?.storage !== 'temporary') return null;
  return (
    <div className="demo-banner" role="note">
      Demo mode: temporary storage. Uploaded certificates and logs can be reset at any time.
    </div>
  );
}

export function PublicLayout() {
  const info = useInstitution();
  return (
    <>
      <DemoStorageBanner info={info} />
      <header className="topbar">
        <div className="topbar-inner">
          <Brand institution={info?.name} />
          <nav className="nav">
            <NavLink to="/" end>
              Verify
            </NavLink>
            <NavLink to="/scan">Scan QR</NavLink>
            <NavLink to="/admin">Registrar login</NavLink>
          </nav>
          <ThemeToggle />
        </div>
      </header>
      <main className="page">
        <div className="container">
          <Outlet />
        </div>
      </main>
    </>
  );
}

// Count of public verifications the registrar hasn't looked at yet.
function useUnseenVerifications() {
  const [count, setCount] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onSeen = () => {
      setCount(0);
      setTick((t) => t + 1);
    };
    window.addEventListener('certverify:seen', onSeen);
    return () => window.removeEventListener('certverify:seen', onSeen);
  }, []);
  usePolling(
    async () => {
      try {
        const seen = getLastSeenVerification();
        const d = await api(`/admin/verifications/count?after=${seen}`);
        if (!seen) markVerificationsSeen(d.latestId); // first visit: start counting from now
        else setCount(d.newCount);
      } catch {
        /* transient; next poll retries */
      }
    },
    5000,
    [tick],
  );
  return count;
}

// Open malpractice alerts; also shown in the tab title so it's noticed from other tabs.
export function useOpenAlerts() {
  const [counts, setCounts] = useState({ open: 0, openHigh: 0 });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('certverify:alerts', bump);
    return () => window.removeEventListener('certverify:alerts', bump);
  }, []);
  usePolling(
    async () => {
      try {
        setCounts(await api('/admin/alerts/count'));
      } catch {
        /* transient; next poll retries */
      }
    },
    5000,
    [tick],
  );
  useEffect(() => {
    document.title = counts.open ? `(${counts.open}) ⚠ CertVerify` : 'CertVerify';
    return () => {
      document.title = 'CertVerify';
    };
  }, [counts.open]);
  return counts;
}

export function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const unseen = useUnseenVerifications();
  const alerts = useOpenAlerts();
  const info = useInstitution();
  const links = [
    ['/admin', 'Dashboard', true],
    ['/admin/alerts', 'Alerts', false, alerts.open, 'danger'],
    ['/admin/upload', 'Upload certificate'],
    ['/admin/certificates', 'Certificates'],
    ['/admin/verifications', 'Verifications', false, unseen],
    ['/admin/audit', 'Audit log'],
  ];
  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <Brand institution="Registrar console" />
          <ThemeToggle />
        </div>
        {links.map(([to, label, end, badge, kind]) => (
          <NavLink key={to} to={to} end={end} className="side-link">
            {label}
            {badge > 0 && <span className={`nav-badge ${kind ?? ''}`}>{badge > 99 ? '99+' : badge}</span>}
          </NavLink>
        ))}
        <a className="side-link" href="/" target="_blank" rel="noreferrer">
          Public portal ↗
        </a>
        <div className="spacer" />
        <div className="who">
          Signed in as
          <strong>{user?.email}</strong>
        </div>
        <button
          className="btn ghost sm"
          style={{ color: '#fff', borderColor: '#45484f' }}
          onClick={async () => {
            await logout();
            navigate('/admin/login');
          }}
        >
          Sign out
        </button>
      </aside>
      <div className="admin-main">
        <DemoStorageBanner info={info} />
        <Outlet />
      </div>
    </div>
  );
}
