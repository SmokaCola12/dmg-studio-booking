// Fills the next few days with sample bookings so the schedule and admin screens have something to show.
// Run with: npm run seed:demo   (safe to run more than once — it skips slots that are already taken)
import './env.js';
import { db, getSettings } from './db.js';
import { studioNow, addDays } from './lib/time.js';
import { planBooking } from './lib/scheduling.js';
import { bookingCode } from './lib/validate.js';

const s = getSettings();
const today = studioNow().date;
const rooms = db.prepare('SELECT * FROM rooms WHERE active = 1 ORDER BY sort_order, id').all();

const people = [
  ['Paolo Reyes', 'The Midnight Jeepney', '09171234567'],
  ['Kat Villanueva', 'Saltwater Saints', '09281112233'],
  ['Migs Santos', '', '09995556677'],
  ['Andrea Lim', 'Sundown Sessions', '09173334455'],
  ['Joaquin dela Rosa', 'Kape at Distortion', '09189990000'],
  ['Bea Castillo', 'Lunar Tide', '09062223344'],
  ['Renz Aquino', 'Heavy Rotation PH', '09451230987'],
];

// [dayOffset, roomIndex, startHour, paidHours, status]
const plan = [
  [0, 0, 13, 2, 'confirmed'],
  [0, 1, 15, 2, 'pending'],
  [0, 0, 18, 3, 'confirmed'],
  [0, 1, 19, 2, 'confirmed'],
  [1, 0, 10, 2, 'pending'],
  [1, 0, 16, 2, 'confirmed'],
  [1, 1, 14, 1, 'confirmed'],
  [2, 0, 19, 2, 'pending'],
  [2, 1, 11, 3, 'confirmed'],
  [-1, 0, 14, 2, 'completed'],
  [-1, 1, 18, 2, 'completed'],
  [-2, 0, 17, 2, 'no_show'],
];

const insert = db.prepare(
  `INSERT INTO bookings (code, room_id, date, start_hour, paid_hours, free_hours, end_hour, customer_name, band_name,
    phone, email, headcount, notes, payment_method, payment_ref, hourly_rate, total, status, source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', ?, ?, ?, ?, ?, 'online')`
);

let added = 0;
plan.forEach(([offset, roomIdx, start, hours, status], i) => {
  const room = rooms[roomIdx % rooms.length];
  if (!room) return;
  const date = addDays(today, offset);
  if (db.prepare('SELECT 1 FROM bookings WHERE room_id = ? AND date = ? AND start_hour = ?').get(room.id, date, start)) return;
  const [name, band, phone] = people[i % people.length];
  let free = 0;
  let end = start + hours;
  if (offset >= 0) {
    const p = planBooking({ roomId: room.id, date, startHour: start, paidHours: hours, ignoreLeadTime: true });
    if (!p.ok) return;
    free = p.freeHours;
    end = p.endHour;
  } else if (s.promo_enabled && hours >= s.promo_buy_hours && end + s.promo_free_hours <= s.close_hour) {
    free = s.promo_free_hours;
    end += free;
  }
  const gcash = i % 3 === 0;
  insert.run(
    bookingCode(), room.id, date, start, hours, free, end, name, band, phone, 3 + (i % 3),
    gcash ? 'gcash' : 'pay_at_studio', gcash ? `10${String(48213 + i * 777).padStart(11, '0')}` : '',
    room.hourly_rate, room.hourly_rate * hours, status
  );
  added += 1;
});

console.log(`Added ${added} sample bookings around ${today}.`);
