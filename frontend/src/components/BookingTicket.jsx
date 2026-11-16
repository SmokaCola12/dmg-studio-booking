import { toast } from 'sonner';
import { Copy } from 'lucide-react';
import { StatusBadge } from './ui.jsx';
import { bookingEnd, bookingStart, dateLabel, formatPhone, hoursText, paymentLabel, peso, rangeLabel } from '../lib/format.js';
import { PaymentNote, paymentStage } from './PaymentNote.jsx';

export function BookingTicket({ booking, serverTime, onPaymentExpire }) {
  const stage = paymentStage(booking);
  const p = booking.payment;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(booking.code);
      toast.success('Booking code copied');
    } catch {
      toast(`Your booking code is ${booking.code}`);
    }
  };

  return (
    <div className="ticket" style={{ '--room': booking.room?.color }}>
      <div className="ticket-top">
        <div>
          <span className="ticket-code-label">Booking code</span>
          <span className="ticket-code">{booking.code}</span>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={copy}>
          <Copy /> Copy code
        </button>
      </div>
      <div className="ticket-body">
        <dl className="review-list">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={booking.status} />
            </dd>
          </div>
          <div>
            <dt>Studio</dt>
            <dd>{booking.room?.name}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{dateLabel(booking.date, { long: true, year: true })}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd className="tnum">
              {rangeLabel(bookingStart(booking), bookingEnd(booking))}
              {booking.freeHours > 0 && ` (${hoursText(booking.freeHours)} free)`}
            </dd>
          </div>
          <div>
            <dt>Booked by</dt>
            <dd className="break">
              {booking.name}
              {booking.bandName && `, ${booking.bandName}`}
            </dd>
          </div>
          <div>
            <dt>Mobile</dt>
            <dd className="tnum">{formatPhone(booking.phone)}</dd>
          </div>
          <div>
            <dt>Payment</dt>
            <dd>
              {paymentLabel(booking)}
              {stage && p.amountDue > 0 && <span className="tnum">{` · ${peso(p.amountDue)} online`}</span>}
              {stage === 'paid' && <strong className="paid-mark"> PAID</strong>}
              {!stage && booking.paymentRef && `, ref ${booking.paymentRef}`}
            </dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd className="tnum">{peso(booking.total)}</dd>
          </div>
        </dl>
        <PaymentNote booking={booking} serverTime={serverTime} onExpire={onPaymentExpire} />
      </div>
    </div>
  );
}
