import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import clsx from 'clsx';
import { adminApi } from '../../lib/api.js';
import { hourLabel, hoursText, minutesText } from '../../lib/format.js';
import { promoText } from '../../lib/schedule.js';
import { Field, Switch } from '../../components/ui.jsx';
import { HOURS_0_24, LoadError, PageHead, useLoader } from './admin-shared.jsx';
import { GcashQrSettings } from './GcashQrSettings.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BUFFER_CHOICES = [0, 30, 60, 90, 120];

// Staff alert emails. `text` follows the bold label.
const NOTIFY_SWITCHES = [
  { key: 'notify_new_booking', label: 'New bookings', text: 'Every booking made on the website.' },
  { key: 'notify_payment_proof', label: 'GCash receipts to check', text: 'When a customer uploads a payment screenshot.' },
  { key: 'notify_customer_changes', label: 'Cancellations and changes', text: 'When a customer cancels or moves a booking online.' },
];

function testEmailError(err) {
  if (err.code === 'mail_not_configured') return 'Email is off. Add your Gmail App Password to the server settings first.';
  if (err.code === 'no_recipient') return 'There is no address to send to. Type one under “Send studio alerts to”, save, then try again.';
  if (err.code === 'mail_failed') return 'Gmail didn’t send the test email. Check the Gmail address and App Password in the server settings, then try again.';
  if (err.status === 429) return 'Too many test emails. Wait a few minutes and try again.';
  return err.message;
}

export default function Settings() {
  const loaded = useLoader(() => adminApi.settings(), []);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  // Older servers don't send `mail`; treat that as "not set up".
  const [mail, setMail] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (loaded.data) {
      setForm(loaded.data.settings);
      setSaved(loaded.data.settings);
      setMail(loaded.data.mail || null);
    }
  }, [loaded.data]);

  if (loaded.error && !loaded.data) return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  if (!form) {
    return (
      <div className="a-page">
        <PageHead title="Settings" />
        <div className="skeleton" style={{ height: 320 }} />
      </div>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const num = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value === '' ? '' : Number(e.target.value) }));
  const bool = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const legacy = loaded.data?.legacy;
  const toggleDay = (d) =>
    setForm((f) => ({
      ...f,
      closed_weekdays: f.closed_weekdays.includes(d) ? f.closed_weekdays.filter((x) => x !== d) : [...f.closed_weekdays, d].sort(),
    }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const r = await adminApi.saveSettings(form);
      setForm(r.settings);
      setSaved(r.settings);
      if (r.mail) setMail(r.mail);
      else if (r.settings.notify_email) setMail((m) => (m ? { ...m, notifyTo: r.settings.notify_email } : m));
      toast.success('Settings saved');
    } catch (err) {
      setFieldErrors(err.fields || {});
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const mailOn = Boolean(mail?.configured);
  const notifyTo = mail?.notifyTo || '';
  // The test goes to the saved address, so a typed-but-unsaved one has to be saved first.
  const emailDirty = (form.notify_email ?? '') !== (saved?.notify_email ?? '');
  const setNotifyEmail = (e) => {
    setForm((f) => ({ ...f, notify_email: e.target.value }));
    setFieldErrors((fe) => ({ ...fe, notify_email: undefined }));
  };
  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await adminApi.sendTestEmail();
      const to = r.to || saved?.notify_email || notifyTo;
      toast.success(to ? `Test email sent to ${to}. Check the inbox and Spam.` : 'Test email sent. Check the inbox and Spam.');
    } catch (err) {
      toast.error(testEmailError(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <form className="a-page settings" onSubmit={save} noValidate>
      <PageHead title="Settings" sub="These rules apply to online bookings. Staff can still add bookings outside them.">
        <Link to="/admin/content" className="btn btn-sm btn-outline">
          Contact details and photos
        </Link>
      </PageHead>

      <section className="set-section" aria-labelledby="set-hours">
        <h2 id="set-hours" className="a-h2">
          Opening hours
        </h2>
        <div className="form-grid">
          <Field label="Opens at">
            {(p) => (
              <select {...p} className="select" value={form.open_hour} onChange={num('open_hour')}>
                {HOURS_0_24.slice(0, 24).map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Closes at">
            {(p) => (
              <select {...p} className="select" value={form.close_hour} onChange={num('close_hour')}>
                {HOURS_0_24.slice(1).map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="field span-2">
            <span className="field-label" id="closed-days">
              Closed on
            </span>
            <div className="day-chips" role="group" aria-labelledby="closed-days">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  className={clsx('chip')}
                  aria-pressed={form.closed_weekdays.includes(i)}
                  onClick={() => toggleDay(i)}
                >
                  {d}
                </button>
              ))}
            </div>
            <span className="field-hint">
              {form.closed_weekdays.length ? 'Bands can’t book these days online.' : 'Open every day. Tap a day to close it every week.'}
            </span>
          </div>
        </div>
      </section>

      <section className="set-section" aria-labelledby="set-rules">
        <h2 id="set-rules" className="a-h2">
          Booking rules
        </h2>
        <div className="form-grid">
          <Field label="Shortest booking" hint="In hours.">
            {(p) => <input {...p} className="input tnum" type="number" inputMode="numeric" min={1} value={form.min_hours} onChange={num('min_hours')} />}
          </Field>
          <Field label="Longest booking" hint="In hours.">
            {(p) => <input {...p} className="input tnum" type="number" inputMode="numeric" min={1} value={form.max_hours} onChange={num('max_hours')} />}
          </Field>
          <Field label="Book at least" hint="Hours before the start time.">
            {(p) => <input {...p} className="input tnum" type="number" inputMode="numeric" min={0} value={form.lead_time_hours} onChange={num('lead_time_hours')} />}
          </Field>
          <Field label="Book up to" hint="Days ahead.">
            {(p) => <input {...p} className="input tnum" type="number" inputMode="numeric" min={1} value={form.max_days_ahead} onChange={num('max_days_ahead')} />}
          </Field>
          <Field label="Online cancellation closes" hint="Hours before the start time.">
            {(p) => (
              <input {...p} className="input tnum" type="number" inputMode="numeric" min={0} value={form.cancel_cutoff_hours} onChange={num('cancel_cutoff_hours')} />
            )}
          </Field>
          <Field label="Cleaning time after each booking" hint="The studio stays free after every booking so staff can clean and set up. Customers can't book into it; staff can.">
            {(p) => (
              <select {...p} className="select" value={form.buffer_minutes ?? 0} onChange={num('buffer_minutes')}>
                {BUFFER_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? 'None' : minutesText(m)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="field">
            <span className="field-label">New online bookings</span>
            <label className="switch-row">
              <Switch checked={form.auto_confirm} onChange={bool('auto_confirm')} label="Confirm new bookings automatically" />
              <span>{form.auto_confirm ? 'Confirmed automatically' : 'Wait for staff to confirm'}</span>
            </label>
          </div>
        </div>
      </section>

      <section className="set-section" aria-labelledby="set-promo">
        <div className="set-head">
          <h2 id="set-promo" className="a-h2">
            Free hour promo
          </h2>
          <Switch checked={form.promo_enabled} onChange={bool('promo_enabled')} label="Free hour promo" />
        </div>
        {form.promo_enabled ? (
          <>
            <div className="form-grid">
              <Field label="When they book">
                {(p) => (
                  <input {...p} className="input tnum" type="number" inputMode="numeric" min={1} value={form.promo_buy_hours} onChange={num('promo_buy_hours')} />
                )}
              </Field>
              <Field label="Free hours">
                {(p) => (
                  <input {...p} className="input tnum" type="number" inputMode="numeric" min={1} value={form.promo_free_hours} onChange={num('promo_free_hours')} />
                )}
              </Field>
            </div>
            <p className="set-preview">
              The website says: <strong>{promoText(form)}</strong>. Free time is added after the paid hours, once per booking, only when it fits.
            </p>
          </>
        ) : (
          <p className="a-hint">Off. Bookings are charged for every hour.</p>
        )}
      </section>

      <section className="set-section" aria-labelledby="set-gcash">
        <div className="set-head">
          <h2 id="set-gcash" className="a-h2">
            Pay with GCash
          </h2>
          <Switch checked={form.gcash_enabled} onChange={bool('gcash_enabled')} label="Pay with GCash" />
        </div>
        {form.gcash_enabled ? (
          <>
            <p className="a-hint" style={{ marginBottom: 14 }}>
              Customers pay 50% or 100% by scanning a QR with the exact amount, then upload their receipt. You confirm each payment in GCash payments.
            </p>
            <GcashQrSettings />
            <div className="form-grid" style={{ marginTop: 18 }}>
              <Field label="Hold the slot without a screenshot" hint="Minutes, 5 to 240. After this the slot is released. Once a screenshot is uploaded it is held until you decide.">
                {(p) => (
                  <input {...p} className="input tnum" type="number" inputMode="numeric" min={5} max={240} value={form.gcash_hold_minutes ?? ''} onChange={num('gcash_hold_minutes')} />
                )}
              </Field>
              <Field label="Keep receipt screenshots for" hint="Days, 7 to 365. Screenshots are deleted after this; the payment record stays.">
                {(p) => (
                  <input {...p} className="input tnum" type="number" inputMode="numeric" min={7} max={365} value={form.receipt_retention_days ?? ''} onChange={num('receipt_retention_days')} />
                )}
              </Field>
            </div>
            {(legacy?.gcashName || legacy?.gcashNumber) && (
              <p className="a-hint" style={{ marginTop: 14 }}>
                Older manual GCash details on file ({[legacy.gcashName, legacy.gcashNumber].filter(Boolean).join(', ')}) are no longer shown to customers.
              </p>
            )}
          </>
        ) : (
          <p className="a-hint">Off. Bands only see “Pay at the studio”.</p>
        )}
      </section>

      <section className="set-section" aria-labelledby="set-email">
        <h2 id="set-email" className="a-h2">
          Email notifications
        </h2>
        <p className="a-hint" style={{ marginTop: 0, marginBottom: 14 }}>
          {mailOn ? 'Emails are sent from your Gmail.' : 'Email is off. Add your Gmail App Password to the server settings to turn it on.'}
        </p>
        <div className="form-grid">
          <Field label="Send studio alerts to" hint="Leave empty to use the Gmail that sends the emails." error={fieldErrors.notify_email}>
            {(p) => (
              <input
                {...p}
                className="input"
                type="email"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={254}
                placeholder={notifyTo || 'name@gmail.com'}
                value={form.notify_email ?? ''}
                onChange={setNotifyEmail}
              />
            )}
          </Field>
          <div className="field span-2">
            <span className="field-label" id="notify-about">
              Email the studio about
            </span>
            <div role="group" aria-labelledby="notify-about">
              {NOTIFY_SWITCHES.map((s) => (
                <label key={s.key} className="switch-row">
                  <Switch checked={Boolean(form[s.key])} onChange={bool(s.key)} label={s.label} />
                  <span>
                    <strong>{s.label}</strong>. {s.text}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn btn-sm btn-outline" disabled={!mailOn || testing || emailDirty} onClick={sendTest}>
            {testing ? 'Sending…' : 'Send test email'}
          </button>
          {mailOn && emailDirty && <p className="a-hint">Save your changes first. The test goes to the saved address.</p>}
        </div>
      </section>

      {error && (
        <div className="notice notice-bad" role="alert">
          {error}
        </div>
      )}

      <div className={clsx('save-bar', dirty && 'is-dirty')}>
        <span className="save-bar-text">{dirty ? 'You have unsaved changes.' : `Online bookings: ${hoursText(form.min_hours)} to ${hoursText(form.max_hours)}, ${hourLabel(form.open_hour)} to ${hourLabel(form.close_hour)}.`}</span>
        <button type="button" className="btn btn-ghost" disabled={!dirty || busy} onClick={() => setForm(saved)}>
          Undo changes
        </button>
        <button type="submit" className="btn btn-dark" disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}
