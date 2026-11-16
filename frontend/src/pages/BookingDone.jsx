import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { CalendarPlus, MessageCircle, QrCode } from 'lucide-react';
import { BookingTicket } from '../components/BookingTicket.jsx';
import { paymentStage } from '../components/PaymentNote.jsx';
import { downloadIcs } from '../lib/ics.js';
import { useStudioInfo } from '../lib/site-data.jsx';
import { api } from '../lib/api.js';

function fromSession(code) {
  try {
    const saved = JSON.parse(sessionStorage.getItem('last_booking') || 'null');
    return saved?.booking?.code === code ? saved : null;
  } catch {
    return null;
  }
}

export default function BookingDone() {
  const info = useStudioInfo();
  const { code } = useParams();
  const { state } = useLocation();
  const initial = state?.booking?.code === code ? state : fromSession(code);
  const [booking, setBooking] = useState(initial?.booking || null);
  const [serverTime, setServerTime] = useState(initial?.serverTime || null);

  // Refresh the status in the background (the studio may have confirmed it already).
  const refresh = useCallback(() => {
    if (!initial?.phone) return;
    api
      .lookupBooking(code, initial.phone)
      .then((r) => {
        setBooking(r.booking);
        setServerTime(r.serverTime || null);
      })
      .catch(() => {});
  }, [code, initial?.phone]);
  useEffect(refresh, [refresh]);

  if (!booking) {
    return (
      <div className="page wrap narrow">
        <h1 className="page-title">Check your booking</h1>
        <p className="page-lead">Enter your mobile number to see booking {code}.</p>
        <p style={{ marginTop: 20 }}>
          <Link className="btn btn-dark" to={`/check?code=${encodeURIComponent(code)}`}>
            Look up this booking
          </Link>
        </p>
      </div>
    );
  }

  const pending = booking.status === 'pending';
  const stage = paymentStage(booking);
  const needsPayment = pending && ['awaiting_proof', 'not_received'].includes(stage);
  return (
    <div className="page wrap narrow">
      <h1 className="page-title">{needsPayment ? 'Finish your payment' : pending ? 'Booking sent to the studio' : 'You’re booked'}</h1>
      <p className="page-lead">
        {needsPayment
          ? 'Your slot is held while you pay. Upload your GCash receipt to keep it.'
          : pending
            ? 'The studio will confirm it soon. Save your booking code: you’ll need it with your mobile number to check the status or cancel.'
            : 'See you at the studio. Save your booking code: you’ll need it with your mobile number to check or cancel.'}
      </p>

      <BookingTicket booking={booking} serverTime={serverTime} onPaymentExpire={refresh} />

      <div className="done-actions">
        {needsPayment && (
          <Link className="btn btn-primary" to={`/booking/${booking.code}/pay`} state={{ booking, phone: initial?.phone, serverTime }}>
            <QrCode /> Pay with GCash
          </Link>
        )}
        <button type="button" className="btn btn-dark" onClick={() => downloadIcs(booking, info.address)}>
          <CalendarPlus /> Add to calendar
        </button>
        <a className="btn btn-outline" href={info.messenger} target="_blank" rel="noreferrer">
          <MessageCircle /> Message the studio
        </a>
        <Link className="btn btn-ghost" to="/">
          Back to the home page
        </Link>
      </div>
    </div>
  );
}
