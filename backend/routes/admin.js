import express, { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { db, getSettings, saveSettings, parseRoom, DEFAULT_SETTINGS, getContent, saveContent, listGallery, galleryPhoto, getGcashQr, saveGcashQr, getLegacyGcash, refDigits } from '../db.js';
import { GALLERY_DIR, MAX_UPLOAD_BYTES, MAX_PHOTOS, imageExtension, galleryPath } from '../lib/uploads.js';
import { checkPassword, issueToken, requireAdmin, loginThrottle } from '../lib/auth.js';
import { studioNow, isValidDate, addDays, weekday } from '../lib/time.js';
import { planBooking, planErrorBody, roomBusy, overlaps, isValidMonth, BUFFER_CHOICES } from '../lib/scheduling.js';
import { normalizePhone, cleanText, isEmail, bookingCode, toInt, toStartMinute } from '../lib/validate.js';
import {
  paymentView, receiptChecks, listProofs, listEvents, logEvent, sweepAndNotify, confirmDeposit, markNotReceived, recordBalance, recordRefund, notify, willEmail,
  getMailer, staffRecipient, mailStatus, sendTestEmail,
} from '../lib/payments.js';
import { testEmailLimiter } from '../lib/throttle.js';
import { RECEIPT_TYPES, MAX_RECEIPT_BYTES, receiptType, saveReceipt, receiptPath, removeReceipt } from '../lib/receipts.js';
import { validateStaticQr, withAmount, pesoText, maskSummary } from '../lib/emv.js';

const router = Router();
const STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show', 'expired']; // 'expired' is set by the system only
const HOLDING = ['pending', 'confirmed'];

router.post('/login', loginThrottle, (req, res) => {
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: 'That password is not correct.' });
  }
  res.json({ token: issueToken() });
});

router.use(requireAdmin);
// Every admin request starts by expiring holds that ran out, so lists never show a ghost hold.
router.use((req, res, next) => {
  sweepAndNotify();
  next();
});

function adminBooking(b, receiptCheck) {
  return {
    id: b.id,
    code: b.code,
    roomId: b.room_id,
    roomName: b.room_name,
    roomColor: b.room_color,
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
    source: b.source,
    adminNotes: b.admin_notes,
    payment: paymentView(b, { admin: true, receiptCheck }),
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

const BOOKING_SELECT = `
  SELECT b.*, r.name AS room_name, r.color AS room_color,
    (SELECT COUNT(*) FROM payment_proofs p WHERE p.booking_id = b.id AND p.kind = 'deposit' AND p.deleted_at IS NULL) AS proof_count
  FROM bookings b JOIN rooms r ON r.id = b.room_id`;

const getBooking = (id) => db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id);

/** adminBooking for a list, with the receipt checks looked up once for the whole list. */
function adminBookings(rows) {
  const checks = receiptChecks(rows);
  return rows.map((r) => adminBooking(r, checks.get(r.id)));
}

function monthEnd(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// ---------- Overview ----------

router.get('/overview', (req, res) => {
  const now = studioNow();
  const today = now.date;
  // Week runs Monday to Sunday.
  const weekStart = addDays(today, -((weekday(today) + 6) % 7));
  const weekEnd = addDays(weekStart, 6);
  const monthStart = `${today.slice(0, 7)}-01`;

  const todayRows = db
    .prepare(`${BOOKING_SELECT} WHERE b.date = ? AND b.status IN ('pending','confirmed','completed','no_show') ORDER BY b.start_hour, b.start_minute, r.sort_order`)
    .all(today);

  const pendingRows = db
    .prepare(`${BOOKING_SELECT} WHERE b.status = 'pending' AND b.date >= ? ORDER BY b.date, b.start_hour, b.start_minute LIMIT 20`)
    .all(today);
  const pendingCount = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending' AND date >= ?").get(today).n;
  const paymentsWaiting = db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending' AND payment_status = 'proof_submitted'")
    .get().n;

  const revenue = (from, to) =>
    db
      .prepare("SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n FROM bookings WHERE date BETWEEN ? AND ? AND status IN ('confirmed','completed')")
      .get(from, to);

  const upcomingRows = db
    .prepare(
      `${BOOKING_SELECT} WHERE b.status = 'confirmed' AND (b.date > ? OR (b.date = ? AND b.start_hour * 60 + b.start_minute >= ?))
       ORDER BY b.date, b.start_hour, b.start_minute LIMIT 8`
    )
    .all(today, today, now.hour * 60 + now.minute);

  // One receipt check for the three lists together (a booking can be in more than one of them).
  const byId = new Map([...todayRows, ...pendingRows, ...upcomingRows].map((r) => [r.id, r]));
  const checks = receiptChecks([...byId.values()]);
  const view = (rows) => rows.map((r) => adminBooking(r, checks.get(r.id)));

  res.json({
    now,
    today: view(todayRows),
    pending: view(pendingRows),
    pendingCount,
    paymentsWaiting,
    week: { from: weekStart, to: weekEnd, ...revenue(weekStart, weekEnd) },
    month: { from: monthStart, to: monthEnd(today), ...revenue(monthStart, monthEnd(today)) },
    upcoming: view(upcomingRows),
  });
});

// ---------- Bookings ----------

router.get('/bookings', (req, res) => {
  const where = [];
  const params = [];
  const { status, room, from, to, q } = req.query;
  if (status && STATUSES.includes(status)) {
    where.push('b.status = ?');
    params.push(status);
  }
  if (room) {
    where.push('b.room_id = ?');
    params.push(toInt(room));
  }
  if (from && isValidDate(from)) {
    where.push('b.date >= ?');
    params.push(from);
  }
  if (to && isValidDate(to)) {
    where.push('b.date <= ?');
    params.push(to);
  }
  if (q) {
    const text = String(q).trim();
    const like = `%${text}%`;
    const digits = text.replace(/\D/g, '');
    // Match phone numbers by digits so "0917 123" finds 09171234567.
    const phoneLike = digits.length >= 3 ? `%${digits}%` : like;
    where.push('(b.code LIKE ? OR b.customer_name LIKE ? OR b.band_name LIKE ? OR b.phone LIKE ? OR b.email LIKE ?)');
    params.push(like, like, like, phoneLike, like);
  }
  const sort =
    req.query.sort === 'created'
      ? 'b.created_at DESC'
      : req.query.sort === 'asc'
        ? 'b.date ASC, b.start_hour ASC, b.start_minute ASC'
        : 'b.date DESC, b.start_hour DESC, b.start_minute DESC';
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const offset = Math.max(toInt(req.query.offset) || 0, 0);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM bookings b ${clause}`).get(...params).n;
  const rows = db.prepare(`${BOOKING_SELECT} ${clause} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ total, limit, offset, bookings: adminBookings(rows) });
});

router.get('/bookings/:id', (req, res) => {
  const b = getBooking(toInt(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ booking: adminBooking(b) });
});

// Walk-ins and phone bookings entered by staff. Skips lead time; confirmed right away.
// Staff (never customers) may send overrideBuffer: true to book inside the cleaning gap.
router.post('/bookings', (req, res) => {
  const b = req.body || {};
  const startMinute = toStartMinute(b.startMinute);
  if (Number.isNaN(startMinute)) return res.status(400).json({ error: 'Start times are on the hour or half hour.' });
  const name = cleanText(b.name, 80);
  const phone = b.phone ? normalizePhone(b.phone) : '';
  const email = cleanText(b.email, 120);
  if (!name) return res.status(400).json({ error: 'Enter a name for this booking.' });
  if (b.phone && !phone) return res.status(400).json({ error: 'Enter a mobile number like 0917 123 4567, or leave it blank.' });
  if (email && !isEmail(email)) return res.status(400).json({ error: 'Check the email address.' });
  if (!isValidDate(b.date)) return res.status(400).json({ error: 'Pick a date.' });

  const create = db.transaction(() => {
    const plan = planBooking({
      roomId: toInt(b.roomId),
      date: b.date,
      startHour: toInt(b.startHour),
      startMinute: startMinute ?? 0,
      paidHours: toInt(b.paidHours),
      ignoreLeadTime: true,
      overrideBuffer: b.overrideBuffer === true,
    });
    if (!plan.ok) return plan;
    let code;
    do code = bookingCode();
    while (db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code));
    const info = db
      .prepare(
        `INSERT INTO bookings (code, room_id, date, start_hour, start_minute, paid_hours, free_hours, end_hour,
          customer_name, band_name, phone, email, headcount, notes, payment_method, payment_ref,
          hourly_rate, total, status, source, admin_notes, ref_digits)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'walk_in', ?, ?)`
      )
      .run(
        code, plan.room.id, b.date, plan.startHour, plan.startMinute, plan.paidHours, plan.freeHours, plan.endHour,
        name, cleanText(b.bandName, 80), phone || '', email, Math.max(toInt(b.headcount) || 1, 1),
        cleanText(b.notes, 500), b.paymentMethod === 'gcash' ? 'gcash' : 'pay_at_studio',
        cleanText(b.paymentRef, 40), plan.hourlyRate, plan.total, cleanText(b.adminNotes, 500),
        refDigits(cleanText(b.paymentRef, 40))
      );
    return { ok: true, id: info.lastInsertRowid, bufferWarning: plan.bufferWarning };
  });
  const result = create();
  if (!result.ok) return res.status(409).json(planErrorBody(result));
  res.status(201).json({ booking: adminBooking(getBooking(result.id)), bufferWarning: result.bufferWarning });
});

router.patch('/bookings/:id', (req, res) => {
  const id = toInt(req.params.id);
  const body = req.body || {};
  const bodyStartMinute = toStartMinute(body.startMinute);
  if (Number.isNaN(bodyStartMinute)) return res.status(400).json({ error: 'Start times are on the hour or half hour.' });

  const update = db.transaction(() => {
    let bufferWarning = null;
    const current = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!current) return { ok: false, status: 404, error: 'Booking not found.' };

    const next = { ...current };
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status) || body.status === 'expired') return { ok: false, status: 400, error: 'Unknown status.' };
      next.status = body.status;
      // A GCash booking is confirmed by recording its payment, never by flipping the status: otherwise the payment is
      // never marked received, drops out of the GCash list, and cannot be refunded or have its balance recorded.
      if (current.payment_plan) {
        if (next.status === 'confirmed' && current.status !== 'confirmed' && current.payment_status !== 'received') {
          return {
            ok: false,
            status: 409,
            body: {
              error: 'This GCash booking is confirmed by recording its payment. Open GCash Payments and press Received & Confirmed.',
              code: 'gcash_payment_required',
            },
          };
        }
        if (next.status === 'pending' && ['expired', 'cancelled'].includes(current.status)) {
          return {
            ok: false,
            status: 409,
            body: {
              error: 'This GCash booking cannot be set back to pending. Open GCash Payments and press Received & Confirmed instead.',
              code: 'gcash_payment_required',
            },
          };
        }
      }
    }
    if (body.adminNotes !== undefined) next.admin_notes = cleanText(body.adminNotes, 500);
    if (body.paymentRef !== undefined) next.payment_ref = cleanText(body.paymentRef, 40);

    const reschedule = ['roomId', 'date', 'startHour', 'startMinute', 'paidHours'].some((k) => body[k] !== undefined);
    const reactivating = HOLDING.includes(next.status) && !HOLDING.includes(current.status);

    if (reschedule || reactivating) {
      const roomId = body.roomId !== undefined ? toInt(body.roomId) : current.room_id;
      const date = body.date !== undefined ? body.date : current.date;
      if (!isValidDate(date)) return { ok: false, status: 400, error: 'Pick a valid date.' };
      // Sending a new startHour without startMinute means :00; with neither, the current start is kept.
      const startMinute = bodyStartMinute ?? (body.startHour !== undefined ? 0 : current.start_minute || 0);
      const plan = planBooking({
        roomId,
        date,
        startHour: body.startHour !== undefined ? toInt(body.startHour) : current.start_hour,
        startMinute,
        paidHours: body.paidHours !== undefined ? toInt(body.paidHours) : current.paid_hours,
        excludeBookingId: id,
        ignoreLeadTime: true,
        overrideBuffer: body.overrideBuffer === true,
      });
      if (!plan.ok) return { ok: false, status: 409, body: planErrorBody(plan) };
      bufferWarning = plan.bufferWarning;
      Object.assign(next, {
        room_id: plan.room.id,
        date,
        start_hour: plan.startHour,
        start_minute: plan.startMinute,
        paid_hours: plan.paidHours,
        free_hours: plan.freeHours,
        end_hour: plan.endHour,
        hourly_rate: reschedule ? plan.hourlyRate : current.hourly_rate,
        total: reschedule ? plan.total : current.total,
      });
    }

    // A booking that staff confirm, move or reopen is no longer waiting on a hold, so a sweep must never expire it.
    if (next.status !== 'pending' || reactivating) next.hold_expires_at = null;

    // Cancelling a booking that took money, or shrinking a paid booking below what was paid, leaves a refund to hand back.
    let refundNote = '';
    const taken = current.paid_amount + current.balance_paid;
    if (current.payment_plan && !current.refund_status) {
      if (next.status === 'cancelled' && current.status !== 'cancelled' && taken > 0) {
        next.refund_status = 'refund_due';
        refundNote = `cancelled after ${taken} pesos were received`;
      } else if (HOLDING.includes(next.status) && current.payment_status === 'received' && taken > next.total) {
        next.refund_status = 'refund_due';
        refundNote = `total is now ${next.total} pesos, ${taken - next.total} to give back`;
      }
    }

    db.prepare(
      `UPDATE bookings SET status = ?, admin_notes = ?, payment_ref = ?, ref_digits = ?, room_id = ?, date = ?, start_hour = ?,
         start_minute = ?, paid_hours = ?, free_hours = ?, end_hour = ?, hourly_rate = ?, total = ?,
         hold_expires_at = ?, refund_status = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      next.status, next.admin_notes, next.payment_ref, refDigits(next.payment_ref), next.room_id, next.date, next.start_hour,
      next.start_minute || 0, next.paid_hours, next.free_hours, next.end_hour, next.hourly_rate, next.total,
      next.hold_expires_at ?? null, next.refund_status || '', id
    );

    if (current.payment_plan) {
      const staffName = cleanText(body.staffName, 40);
      if (next.status !== current.status) {
        logEvent(id, {
          actor: 'staff', staffName, action: next.status === 'cancelled' ? 'cancelled' : 'status_changed', note: `${current.status} to ${next.status}`,
        });
      } else if (reschedule) {
        logEvent(id, { actor: 'staff', staffName, action: 'rescheduled', note: `${next.date} ${next.start_hour}:${next.start_minute === 30 ? '30' : '00'}` });
      }
      if (next.refund_status === 'refund_due' && !current.refund_status) {
        logEvent(id, { actor: 'staff', staffName, action: 'refund_due', amount: taken, note: refundNote });
      }
    }
    return { ok: true, bufferWarning };
  });

  const result = update();
  if (!result.ok) return res.status(result.status).json(result.body || { error: result.error });
  res.json({ booking: adminBooking(getBooking(id)), bufferWarning: result.bufferWarning });
});

// ---------- Day schedule & blocks ----------

router.get('/schedule', (req, res) => {
  const date = req.query.date || studioNow().date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'Use a date like 2026-10-25.' });
  const bookings = adminBookings(
    db.prepare(`${BOOKING_SELECT} WHERE b.date = ? ORDER BY b.start_hour, b.start_minute`).all(date)
  );
  const blocks = db.prepare('SELECT * FROM blocks WHERE date = ? ORDER BY start_hour').all(date).map((b) => ({
    id: b.id, roomId: b.room_id, date: b.date, startHour: b.start_hour, endHour: b.end_hour, reason: b.reason,
  }));
  const bufferConflicts = findBufferConflicts(bookings, getSettings().buffer_minutes);
  const rooms = db
    .prepare('SELECT * FROM rooms WHERE active = 1 OR id IN (SELECT room_id FROM bookings WHERE date = ?) ORDER BY sort_order, id')
    .all(date)
    .map(parseRoom);
  res.json({ date, now: studioNow(), settings: getSettings(), rooms, bookings, blocks, bufferConflicts });
});

// Back-to-back pairs in one room that leave less than the cleaning buffer between them (for example bookings made
// before the buffer existed, or staff overrides). Cancelled, completed and no-show bookings are ignored.
function findBufferConflicts(bookings, buffer) {
  const live = bookings
    .filter((b) => HOLDING.includes(b.status))
    .map((b) => ({ id: b.id, roomId: b.roomId, start: b.startHour * 60 + b.startMinute, end: b.endHour * 60 + b.startMinute }))
    .sort((a, b) => a.roomId - b.roomId || a.start - b.start);
  const out = [];
  for (let i = 1; i < live.length; i++) {
    const a = live[i - 1];
    const b = live[i];
    if (a.roomId !== b.roomId) continue;
    const gap = b.start - a.end;
    if (gap < buffer) out.push({ roomId: a.roomId, bookingIds: [a.id, b.id], gapMinutes: gap });
  }
  return out;
}

// Per-day booking counts for a month, for the staff calendar. Cancelled and no-show bookings are left out.
router.get('/calendar', (req, res) => {
  const month = req.query.month || studioNow().date.slice(0, 7);
  if (!isValidMonth(month)) return res.status(400).json({ error: 'Use a month like 2026-10.' });
  const from = `${month}-01`;
  const to = `${month}-31`;
  const days = {};
  const day = (date) => (days[date] ||= { bookings: 0, pending: 0, blocks: 0 });
  const bookings = db
    .prepare(
      `SELECT date, status, COUNT(*) AS n FROM bookings
       WHERE date BETWEEN ? AND ? AND status IN ('pending', 'confirmed', 'completed') GROUP BY date, status`,
    )
    .all(from, to);
  for (const r of bookings) {
    const d = day(r.date);
    d.bookings += r.n;
    if (r.status === 'pending') d.pending += r.n;
  }
  const blocks = db.prepare('SELECT date, COUNT(*) AS n FROM blocks WHERE date BETWEEN ? AND ? GROUP BY date').all(from, to);
  for (const r of blocks) day(r.date).blocks += r.n;
  res.json({ month, days });
});

router.post('/blocks', (req, res) => {
  const b = req.body || {};
  const roomId = b.roomId === null || b.roomId === '' || b.roomId === undefined ? null : toInt(b.roomId);
  const start = toInt(b.startHour);
  const end = toInt(b.endHour);
  if (!isValidDate(b.date)) return res.status(400).json({ error: 'Pick a date.' });
  if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end || start < 0 || end > 24) {
    return res.status(400).json({ error: 'The end time has to be after the start time.' });
  }
  // Check and insert in one transaction so a booking cannot slip in between. Only booking bodies count: a block may
  // sit over a booking's cleaning time.
  const create = db.transaction(() => {
    const rooms = roomId === null ? db.prepare('SELECT id FROM rooms WHERE active = 1').all() : [{ id: roomId }];
    for (const r of rooms) {
      const busy = roomBusy(r.id, b.date).filter((x) => x.kind === 'booking');
      if (overlaps(busy, start * 60, end * 60)) return { ok: false };
    }
    const info = db
      .prepare('INSERT INTO blocks (room_id, date, start_hour, end_hour, reason) VALUES (?, ?, ?, ?, ?)')
      .run(roomId, b.date, start, end, cleanText(b.reason, 120));
    return { ok: true, id: info.lastInsertRowid };
  });
  const result = create();
  if (!result.ok) {
    return res.status(409).json({ error: 'There is a booking in that time. Move or cancel it first, then block the time.' });
  }
  res.status(201).json({ id: result.id });
});

router.delete('/blocks/:id', (req, res) => {
  db.prepare('DELETE FROM blocks WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
});

// ---------- Rooms ----------

function roomInput(body) {
  const name = cleanText(body.name, 60);
  const hourlyRate = toInt(body.hourlyRate);
  const capacity = toInt(body.capacity);
  const gear = Array.isArray(body.gear) ? body.gear.map((g) => cleanText(g, 80)).filter(Boolean).slice(0, 20) : [];
  const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#F2B33D';
  if (!name) return { error: 'Give the studio a name.' };
  if (!Number.isInteger(hourlyRate) || hourlyRate < 0) return { error: 'Enter the hourly rate in pesos.' };
  if (!Number.isInteger(capacity) || capacity < 1) return { error: 'Enter how many people the studio fits.' };
  return {
    value: {
      name,
      description: cleanText(body.description, 400),
      hourly_rate: hourlyRate,
      capacity,
      gear: JSON.stringify(gear),
      color,
      active: body.active === false ? 0 : 1,
      sort_order: toInt(body.sortOrder) || 0,
    },
  };
}

router.get('/rooms', (req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY sort_order, id').all().map(parseRoom);
  res.json({ rooms });
});

router.post('/rooms', (req, res) => {
  const { value, error } = roomInput(req.body || {});
  if (error) return res.status(400).json({ error });
  const info = db
    .prepare('INSERT INTO rooms (name, description, hourly_rate, capacity, gear, color, active, sort_order) VALUES (@name, @description, @hourly_rate, @capacity, @gear, @color, @active, @sort_order)')
    .run(value);
  res.status(201).json({ room: parseRoom(db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid)) });
});

router.put('/rooms/:id', (req, res) => {
  const id = toInt(req.params.id);
  if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id)) return res.status(404).json({ error: 'Studio not found.' });
  const { value, error } = roomInput(req.body || {});
  if (error) return res.status(400).json({ error });
  db.prepare(
    'UPDATE rooms SET name=@name, description=@description, hourly_rate=@hourly_rate, capacity=@capacity, gear=@gear, color=@color, active=@active, sort_order=@sort_order WHERE id=@id'
  ).run({ ...value, id });
  res.json({ room: parseRoom(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id)) });
});

router.delete('/rooms/:id', (req, res) => {
  const id = toInt(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE room_id = ?').get(id).n;
  if (used > 0) {
    return res.status(409).json({ error: 'This studio has bookings on record, so it can’t be deleted. Hide it from the website instead.' });
  }
  db.prepare('DELETE FROM blocks WHERE room_id = ?').run(id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Settings ----------

// `legacy` is the old send-to name and number from the manual GCash flow: read-only, null when never stored.
// `mail` is read-only too: whether email is set up, and the address staff emails go to. Never the password.
router.get('/settings', (req, res) => {
  const settings = getSettings();
  res.json({ settings, legacy: getLegacyGcash(), mail: mailStatus(settings) });
});

/** notify_email: '' (use the SMTP_USER address) or one plain email address. Returns the clean value, or null when bad. */
function notifyEmailInput(v) {
  if (typeof v !== 'string') return null;
  const email = v.trim();
  if (email === '') return '';
  return email.length <= 254 && isEmail(email) && !/[,;:<>()"'\\\x00-\x1f\x7f]/.test(email) ? email : null;
}

router.put('/settings', (req, res) => {
  const input = req.body || {};
  const current = getSettings();
  const next = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (input[key] === undefined) continue;
    if (key === 'notify_email') {
      next[key] = notifyEmailInput(input[key]);
      if (next[key] === null) {
        return res.status(400).json({
          error: 'Some details need fixing.',
          fields: { notify_email: 'Enter one email address like studio@gmail.com, or leave it blank to use the sending address.' },
        });
      }
    } else if (typeof def === 'boolean') next[key] = !!input[key];
    else if (typeof def === 'number') next[key] = toInt(input[key]);
    else if (Array.isArray(def)) next[key] = Array.isArray(input[key]) ? input[key].map(toInt).filter((n) => n >= 0 && n <= 6) : def;
    else next[key] = cleanText(input[key], 80);
  }
  const merged = { ...current, ...next };
  const ints = ['open_hour', 'close_hour', 'min_hours', 'max_hours', 'lead_time_hours', 'max_days_ahead', 'cancel_cutoff_hours', 'promo_buy_hours', 'promo_free_hours'];
  if (ints.some((k) => !Number.isInteger(merged[k]) || merged[k] < 0)) {
    return res.status(400).json({ error: 'Use whole numbers for hours and days.' });
  }
  if (!BUFFER_CHOICES.includes(merged.buffer_minutes)) {
    return res.status(400).json({ error: `Cleaning time has to be one of ${BUFFER_CHOICES.join(', ')} minutes.` });
  }
  if (!Number.isInteger(merged.gcash_hold_minutes) || merged.gcash_hold_minutes < 5 || merged.gcash_hold_minutes > 240) {
    return res.status(400).json({ error: 'Hold time without a screenshot has to be 5 to 240 minutes.' });
  }
  if (!Number.isInteger(merged.receipt_retention_days) || merged.receipt_retention_days < 7 || merged.receipt_retention_days > 365) {
    return res.status(400).json({ error: 'Keep payment screenshots for 7 to 365 days.' });
  }
  if (merged.open_hour >= merged.close_hour || merged.close_hour > 24) {
    return res.status(400).json({ error: 'Closing time has to be after opening time.' });
  }
  if (merged.min_hours < 1 || merged.min_hours > merged.max_hours) {
    return res.status(400).json({ error: 'Minimum hours has to be at least 1 and no more than the maximum.' });
  }
  if (merged.promo_enabled && (merged.promo_buy_hours < 1 || merged.promo_free_hours < 1)) {
    return res.status(400).json({ error: 'Set how many hours to book and how many are free.' });
  }
  const settings = saveSettings(next);
  res.json({ settings, mail: mailStatus(settings) });
});

// Sends a short test email to the address staff emails go to, and waits for the mail server's answer.
router.post('/settings/test-email', async (req, res) => {
  if (!getMailer().enabled) {
    return res.status(409).json({
      error: 'Email is not set up yet. Add SMTP_USER and SMTP_PASS to the .env file and restart the server.',
      code: 'mail_not_configured',
    });
  }
  const to = staffRecipient();
  if (!to) return res.status(409).json({ error: 'Add an email address for notifications first.', code: 'no_recipient' });
  if (!testEmailLimiter.take('all')) {
    return res.status(429).json({ error: 'Too many test emails. Wait a few minutes and try again.', code: 'rate_limited' });
  }
  const result = await sendTestEmail(to);
  if (!result.sent) {
    return res.status(502).json({
      error: 'The test email could not be sent. Check SMTP_USER and SMTP_PASS (a Gmail App Password) in the .env file, then try again.',
      code: 'mail_failed',
    });
  }
  res.json({ sent: true, to });
});

// ---------- GCash payments ----------

/** A booking as the GCash Payments page and booking dialog need it: the admin booking plus screenshots and audit trail. */
function paymentItem(id) {
  const row = getBooking(id);
  return { ...adminBooking(row), proofs: listProofs(row.id), events: listEvents(row.id) };
}

const staffNameOf = (v) => cleanText(v, 40);
const failBody = (res, result) => res.status(result.status).json(result.body);

// Every GCash booking: new-style ones with a plan, plus older manual ones under status=older.
router.get('/payments', (req, res) => {
  const where = ["b.payment_method = 'gcash'"];
  const params = [];
  const { status, balance } = req.query;
  if (['awaiting_proof', 'proof_submitted', 'not_received'].includes(status)) {
    where.push("b.payment_plan != '' AND b.status = 'pending' AND b.payment_status = ?");
    params.push(status);
  } else if (status === 'received') where.push("b.payment_status = 'received'");
  else if (status === 'expired') where.push("b.payment_plan != '' AND b.status = 'expired'");
  else if (status === 'older') where.push("b.payment_plan = ''");
  if (balance === 'due') {
    where.push("b.payment_status = 'received' AND b.total - b.paid_amount - b.balance_paid > 0 AND b.status NOT IN ('cancelled', 'expired')");
  }
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const offset = Math.max(toInt(req.query.offset) || 0, 0);
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM bookings b ${clause}`).get(...params).n;
  const rows = db
    .prepare(
      `${BOOKING_SELECT} ${clause}
       ORDER BY (b.status = 'pending' AND b.payment_status = 'proof_submitted') DESC, b.created_at DESC, b.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const waitingCount = db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending' AND payment_status = 'proof_submitted'")
    .get().n;
  res.json({
    total,
    waitingCount,
    bookings: adminBookings(rows).map((b) => ({ ...b, proofs: listProofs(b.id), events: listEvents(b.id) })),
  });
});

// Registered before /payments/:id so "proofs" is never read as an id.
router.get('/payments/proofs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM payment_proofs WHERE id = ? AND deleted_at IS NULL').get(toInt(req.params.id));
  const full = row && receiptPath(row.file);
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'Screenshot not found.' });
  res.sendFile(full, {
    dotfiles: 'deny',
    cacheControl: false,
    lastModified: false,
    headers: {
      'Content-Type': row.mime,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
});

router.get('/payments/:id', (req, res) => {
  const id = toInt(req.params.id);
  if (!getBooking(id)) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ booking: paymentItem(id) });
});

router.post('/payments/:id/confirm', (req, res) => {
  const id = toInt(req.params.id);
  const body = req.body || {};
  const amount = body.amount === undefined || body.amount === null ? undefined : toInt(body.amount);
  const result = confirmDeposit(id, { staffName: staffNameOf(body.staffName), amount });
  // Holds that the confirm's own sweep expired (committed even if the confirm was refused) still get their email,
  // except this booking itself, which is being revived or confirmed.
  for (const r of result.expired || []) if (r.id !== id && r.email) void notify('holdExpired', r);
  if (!result.ok) return failBody(res, result);
  const row = getBooking(id);
  void notify('confirmed', row);
  res.json({ booking: paymentItem(id), emailQueued: willEmail(row) });
});

router.post('/payments/:id/not-received', (req, res) => {
  const id = toInt(req.params.id);
  const body = req.body || {};
  const result = markNotReceived(id, { staffName: staffNameOf(body.staffName), note: cleanText(body.note, 300) });
  if (!result.ok) return failBody(res, result);
  const row = getBooking(id);
  void notify('notReceived', row);
  res.json({ booking: paymentItem(id), emailQueued: willEmail(row) });
});

// The other half of a 50% booking. Headers: X-Balance-Method (cash | gcash), optional X-Balance-Amount (must equal the
// balance), X-Staff-Name, X-Note. For gcash the body is the raw screenshot (required); for cash there is no body.
const balanceUpload = express.raw({ type: RECEIPT_TYPES, limit: MAX_RECEIPT_BYTES });

router.post('/payments/:id/balance', balanceUpload, (req, res) => {
  const id = toInt(req.params.id);
  const method = String(req.get('x-balance-method') || '').trim().toLowerCase();
  if (!['cash', 'gcash'].includes(method)) {
    return res.status(400).json({ error: 'Say how the balance was paid: cash or gcash.' });
  }
  const amountHeader = req.get('x-balance-amount');
  let amount;
  if (amountHeader !== undefined && amountHeader !== '') {
    amount = /^\d{1,7}$/.test(amountHeader.trim()) ? Number(amountHeader.trim()) : NaN;
    if (!Number.isInteger(amount)) return res.status(400).json({ error: 'The balance amount has to be whole pesos.' });
  }
  const hasBody = Buffer.isBuffer(req.body) && req.body.length > 0;

  let saved = null;
  let image;
  if (method === 'gcash') {
    if (!hasBody) {
      // A body that was sent but is not an accepted image type is a 415, same as the customer upload.
      const sentSomething = Number(req.get('content-length')) > 0 || !!req.get('transfer-encoding');
      if (sentSomething && !req.is(RECEIPT_TYPES)) return res.status(415).json({ error: 'That file is not a JPEG, PNG or WebP image.' });
      return res.status(400).json({ error: 'Upload the screenshot of the GCash payment.' });
    }
    const type = receiptType(req.body, req.get('content-type'));
    if (!type) return res.status(415).json({ error: 'That file is not a JPEG, PNG or WebP image.' });
    saved = saveReceipt(req.body, type.ext);
    image = { file: saved.file, mime: type.mime, bytes: req.body.length, sha256: saved.sha256 };
  } else if (hasBody) {
    return res.status(400).json({ error: 'A cash payment does not need a screenshot.' });
  }

  let result;
  try {
    result = recordBalance(id, {
      staffName: staffNameOf(req.get('x-staff-name')),
      method,
      amount,
      note: cleanText(req.get('x-note'), 300),
      image,
    });
  } catch (err) {
    if (saved) removeReceipt(saved.file);
    throw err;
  }
  if (!result.ok) {
    if (saved) removeReceipt(saved.file);
    return failBody(res, result);
  }
  res.json({ booking: paymentItem(id) });
});

router.post('/payments/:id/refund', (req, res) => {
  const id = toInt(req.params.id);
  const body = req.body || {};
  const method = String(body.method || '').toLowerCase();
  if (!['cash', 'gcash'].includes(method)) return res.status(400).json({ error: 'Say how the refund was paid: cash or gcash.' });
  const result = recordRefund(id, {
    staffName: staffNameOf(body.staffName),
    amount: toInt(body.amount),
    method,
    note: cleanText(body.note, 300),
  });
  if (!result.ok) return failBody(res, result);
  res.json({ booking: paymentItem(id) });
});

// The studio's own GCash / InstaPay QR. The owner uploads the picture, the browser decodes it, and only the text is
// sent here. It is never returned: the owner sees a masked summary and the customer sees one rendered QR per booking.
const qrSummary = () => {
  const payload = getGcashQr();
  return payload ? { configured: true, ...maskSummary(payload) } : { configured: false, merchantName: '', city: '', accountHint: '' };
};

router.get('/settings/gcash-qr', (req, res) => res.json(qrSummary()));

router.put('/settings/gcash-qr', (req, res) => {
  const payload = req.body?.payload;
  const check = validateStaticQr(payload);
  if (!check.ok) return res.status(400).json({ error: check.error });
  saveGcashQr(payload);
  res.json(qrSummary());
});

router.delete('/settings/gcash-qr', (req, res) => {
  saveGcashQr(null);
  res.json(qrSummary());
});

// A test QR with a small amount, so the owner can scan it in GCash before customers do.
router.post('/settings/gcash-qr/preview', async (req, res) => {
  const payload = getGcashQr();
  if (!payload) return res.status(409).json({ error: 'Upload your GCash QR first.' });
  const amount = pesoText(toInt(req.body?.amount));
  if (!amount) return res.status(400).json({ error: 'Enter an amount in whole pesos.' });
  const qrSvg = await QRCode.toString(withAmount(payload, amount), { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
  res.set('Cache-Control', 'no-store');
  res.json({ amount, qrSvg });
});

// ---------- Studio page content: contact details and gallery ----------

const MESSENGER_HOSTS = ['m.me', 'messenger.com', 'facebook.com'];

function httpsUrl(v, max = 300) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

const isBlank = (v) => v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// Returns { value } with null meaning "reset to default", or { error }.
const CONTACT_RULES = {
  address(v) {
    if (!Array.isArray(v) || v.some((l) => typeof l !== 'string')) return { error: 'Enter the address as one to three lines.' };
    const lines = v.map((l) => l.trim()).filter(Boolean);
    if (v.some((l) => CONTROL_CHARS.test(l))) return { error: 'Remove special characters from the address.' };
    if (lines.length < 1 || lines.length > 3) return { error: 'Use one to three address lines.' };
    if (lines.some((l) => l.length > 120)) return { error: 'Keep each address line under 120 characters.' };
    return { value: lines };
  },
  landmark(v) {
    if (typeof v !== 'string') return { error: 'Enter the landmark as text.' };
    if (v.trim().length > 200) return { error: 'Keep the landmark under 200 characters.' };
    if (CONTROL_CHARS.test(v)) return { error: 'Remove special characters from the landmark.' };
    return { value: v.trim() };
  },
  mapsQuery(v) {
    if (typeof v !== 'string') return { error: 'Enter the map search text.' };
    if (v.trim().length > 200) return { error: 'Keep the map search text under 200 characters.' };
    if (CONTROL_CHARS.test(v)) return { error: 'Remove special characters from the map search text.' };
    return { value: v.trim() };
  },
  phone(v) {
    if (typeof v !== 'string' || !/^[+\d][\d\s()-]{6,19}$/.test(v.trim())) return { error: 'Enter a phone number like 0917 123 4567.' };
    return { value: v.trim() };
  },
  email(v) {
    if (typeof v !== 'string' || v.trim().length > 120 || !isEmail(v.trim())) return { error: 'Check the email address.' };
    return { value: v.trim() };
  },
  messenger(v) {
    const u = httpsUrl(v);
    if (!u) return { error: 'Enter a Messenger link that starts with https://.' };
    const host = u.hostname.toLowerCase();
    if (!MESSENGER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      return { error: 'Use a Messenger link (m.me, messenger.com or facebook.com).' };
    }
    return { value: v.trim() };
  },
  socials(v) {
    if (!Array.isArray(v)) return { error: 'Enter the social links as a list.' };
    if (v.length > 6) return { error: 'Add up to 6 social links.' };
    const out = [];
    for (const s of v) {
      const label = typeof s?.label === 'string' ? s.label.trim() : '';
      if (!label || label.length > 30) return { error: 'Give each social link a name of up to 30 characters.' };
      if (!httpsUrl(s.href)) return { error: 'Each social link needs an address that starts with https://.' };
      out.push({ label, href: s.href.trim() });
    }
    return { value: out };
  },
};

router.get('/content', (req, res) => {
  res.json({ contact: getContent(), gallery: listGallery() });
});

router.put('/content/contact', (req, res) => {
  const input = req.body && typeof req.body === 'object' ? req.body : {};
  const next = {};
  const fields = {};
  for (const [field, rule] of Object.entries(CONTACT_RULES)) {
    if (input[field] === undefined) continue;
    // Empty string, null or an empty list removes the stored value.
    if (isBlank(input[field])) {
      next[field] = null;
      continue;
    }
    const r = rule(input[field]);
    if (r.error) fields[field] = r.error;
    else next[field] = r.value;
  }
  if (Object.keys(fields).length) return res.status(400).json({ error: 'Some details need fixing.', fields });
  res.json({ contact: saveContent(next) });
});

const galleryUpload = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_UPLOAD_BYTES });

router.post('/gallery', galleryUpload, (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(415).json({ error: 'Upload a JPEG, PNG or WebP photo.' });
  }
  const ext = imageExtension(req.body);
  if (!ext) return res.status(415).json({ error: 'That file is not a JPEG, PNG or WebP photo.' });
  const alt = typeof req.query.alt === 'string' ? req.query.alt.trim() : '';
  if (alt.length > 160) return res.status(400).json({ error: 'Keep the photo description under 160 characters.' });
  if (db.prepare('SELECT COUNT(*) AS n FROM gallery_photos').get().n >= MAX_PHOTOS) {
    return res.status(409).json({ error: `The gallery is full (${MAX_PHOTOS} photos). Delete one to add another.` });
  }

  const file = `${crypto.randomUUID()}${ext}`;
  const dest = path.join(GALLERY_DIR, file);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, req.body);
  fs.renameSync(tmp, dest);
  let row;
  try {
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM gallery_photos').get().n;
    const info = db.prepare('INSERT INTO gallery_photos (file, alt, sort_order) VALUES (?, ?, ?)').run(file, alt, next);
    row = db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(info.lastInsertRowid);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  res.status(201).json({ photo: galleryPhoto(row) });
});

// Registered before the /gallery/:id routes.
router.put('/gallery/order', (req, res) => {
  const ids = req.body?.ids;
  const current = db.prepare('SELECT id FROM gallery_photos').all().map((r) => r.id);
  const valid =
    Array.isArray(ids) &&
    ids.length === current.length &&
    ids.every((id) => Number.isInteger(id)) &&
    new Set(ids).size === ids.length &&
    ids.every((id) => current.includes(id));
  if (!valid) return res.status(400).json({ error: 'Send every photo id exactly once.' });
  const update = db.prepare('UPDATE gallery_photos SET sort_order = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => update.run(i + 1, id)))();
  res.json({ gallery: listGallery() });
});

router.patch('/gallery/:id', (req, res) => {
  const id = toInt(req.params.id);
  if (typeof req.body?.alt !== 'string' || req.body.alt.trim().length > 160) {
    return res.status(400).json({ error: 'Keep the photo description under 160 characters.' });
  }
  const info = db.prepare('UPDATE gallery_photos SET alt = ? WHERE id = ?').run(req.body.alt.trim(), id);
  if (!info.changes) return res.status(404).json({ error: 'Photo not found.' });
  res.json({ photo: galleryPhoto(db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(id)) });
});

router.delete('/gallery/:id', (req, res) => {
  const id = toInt(req.params.id);
  const row = db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Photo not found.' });
  db.prepare('DELETE FROM gallery_photos WHERE id = ?').run(id);
  const full = galleryPath(row.file);
  if (full) {
    try {
      fs.rmSync(full, { force: true });
    } catch (err) {
      console.warn(`[gallery] could not delete ${row.file}: ${err.code || err.message}`);
    }
  }
  res.json({ ok: true });
});

export default router;
