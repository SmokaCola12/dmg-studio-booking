import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { CalendarPlus, MessageCircle } from 'lucide-react';
import { BookingTicket } from '../components/BookingTicket.jsx';
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

  // Refresh the status in the background (the studio may have confirmed it already).
  useEffect(() => {
    if (!initial?.phone) return;
    api
      .lookupBooking(code, initial.phone)
      .then((r) => setBooking(r.booking))
      .catch(() => {});
  }, [code, initial?.phone]);

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
  return (
    <div className="page wrap narrow">
      <h1 className="page-title">{pending ? 'Booking sent to the studio' : 'You’re booked'}</h1>
      <p className="page-lead">
        {pending
          ? 'The studio will confirm it soon. Save your booking code: you’ll need it with your mobile number to check the status or cancel.'
          : 'See you at the studio. Save your booking code: you’ll need it with your mobile number to check or cancel.'}
      </p>

      <BookingTicket booking={booking} />

      <div className="done-actions">
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
