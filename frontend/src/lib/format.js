const pesoFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 });
export const peso = (n) => pesoFmt.format(n || 0);

/**
 * 10 → "10 AM", 12 → "12 NN", 0/24 → "12 MN" (the way schedules are written in the Philippines).
 * Half hours keep the minutes: 15.5 → "3:30 PM", 12.5 → "12:30 PM".
 */
export function hourLabel(h, { short = false } = {}) {
  const day = ((h % 24) + 24) % 24;
  const hour = Math.floor(day);
  const minutes = Math.round((day - hour) * 60);
  const n = hour % 12 || 12;
  const mm = String(minutes).padStart(2, '0');
  if (minutes === 0) {
    if (hour === 12) return short ? '12' : '12 NN';
    if (hour === 0) return short ? '12' : '12 MN';
    return short ? String(n) : `${n} ${hour < 12 ? 'AM' : 'PM'}`;
  }
  return short ? `${n}:${mm}` : `${n}:${mm} ${hour < 12 ? 'AM' : 'PM'}`;
}

const meridiem = (h) => {
  const day = ((h % 24) + 24) % 24;
  if (day === 12) return 'NN';
  if (day === 0) return 'MN';
  return day < 12 ? 'AM' : 'PM';
};

/** A booking's start as a decimal hour: startHour 15, startMinute 30 → 15.5. Old data has no startMinute. */
export const bookingStart = (b) => (b.startHour ?? 0) + (b.startMinute || 0) / 60;

/** A booking's end as a decimal hour. endHour is a whole number and shares the start's minutes. */
export const bookingEnd = (b) => (b.endHour ?? 0) + (b.startMinute || 0) / 60;

/** Splits a decimal start hour (15.5) into what the API takes: { startHour: 15, startMinute: 30 }. */
export const splitStart = (h) => ({ startHour: Math.floor(h), startMinute: Math.round((h - Math.floor(h)) * 60) });

/** 15, 18 → "3–6 PM"; 11, 14 → "11 AM – 2 PM" */
export function rangeLabel(start, end) {
  const sameHalf = meridiem(start) === meridiem(end) && !['NN', 'MN'].includes(meridiem(start));
  if (sameHalf) return `${hourLabel(start, { short: true })}–${hourLabel(end)}`;
  return `${hourLabel(start)} – ${hourLabel(end)}`;
}

export const hoursText = (n) => `${n} ${n === 1 ? 'hour' : 'hours'}`;

/** 30 → "30 min", 60 → "1 hour", 90 → "1 hr 30 min" */
export function minutesText(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} hr ${rest} min` : hoursText(h);
}

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
  expired: 'Expired',
};

export const PAYMENT_LABELS = {
  pay_at_studio: 'Pay at the studio',
  gcash: 'GCash',
};

/** half → "50%", full → "100%" */
export const PLAN_LABELS = { half: '50%', full: '100%' };

/** What is paid online now: half rounds up to a whole peso, full is the total. Matches the server. */
export const depositAmount = (total, plan) => (plan === 'half' ? Math.ceil((total || 0) / 2) : total || 0);

/** Where a GCash payment stands, in staff wording. `stage` comes from the server. */
export const PAYMENT_STAGE_LABELS = {
  awaiting_proof: 'Waiting for screenshot',
  proof_submitted: 'To check',
  not_received: 'Not received',
  deposit_received: 'Deposit received',
  paid: 'PAID',
  expired: 'Hold expired',
  refund_due: 'Refund due',
  refunded: 'Refunded',
};

/** "GCash 50%" for a new-style GCash booking, otherwise the plain payment method. */
export function paymentLabel(b) {
  if (b.paymentMethod === 'gcash' && b.payment?.plan) return `GCash ${PLAN_LABELS[b.payment.plan] || ''}`.trim();
  return PAYMENT_LABELS[b.paymentMethod] || '';
}

/** 754000 ms → "12:34" */
export function clockText(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** An ISO instant shown on the studio clock, e.g. "Nov 14, 3:05 PM". */
export function instantLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Whole bytes as "2.4 MB" */
export function sizeText(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
