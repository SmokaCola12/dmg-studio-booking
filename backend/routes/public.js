import { Router } from 'express';
import { db, getSettings, parseRoom } from '../db.js';
import { studioNow, isValidDate, STUDIO_TZ } from '../lib/time.js';
import { dateWindow, planBooking, roomBusy, canCustomerCancel } from '../lib/scheduling.js';
import { normalizePhone, cleanText, isEmail, bookingCode, toInt } from '../lib/validate.js';

const router = Router();

const PUBLIC_SETTING_KEYS = [
  'open_hour', 'close_hour', 'min_hours', 'max_hours', 'lead_time_hours', 'max_days_ahead',
  'cancel_cutoff_hours', 'auto_confirm', 'promo_enabled', 'promo_buy_hours', 'promo_free_hours',
  'gcash_enabled', 'gcash_name', 'gcash_number', 'closed_weekdays',
];

export function publicBooking(b) {
  const room = db.prepare('SELECT id, name, color FROM rooms WHERE id = ?').get(b.room_id);
  return {
    code: b.code,
    room,
    date: b.date,
    startHour: b.start_hour,
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
    createdAt: b.created_at,
  };
}

router.get('/site', (req, res) => {
  const s = getSettings();
  const rooms = db
    .prepare('SELECT * FROM rooms WHERE active = 1 ORDER BY sort_order, id')
    .all()
    .map(parseRoom)
    .map(({ id, name, description, hourly_rate, capacity, gear, color }) => ({
      id, name, description, hourlyRate: hourly_rate, capacity, gear, color,
    }));
  const settings = Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, s[k]]));
  res.json({ rooms, settings, now: studioNow(), timeZone: STUDIO_TZ });
});

router.get('/availability', (req, res) => {
  const date = req.query.date || studioNow().date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'Use a date like 2026-10-25.' });
  const rooms = db.prepare('SELECT id FROM rooms WHERE active = 1 ORDER BY sort_order, id').all();
  res.json({
    date,
    now: studioNow(),
    window: dateWindow(date),
    rooms: rooms.map((r) => ({ id: r.id, busy: roomBusy(r.id, date) })),
  });
});

router.post('/bookings', (req, res) => {
  const b = req.body || {};
  const s = getSettings();

  const name = cleanText(b.name, 80);
  const phone = normalizePhone(b.phone);
  const email = cleanText(b.email, 120);
  const headcount = toInt(b.headcount ?? 1);
  const paymentMethod = b.paymentMethod === 'gcash' && s.gcash_enabled ? 'gcash' : 'pay_at_studio';
  const paymentRef = cleanText(b.paymentRef, 40);

  const errors = {};
  if (!name) errors.name = 'Enter the name of the person booking.';
  if (!phone) errors.phone = 'Enter a mobile number like 0917 123 4567.';
  if (email && !isEmail(email)) errors.email = 'Check the email address.';
  if (!Number.isInteger(headcount) || headcount < 1 || headcount > 30) errors.headcount = 'Enter how many people are coming.';
  if (!isValidDate(b.date)) errors.date = 'Pick a date.';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Some details need fixing.', fields: errors });

  const create = db.transaction(() => {
    const plan = planBooking({
      roomId: toInt(b.roomId),
      date: b.date,
      startHour: toInt(b.startHour),
      paidHours: toInt(b.paidHours),
    });
    if (!plan.ok) return plan;
    if (headcount > plan.room.capacity) {
      return { ok: false, error: `${plan.room.name} fits up to ${plan.room.capacity} people.` };
    }

    let code;
    do code = bookingCode();
    while (db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code));

    const info = db
      .prepare(
        `INSERT INTO bookings (code, room_id, date, start_hour, paid_hours, free_hours, end_hour,
          customer_name, band_name, phone, email, headcount, notes, payment_method, payment_ref,
          hourly_rate, total, status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online')`
      )
      .run(
        code, plan.room.id, b.date, plan.startHour, plan.paidHours, plan.freeHours, plan.endHour,
        name, cleanText(b.bandName, 80), phone, email, headcount, cleanText(b.notes, 500),
        paymentMethod, paymentRef, plan.hourlyRate, plan.total, s.auto_confirm ? 'confirmed' : 'pending'
      );
    return { ok: true, id: info.lastInsertRowid, freeNote: plan.freeNote };
  });

  const result = create();
  if (!result.ok) return res.status(409).json({ error: result.error });
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.id);
  res.status(201).json({ booking: publicBooking(row), freeNote: result.freeNote });
});

function findCustomerBooking(code, phone) {
  const normalized = normalizePhone(phone);
  if (!code || !normalized) return null;
  const row = db.prepare('SELECT * FROM bookings WHERE code = ?').get(String(code).trim().toUpperCase());
  return row && row.phone === normalized ? row : null;
}

router.post('/bookings/lookup', (req, res) => {
  const row = findCustomerBooking(req.body?.code, req.body?.phone);
  if (!row) return res.status(404).json({ error: 'No booking matches that code and mobile number.' });
  res.json({ booking: publicBooking(row) });
});

router.post('/bookings/cancel', (req, res) => {
  const row = findCustomerBooking(req.body?.code, req.body?.phone);
  if (!row) return res.status(404).json({ error: 'No booking matches that code and mobile number.' });
  if (!canCustomerCancel(row)) {
    const s = getSettings();
    return res.status(409).json({
      error: `This booking can no longer be cancelled online. Bookings can be cancelled up to ${s.cancel_cutoff_hours} hours before the start time — message the studio instead.`,
    });
  }
  db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(row.id);
  res.json({ booking: publicBooking(db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.id)) });
});

// Same room and same paid hours; only the date and start time move. Same cutoff as cancelling.
router.post('/bookings/reschedule', (req, res) => {
  const row = findCustomerBooking(req.body?.code, req.body?.phone);
  if (!row) return res.status(404).json({ error: 'No booking matches that code and mobile number.' });
  if (!canCustomerCancel(row)) {
    const s = getSettings();
    return res.status(409).json({
      error: `This booking can no longer be changed online. Bookings can be moved up to ${s.cancel_cutoff_hours} hours before the start time — message the studio instead.`,
    });
  }
  if (!isValidDate(req.body?.date)) return res.status(400).json({ error: 'Pick a new date.' });
  const date = req.body.date;
  const startHour = toInt(req.body.startHour);
  if (date === row.date && startHour === row.start_hour) {
    return res.status(400).json({ error: 'That is the time you already have. Pick a different one.' });
  }

  const move = db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.id);
    if (!canCustomerCancel(fresh)) return { ok: false, error: 'This booking can no longer be changed online.' };
    const plan = planBooking({
      roomId: fresh.room_id,
      date,
      startHour,
      paidHours: fresh.paid_hours,
      excludeBookingId: fresh.id,
    });
    if (!plan.ok) return plan;
    db.prepare(
      `UPDATE bookings SET date = ?, start_hour = ?, free_hours = ?, end_hour = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(date, plan.startHour, plan.freeHours, plan.endHour, fresh.id);
    return { ok: true, freeNote: plan.freeNote };
  });

  const result = move();
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json({
    booking: publicBooking(db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.id)),
    freeNote: result.freeNote,
  });
});

export default router;
