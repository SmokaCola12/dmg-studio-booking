import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Throwaway database; must be set before the backend modules load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-month-'));
process.env.DB_PATH = path.join(tmp, 'test.db');

const { default: express } = await import('express');
const { db, saveSettings, DEFAULT_SETTINGS } = await import('../backend/db.js');
const { default: publicRoutes } = await import('../backend/routes/public.js');
const { studioNow, addDays, weekday } = await import('../backend/lib/time.js');

let server;
let base;

before(async () => {
  const app = express();
  app.use('/api', publicRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM bookings').run();
  db.prepare('DELETE FROM blocks').run();
  saveSettings({ ...DEFAULT_SETTINGS });
});

const getMonth = async (month) => {
  const res = await fetch(`${base}/availability/month?month=${month}`);
  return { status: res.status, body: await res.json() };
};
const dayOf = (body, date) => body.days.find((d) => d.date === date);
const roomIds = () => db.prepare('SELECT id FROM rooms WHERE active = 1').all().map((r) => r.id);

let code = 0;
function addBooking(roomId, date, start, end, status = 'confirmed') {
  db.prepare(
    `INSERT INTO bookings (code, room_id, date, start_hour, paid_hours, end_hour, customer_name, phone, hourly_rate, total, status)
     VALUES (?, ?, ?, ?, ?, ?, 'Test', '09171234567', 300, 300, ?)`
  ).run(`T${++code}`, roomId, date, start, end - start, end, status);
}
const addBlock = (roomId, date, start, end) =>
  db.prepare('INSERT INTO blocks (room_id, date, start_hour, end_hour) VALUES (?, ?, ?, ?)').run(roomId, date, start, end);

const target = addDays(studioNow().date, 5);
const targetMonth = target.slice(0, 7);

test('returns one entry per day of the month', async () => {
  const { status, body } = await getMonth('2028-02');
  assert.equal(status, 200);
  assert.equal(body.month, '2028-02');
  assert.equal(body.days.length, 29);
  assert.ok(body.now.date);
});

test('bookable day is open with free hours', async () => {
  const { body } = await getMonth(targetMonth);
  const day = dayOf(body, target);
  assert.equal(day.status, 'open');
  assert.equal(day.freeHours, 12 * roomIds().length);
});

test('closed weekday is closed with a reason', async () => {
  saveSettings({ closed_weekdays: [weekday(target)] });
  const day = dayOf((await getMonth(targetMonth)).body, target);
  assert.equal(day.status, 'closed');
  assert.match(day.reason, /closed/i);
});

test('past day is closed', async () => {
  const yesterday = addDays(studioNow().date, -1);
  const day = dayOf((await getMonth(yesterday.slice(0, 7))).body, yesterday);
  assert.equal(day.status, 'closed');
  assert.match(day.reason, /passed/i);
});

test('day beyond max_days_ahead is closed', async () => {
  const far = addDays(studioNow().date, DEFAULT_SETTINGS.max_days_ahead + 1);
  const day = dayOf((await getMonth(far.slice(0, 7))).body, far);
  assert.equal(day.status, 'closed');
  assert.match(day.reason, /days ahead/i);
});

test('block with no room makes the day full', async () => {
  addBlock(null, target, 10, 22);
  const day = dayOf((await getMonth(targetMonth)).body, target);
  assert.equal(day.status, 'full');
  assert.equal(day.freeHours, 0);
});

test('every room booked all day is full', async () => {
  for (const id of roomIds()) addBooking(id, target, 10, 22, 'pending');
  assert.equal(dayOf((await getMonth(targetMonth)).body, target).status, 'full');
});

test('partly booked day is few, then open with room to spare', async () => {
  const [a, ...others] = roomIds();
  for (const id of others) addBlock(id, target, 10, 22);
  addBooking(a, target, 10, 20); // 20-22 left: 2 start hours (min_hours 1)
  assert.equal(dayOf((await getMonth(targetMonth)).body, target).status, 'few');

  db.prepare('DELETE FROM bookings').run();
  addBooking(a, target, 10, 12); // 10 start hours left
  const day = dayOf((await getMonth(targetMonth)).body, target);
  assert.equal(day.status, 'open');
  assert.equal(day.freeHours, 10);
});

test('cancelled booking is ignored', async () => {
  for (const id of roomIds()) addBooking(id, target, 10, 22, 'cancelled');
  const day = dayOf((await getMonth(targetMonth)).body, target);
  assert.equal(day.status, 'open');
  assert.equal(day.freeHours, 12 * roomIds().length);
});

test('bad month returns 400', async () => {
  for (const m of ['', '2026-13', '2026-00', '2026-1', '2026-10-01', 'abc']) {
    const { status, body } = await getMonth(m);
    assert.equal(status, 400, m);
    assert.ok(body.error);
  }
  const res = await fetch(`${base}/availability/month`);
  assert.equal(res.status, 400);
});
