import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MessageSquare, Phone, Mail } from 'lucide-react';
import { adminApi } from '../../lib/api.js';
import { ConfirmDialog, Dialog, Field, StatusBadge } from '../../components/ui.jsx';
import { bookingEnd, bookingStart, dateLabel, formatPhone, hourLabel, hoursText, PAYMENT_LABELS, peso, rangeLabel, splitStart } from '../../lib/format.js';
import { useAdmin } from './admin-shared.jsx';

/** Details and actions for one booking. `booking` stays mounted while closing so the exit animation has content. */
export function BookingDialog({ booking, open, onOpenChange, onSaved }) {
  const { changed } = useAdmin();
  const [current, setCurrent] = useState(booking);
  const [notes, setNotes] = useState('');
  const [paymentRef, setPaymentRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'cancel' | 'no_show'
  const [moving, setMoving] = useState(false);
  // Set when the server says the change only clashes with another booking's cleaning time (409, code 'buffer').
  const [bufferAsk, setBufferAsk] = useState(null); // { body, message, text }

  useEffect(() => {
    if (booking) {
      setCurrent(booking);
      setNotes(booking.adminNotes || '');
      setPaymentRef(booking.paymentRef || '');
      setMoving(false);
      setBufferAsk(null);
    }
  }, [booking]);

  if (!current) return null;
  const b = current;
  const dirty = notes !== (b.adminNotes || '') || paymentRef !== (b.paymentRef || '');

  const patch = async (body, message) => {
    setBusy(true);
    try {
      const r = await adminApi.updateBooking(b.id, body);
      setCurrent(r.booking);
      setNotes(r.booking.adminNotes || '');
      setPaymentRef(r.booking.paymentRef || '');
      toast.success(message);
      changed();
      onSaved?.(r.booking);
      return true;
    } catch (err) {
      if (err.status === 409 && err.code === 'buffer') {
        // Staff may book into the cleaning time on purpose, after a warning.
        setBufferAsk({ body, message, text: err.message });
      } else {
        toast.error(err.message);
      }
      return false;
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const who = b.bandName || b.name;
  const active = b.status === 'pending' || b.status === 'confirmed';

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={who}
        description={`${b.code}${b.source === 'walk_in' ? ', added by staff' : ', booked online'}`}
        wide
        footer={
          <>
            {b.status === 'pending' && (
              <>
                <button type="button" className="btn btn-outline" onClick={() => setConfirm('cancel')} disabled={busy}>
                  Decline
                </button>
                <button type="button" className="btn btn-dark" onClick={() => patch({ status: 'confirmed' }, 'Booking confirmed')} disabled={busy}>
                  Confirm booking
                </button>
              </>
            )}
            {b.status === 'confirmed' && (
              <>
                <button type="button" className="btn btn-ghost" onClick={() => setConfirm('cancel')} disabled={busy}>
                  Cancel booking
                </button>
                <button type="button" className="btn btn-outline" onClick={() => setConfirm('no_show')} disabled={busy}>
                  Mark as no-show
                </button>
                <button type="button" className="btn btn-dark" onClick={() => patch({ status: 'completed' }, 'Marked as done')} disabled={busy}>
                  Mark as done
                </button>
              </>
            )}
            {!active && (
              <button type="button" className="btn btn-outline" onClick={() => patch({ status: 'confirmed' }, 'Booking reopened')} disabled={busy}>
                Reopen as confirmed
              </button>
            )}
          </>
        }
      >
        <div className="bd-grid">
          <div className="bd-when" style={{ '--room': b.roomColor }}>
            <StatusBadge status={b.status} />
            <p className="bd-when-main">
              {b.roomName}, {dateLabel(b.date, { long: true })}
            </p>
            <p className="bd-when-sub tnum">
              {rangeLabel(bookingStart(b), bookingEnd(b))} ({hoursText(b.paidHours)}
              {b.freeHours ? ` + ${hoursText(b.freeHours)} free` : ''})
            </p>
            {active && !moving && (
              <button type="button" className="btn btn-ghost btn-sm bd-move" onClick={() => setMoving(true)}>
                Move to another time
              </button>
            )}
          </div>

          {moving && (
            <MoveForm
              booking={b}
              busy={busy}
              onCancel={() => setMoving(false)}
              onSave={async (body) => {
                if (await patch(body, 'Booking moved')) setMoving(false);
              }}
            />
          )}

          <dl className="bd-list">
            <div>
              <dt>Booked by</dt>
              <dd className="break">{b.name}</dd>
            </div>
            {b.bandName && (
              <div>
                <dt>Band</dt>
                <dd className="break">{b.bandName}</dd>
              </div>
            )}
            <div>
              <dt>Mobile</dt>
              <dd>
                {b.phone ? (
                  <span className="bd-contact">
                    <span className="tnum">{formatPhone(b.phone)}</span>
                    <a className="btn btn-outline btn-sm" href={`tel:${b.phone}`} aria-label={`Call ${b.name}`}>
                      <Phone />
                    </a>
                    <a className="btn btn-outline btn-sm" href={`sms:${b.phone}`} aria-label={`Text ${b.name}`}>
                      <MessageSquare />
                    </a>
                  </span>
                ) : (
                  <span className="muted">Not given</span>
                )}
              </dd>
            </div>
            {b.email && (
              <div>
                <dt>Email</dt>
                <dd className="break">
                  <a href={`mailto:${b.email}`} className="bd-link">
                    <Mail aria-hidden="true" /> {b.email}
                  </a>
                </dd>
              </div>
            )}
            <div>
              <dt>People</dt>
              <dd>{b.headcount}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd className="tnum">
                {peso(b.total)} <span className="muted">({hoursText(b.paidHours)} × {peso(b.hourlyRate)})</span>
              </dd>
            </div>
            <div>
              <dt>Payment</dt>
              <dd>{PAYMENT_LABELS[b.paymentMethod]}</dd>
            </div>
            {b.notes && (
              <div>
                <dt>Their note</dt>
                <dd className="break bd-note">{b.notes}</dd>
              </div>
            )}
          </dl>

          <div className="bd-staff">
            <Field label="GCash or receipt reference" optional>
              {(p) => <input {...p} className="input tnum" value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} maxLength={40} />}
            </Field>
            <Field label="Staff notes" optional hint="Only staff see this.">
              {(p) => (
                <textarea
                  {...p}
                  className="textarea"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={500}
                  placeholder="Paid ₱400 downpayment, needs an extra mic…"
                />
              )}
            </Field>
            {dirty && (
              <div>
                <button type="button" className="btn btn-dark btn-sm" disabled={busy} onClick={() => patch({ adminNotes: notes, paymentRef }, 'Notes saved')}>
                  Save notes
                </button>
              </div>
            )}
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={b.status === 'pending' ? 'Decline this booking?' : 'Cancel this booking?'}
        description={`${who}, ${b.roomName}, ${dateLabel(b.date)} ${rangeLabel(bookingStart(b), bookingEnd(b))}. The time opens up for other bands. Let them know by text or Messenger.`}
        confirmLabel={b.status === 'pending' ? 'Decline booking' : 'Cancel booking'}
        cancelLabel="Keep it"
        danger
        busy={busy}
        onConfirm={() => patch({ status: 'cancelled' }, b.status === 'pending' ? 'Booking declined' : 'Booking cancelled')}
      />
      <ConfirmDialog
        open={confirm === 'no_show'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Mark as no-show?"
        description={`${who} didn’t come to their ${hourLabel(bookingStart(b))} slot. You can reopen it later if this was a mistake.`}
        confirmLabel="Mark as no-show"
        cancelLabel="Go back"
        busy={busy}
        onConfirm={() => patch({ status: 'no_show' }, 'Marked as no-show')}
      />
      <ConfirmDialog
        open={Boolean(bufferAsk)}
        onOpenChange={(o) => !o && setBufferAsk(null)}
        title="Not enough cleaning time"
        description={`${bufferAsk?.text || 'This time is inside another booking’s cleaning time.'} Save it anyway?`}
        confirmLabel="Save anyway"
        cancelLabel="Go back"
        busy={busy}
        onConfirm={async () => {
          const ask = bufferAsk;
          setBufferAsk(null);
          if (await patch({ ...ask.body, overrideBuffer: true }, ask.message)) setMoving(false);
        }}
      />
    </>
  );
}

function MoveForm({ booking, busy, onCancel, onSave }) {
  const [rooms, setRooms] = useState(null);
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({
    roomId: booking.roomId,
    date: booking.date,
    start: bookingStart(booking), // decimal hour, 15.5 = 3:30 PM
    paidHours: booking.paidHours,
  });

  useEffect(() => {
    Promise.all([adminApi.rooms(), adminApi.settings()])
      .then(([r, s]) => {
        setRooms(r.rooms);
        setSettings(s.settings);
      })
      .catch((err) => toast.error(err.message));
  }, []);

  if (!rooms || !settings) return <div className="skeleton" style={{ height: 120 }} />;
  const hours = [];
  for (let h = settings.open_hour; h < settings.close_hour; h += 0.5) hours.push(h);
  const lengths = [];
  for (let n = settings.min_hours; n <= settings.max_hours; n++) lengths.push(n);
  const set = (k, num = true) => (e) => setForm((f) => ({ ...f, [k]: num ? Number(e.target.value) : e.target.value }));

  return (
    <div className="bd-move-form">
      <div className="form-grid">
        <Field label="Room">
          {(p) => (
            <select {...p} className="select" value={form.roomId} onChange={set('roomId')}>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {!r.active ? ' (hidden)' : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Date">
          {(p) => <input {...p} type="date" className="input" value={form.date} onChange={set('date', false)} />}
        </Field>
        <Field label="Start">
          {(p) => (
            <select {...p} className="select" value={form.start} onChange={set('start')}>
              {hours.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Paid hours">
          {(p) => (
            <select {...p} className="select" value={form.paidHours} onChange={set('paidHours')}>
              {lengths.map((n) => (
                <option key={n} value={n}>
                  {hoursText(n)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <p className="field-hint" style={{ marginTop: 8 }}>
        The price updates to the new room’s rate. The free promo hour is added again if it fits.
      </p>
      <div className="bd-move-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Never mind
        </button>
        <button type="button" className="btn btn-dark btn-sm" disabled={busy} onClick={() => onSave({ roomId: form.roomId, date: form.date, ...splitStart(form.start), paidHours: form.paidHours })}>
          Move booking
        </button>
      </div>
    </div>
  );
}
