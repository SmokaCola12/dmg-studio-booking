import { useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, adminToken } from '../../lib/api.js';
import { site } from '../../config/site.js';
import { Field } from '../../components/ui.jsx';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!password) {
      setError('Enter the staff password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { token } = await adminApi.login(password);
      adminToken.set(token);
      onLogin();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="a-login">
      <form className="a-login-card" onSubmit={submit} noValidate>
        <Link to="/" className="wordmark a-login-mark">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="3" y="8" width="14" height="7" rx="2" fill="var(--marigold)" />
            <rect x="12" y="18" width="15" height="7" rx="2" fill="var(--teal)" />
            <rect x="20" y="4" width="2.4" height="24" rx="1.2" fill="var(--rec)" />
          </svg>
          <span>{site.shortName}</span>
        </Link>
        <h1 className="a-login-title">Staff login</h1>
        <p className="a-login-sub">Manage bookings, studios and opening hours.</p>
        <Field label="Password" error={error}>
          {(p) => (
            <input
              {...p}
              type="password"
              className="input"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              enterKeyHint="go"
            />
          )}
        </Field>
        <button type="submit" className="btn btn-dark btn-lg btn-block" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
