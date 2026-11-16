// Reads a GCash receipt screenshot in the browser (OCR) and returns the reference number and amount it finds.
// The picture never leaves the device for this: the worker, the WASM core and the English data are served by
// this site from /ocr (copied there by scripts/copy-ocr.mjs), never from a CDN.
// Import this file with a dynamic import() so tesseract.js and the text parser stay out of the main bundle.
// It is the only file that imports receipt-ocr.js.
import { createWorker } from 'tesseract.js';
import { amountText, parseGcashReceipt } from './receipt-ocr.js';

const OCR_BASE = new URL(`${import.meta.env.BASE_URL}ocr`, window.location.href).href.replace(/\/$/, '');
const MAX_SIDE = 1600;
const TIMEOUT_MS = 25_000;
const CLEANUP_WAIT_MS = 4000; // how long the next read waits for a worker that is still starting, before going ahead

async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A smaller grey, higher-contrast copy: quicker to read and kinder to phones with little memory. */
async function toCanvas(file) {
  const img = await loadImage(file);
  const w = img.width || img.naturalWidth;
  const h = img.height || img.naturalHeight;
  if (!w || !h) throw new Error('empty image');
  const longest = Math.max(w, h);
  const scale = longest > MAX_SIDE ? MAX_SIDE / longest : longest < 900 ? Math.min(2, 900 / longest) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if ('filter' in ctx) ctx.filter = 'grayscale(1) contrast(1.35)';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  return canvas;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One read. `result` settles as soon as there is an answer, a timeout or an abort.
 * `cleaned` settles once this read's worker is gone, so the next read can start.
 */
function readNow(file, signal) {
  if (signal?.aborted) return { result: Promise.resolve(null), cleaned: Promise.resolve() };

  let ended = false;
  let creating = null; // the createWorker() promise, once the worker has been asked for
  let timer = null;
  let onAbort = null;

  const stopped = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    onAbort = () => resolve(null);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  const work = (async () => {
    const canvas = await toCanvas(file);
    if (ended) return null;
    creating = createWorker('eng', 1, {
      workerPath: `${OCR_BASE}/worker.min.js`,
      corePath: OCR_BASE,
      langPath: OCR_BASE,
      gzip: true,
      workerBlobURL: false,
    });
    const w = await creating;
    if (ended) return null;
    const { data } = await w.recognize(canvas);
    canvas.width = 0; // let the pixels go
    canvas.height = 0;
    const found = parseGcashReceipt(data?.text || '');
    return { ...found, amountText: amountText(found.amount) };
  })();
  work.catch(() => {}); // a late failure after a timeout or abort must not surface as an unhandled rejection

  // Out of memory, blocked worker, unreadable image: null, and the upload carries on without it.
  const result = Promise.race([work, stopped]).catch(() => null);

  const cleaned = result.then(async () => {
    ended = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (!creating) return;
    // A worker that exists is terminated right away; one still starting is terminated the moment it is up.
    const gone = creating.then((w) => w.terminate()).catch(() => {});
    await Promise.race([gone, wait(CLEANUP_WAIT_MS)]);
  });

  return { result, cleaned };
}

// Reads run one after another, so picking several files quickly never has several WASM workers alive at once.
let queue = Promise.resolve();

/**
 * @param {File|Blob} file the screenshot the customer already chose
 * @param {{ signal?: AbortSignal }} [options] abort to stop the read and terminate its worker at once
 * @returns {Promise<{ ref: string, amount: number|null, amountText: string, dateText: string }|null>}
 *   amountText is the amount as "210.00" for the X-Receipt-Amount header ('' when none).
 *   null when it could not be read at all, timed out or was aborted.
 */
export function readReceipt(file, { signal } = {}) {
  let cleaned = Promise.resolve();
  const result = queue.then(() => {
    const run = readNow(file, signal);
    cleaned = run.cleaned;
    return run.result;
  });
  queue = result.then(
    () => cleaned,
    () => cleaned
  ).catch(() => {});
  return result;
}
