// All booking dates and hours are stored in the studio's local time zone.
export const STUDIO_TZ = process.env.STUDIO_TZ || 'Asia/Manila';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Current date/hour/minute in the studio's time zone. */
export function studioNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: STUDIO_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** Days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

/** Hours from "now" until a given date + hour (can be negative). `hour` may be fractional, e.g. 15.5 for 3:30 PM. */
export function hoursUntil(dateStr, hour) {
  const now = studioNow();
  return daysBetween(now.date, dateStr) * 24 + hour - (now.hour + now.minute / 60);
}
