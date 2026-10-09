import { useState } from 'react';

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading">
      <div className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="error-box">{error.message || String(error)}</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

const STATUS_TONES = {
  active: 'ok',
  revoked: 'warn',
  completed: 'ok',
  in_progress: 'muted',
  verified: 'ok',
  not_found: 'neutral',
  invalid_signature: 'bad',
  revoked_verdict: 'warn',
  tampered: 'bad',
  unable: 'muted',
};

const LABELS = {
  in_progress: 'In progress',
  not_found: 'Not found',
  invalid_signature: 'Invalid signature',
};

export function Badge({ value, verdict = false }) {
  if (!value) return <span className="muted">—</span>;
  const tone = STATUS_TONES[verdict && value === 'revoked' ? 'revoked_verdict' : value] || 'neutral';
  const label = LABELS[value] || value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
  return <span className={`badge tone-${tone}`}>{label}</span>;
}

export function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function FileDrop({ onFile, disabled, title, hint, accept = 'application/pdf,.pdf' }) {
  const [over, setOver] = useState(false);
  return (
    <label
      className={`dropzone${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !disabled) onFile(f);
      }}
    >
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      <strong>{title}</strong>
      {hint && <div className="small muted">{hint}</div>}
    </label>
  );
}
