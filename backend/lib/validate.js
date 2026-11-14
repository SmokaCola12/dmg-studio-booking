import crypto from 'node:crypto';

/** Accepts 09XXXXXXXXX, 9XXXXXXXXX, +639XXXXXXXXX, 639XXXXXXXXX (spaces/dashes ok). Returns 09XXXXXXXXX or null. */
export function normalizePhone(input) {
  const digits = String(input || '').replace(/[^\d]/g, '');
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  if (/^9\d{9}$/.test(digits)) return `0${digits}`;
  return null;
}

export function cleanText(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

export function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// No 0/O/1/I to keep codes easy to read over the phone.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function bookingCode() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `BK-${s}`;
}

export function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/** Start minute of a booking: undefined when not sent, otherwise 0 or 30 (NaN for anything else). */
export function toStartMinute(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = toInt(v);
  return n === 0 || n === 30 ? n : NaN;
}
