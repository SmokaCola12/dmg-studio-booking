import { useState } from 'react';
import { BrandMark } from '../../components/SiteChrome.jsx';
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
          <BrandMark />
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
