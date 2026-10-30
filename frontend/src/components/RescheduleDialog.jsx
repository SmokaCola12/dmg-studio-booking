import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { Info } from 'lucide-react';
import { Dialog } from './ui.jsx';
import { api } from '../lib/api.js';
import { useAvailability } from '../lib/useAvailability.js';
import { startOptions } from '../lib/schedule.js';
import { addDays, dateLabel, hourLabel, hoursText, rangeLabel } from '../lib/format.js';

/** Move a booking to another date or start time. Room and paid hours stay the same. */
export function RescheduleDialog({ open, onOpenChange, booking, phone, settings, today, onMoved }) {
  const [date, setDate] = useState(booking.date);
  const [startHour, setStartHour] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const maxDate = addDays(today, settings.max_days_ahead);
  const minDate = booking.date < today ? booking.date : today;
  const { data: avail, loading } = useAvailability(date);

  const options = useMemo(() => {
    if (!avail || avail.date !== date) return [];
    let busy = avail.rooms.find((r) => r.id === booking.room.id)?.busy || [];
    if (date === booking.date) {
      // Your current slot is not in your way when you shift by an hour.
      const own = busy.findIndex(
        (b) => b.kind === 'booking' && b.start === booking.startHour && b.end === booking.endHour
      );
      if (own >= 0) busy = busy.filter((_, i) => i !== own);
    }
    return startOptions({ busy, settings, window: avail.window, paidHours: booking.paidHours });
  }, [avail, date, booking, settings]);

  const visible = options.filter((o) => !o.past);
  const isCurrent = (h) => date === booking.date && h === booking.startHour;
  const picked = options.find((o) => o.hour === startHour && o.ok);

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    setError('');
    try {
      const r = await api.rescheduleBooking(booking.code, phone, date, picked.hour);
      toast.success('Booking moved');
      onMoved(r.booking);
      onOpenChange(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Pick a new time"
      description={`${booking.room?.name}, ${hoursText(booking.paidHours)}. Now: ${dateLabel(booking.date)}, ${rangeLabel(booking.startHour, booking.endHour)}`}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={() => onOpenChange(false)}>
            Keep current time
          </button>
          <button type="button" className="btn btn-primary" disabled={!picked || saving} onClick={save}>
            {saving ? 'Moving…' : 'Move booking'}
          </button>
        </>
      }
    >
      <div className="resched-body">
        <label className="field">
          <span className="field-label">New date</span>
          <input
            type="date"
            className="input"
            min={minDate}
            max={maxDate}
            value={date}
            onChange={(e) => {
              if (!e.target.value) return;
              setDate(e.target.value);
              setStartHour(null);
              setError('');
            }}
          />
        </label>

        <div>
          <span className="field-label">Start time</span>
          {loading && !avail ? (
            <div className="skeleton" style={{ height: 120, marginTop: 8 }} />
          ) : avail?.window && !avail.window.open ? (
            <p className="empty-note">{avail.window.reason} Pick another date.</p>
          ) : !visible.some((o) => o.ok && !isCurrent(o.hour)) ? (
            <p className="empty-note">Nothing else fits {hoursText(booking.paidHours)} on this day. Try another date.</p>
          ) : (
            <div className="time-grid" role="radiogroup" aria-label="New start time">
              {visible.map((o) => (
                <button
                  key={o.hour}
                  type="button"
                  role="radio"
                  aria-checked={startHour === o.hour}
                  disabled={!o.ok || isCurrent(o.hour)}
                  className={clsx('time-chip', o.freeHours > 0 && 'has-free')}
                  onClick={() => setStartHour(o.hour)}
                >
                  <span className="time-chip-start tnum">{hourLabel(o.hour)}</span>
                  <span className="time-chip-end tnum">
                    {isCurrent(o.hour)
                      ? 'Your slot'
                      : o.ok
                        ? `until ${hourLabel(o.hour + booking.paidHours + o.freeHours)}`
                        : o.reason === 'closing'
                          ? 'Past closing'
                          : 'Taken'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="notice notice-bad" role="alert">
            <Info /> {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
