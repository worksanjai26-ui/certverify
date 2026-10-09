import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import ThemeToggle from '../../components/ThemeToggle.jsx';
import { ErrorBox } from '../../components/ui.jsx';

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const to = location.state?.from || '/admin';

  if (user) return <Navigate to={to} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(to, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16, borderTop: '6px solid var(--rust)' }}>
      <ThemeToggle className="corner-toggle" />
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div className="eyebrow">Registrar console</div>
        <h1 style={{ fontSize: '2rem' }}>College sign in</h1>
        <p className="muted">Issue, manage and revoke degree certificates.</p>
        <form className="card stack" onSubmit={submit}>
          <label className="field">
            Email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <ErrorBox error={error} />
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="small" style={{ marginTop: 16 }}>
          <Link to="/">← Back to public verification</Link>
        </p>
      </div>
    </div>
  );
}
