import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// Cleaning buffer after each booking, :30 start times and their API surface. The real server runs as a child
// process against a throwaway database (never data/studio.db). Each test uses its own future date so tests do
// not interfere with each other; settings changed by a test are restored by that test.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-buffer-'));
const PASSWORD = 'test-password-buffer';
const PHONE = '09171234567';

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

/** Starts backend/index.js on a free port against `dbPath`. Returns an api() helper and stop(). */
async function startServer(dbPath, extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_TOKEN_SECRET: 'test-secret-buffer',
    ...extraEnv,
  };
  delete env.STUDIO_TZ;
  const child = spawn(process.execPath, [path.join(root, 'backend', 'index.js')], { cwd: root, env, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${base}/api/site`)).ok;
    } catch {
      /* not up yet */
    }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, 'server did not start');
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const token = (await login.json()).token;
  assert.ok(token, 'could not log in');

  async function api(method, url, body, { auth = false } = {}) {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, body: json };
  }
  const stop = async () => {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    await new Promise((r) => setTimeout(r, 200));
  };
  return { api, admin: (m, u, b) => api(m, `/admin${u}`, b, { auth: true }), stop, child };
}

let srv;
let pub;
let admin;

before(async () => {
  srv = await startServer(path.join(tmp, 'main.db'));
  pub = srv.api;
  admin = srv.admin;
});

after(async () => {
  await srv.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- helpers ----------

function manilaToday() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const day = (n) => addDays(manilaToday(), n);
const ROOM_A = 1;
const ROOM_B = 2;

const publicBody = (date, startHour, paidHours, extra = {}) => ({
  roomId: ROOM_A, date, startHour, paidHours, name: 'Tester', phone: PHONE, headcount: 2, ...extra,
});
const bookPublic = (date, startHour, paidHours, extra) => pub('POST', '/bookings', publicBody(date, startHour, paidHours, extra));
const bookAdmin = (date, startHour, paidHours, extra = {}) =>
  admin('POST', '/bookings', { roomId: ROOM_A, date, startHour, paidHours, name: 'Walk In', ...extra });
const setSettings = async (s) => assert.equal((await admin('PUT', '/settings', s)).status, 200);
const settings = async () => (await admin('GET', '/settings')).body.settings;

// A booking via admin, asserting success.
async function seed(date, startHour, paidHours, extra) {
  const r = await bookAdmin(date, startHour, paidHours, extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.booking;
}

// ---------- defaults ----------

test('default buffer is 30 and is public in /api/site', async () => {
  const r = await pub('GET', '/site');
  assert.equal(r.body.settings.buffer_minutes, 30);
});

// ---------- the basic rule ----------

test('back-to-back booking is rejected with code buffer', async () => {
  const d = day(3);
  assert.equal((await bookPublic(d, 10, 1)).status, 201);
  const r = await bookPublic(d, 11, 1);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'buffer');
  assert.equal(r.body.bufferMinutes, 30);
  assert.equal(r.body.gapMinutes, 0);
  assert.ok(r.body.error);
});

test('overlap is a plain 409 without the buffer code', async () => {
  const d = day(3);
  const r = await bookPublic(d, 10, 2);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, undefined);
});

test('exact 30 minute gap is allowed after and before an existing booking', async () => {
  const d = day(4);
  const mid = await seed(d, 14, 2); // 14:00-16:00 (no promo for admin? promo applies; end may be 17)
  const busyEnd = mid.endHour;
  // one grid step closer than the buffer is rejected first (13:00-14:00 touches 14:00)
  const tooCloseBefore = await bookPublic(d, 13, 1);
  assert.equal(tooCloseBefore.status, 409);
  assert.equal(tooCloseBefore.body.code, 'buffer');
  assert.equal(tooCloseBefore.body.gapMinutes, 0);
  // after: starts exactly buffer after the end
  const after1 = await bookPublic(d, busyEnd, 1, { startMinute: 30 });
  assert.equal(after1.status, 201, JSON.stringify(after1.body));
  assert.equal(after1.body.booking.startMinute, 30);
  // before: ends exactly 30 minutes before 14:00 -> 12:30 start, 1h => 13:30
  const before1 = await bookPublic(d, 12, 1, { startMinute: 30 });
  assert.equal(before1.status, 201, JSON.stringify(before1.body));
});

test('a half hour start is reported and a 30 minute gap is reported as gapMinutes', async () => {
  const d = day(5);
  await seed(d, 10, 1, { startMinute: 30 }); // 10:30-11:30 (admin 1h: no promo)
  const r = await bookPublic(d, 11, 1, { startMinute: 30 }); // 11:30 start: gap 0
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'buffer');
  assert.equal(r.body.gapMinutes, 0);
  const ok = await bookPublic(d, 12, 1);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.booking.startMinute, 0);
});

test('startMinute other than 0 or 30 is a 400 everywhere', async () => {
  const d = day(6);
  for (const m of [15, 29, 45, 60, -30, 'abc', 30.5]) {
    const r = await bookPublic(d, 10, 1, { startMinute: m });
    assert.equal(r.status, 400, `public ${m}`);
    assert.ok(r.body.fields?.startMinute, `field error for ${m}`);
    const a = await bookAdmin(d, 10, 1, { startMinute: m });
    assert.equal(a.status, 400, `admin ${m}`);
  }
  // nothing was created
  const sched = await admin('GET', `/schedule?date=${d}`);
  assert.equal(sched.body.bookings.length, 0);
  // PATCH and reschedule validate too
  const b = await seed(d, 10, 1);
  assert.equal((await admin('PATCH', `/bookings/${b.id}`, { startMinute: 15 })).status, 400);
  const pb = await bookPublic(d, 13, 1);
  assert.equal(pb.status, 201);
  const rs = await pub('POST', '/bookings/reschedule', { code: pb.body.booking.code, phone: PHONE, date: d, startHour: 15, startMinute: 15 });
  assert.equal(rs.status, 400);
});

test('startMinute 0 and 30 are accepted, and omitted means 0', async () => {
  const d = day(7);
  const a = await bookPublic(d, 10, 1, { startMinute: 30 });
  assert.equal(a.status, 201);
  assert.equal(a.body.booking.startMinute, 30);
  const b = await bookPublic(d, 12, 1, { startMinute: 0 });
  assert.equal(b.body.booking.startMinute, 0);
  const c = await bookPublic(d, 14, 1);
  assert.equal(c.body.booking.startMinute, 0);
});

test('buffer 60 rejects a 30 minute gap and allows 60', async () => {
  const d = day(8);
  await setSettings({ buffer_minutes: 60 });
  try {
    await seed(d, 10, 1); // 10-11
    const tooClose = await bookPublic(d, 11, 1, { startMinute: 30 }); // gap 30
    assert.equal(tooClose.status, 409);
    assert.equal(tooClose.body.code, 'buffer');
    assert.equal(tooClose.body.bufferMinutes, 60);
    assert.equal(tooClose.body.gapMinutes, 30);
    const ok = await bookPublic(d, 12, 1); // gap 60
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    // and the gap before an existing booking: 12-13 booked, 10:30-11:30 would leave 30
    const before = await bookPublic(d, 14, 1);
    assert.equal(before.status, 201); // 14-15, gap 60 after 12-13
  } finally {
    await setSettings({ buffer_minutes: 30 });
  }
});

test('buffer 0 allows back-to-back bookings', async () => {
  const d = day(9);
  await setSettings({ buffer_minutes: 0 });
  try {
    await seed(d, 10, 1);
    const r = await bookPublic(d, 11, 1);
    assert.equal(r.status, 201);
    const overlap = await bookPublic(d, 10, 1);
    assert.equal(overlap.status, 409);
  } finally {
    await setSettings({ buffer_minutes: 30 });
  }
});

test('other rooms are unaffected by the buffer', async () => {
  const d = day(10);
  await seed(d, 10, 1);
  const r = await bookPublic(d, 11, 1, { roomId: ROOM_B });
  assert.equal(r.status, 201);
});

test('cancelled booking frees the slot and its buffer', async () => {
  const d = day(11);
  const b = await seed(d, 10, 1);
  assert.equal((await bookPublic(d, 11, 1)).status, 409);
  await admin('PATCH', `/bookings/${b.id}`, { status: 'cancelled' });
  assert.equal((await bookPublic(d, 11, 1)).status, 201);
});

// ---------- closing time ----------

test('21:00-22:00 fits before closing; 21:30 start is rejected; buffer may pass closing', async () => {
  const d = day(12);
  const late = await bookPublic(d, 21, 1, { startMinute: 30 });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, undefined);
  assert.match(late.body.error, /closing/i);
  const ok = await bookPublic(d, 21, 1);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.booking.endHour, 22);
  // a 20:30-21:30 start would clash with the 21:00 booking in the same room, but the other room is fine
  const other = await bookPublic(d, 20, 2, { roomId: ROOM_B, startMinute: 0 });
  assert.equal(other.status, 201);
});

// ---------- blocks ----------

test('a block next to a booking is allowed and gets no buffer', async () => {
  const d = day(13);
  await seed(d, 10, 1); // 10-11
  const after1 = await admin('POST', '/blocks', { roomId: ROOM_A, date: d, startHour: 11, endHour: 12 });
  assert.equal(after1.status, 201);
  // booking right after the block: no buffer applies to a block
  const r = await bookPublic(d, 12, 1);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // block right before that booking
  const before1 = await admin('POST', '/blocks', { roomId: ROOM_A, date: d, startHour: 11 - 0, endHour: 12 });
  assert.equal(before1.status, 201); // overlapping blocks do not conflict with each other
  const into = await admin('POST', '/blocks', { roomId: ROOM_A, date: d, startHour: 12, endHour: 13 });
  assert.equal(into.status, 409, 'blocks may not cover a booking body');
  const clash = await admin('POST', '/blocks', { roomId: ROOM_A, date: d, startHour: 9, endHour: 10 });
  assert.equal(clash.status, 201, 'a block ending at the booking start is fine');
});

test('block over the day-all rooms is rejected when a booking body is in it', async () => {
  const d = day(14);
  await seed(d, 10, 1);
  const r = await admin('POST', '/blocks', { date: d, startHour: 10, endHour: 12 });
  assert.equal(r.status, 409);
});

// ---------- free promo hour ----------

test('free promo hour is dropped when free hour plus buffer collides with the next booking', async () => {
  const d = day(15);
  // existing booking 13:30-14:30
  await seed(d, 13, 1, { startMinute: 30 });
  // control: 10-12 paid, +1 free = 13:00; 13:00 + 30 min buffer = 13:30, exactly fits
  const ok = await bookPublic(d, 10, 2);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.booking.freeHours, 1);
  assert.equal(ok.body.booking.endHour, 13);

  // buffer 60: free hour would need to end by 12:30 -> dropped, paid hours still fit
  const d2 = day(16);
  await setSettings({ buffer_minutes: 60 });
  try {
    await seed(d2, 13, 1, { startMinute: 30 });
    const r = await bookPublic(d2, 10, 2);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.booking.freeHours, 0);
    assert.equal(r.body.booking.endHour, 12);
    assert.ok(r.body.freeNote);
  } finally {
    await setSettings({ buffer_minutes: 30 });
  }
});

test('free promo hour is dropped when it would pass closing', async () => {
  const d = day(17);
  const r = await bookPublic(d, 20, 2); // 20-22, free hour would end 23
  assert.equal(r.status, 201);
  assert.equal(r.body.booking.freeHours, 0);
  assert.equal(r.body.booking.endHour, 22);
});

// ---------- availability ----------

test('availability busy hours carry bufferEnd for bookings only, in decimal hours', async () => {
  const d = day(18);
  await seed(d, 10, 1, { startMinute: 30 }); // 10:30-11:30
  await admin('POST', '/blocks', { roomId: ROOM_A, date: d, startHour: 15, endHour: 16 });
  const r = await pub('GET', `/availability?date=${d}`);
  assert.equal(r.status, 200);
  const room = r.body.rooms.find((x) => x.id === ROOM_A);
  assert.deepEqual(room.busy, [
    { start: 10.5, end: 11.5, kind: 'booking', bufferEnd: 12 },
    { start: 15, end: 16, kind: 'block' },
  ]);
  assert.deepEqual(r.body.rooms.find((x) => x.id === ROOM_B).busy, []);
});

test('month availability counts the buffer (but not past closing, and not for blocks)', async () => {
  const d = day(19);
  await admin('POST', '/blocks', { roomId: ROOM_B, date: d, startHour: 10, endHour: 22 });
  await seed(d, 10, 2); // room A, 10-12 paid; the promo hour may extend it, so read endHour back
  const sched = await admin('GET', `/schedule?date=${d}`);
  const booking = sched.body.bookings[0];
  const end = booking.endHour;
  const month = d.slice(0, 7);
  const freeFor = async (buffer) => {
    await setSettings({ buffer_minutes: buffer });
    const r = await pub('GET', `/availability/month?month=${month}`);
    return r.body.days.find((x) => x.date === d).freeHours;
  };
  try {
    assert.equal(await freeFor(0), 22 - end);
    assert.equal(await freeFor(30), 22 - end - 0.5);
    assert.equal(await freeFor(60), 22 - end - 1);
  } finally {
    await setSettings({ buffer_minutes: 30 });
  }
});

test('month availability: a booking ending at closing, its buffer past closing costs nothing extra', async () => {
  const d = day(20);
  await admin('POST', '/blocks', { roomId: ROOM_B, date: d, startHour: 10, endHour: 22 });
  await seed(d, 20, 2); // 20-22 (promo cannot fit)
  const r = await pub('GET', `/availability/month?month=${d.slice(0, 7)}`);
  const got = r.body.days.find((x) => x.date === d);
  assert.equal(got.freeHours, 10); // 10:00-20:00 free in room A; room B blocked; buffer past 22:00 is not counted
});

// ---------- customer reschedule ----------

test('customer reschedule respects the buffer and ignores its own old slot', async () => {
  const d = day(21);
  await seed(d, 14, 1); // 14-15 held by someone else
  const mine = await bookPublic(d, 10, 1);
  assert.equal(mine.status, 201);
  const code = mine.body.booking.code;
  const move = (startHour, startMinute) =>
    pub('POST', '/bookings/reschedule', { code, phone: PHONE, date: d, startHour, ...(startMinute === undefined ? {} : { startMinute }) });

  // overlapping its own old slot (10:30-11:30) is fine
  const own = await move(10, 30);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.booking.startMinute, 30);

  // 13:00-14:00 touches the other booking
  const tight = await move(13);
  assert.equal(tight.status, 409);
  assert.equal(tight.body.code, 'buffer');
  assert.equal(tight.body.gapMinutes, 0);
  // 12:30-13:30 leaves exactly 30 minutes
  const exact = await move(12, 30);
  assert.equal(exact.status, 200, JSON.stringify(exact.body));
  // 13:30 start leaves a 0 gap after... would overlap? 13:30-14:30 overlaps 14-15
  const overlap = await move(13, 30);
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.code, undefined);
});

test('moving to the exact same time is still a 400', async () => {
  const d = day(22);
  const mine = await bookPublic(d, 12, 1, { startMinute: 30 });
  const r = await pub('POST', '/bookings/reschedule', {
    code: mine.body.booking.code, phone: PHONE, date: d, startHour: 12, startMinute: 30,
  });
  assert.equal(r.status, 400);
});

// ---------- overrideBuffer ----------

test('public routes ignore overrideBuffer', async () => {
  const d = day(23);
  await seed(d, 10, 1);
  const r = await bookPublic(d, 11, 1, { overrideBuffer: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'buffer');
  // reschedule too
  const mine = await bookPublic(d, 15, 1);
  const rs = await pub('POST', '/bookings/reschedule', {
    code: mine.body.booking.code, phone: PHONE, date: d, startHour: 11, overrideBuffer: true,
  });
  assert.equal(rs.status, 409);
  assert.equal(rs.body.code, 'buffer');
});

test('admin walk-in: 409 buffer, then 201 with overrideBuffer and a warning', async () => {
  const d = day(24);
  await seed(d, 10, 1);
  const r = await bookAdmin(d, 11, 1);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'buffer');
  assert.equal(r.body.bufferMinutes, 30);
  assert.equal(r.body.gapMinutes, 0);

  const strict = await bookAdmin(d, 11, 1, { overrideBuffer: 'true' });
  assert.equal(strict.status, 409, 'only boolean true overrides');

  const ok = await bookAdmin(d, 11, 1, { overrideBuffer: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.bufferWarning.gapMinutes, 0);
  assert.equal(ok.body.bufferWarning.bufferMinutes, 30);
  assert.ok(ok.body.bufferWarning.message);

  // a clean walk-in has no warning
  const clean = await bookAdmin(d, 15, 1);
  assert.equal(clean.status, 201);
  assert.ok(!clean.body.bufferWarning);

  // overlap cannot be overridden
  const overlap = await bookAdmin(d, 10, 1, { overrideBuffer: true });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.code, undefined);
});

test('admin PATCH move and reactivate honour the buffer and overrideBuffer', async () => {
  const d = day(25);
  const a = await seed(d, 10, 1);
  const b = await seed(d, 13, 1);
  // move b right after a
  const move = await admin('PATCH', `/bookings/${b.id}`, { startHour: 11 });
  assert.equal(move.status, 409);
  assert.equal(move.body.code, 'buffer');
  const forced = await admin('PATCH', `/bookings/${b.id}`, { startHour: 11, overrideBuffer: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.bufferWarning.gapMinutes, 0);
  assert.equal(forced.body.booking.startHour, 11);
  assert.equal(forced.body.booking.startMinute, 0);
  // a half-hour move that fits
  const half = await admin('PATCH', `/bookings/${b.id}`, { startHour: 11, startMinute: 30 });
  assert.equal(half.status, 200, JSON.stringify(half.body));
  assert.equal(half.body.booking.startMinute, 30);
  // cancel and reactivate into a tight spot
  await admin('PATCH', `/bookings/${b.id}`, { status: 'cancelled' });
  await bookAdmin(d, 11, 1, { startMinute: 30 });
  const re = await admin('PATCH', `/bookings/${b.id}`, { status: 'confirmed' });
  assert.equal(re.status, 409);
  assert.ok(a.id);
});

test('status-only PATCH on an existing back-to-back pair works', async () => {
  const d = day(26);
  const a = await seed(d, 10, 1);
  const b = await seed(d, 11, 1, { overrideBuffer: true });
  assert.equal((await admin('PATCH', `/bookings/${a.id}`, { status: 'pending' })).status, 200);
  const confirm = await admin('PATCH', `/bookings/${a.id}`, { status: 'confirmed' });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.booking.status, 'confirmed');
  assert.equal((await admin('PATCH', `/bookings/${b.id}`, { adminNotes: 'note' })).status, 200);
  const done = await admin('PATCH', `/bookings/${b.id}`, { status: 'completed' });
  assert.equal(done.status, 200);
  assert.equal(done.body.booking.status, 'completed');
});

// ---------- bufferConflicts ----------

test('schedule reports buffer conflicts for tight pairs only', async () => {
  const d = day(27);
  const a = await seed(d, 10, 1);
  const b = await seed(d, 11, 1, { overrideBuffer: true });
  const okPair = await seed(d, 14, 1);
  const okNext = await seed(d, 15, 1, { startMinute: 30 }); // 30 min gap after 14-15
  const otherRoom = await seed(d, 11, 1, { roomId: ROOM_B });
  const s = await admin('GET', `/schedule?date=${d}`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.bufferConflicts, [{ roomId: ROOM_A, bookingIds: [a.id, b.id], gapMinutes: 0 }]);
  assert.ok(okPair.id && okNext.id && otherRoom.id);

  // cancelled bookings no longer count
  await admin('PATCH', `/bookings/${b.id}`, { status: 'cancelled' });
  const s2 = await admin('GET', `/schedule?date=${d}`);
  assert.deepEqual(s2.body.bufferConflicts, []);
});

test('schedule on an empty day has no buffer conflicts', async () => {
  const s = await admin('GET', `/schedule?date=${day(28)}`);
  assert.deepEqual(s.body.bufferConflicts, []);
});

// ---------- settings validation ----------

test('PUT /admin/settings validates buffer_minutes', async () => {
  for (const v of [45, 15, 150, -30, 'abc', 30.5]) {
    const r = await admin('PUT', '/settings', { buffer_minutes: v });
    assert.equal(r.status, 400, String(v));
  }
  assert.equal((await settings()).buffer_minutes, 30);
  for (const v of [0, 60, 90, 120, 30]) {
    const r = await admin('PUT', '/settings', { buffer_minutes: v });
    assert.equal(r.status, 200, String(v));
    assert.equal(r.body.settings.buffer_minutes, v);
  }
  assert.equal((await pub('GET', '/site')).body.settings.buffer_minutes, 30);
});

test('settings and schedule need an admin token', async () => {
  assert.equal((await pub('GET', '/admin/settings')).status, 401);
  assert.equal((await pub('PUT', '/admin/settings', { buffer_minutes: 0 })).status, 401);
  assert.equal((await pub('GET', `/admin/schedule?date=${day(3)}`)).status, 401);
  assert.equal((await pub('POST', '/admin/bookings', { overrideBuffer: true })).status, 401);
});

// ---------- concurrency ----------

test('concurrent back-to-back requests: only one wins', async () => {
  const d = day(29);
  const results = await Promise.all([bookPublic(d, 10, 1), bookPublic(d, 11, 1), bookPublic(d, 10, 1, { startMinute: 30 })]);
  const created = results.filter((r) => r.status === 201).length;
  assert.equal(created, 1, results.map((r) => r.status).join(','));
  const s = await admin('GET', `/schedule?date=${d}`);
  assert.deepEqual(s.body.bufferConflicts, []);
});

// ---------- migration ----------

function oldSchemaDb(file) {
  const old = new Database(file);
  old.exec(`
    CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      hourly_rate INTEGER NOT NULL, capacity INTEGER NOT NULL DEFAULT 6, gear TEXT NOT NULL DEFAULT '[]',
      color TEXT NOT NULL DEFAULT '#F2B33D', active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
      room_id INTEGER NOT NULL REFERENCES rooms(id), date TEXT NOT NULL, start_hour INTEGER NOT NULL,
      paid_hours INTEGER NOT NULL, free_hours INTEGER NOT NULL DEFAULT 0, end_hour INTEGER NOT NULL,
      customer_name TEXT NOT NULL, band_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '', headcount INTEGER NOT NULL DEFAULT 1, notes TEXT NOT NULL DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT 'pay_at_studio', payment_ref TEXT NOT NULL DEFAULT '',
      hourly_rate INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'online', admin_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER REFERENCES rooms(id), date TEXT NOT NULL,
      start_hour INTEGER NOT NULL, end_hour INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings (key, value) VALUES ('open_hour', '9'), ('close_hour', '22');
    INSERT INTO rooms (name, hourly_rate, capacity) VALUES ('Old Room', 350, 6);
  `);
  return old;
}

test('migration: old database gains start_minute and buffer_minutes, old rows read startMinute 0', async () => {
  const file = path.join(tmp, 'old.db');
  const date = day(5);
  const old = oldSchemaDb(file);
  old.prepare(
    `INSERT INTO bookings (code, room_id, date, start_hour, paid_hours, end_hour, customer_name, phone, hourly_rate, total, status)
     VALUES ('BK-OLD111', 1, ?, 12, 2, 14, 'Old Timer', ?, 350, 700, 'confirmed')`
  ).run(date, PHONE);
  assert.ok(!old.prepare('PRAGMA table_info(bookings)').all().some((c) => c.name === 'start_minute'));
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'buffer_minutes'").get().n, 0);
  old.close();

  const s = await startServer(file);
  try {
    const site = await s.api('GET', '/site');
    assert.equal(site.body.settings.buffer_minutes, 30);
    assert.equal(site.body.settings.open_hour, 9, 'existing settings are kept');
    const list = await s.admin('GET', '/bookings');
    assert.equal(list.body.bookings.length, 1);
    assert.equal(list.body.bookings[0].startMinute, 0);
    assert.equal(list.body.bookings[0].endHour, 14);
    const lookup = await s.api('POST', '/bookings/lookup', { code: 'BK-OLD111', phone: PHONE });
    assert.equal(lookup.body.booking.startMinute, 0);

    // the old row takes part in the buffer rule
    const tight = await s.api('POST', '/bookings', {
      roomId: 1, date, startHour: 14, paidHours: 1, name: 'New', phone: PHONE, headcount: 1,
    });
    assert.equal(tight.status, 409);
    assert.equal(tight.body.code, 'buffer');
    const fine = await s.api('POST', '/bookings', {
      roomId: 1, date, startHour: 14, startMinute: 30, paidHours: 1, name: 'New', phone: PHONE, headcount: 1,
    });
    assert.equal(fine.status, 201, JSON.stringify(fine.body));
    // old data is flagged on the schedule only if it is too tight: it is not
    assert.deepEqual((await s.admin('GET', `/schedule?date=${date}`)).body.bufferConflicts, []);
  } finally {
    await s.stop();
  }

  const check = new Database(file, { readonly: true });
  try {
    const col = check.prepare('PRAGMA table_info(bookings)').all().find((c) => c.name === 'start_minute');
    assert.ok(col, 'start_minute column exists');
    assert.equal(col.notnull, 1);
    assert.equal(check.prepare("SELECT value FROM settings WHERE key = 'buffer_minutes'").get().value, '30');
    assert.equal(check.prepare("SELECT start_minute AS m FROM bookings WHERE code = 'BK-OLD111'").get().m, 0);
  } finally {
    check.close();
  }
});

test('migration: a database already on the new schema is left alone on restart', async () => {
  const file = path.join(tmp, 'restart.db');
  const s1 = await startServer(file);
  try {
    const put = await s1.admin('PUT', '/settings', { buffer_minutes: 90 });
    assert.equal(put.status, 200);
    const b = await s1.admin('POST', '/bookings', { roomId: 1, date: day(6), startHour: 10, startMinute: 30, paidHours: 1, name: 'Keep' });
    assert.equal(b.status, 201);
  } finally {
    await s1.stop();
  }
  const s2 = await startServer(file);
  try {
    assert.equal((await s2.api('GET', '/site')).body.settings.buffer_minutes, 90, 'customised buffer survives restart');
    const list = await s2.admin('GET', '/bookings');
    assert.equal(list.body.bookings[0].startMinute, 30);
  } finally {
    await s2.stop();
  }
});

// ---------- time zone ----------

test('lead time follows the Asia/Manila clock even when the process TZ differs', async () => {
  const s = await startServer(path.join(tmp, 'tz.db'), { TZ: 'America/Los_Angeles' });
  try {
    const manilaParts = () => {
      const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(new Date()).map((x) => [x.type, x.value])
      );
      return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
    };
    const expected = (m) => {
      const e = Math.max(10 * 60, Math.ceil((m + 60) / 30) * 30);
      return e >= 22 * 60 ? null : e / 60;
    };
    const t0 = manilaParts();
    const r = await s.api('GET', `/availability?date=${t0.date}`);
    const t1 = manilaParts();
    assert.equal(r.status, 200);
    assert.equal(r.body.now.date === t0.date || r.body.now.date === t1.date, true, 'server date is the Manila date');
    const nowMin = r.body.now.hour * 60 + r.body.now.minute;
    assert.ok(nowMin >= t0.minutes - 1 && nowMin <= t1.minutes + 1 || t1.minutes < t0.minutes, `server clock ${nowMin} is Manila`);
    const allowed = [expected(t0.minutes), expected(t1.minutes)];
    if (allowed.every((a) => a === null)) {
      assert.equal(r.body.window.open, false);
      assert.match(r.body.window.reason, /no more slots/i);
    } else {
      assert.ok(r.body.window.open, 'today is open');
      assert.ok(allowed.includes(r.body.window.earliest), `earliest ${r.body.window.earliest} not in ${allowed}`);
      // earliest is on the half hour grid
      assert.equal((r.body.window.earliest * 2) % 1, 0);
    }
    // tomorrow starts at opening time regardless of the machine zone
    const tomorrow = await s.api('GET', `/availability?date=${addDays(t0.date, 1)}`);
    assert.equal(tomorrow.body.window.earliest, 10);
  } finally {
    await s.stop();
  }
});
