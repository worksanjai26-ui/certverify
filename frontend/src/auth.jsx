import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, getToken, setToken } from './api.js';
import { Loading } from './components/ui.jsx';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => {
      setToken(null);
      setUser(null);
    };
    window.addEventListener('certverify:unauthorized', onUnauthorized);
    if (getToken()) {
      api('/admin/me')
        .then((d) => setUser(d.user))
        .catch(() => setToken(null))
        .finally(() => setReady(true));
    } else {
      setReady(true);
    }
    return () => window.removeEventListener('certverify:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (email, password) => {
    const d = await api('/admin/login', { method: 'POST', body: { email, password } });
    setToken(d.token);
    setUser(d.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/admin/logout', { method: 'POST' });
    } catch {
      /* token may already be invalid */
    }
    setToken(null);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, ready, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

export function RequireAuth({ children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Loading label="Checking your session…" />;
  if (!user) return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  return children;
}
