import { site } from '../config/site.js';
import { bookingEnd, bookingStart } from './format.js';

const pad = (n) => String(n).padStart(2, '0');

/** Downloads a calendar file for a booking. Times are written in Philippine time (UTC+8). */
export function downloadIcs(booking, address = site.address) {
  const ymd = booking.date.replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  // h is a decimal hour (15.5 = 3:30 PM). The cleaning buffer after a booking is not part of the event.
  const dt = (h) => {
    if (h >= 24) return `${ymd}T235900`;
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${ymd}T${pad(hh)}${pad(mm)}00`;
  };
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
    `DTSTART;TZID=Asia/Manila:${dt(bookingStart(booking))}`,
    `DTEND;TZID=Asia/Manila:${dt(bookingEnd(booking))}`,
    `SUMMARY:Rehearsal at ${site.shortName} (${booking.room.name})`,
    `LOCATION:${address.join(', ').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')}`,
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
