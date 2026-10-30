import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { adminApi } from '../../lib/api.js';
import { hourLabel, hoursText } from '../../lib/format.js';
import { promoText } from '../../lib/schedule.js';
import { Field, Switch } from '../../components/ui.jsx';
import { HOURS_0_24, LoadError, PageHead, useLoader } from './admin-shared.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Settings() {
  const loaded = useLoader(() => adminApi.settings(), []);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (loaded.data) {
      setForm(loaded.data.settings);
      setSaved(loaded.data.settings);
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
  const text = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const bool = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleDay = (d) =>
    setForm((f) => ({
      ...f,
      closed_weekdays: f.closed_weekdays.includes(d) ? f.closed_weekdays.filter((x) => x !== d) : [...f.closed_weekdays, d].sort(),
    }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await adminApi.saveSettings(form);
      setForm(r.settings);
      setSaved(r.settings);
      toast.success('Settings saved');
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="a-page settings" onSubmit={save} noValidate>
      <PageHead title="Settings" sub="These rules apply to online bookings. Staff can still add bookings outside them." />

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
            GCash downpayment
          </h2>
          <Switch checked={form.gcash_enabled} onChange={bool('gcash_enabled')} label="GCash downpayment" />
        </div>
        {form.gcash_enabled ? (
          <div className="form-grid">
            <Field label="Account name">
              {(p) => <input {...p} className="input" value={form.gcash_name} onChange={text('gcash_name')} maxLength={80} />}
            </Field>
            <Field label="GCash number">
              {(p) => <input {...p} className="input tnum" type="tel" inputMode="tel" value={form.gcash_number} onChange={text('gcash_number')} maxLength={20} />}
            </Field>
          </div>
        ) : (
          <p className="a-hint">Off. Bands only see “Pay at the studio”.</p>
        )}
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
