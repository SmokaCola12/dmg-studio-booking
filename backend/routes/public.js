import express, { Router } from 'express';
import QRCode from 'qrcode';
import { db, getSettings, parseRoom, getContent, listGallery, getGcashQr } from '../db.js';
import { studioNow, isValidDate, STUDIO_TZ } from '../lib/time.js';
import {
  dateWindow, planBooking, planErrorBody, roomBusyHours, canCustomerCancel, canCustomerChange,
  monthAvailability, isValidMonth, nowIso,
} from '../lib/scheduling.js';
import { normalizePhone, cleanText, isEmail, bookingCode, toInt, toStartMinute } from '../lib/validate.js';
import {
  PAYMENT_PLANS, depositAmount, paymentView, logEvent, sweepExpiredHolds, sweepAndNotify, recordProof, receiptHints, releaseHold,
  canUploadProof, proofCountFor, notifyStaff,
} from '../lib/payments.js';
import {
  RECEIPT_TYPES, MAX_RECEIPT_BYTES, MAX_PROOFS_PER_BOOKING, receiptType, saveReceipt, removeReceipt,
} from '../lib/receipts.js';
import { withAmount, pesoText } from '../lib/emv.js';
import { uploadLimiter, lookupFailures } from '../lib/throttle.js';

const router = Router();

const PUBLIC_SETTING_KEYS = [
  'open_hour', 'close_hour', 'min_hours', 'max_hours', 'lead_time_hours', 'max_days_ahead',
  'buffer_minutes', 'cancel_cutoff_hours', 'auto_confirm', 'promo_enabled', 'promo_buy_hours', 'promo_free_hours',
  'gcash_enabled', 'gcash_hold_minutes', 'closed_weekdays',
];

/** Online GCash is on only when the owner switched it on AND uploaded the studio QR. */
const gcashAvailable = (s = getSettings()) => !!s.gcash_enabled && !!getGcashQr();

export function publicBooking(b) {
  const room = db.prepare('SELECT id, name, color FROM rooms WHERE id = ?').get(b.room_id);
  return {
    code: b.code,
    room,
    date: b.date,
    startHour: b.start_hour,
    startMinute: b.start_minute || 0,
    endHour: b.end_hour,
    paidHours: b.paid_hours,
    freeHours: b.free_hours,
    name: b.customer_name,
    bandName: b.band_name,
    phone: b.phone,
    email: b.email,
    headcount: b.headcount,
    notes: b.notes,
    paymentMethod: b.payment_method,
    paymentRef: b.payment_ref,
    hourlyRate: b.hourly_rate,
    total: b.total,
    status: b.status,
    canCancel: canCustomerCancel(b),
    canReschedule: canCustomerChange(b),
    payment: paymentView(b),
    createdAt: b.created_at,
  };
}

const serverTime = () => nowIso();
const freshBooking = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
const bookingResponse = (id, extra = {}) => ({ booking: publicBooking(freshBooking(id)), serverTime: serverTime(), ...extra });

router.get('/site', (req, res) => {
  const s = getSettings();
  const rooms = db
    .prepare('SELECT * FROM rooms WHERE active = 1 ORDER BY sort_order, id')
    .all()
    .map(parseRoom)
    .map(({ id, name, description, hourly_rate, capacity, gear, color }) => ({
      id, name, description, hourlyRate: hourly_rate, capacity, gear, color,
    }));
  const settings = { ...Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, s[k]])), gcash_enabled: gcashAvailable(s) };
  const gallery = listGallery().map(({ id, src, alt }) => ({ id, src, alt }));
  res.json({ rooms, settings, content: { contact: getContent(), gallery }, now: studioNow(), timeZone: STUDIO_TZ });
});

router.get('/availability', (req, res) => {
  const date = req.query.date || studioNow().date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'Use a date like 2026-10-25.' });
  const rooms = db.prepare('SELECT id FROM rooms WHERE active = 1 ORDER BY sort_order, id').all();
  res.json({
    date,
    now: studioNow(),
    window: dateWindow(date),
    // busy is in decimal hours (15.5 = 3:30 PM); bookings also carry bufferEnd, the end of their cleaning time.
    rooms: rooms.map((r) => ({ id: r.id, busy: roomBusyHours(r.id, date) })),
  });
});

router.get('/availability/month', (req, res) => {
  const month = req.query.month;
  if (!isValidMonth(month)) return res.status(400).json({ error: 'Use a month like 2026-10.' });
  res.json(monthAvailability(month));
});

router.post('/bookings', (req, res) => {
  const b = req.body || {};
  const s = getSettings();

  const name = cleanText(b.name, 80);
  const phone = normalizePhone(b.phone);
  const email = cleanText(b.email, 120);
  const headcount = toInt(b.headcount ?? 1);
  const wantsGcash = b.paymentMethod === 'gcash';
  const paymentPlan = wantsGcash ? b.paymentPlan : '';
  const startMinute = toStartMinute(b.startMinute);

  const errors = {};
  if (Number.isNaN(startMinute)) errors.startMinute = 'Start times are on the hour or half hour.';
  if (!name) errors.name = 'Enter the name of the person booking.';
  if (!phone) errors.phone = 'Enter a mobile number like 0917 123 4567.';
  if (email && !isEmail(email)) errors.email = 'Check the email address.';
  if (!Number.isInteger(headcount) || headcount < 1 || headcount > 30) errors.headcount = 'Enter how many people are coming.';
  if (!isValidDate(b.date)) errors.date = 'Pick a date.';
  if (wantsGcash && !gcashAvailable(s)) errors.paymentMethod = 'GCash payments are not available right now. Pick pay at the studio.';
  else if (wantsGcash && !PAYMENT_PLANS.includes(paymentPlan)) errors.paymentPlan = 'Choose to pay 50% or 100% by GCash.';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Some details need fixing.', fields: errors });

  const create = db.transaction(() => {
    sweepExpiredHolds();
    const plan = planBooking({
      roomId: toInt(b.roomId),
      date: b.date,
      startHour: toInt(b.startHour),
      startMinute: startMinute ?? 0,
      paidHours: toInt(b.paidHours),
    });
    if (!plan.ok) return plan;
    if (headcount > plan.room.capacity) {
      return { ok: false, error: `${plan.room.name} fits up to ${plan.room.capacity} people.` };
    }

    let code;
    do code = bookingCode();
    while (db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code));

    // GCash bookings always wait for staff, whatever auto_confirm says, and hold their slot until the hold ends.
    const gcash = wantsGcash;
    const amountDue = gcash ? depositAmount(plan.total, paymentPlan) : 0;
    const holdUntil = gcash ? new Date(Date.now() + s.gcash_hold_minutes * 60_000).toISOString() : null;

    const info = db
      .prepare(
        `INSERT INTO bookings (code, room_id, date, start_hour, start_minute, paid_hours, free_hours, end_hour,
          customer_name, band_name, phone, email, headcount, notes, payment_method, payment_ref,
          hourly_rate, total, status, source, payment_plan, amount_due, payment_status, hold_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'online', ?, ?, ?, ?)`
      )
      .run(
        code, plan.room.id, b.date, plan.startHour, plan.startMinute, plan.paidHours, plan.freeHours, plan.endHour,
        name, cleanText(b.bandName, 80), phone, email, headcount, cleanText(b.notes, 500),
        gcash ? 'gcash' : 'pay_at_studio', plan.hourlyRate, plan.total,
        gcash ? 'pending' : s.auto_confirm ? 'confirmed' : 'pending',
        gcash ? paymentPlan : '', amountDue, gcash ? 'awaiting_proof' : '', holdUntil
      );
    if (gcash) {
      logEvent(info.lastInsertRowid, {
        actor: 'customer', action: 'created', amount: amountDue, method: 'gcash', note: `${paymentPlan === 'full' ? '100%' : '50%'} plan`,
      });
    }
    return { ok: true, id: info.lastInsertRowid, freeNote: plan.freeNote };
  });

  const result = create();
  if (!result.ok) return res.status(409).json(planErrorBody(result));
  // Tell the studio inbox, after the commit and without waiting for it.
  void notifyStaff('staffNewBooking', freshBooking(result.id));
  res.status(201).json(bookingResponse(result.id, { freeNote: result.freeNote }));
});

const NO_MATCH = { error: 'No booking matches that code and mobile number.' };
const TOO_MANY = { error: 'Too many tries. Wait a few minutes and try again.' };

/**
 * Finds a booking by code + mobile number. Answers 429 when this IP has too many failed matches and 404 on a miss
 * (counted against the IP). Returns the row, or null after the response has been sent.
 */
function customerBooking(req, res, code, phone) {
  if (lookupFailures.blocked(req.ip)) {
    res.status(429).json(TOO_MANY);
    return null;
  }
  const normalized = normalizePhone(phone);
  const row = code && normalized ? db.prepare('SELECT * FROM bookings WHERE code = ?').get(String(code).trim().toUpperCase()) : null;
  if (!row || row.phone !== normalized) {
    lookupFailures.add(req.ip);
    res.status(404).json(NO_MATCH);
    return null;
  }
  return row;
}

router.post('/bookings/lookup', (req, res) => {
  sweepAndNotify();
  const row = customerBooking(req, res, req.body?.code, req.body?.phone);
  if (!row) return;
  res.json(bookingResponse(row.id));
});

router.post('/bookings/cancel', (req, res) => {
  sweepAndNotify();
  const row = customerBooking(req, res, req.body?.code, req.body?.phone);
  if (!row) return;
  if (!canCustomerCancel(row)) {
    const s = getSettings();
    const paid = row.payment_status === 'received';
    const sentProof = ['proof_submitted', 'not_received'].includes(row.payment_status);
    return res.status(409).json({
      error: paid
        ? 'Your GCash payment was received, so this booking cannot be cancelled online. Message the studio and they will help.'
        : sentProof
          ? 'You already sent a GCash screenshot for this booking, so it cannot be cancelled online. Message the studio and they will help.'
          : `This booking can no longer be cancelled online. Bookings can be cancelled up to ${s.cancel_cutoff_hours} hours before the start time — message the studio instead.`,
    });
  }
  db.transaction(() => {
    db.prepare("UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL, updated_at = datetime('now') WHERE id = ?").run(row.id);
    if (row.payment_plan) {
      const proofs = db.prepare('SELECT COUNT(*) AS n FROM payment_proofs WHERE booking_id = ?').get(row.id).n;
      logEvent(row.id, { actor: 'customer', action: 'cancelled', note: proofs ? 'a screenshot was already uploaded' : '' });
    }
  })();
  void notifyStaff('staffCustomerChange', freshBooking(row.id), { kind: 'cancelled' });
  res.json(bookingResponse(row.id));
});

// Same room and same paid hours; only the date and start time move. Same cutoff as cancelling. A GCash payment
// carries over, and an unfinished hold keeps its original timer.
router.post('/bookings/reschedule', (req, res) => {
  sweepAndNotify();
  const row = customerBooking(req, res, req.body?.code, req.body?.phone);
  if (!row) return;
  if (!canCustomerChange(row)) {
    const s = getSettings();
    return res.status(409).json({
      error: `This booking can no longer be changed online. Bookings can be moved up to ${s.cancel_cutoff_hours} hours before the start time — message the studio instead.`,
    });
  }
  if (!isValidDate(req.body?.date)) return res.status(400).json({ error: 'Pick a new date.' });
  const date = req.body.date;
  const startHour = toInt(req.body.startHour);
  const startMinute = toStartMinute(req.body.startMinute);
  if (Number.isNaN(startMinute)) return res.status(400).json({ error: 'Start times are on the hour or half hour.' });
  if (date === row.date && startHour === row.start_hour && (startMinute ?? 0) === (row.start_minute || 0)) {
    return res.status(400).json({ error: 'That is the time you already have. Pick a different one.' });
  }

  const move = db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.id);
    if (!canCustomerChange(fresh)) return { ok: false, error: 'This booking can no longer be changed online.' };
    const plan = planBooking({
      roomId: fresh.room_id,
      date,
      startHour,
      startMinute: startMinute ?? 0,
      paidHours: fresh.paid_hours,
      excludeBookingId: fresh.id,
    });
    if (!plan.ok) return plan;
    db.prepare(
      `UPDATE bookings SET date = ?, start_hour = ?, start_minute = ?, free_hours = ?, end_hour = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(date, plan.startHour, plan.startMinute, plan.freeHours, plan.endHour, fresh.id);
    if (fresh.payment_plan) logEvent(fresh.id, { actor: 'customer', action: 'rescheduled', note: `${date} ${plan.startHour}:${plan.startMinute === 30 ? '30' : '00'}` });
    return { ok: true, freeNote: plan.freeNote, was: fresh };
  });

  const result = move();
  if (!result.ok) return res.status(409).json(planErrorBody(result));
  void notifyStaff('staffCustomerChange', freshBooking(row.id), { kind: 'rescheduled', was: result.was });
  res.json(bookingResponse(row.id, { freeNote: result.freeNote }));
});

// ---------- GCash payment pages ----------

// The QR for one booking, with its exact deposit amount inside. Needs the booking code and mobile number, and only
// works while the booking is waiting for a screenshot. The stored QR text itself is never returned, only the picture.
router.post('/bookings/payment-qr', async (req, res) => {
  sweepAndNotify();
  const row = customerBooking(req, res, req.body?.code, req.body?.phone);
  if (!row) return;
  if (!row.payment_plan || row.status !== 'pending' || !['awaiting_proof', 'not_received'].includes(row.payment_status)) {
    return res.status(409).json({ error: 'This booking is not waiting for a GCash payment.' });
  }
  const payload = getGcashQr();
  const amount = pesoText(row.amount_due);
  if (!payload || !amount) return res.status(503).json({ error: 'GCash payments are not available right now. Message the studio.' });
  const qrSvg = await QRCode.toString(withAmount(payload, amount), { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
  res.set('Cache-Control', 'no-store');
  res.json({ amount, qrSvg, holdExpiresAt: row.hold_expires_at || null, serverTime: serverTime() });
});

// Receipt screenshot as the raw image body. The booking code and mobile number travel in headers so they stay out of
// URLs and proxy logs.
const proofUpload = express.raw({ type: RECEIPT_TYPES, limit: MAX_RECEIPT_BYTES });

// Runs BEFORE the body is read, so an anonymous client cannot make the server buffer up to 15 MB per request before
// being turned away. It uses only headers: rate limit, failed-match block, booking code + phone, and the booking state.
// The same checks run again inside recordProof's transaction, which stays the source of truth.
function proofGate(req, res, next) {
  if (lookupFailures.blocked(req.ip) || !uploadLimiter.take(req.ip)) return res.status(429).json(TOO_MANY);
  sweepAndNotify();
  const row = customerBooking(req, res, req.get('x-booking-code'), req.get('x-booking-phone'));
  if (!row) return;
  if (!row.payment_plan) return res.status(409).json({ error: 'This booking does not take GCash screenshots.' });
  const proofs = proofCountFor(row.id);
  if (proofs >= MAX_PROOFS_PER_BOOKING) {
    return res.status(409).json({ error: `You can upload up to ${MAX_PROOFS_PER_BOOKING} screenshots for one booking.` });
  }
  if (!canUploadProof(row, proofs)) {
    return res.status(409).json({ error: 'Screenshots can no longer be added to this booking. Message the studio.' });
  }
  if (!req.is(RECEIPT_TYPES)) return res.status(415).json({ error: 'Upload a JPEG, PNG or WebP screenshot.' });
  req.gateBooking = row;
  next();
}

router.post('/bookings/payment-proof', proofGate, proofUpload, (req, res) => {
  const row = req.gateBooking;
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(415).json({ error: 'Upload a JPEG, PNG or WebP screenshot.' });
  }
  const type = receiptType(req.body, req.get('content-type'));
  if (!type) return res.status(415).json({ error: 'That file is not a JPEG, PNG or WebP image.' });

  const ref = cleanText(req.get('x-payment-ref'), 40);
  // What the customer's browser read from the screenshot. Hints only: bad values are dropped, never an error.
  const hints = receiptHints(req.get('x-receipt-ref'), req.get('x-receipt-amount'));
  const saved = saveReceipt(req.body, type.ext);
  let result;
  try {
    result = recordProof(row.id, { file: saved.file, mime: type.mime, bytes: req.body.length, sha256: saved.sha256, ref, ...hints });
  } catch (err) {
    removeReceipt(saved.file);
    throw err;
  }
  if (!result.ok) {
    removeReceipt(saved.file);
    return res.status(result.status).json(result.body);
  }
  // One email to the studio inbox per screenshot (`row` is the booking as it was before this upload).
  void notifyStaff('staffPaymentProof', freshBooking(row.id), { reupload: row.payment_status === 'not_received' });
  res.status(201).json(bookingResponse(row.id));
});

// "Pay later": give the slot back.
router.post('/bookings/release', (req, res) => {
  sweepAndNotify();
  const row = customerBooking(req, res, req.body?.code, req.body?.phone);
  if (!row) return;
  const result = releaseHold(row.id);
  if (!result.ok) return res.status(result.status).json(result.body);
  res.json(bookingResponse(row.id));
});

export default router;
