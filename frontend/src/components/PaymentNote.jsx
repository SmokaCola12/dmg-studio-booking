import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { CheckCircle2, Clock, Info, RotateCcw, XCircle } from 'lucide-react';
import { useCountdown } from '../lib/countdown.js';
import { clockText, peso } from '../lib/format.js';

/** The stage the server reports for a new-style GCash booking, or '' when the note doesn't apply. */
export function paymentStage(booking) {
  const p = booking?.payment;
  if (!p || booking.paymentMethod !== 'gcash' || !p.plan) return '';
  return p.stage || p.status || '';
}

/**
 * One short note on where a GCash payment stands. Shown on the ticket, so My booking and
 * the booking page both explain what is happening and what to do next.
 * `onExpire` fires once when the hold countdown runs out, so the page can ask the server again.
 */
export function PaymentNote({ booking, serverTime, onExpire }) {
  const stage = paymentStage(booking);
  const p = booking?.payment;
  const waiting = stage === 'awaiting_proof' && booking.status === 'pending';
  const left = useCountdown(waiting ? p?.holdExpiresAt : null, serverTime);

  const fired = useRef(false);
  useEffect(() => {
    if (waiting && left !== null && left <= 0 && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
  }, [waiting, left, onExpire]);

  if (!stage) return null;
  // A cancelled booking only needs a note when money is involved.
  if (booking.status === 'cancelled' && !['refund_due', 'refunded'].includes(stage)) return null;

  const payLink = `/booking/${booking.code}/pay`;
  let tone = 'info';
  let Icon = Info;
  let title = '';
  let body = null;

  switch (stage) {
    case 'awaiting_proof':
      tone = 'warn';
      Icon = Clock;
      title = 'Upload your GCash receipt';
      body = (
        <>
          {left !== null && left > 0 ? (
            <>
              Your slot is held for <strong className="tnum">{clockText(left)}</strong>. After that it opens up for other bands.{' '}
            </>
          ) : (
            <>Your slot is about to be released if no receipt arrives. </>
          )}
          <Link to={payLink}>Pay now</Link>
        </>
      );
      break;
    case 'proof_submitted':
      Icon = Clock;
      title = 'Receipt sent';
      body = <>The studio will confirm once it sees your payment. Your slot is held until then.</>;
      break;
    case 'not_received':
      tone = 'warn';
      Icon = RotateCcw;
      title = 'Payment not received yet';
      body = (
        <>
          The studio hasn’t received your payment yet. Check the amount and upload a new screenshot. <Link to={payLink}>Upload again</Link>
        </>
      );
      break;
    case 'deposit_received':
      tone = 'ok';
      Icon = CheckCircle2;
      title = `${p.plan === 'half' ? '50% paid' : 'Payment received'}${p.paidAmount ? ` (${peso(p.paidAmount)})` : ''}`;
      body =
        p.balanceDue > 0 ? (
          <>
            Balance of <strong className="tnum">{peso(p.balanceDue)}</strong> is due at the studio.
          </>
        ) : (
          <>Thank you. See you at the studio.</>
        );
      break;
    case 'paid':
      tone = 'ok';
      Icon = CheckCircle2;
      title = 'PAID';
      body = <>Payment complete. See you at the studio.</>;
      break;
    case 'expired':
      tone = 'bad';
      Icon = XCircle;
      title = 'Hold ended';
      body = (
        <>
          Your slot was released because no receipt came in time.{' '}
          {p.canUploadProof ? (
            <>
              Already paid? <Link to={payLink}>Upload your receipt</Link> and the studio will sort it out.
            </>
          ) : (
            <>Message the studio if you already paid.</>
          )}
        </>
      );
      break;
    case 'refund_due':
      tone = 'warn';
      Icon = RotateCcw;
      title = 'Refund due';
      body = <>The studio will contact you about your refund.</>;
      break;
    case 'refunded':
      Icon = Info;
      title = 'Refunded';
      body = <>Your payment was refunded by the studio.</>;
      break;
    default:
      return null;
  }

  return (
    <div className={clsx('pay-note', `pay-note-${tone}`, `pay-note-stage-${stage}`)} role="status">
      <Icon aria-hidden="true" />
      <div>
        <p className="pay-note-title">{title}</p>
        <p className="pay-note-body">{body}</p>
      </div>
    </div>
  );
}
