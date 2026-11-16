// GCash payments confirmed by staff, with a screenshot as proof.
//
// A customer books with GCash (50% or 100%): the booking is `pending` and holds its slot for gcash_hold_minutes while
// it waits for a receipt screenshot. Once a screenshot is in, the slot is held until staff confirm or reject. Staff
// actions and customer uploads all go through the functions here, which keep every state change in one transaction and
// write an audit event for each.
import { db, getSettings, refDigits } from '../db.js';
import { studioNow, addDays, hoursUntil } from './time.js';
import { planBooking, nowIso } from './scheduling.js';
import { removeReceipt, MAX_PROOFS_PER_BOOKING } from './receipts.js';
import { createMailer } from './mailer.js';
import { cleanText } from './validate.js';

/** The deposit is fixed at 50% or 100% of the booking total. */
export const DEPOSIT_PERCENT = 50;
export const PAYMENT_PLANS = ['half', 'full'];

const WAITING_FOR_PROOF = ['awaiting_proof', 'not_received', 'proof_submitted'];

let mailer = createMailer();
/** Swap the mailer (tests inject a fake transport). */
export function setMailer(m) {
  mailer = m;
}
export const getMailer = () => mailer;

/** Whole pesos due by GCash now: the full total, or half of it rounded up to a whole peso. */
export function depositAmount(total, plan) {
  return plan === 'full' ? total : Math.ceil((total * DEPOSIT_PERCENT) / 100);
}

export function logEvent(bookingId, { actor, staffName = '', action, amount = null, method = '', note = '' }) {
  db.prepare(
    'INSERT INTO payment_events (booking_id, at, actor, staff_name, action, amount, method, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(bookingId, nowIso(), actor, cleanText(staffName, 40), action, amount, method, cleanText(note, 300));
}

export function proofCountFor(bookingId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM payment_proofs WHERE booking_id = ? AND kind = 'deposit' AND deleted_at IS NULL")
    .get(bookingId).n;
}

// ---------- Derived payment state ----------

/** Pesos still to pay after the deposit and any recorded balance. Only meaningful once the deposit is received. */
export function balanceDue(b) {
  if (!b.payment_plan || b.payment_status !== 'received') return 0;
  return Math.max(0, b.total - b.paid_amount - b.balance_paid);
}

export function paidInFull(b) {
  return !!b.payment_plan && b.payment_status === 'received' && b.paid_amount + b.balance_paid >= b.total;
}

/** One word for where a GCash booking stands, for badges and notes. '' for bookings that are not new-style GCash. */
export function stageOf(b) {
  if (!b.payment_plan) return '';
  if (b.refund_status === 'refund_due') return 'refund_due';
  if (b.refund_status === 'refunded') return 'refunded';
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'expired') return 'expired';
  if (b.payment_status === 'received') return paidInFull(b) ? 'paid' : 'deposit_received';
  return b.payment_status; // awaiting_proof | proof_submitted | not_received
}

export function canUploadProof(b, proofCount) {
  if (!b.payment_plan || proofCount >= MAX_PROOFS_PER_BOOKING) return false;
  if (b.status === 'pending') return WAITING_FOR_PROOF.includes(b.payment_status);
  return b.status === 'expired' && b.payment_status === 'awaiting_proof';
}

/**
 * True when staff can record a refund for this booking: one is due, or the booking ended (expired or cancelled) with at
 * least one screenshot on file and nothing recorded yet. recordRefund uses the same rule.
 */
export function refundEligible(b) {
  if (!b.payment_plan) return false;
  if (b.refund_status === 'refund_due') return true;
  if (b.refund_status !== '' || !['expired', 'cancelled'].includes(b.status)) return false;
  return db.prepare('SELECT COUNT(*) AS n FROM payment_proofs WHERE booking_id = ?').get(b.id).n > 0;
}

/**
 * The `payment` object on public and admin booking objects. Never contains file names or staff names. `canRefund` is
 * only ever true in the admin view (`{ admin: true }`).
 */
export function paymentView(b, { admin = false, receiptCheck } = {}) {
  const proofCount = b.proof_count ?? proofCountFor(b.id);
  return {
    // Staff-only hints read from the screenshot. Never part of the public view.
    ...(admin ? { receiptCheck: receiptCheck ?? receiptChecks([b]).get(b.id) } : {}),
    method: b.payment_method,
    plan: b.payment_plan,
    amountDue: b.amount_due,
    paidAmount: b.paid_amount,
    balanceDue: balanceDue(b),
    balancePaid: b.balance_paid,
    balanceMethod: b.balance_method,
    status: b.payment_status,
    stage: stageOf(b),
    paidInFull: paidInFull(b),
    holdExpiresAt: b.hold_expires_at || null,
    proofSubmittedAt: b.proof_submitted_at || null,
    proofCount,
    canUploadProof: canUploadProof(b, proofCount),
    refundStatus: b.refund_status,
    canRefund: admin ? refundEligible(b) : false,
  };
}

// ---------- Receipt hints (OCR) ----------
//
// The customer's browser reads the screenshot and sends what it found as hints. They are untrusted: a screenshot can be
// edited and the browser can send anything. They only help staff compare, and flag a reference used on two bookings.

const pesos = (centavos) => (centavos === null || centavos === undefined ? null : centavos / 100);

/**
 * Cleans the hint headers. Anything that does not look right is dropped silently, never an error. The reference must be
 * 8 to 20 digits and nothing else (no stripping: a header sent twice arrives joined by ', ' and is dropped).
 */
export function receiptHints(rawRef, rawAmount) {
  const refText = typeof rawRef === 'string' && rawRef.length <= 64 ? rawRef.trim() : '';
  const ocrRef = /^\d{8,20}$/.test(refText) ? refText : '';
  let ocrAmountCentavos = null;
  const amountText = typeof rawAmount === 'string' && rawAmount.length <= 16 ? rawAmount.trim() : '';
  if (/^\d{1,7}(\.\d{1,2})?$/.test(amountText)) {
    const centavos = Math.round(Number(amountText) * 100);
    if (centavos > 0 && centavos <= 1_000_000 * 100) ocrAmountCentavos = centavos;
  }
  return { ocrRef, ocrAmountCentavos };
}

function inChunks(values, size, run) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(...run(values.slice(i, i + size)));
  return out;
}
const marks = (list) => list.map(() => '?').join(',');

/**
 * Staff-only receipt check for a list of booking rows, as a Map of booking id to
 * { ocrRef, ocrAmount, amountMatches, refMatchesOcr, duplicateRef }. A fixed number of queries per page, however many
 * bookings are in it.
 */
export function receiptChecks(rows) {
  const out = new Map();
  if (!rows.length) return out;
  const ids = rows.map((r) => r.id);
  const proofs = inChunks(ids, 400, (part) =>
    db
      .prepare(`SELECT id, booking_id, kind, ocr_ref, ocr_amount_centavos FROM payment_proofs WHERE booking_id IN (${marks(part)}) ORDER BY id`)
      .all(...part)
  );
  const proofsOf = new Map();
  for (const p of proofs) {
    if (!proofsOf.has(p.booking_id)) proofsOf.set(p.booking_id, []);
    proofsOf.get(p.booking_id).push(p);
  }

  // Every reference each booking carries: the one the customer typed and the ones read from its screenshots.
  const refsOf = new Map();
  const allRefs = new Set();
  for (const b of rows) {
    const refs = new Set();
    const typed = refDigits(b.payment_ref);
    if (typed) refs.add(typed);
    for (const p of proofsOf.get(b.id) || []) if (p.ocr_ref) refs.add(p.ocr_ref);
    refsOf.set(b.id, refs);
    for (const r of refs) allRefs.add(r);
  }

  // Which bookings use each of those references (typed or read). The `!= ''` terms repeat the WHERE clause of the
  // partial indexes (idx_bookings_ref_digits, idx_proofs_ocr_ref); without them SQLite scans the whole table.
  const usedBy = new Map(); // ref -> Map(bookingId -> { id, code, status })
  const note = (row) => {
    if (!usedBy.has(row.ref)) usedBy.set(row.ref, new Map());
    usedBy.get(row.ref).set(row.id, { id: row.id, code: row.code, status: row.status });
  };
  const refList = [...allRefs];
  inChunks(refList, 400, (part) =>
    db.prepare(`SELECT id, code, status, ref_digits AS ref FROM bookings WHERE ref_digits IN (${marks(part)}) AND ref_digits != ''`).all(...part)
  ).forEach(note);
  inChunks(refList, 400, (part) =>
    db
      .prepare(
        `SELECT b.id, b.code, b.status, p.ocr_ref AS ref FROM payment_proofs p JOIN bookings b ON b.id = p.booking_id
         WHERE p.ocr_ref IN (${marks(part)}) AND p.ocr_ref != ''`
      )
      .all(...part)
  ).forEach(note);

  for (const b of rows) {
    const deposits = (proofsOf.get(b.id) || []).filter((p) => p.kind === 'deposit');
    const latest = deposits[deposits.length - 1];
    const ocrRef = latest?.ocr_ref || '';
    const cents = latest?.ocr_amount_centavos ?? null;
    const typed = refDigits(b.payment_ref);
    const others = new Map();
    for (const ref of refsOf.get(b.id)) {
      for (const [id, other] of usedBy.get(ref) || []) if (id !== b.id) others.set(id, other);
    }
    out.set(b.id, {
      ocrRef,
      ocrAmount: pesos(cents),
      amountMatches: cents === null || !b.payment_plan ? null : cents === b.amount_due * 100,
      refMatchesOcr: typed && ocrRef ? typed === ocrRef : null,
      duplicateRef: [...others.values()].sort((a, c) => a.id - c.id),
    });
  }
  return out;
}

/** Admin-only: stored screenshots (no file names) and the audit trail of one booking. */
export function listProofs(bookingId) {
  return db
    .prepare(
      `SELECT p.id, p.kind, p.uploaded_by, p.uploaded_at, p.bytes, p.ocr_ref, p.ocr_amount_centavos,
         (SELECT b2.code FROM payment_proofs p2 JOIN bookings b2 ON b2.id = p2.booking_id
          WHERE p2.sha256 = p.sha256 AND p2.booking_id != p.booking_id LIMIT 1) AS duplicate_of
       FROM payment_proofs p WHERE p.booking_id = ? AND p.deleted_at IS NULL ORDER BY p.id`
    )
    .all(bookingId)
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      uploadedBy: p.uploaded_by,
      uploadedAt: p.uploaded_at,
      bytes: p.bytes,
      ocrRef: p.ocr_ref,
      ocrAmount: pesos(p.ocr_amount_centavos),
      ...(p.duplicate_of ? { duplicateOf: p.duplicate_of } : {}),
    }));
}

export function listEvents(bookingId) {
  return db
    .prepare('SELECT * FROM payment_events WHERE booking_id = ? ORDER BY id')
    .all(bookingId)
    .map((e) => ({
      id: e.id,
      at: e.at,
      actor: e.actor,
      staffName: e.staff_name,
      action: e.action,
      amount: e.amount,
      method: e.method,
      note: e.note,
    }));
}

// ---------- Holds ----------

/**
 * Marks pending GCash bookings whose hold ran out as `expired` and logs it. Safe to call anywhere, including inside
 * another transaction. Returns the rows that were expired (before the update), so callers can email them.
 */
export function sweepExpiredHolds() {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM bookings WHERE status = 'pending' AND payment_status = 'awaiting_proof'
           AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?`
      )
      .all(nowIso());
    const expire = db.prepare("UPDATE bookings SET status = 'expired', updated_at = datetime('now') WHERE id = ?");
    for (const r of rows) {
      expire.run(r.id);
      logEvent(r.id, { actor: 'system', action: 'hold_expired' });
    }
    return rows;
  })();
}

/** Sweeps, then emails each customer whose hold ended (when they gave an email). Never throws. */
export function sweepAndNotify() {
  try {
    const rows = sweepExpiredHolds();
    for (const r of rows) if (r.email) void notify('holdExpired', r);
    return rows;
  } catch (err) {
    console.error(`[payments] sweep failed: ${err.code || err.message}`);
    return [];
  }
}

// ---------- Email ----------

const hm = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h % 24 < 12 ? 'AM' : 'PM'}`;

function describe(b) {
  const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(b.room_id)?.name || 'Studio';
  const day = new Date(`${b.date}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const m = b.start_minute || 0;
  return { room, when: `${day}, ${hm(b.start_hour, m)} to ${hm(b.end_hour, m)}` };
}

function siteUrl() {
  const u = (process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(u) ? u : '';
}

/**
 * Sends one payment email (template: confirmed | notReceived | holdExpired) and records the result in the audit trail.
 * Fire and forget: it never throws and never blocks the action that triggered it. No-op without an email address.
 */
export async function notify(template, b) {
  if (!b.email || !mailer.enabled) return { skipped: true };
  try {
    const { room, when } = describe(b);
    const result = await mailer.send(template, b.email, {
      name: b.customer_name,
      code: b.code,
      room,
      when,
      amount: b.paid_amount || b.amount_due,
      balanceDue: balanceDue(b),
      holdMinutes: getSettings().gcash_hold_minutes,
      siteUrl: siteUrl(),
    });
    if (!result.skipped) {
      logEvent(b.id, { actor: 'system', action: result.sent ? 'email_sent' : 'email_failed', note: template });
    }
    return result;
  } catch (err) {
    console.error(`[mail] ${template} failed: ${err?.code || 'error'}`);
    return { sent: false, failed: true };
  }
}

/** True when an email would be attempted for this booking right now. */
export const willEmail = (b) => !!(b.email && mailer.enabled);

// ---------- Email to the studio inbox ----------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const peso = (n) => `₱${Number(n || 0).toLocaleString('en-US')}`;
// Customer text goes into the email on one line, so it cannot fake extra lines.
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** "Sat 14 Nov 5:00–7:00 PM" for a booking row (or its old date and time). Already studio time, so no conversion. */
function staffWhen(b) {
  const d = new Date(`${b.date}T00:00:00Z`);
  const m = String(b.start_minute || 0).padStart(2, '0');
  const ap = (h) => (h % 24 < 12 ? 'AM' : 'PM');
  const t = (h) => `${h % 12 || 12}:${m}`;
  const range =
    ap(b.start_hour) === ap(b.end_hour)
      ? `${t(b.start_hour)}–${t(b.end_hour)} ${ap(b.end_hour)}`
      : `${t(b.start_hour)} ${ap(b.start_hour)}–${t(b.end_hour)} ${ap(b.end_hour)}`;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${range}`;
}

function staffStatus(b) {
  if (b.status === 'pending') {
    if (!b.payment_plan) return 'Pending, waiting for your approval';
    if (b.payment_status === 'proof_submitted') return 'Pending, GCash receipt uploaded and waiting for your check';
    if (b.payment_status === 'not_received') return 'Pending, GCash payment not yet received';
    return 'Pending, waiting for the GCash receipt';
  }
  const names = { confirmed: 'Confirmed', cancelled: 'Cancelled', completed: 'Completed', no_show: 'No show', expired: 'Expired' };
  return names[b.status] || b.status;
}

function staffPayment(b) {
  if (b.payment_method !== 'gcash') return 'Pay at the studio';
  if (!b.payment_plan) return 'GCash';
  const plan = `GCash ${b.payment_plan === 'full' ? '100%' : '50%'}`;
  if (b.payment_status !== 'received') return `${plan}, ${peso(b.amount_due)} due now by GCash`;
  const left = balanceDue(b);
  return `${plan}, ${peso(b.paid_amount)} received${left > 0 ? `, ${peso(left)} balance at the studio` : ''}`;
}

function staffData(b, { kind, was, reupload, receipts } = {}) {
  const url = siteUrl();
  return {
    code: b.code,
    status: staffStatus(b),
    name: oneLine(b.customer_name),
    band: oneLine(b.band_name),
    phone: b.phone,
    email: oneLine(b.email),
    room: oneLine(db.prepare('SELECT name FROM rooms WHERE id = ?').get(b.room_id)?.name || 'Studio'),
    when: staffWhen(b),
    oldWhen: was ? staffWhen(was) : '',
    hours: `${b.paid_hours}${b.free_hours ? ` + ${b.free_hours} free` : ''}`,
    total: peso(b.total),
    payment: staffPayment(b),
    amount: peso(b.amount_due),
    kind,
    reupload: !!reupload,
    adminUrl: url ? `${url}${receipts ? '/admin/gcash' : '/admin'}` : '',
  };
}

const STAFF_EMAILS = {
  staffNewBooking: 'notify_new_booking',
  staffPaymentProof: 'notify_payment_proof',
  staffCustomerChange: 'notify_customer_changes',
};

/** Where staff emails go: the notify_email setting, or the SMTP_USER address. '' when there is neither. */
export function staffRecipient(s = getSettings()) {
  return s.notify_email || mailer.user || '';
}

/** The read-only `mail` object on the admin settings responses. Never anything secret. */
export function mailStatus(s = getSettings()) {
  return { configured: !!mailer.enabled, notifyTo: staffRecipient(s) };
}

/**
 * Emails the studio inbox about something a customer did online (template: staffNewBooking | staffPaymentProof |
 * staffCustomerChange). Call it after the transaction committed, with `void`: it never throws, never blocks the
 * customer's request, and does nothing when the owner switched that email off, mail is not set up, or there is no
 * address to send to. `extra`: { kind: 'cancelled' | 'rescheduled', was: the row before the move, reupload }.
 */
export async function notifyStaff(template, b, extra = {}) {
  try {
    if (!mailer.enabled || !b) return { skipped: true };
    const s = getSettings();
    const to = staffRecipient(s);
    if (!s[STAFF_EMAILS[template]] || !to) return { skipped: true };
    return await mailer.send(template, to, staffData(b, { ...extra, receipts: template === 'staffPaymentProof' }));
  } catch (err) {
    console.error(`[mail] ${template} failed: ${err?.code || 'error'}`);
    return { sent: false, failed: true };
  }
}

/** Sends the test email from the Settings page. Resolves to the mailer result ({ sent } or { failed }). Never throws. */
export async function sendTestEmail(to) {
  try {
    const url = siteUrl();
    return await mailer.send('test', to, { adminUrl: url ? `${url}/admin` : '' });
  } catch (err) {
    console.error(`[mail] test failed: ${err?.code || 'error'}`);
    return { sent: false, failed: true };
  }
}

// ---------- State changes ----------

const fail = (status, error, extra = {}) => ({ ok: false, status, body: { error, ...extra } });
const getBooking = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
const SLOT_TAKEN = 'This hold ended and the slot was taken. Message the studio; if you already paid they will sort it out.';

/** Re-checks that a booking's own slot is still free (including the cleaning buffer). Returns the plan. */
function recheckSlot(b) {
  return planBooking({
    roomId: b.room_id,
    date: b.date,
    startHour: b.start_hour,
    startMinute: b.start_minute || 0,
    paidHours: b.paid_hours,
    excludeBookingId: b.id,
    ignoreLeadTime: true,
  });
}

/**
 * Customer uploads a receipt screenshot (already saved to disk). Moves the booking to proof_submitted and clears its
 * hold. A hold that already ran out is revived when the slot is still free. Returns { ok, revived } or an error result.
 */
export function recordProof(bookingId, { file, mime, bytes, sha256, ref, ocrRef = '', ocrAmountCentavos = null }) {
  return db.transaction(() => {
    const b = getBooking(bookingId);
    if (!b) return fail(404, 'No booking matches that code and mobile number.');
    if (!b.payment_plan) return fail(409, 'This booking does not take GCash screenshots.');
    if (proofCountFor(b.id) >= MAX_PROOFS_PER_BOOKING) {
      return fail(409, `You can upload up to ${MAX_PROOFS_PER_BOOKING} screenshots for one booking.`);
    }

    let revived = false;
    const live = b.status === 'pending' && WAITING_FOR_PROOF.includes(b.payment_status);
    const patch = {};
    if (!live) {
      if (!(b.status === 'expired' && b.payment_status === 'awaiting_proof')) {
        return fail(409, 'Screenshots can no longer be added to this booking. Message the studio.');
      }
      if (hoursUntil(b.date, b.start_hour + (b.start_minute || 0) / 60) <= 0) {
        return fail(409, 'That time has already started. Message the studio and they will sort it out.', { code: 'slot_taken' });
      }
      const plan = recheckSlot(b);
      if (!plan.ok) return fail(409, SLOT_TAKEN, { code: 'slot_taken' });
      revived = true;
      patch.free_hours = plan.freeHours;
      patch.end_hour = plan.endHour;
    }

    db.prepare(
      `INSERT INTO payment_proofs (booking_id, file, mime, bytes, sha256, kind, uploaded_by, uploaded_at, ocr_ref, ocr_amount_centavos)
       VALUES (?, ?, ?, ?, ?, 'deposit', 'customer', ?, ?, ?)`
    ).run(b.id, file, mime, bytes, sha256, nowIso(), ocrRef, ocrAmountCentavos);

    db.prepare(
      `UPDATE bookings SET status = 'pending', payment_status = 'proof_submitted', hold_expires_at = NULL,
         proof_submitted_at = ?, payment_ref = CASE WHEN ? != '' THEN ? ELSE payment_ref END,
         ref_digits = CASE WHEN ? != '' THEN ? ELSE ref_digits END,
         free_hours = ?, end_hour = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(nowIso(), ref || '', ref || '', ref || '', refDigits(ref), patch.free_hours ?? b.free_hours, patch.end_hour ?? b.end_hour, b.id);

    if (revived) logEvent(b.id, { actor: 'customer', action: 'revived' });
    const notes = [
      ref ? `reference ${cleanText(ref, 40)}` : '',
      ocrRef ? 'ocr ref found' : '',
      ocrAmountCentavos !== null ? 'ocr amount found' : '',
    ].filter(Boolean);
    logEvent(b.id, { actor: 'customer', action: 'proof_uploaded', note: notes.join(', ') });
    return { ok: true, revived };
  })();
}

/** "Pay later": the customer gives the slot back. Only from a hold that is still waiting for its first screenshot. */
export function releaseHold(bookingId) {
  return db.transaction(() => {
    const b = getBooking(bookingId);
    if (!b) return fail(404, 'No booking matches that code and mobile number.');
    if (!(b.status === 'pending' && b.payment_status === 'awaiting_proof')) {
      return fail(409, 'This booking can no longer be released here. Message the studio.');
    }
    db.prepare("UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL, updated_at = datetime('now') WHERE id = ?").run(b.id);
    logEvent(b.id, { actor: 'customer', action: 'released' });
    return { ok: true };
  })();
}

/** Staff: the deposit arrived. Booking becomes confirmed and the deposit is recorded as received. */
export function confirmDeposit(bookingId, { staffName = '', amount } = {}) {
  // The sweep inside the transaction commits even when the confirm itself is refused, so the holds it expired are
  // returned on every result (`expired`) and the caller emails them after the commit.
  let expired = [];
  const result = db.transaction(() => {
    expired = sweepExpiredHolds();
    const b = getBooking(bookingId);
    if (!b) return fail(404, 'Booking not found.');
    if (!b.payment_plan) return fail(409, 'This is an older GCash booking. Update it from the Bookings page.');
    if (b.status === 'cancelled') return fail(409, 'This booking was cancelled.');
    if (['completed', 'no_show'].includes(b.status)) return fail(409, 'This booking is already finished.');
    if (b.payment_status === 'received') return fail(409, 'This payment was already confirmed.');

    const paid = amount === undefined || amount === null ? b.amount_due : amount;
    if (!Number.isInteger(paid) || paid < 1 || paid > b.total) {
      return fail(400, `Enter the amount received in whole pesos, up to ${b.total}.`);
    }

    if (b.status === 'expired') {
      const plan = recheckSlot(b);
      if (!plan.ok) {
        return fail(409, 'That slot was taken after the hold ended. Reschedule the booking or record a refund.', { code: 'slot_taken' });
      }
      db.prepare('UPDATE bookings SET free_hours = ?, end_hour = ? WHERE id = ?').run(plan.freeHours, plan.endHour, b.id);
    }

    db.prepare(
      `UPDATE bookings SET status = 'confirmed', payment_status = 'received', paid_amount = ?, hold_expires_at = NULL,
         refund_status = '', updated_at = datetime('now') WHERE id = ?`
    ).run(paid, b.id);
    logEvent(b.id, { actor: 'staff', staffName, action: 'confirmed_received', amount: paid, method: 'gcash' });
    return { ok: true };
  })();
  return { ...result, expired };
}

/** Staff: no payment seen yet. The booking stays pending and the customer can upload again. */
export function markNotReceived(bookingId, { staffName = '', note = '' } = {}) {
  return db.transaction(() => {
    const b = getBooking(bookingId);
    if (!b) return fail(404, 'Booking not found.');
    if (!b.payment_plan) return fail(409, 'This is an older GCash booking. Update it from the Bookings page.');
    if (!(b.status === 'pending' && ['proof_submitted', 'not_received'].includes(b.payment_status))) {
      return fail(409, 'Only a booking with an uploaded screenshot that is still pending can be marked not received.');
    }
    db.prepare("UPDATE bookings SET payment_status = 'not_received', hold_expires_at = NULL, updated_at = datetime('now') WHERE id = ?").run(b.id);
    logEvent(b.id, { actor: 'staff', staffName, action: 'marked_not_received', note });
    return { ok: true };
  })();
}

/**
 * Staff: the rest of a 50% booking was paid at the studio. `image` is the saved GCash screenshot for method 'gcash'
 * (required); cash needs none. The booking is then paid in full.
 */
export function recordBalance(bookingId, { staffName = '', method, amount, note = '', image }) {
  return db.transaction(() => {
    const b = getBooking(bookingId);
    if (!b) return fail(404, 'Booking not found.');
    if (!b.payment_plan || b.payment_status !== 'received') {
      return fail(409, 'Confirm the deposit first, then record the balance.');
    }
    if (!['confirmed', 'completed', 'no_show'].includes(b.status)) return fail(409, 'This booking is not active.');
    // Normally the balance is recorded once and nothing is left. If the total went up afterwards (a longer or pricier
    // slot), the difference can be recorded the same way, on top of what was paid.
    const remaining = balanceDue(b);
    if (remaining <= 0) {
      return fail(409, b.balance_recorded_at ? 'The balance for this booking was already recorded.' : 'There is no balance left to record.');
    }
    if (amount !== undefined && amount !== remaining) return fail(400, `The balance is ${remaining} pesos. Send exactly that amount.`);

    if (image) {
      db.prepare(
        `INSERT INTO payment_proofs (booking_id, file, mime, bytes, sha256, kind, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, 'balance', 'staff', ?)`
      ).run(b.id, image.file, image.mime, image.bytes, image.sha256, nowIso());
    }
    db.prepare(
      `UPDATE bookings SET balance_paid = ?, balance_method = ?, balance_recorded_at = ?, balance_recorded_by = ?,
         updated_at = datetime('now') WHERE id = ?`
    ).run(b.balance_paid + remaining, method, nowIso(), cleanText(staffName, 40), b.id);
    logEvent(b.id, { actor: 'staff', staffName, action: 'balance_collected', amount: remaining, method, note });
    return { ok: true, amount: remaining };
  })();
}

/** Staff: a refund was handed back (manually, outside the app). */
export function recordRefund(bookingId, { staffName = '', amount, method, note = '' }) {
  return db.transaction(() => {
    const b = getBooking(bookingId);
    if (!b) return fail(404, 'Booking not found.');
    if (!b.payment_plan) return fail(409, 'This is an older GCash booking. Update it from the Bookings page.');
    if (!refundEligible(b)) return fail(409, 'There is no refund to record for this booking.');
    const most = Math.max(b.paid_amount + b.balance_paid, b.amount_due);
    if (!Number.isInteger(amount) || amount < 1 || amount > most) {
      return fail(400, `Enter the refunded amount in whole pesos, up to ${most}.`);
    }
    db.prepare("UPDATE bookings SET refund_status = 'refunded', updated_at = datetime('now') WHERE id = ?").run(b.id);
    logEvent(b.id, { actor: 'staff', staffName, action: 'refunded', amount, method, note });
    return { ok: true };
  })();
}

// ---------- Receipt retention ----------

/**
 * Deletes screenshot files that are older than receipt_retention_days: the booking date is that long ago, or the
 * booking was expired or cancelled that long ago. Events stay; the proof rows get deleted_at. Returns how many.
 */
export function cleanupReceipts() {
  try {
    const days = getSettings().receipt_retention_days;
    const cutoffDate = addDays(studioNow().date, -days);
    const rows = db
      .prepare(
        `SELECT p.id, p.file, p.booking_id FROM payment_proofs p JOIN bookings b ON b.id = p.booking_id
         WHERE p.deleted_at IS NULL
           AND (b.date <= ? OR (b.status IN ('expired', 'cancelled') AND b.updated_at <= datetime('now', ?)))`
      )
      .all(cutoffDate, `-${days} days`);
    const mark = db.prepare('UPDATE payment_proofs SET deleted_at = ? WHERE id = ?');
    let n = 0;
    for (const r of rows) {
      if (!removeReceipt(r.file)) continue;
      mark.run(nowIso(), r.id);
      logEvent(r.booking_id, { actor: 'system', action: 'receipt_deleted' });
      n += 1;
    }
    return n;
  } catch (err) {
    console.error(`[payments] receipt cleanup failed: ${err.code || err.message}`);
    return 0;
  }
}
