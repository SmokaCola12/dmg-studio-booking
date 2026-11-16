import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import clsx from 'clsx';
import { adminApi } from '../../lib/api.js';
import { ConfirmDialog, Dialog, Field } from '../../components/ui.jsx';
import { bookingEnd, bookingStart, dateLabel, formatPhone, instantLabel, PLAN_LABELS, peso, rangeLabel } from '../../lib/format.js';
import { LoadError, PageHead, useAdmin, useLoader } from './admin-shared.jsx';
import { BalanceActions, PaymentStageBadge, ProofLightbox, ProofThumb, ReceiptCheck, balanceOpen, paymentErrorText, stageOf } from './payment-shared.jsx';

const FILTERS = [
  ['proof_submitted', 'To check'],
  ['not_received', 'Not received'],
  ['awaiting_proof', 'Waiting for screenshot'],
  ['received', 'Confirmed'],
  ['balance', 'Balance due'],
  ['refunds', 'Refunds'],
  ['expired', 'Expired'],
  ['older', 'Older'],
  ['all', 'All'],
];

const PAGE = 30;

const EVENT_LABELS = {
  created: 'Booked with GCash',
  proof_uploaded: 'Screenshot uploaded',
  released: 'Customer released the slot',
  hold_expired: 'Hold expired',
  revived: 'Booking restored after a late receipt',
  confirmed_received: 'Confirmed as received',
  marked_not_received: 'Marked not received',
  balance_collected: 'Balance recorded',
  refund_due: 'Refund due',
  refunded: 'Refund recorded',
  cancelled: 'Cancelled',
  rescheduled: 'Rescheduled',
  email_sent: 'Email sent',
  email_failed: 'Email could not be sent',
};

// A booking where a refund can be recorded (paid and cancelled or expired, or a refund is due).
const refundable = (b) => Boolean(b.payment?.canRefund) || stageOf(b) === 'refund_due';

// "Refunds" has no filter of its own on the server: load everything (one big page) and keep the refundable ones here,
// so a customer who paid and then cancelled can't disappear from staff view.
const REFUND_SCAN = 200;

const queryFor = (filter, limit) => {
  if (filter === 'refunds') return { limit: REFUND_SCAN };
  const q = { limit };
  if (filter === 'balance') q.balance = 'due';
  else if (filter !== 'all') q.status = filter;
  return q;
};

export default function GcashPayments() {
  const { version, changed } = useAdmin();
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') || 'proof_submitted';
  const [limit, setLimit] = useState(PAGE);
  const [proof, setProof] = useState(null);

  const list = useLoader(() => adminApi.payments(queryFor(filter, limit)), [filter, limit, version]);
  const data = list.data;
  const shown = data ? (filter === 'refunds' ? data.bookings.filter(refundable) : data.bookings) : [];
  const hasMore = Boolean(data) && filter !== 'refunds' && data.total > data.bookings.length;

  const setFilter = (v) => {
    const next = new URLSearchParams(params);
    if (v === 'proof_submitted') next.delete('filter');
    else next.set('filter', v);
    setParams(next, { replace: true });
    setLimit(PAGE);
  };

  const refresh = () => {
    changed();
    list.reload(true);
  };

  return (
    <div className="a-page">
      <PageHead
        title="GCash payments"
        sub={data ? `${data.waitingCount ?? 0} ${data.waitingCount === 1 ? 'receipt' : 'receipts'} waiting to be checked` : ' '}
      />

      <div className="chips" role="group" aria-label="Show">
        {FILTERS.map(([v, label]) => (
          <button key={v} type="button" className="chip" aria-pressed={filter === v} onClick={() => setFilter(v)}>
            {label}
          </button>
        ))}
      </div>

      {list.error && !data && <LoadError error={list.error} onRetry={list.reload} />}

      {!data && !list.error && (
        <div className="b-list-skeleton">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 120 }} />
          ))}
        </div>
      )}

      {data && shown.length === 0 && (
        <p className="a-empty">
          {filter === 'proof_submitted'
            ? 'Nothing to check right now. New receipts show up here as soon as customers upload them.'
            : filter === 'refunds'
              ? 'No refunds to record.'
              : 'No GCash bookings match this filter.'}
        </p>
      )}

      {data && shown.length > 0 && (
        <>
          <ul className={clsx('gp-list', list.loading && 'is-refreshing')}>
            {shown.map((b) => (
              <PaymentCard key={b.id} b={b} onOpenProof={setProof} onChanged={refresh} />
            ))}
          </ul>
          {hasMore && (
            <div className="more">
              <button type="button" className="btn btn-outline" onClick={() => setLimit((l) => l + PAGE)} disabled={list.loading}>
                Show more ({data.total - data.bookings.length} left)
              </button>
            </div>
          )}
        </>
      )}

      <ProofLightbox proof={proof} onOpenChange={(o) => !o && setProof(null)} />
    </div>
  );
}

function PaymentCard({ b, onOpenProof, onChanged }) {
  const p = b.payment;
  const stage = stageOf(b);
  const legacy = !p?.plan; // an older manual GCash booking: read-only
  const [dialog, setDialog] = useState(null); // 'confirm' | 'not_received' | 'refund'
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [refund, setRefund] = useState({ amount: '', method: 'gcash' });

  const canConfirm = !legacy && ['awaiting_proof', 'proof_submitted', 'not_received', 'expired'].includes(stage);
  const canNotReceived = !legacy && stage === 'proof_submitted';
  const canRefund = !legacy && refundable(b);
  const who = b.bandName || b.name;

  const close = () => {
    setDialog(null);
    setNote('');
  };

  const run = async (fn, message) => {
    setBusy(true);
    try {
      await fn();
      toast.success(message);
      close();
      onChanged();
    } catch (err) {
      toast.error(paymentErrorText(err));
      if (err.status === 409) onChanged();
    } finally {
      setBusy(false);
    }
  };

  const openRefund = () => {
    const paid = (p.paidAmount || 0) + (p.balancePaid || 0);
    setRefund({ amount: paid > 0 ? String(paid) : '', method: 'gcash' }); // no money recorded yet: staff type what they sent back
    setDialog('refund');
  };

  return (
    <li className="gp-card" style={{ '--room': b.roomColor }}>
      <div className="gp-head">
        <div className="gp-who">
          <span className="gp-name">{who}</span>
          <span className="gp-meta">
            {b.code} · {b.roomName}, {dateLabel(b.date)} {rangeLabel(bookingStart(b), bookingEnd(b))}
          </span>
          <span className="gp-meta">
            {b.name}
            {b.phone ? `, ${formatPhone(b.phone)}` : ''}
            {b.email ? `, ${b.email}` : ' · no email, they see updates in My booking'}
          </span>
        </div>
        <div className="gp-status">
          {!legacy && <PaymentStageBadge stage={stage} plan={p.plan} />}
          <span className="gp-total tnum">{peso(b.total)}</span>
        </div>
      </div>

      {legacy ? (
        <p className="gp-meta">Older manual GCash booking{b.paymentRef ? `, ref ${b.paymentRef}` : ''}. Check it in the booking.</p>
      ) : (
        <>
          <div className="gp-chips">
            <span className="gp-chip">
              {PLAN_LABELS[p.plan]} plan · <strong className="tnum">{peso(p.amountDue)}</strong> online
            </span>
            {p.paidAmount > 0 && (
              <span className="gp-chip">
                Received <strong className="tnum">{peso(p.paidAmount)}</strong>
              </span>
            )}
            {balanceOpen(p) && (
              <span className="gp-chip gp-chip-warn">
                Balance due at studio <strong className="tnum">{peso(p.balanceDue)}</strong>
              </span>
            )}
            {p.balancePaid > 0 && (
              <span className="gp-chip">
                Balance <strong className="tnum">{peso(p.balancePaid)}</strong> paid by {p.balanceMethod === 'gcash' ? 'GCash' : 'cash'}
              </span>
            )}
          </div>

          {b.proofs?.length > 0 ? (
            <div className="gp-proofs">
              {b.proofs.map((pr) => (
                <ProofThumb key={pr.id} proof={pr} onOpen={onOpenProof} />
              ))}
            </div>
          ) : (
            <p className="gp-meta">No screenshot uploaded yet.</p>
          )}

          <ReceiptCheck booking={b} />

          <div className="gp-actions">
            {canConfirm && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog('confirm')} disabled={busy}>
                Received &amp; Confirmed
              </button>
            )}
            {canNotReceived && (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setDialog('not_received')} disabled={busy}>
                Not yet received
              </button>
            )}
            {canRefund && (
              <button type="button" className="btn btn-outline btn-sm" onClick={openRefund} disabled={busy}>
                Refund recorded
              </button>
            )}
          </div>

          <BalanceActions booking={b} onDone={onChanged} />
        </>
      )}

      <div className="gp-foot">
        <Link className="gp-link" to={`/admin/bookings?q=${encodeURIComponent(b.code)}&when=all`}>
          Open in Bookings
        </Link>
        {b.events?.length > 0 && (
          <details className="gp-events">
            <summary>History ({b.events.length})</summary>
            <ol>
              {b.events.map((ev, i) => (
                <li key={ev.id ?? i}>
                  <span className="gp-ev-when tnum">{instantLabel(ev.at)}</span>
                  <span>
                    {EVENT_LABELS[ev.action] || ev.action}
                    {ev.amount ? ` · ${peso(ev.amount)}` : ''}
                    {ev.method ? ` · ${ev.method}` : ''}
                    {ev.staffName ? ` · ${ev.staffName}` : ev.actor === 'staff' ? ' · staff' : ev.actor === 'system' ? ' · automatic' : ''}
                    {ev.note ? ` · “${ev.note}”` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>

      <ConfirmDialog
        open={dialog === 'confirm'}
        onOpenChange={(o) => !o && close()}
        title={`Confirm ${peso(p?.amountDue)} received?`}
        description={`${who}, ${b.roomName}, ${dateLabel(b.date)} ${rangeLabel(bookingStart(b), bookingEnd(b))}. Check the GCash app first. The booking becomes confirmed and the payment is marked received${b.email ? ', and they get an email' : ''}.${stage === 'expired' ? ' The hold had ended, so the time is checked again and may no longer be free.' : ''}`}
        confirmLabel={busy ? 'Confirming…' : 'Received & Confirmed'}
        cancelLabel="Go back"
        busy={busy}
        onConfirm={() => run(() => adminApi.confirmPayment(b.id), 'Payment confirmed')}
      />

      <Dialog
        open={dialog === 'not_received'}
        onOpenChange={(o) => !o && close()}
        title="Payment not received yet?"
        description="The booking stays pending and the customer is told you haven’t seen the payment. They can upload a new screenshot."
        footer={
          <>
            <button type="button" className="btn btn-outline" onClick={close} disabled={busy}>
              Go back
            </button>
            <button type="button" className="btn btn-dark" disabled={busy} onClick={() => run(() => adminApi.paymentNotReceived(b.id, { note: note.trim() }), 'Marked as not received')}>
              {busy ? 'Saving…' : 'Not yet received'}
            </button>
          </>
        }
      >
        <Field label="Note" optional hint="Only staff see this.">
          {(f) => <input {...f} className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />}
        </Field>
      </Dialog>

      <Dialog
        open={dialog === 'refund'}
        onOpenChange={(o) => !o && close()}
        title="Record the refund"
        description="Do this after you have sent the money back yourself. It closes the refund in the audit trail."
        footer={
          <>
            <button type="button" className="btn btn-outline" onClick={close} disabled={busy}>
              Go back
            </button>
            <button
              type="button"
              className="btn btn-dark"
              disabled={busy || !(Number(refund.amount) > 0)}
              onClick={() => run(() => adminApi.recordRefund(b.id, { amount: Number(refund.amount), method: refund.method, note: note.trim() }), 'Refund recorded')}
            >
              {busy ? 'Saving…' : 'Refund recorded'}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Amount refunded">
            {(f) => <input {...f} className="input tnum" type="number" inputMode="numeric" min={1} value={refund.amount} onChange={(e) => setRefund((r) => ({ ...r, amount: e.target.value }))} />}
          </Field>
          <Field label="Sent by">
            {(f) => (
              <select {...f} className="select" value={refund.method} onChange={(e) => setRefund((r) => ({ ...r, method: e.target.value }))}>
                <option value="gcash">GCash</option>
                <option value="cash">Cash</option>
              </select>
            )}
          </Field>
          <Field label="Note" optional className="span-2">
            {(f) => <input {...f} className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />}
          </Field>
        </div>
      </Dialog>
    </li>
  );
}
