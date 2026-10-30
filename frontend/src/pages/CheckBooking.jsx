import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertCircle, CalendarClock, CalendarPlus, Info } from 'lucide-react';
import { RescheduleDialog } from '../components/RescheduleDialog.jsx';
import { api } from '../lib/api.js';
import { BookingTicket } from '../components/BookingTicket.jsx';
import { ConfirmDialog, Field } from '../components/ui.jsx';
import { downloadIcs } from '../lib/ics.js';
import { dateLabel, rangeLabel } from '../lib/format.js';
import { useSite } from '../lib/site-data.jsx';
import { HowToBook, claimTour } from '../components/HowToBook.jsx';

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

  // First visit without a code in the link: show a short animated walkthrough.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (params.get('code')) return;
    const t = setTimeout(() => claimTour('find') && setTourOpen(true), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onTourChange = setTourOpen;

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

  // Animated walkthrough for moving a booking; opens the first time the button is used.
  const [moveTourOpen, setMoveTourOpen] = useState(false);
  const [reschedOpen, setReschedOpen] = useState(false);
  const startResched = () => {
    let seen = true;
    try {
      seen = !!localStorage.getItem('dmg-site-resched-tour-seen');
    } catch {
      /* skip the tour if storage is blocked */
    }
    if (seen) setReschedOpen(true);
    else setMoveTourOpen(true);
  };
  const onMoveTourChange = (open) => {
    setMoveTourOpen(open);
    if (!open) {
      try {
        localStorage.setItem('dmg-site-resched-tour-seen', '1');
      } catch {
        /* not remembered in private mode */
      }
      setReschedOpen(true);
    }
  };

  const cutoff = siteData?.settings.cancel_cutoff_hours;

  return (
    <div className="page wrap narrow">
      <HowToBook variant="find" open={tourOpen} onOpenChange={onTourChange} hideKey="find" />
      <div className="book-title-row">
        <h1 className="page-title">My booking</h1>
        <button type="button" className="day-view-help" onClick={() => setTourOpen(true)}>
          How to find it
        </button>
      </div>
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
            {booking.canCancel && siteData && (
              <button type="button" className="btn btn-outline" onClick={startResched}>
                <CalendarClock /> Change date or time
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
                Changing or cancelling online closes {cutoff} hours before the start time. To change or cancel now, message the studio.
              </span>
            </div>
          )}
          <HowToBook variant="resched" open={moveTourOpen} onOpenChange={onMoveTourChange} />
          {siteData && reschedOpen && (
            <RescheduleDialog
              key={`${booking.date}-${booking.startHour}`}
              open={reschedOpen}
              onOpenChange={setReschedOpen}
              booking={booking}
              phone={phone}
              settings={siteData.settings}
              today={siteData.now.date}
              onMoved={setBooking}
            />
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
