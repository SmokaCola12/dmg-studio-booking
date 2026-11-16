import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '../../lib/api.js';
import { ConfirmDialog, Dialog } from '../../components/ui.jsx';

const svgUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall back to an <img> below */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file isn’t an image we can read.'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Reads the QR text out of a picture in the browser, so the server never needs an image library.
 * jsqr is loaded only when the owner uploads a QR. Small pictures are enlarged first.
 */
async function decodeQrFile(file) {
  const { default: jsQR } = await import('jsqr');
  const bitmap = await loadBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;
  for (const scale of [1, 2, 0.5, 3]) {
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (w < 150 || h < 150 || w * h > 16_000_000) continue;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h);
    const found = jsQR(pixels.data, w, h, { inversionAttempts: 'attemptBoth' });
    if (found?.data) return found.data;
  }
  return null;
}

/** Upload, check and remove the studio's GCash QR. Only a masked summary is ever shown back. */
export function GcashQrSettings({ onChange }) {
  const [info, setInfo] = useState(undefined); // undefined while loading, null if it failed
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const input = useRef(null);

  const load = () =>
    adminApi
      .gcashQr()
      .then((r) => {
        setInfo(r);
        onChange?.(r);
      })
      .catch(() => setInfo(null));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const payload = await decodeQrFile(file);
      if (!payload) {
        toast.error('Couldn’t find a QR code in that picture. Crop it to just the QR and try again.');
        return;
      }
      const r = await adminApi.saveGcashQr(payload);
      setInfo(r);
      onChange?.(r);
      toast.success('GCash QR saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await adminApi.previewGcashQr('1.00');
      setPreview(r.qrSvg);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await adminApi.deleteGcashQr();
      setRemoveOpen(false);
      await load();
      toast.success('GCash QR removed. Online GCash payment is off until you add one.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qr-settings">
      <input ref={input} type="file" accept="image/*" className="sr-only" id="gcash-qr-file" onChange={pick} />
      {info === undefined && <div className="skeleton" style={{ height: 56 }} />}
      {info === null && <p className="a-hint">The QR settings didn’t load. Refresh the page to try again.</p>}
      {info && (
        <>
          {info.configured ? (
            <p className="qr-summary">
              <strong>QR saved.</strong> {info.merchantName || 'Account'}
              {info.city ? `, ${info.city}` : ''}
              {info.accountHint ? ` · ${info.accountHint}` : ''}
            </p>
          ) : (
            <p className="a-hint">No QR saved yet. Customers can’t pay by GCash until you add one. Save your “Receive money” QR from the GCash app, crop it to just the QR, and upload it here.</p>
          )}
          <div className="qr-buttons">
            <button type="button" className="btn btn-dark btn-sm" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Working…' : info.configured ? 'Replace QR' : 'Upload your GCash QR'}
            </button>
            {info.configured && (
              <>
                <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={test}>
                  Test QR (₱1.00)
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRemoveOpen(true)}>
                  Remove
                </button>
              </>
            )}
          </div>
          <p className="field-hint">The QR picture is read in your browser. Only its text is saved, kept private, and used to draw a QR with the exact amount for each booking.</p>
        </>
      )}

      <Dialog open={Boolean(preview)} onOpenChange={(o) => !o && setPreview('')} title="Test QR for ₱1.00" description="Scan this with the GCash app on another phone. It should show ₱1.00 and your account name. Don’t send the payment.">
        {preview && <img className="qr-preview" src={svgUri(preview)} alt="Test GCash QR code for 1 peso" width={260} height={260} />}
      </Dialog>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove the GCash QR?"
        description="Customers won’t be able to choose GCash until you upload a QR again. Existing bookings stay as they are."
        confirmLabel={busy ? 'Removing…' : 'Remove QR'}
        cancelLabel="Keep it"
        danger
        busy={busy}
        onConfirm={remove}
      />
    </div>
  );
}
