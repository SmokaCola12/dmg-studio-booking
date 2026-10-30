import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertCircle, CalendarPlus, Info } from 'lucide-react';
import { api } from '../lib/api.js';
import { BookingTicket } from '../components/BookingTicket.jsx';
import { ConfirmDialog, Field } from '../components/ui.jsx';
import { downloadIcs } from '../lib/ics.js';
import { dateLabel, rangeLabel } from '../lib/format.js';
import { useSite } from '../lib/site-data.jsx';

export default function CheckBooking() {
  const [params] = useSearchParams();
  const { data: siteData } = useSite();
  const [code, setCode] = useState(params.get('code') || '');
  const [phone, setPhone] = useState('');
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const lookup = async (e) => {
    e.preventDefault();
    if (!code.trim() || !phone.trim()) {
      setError('Enter both your booking code and the mobile number you booked with.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await api.lookupBooking(code.trim(), phone);
      setBooking(r.booking);
    } catch (err) {
      setBooking(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const cancel = async () => {
    setCancelling(true);
    try {
      const r = await api.cancelBooking(booking.code, phone);
      setBooking(r.booking);
      setConfirmOpen(false);
      toast.success('Booking cancelled');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCancelling(false);
    }
  };

  const cutoff = siteData?.settings.cancel_cutoff_hours;

  return (
    <div className="page wrap narrow">
      <h1 className="page-title">My booking</h1>
      <p className="page-lead">Use the code you got when you booked, plus the mobile number you booked with.</p>

      <form className="lookup-form" onSubmit={lookup} noValidate>
        <Field label="Booking code">
          {(p) => (
            <input
              {...p}
              className="input code-input"
              placeholder="BK-XXXXXX"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              enterKeyHint="next"
            />
          )}
        </Field>
        <Field label="Mobile number">
          {(p) => (
            <input
              {...p}
              className="input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0917 123 4567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              enterKeyHint="search"
            />
          )}
        </Field>
        <button type="submit" className="btn btn-dark" disabled={loading} style={{ minHeight: 46 }}>
          {loading ? 'Looking…' : 'Find booking'}
        </button>
      </form>

      {error && (
        <div className="notice notice-bad" style={{ marginTop: 16 }} role="alert">
          <AlertCircle /> {error}
        </div>
      )}

      {booking && (
        <>
          <BookingTicket booking={booking} />
          <div className="done-actions">
            {['pending', 'confirmed'].includes(booking.status) && (
              <button type="button" className="btn btn-dark" onClick={() => downloadIcs(booking)}>
                <CalendarPlus /> Add to calendar
              </button>
            )}
            {booking.canCancel && (
              <button type="button" className="btn btn-outline" onClick={() => setConfirmOpen(true)}>
                Cancel this booking
              </button>
            )}
          </div>
          {['pending', 'confirmed'].includes(booking.status) && !booking.canCancel && cutoff !== undefined && (
            <div className="notice" style={{ marginTop: 16 }}>
              <Info />
              <span>
                Online cancellation closes {cutoff} hours before the start time. To change or cancel now, message the studio.
              </span>
            </div>
          )}
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Cancel this booking?"
            description={`${booking.room?.name}, ${dateLabel(booking.date)}, ${rangeLabel(booking.startHour, booking.endHour)}. The slot opens up for other bands right away.`}
            confirmLabel={cancelling ? 'Cancelling…' : 'Cancel booking'}
            onConfirm={cancel}
            busy={cancelling}
            danger
          />
        </>
      )}
    </div>
  );
}
