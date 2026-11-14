// Mirrors the server's booking rules so the booking page can show what fits instantly.
// The server checks everything again when the booking is submitted.
//
// Times here are decimal hours on the studio clock (15.5 = 3:30 PM). Start times can fall on :00 or :30.
// After every booking the room stays unavailable for `buffer_minutes` (cleaning and prep).

import { minutesText } from './format.js';

export const START_STEP = 0.5;

/** Cleaning time after each booking, in minutes. 0 when the server doesn't send it (older server). */
export const bufferMinutes = (settings) => Math.max(0, Number(settings?.buffer_minutes) || 0);

/** "30 min is kept after each session for cleaning." (empty when there is no buffer) */
export function bufferText(settings) {
  const m = bufferMinutes(settings);
  return m ? `${minutesText(m)} is kept after each session for cleaning.` : '';
}

const isBlock = (b) => b.kind === 'block';

/** Any overlap with a booking or block itself (no buffer). */
export const overlaps = (busy, start, end) => busy.some((b) => start < b.end && end > b.start);

/**
 * The server's rule. A new booking [start, end) conflicts with a booking when
 *   start < booking.bufferEnd  &&  booking.start < end + buffer
 * so you can't start in the previous cleaning time and your own cleaning can't run into the next booking.
 * Blocks have no buffer. Returns '' when it fits, 'taken' for a real overlap, 'cleaning' for a buffer clash.
 */
export function conflictReason(busy, start, end, buffer) {
  if (overlaps(busy, start, end)) return 'taken';
  const bufferHours = buffer / 60;
  for (const b of busy) {
    if (isBlock(b)) continue;
    const bufferEnd = b.bufferEnd ?? b.end + bufferHours;
    if (start < bufferEnd && b.start < end + bufferHours) return 'cleaning';
  }
  return '';
}

export function promoFreeHours(paidHours, settings) {
  if (!settings.promo_enabled) return 0;
  return paidHours >= settings.promo_buy_hours ? settings.promo_free_hours : 0;
}

/**
 * For each possible start (every half hour): whether it fits, and whether the free promo hour fits after it.
 * `hour` is a decimal hour. `reason` says why a start doesn't fit: taken, cleaning or closing.
 */
export function startOptions({ busy, settings, window, paidHours, ignoreBooking = null }) {
  if (!window?.open) return [];
  const rows = ignoreBooking ? busy.filter((b) => !ignoreBooking(b)) : busy;
  const buffer = bufferMinutes(settings);
  const promo = promoFreeHours(paidHours, settings);
  const out = [];
  for (let h = settings.open_hour; h < settings.close_hour; h += START_STEP) {
    const paidEnd = h + paidHours;
    const past = h < window.earliest;
    const pastClosing = paidEnd > settings.close_hour;
    const clash = pastClosing ? '' : conflictReason(rows, h, paidEnd, buffer);
    const ok = !past && !pastClosing && !clash;
    let freeHours = 0;
    if (ok && promo > 0 && paidEnd + promo <= settings.close_hour && !conflictReason(rows, h, paidEnd + promo, buffer)) {
      freeHours = promo;
    }
    out.push({ hour: h, ok, freeHours, past, reason: clash || (pastClosing ? 'closing' : '') });
  }
  return out;
}

/**
 * Adds a muted "Cleaning" clip after every booking, from its end to its bufferEnd (or end + buffer),
 * stopping where the next booking or block starts. Pass the items for ONE room.
 */
export function withBufferClips(roomItems, buffer) {
  const isActive = (it) => it.kind === 'booking' && !['cancelled', 'completed', 'no_show'].includes(it.status);
  const bookings = roomItems.filter(isActive);
  const clips = [];
  for (const it of bookings) {
    const bufferEnd = it.bufferEnd ?? (buffer ? it.end + buffer / 60 : it.end);
    if (bufferEnd <= it.end) continue;
    const nextStart = Math.min(
      bufferEnd,
      ...roomItems.filter((o) => o !== it && (isActive(o) || o.kind === 'block') && o.start >= it.end).map((o) => o.start)
    );
    if (nextStart > it.end) {
      clips.push({ kind: 'buffer', start: it.end, end: nextStart, label: 'Cleaning', id: `buf-${it.id ?? it.start}` });
    }
  }
  return [...roomItems, ...clips];
}

export function promoText(settings) {
  if (!settings?.promo_enabled) return '';
  const { promo_buy_hours: buy, promo_free_hours: free } = settings;
  return `Book ${buy} ${buy === 1 ? 'hour' : 'hours'}, get ${free === 1 ? 'the next hour' : `${free} more hours`} free`;
}
