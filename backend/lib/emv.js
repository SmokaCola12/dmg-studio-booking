// QR Ph (EMVCo merchant-presented) helpers. Pure functions, no database or network.
//
// The studio uploads its own static GCash / InstaPay QR once. To ask for an exact amount we keep every field,
// switch the point-of-initiation tag (01) from static "11" to dynamic "12", insert the amount (tag 54) right after the
// currency (tag 53), and recompute the CRC-16/CCITT-FALSE checksum in tag 63.

const MAX_PAYLOAD = 500;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** Splits an EMV TLV string into [{ id, len, val }], or returns null when it is not well formed. */
export function parseTlv(text) {
  if (typeof text !== 'string') return null;
  const items = [];
  let i = 0;
  while (i < text.length) {
    if (i + 4 > text.length) return null;
    const id = text.slice(i, i + 2);
    const lenText = text.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lenText)) return null;
    const len = Number(lenText);
    if (i + 4 + len > text.length) return null;
    items.push({ id, len, val: text.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return items;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the characters of `text`, as 4 uppercase hex digits. */
export function crc16ccitt(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= (text.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Checks that `payload` is a usable static QR Ph code. Returns { ok: true, items } or { ok: false, error }.
 * Error texts are written for the owner and never contain the payload itself.
 */
export function validateStaticQr(payload) {
  if (typeof payload !== 'string' || !payload) return { ok: false, error: 'That QR code could not be read.' };
  if (payload.length > MAX_PAYLOAD) return { ok: false, error: 'That QR code is too long to be a GCash QR.' };
  if (!PRINTABLE_ASCII.test(payload)) return { ok: false, error: 'That QR code has characters a GCash QR does not use.' };
  const items = parseTlv(payload);
  if (!items || items.length < 4) return { ok: false, error: 'That does not look like a GCash or InstaPay QR code.' };
  const get = (id) => items.find((x) => x.id === id)?.val;
  if (get('00') !== '01') return { ok: false, error: 'That does not look like a GCash or InstaPay QR code.' };
  if (get('01') !== '11' && get('01') !== '12') return { ok: false, error: 'That QR code is not a payment QR.' };
  if (get('53') !== '608') return { ok: false, error: 'That QR code is not in Philippine pesos.' };
  if (get('58') !== 'PH') return { ok: false, error: 'That QR code is not from the Philippines.' };
  const last = items[items.length - 1];
  if (last.id !== '63' || last.len !== 4) return { ok: false, error: 'That QR code is incomplete (no checksum).' };
  if (crc16ccitt(payload.slice(0, -4)) !== last.val.toUpperCase()) {
    return { ok: false, error: 'That QR code looks damaged (the checksum does not match). Try a clearer image.' };
  }
  return { ok: true, items };
}

/** Whole pesos as the "250.00" text a QR amount uses, or null when the amount is not a positive whole number. */
export function pesoText(amount) {
  return Number.isInteger(amount) && amount > 0 && amount <= 1_000_000 ? `${amount}.00` : null;
}

/**
 * Returns a new payload that asks for `amount` (text like "250.00"): any old tag 54 and the old checksum are dropped,
 * tag 01 becomes "12" (dynamic), tag 54 goes right after tag 53, and a fresh checksum is appended.
 */
export function withAmount(payload, amount) {
  if (!/^\d{1,7}\.\d{2}$/.test(String(amount))) throw new Error('Amount must look like 250.00');
  const check = validateStaticQr(payload);
  if (!check.ok) throw new Error('The stored QR code is not valid.');
  const out = [];
  for (const it of check.items) {
    if (it.id === '63' || it.id === '54') continue;
    const val = it.id === '01' ? '12' : it.val;
    out.push(`${it.id}${String(val.length).padStart(2, '0')}${val}`);
    if (it.id === '53') out.push(`54${String(String(amount).length).padStart(2, '0')}${amount}`);
  }
  const body = `${out.join('')}6304`;
  return `${body}${crc16ccitt(body)}`;
}

const mask = (v) => (v.length <= 4 ? '•'.repeat(v.length) : `${v.slice(0, 2)}${'•'.repeat(v.length - 4)}${v.slice(-2)}`);

/** What the owner may see after uploading: merchant name, city and a masked account hint. Never the raw payload. */
export function maskSummary(payload) {
  const check = validateStaticQr(payload);
  if (!check.ok) return { merchantName: '', city: '', accountHint: '' };
  const get = (id) => check.items.find((x) => x.id === id)?.val || '';
  // The merchant account template is one of tags 26 to 51. Its longest sub-field (other than the "00" network
  // identifier) is the account reference.
  let hint = '';
  for (const it of check.items) {
    const n = Number(it.id);
    if (n < 26 || n > 51) continue;
    const subs = parseTlv(it.val) || [];
    for (const s of subs) if (s.id !== '00' && s.val.length > hint.length) hint = s.val;
  }
  return { merchantName: get('59'), city: get('60'), accountHint: hint ? mask(hint) : '' };
}
