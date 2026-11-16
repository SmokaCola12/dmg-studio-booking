import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '../../lib/api.js';
import { ConfirmDialog, Dialog, Field } from '../../components/ui.jsx';
import { bookingEnd, bookingStart, hourLabel, hoursText, peso, splitStart } from '../../lib/format.js';
import { bufferMinutes, conflictReason } from '../../lib/schedule.js';
import { useAdmin } from './admin-shared.jsx';

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

// Busy times in decimal hours. Bookings carry their cleaning time (bufferEnd); blocks have none.
const busyFor = (day, roomId) =>
  day
    ? [
        ...day.bookings
          .filter((b) => b.roomId === roomId && (b.status === 'pending' || b.status === 'confirmed'))
          .map((b) => ({
            kind: 'booking',
            start: bookingStart(b),
            end: bookingEnd(b),
            bufferEnd: bookingEnd(b) + bufferMinutes(day.settings) / 60,
          })),
        ...day.blocks
          .filter((b) => b.roomId === null || b.roomId === roomId)
          .map((b) => ({ kind: 'block', start: b.startHour, end: b.endHour })),
      ]
    : [];

/** Staff-entered booking: walk-ins, phone calls, Messenger requests. Confirmed right away. */
export function NewBookingDialog({ open, onOpenChange, defaults, onCreated }) {
  const { changed } = useAdmin();
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Set when the server says the time only clashes with another booking's cleaning time (409, code 'buffer').
  const [bufferAsk, setBufferAsk] = useState(null);

  useEffect(() => {
    if (open && defaults) {
      setBufferAsk(null);
      setForm({
        roomId: defaults.roomId,
        date: defaults.date,
        start: defaults.startHour ?? '', // decimal hour, 15.5 = 3:30 PM
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
  if (settings) for (let h = settings.open_hour; h < settings.close_hour; h += 0.5) hours.push(h);
  const lengths = [];
  if (settings) for (let n = settings.min_hours; n <= settings.max_hours; n++) lengths.push(n);
  const buffer = bufferMinutes(settings);

  const save = async (overrideBuffer = false) => {
    setBusy(true);
    setError('');
    try {
      const { start, ...rest } = form;
      const r = await adminApi.createBooking({
        ...rest,
        ...splitStart(Number(start)),
        ...(overrideBuffer ? { overrideBuffer: true } : {}),
      });
      toast.success(`Booked ${r.booking.roomName} for ${r.booking.bandName || r.booking.name}`);
      changed();
      onCreated?.(r.booking);
      onOpenChange(false);
    } catch (err) {
      if (err.status === 409 && err.code === 'buffer') {
        // Staff can book into the cleaning time on purpose, after a warning.
        setBufferAsk(err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Enter a name for this booking.');
      return;
    }
    if (form.start === '') {
      setError('Pick a start time.');
      return;
    }
    save(false);
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
          <Field label="Studio">
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
              <select {...p} className="select" value={form.start} onChange={set('start')}>
                <option value="">Pick a time</option>
                {hours.map((h) => {
                  const clash = conflictReason(busyList, h, h + Number(form.paidHours), buffer);
                  return (
                    <option key={h} value={h} disabled={clash === 'taken'}>
                      {hourLabel(h)}
                      {clash === 'taken' ? ' (taken)' : clash === 'cleaning' ? ' (cleaning time, you can override)' : ''}
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
      <ConfirmDialog
        open={Boolean(bufferAsk)}
        onOpenChange={(o) => !o && setBufferAsk(null)}
        title="Not enough cleaning time"
        description={`${bufferAsk || ''} Book it anyway?`}
        confirmLabel="Book anyway"
        cancelLabel="Go back"
        busy={busy}
        onConfirm={() => {
          setBufferAsk(null);
          save(true);
        }}
      />
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
          <Field label="Studio" className="span-2">
            {(p) => (
              <select {...p} className="select" value={form.roomId} onChange={set('roomId')}>
                <option value="">All studios</option>
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
