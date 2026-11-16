import { db, getSettings } from '../db.js';
import { studioNow, daysBetween, weekday, hoursUntil, addDays } from './time.js';

const ACTIVE_STATUSES = ['pending', 'confirmed'];

/** Current instant as a UTC ISO string, the format hold_expires_at is stored and compared in. */
export const nowIso = () => new Date().toISOString();

/**
 * The one rule for "this booking holds its time slot": it is pending or confirmed, and not a pending GCash booking
 * whose hold has run out (even if the sweep has not marked it expired yet). Every slot query uses this fragment.
 * Returns { sql, params }; `alias` is a table alias such as 'b'.
 */
export function holdingWhere(alias = '') {
  const p = alias ? `${alias}.` : '';
  return {
    sql: `(${p}status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) AND NOT (${p}status = 'pending' AND ${p}hold_expires_at IS NOT NULL AND ${p}hold_expires_at <= ?))`,
    params: [...ACTIVE_STATUSES, nowIso()],
  };
}

// Start times sit on a 30-minute grid. Inside this file every time is whole minutes from midnight on the
// studio clock; decimal hours (always a multiple of 0.5, so exact) only appear in what the API returns.
const STEP = 30;

/** Allowed values for the `buffer_minutes` setting. */
export const BUFFER_CHOICES = [0, 30, 60, 90, 120];

// A booking occupies [start, end) at its own start minute; the free promo hour is part of end_hour.
const startMinutes = (b) => b.start_hour * 60 + (b.start_minute || 0);
const endMinutes = (b) => b.end_hour * 60 + (b.start_minute || 0);

/** Bookings that hold a time slot (pending or confirmed) plus blocks, for one date. */
export function busyForDate(date) {
  const hold = holdingWhere();
  const bookings = db
    .prepare(`SELECT * FROM bookings WHERE date = ? AND ${hold.sql} ORDER BY start_hour, start_minute`)
    .all(date, ...hold.params);
  const blocks = db.prepare('SELECT * FROM blocks WHERE date = ? ORDER BY start_hour').all(date);
  return { bookings, blocks };
}

/** Busy intervals for one room on one date, in minutes: [{ start, end, kind, id? }] (booking bodies, no buffer). */
export function roomBusy(roomId, date, { excludeBookingId } = {}) {
  const { bookings, blocks } = busyForDate(date);
  return [
    ...bookings
      .filter((b) => b.room_id === roomId && b.id !== excludeBookingId)
      .map((b) => ({ start: startMinutes(b), end: endMinutes(b), kind: 'booking', id: b.id })),
    ...blocks
      .filter((b) => b.room_id === null || b.room_id === roomId)
      .map((b) => ({ start: b.start_hour * 60, end: b.end_hour * 60, kind: 'block' })),
  ].sort((a, b) => a.start - b.start);
}

/** What the public availability API returns: decimal hours, with `bufferEnd` on bookings (end plus cleaning time). */
export function roomBusyHours(roomId, date) {
  const { buffer_minutes: buffer } = getSettings();
  return roomBusy(roomId, date).map((b) =>
    b.kind === 'booking'
      ? { start: b.start / 60, end: b.end / 60, kind: 'booking', bufferEnd: (b.end + buffer) / 60 }
      : { start: b.start / 60, end: b.end / 60, kind: 'block' }
  );
}

/** Plain overlap of [start, end) with any busy interval (no buffer). */
export function overlaps(busy, start, end) {
  return busy.some((b) => start < b.end && end > b.start);
}

/** Bookings whose cleaning time clashes with [s, e): you cannot start inside the previous booking's buffer, and your own buffer cannot run into the next booking. Blocks have no buffer. */
function bufferHits(busy, s, e, buffer) {
  return busy.filter((b) => b.kind === 'booking' && s < b.end + buffer && b.start < e + buffer);
}

/** Smallest gap, in minutes, between [s, e) and the bookings that hit it. */
function smallestGap(hits, s, e) {
  return Math.min(...hits.map((b) => (b.end <= s ? s - b.end : b.start >= e ? b.start - e : 0)));
}

/**
 * Checks [s, e) against everything busy. Returns null when it fits, otherwise
 * { type: 'overlap' } or { type: 'buffer', gapMinutes }.
 */
export function conflicts(busy, s, e, buffer) {
  if (overlaps(busy, s, e)) return { type: 'overlap' };
  const hits = bufferHits(busy, s, e, buffer);
  if (hits.length) return { type: 'buffer', gapMinutes: smallestGap(hits, s, e) };
  return null;
}

/** Free hours promo: "book X hours, get Y free" applies once per booking. */
export function promoFreeHours(paidHours, settings = getSettings()) {
  if (!settings.promo_enabled) return 0;
  return paidHours >= settings.promo_buy_hours ? settings.promo_free_hours : 0;
}

/**
 * Checks whether a date is bookable at all, and returns the earliest
 * start time allowed for that date as decimal hours, e.g. 15.5 (respects opening hours and lead time).
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

  let earliest = s.open_hour * 60;
  if (!ignoreLeadTime && diff === 0) {
    const nowMin = now.hour * 60 + now.minute;
    const minStart = Math.ceil((nowMin + s.lead_time_hours * 60) / STEP) * STEP;
    earliest = Math.max(earliest, minStart);
  }
  if (earliest >= s.close_hour * 60) return { open: false, reason: 'No more slots left today.' };
  return { open: true, earliest: earliest / 60, openHour: s.open_hour, closeHour: s.close_hour };
}

const FEW_START_TIMES = 3;

/** True for "YYYY-MM" with a month from 01 to 12. */
export function isValidMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/**
 * Per-day availability summary for a month (read-only, two range queries).
 * status: closed (dateWindow not open), full (no active room can take a min_hours booking), few (fewer than 3
 * bookable start times, on the :00/:30 grid, across all active rooms), else open.
 * freeHours = hours (multiples of 0.5) summed across active rooms that are free between the earliest start and
 * closing, not counting any booking's cleaning time.
 */
export function monthAvailability(month) {
  const s = getSettings();
  const buffer = s.buffer_minutes;
  const first = `${month}-01`;
  const dates = [];
  for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1)) dates.push(d);
  const last = dates[dates.length - 1];

  const rooms = db.prepare('SELECT id FROM rooms WHERE active = 1').all();
  const hold = holdingWhere();
  const bookings = db
    .prepare(
      `SELECT room_id, date, start_hour, start_minute, end_hour FROM bookings
       WHERE date BETWEEN ? AND ? AND ${hold.sql}`
    )
    .all(first, last, ...hold.params);
  const blocks = db.prepare('SELECT room_id, date, start_hour, end_hour FROM blocks WHERE date BETWEEN ? AND ?').all(first, last);

  const byDate = new Map();
  const add = (date, row) => {
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  };
  for (const b of bookings) add(b.date, { kind: 'booking', room_id: b.room_id, start: startMinutes(b), end: endMinutes(b) });
  for (const b of blocks) add(b.date, { kind: 'block', room_id: b.room_id, start: b.start_hour * 60, end: b.end_hour * 60 });

  const days = dates.map((date) => {
    const win = dateWindow(date);
    if (!win.open) return { date, status: 'closed', freeHours: 0, reason: win.reason };

    const rows = byDate.get(date) || [];
    const earliest = Math.round(win.earliest * 60);
    const close = win.closeHour * 60;
    let freeMinutes = 0;
    let startTimes = 0;
    for (const room of rooms) {
      const busy = rows.filter((r) => (r.kind === 'block' ? r.room_id === null || r.room_id === room.id : r.room_id === room.id));
      for (let t = earliest; t < close; t += STEP) {
        // A half hour is free when no booking body, booking cleaning time or block touches it.
        const taken = busy.some((b) => t < b.end + (b.kind === 'booking' ? buffer : 0) && b.start < t + STEP);
        if (!taken) freeMinutes += STEP;
      }
      for (let t = earliest; t + s.min_hours * 60 <= close; t += STEP) {
        if (!conflicts(busy, t, t + s.min_hours * 60, buffer)) startTimes++;
      }
    }
    const status = startTimes === 0 ? 'full' : startTimes < FEW_START_TIMES ? 'few' : 'open';
    return { date, status, freeHours: freeMinutes / 60 };
  });

  return { month, now: studioNow(), days };
}

/** JSON body for a failed plan: { error } plus { code, bufferMinutes, gapMinutes } when the cleaning buffer is the reason. */
export function planErrorBody(plan) {
  const body = { error: plan.error };
  if (plan.code) {
    body.code = plan.code;
    body.bufferMinutes = plan.bufferMinutes;
    body.gapMinutes = plan.gapMinutes;
  }
  return body;
}

/**
 * Works out the reserved block for a requested booking.
 * The booking must not overlap anything and must keep `buffer_minutes` clear of neighbouring bookings.
 * With `overrideBuffer` (staff only) a buffer clash is allowed and reported as `bufferWarning`.
 * The free promo hour is added only when it fits before closing and before the next booking plus its buffer.
 */
export function planBooking({
  roomId,
  date,
  startHour,
  startMinute = 0,
  paidHours,
  excludeBookingId,
  ignoreLeadTime = false,
  overrideBuffer = false,
}) {
  const s = getSettings();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room || (!room.active && !ignoreLeadTime)) return { ok: false, error: 'That studio is not available.' };

  if (!Number.isInteger(paidHours) || paidHours < s.min_hours || paidHours > s.max_hours)
    return { ok: false, error: `Bookings are ${s.min_hours} to ${s.max_hours} hours long.` };
  if (!Number.isInteger(startHour)) return { ok: false, error: 'Pick a start time.' };
  if (startMinute !== 0 && startMinute !== 30) return { ok: false, error: 'Start times are on the hour or half hour.' };

  const win = dateWindow(date, { ignoreLeadTime });
  if (!win.open) return { ok: false, error: win.reason };

  const start = startHour * 60 + startMinute;
  if (start < Math.round(win.earliest * 60)) return { ok: false, error: 'That start time is no longer available.' };

  const paidEnd = start + paidHours * 60;
  if (paidEnd > s.close_hour * 60) return { ok: false, error: 'That booking runs past closing time.' };

  const busy = roomBusy(room.id, date, { excludeBookingId });
  const buffer = s.buffer_minutes;
  if (overlaps(busy, start, paidEnd))
    return { ok: false, error: 'Someone already has part of that time. Pick another start time.' };

  let bufferWarning = null;
  const paidHits = bufferHits(busy, start, paidEnd, buffer);
  if (paidHits.length) {
    const gapMinutes = smallestGap(paidHits, start, paidEnd);
    if (!overrideBuffer) {
      return {
        ok: false,
        code: 'buffer',
        error: `That time is too close to another booking. ${buffer} minutes are kept after each session for cleaning.`,
        bufferMinutes: buffer,
        gapMinutes,
      };
    }
    bufferWarning = {
      bufferMinutes: buffer,
      gapMinutes,
      message: `Only ${gapMinutes} min to clean next to another booking (the usual gap is ${buffer} min).`,
    };
  }

  let freeHours = promoFreeHours(paidHours, s);
  let freeNote = '';
  if (freeHours > 0) {
    const freeEnd = paidEnd + freeHours * 60;
    const alreadyHit = new Set(paidHits.map((b) => b.id));
    const freeHits = bufferHits(busy, start, freeEnd, buffer).filter((b) => !alreadyHit.has(b.id));
    if (freeEnd > s.close_hour * 60 || overlaps(busy, paidEnd, freeEnd) || freeHits.length) {
      freeHours = 0;
      freeNote = 'The free hour does not fit after this slot. Start earlier to get it.';
    }
  }

  return {
    ok: true,
    room,
    startHour,
    startMinute,
    paidHours,
    freeHours,
    endHour: startHour + paidHours + freeHours,
    hourlyRate: room.hourly_rate,
    total: paidHours * room.hourly_rate,
    freeNote,
    bufferWarning,
  };
}

/** Customers may change (move) an active booking until the cutoff before it starts. */
export function canCustomerChange(booking) {
  const s = getSettings();
  if (!ACTIVE_STATUSES.includes(booking.status)) return false;
  return hoursUntil(booking.date, booking.start_hour + (booking.start_minute || 0) / 60) >= s.cancel_cutoff_hours;
}

/** Payment states in which money may already have been sent: a screenshot is on file, or the payment was received. */
export const PAID_OR_PROOF_STATUSES = ['proof_submitted', 'not_received', 'received'];

/**
 * Same cutoff, but a GCash booking cannot be cancelled online once a screenshot was uploaded or the payment was
 * received (refunds are manual, so staff have to see it). Customers can still pay later or move it.
 */
export function canCustomerCancel(booking) {
  return canCustomerChange(booking) && !PAID_OR_PROOF_STATUSES.includes(booking.payment_status);
}
