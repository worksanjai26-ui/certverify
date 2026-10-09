import { useState } from 'react';
import { saveVerifier } from '../api.js';

export default function VerifierForm({ initial, onDone, onCancel }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [organization, setOrganization] = useState(initial?.organization ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');

  function submit(e) {
    e.preventDefault();
    const v = { name: name.trim(), organization: organization.trim(), email: email.trim() };
    saveVerifier(v);
    onDone(v);
  }

  return (
    <form className="card stack" onSubmit={submit} style={{ maxWidth: 560 }}>
      <div>
        <div className="card-title">Before you verify</div>
        <h2 style={{ marginBottom: 6 }}>Who is checking this certificate?</h2>
        <p className="small muted" style={{ margin: 0 }}>
          The institution keeps a record of every verification. Your details are shared only with the college
          registrar and are remembered on this device for your next check.
        </p>
      </div>
      <label className="field">
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={100} required autoFocus />
      </label>
      <label className="field">
        Organisation <span className="hint">Company, university or agency you are verifying for</span>
        <input value={organization} onChange={(e) => setOrganization(e.target.value)} minLength={2} maxLength={150} required />
      </label>
      <label className="field">
        Work email <span className="hint">Optional</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
      </label>
      <div className="row">
        <button className="btn primary">Continue to verification</button>
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function VerifierLine({ verifier, onChange }) {
  return (
    <span className="small muted">
      Verifying as <strong>{verifier.name}</strong> ({verifier.organization}) ·{' '}
      <button type="button" className="linklike" onClick={onChange}>
        change
      </button>
    </span>
  );
}
