const pesoFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 });
export const peso = (n) => pesoFmt.format(n || 0);

/** 10 → "10 AM", 12 → "12 NN", 0/24 → "12 MN" (the way schedules are written in the Philippines). */
export function hourLabel(h, { short = false } = {}) {
  const hour = ((h % 24) + 24) % 24;
  if (hour === 12) return short ? '12' : '12 NN';
  if (hour === 0) return short ? '12' : '12 MN';
  const n = hour % 12;
  return short ? String(n) : `${n} ${hour < 12 ? 'AM' : 'PM'}`;
}

const meridiem = (h) => {
  const hour = ((h % 24) + 24) % 24;
  if (hour === 12) return 'NN';
  if (hour === 0) return 'MN';
  return hour < 12 ? 'AM' : 'PM';
};

/** 15, 18 → "3–6 PM"; 11, 14 → "11 AM – 2 PM" */
export function rangeLabel(start, end) {
  const sameHalf = meridiem(start) === meridiem(end) && !['NN', 'MN'].includes(meridiem(start));
  if (sameHalf) return `${hourLabel(start, { short: true })}–${hourLabel(end)}`;
  return `${hourLabel(start)} – ${hourLabel(end)}`;
}

export const hoursText = (n) => `${n} ${n === 1 ? 'hour' : 'hours'}`;

const toDate = (s) => new Date(`${s}T00:00:00Z`);

export function dateLabel(s, { long = false, year = false } = {}) {
  return toDate(s).toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    weekday: long ? 'long' : 'short',
    month: long ? 'long' : 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
  });
}

export function addDays(s, n) {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

/** "Today", "Tomorrow", or "Wed, Oct 28" */
export function relativeDay(s, today) {
  const diff = daysBetween(today, s);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return dateLabel(s);
}

export const weekdayOf = (s) => toDate(s).getUTCDay();

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Open 10 AM to 10 PM, closed on Monday" */
export function hoursSentence(settings) {
  const range = `${hourLabel(settings.open_hour)} to ${hourLabel(settings.close_hour)}`;
  if (!settings.closed_weekdays?.length) return `Open every day, ${range}`;
  const closed = settings.closed_weekdays.map((d) => WEEKDAY_NAMES[d]).join(' and ');
  return `Open ${range}, closed on ${closed}`;
}

export function formatPhone(p) {
  if (!p || p.length !== 11) return p || '';
  return `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}`;
}

export const STATUS_LABELS = {
  pending: 'Waiting for approval',
  confirmed: 'Confirmed',
  completed: 'Done',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

export const PAYMENT_LABELS = {
  pay_at_studio: 'Pay at the studio',
  gcash: 'GCash',
};
