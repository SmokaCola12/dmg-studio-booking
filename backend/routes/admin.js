import { Router } from 'express';
import { db, getSettings, saveSettings, parseRoom, DEFAULT_SETTINGS } from '../db.js';
import { checkPassword, issueToken, requireAdmin, loginThrottle } from '../lib/auth.js';
import { studioNow, isValidDate, addDays, weekday } from '../lib/time.js';
import { planBooking, roomBusy, overlaps, isValidMonth } from '../lib/scheduling.js';
import { normalizePhone, cleanText, isEmail, bookingCode, toInt } from '../lib/validate.js';

const router = Router();
const STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
const HOLDING = ['pending', 'confirmed'];

router.post('/login', loginThrottle, (req, res) => {
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: 'That password is not correct.' });
  }
  res.json({ token: issueToken() });
});

router.use(requireAdmin);

function adminBooking(b) {
  return {
    id: b.id,
    code: b.code,
    roomId: b.room_id,
    roomName: b.room_name,
    roomColor: b.room_color,
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
    source: b.source,
    adminNotes: b.admin_notes,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

const BOOKING_SELECT = `
  SELECT b.*, r.name AS room_name, r.color AS room_color
  FROM bookings b JOIN rooms r ON r.id = b.room_id`;

const getBooking = (id) => db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id);

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

  const todayBookings = db
    .prepare(`${BOOKING_SELECT} WHERE b.date = ? AND b.status IN ('pending','confirmed','completed','no_show') ORDER BY b.start_hour, r.sort_order`)
    .all(today)
    .map(adminBooking);

  const pending = db
    .prepare(`${BOOKING_SELECT} WHERE b.status = 'pending' AND b.date >= ? ORDER BY b.date, b.start_hour LIMIT 20`)
    .all(today)
    .map(adminBooking);
  const pendingCount = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending' AND date >= ?").get(today).n;

  const revenue = (from, to) =>
    db
      .prepare("SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS n FROM bookings WHERE date BETWEEN ? AND ? AND status IN ('confirmed','completed')")
      .get(from, to);

  const upcoming = db
    .prepare(
      `${BOOKING_SELECT} WHERE b.status = 'confirmed' AND (b.date > ? OR (b.date = ? AND b.start_hour >= ?))
       ORDER BY b.date, b.start_hour LIMIT 8`
    )
    .all(today, today, now.hour)
    .map(adminBooking);

  res.json({
    now,
    today: todayBookings,
    pending,
    pendingCount,
    week: { from: weekStart, to: weekEnd, ...revenue(weekStart, weekEnd) },
    month: { from: monthStart, to: monthEnd(today), ...revenue(monthStart, monthEnd(today)) },
    upcoming,
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
        ? 'b.date ASC, b.start_hour ASC'
        : 'b.date DESC, b.start_hour DESC';
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const offset = Math.max(toInt(req.query.offset) || 0, 0);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM bookings b ${clause}`).get(...params).n;
  const rows = db.prepare(`${BOOKING_SELECT} ${clause} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ total, limit, offset, bookings: rows.map(adminBooking) });
});

router.get('/bookings/:id', (req, res) => {
  const b = getBooking(toInt(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ booking: adminBooking(b) });
});

// Walk-ins and phone bookings entered by staff. Skips lead time; confirmed right away.
router.post('/bookings', (req, res) => {
  const b = req.body || {};
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
      paidHours: toInt(b.paidHours),
      ignoreLeadTime: true,
    });
    if (!plan.ok) return plan;
    let code;
    do code = bookingCode();
    while (db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code));
    const info = db
      .prepare(
        `INSERT INTO bookings (code, room_id, date, start_hour, paid_hours, free_hours, end_hour,
          customer_name, band_name, phone, email, headcount, notes, payment_method, payment_ref,
          hourly_rate, total, status, source, admin_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'walk_in', ?)`
      )
      .run(
        code, plan.room.id, b.date, plan.startHour, plan.paidHours, plan.freeHours, plan.endHour,
        name, cleanText(b.bandName, 80), phone || '', email, Math.max(toInt(b.headcount) || 1, 1),
        cleanText(b.notes, 500), b.paymentMethod === 'gcash' ? 'gcash' : 'pay_at_studio',
        cleanText(b.paymentRef, 40), plan.hourlyRate, plan.total, cleanText(b.adminNotes, 500)
      );
    return { ok: true, id: info.lastInsertRowid };
  });
  const result = create();
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.status(201).json({ booking: adminBooking(getBooking(result.id)) });
});

router.patch('/bookings/:id', (req, res) => {
  const id = toInt(req.params.id);
  const body = req.body || {};

  const update = db.transaction(() => {
    const current = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!current) return { ok: false, status: 404, error: 'Booking not found.' };

    const next = { ...current };
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return { ok: false, status: 400, error: 'Unknown status.' };
      next.status = body.status;
    }
    if (body.adminNotes !== undefined) next.admin_notes = cleanText(body.adminNotes, 500);
    if (body.paymentRef !== undefined) next.payment_ref = cleanText(body.paymentRef, 40);

    const reschedule = ['roomId', 'date', 'startHour', 'paidHours'].some((k) => body[k] !== undefined);
    const reactivating = HOLDING.includes(next.status) && !HOLDING.includes(current.status);

    if (reschedule || reactivating) {
      const roomId = body.roomId !== undefined ? toInt(body.roomId) : current.room_id;
      const date = body.date !== undefined ? body.date : current.date;
      if (!isValidDate(date)) return { ok: false, status: 400, error: 'Pick a valid date.' };
      const plan = planBooking({
        roomId,
        date,
        startHour: body.startHour !== undefined ? toInt(body.startHour) : current.start_hour,
        paidHours: body.paidHours !== undefined ? toInt(body.paidHours) : current.paid_hours,
        excludeBookingId: id,
        ignoreLeadTime: true,
      });
      if (!plan.ok) return { ok: false, status: 409, error: plan.error };
      Object.assign(next, {
        room_id: plan.room.id,
        date,
        start_hour: plan.startHour,
        paid_hours: plan.paidHours,
        free_hours: plan.freeHours,
        end_hour: plan.endHour,
        hourly_rate: reschedule ? plan.hourlyRate : current.hourly_rate,
        total: reschedule ? plan.total : current.total,
      });
    }

    db.prepare(
      `UPDATE bookings SET status = ?, admin_notes = ?, payment_ref = ?, room_id = ?, date = ?, start_hour = ?,
         paid_hours = ?, free_hours = ?, end_hour = ?, hourly_rate = ?, total = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      next.status, next.admin_notes, next.payment_ref, next.room_id, next.date, next.start_hour,
      next.paid_hours, next.free_hours, next.end_hour, next.hourly_rate, next.total, id
    );
    return { ok: true };
  });

  const result = update();
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ booking: adminBooking(getBooking(id)) });
});

// ---------- Day schedule & blocks ----------

router.get('/schedule', (req, res) => {
  const date = req.query.date || studioNow().date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'Use a date like 2026-10-25.' });
  const bookings = db
    .prepare(`${BOOKING_SELECT} WHERE b.date = ? ORDER BY b.start_hour`)
    .all(date)
    .map(adminBooking);
  const blocks = db.prepare('SELECT * FROM blocks WHERE date = ? ORDER BY start_hour').all(date).map((b) => ({
    id: b.id, roomId: b.room_id, date: b.date, startHour: b.start_hour, endHour: b.end_hour, reason: b.reason,
  }));
  const rooms = db
    .prepare('SELECT * FROM rooms WHERE active = 1 OR id IN (SELECT room_id FROM bookings WHERE date = ?) ORDER BY sort_order, id')
    .all(date)
    .map(parseRoom);
  res.json({ date, now: studioNow(), settings: getSettings(), rooms, bookings, blocks });
});

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
  const rooms = roomId === null ? db.prepare('SELECT id FROM rooms WHERE active = 1').all() : [{ id: roomId }];
  for (const r of rooms) {
    const busy = roomBusy(r.id, b.date).filter((x) => x.kind === 'booking');
    if (overlaps(busy, start, end)) {
      return res.status(409).json({ error: 'There is a booking in that time. Move or cancel it first, then block the time.' });
    }
  }
  const info = db
    .prepare('INSERT INTO blocks (room_id, date, start_hour, end_hour, reason) VALUES (?, ?, ?, ?, ?)')
    .run(roomId, b.date, start, end, cleanText(b.reason, 120));
  res.status(201).json({ id: info.lastInsertRowid });
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
  if (!name) return { error: 'Give the room a name.' };
  if (!Number.isInteger(hourlyRate) || hourlyRate < 0) return { error: 'Enter the hourly rate in pesos.' };
  if (!Number.isInteger(capacity) || capacity < 1) return { error: 'Enter how many people the room fits.' };
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
  if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id)) return res.status(404).json({ error: 'Room not found.' });
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
    return res.status(409).json({ error: 'This room has bookings on record, so it can’t be deleted. Hide it from the website instead.' });
  }
  db.prepare('DELETE FROM blocks WHERE room_id = ?').run(id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Settings ----------

router.get('/settings', (req, res) => res.json({ settings: getSettings() }));

router.put('/settings', (req, res) => {
  const input = req.body || {};
  const current = getSettings();
  const next = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (input[key] === undefined) continue;
    if (typeof def === 'boolean') next[key] = !!input[key];
    else if (typeof def === 'number') next[key] = toInt(input[key]);
    else if (Array.isArray(def)) next[key] = Array.isArray(input[key]) ? input[key].map(toInt).filter((n) => n >= 0 && n <= 6) : def;
    else next[key] = cleanText(input[key], 80);
  }
  const merged = { ...current, ...next };
  const ints = ['open_hour', 'close_hour', 'min_hours', 'max_hours', 'lead_time_hours', 'max_days_ahead', 'cancel_cutoff_hours', 'promo_buy_hours', 'promo_free_hours'];
  if (ints.some((k) => !Number.isInteger(merged[k]) || merged[k] < 0)) {
    return res.status(400).json({ error: 'Use whole numbers for hours and days.' });
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
  res.json({ settings: saveSettings(next) });
});

export default router;
