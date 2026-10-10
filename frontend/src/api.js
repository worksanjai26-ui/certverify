import { useEffect, useRef, useState } from 'react';

const TOKEN_KEY = 'certverify.token';
const VERIFIER_KEY = 'certverify.verifier';
const SEEN_KEY = 'certverify.lastSeenVerification';

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: lasts until reload */
  }
}

export const getToken = () => storageGet(TOKEN_KEY);
export const setToken = (token) => storageSet(TOKEN_KEY, token || null);

export async function api(path, { method = 'GET', body, form, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  try {
    const res = await fetch(`/api${path}`, { method, headers, body: payload, signal: controller.signal });
    const data = (res.headers.get('content-type') || '').includes('application/json') ? await res.json() : null;
    if (!res.ok) {
      // Vercel rejects bodies over 4.5 MB itself, before our server can explain.
      const fallback = res.status === 413 ? 'The file is too large to upload. Compress it and try again.' : `Request failed (${res.status})`;
      const err = new Error(data?.error || fallback);
      err.status = res.status;
      err.data = data;
      if (res.status === 401 && path.startsWith('/admin') && path !== '/admin/login') {
        window.dispatchEvent(new Event('certverify:unauthorized'));
      }
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('The request timed out.');
      err.timeout = true;
      throw err;
    }
    if (e instanceof TypeError) throw new Error('Could not reach the verification server.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCertificateFile(id, version) {
  const qs = version === 'original' ? '?version=original' : '';
  const res = await fetch(`/api/admin/certificates/${encodeURIComponent(id)}/file${qs}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error('Could not fetch the file.');
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? `${id}.pdf`;
  return { blob: await res.blob(), name };
}

export async function downloadCertificateFile(id, version = 'verified') {
  const { blob, name } = await fetchCertificateFile(id, version);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function openCertificateFile(id, version = 'verified') {
  const tab = window.open('', '_blank');
  const { blob } = await fetchCertificateFile(id, version);
  const url = URL.createObjectURL(blob);
  if (tab) tab.location.href = url;
  else window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const formatDate = (iso, withTime = false) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
      })
    : '—';

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return formatDate(iso);
}

export const CERT_ID_RE = /^DEG-[A-Z0-9]+-\d{4}-\d{3,}$/i;

// Decoded QR text -> { id, h, s }. Links to other sites are returned as foreignUrl, never followed.
export function parseQrText(text, trustedOrigins) {
  const t = String(text || '').trim();
  if (CERT_ID_RE.test(t)) return { id: t.toUpperCase() };
  let url;
  try {
    url = new URL(t);
  } catch {
    return { invalid: true };
  }
  const m = url.pathname.match(/\/verify\/([^/?#]+)\/?$/);
  const embeddedId = m ? decodeURIComponent(m[1]).toUpperCase() : null;
  if (embeddedId && trustedOrigins.includes(url.origin)) {
    // Keep the whole query: hash, signature and the details (name, roll, marks, year) the QR carries.
    return { id: embeddedId, search: url.search };
  }
  return { foreignUrl: t, embeddedId };
}

// Who is verifying. Remembered on this device so repeat checks don't re-ask.
export function loadVerifier() {
  try {
    const v = JSON.parse(storageGet(VERIFIER_KEY) || 'null');
    return v?.name && v?.organization ? v : null;
  } catch {
    return null;
  }
}
export const saveVerifier = (v) => storageSet(VERIFIER_KEY, v ? JSON.stringify(v) : null);

export const getLastSeenVerification = () => Number(storageGet(SEEN_KEY)) || 0;
export function markVerificationsSeen(latestId) {
  storageSet(SEEN_KEY, String(latestId));
  window.dispatchEvent(new Event('certverify:seen'));
}

// Re-runs `fn` every `ms` while the tab is visible.
export function usePolling(fn, ms, deps = []) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (!stopped && document.visibilityState === 'visible') saved.current();
    };
    tick();
    const t = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

// Highlights rows that arrived after the first load.
export function useNewIds(rows) {
  const known = useRef(null);
  const [fresh, setFresh] = useState(new Set());
  useEffect(() => {
    if (!rows) return;
    const ids = rows.map((r) => r.id);
    if (known.current) {
      const added = ids.filter((id) => !known.current.has(id));
      if (added.length) {
        setFresh(new Set(added));
        setTimeout(() => setFresh(new Set()), 4000);
      }
    }
    known.current = new Set(ids);
  }, [rows]);
  return fresh;
}
