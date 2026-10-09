import { useEffect, useState } from 'react';

const KEY = 'certverify.theme';
const current = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

// index.html sets the initial theme (saved choice, else the system setting) before React loads.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable: choice lasts for this page only */
  }
  window.dispatchEvent(new Event('certverify:theme'));
}

const Sun = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
  </svg>
);

const Moon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
    <path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a7 7 0 0 0 10.7 10.7z" />
  </svg>
);

export default function ThemeToggle({ className = '' }) {
  const [theme, setTheme] = useState(current);

  useEffect(() => {
    const sync = () => setTheme(current());
    window.addEventListener('certverify:theme', sync);
    return () => window.removeEventListener('certverify:theme', sync);
  }, []);

  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`}
      onClick={() => applyTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </button>
  );
}
