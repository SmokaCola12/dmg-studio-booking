import { db, getSettings } from '../db.js';
import { studioNow, daysBetween, weekday, hoursUntil, addDays } from './time.js';

const ACTIVE_STATUSES = ['pending', 'confirmed'];

/** Bookings that hold a time slot (pending or confirmed) plus blocks, for one date. */
export function busyForDate(date) {
  const bookings = db
    .prepare(
      `SELECT * FROM bookings WHERE date = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
       ORDER BY start_hour`
    )
    .all(date, ...ACTIVE_STATUSES);
  const blocks = db.prepare('SELECT * FROM blocks WHERE date = ? ORDER BY start_hour').all(date);
  return { bookings, blocks };
}

/** Busy intervals for one room on one date: [{ start, end, kind }] */
export function roomBusy(roomId, date, { excludeBookingId } = {}) {
  const { bookings, blocks } = busyForDate(date);
  return [
    ...bookings
      .filter((b) => b.room_id === roomId && b.id !== excludeBookingId)
      .map((b) => ({ start: b.start_hour, end: b.end_hour, kind: 'booking' })),
    ...blocks
      .filter((b) => b.room_id === null || b.room_id === roomId)
      .map((b) => ({ start: b.start_hour, end: b.end_hour, kind: 'block' })),
  ].sort((a, b) => a.start - b.start);
}

export function overlaps(busy, start, end) {
  return busy.some((b) => start < b.end && end > b.start);
}

/** Free hours promo: "book X hours, get Y free" applies once per booking. */
export function promoFreeHours(paidHours, settings = getSettings()) {
  if (!settings.promo_enabled) return 0;
  return paidHours >= settings.promo_buy_hours ? settings.promo_free_hours : 0;
}

/**
 * Checks whether a date is bookable at all, and returns the earliest
 * start hour allowed for that date (respects opening hours and lead time).
 */
export function dateWindow(date, { ignoreLeadTime = false } = {}) {
  const s = getSettings();
  const now = studioNow();
  const diff = daysBetween(now.date, date);

  if (diff < 0) return { open: false, reason: 'That date has already passed.' };
  if (!ignoreLeadTime && diff > s.max_days_ahead)
    return { open: false, reason: `Bookings open up to ${s.max_days_ahead} days ahead.` };
  if (s.closed_weekdays.includes(weekday(date)))
    return { open: false, reason: 'The studio is closed on this day.' };

  let earliest = s.open_hour;
  if (!ignoreLeadTime && diff === 0) {
    const minStart = Math.ceil(now.hour + now.minute / 60 + s.lead_time_hours);
    earliest = Math.max(earliest, minStart);
  }
  if (earliest >= s.close_hour) return { open: false, reason: 'No more slots left today.' };
  return { open: true, earliest, openHour: s.open_hour, closeHour: s.close_hour };
}

const FEW_START_HOURS = 3;

/** True for "YYYY-MM" with a month from 01 to 12. */
export function isValidMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/**
 * Per-day availability summary for a month (read-only, two range queries).
 * status: closed (dateWindow not open), full (no active room has min_hours free in a row),
 * few (fewer than 3 bookable start hours across all active rooms), else open.
 * freeHours = free hours summed across active rooms between the earliest start and closing.
 */
export function monthAvailability(month) {
  const s = getSettings();
  const first = `${month}-01`;
  const dates = [];
  for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1)) dates.push(d);
  const last = dates[dates.length - 1];

  const rooms = db.prepare('SELECT id FROM rooms WHERE active = 1').all();
  const bookings = db
    .prepare(
      `SELECT room_id, date, start_hour, end_hour FROM bookings
       WHERE date BETWEEN ? AND ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
    )
    .all(first, last, ...ACTIVE_STATUSES);
  const blocks = db.prepare('SELECT room_id, date, start_hour, end_hour FROM blocks WHERE date BETWEEN ? AND ?').all(first, last);

  const byDate = new Map();
  for (const row of [...bookings.map((b) => ({ ...b, kind: 'b' })), ...blocks.map((b) => ({ ...b, kind: 'k' }))]) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const days = dates.map((date) => {
    const win = dateWindow(date);
    if (!win.open) return { date, status: 'closed', freeHours: 0, reason: win.reason };

    const rows = byDate.get(date) || [];
    let freeHours = 0;
    let startHours = 0;
    for (const room of rooms) {
      const busy = rows
        .filter((r) => (r.kind === 'k' ? r.room_id === null || r.room_id === room.id : r.room_id === room.id))
        .map((r) => ({ start: r.start_hour, end: r.end_hour }));
      for (let h = win.earliest; h < win.closeHour; h++) {
        if (!overlaps(busy, h, h + 1)) freeHours++;
      }
      for (let h = win.earliest; h + s.min_hours <= win.closeHour; h++) {
        if (!overlaps(busy, h, h + s.min_hours)) startHours++;
      }
    }
    const status = startHours === 0 ? 'full' : startHours < FEW_START_HOURS ? 'few' : 'open';
    return { date, status, freeHours };
  });

  return { month, now: studioNow(), days };
}

/**
 * Works out the reserved block for a requested booking.
 * The free promo hour is added only when it fits before closing and before the next booking.
 */
export function planBooking({ roomId, date, startHour, paidHours, excludeBookingId, ignoreLeadTime = false }) {
  const s = getSettings();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room || (!room.active && !ignoreLeadTime)) return { ok: false, error: 'That room is not available.' };

  if (!Number.isInteger(paidHours) || paidHours < s.min_hours || paidHours > s.max_hours)
    return { ok: false, error: `Bookings are ${s.min_hours} to ${s.max_hours} hours long.` };
  if (!Number.isInteger(startHour)) return { ok: false, error: 'Pick a start time.' };

  const win = dateWindow(date, { ignoreLeadTime });
  if (!win.open) return { ok: false, error: win.reason };
  if (startHour < win.earliest) return { ok: false, error: 'That start time is no longer available.' };

  const paidEnd = startHour + paidHours;
  if (paidEnd > s.close_hour) return { ok: false, error: 'That booking runs past closing time.' };

  const busy = roomBusy(room.id, date, { excludeBookingId });
  if (overlaps(busy, startHour, paidEnd))
    return { ok: false, error: 'Someone already has part of that time. Pick another start time.' };

  let freeHours = promoFreeHours(paidHours, s);
  let freeNote = '';
  if (freeHours > 0) {
    const freeEnd = paidEnd + freeHours;
    if (freeEnd > s.close_hour || overlaps(busy, paidEnd, freeEnd)) {
      freeHours = 0;
      freeNote = 'The free hour does not fit after this slot. Start earlier to get it.';
    }
  }

  return {
    ok: true,
    room,
    startHour,
    paidHours,
    freeHours,
    endHour: paidEnd + freeHours,
    hourlyRate: room.hourly_rate,
    total: paidHours * room.hourly_rate,
    freeNote,
  };
}

export function canCustomerCancel(booking) {
  const s = getSettings();
  if (!ACTIVE_STATUSES.includes(booking.status)) return false;
  return hoursUntil(booking.date, booking.start_hour) >= s.cancel_cutoff_hours;
}
