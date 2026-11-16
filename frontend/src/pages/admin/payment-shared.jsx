import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import clsx from 'clsx';
import { ImagePlus } from 'lucide-react';
import { adminApi } from '../../lib/api.js';
import { ConfirmDialog, Dialog, Field } from '../../components/ui.jsx';
import { instantLabel, PAYMENT_STAGE_LABELS, PLAN_LABELS, peso, sizeText } from '../../lib/format.js';

export const MAX_PROOF_BYTES = 15 * 1024 * 1024;
export const PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** The stage the server reports for a booking's payment. */
export const stageOf = (b) => b?.payment?.stage || b?.payment?.status || '';

/** A new-style GCash booking whose deposit hasn't been confirmed yet: it can only be confirmed from GCash payments. */
export const needsPaymentCheck = (b) => Boolean(b?.payment?.plan) && b.payment.status !== 'received';

/** Where "Check the payment" goes: the GCash payments page, on the filter that lists this booking. */
export function gcashLink(b) {
  const stage = stageOf(b);
  const filter = { awaiting_proof: 'awaiting_proof', not_received: 'not_received', expired: 'expired', cancelled: 'all', refund_due: 'refunds' }[stage];
  return filter ? `/admin/gcash?filter=${filter}` : '/admin/gcash';
}

/** Money still to collect on a 50% booking: the deposit is in, something is left (also a top-up after the total went up). */
export const balanceOpen = (p) =>
  Boolean(p) && p.plan === 'half' && p.status === 'received' && p.balanceDue > 0 && !['refund_due', 'refunded', 'cancelled', 'expired'].includes(p.stage);

export function PaymentStageBadge({ stage, plan }) {
  if (!stage) return null;
  const label = stage === 'deposit_received' && plan ? `${PLAN_LABELS[plan]} paid` : PAYMENT_STAGE_LABELS[stage] || stage;
  return <span className={clsx('badge', 'pay-badge', `pay-badge-${stage}`)}>{label}</span>;
}

/**
 * What the customer's browser read off the screenshot (payment.receiptCheck), next to what the booking expects.
 * Hints for staff only: a screenshot can be edited, so the payment is still checked in GCash. Older rows have none.
 */
export function ReceiptCheck({ booking }) {
  const rc = booking?.payment?.receiptCheck;
  if (!rc) return null;
  const dupes = Array.isArray(rc.duplicateRef) ? rc.duplicateRef : [];
  const hasAmount = rc.ocrAmount !== null && rc.ocrAmount !== undefined && rc.ocrAmount !== '';
  if (!rc.ocrRef && !hasAmount && dupes.length === 0) return null;
  return (
    <div className="gp-check">
      <p className="gp-check-title">Receipt check · read from the screenshot, check it against GCash</p>
      <div className="gp-chips">
        {hasAmount ? (
          rc.amountMatches === false ? (
            <span className="gp-chip gp-chip-warn">
              Amount differs: receipt shows <strong className="tnum">{peso(Number(rc.ocrAmount))}</strong>
            </span>
          ) : (
            <span className="gp-chip">
              Receipt shows <strong className="tnum">{peso(Number(rc.ocrAmount))}</strong>
              {rc.amountMatches === true && ' · amount matches'}
            </span>
          )
        ) : (
          <span className="gp-chip">Amount not read</span>
        )}
        {rc.ocrRef ? (
          <span className={clsx('gp-chip', rc.refMatchesOcr === false && 'gp-chip-warn')}>
            Ref on receipt <strong className="tnum">{rc.ocrRef}</strong>
            {rc.refMatchesOcr === false && ' · differs from what they typed'}
          </span>
        ) : (
          <span className="gp-chip">Reference not read</span>
        )}
        {dupes.map((d) => (
          <Link key={d.id ?? d.code} className="gp-chip gp-chip-warn gp-chip-link" to={`/admin/bookings?q=${encodeURIComponent(d.code)}&when=all`}>
            Reference already used on booking <strong>{d.code}</strong>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Loads one private screenshot with the admin token. The object URL is released when it goes away. */
export function useProofImage(proofId) {
  const [state, setState] = useState({ url: '', error: false });
  useEffect(() => {
    let live = true;
    let created = '';
    setState({ url: '', error: false });
    adminApi
      .proofImageUrl(proofId)
      .then((url) => {
        created = url;
        if (live) setState({ url, error: false });
        else URL.revokeObjectURL(url);
      })
      .catch(() => live && setState({ url: '', error: true }));
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [proofId]);
  return state;
}

/** A small screenshot you can tap to enlarge. */
export function ProofThumb({ proof, onOpen }) {
  const { url, error } = useProofImage(proof.id);
  return (
    <button type="button" className="gp-thumb" onClick={() => url && onOpen(proof)} disabled={!url} aria-label={`Open ${proof.kind === 'balance' ? 'balance' : 'deposit'} screenshot`}>
      {url ? <img src={url} alt="" /> : <span className="gp-thumb-empty">{error ? 'Missing' : '…'}</span>}
      <span className="gp-thumb-label">
        {proof.kind === 'balance' ? 'Balance' : 'Deposit'}
        {proof.uploadedAt && <small>{instantLabel(proof.uploadedAt)}</small>}
        {proof.duplicateOf && <small className="gp-dup">Same image as another booking</small>}
        {(proof.ocrRef || proof.ocrAmount) && (
          <small className="tnum">
            Read: {[proof.ocrAmount ? peso(Number(proof.ocrAmount)) : '', proof.ocrRef ? `ref ${proof.ocrRef}` : ''].filter(Boolean).join(' · ')}
          </small>
        )}
      </span>
    </button>
  );
}

export function ProofLightbox({ proof, onOpenChange }) {
  const { url } = useProofImage(proof?.id);
  return (
    <Dialog
      open={Boolean(proof)}
      onOpenChange={onOpenChange}
      title={proof?.kind === 'balance' ? 'Balance screenshot' : 'Deposit screenshot'}
      description={proof?.uploadedAt ? `Uploaded ${instantLabel(proof.uploadedAt)}` : undefined}
      wide
    >
      {url ? <img className="lightbox-img" src={url} alt="GCash receipt screenshot" /> : <div className="skeleton" style={{ height: 240 }} />}
    </Dialog>
  );
}

/** A screenshot picker with a preview. Staff must choose one for a GCash balance. */
export function ProofPicker({ file, onFile }) {
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const input = useRef(null);

  useEffect(() => {
    if (!file) {
      setPreview('');
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!PROOF_TYPES.includes(f.type)) {
      setError('Use a JPEG, PNG or WebP screenshot.');
      onFile(null);
      return;
    }
    if (f.size > MAX_PROOF_BYTES) {
      setError(`That file is ${sizeText(f.size)}. The most we can take is ${sizeText(MAX_PROOF_BYTES)}.`);
      onFile(null);
      return;
    }
    setError('');
    onFile(f);
  };

  return (
    <div className="uploader">
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="proof-picker" onChange={pick} />
      <label htmlFor="proof-picker" className={clsx('upload-drop', file && 'has-file')}>
        {file ? (
          <>
            <img className="upload-preview" src={preview} alt="Screenshot to save" />
            <span className="upload-name">
              {file.name} <span className="muted tnum">({sizeText(file.size)})</span>
            </span>
            <span className="upload-change">Choose a different file</span>
          </>
        ) : (
          <>
            <ImagePlus aria-hidden="true" />
            <span className="upload-cta">Choose the GCash screenshot</span>
            <span className="upload-hint">JPEG, PNG or WebP, up to {sizeText(MAX_PROOF_BYTES)}</span>
          </>
        )}
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Copy for the errors staff can hit on a payment action. */
export function paymentErrorText(err) {
  if (err.code === 'slot_taken') {
    return 'That time was taken by another booking after the hold ended, so it can’t be confirmed. Move this booking to another time in Bookings, or record a refund.';
  }
  return err.message;
}

/**
 * The two ways to record the other half of a 50% booking. Cash needs no file; GCash needs a screenshot.
 * Recording it makes the booking PAID. `onDone(booking)` gets the updated booking from the server.
 */
export function BalanceActions({ booking, onDone }) {
  const p = booking.payment;
  const [dialog, setDialog] = useState(null); // 'cash' | 'gcash'
  const [file, setFile] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (!balanceOpen(p)) return null;
  const who = booking.bandName || booking.name;
  // A balance was already recorded once and the total went up since: this is the extra amount.
  const topUp = p.balancePaid > 0;

  const close = () => {
    setDialog(null);
    setFile(null);
    setNote('');
  };

  const save = async (method) => {
    setBusy(true);
    try {
      const r = await adminApi.balancePayment(booking.id, { method, file, amount: p.balanceDue, note: note.trim() });
      toast.success('Recorded. The booking is now PAID.');
      close();
      onDone?.(r.booking || null);
    } catch (err) {
      toast.error(paymentErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="gp-balance">
        <p className="gp-balance-due">
          Balance due at the studio: <strong className="tnum">{peso(p.balanceDue)}</strong>
        </p>
        <div className="gp-balance-buttons">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setDialog('cash')}>
            {topUp ? `${peso(p.balanceDue)} paid at the studio (cash)` : '50% paid at the studio (cash)'}
          </button>
          <button type="button" className="btn btn-dark btn-sm" onClick={() => setDialog('gcash')}>
            {topUp ? `${peso(p.balanceDue)} paid in GCash` : '50% paid in GCash'}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={dialog === 'cash'}
        onOpenChange={(o) => !o && close()}
        title="Record cash for the balance?"
        description={`${who} paid ${peso(p.balanceDue)} in cash at the studio. The booking will show PAID. This is kept in the audit trail.`}
        confirmLabel={busy ? 'Saving…' : 'Yes, paid in cash'}
        cancelLabel="Go back"
        busy={busy}
        onConfirm={() => save('cash')}
      />

      <Dialog
        open={dialog === 'gcash'}
        onOpenChange={(o) => !o && close()}
        title="Balance paid in GCash"
        description={`${who} paid ${peso(p.balanceDue)} in GCash. Add a screenshot of that payment; the booking will then show PAID.`}
        footer={
          <>
            <button type="button" className="btn btn-outline" onClick={close} disabled={busy}>
              Go back
            </button>
            <button type="button" className="btn btn-dark" onClick={() => save('gcash')} disabled={!file || busy}>
              {busy ? 'Saving…' : 'Save as PAID'}
            </button>
          </>
        }
      >
        <ProofPicker file={file} onFile={setFile} />
        <Field label="Note" optional hint="Only staff see this." className="gp-note-field">
          {(f) => <input {...f} className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />}
        </Field>
      </Dialog>
    </>
  );
}
