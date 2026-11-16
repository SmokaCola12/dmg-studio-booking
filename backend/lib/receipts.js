import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPLOAD_ROOT, imageExtension } from './uploads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Payment receipts hold names and phone numbers, so they live OUTSIDE the folder served at /media and are only ever
// streamed by an admin route.
export const RECEIPT_DIR = path.resolve(process.env.RECEIPT_DIR || path.join(__dirname, '..', '..', 'data', 'private', 'receipts'));
export const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;
export const MAX_PROOFS_PER_BOOKING = 3;

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
export const RECEIPT_TYPES = Object.values(MIME_BY_EXT);

const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const distDir = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
if (isInside(RECEIPT_DIR, UPLOAD_ROOT) || isInside(UPLOAD_ROOT, RECEIPT_DIR) || isInside(RECEIPT_DIR, distDir)) {
  throw new Error('RECEIPT_DIR must be a private folder: not inside UPLOAD_DIR (served at /media) and not inside frontend/dist.');
}

fs.mkdirSync(RECEIPT_DIR, { recursive: true });

// Leftovers from an upload that crashed between write and rename.
for (const name of fs.readdirSync(RECEIPT_DIR)) {
  if (name.endsWith('.tmp')) fs.rmSync(path.join(RECEIPT_DIR, name), { force: true });
}

/**
 * Judges an uploaded image by its first bytes AND its Content-Type header. Returns { ext, mime } or null when the bytes
 * are not a JPEG, PNG or WebP, or the declared type does not match them.
 */
export function receiptType(buf, declaredType) {
  const ext = imageExtension(buf);
  if (!ext) return null;
  const mime = MIME_BY_EXT[ext];
  const declared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  return declared === mime ? { ext, mime } : null;
}

/** Writes the image under a random name (temp file then rename). Returns { file, sha256 }. */
export function saveReceipt(buf, ext) {
  const file = `${crypto.randomUUID()}${ext}`;
  const dest = path.join(RECEIPT_DIR, file);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return { file, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** Full path of a stored receipt, or null if it would fall outside the receipt folder. */
export function receiptPath(file) {
  const full = path.resolve(RECEIPT_DIR, String(file));
  return full.startsWith(RECEIPT_DIR + path.sep) ? full : null;
}

/** Deletes a stored receipt. Returns true when the file is gone (or never existed). */
export function removeReceipt(file) {
  const full = receiptPath(file);
  if (!full) return false;
  try {
    fs.rmSync(full, { force: true });
    return true;
  } catch (err) {
    console.warn(`[receipts] could not delete a receipt file: ${err.code || 'error'}`);
    return false;
  }
}
