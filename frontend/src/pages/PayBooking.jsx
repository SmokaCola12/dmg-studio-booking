import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import clsx from 'clsx';
import { AlertCircle, Download, ImagePlus, Info, MessageCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCountdown } from '../lib/countdown.js';
import { useSite, useStudioInfo } from '../lib/site-data.jsx';
import { bookingEnd, bookingStart, clockText, dateLabel, peso, rangeLabel, sizeText } from '../lib/format.js';
import { ConfirmDialog, Field } from '../components/ui.jsx';
import { PaymentNote, paymentStage } from '../components/PaymentNote.jsx';

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 3;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function fromSession(code) {
  try {
    const saved = JSON.parse(sessionStorage.getItem('last_booking') || 'null');
    return saved?.booking?.code === code ? saved : null;
  } catch {
    return null;
  }
}

const svgUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Draws the QR onto a white canvas and saves it as a PNG, so it can be uploaded from the gallery in GCash. */
function saveQrPng(svg, name) {
  const img = new Image();
  img.onload = () => {
    const size = 900;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    canvas.toBlob((blob) => {
      if (!blob) {
        toast.error('Couldn’t save the QR. Take a screenshot of it instead.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  };
  img.onerror = () => toast.error('Couldn’t save the QR. Take a screenshot of it instead.');
  img.src = svgUri(svg);
}

export default function PayBooking() {
  const { code } = useParams();
  const { state } = useLocation();
  const { data: siteData } = useSite();
  const info = useStudioInfo();
  const initial = state?.booking?.code === code ? state : fromSession(code);

  const [phone, setPhone] = useState(initial?.phone || '');
  const [booking, setBooking] = useState(initial?.booking || null);
  const [serverTime, setServerTime] = useState(initial?.serverTime || null);
  const [lookupError, setLookupError] = useState('');
  const [looking, setLooking] = useState(false);

  const load = useCallback(
    async (p) => {
      const r = await api.lookupBooking(code, p);
      setBooking(r.booking);
      setServerTime(r.serverTime || null);
      return r.booking;
    },
    [code]
  );

  // Refresh once on arrival, so a booking from a stale tab shows what is true now.
  useEffect(() => {
    if (initial?.phone) load(initial.phone).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const lookup = async (e) => {
    e.preventDefault();
    if (!phone.trim()) {
      setLookupError('Enter the mobile number you booked with.');
      return;
    }
    setLooking(true);
    setLookupError('');
    try {
      await load(phone);
    } catch (err) {
      setLookupError(err.message);
    } finally {
      setLooking(false);
    }
  };

  if (!booking) {
    return (
      <div className="page wrap narrow">
        <h1 className="page-title">Pay with GCash</h1>
        <p className="page-lead">Enter the mobile number you booked with to see the payment for {code}.</p>
        <form className="lookup-form" onSubmit={lookup} noValidate>
          <Field label="Mobile number" error={lookupError}>
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
              />
            )}
          </Field>
          <button type="submit" className="btn btn-dark" disabled={looking} style={{ minHeight: 46 }}>
            {looking ? 'Looking…' : 'Continue'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <PayView
      booking={booking}
      phone={phone}
      serverTime={serverTime}
      holdMinutes={siteData?.settings?.gcash_hold_minutes || 30}
      messenger={info.messenger}
      onBooking={(b, st) => {
        setBooking(b);
        if (st) setServerTime(st);
      }}
      reload={() => load(phone)}
    />
  );
}

function PayView({ booking, phone, serverTime, holdMinutes, messenger, onBooking, reload }) {
  const stage = paymentStage(booking);
  const p = booking.payment;
  const canPay = booking.status === 'pending' && ['awaiting_proof', 'not_received'].includes(stage);
  const canLateUpload = stage === 'expired' && p?.canUploadProof;

  // The QR with this booking's exact amount. Only fetched while there is something to pay.
  const [qr, setQr] = useState(null);
  const [qrError, setQrError] = useState('');
  useEffect(() => {
    if (!canPay) return undefined;
    let live = true;
    setQrError('');
    api
      .paymentQr(booking.code, phone)
      .then((r) => live && setQr(r))
      .catch((err) => live && setQrError(err.status === 503 ? 'The GCash QR isn’t available right now. Message the studio to pay.' : err.message));
    return () => {
      live = false;
    };
  }, [canPay, booking.code, phone]);

  // Keep the page honest: when the hold runs out, or while waiting for the studio, ask the server again.
  const left = useCountdown(stage === 'awaiting_proof' ? p?.holdExpiresAt : null, serverTime);
  const asked = useRef(false);
  useEffect(() => {
    if (left !== null && left <= 0 && !asked.current) {
      asked.current = true;
      reload().catch(() => {});
    }
    if (left !== null && left > 0) asked.current = false;
  }, [left, reload]);
  useEffect(() => {
    if (stage !== 'proof_submitted') return undefined;
    const t = setInterval(() => document.visibilityState === 'visible' && reload().catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [stage, reload]);

  // Upload
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [ref, setRef] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [sent, setSent] = useState(false);
  const [addMore, setAddMore] = useState(false); // after the first receipt: "Add another screenshot"
  const fileInput = useRef(null);

  useEffect(() => {
    if (!file) {
      setPreview('');
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Read the reference number and amount off the screenshot, in this browser (the picture is not sent anywhere
  // for this). It only fills the field and shows what it found; it never blocks Proceed.
  // The text parser and tesseract load only here, on demand (receipt-reader.js), never with the page.
  const [ocr, setOcr] = useState({ status: 'idle', ref: '', amount: null, amountText: '' }); // idle | reading | done | failed
  const lastOcrRef = useRef(''); // the reference the last read put in the field
  useEffect(() => {
    // A new screenshot (or none): what the previous one put in the field goes, unless the customer changed it.
    const previous = lastOcrRef.current;
    lastOcrRef.current = '';
    if (previous) setRef((cur) => (cur === previous ? '' : cur));

    if (!file) {
      setOcr({ status: 'idle', ref: '', amount: null, amountText: '' });
      return undefined;
    }
    // Aborting stops the read and its worker when another file is picked or the page goes away.
    const stopper = new AbortController();
    setOcr({ status: 'reading', ref: '', amount: null, amountText: '' });
    import('../lib/receipt-reader.js')
      .then((m) => m.readReceipt(file, { signal: stopper.signal }))
      .catch(() => null)
      .then((found) => {
        if (stopper.signal.aborted) return;
        if (!found) {
          setOcr({ status: 'failed', ref: '', amount: null, amountText: '' });
          return;
        }
        setOcr({ status: 'done', ref: found.ref, amount: found.amount, amountText: found.amountText || '' });
        if (found.ref) {
          // Only fill an empty field. Never replace what the customer typed.
          setRef((cur) => (cur.trim() === '' ? found.ref : cur));
          lastOcrRef.current = found.ref;
        }
      });
    return () => stopper.abort();
  }, [file]);

  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!TYPES.includes(f.type)) {
      setFile(null);
      setUploadError('Use a JPEG, PNG or WebP screenshot.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      setUploadError(`That file is ${sizeText(f.size)}. The most we can take is ${sizeText(MAX_BYTES)}.`);
      return;
    }
    setUploadError('');
    setFile(f);
  };

  const proceed = async () => {
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const r = await api.uploadProof(booking.code, phone, file, ref.trim(), { ref: ocr.ref, amount: ocr.amountText });
      onBooking(r.booking, r.serverTime);
      setFile(null);
      setRef('');
      lastOcrRef.current = '';
      setSent(true);
      setAddMore(false);
      toast.success('Receipt sent to the studio');
    } catch (err) {
      setUploadError(err.message);
      if (err.status === 409) reload().catch(() => {});
    } finally {
      setUploading(false);
    }
  };

  // Pay later gives the slot back.
  const [laterOpen, setLaterOpen] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const release = async () => {
    setReleasing(true);
    try {
      const r = await api.releaseBooking(booking.code, phone);
      onBooking(r.booking, r.serverTime);
      setLaterOpen(false);
      toast('Slot released. You haven’t been charged.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setReleasing(false);
    }
  };

  const proofCount = p?.proofCount || 0;
  const full = proofCount >= MAX_FILES;
  const when = `${booking.room?.name || ''}, ${dateLabel(booking.date, { long: true })}, ${rangeLabel(bookingStart(booking), bookingEnd(booking))}`;
  const showUploader = (canPay || canLateUpload) && !full;
  const released = booking.status === 'cancelled' && !['refund_due', 'refunded'].includes(stage);

  return (
    <div className="page wrap pay-page">
      <h1 className="page-title">{canPay ? 'Pay with GCash' : canLateUpload ? 'Already paid?' : 'Your payment'}</h1>
      <p className="page-lead">
        {when}. Booking <span className="tnum">{booking.code}</span>.
      </p>

      {released && (
        <div className="pay-note pay-note-info" role="status">
          <Info aria-hidden="true" />
          <div>
            <p className="pay-note-title">Slot released</p>
            <p className="pay-note-body">
              This booking was cancelled and nothing was charged. <Link to="/book">Book another time</Link>
            </p>
          </div>
        </div>
      )}

      {!released && !canPay && !canLateUpload && (
        <>
          {(sent || stage === 'proof_submitted') && (
            <div className="pay-sent">
              <h2 className="pay-sent-title">Thanks, your receipt is in</h2>
              <p>
                The studio will confirm once it sees your payment. If you gave an email, the update goes there. Otherwise open{' '}
                <Link to={`/check?code=${encodeURIComponent(booking.code)}`}>My booking</Link> and use your code and mobile number.
              </p>
            </div>
          )}
          <PaymentNote booking={booking} serverTime={serverTime} />
          {stage === 'proof_submitted' && p?.canUploadProof && !full &&
            (addMore ? (
              <section className="upload-card" aria-labelledby="more-title" style={{ marginTop: 16 }}>
                <h2 id="more-title" className="block-title">
                  Add another screenshot
                </h2>
                <Uploader
                  file={file}
                  preview={preview}
                  inputRef={fileInput}
                  onPick={pick}
                  error={uploadError}
                  refValue={ref}
                  onRef={setRef}
                  ocr={ocr}
                  amountDue={p?.amountDue}
                  proofCount={proofCount}
                  disabled={uploading}
                />
                <div className="pay-actions">
                  <button type="button" className="btn btn-primary btn-lg" onClick={proceed} disabled={!file || uploading}>
                    {uploading ? 'Sending…' : 'Send screenshot'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost pay-later"
                    onClick={() => {
                      setAddMore(false);
                      setFile(null);
                      setUploadError('');
                    }}
                    disabled={uploading}
                  >
                    Never mind
                  </button>
                </div>
              </section>
            ) : (
              <button type="button" className="btn btn-ghost pay-later" onClick={() => setAddMore(true)}>
                Add another screenshot
              </button>
            ))}
        </>
      )}

      {canPay && (
        <div className="pay-grid">
          <section className="qr-card" aria-labelledby="qr-title">
            <h2 id="qr-title" className="pay-step">
              <span className="pay-step-no" aria-hidden="true">
                01
              </span>
              Scan and pay
            </h2>
            <div className="pay-amount-block">
              <p className="pay-amount tnum">{peso(p.amountDue)}</p>
              <p className="pay-amount-sub">
                {p.plan === 'half' ? '50% now' : '100% now'}
                {p.balanceDue > 0 && ` · ${peso(p.balanceDue)} at the studio`}
              </p>
            </div>
            {qr ? (
              <>
                <img className="qr-img" src={svgUri(qr.qrSvg)} alt={`GCash QR code for ${peso(p.amountDue)}`} width={300} height={300} />
                <p className="qr-help">Open GCash, tap QR, and scan this code. The amount is already filled in. On the same phone? Save the QR and upload it from your gallery in GCash.</p>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => saveQrPng(qr.qrSvg, `gcash-qr-${booking.code}.png`)}>
                  <Download /> Save QR image
                </button>
              </>
            ) : qrError ? (
              <div className="notice notice-bad" role="alert">
                <AlertCircle /> {qrError}
              </div>
            ) : (
              <div className="skeleton qr-skel" />
            )}
          </section>

          <section className="upload-card" aria-labelledby="up-title">
            <h2 id="up-title" className="pay-step">
              <span className="pay-step-no" aria-hidden="true">
                02
              </span>
              Upload your receipt
            </h2>
            {stage === 'awaiting_proof' && (
              <p className={clsx('pay-countdown', left !== null && left < 5 * 60_000 && 'is-low')} aria-live="off">
                {left !== null && left > 0 ? (
                  <>
                    Slot held for <strong className="tnum">{clockText(left)}</strong>
                  </>
                ) : (
                  'Your hold is ending…'
                )}
              </p>
            )}
            {stage === 'not_received' && (
              <div className="pay-note pay-note-warn" role="status">
                <Info aria-hidden="true" />
                <div>
                  <p className="pay-note-title">The studio hasn’t received your payment yet</p>
                  <p className="pay-note-body">Check the amount, then upload a new screenshot of your GCash receipt.</p>
                </div>
              </div>
            )}
            <Uploader
              file={file}
              preview={preview}
              inputRef={fileInput}
              onPick={pick}
              error={uploadError}
              refValue={ref}
              onRef={setRef}
              ocr={ocr}
              amountDue={p?.amountDue}
              proofCount={proofCount}
              disabled={uploading || full}
            />
            <div className="pay-actions">
              <button type="button" className="btn btn-primary btn-lg" onClick={proceed} disabled={!file || uploading}>
                {uploading ? 'Sending…' : 'Proceed'}
              </button>
              {stage === 'awaiting_proof' && (
                <button type="button" className="btn btn-ghost pay-later" onClick={() => setLaterOpen(true)}>
                  Pay later
                </button>
              )}
            </div>
            <p className="pay-rules">
              Your slot is held for {holdMinutes} minutes. If no screenshot is uploaded by then, the slot is released automatically. After you upload, it is held until the studio confirms.
            </p>
          </section>
        </div>
      )}

      {canPay && full && (
        <div className="notice notice-warn" style={{ marginTop: 16 }}>
          <Info /> You’ve already sent {MAX_FILES} screenshots. Message the studio if something is missing.
        </div>
      )}

      {canLateUpload && showUploader && (
        <section className="upload-card" aria-labelledby="late-title" style={{ marginTop: 16 }}>
          <PaymentNote booking={booking} serverTime={serverTime} />
          <h2 id="late-title" className="block-title">
            Upload your receipt
          </h2>
          <p className="bk-note">If the time is still free, your booking comes back and waits for the studio to confirm. If someone else took it, message the studio.</p>
          <Uploader
            file={file}
            preview={preview}
            inputRef={fileInput}
            onPick={pick}
            error={uploadError}
            refValue={ref}
            onRef={setRef}
            ocr={ocr}
            amountDue={p?.amountDue}
            proofCount={proofCount}
            disabled={uploading}
          />
          <div className="pay-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={proceed} disabled={!file || uploading}>
              {uploading ? 'Sending…' : 'Send receipt'}
            </button>
          </div>
        </section>
      )}

      <div className="done-actions">
        <Link className="btn btn-dark" to={`/check?code=${encodeURIComponent(booking.code)}`}>
          My booking
        </Link>
        {messenger && (
          <a className="btn btn-outline" href={messenger} target="_blank" rel="noreferrer">
            <MessageCircle /> Message the studio
          </a>
        )}
        <Link className="btn btn-ghost" to="/">
          Back to the home page
        </Link>
      </div>

      <ConfirmDialog
        open={laterOpen}
        onOpenChange={setLaterOpen}
        title="Pay later and release the slot?"
        description={`${when}. The slot opens up for other bands right away, and this booking is cancelled. Nothing has been charged.`}
        confirmLabel={releasing ? 'Releasing…' : 'Release the slot'}
        cancelLabel="Keep paying"
        onConfirm={release}
        busy={releasing}
        danger
      />
    </div>
  );
}

/** What the browser read off the screenshot. Hints only: nothing here stops the upload. */
function ReceiptRead({ ocr, amountDue }) {
  if (!ocr || ocr.status === 'idle') return null;
  if (ocr.status === 'reading') {
    return (
      <p className="ocr-note" role="status">
        Reading your receipt…
      </p>
    );
  }
  const hasAmount = typeof ocr.amount === 'number';
  const matches = hasAmount && typeof amountDue === 'number' && Math.abs(ocr.amount - amountDue) < 0.005;
  return (
    <div className="ocr-read" role="status">
      {(ocr.ref || hasAmount) && (
        <div className="ocr-chips">
          {ocr.ref && (
            <span className="ocr-chip">
              Reference found <strong className="tnum">{ocr.ref}</strong>
            </span>
          )}
          {hasAmount && (
            <span className={clsx('ocr-chip', !matches && typeof amountDue === 'number' && 'ocr-chip-warn')}>
              Receipt shows <strong className="tnum">{peso(ocr.amount)}</strong>
              {matches && ' · matches'}
            </span>
          )}
        </div>
      )}
      {hasAmount && !matches && typeof amountDue === 'number' && (
        <p className="ocr-note">
          The receipt shows {peso(ocr.amount)} but this booking needs {peso(amountDue)}. You can still send it, the studio will check.
        </p>
      )}
      {!ocr.ref && <p className="ocr-note">We couldn’t read the reference, you can type it.</p>}
      {ocr.ref && <p className="ocr-note">Read from your screenshot on this device. Check the number before you send.</p>}
    </div>
  );
}

function Uploader({ file, preview, inputRef, onPick, error, refValue, onRef, ocr, amountDue, proofCount, disabled }) {
  return (
    <div className="uploader">
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="receipt-file" onChange={onPick} disabled={disabled} />
      <label htmlFor="receipt-file" className={clsx('upload-drop', file && 'has-file', disabled && 'is-disabled')}>
        {file ? (
          <>
            <img className="upload-preview" src={preview} alt="Your receipt screenshot" />
            <span className="upload-name">
              {file.name} <span className="muted tnum">({sizeText(file.size)})</span>
            </span>
            <span className="upload-change">Choose a different file</span>
          </>
        ) : (
          <>
            <ImagePlus aria-hidden="true" />
            <span className="upload-cta">Upload screenshot of your GCash receipt</span>
            <span className="upload-hint">JPEG, PNG or WebP, up to {sizeText(MAX_BYTES)}</span>
          </>
        )}
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {proofCount > 0 && (
        <p className="field-hint">
          {proofCount} of {MAX_FILES} screenshots sent already.
        </p>
      )}
      {file && <ReceiptRead ocr={ocr} amountDue={amountDue} />}
      <Field label="GCash reference number" optional hint="Filled in from your screenshot when we can read it. Helps the studio find your payment faster.">
        {(p) => <input {...p} className="input tnum" inputMode="numeric" autoComplete="off" value={refValue} onChange={(e) => onRef(e.target.value)} maxLength={40} />}
      </Field>
    </div>
  );
}
