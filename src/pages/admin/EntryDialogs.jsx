import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '../../lib/api.js';
import { Dialog, Field } from '../../components/ui.jsx';
import { hourLabel, hoursText, peso } from '../../lib/format.js';
import { useAdmin } from './admin-shared.jsx';

const overlaps = (list, s, e) => list.some((x) => s < x.end && e > x.start);

/** Busy times for a date from the admin schedule endpoint. */
function useDayBusy(date, open) {
  const [day, setDay] = useState(null);
  useEffect(() => {
    if (!open || !date) return;
    let live = true;
    setDay(null);
    adminApi
      .schedule(date)
      .then((d) => live && setDay(d))
      .catch((err) => toast.error(err.message));
    return () => {
      live = false;
    };
  }, [date, open]);
  return day;
}

const busyFor = (day, roomId) =>
  day
    ? [
        ...day.bookings
          .filter((b) => b.roomId === roomId && (b.status === 'pending' || b.status === 'confirmed'))
          .map((b) => ({ start: b.startHour, end: b.endHour })),
        ...day.blocks.filter((b) => b.roomId === null || b.roomId === roomId).map((b) => ({ start: b.startHour, end: b.endHour })),
      ]
    : [];

/** Staff-entered booking: walk-ins, phone calls, Messenger requests. Confirmed right away. */
export function NewBookingDialog({ open, onOpenChange, defaults, onCreated }) {
  const { changed } = useAdmin();
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && defaults) {
      setForm({
        roomId: defaults.roomId,
        date: defaults.date,
        startHour: defaults.startHour ?? '',
        paidHours: defaults.paidHours ?? 2,
        name: '',
        bandName: '',
        phone: '',
        headcount: 4,
        paymentMethod: 'pay_at_studio',
        paymentRef: '',
        adminNotes: '',
      });
      setError('');
    }
    // Reset only when the dialog opens; `defaults` is often a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const day = useDayBusy(form?.date, open);
  const rooms = day?.rooms || [];
  const settings = day?.settings;
  const room = rooms.find((r) => r.id === form?.roomId);
  const busyList = useMemo(() => busyFor(day, form?.roomId), [day, form?.roomId]);

  if (!form) return null;
  const set = (k, num = false) => (e) => setForm((f) => ({ ...f, [k]: num ? Number(e.target.value) : e.target.value }));

  const hours = [];
  if (settings) for (let h = settings.open_hour; h < settings.close_hour; h++) hours.push(h);
  const lengths = [];
  if (settings) for (let n = settings.min_hours; n <= settings.max_hours; n++) lengths.push(n);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Enter a name for this booking.');
      return;
    }
    if (form.startHour === '') {
      setError('Pick a start time.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await adminApi.createBooking({ ...form, startHour: Number(form.startHour) });
      toast.success(`Booked ${r.booking.roomName} for ${r.booking.bandName || r.booking.name}`);
      changed();
      onCreated?.(r.booking);
      onOpenChange(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New booking"
      description="For walk-ins, calls and Messenger requests. It’s confirmed right away."
      wide
    >
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Room">
            {(p) => (
              <select {...p} className="select" value={form.roomId} onChange={set('roomId', true)}>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({peso(r.hourly_rate)}/hr)
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Date">
            {(p) => <input {...p} type="date" className="input" value={form.date} onChange={set('date')} />}
          </Field>
          <Field label="Start">
            {(p) => (
              <select {...p} className="select" value={form.startHour} onChange={set('startHour')}>
                <option value="">Pick a time</option>
                {hours.map((h) => {
                  const taken = overlaps(busyList, h, h + Number(form.paidHours));
                  return (
                    <option key={h} value={h} disabled={taken}>
                      {hourLabel(h)}
                      {taken ? ' (taken)' : ''}
                    </option>
                  );
                })}
              </select>
            )}
          </Field>
          <Field label="Paid hours">
            {(p) => (
              <select {...p} className="select" value={form.paidHours} onChange={set('paidHours', true)}>
                {lengths.map((n) => (
                  <option key={n} value={n}>
                    {hoursText(n)}
                    {room ? `, ${peso(room.hourly_rate * n)}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Name">
            {(p) => <input {...p} className="input" value={form.name} onChange={set('name')} maxLength={80} />}
          </Field>
          <Field label="Band name" optional>
            {(p) => <input {...p} className="input" value={form.bandName} onChange={set('bandName')} maxLength={80} />}
          </Field>
          <Field label="Mobile number" optional>
            {(p) => <input {...p} className="input" type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} maxLength={16} />}
          </Field>
          <Field label="People">
            {(p) => <input {...p} className="input" type="number" inputMode="numeric" min={1} max={30} value={form.headcount} onChange={set('headcount', true)} />}
          </Field>
          <Field label="Payment">
            {(p) => (
              <select {...p} className="select" value={form.paymentMethod} onChange={set('paymentMethod')}>
                <option value="pay_at_studio">Pay at the studio</option>
                <option value="gcash">GCash</option>
              </select>
            )}
          </Field>
          <Field label="Reference number" optional>
            {(p) => <input {...p} className="input tnum" value={form.paymentRef} onChange={set('paymentRef')} maxLength={40} />}
          </Field>
          <Field label="Staff notes" optional className="span-2">
            {(p) => <textarea {...p} className="textarea" rows={2} value={form.adminNotes} onChange={set('adminNotes')} maxLength={500} />}
          </Field>
        </div>
        {error && (
          <div className="notice notice-bad" style={{ marginTop: 16 }} role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-outline" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-dark" disabled={busy || !day}>
            {busy ? 'Saving…' : 'Add booking'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Close a room (or the whole studio) for part of a day: repairs, private events, holidays. */
export function BlockDialog({ open, onOpenChange, defaults, onCreated }) {
  const { changed } = useAdmin();
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && defaults) {
      setForm({
        roomId: defaults.roomId ?? '',
        date: defaults.date,
        startHour: defaults.startHour ?? defaults.openHour ?? 10,
        endHour: defaults.endHour ?? defaults.closeHour ?? 22,
        reason: '',
      });
      setError('');
    }
    // Reset only when the dialog opens; `defaults` is often a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const day = useDayBusy(form?.date, open);
  if (!form) return null;
  const settings = day?.settings;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const hours = [];
  if (settings) for (let h = settings.open_hour; h <= settings.close_hour; h++) hours.push(h);

  const submit = async (e) => {
    e.preventDefault();
    if (Number(form.endHour) <= Number(form.startHour)) {
      setError('The end time has to be after the start time.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await adminApi.createBlock({
        roomId: form.roomId === '' ? null : Number(form.roomId),
        date: form.date,
        startHour: Number(form.startHour),
        endHour: Number(form.endHour),
        reason: form.reason,
      });
      toast.success('Time blocked');
      changed();
      onCreated?.();
      onOpenChange(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Block time"
      description="Blocked time can’t be booked online. Use it for repairs, private events or holidays."
    >
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Room" className="span-2">
            {(p) => (
              <select {...p} className="select" value={form.roomId} onChange={set('roomId')}>
                <option value="">All rooms</option>
                {(day?.rooms || []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Date" className="span-2">
            {(p) => <input {...p} type="date" className="input" value={form.date} onChange={set('date')} />}
          </Field>
          <Field label="From">
            {(p) => (
              <select {...p} className="select" value={form.startHour} onChange={set('startHour')}>
                {hours.slice(0, -1).map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Until">
            {(p) => (
              <select {...p} className="select" value={form.endHour} onChange={set('endHour')}>
                {hours.slice(1).map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Reason" optional className="span-2" hint="Shown to staff only. The website just says “Closed”.">
            {(p) => <input {...p} className="input" value={form.reason} onChange={set('reason')} maxLength={120} placeholder="Aircon repair" />}
          </Field>
        </div>
        {error && (
          <div className="notice notice-bad" style={{ marginTop: 16 }} role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-outline" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-dark" disabled={busy || !day}>
            {busy ? 'Saving…' : 'Block time'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
