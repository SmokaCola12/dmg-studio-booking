import { site } from '../config/site.js';

const pad = (n) => String(n).padStart(2, '0');

/** Downloads a calendar file for a booking. Times are written in Philippine time (UTC+8). */
export function downloadIcs(booking) {
  const ymd = booking.date.replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dt = (h) => (h >= 24 ? `${ymd}T235900` : `${ymd}T${pad(h)}0000`);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Studio Booking//EN',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Manila',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:PST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${booking.code}@studio-booking`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Asia/Manila:${dt(booking.startHour)}`,
    `DTEND;TZID=Asia/Manila:${dt(booking.endHour)}`,
    `SUMMARY:Rehearsal at ${site.shortName} (${booking.room.name})`,
    `LOCATION:${site.address.join(', ').replace(/,/g, '\\,')}`,
    `DESCRIPTION:Booking code ${booking.code}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${booking.code}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
