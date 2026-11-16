import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { buildQr, FAKE_ACCOUNT } from './helpers/qr.js';
import { isolatedEnv } from './helpers/isolation.js';

// GCash screenshot payments. The real server (backend/index.js) runs as a child process against throwaway
// folders: DB_PATH, UPLOAD_DIR and RECEIPT_DIR all live under one temp folder (never data/studio.db or data/private).
// Each test uses its own future date so tests do not interfere. The QR is synthetic (tests/helpers/qr.js).
//
// SMTP: every child gets SMTP_HOST=127.0.0.1 and SMTP_PORT=1 so that, even if a developer .env holds mail
// credentials, no test can send a real email (empty values cannot unset .env values on Windows). Tests that
// check email point the server at a tiny fake SMTP server instead.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-gcash-'));
const PASSWORD = 'test-password-gcash';
const PHONE = '09171234567';
const PAYLOAD = buildQr();

const extraServers = [];
// Never leave a child server behind, even if the runner dies or a test throws.
process.on('exit', () => extraServers.forEach((x) => x.kill?.()));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

/**
 * Starts backend/index.js on a free port. `name` names the sub folders (uploads and receipts are siblings, never nested).
 * Returns helpers: api (public), admin (token), upload (customer screenshot), adminRaw, logs(), stop().
 */
// A free port can be taken between probing it and the child binding it (other test files run at the same time):
// retry on a new port when the child died at startup.
async function startServer(name, opts) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startServerOnce(name, opts);
    } catch (err) {
      if (attempt >= 3 || !/did not start/.test(String(err.message))) throw err;
    }
  }
}

async function startServerOnce(name, { env: extraEnv = {}, dbPath, receiptDir, qr = true } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  dbPath ||= path.join(tmp, `${name}.db`);
  const uploadDir = path.join(tmp, `${name}-uploads`);
  receiptDir ||= path.join(tmp, `${name}-receipts`);
  // All app variables pinned (tests/helpers/isolation.js); `undefined` in extraEnv means "default" (pinned blank so the
  // real .env cannot fill it in). Throws unless DB_PATH, UPLOAD_DIR and RECEIPT_DIR are temp paths.
  const env = isolatedEnv(tmp, {
    PORT: String(port),
    DB_PATH: dbPath,
    UPLOAD_DIR: uploadDir,
    RECEIPT_DIR: receiptDir,
    BACKUP_DIR: path.join(tmp, `${name}-backups`),
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_TOKEN_SECRET: `test-secret-${name}`,
    UPLOAD_RATE_LIMIT: '1000',
    LOOKUP_FAIL_LIMIT: '1000',
    ...extraEnv,
  });
  const child = spawn(process.execPath, [path.join(root, 'backend', 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Registered at once so a failed start or login never leaves this child running (a leaked child holds the runner open).
  extraServers.push({ kill: () => child.kill() });
  const logLines = [];
  child.stdout.on('data', (d) => logLines.push(String(d)));
  child.stderr.on('data', (d) => logLines.push(String(d)));
  let up = false;
  for (let i = 0; i < 150 && !up && child.exitCode === null; i++) {
    try {
      // an exited child (e.g. the port was taken) must not be mistaken for another server answering on that port
      up = (await fetch(`${base}/api/site`, { signal: AbortSignal.timeout(5000) })).ok && child.exitCode === null;
    } catch {
      /* not up yet */
    }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) child.kill();
  assert.ok(up, `server ${name} did not start: ${logLines.join('')}`);
  const login = await fetch(`${base}/api/admin/login`, {
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const token = (await login.json()).token;
  assert.ok(token, 'could not log in');

  async function read(res) {
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  async function api(method, url, body, { auth = false, token: tok = token, rawBody } = {}) {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${tok}`;
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}/api${url}`, {
      signal: AbortSignal.timeout(30_000),
      method,
      headers,
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    });
    return read(res);
  }
  /** Customer screenshot upload (raw image body, code and phone in headers). */
  async function upload(code, phone, buf, { type = 'image/png', ref, headers = {} } = {}) {
    const h = { 'content-type': type, ...headers };
    if (code !== null) h['x-booking-code'] = code;
    if (phone !== null) h['x-booking-phone'] = phone;
    if (ref) h['x-payment-ref'] = ref;
    return read(await fetch(`${base}/api/bookings/payment-proof`, { method: 'POST', headers: h, body: buf, signal: AbortSignal.timeout(30_000) }));
  }
  /** Admin request with a raw (or empty) body and custom headers, for the balance route. */
  async function adminRaw(method, url, buf, headers = {}, { auth = true } = {}) {
    const h = { ...headers };
    if (auth) h.authorization = `Bearer ${token}`;
    return read(await fetch(`${base}/api/admin${url}`, { method, headers: h, body: buf, signal: AbortSignal.timeout(30_000) }));
  }
  let stopping = null;
  const stop = () =>
    (stopping ||= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      child.stdout.destroy();
      child.stderr.destroy();
      await new Promise((r) => setTimeout(r, 200));
    })());
  const srv = {
    name, base, token, dbPath, kill: () => child.kill(), uploadDir, receiptDir, api, upload, adminRaw, stop,
    admin: (m, u, b) => api(m, `/admin${u}`, b, { auth: true }),
    logs: () => logLines.join(''),
  };
  extraServers.push(srv);
  if (qr) assert.equal((await srv.admin('PUT', '/settings/gcash-qr', { payload: PAYLOAD })).status, 200);
  return srv;
}

let srv;
let pub;
let admin;
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.endsWith('.tmp')) : []);

before(async () => {
  srv = await startServer('main');
  pub = srv.api;
  admin = srv.admin;
});

after(async () => {
  await srv.stop().catch(() => {});
  await Promise.all(extraServers.map((x) => (x.stop ? x.stop() : Promise.resolve(x.kill())).catch(() => {})));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
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
let dayCounter = 2;
const freshDay = () => day(dayCounter++);

const withDb = (file, fn) => {
  const d = new Database(file);
  try {
    return fn(d);
  } finally {
    d.close();
  }
};
const pastIso = (ms = 60_000) => new Date(Date.now() - ms).toISOString();
const expireHold = (code, s = srv) => withDb(s.dbPath, (d) => d.prepare('UPDATE bookings SET hold_expires_at = ? WHERE code = ?').run(pastIso(), code));

// Smallest buffers that pass the magic-byte check.
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(40)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBP'), crypto.randomBytes(40)]);

const gbody = (date, startHour, extra = {}) => ({
  roomId: 1, date, startHour, paidHours: 1, name: 'Gina Gcash', phone: PHONE, headcount: 2,
  paymentMethod: 'gcash', paymentPlan: 'half', ...extra,
});
async function gcash(date, startHour = 14, extra = {}, s = srv) {
  const r = await s.api('POST', '/bookings', gbody(date, startHour, extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.booking;
}
async function plain(date, startHour, extra = {}, s = srv) {
  const r = await s.api('POST', '/bookings', { roomId: 1, date, startHour, paidHours: 1, name: 'Pat Plain', phone: PHONE, headcount: 2, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.booking;
}
const creds = (b) => ({ code: b.code, phone: PHONE });
const lookup = async (b, s = srv) => (await s.api('POST', '/bookings/lookup', creds(b))).body.booking;
async function idOf(code, s = srv) {
  // The admin search also matches phone numbers by the digits in the query, so a code whose digits happen to sit in
  // the test phone number (BK-2A3B4C and 0917 123 4567) lists every booking. Pick the exact code out of the page.
  const r = await s.admin('GET', `/bookings?q=${code}&limit=200`);
  const hits = r.body.bookings.filter((x) => x.code === code);
  assert.equal(hits.length, 1);
  return hits[0].id;
}
const detail = async (b, s = srv) => (await s.admin('GET', `/payments/${await idOf(b.code, s)}`)).body.booking;
const events = async (b, s = srv) => (await detail(b, s)).events;
const actions = async (b, s = srv) => (await events(b, s)).map((e) => e.action);
async function uploadOk(b, s = srv, buf = png(), opts) {
  const r = await s.upload(b.code, PHONE, buf, opts);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.booking;
}
async function confirm(b, body = {}, s = srv) {
  return s.admin('POST', `/payments/${await idOf(b.code, s)}/confirm`, body);
}
async function confirmOk(b, body, s = srv) {
  await uploadOk(b, s);
  const r = await confirm(b, body, s);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.booking;
}
const setSettings = async (s) => assert.equal((await admin('PUT', '/settings', s)).status, 200);
const monthFree = async (date) => {
  const r = await pub('GET', `/availability/month?month=${date.slice(0, 7)}`);
  return r.body.days.find((d) => d.date === date).freeHours;
};
const busyOf = async (date, roomId = 1) => (await pub('GET', `/availability?date=${date}`)).body.rooms.find((r) => r.id === roomId).busy;

// ---------- amounts, holds and settings ----------

test('half is 50% rounded up to a whole peso, full is the total, and the booking starts as a pending hold', async () => {
  const d = freshDay();
  const half = await gcash(d, 10); // Room A 400/h, 1 hour
  assert.equal(half.total, 400);
  assert.equal(half.payment.plan, 'half');
  assert.equal(half.payment.amountDue, 200);
  assert.equal(half.status, 'pending');
  assert.equal(half.paymentMethod, 'gcash');
  assert.equal(half.payment.status, 'awaiting_proof');
  assert.equal(half.payment.stage, 'awaiting_proof');
  assert.equal(half.payment.paidAmount, 0);
  assert.equal(half.payment.proofCount, 0);
  assert.equal(half.payment.canUploadProof, true);
  assert.equal(half.payment.refundStatus, '');

  const full = await gcash(d, 13, { paymentPlan: 'full' });
  assert.equal(full.payment.amountDue, 400);
  assert.equal(full.payment.plan, 'full');

  // an odd total: a 333 pesos/hour room, 1 hour -> half is 166.5 -> 167
  const room = await admin('POST', '/rooms', { name: 'Odd Room', hourlyRate: 333, capacity: 4 });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  const roomId = room.body.room?.id ?? room.body.id;
  assert.ok(roomId, 'room id');
  const odd = await gcash(d, 10, { roomId });
  assert.equal(odd.total, 333);
  assert.equal(odd.payment.amountDue, 167);
  const oddFull = await gcash(d, 13, { roomId, paymentPlan: 'full' });
  assert.equal(oddFull.payment.amountDue, 333);
  // deactivate so later tests that count rooms are not affected
  await admin('PUT', `/rooms/${roomId}`, { name: 'Odd Room', hourlyRate: 333, capacity: 4, active: false });
});

test('a GCash booking needs a valid plan and always starts pending, even with auto_confirm on', async () => {
  const d = freshDay();
  for (const bad of [undefined, '', 'third', 'HALF', 50, null]) {
    const r = await pub('POST', '/bookings', gbody(d, 10, { paymentPlan: bad }));
    assert.equal(r.status, 400, String(bad));
    assert.ok(r.body.fields.paymentPlan, `plan field error for ${bad}`);
  }
  await setSettings({ auto_confirm: true });
  try {
    const b = await gcash(d, 10);
    assert.equal(b.status, 'pending');
    const plain1 = await plain(d, 14);
    assert.equal(plain1.status, 'confirmed', 'non-GCash still follows auto_confirm');
    assert.equal(plain1.payment.plan, '');
    assert.equal(plain1.payment.stage, '');
    assert.equal(plain1.payment.holdExpiresAt, null);
  } finally {
    await setSettings({ auto_confirm: false });
  }
  const sched = await admin('GET', `/schedule?date=${d}`);
  assert.equal(sched.body.bookings.length, 2, 'rejected requests created nothing');
});

test('hold length follows gcash_hold_minutes and is a UTC ISO instant; the setting is range checked', async () => {
  const d = freshDay();
  const a = await gcash(d, 10);
  const t0 = Date.parse(a.payment.holdExpiresAt);
  assert.match(a.payment.holdExpiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const created = Date.now();
  assert.ok(Math.abs(t0 - (created + 30 * 60_000)) < 60_000, 'default hold is 30 minutes');

  await setSettings({ gcash_hold_minutes: 60 });
  try {
    const b = await gcash(d, 13);
    const mins = (Date.parse(b.payment.holdExpiresAt) - Date.now()) / 60_000;
    assert.ok(mins > 59 && mins <= 60.05, `hold is ${mins} minutes`);
    assert.equal((await pub('GET', '/site')).body.settings.gcash_hold_minutes, 60);
  } finally {
    await setSettings({ gcash_hold_minutes: 30 });
  }
  for (const bad of [4, 241, 0, -5, 'abc', 10.5]) {
    assert.equal((await admin('PUT', '/settings', { gcash_hold_minutes: bad })).status, 400, `hold ${bad}`);
  }
  for (const ok of [5, 240]) assert.equal((await admin('PUT', '/settings', { gcash_hold_minutes: ok })).status, 200);
  await setSettings({ gcash_hold_minutes: 30 });

  for (const bad of [6, 366, 0, 'x']) {
    assert.equal((await admin('PUT', '/settings', { receipt_retention_days: bad })).status, 400, `retention ${bad}`);
  }
  for (const ok of [7, 365]) assert.equal((await admin('PUT', '/settings', { receipt_retention_days: ok })).status, 200);
  await setSettings({ receipt_retention_days: 60 });
  assert.equal((await admin('GET', '/settings')).body.settings.receipt_retention_days, 60);
});

// ---------- the studio QR ----------

test('without a stored QR, GCash is refused and /api/site says it is off; a bad QR is rejected', async () => {
  const d = freshDay();
  const bad = await admin('PUT', '/settings/gcash-qr', { payload: buildQr({ badCrc: true }) });
  assert.equal(bad.status, 400);
  assert.ok(!bad.text.includes(FAKE_ACCOUNT), 'error does not echo the payload');
  for (const junk of [undefined, '', 123, 'hello', buildQr({ currency: '840' })]) {
    assert.equal((await admin('PUT', '/settings/gcash-qr', { payload: junk })).status, 400);
  }
  assert.equal((await admin('GET', '/settings/gcash-qr')).body.configured, true, 'the good QR is still stored');

  assert.equal((await admin('DELETE', '/settings/gcash-qr')).body.configured, false);
  try {
    assert.equal((await pub('GET', '/site')).body.settings.gcash_enabled, false);
    const r = await pub('POST', '/bookings', gbody(d, 10));
    assert.equal(r.status, 400);
    assert.ok(r.body.fields.paymentMethod);
    assert.equal((await admin('POST', '/settings/gcash-qr/preview', { amount: 50 })).status, 409);
    // pay at the studio still works
    assert.equal((await pub('POST', '/bookings', { ...gbody(d, 10), paymentMethod: 'pay_at_studio' })).status, 201);
  } finally {
    assert.equal((await admin('PUT', '/settings/gcash-qr', { payload: PAYLOAD })).status, 200);
  }
  assert.equal((await pub('GET', '/site')).body.settings.gcash_enabled, true);
});

test('the QR summary is masked and the raw QR text is never returned by any endpoint', async () => {
  const d = freshDay();
  const summary = await admin('GET', '/settings/gcash-qr');
  assert.equal(summary.body.configured, true);
  assert.equal(summary.body.merchantName, 'TEST MERCHANT');
  assert.equal(summary.body.city, 'TESTVILLE');
  assert.ok(!summary.text.includes(FAKE_ACCOUNT));
  assert.ok(!summary.text.includes(PAYLOAD));
  const put = await admin('PUT', '/settings/gcash-qr', { payload: PAYLOAD });
  assert.ok(!put.text.includes(FAKE_ACCOUNT));

  const preview = await admin('POST', '/settings/gcash-qr/preview', { amount: 50 });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.amount, '50.00');
  assert.ok(preview.body.qrSvg.startsWith('<svg'));
  assert.ok(!preview.text.includes(FAKE_ACCOUNT) && !preview.text.includes(PAYLOAD));
  for (const bad of [0, -5, 1.5, 'abc', undefined]) {
    assert.equal((await admin('POST', '/settings/gcash-qr/preview', { amount: bad })).status, 400, `preview ${bad}`);
  }

  const b = await gcash(d, 10);
  const qr = await pub('POST', '/bookings/payment-qr', creds(b));
  assert.equal(qr.status, 200, qr.text);
  assert.deepEqual(Object.keys(qr.body).sort(), ['amount', 'holdExpiresAt', 'qrSvg', 'serverTime']);
  assert.equal(qr.body.amount, '200.00');
  assert.ok(qr.body.qrSvg.startsWith('<svg'));
  assert.ok(!qr.text.includes(FAKE_ACCOUNT) && !qr.text.includes(PAYLOAD), 'no raw QR text');
  assert.equal(qr.headers.get('cache-control'), 'no-store');
  assert.equal(qr.body.holdExpiresAt, b.payment.holdExpiresAt);
  assert.ok(Math.abs(Date.parse(qr.body.serverTime) - Date.now()) < 5000);

  // the full plan asks for a different amount, so the picture differs
  const f = await gcash(d, 13, { paymentPlan: 'full' });
  const qrFull = await pub('POST', '/bookings/payment-qr', creds(f));
  assert.equal(qrFull.body.amount, '400.00');
  assert.notEqual(qrFull.body.qrSvg, qr.body.qrSvg);

  // needs the right code and phone
  assert.equal((await pub('POST', '/bookings/payment-qr', { code: b.code, phone: '09170000000' })).status, 404);
  assert.equal((await pub('POST', '/bookings/payment-qr', { code: 'BK-NOPE', phone: PHONE })).status, 404);
  assert.equal((await pub('POST', '/bookings/payment-qr', {})).status, 404);
  // phone formats are accepted
  assert.equal((await pub('POST', '/bookings/payment-qr', { code: b.code, phone: '+63 917-123-4567' })).status, 200);
  // not for a booking that is not waiting for GCash
  const p = await plain(d, 16);
  assert.equal((await pub('POST', '/bookings/payment-qr', creds(p))).status, 409);
  // and not once a screenshot is in
  await uploadOk(b);
  assert.equal((await pub('POST', '/bookings/payment-qr', creds(b))).status, 409);
});

test('/api/site and public responses leak neither the QR text nor the old GCash name and number', async () => {
  const d = freshDay();
  withDb(srv.dbPath, (db) => {
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    up.run('gcash_name', JSON.stringify('Legacy Fake Name'));
    up.run('gcash_number', JSON.stringify('09000000042'));
  });
  const b = await gcash(d, 10);
  const surfaces = [
    (await pub('GET', '/site')).text,
    (await pub('GET', `/availability?date=${d}`)).text,
    (await pub('GET', `/availability/month?month=${d.slice(0, 7)}`)).text,
    (await pub('POST', '/bookings/lookup', creds(b))).text,
    (await pub('POST', '/bookings/payment-qr', creds(b))).text,
  ];
  for (const text of surfaces) {
    assert.ok(!text.includes(FAKE_ACCOUNT), 'no QR account');
    assert.ok(!text.includes(PAYLOAD), 'no QR payload');
    assert.ok(!text.includes('Legacy Fake Name'), 'no old name');
    assert.ok(!text.includes('09000000042'), 'no old number');
    assert.ok(!/gcash_name|gcash_number|gcashName|gcashNumber|gcash_qr/.test(text), 'no key names');
  }
  // the admin settings and schedule never hold the QR either; legacy values are admin-only
  assert.ok(!(await admin('GET', `/schedule?date=${d}`)).text.includes(FAKE_ACCOUNT));
  const settings = await admin('GET', '/settings');
  assert.ok(!settings.text.includes(FAKE_ACCOUNT));
  assert.deepEqual(settings.body.legacy, { gcashName: 'Legacy Fake Name', gcashNumber: '09000000042' });
});

// ---------- a held slot counts as busy everywhere ----------

test('a held slot blocks other customers, walk-ins, blocks, reschedules and shows in the month view with its buffer', async () => {
  const d = freshDay();
  const before = await monthFree(d);
  const held = await gcash(d, 14); // 14:00-15:00, plus 30 min cleaning
  assert.equal(held.status, 'pending');

  // other customers: overlap and cleaning buffer
  const overlap = await pub('POST', '/bookings', gbody(d, 14, { paymentMethod: 'pay_at_studio' }));
  assert.equal(overlap.status, 409);
  const other = await pub('POST', '/bookings', gbody(d, 14));
  assert.equal(other.status, 409, 'a second GCash customer cannot take it either');
  const buffer = await pub('POST', '/bookings', gbody(d, 15, { paymentMethod: 'pay_at_studio' }));
  assert.equal(buffer.status, 409);
  assert.equal(buffer.body.code, 'buffer');
  const beforeSide = await pub('POST', '/bookings', gbody(d, 13, { paymentMethod: 'pay_at_studio' }));
  assert.equal(beforeSide.status, 409);
  assert.equal(beforeSide.body.code, 'buffer');

  // availability and month view
  const busy = await busyOf(d);
  assert.equal(busy.length, 1);
  assert.deepEqual([busy[0].start, busy[0].end, busy[0].kind, busy[0].bufferEnd], [14, 15, 'booking', 15.5]);
  assert.equal(before - (await monthFree(d)), 1.5, 'one hour plus the 30 minute cleaning buffer');

  // walk-ins and blocks
  const walk = await admin('POST', '/bookings', { roomId: 1, date: d, startHour: 14, paidHours: 1, name: 'Walk In' });
  assert.equal(walk.status, 409);
  const walkBuffer = await admin('POST', '/bookings', { roomId: 1, date: d, startHour: 15, paidHours: 1, name: 'Walk In' });
  assert.equal(walkBuffer.status, 409);
  assert.equal(walkBuffer.body.code, 'buffer');
  const block = await admin('POST', '/blocks', { roomId: 1, date: d, startHour: 13, endHour: 16, reason: 'repairs' });
  assert.equal(block.status, 409);
  const blockAll = await admin('POST', '/blocks', { roomId: null, date: d, startHour: 14, endHour: 15 });
  assert.equal(blockAll.status, 409);
  // another room is free
  assert.equal((await pub('POST', '/bookings', gbody(d, 14, { roomId: 2, paymentMethod: 'pay_at_studio' }))).status, 201);

  // reschedule by the customer and by staff into the held slot
  const mover = await plain(d, 19);
  const rs = await pub('POST', '/bookings/reschedule', { ...creds(mover), date: d, startHour: 14 });
  assert.equal(rs.status, 409);
  const rsBuffer = await pub('POST', '/bookings/reschedule', { ...creds(mover), date: d, startHour: 15 });
  assert.equal(rsBuffer.status, 409);
  assert.equal(rsBuffer.body.code, 'buffer');
  const moverId = await idOf(mover.code);
  assert.equal((await admin('PATCH', `/bookings/${moverId}`, { startHour: 14 })).status, 409);
  assert.equal((await admin('PATCH', `/bookings/${moverId}`, { roomId: 1, startHour: 14, paidHours: 1 })).status, 409);

  // admin calendar and schedule show the held booking
  const cal = await admin('GET', `/calendar?month=${d.slice(0, 7)}`);
  assert.ok(cal.body.days[d].pending >= 1);
  const sched = await admin('GET', `/schedule?date=${d}`);
  const row = sched.body.bookings.find((b) => b.code === held.code);
  assert.equal(row.status, 'pending');
  assert.equal(row.payment.stage, 'awaiting_proof');
});

test('after the hold ends the slot is free again everywhere, lazily and for good', async () => {
  const d = freshDay();
  const before = await monthFree(d);
  const held = await gcash(d, 14);
  assert.equal(before - (await monthFree(d)), 1.5);
  const id = await idOf(held.code);

  // the hold runs out (written straight to the temp database, no request in between to sweep it)
  expireHold(held.code);
  assert.deepEqual(await busyOf(d), [], 'availability ignores an expired hold even before the sweep');
  assert.equal(await monthFree(d), before, 'month view too, including the buffer');

  // another customer can take it, and so can staff
  const next = await plain(d, 14);
  assert.equal(next.status, 'pending');
  // the old booking reads as expired
  const old = await lookup(held);
  assert.equal(old.status, 'expired');
  assert.equal(old.payment.stage, 'expired');
  assert.equal(old.payment.canUploadProof, true, 'a late screenshot is still allowed (revive or slot_taken)');
  assert.equal(old.canCancel, false);
  assert.equal(old.canReschedule, false);
  assert.ok((await actions(held)).includes('hold_expired'));
  const ev = (await events(held)).find((e) => e.action === 'hold_expired');
  assert.equal(ev.actor, 'system');
  assert.equal((await admin('GET', `/bookings/${id}`)).body.booking.status, 'expired');

  // staff: walk-in and block on a second expired hold
  const d2 = freshDay();
  const held2 = await gcash(d2, 12);
  expireHold(held2.code);
  const walk = await admin('POST', '/bookings', { roomId: 1, date: d2, startHour: 12, paidHours: 1, name: 'Walk In' });
  assert.equal(walk.status, 201, JSON.stringify(walk.body));
  const d3 = freshDay();
  const held3 = await gcash(d3, 12);
  expireHold(held3.code);
  const block = await admin('POST', '/blocks', { roomId: 1, date: d3, startHour: 12, endHour: 14 });
  assert.equal(block.status, 201, JSON.stringify(block.body));

  // the admin calendar no longer counts the expired booking, and the schedule lists it as expired with no buffer clash
  const d4 = freshDay();
  const held4 = await gcash(d4, 12);
  const calBefore = (await admin('GET', `/calendar?month=${d4.slice(0, 7)}`)).body.days[d4];
  assert.equal(calBefore.bookings, 1);
  expireHold(held4.code);
  const calAfter = (await admin('GET', `/calendar?month=${d4.slice(0, 7)}`)).body.days[d4];
  assert.equal(calAfter?.bookings ?? 0, 0);
  const sched = await admin('GET', `/schedule?date=${d4}`);
  assert.equal(sched.body.bookings[0].status, 'expired');
  assert.deepEqual(sched.body.bufferConflicts, []);
  // 'expired' is system-only
  const id4 = await idOf(held4.code);
  assert.equal((await admin('PATCH', `/bookings/${id4}`, { status: 'expired' })).status, 400);
});

test('a hold that ended exactly now is already free', async () => {
  const d = freshDay();
  const b = await gcash(d, 11);
  withDb(srv.dbPath, (db) => db.prepare('UPDATE bookings SET hold_expires_at = ? WHERE code = ?').run(new Date().toISOString(), b.code));
  assert.equal((await pub('POST', '/bookings', gbody(d, 11, { paymentMethod: 'pay_at_studio' }))).status, 201);
});

test('a hold is not cut short: a screenshot, staff confirmation or "not received" clears the timer', async () => {
  const d = freshDay();
  const up = await gcash(d, 10);
  await uploadOk(up);
  withDb(srv.dbPath, (db) => assert.equal(db.prepare('SELECT hold_expires_at AS h FROM bookings WHERE code = ?').get(up.code).h, null));
  assert.equal((await lookup(up)).payment.holdExpiresAt, null);
  // let a sweep run: still pending, still holding
  await admin('GET', '/payments');
  assert.equal((await lookup(up)).status, 'pending');
  assert.equal((await pub('POST', '/bookings', gbody(d, 10, { paymentMethod: 'pay_at_studio' }))).status, 409);

  // admin confirms an awaiting booking by hand: no ghost expiry afterwards
  // (flipping the status by PATCH is refused for GCash bookings now; see the PATCH guard tests)
  const manual = await gcash(d, 13);
  const id = await idOf(manual.code);
  assert.equal((await admin('PATCH', `/bookings/${id}`, { status: 'confirmed' })).status, 409);
  const done = await confirmOk(manual);
  assert.equal(done.payment.holdExpiresAt, null);
  expireHold(manual.code);
  await admin('GET', '/payments');
  assert.equal((await lookup(manual)).status, 'confirmed');
});

test('concurrent GCash bookings for the same slot: only one wins', async () => {
  const d = freshDay();
  const results = await Promise.all([
    pub('POST', '/bookings', gbody(d, 15)),
    pub('POST', '/bookings', gbody(d, 15, { paymentPlan: 'full' })),
    pub('POST', '/bookings', gbody(d, 15, { paymentMethod: 'pay_at_studio' })),
    pub('POST', '/bookings', gbody(d, 16)),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(','));
});

// ---------- pay later ----------

test('pay later releases the slot, only from awaiting_proof', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  assert.equal((await pub('POST', '/bookings/release', { code: b.code, phone: '09170000000' })).status, 404);
  const r = await pub('POST', '/bookings/release', creds(b));
  assert.equal(r.status, 200);
  assert.equal(r.body.booking.status, 'cancelled');
  assert.equal(r.body.booking.payment.holdExpiresAt, null);
  assert.equal(r.body.booking.payment.canUploadProof, false);
  assert.deepEqual(await busyOf(d), []);
  assert.equal((await pub('POST', '/bookings/release', creds(b))).status, 409, 'second release');
  assert.ok((await actions(b)).includes('released'));
  assert.equal((await plain(d, 14)).status, 'pending', 'the slot can be booked again');

  // not once a screenshot is in
  const d2 = freshDay();
  const c = await gcash(d2, 14);
  await uploadOk(c);
  assert.equal((await pub('POST', '/bookings/release', creds(c))).status, 409);
  assert.equal((await lookup(c)).status, 'pending');
  // not after the hold has expired (it is already released)
  const e = await gcash(d2, 17);
  expireHold(e.code);
  assert.equal((await pub('POST', '/bookings/release', creds(e))).status, 409);
});

// ---------- screenshot upload ----------

test('upload validation: magic bytes, declared type, empty body, headers, phone', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  const dir = srv.receiptDir;
  const n0 = files(dir).length;

  // wrong magic bytes with an image content type
  const text = await srv.upload(b.code, PHONE, Buffer.from('this is plainly not an image at all'), { type: 'image/png' });
  assert.equal(text.status, 415);
  const gif = await srv.upload(b.code, PHONE, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30)]), { type: 'image/png' });
  assert.equal(gif.status, 415);
  const svg = await srv.upload(b.code, PHONE, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { type: 'image/png' });
  assert.equal(svg.status, 415);
  const exe = await srv.upload(b.code, PHONE, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40)]), { type: 'image/jpeg' });
  assert.equal(exe.status, 415);
  // real bytes, mismatched declared type (forged)
  assert.equal((await srv.upload(b.code, PHONE, png(), { type: 'image/jpeg' })).status, 415);
  assert.equal((await srv.upload(b.code, PHONE, jpg(), { type: 'image/png' })).status, 415);
  assert.equal((await srv.upload(b.code, PHONE, webp(), { type: 'image/png' })).status, 415);
  // types that are not accepted at all
  assert.equal((await srv.upload(b.code, PHONE, png(), { type: 'text/plain' })).status, 415);
  assert.equal((await srv.upload(b.code, PHONE, png(), { type: 'application/octet-stream' })).status, 415);
  assert.equal((await srv.upload(b.code, PHONE, png(), { type: 'image/svg+xml' })).status, 415);
  // empty and too short
  assert.equal((await srv.upload(b.code, PHONE, Buffer.alloc(0))).status, 415);
  assert.equal((await srv.upload(b.code, PHONE, Buffer.from([0x89, 0x50]))).status, 415);
  // identity headers
  assert.equal((await srv.upload(b.code, '09170000000', png())).status, 404, 'wrong phone');
  assert.equal((await srv.upload('BK-ZZZZZZ', PHONE, png())).status, 404, 'unknown code');
  assert.equal((await srv.upload(null, PHONE, png())).status, 404, 'missing code');
  assert.equal((await srv.upload(b.code, null, png())).status, 404, 'missing phone');
  // plain booking is not a GCash booking
  const p = await plain(d, 17);
  assert.equal((await srv.upload(p.code, PHONE, png())).status, 409);

  assert.equal(files(dir).length, n0, 'nothing was stored for any rejected upload');
  assert.equal((await lookup(b)).payment.proofCount, 0);
  assert.equal((await lookup(b)).payment.status, 'awaiting_proof');
});

test('a valid upload is stored outside UPLOAD_DIR and /media, moves the booking to proof_submitted, and the 4th file is refused', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  const dir = srv.receiptDir;
  const n0 = files(dir).length;

  const first = await srv.upload(b.code, '+63 917 123 4567', png(), { ref: ' 1234 5678 ' });
  assert.equal(first.status, 201, first.text);
  assert.equal(first.body.booking.payment.status, 'proof_submitted');
  assert.equal(first.body.booking.payment.stage, 'proof_submitted');
  assert.equal(first.body.booking.payment.holdExpiresAt, null);
  assert.equal(first.body.booking.payment.proofCount, 1);
  assert.equal(first.body.booking.status, 'pending');
  assert.equal(first.body.booking.paymentRef, '1234 5678');
  assert.ok(first.body.serverTime);
  assert.equal(files(dir).length, n0 + 1);
  const stored = files(dir).at(-1);
  // the public response never carries file names
  assert.ok(!first.text.includes(stored.replace(/\.\w+$/, '')));

  // the file is not under the served upload folder, and nothing under /media reaches it
  assert.ok(path.resolve(dir) !== path.resolve(srv.uploadDir));
  assert.ok(!path.resolve(dir).startsWith(path.resolve(srv.uploadDir) + path.sep));
  assert.ok(!path.resolve(srv.uploadDir).startsWith(path.resolve(dir) + path.sep));
  assert.ok(!files(srv.uploadDir).includes(stored));
  const walk = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => walk(path.join(p, f))) : [p]);
  assert.ok(!walk(srv.uploadDir).some((f) => path.basename(f) === stored), 'not anywhere in UPLOAD_DIR');
  for (const url of [`/media/${stored}`, `/media/gallery/${stored}`, `/media/receipts/${stored}`]) {
    const res = await fetch(`${srv.base}${url}`);
    assert.equal(res.status, 404, url);
    assert.ok(!(res.headers.get('content-type') || '').startsWith('image/'));
  }

  // identical bytes for two bookings are flagged for staff
  const sameBytes = png();
  const x = await gcash(d, 17);
  await uploadOk(x, srv, sameBytes);
  const y = await gcash(freshDay(), 20);
  await uploadOk(y, srv, sameBytes);
  const flagged = (await detail(y)).proofs[0];
  assert.equal(flagged.duplicateOf, x.code);

  // a 2nd and 3rd screenshot are fine (jpeg and webp too), the 4th is refused and leaves nothing behind
  assert.equal((await srv.upload(b.code, PHONE, jpg(), { type: 'image/jpeg' })).status, 201);
  assert.equal((await srv.upload(b.code, PHONE, webp(), { type: 'image/webp' })).status, 201);
  const count = files(dir).length;
  const fourth = await srv.upload(b.code, PHONE, png());
  assert.equal(fourth.status, 409);
  assert.equal(files(dir).length, count, 'the refused file was removed from disk');
  assert.equal((await lookup(b)).payment.proofCount, 3);
});

test('an upload over 15 MB is refused with 413 and stores nothing', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  const n0 = files(srv.receiptDir).length;
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(15 * 1024 * 1024)]);
  let status;
  try {
    status = (await srv.upload(b.code, PHONE, big)).status;
  } catch (err) {
    // the server may close the connection while the client is still sending; that is also a refusal
    status = /fetch failed|EPIPE|ECONNRESET/i.test(`${err.message} ${err.cause?.code}`) ? 413 : -1;
  }
  assert.equal(status, 413);
  assert.equal(files(srv.receiptDir).length, n0);
  // exactly at the limit is accepted
  const edge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(15 * 1024 * 1024 - 8)]);
  assert.equal((await srv.upload(b.code, PHONE, edge)).status, 201);
  assert.equal((await lookup(b)).payment.proofCount, 1);
});

test('upload and lookup rate limits answer 429 (defaults 10 uploads and 30 misses per 15 minutes)', async () => {
  const s = await startServer('rl-default', { env: { UPLOAD_RATE_LIMIT: undefined, LOOKUP_FAIL_LIMIT: undefined } });
  try {
    for (let i = 1; i <= 10; i++) {
      assert.equal((await s.upload('BK-NOSUCH', PHONE, png())).status, 404, `upload ${i}`);
    }
    assert.equal((await s.upload('BK-NOSUCH', PHONE, png())).status, 429, 'the 11th upload');
    for (let i = 1; i <= 20; i++) {
      assert.equal((await s.api('POST', '/bookings/lookup', { code: 'BK-NOSUCH', phone: PHONE })).status, 404, `miss ${i + 10}`);
    }
    const blocked = await s.api('POST', '/bookings/lookup', { code: 'BK-NOSUCH', phone: PHONE });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.body.error);
  } finally {
    await s.stop();
  }
});

test('lowered limits from the environment apply, and a blocked IP is refused even with correct details', async () => {
  const s = await startServer('rl-low', { env: { UPLOAD_RATE_LIMIT: '2', LOOKUP_FAIL_LIMIT: '2' } });
  try {
    const d = freshDay();
    const b = await gcash(d, 14, {}, s);
    assert.equal((await s.upload(b.code, PHONE, png())).status, 201);
    assert.equal((await s.upload(b.code, PHONE, png())).status, 201);
    assert.equal((await s.upload(b.code, PHONE, png())).status, 429, 'third upload with correct details');
    assert.equal((await s.api('POST', '/bookings/lookup', creds(b))).status, 200, 'looking up is not an upload');
    assert.equal((await s.api('POST', '/bookings/lookup', { code: b.code, phone: '09170000000' })).status, 404);
    assert.equal((await s.api('POST', '/bookings/lookup', { code: b.code, phone: '09170000000' })).status, 404);
    for (const [url, body] of [
      ['/bookings/lookup', creds(b)],
      ['/bookings/payment-qr', creds(b)],
      ['/bookings/release', creds(b)],
      ['/bookings/cancel', creds(b)],
      ['/bookings/reschedule', { ...creds(b), date: d, startHour: 17 }],
    ]) {
      assert.equal((await s.api('POST', url, body)).status, 429, url);
    }
    assert.equal((await s.upload(b.code, PHONE, png())).status, 429);
    assert.equal((await s.api('POST', '/bookings', gbody(d, 19), {})).status, 201, 'creating bookings is not limited');
  } finally {
    await s.stop();
  }
});

// ---------- late uploads ----------

test('a late screenshot revives an expired hold when the slot is still free', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  expireHold(b.code);
  assert.equal((await lookup(b)).status, 'expired');
  const r = await srv.upload(b.code, PHONE, png());
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.booking.status, 'pending');
  assert.equal(r.body.booking.payment.status, 'proof_submitted');
  assert.equal(r.body.booking.payment.holdExpiresAt, null);
  assert.equal(r.body.booking.endHour, 15);
  const acts = await actions(b);
  assert.ok(acts.includes('hold_expired') && acts.includes('revived') && acts.includes('proof_uploaded'));
  // the slot is held again
  assert.equal((await pub('POST', '/bookings', gbody(d, 14, { paymentMethod: 'pay_at_studio' }))).status, 409);
});

test('a late screenshot after the slot was taken gets 409 slot_taken and nothing is stored', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  expireHold(b.code);
  const taker = await plain(d, 14);
  assert.equal(taker.status, 'pending');
  const n0 = files(srv.receiptDir).length;
  const r = await srv.upload(b.code, PHONE, png());
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'slot_taken');
  assert.equal(files(srv.receiptDir).length, n0);
  const after = await lookup(b);
  assert.equal(after.status, 'expired');
  assert.equal(after.payment.proofCount, 0);
  // the buffer counts as taken too
  const d2 = freshDay();
  const c = await gcash(d2, 14);
  expireHold(c.code);
  const near = await srv.admin('POST', '/bookings', { roomId: 1, date: d2, startHour: 15, paidHours: 1, name: 'Near' });
  assert.equal(near.status, 201, 'staff can book the freed slot side');
  const r2 = await srv.upload(c.code, PHONE, png());
  assert.equal(r2.status, 409);
  assert.equal(r2.body.code, 'slot_taken');
});

test('a late screenshot for a time that has already started is slot_taken', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  expireHold(b.code);
  // move the booking to the start of today (Manila): it has started by now
  withDb(srv.dbPath, (db) => db.prepare('UPDATE bookings SET date = ?, start_hour = 0, end_hour = 1 WHERE code = ?').run(manilaToday(), b.code));
  const r = await srv.upload(b.code, PHONE, png());
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'slot_taken');
});

// ---------- admin: auth and proof stream ----------

test('admin payment endpoints reject missing and invalid tokens', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  await uploadOk(b);
  const id = await idOf(b.code);
  const proofId = (await detail(b)).proofs[0].id;
  const routes = [
    ['GET', '/payments'], ['GET', `/payments/${id}`], ['GET', `/payments/proofs/${proofId}`],
    ['POST', `/payments/${id}/confirm`], ['POST', `/payments/${id}/not-received`], ['POST', `/payments/${id}/balance`],
    ['POST', `/payments/${id}/refund`], ['GET', '/settings/gcash-qr'], ['PUT', '/settings/gcash-qr'],
    ['DELETE', '/settings/gcash-qr'], ['POST', '/settings/gcash-qr/preview'], ['GET', '/settings'],
  ];
  const forged = `${Buffer.from(JSON.stringify({ role: 'admin', exp: Date.now() + 1e9 })).toString('base64url')}.AAAA`;
  for (const [method, url] of routes) {
    for (const [label, headers] of [
      ['no token', {}],
      ['bad token', { authorization: 'Bearer nonsense' }],
      ['forged token', { authorization: `Bearer ${forged}` }],
      ['wrong scheme', { authorization: `Basic ${srv.token}` }],
    ]) {
      const res = await fetch(`${srv.base}/api/admin${url}`, { method, headers: { ...headers, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 401, `${method} ${url} (${label})`);
    }
  }
  // nothing changed
  assert.equal((await lookup(b)).payment.status, 'proof_submitted');
});

test('the screenshot is streamed only with the admin token, with safe headers', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  const bytes = png();
  await uploadOk(b, srv, bytes);
  const proof = (await detail(b)).proofs[0];
  assert.equal(proof.kind, 'deposit');
  assert.equal(proof.uploadedBy, 'customer');
  assert.equal(proof.bytes, bytes.length);
  assert.ok(!('file' in proof), 'no file name in the admin payload');

  const anon = await fetch(`${srv.base}/api/admin/payments/proofs/${proof.id}`);
  assert.equal(anon.status, 401);
  const ok = await fetch(`${srv.base}/api/admin/payments/proofs/${proof.id}`, { headers: { authorization: `Bearer ${srv.token}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.match(ok.headers.get('cache-control'), /no-store/);
  assert.equal(ok.headers.get('content-disposition'), 'inline');
  assert.ok(Buffer.from(await ok.arrayBuffer()).equals(bytes));
  for (const bad of ['999999', 'abc', '0', '-1', '../../etc/passwd']) {
    const res = await fetch(`${srv.base}/api/admin/payments/proofs/${encodeURIComponent(bad)}`, { headers: { authorization: `Bearer ${srv.token}` } });
    assert.equal(res.status, 404, bad);
  }
  // the public lookup and the admin list never expose stored file names
  const names = files(srv.receiptDir).map((f) => f.replace(/\.\w+$/, ''));
  const lookupText = (await pub('POST', '/bookings/lookup', creds(b))).text;
  const adminText = (await admin('GET', `/payments/${await idOf(b.code)}`)).text;
  for (const n of names) {
    assert.ok(!lookupText.includes(n) && !adminText.includes(n), 'no file name in responses');
  }
});

// ---------- admin: confirm / not received ----------

test('confirm records the deposit, keeps an optional staff name, and cannot be repeated', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  await uploadOk(b);
  const id = await idOf(b.code);
  assert.equal((await admin('POST', `/payments/${id}/confirm`, { amount: 0 })).status, 400);
  assert.equal((await admin('POST', `/payments/${id}/confirm`, { amount: -5 })).status, 400);
  assert.equal((await admin('POST', `/payments/${id}/confirm`, { amount: 401 })).status, 400);
  assert.equal((await admin('POST', `/payments/${id}/confirm`, { amount: 'abc' })).status, 400);
  assert.equal((await admin('POST', `/payments/${id}/confirm`, { amount: 10.5 })).status, 400);
  assert.equal((await lookup(b)).status, 'pending', 'bad amounts changed nothing');

  const ok = await admin('POST', `/payments/${id}/confirm`, { staffName: 'Ana' });
  assert.equal(ok.status, 200, ok.text);
  const bk = ok.body.booking;
  assert.equal(bk.status, 'confirmed');
  assert.equal(bk.payment.status, 'received');
  assert.equal(bk.payment.stage, 'deposit_received');
  assert.equal(bk.payment.paidAmount, 200);
  assert.equal(bk.payment.balanceDue, 200);
  assert.equal(bk.payment.paidInFull, false);
  assert.equal(bk.payment.holdExpiresAt, null);
  assert.equal(ok.body.emailQueued, false, 'no email address on the booking');
  const ev = bk.events.find((e) => e.action === 'confirmed_received');
  assert.equal(ev.staffName, 'Ana');
  assert.equal(ev.actor, 'staff');
  assert.equal(ev.amount, 200);
  assert.equal(ev.method, 'gcash');
  assert.ok(Date.parse(ev.at));

  assert.equal((await admin('POST', `/payments/${id}/confirm`, {})).status, 409, 'again');
  // the customer sees the paid state but no staff name
  const pubText = (await pub('POST', '/bookings/lookup', creds(b))).text;
  assert.ok(!pubText.includes('Ana'));
  assert.equal(JSON.parse(pubText).booking.status, 'confirmed');

  // without a staff name, and a partial amount
  const c = await gcash(d, 17);
  await uploadOk(c);
  const cid = await idOf(c.code);
  const partial = await admin('POST', `/payments/${cid}/confirm`, { amount: 150 });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.booking.payment.paidAmount, 150);
  assert.equal(partial.body.booking.payment.balanceDue, 250);
  assert.equal(partial.body.booking.events.find((e) => e.action === 'confirmed_received').staffName, '');
  // a staff name is trimmed to 40 characters
  const long = await gcash(freshDay(), 14);
  await uploadOk(long);
  const lr = await admin('POST', `/payments/${await idOf(long.code)}/confirm`, { staffName: 'N'.repeat(100) });
  assert.equal(lr.body.booking.events.find((e) => e.action === 'confirmed_received').staffName.length, 40);

  assert.equal((await admin('POST', '/payments/999999/confirm', {})).status, 404);
  assert.equal((await admin('POST', '/payments/abc/confirm', {})).status, 404);
  const p = await plain(d, 20);
  assert.equal((await admin('POST', `/payments/${await idOf(p.code)}/confirm`, {})).status, 409, 'not a GCash booking');
});

test('confirm on a cancelled booking is refused; concurrent confirms: one wins', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  await uploadOk(b);
  const id = await idOf(b.code);
  const results = await Promise.all([1, 2, 3].map(() => admin('POST', `/payments/${id}/confirm`, {})));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);

  const c = await gcash(d, 17);
  await uploadOk(c);
  // customers cannot cancel once a screenshot exists, so staff cancel it
  assert.equal((await admin('PATCH', `/bookings/${await idOf(c.code)}`, { status: 'cancelled' })).status, 200);
  assert.equal((await confirm(c)).status, 409);
});

test('confirm from expired works when the slot is free and is slot_taken when it was taken', async () => {
  const d = freshDay();
  const free = await gcash(d, 14);
  expireHold(free.code);
  const ok = await confirm(free, { staffName: 'Ben' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.booking.status, 'confirmed');
  assert.equal(ok.body.booking.payment.stage, 'deposit_received');
  assert.deepEqual(await busyOf(d).then((b) => b.map((x) => [x.start, x.end])), [[14, 15]]);

  const taken = await gcash(d, 18);
  expireHold(taken.code);
  const other = await plain(d, 18);
  assert.equal(other.status, 'pending');
  const bad = await confirm(taken);
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'slot_taken');
  assert.equal((await lookup(taken)).status, 'expired');
  // staff reopening it by status is refused for the same reason
  assert.equal((await admin('PATCH', `/bookings/${await idOf(taken.code)}`, { status: 'confirmed' })).status, 409);
});

test('not received is only for a pending booking with a screenshot; the customer can upload again', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  const id = await idOf(b.code);
  assert.equal((await admin('POST', `/payments/${id}/not-received`, {})).status, 409, 'no screenshot yet');
  await uploadOk(b);
  const nr = await admin('POST', `/payments/${id}/not-received`, { staffName: 'Cara', note: 'nothing in the wallet yet' });
  assert.equal(nr.status, 200, nr.text);
  assert.equal(nr.body.booking.status, 'pending');
  assert.equal(nr.body.booking.payment.status, 'not_received');
  assert.equal(nr.body.booking.payment.stage, 'not_received');
  assert.equal(nr.body.booking.payment.canUploadProof, true);
  assert.equal(nr.body.booking.payment.holdExpiresAt, null);
  const ev = nr.body.booking.events.find((e) => e.action === 'marked_not_received');
  assert.equal(ev.staffName, 'Cara');
  assert.equal(ev.note, 'nothing in the wallet yet');
  // still holds the slot, and the QR is still available
  assert.equal((await pub('POST', '/bookings', gbody(d, 14, { paymentMethod: 'pay_at_studio' }))).status, 409);
  assert.equal((await pub('POST', '/bookings/payment-qr', creds(b))).status, 200);
  // repeated marking is allowed while still not received; then a new screenshot puts it back in the queue
  assert.equal((await admin('POST', `/payments/${id}/not-received`, {})).status, 200);
  const again = await uploadOk(b);
  assert.equal(again.payment.status, 'proof_submitted');
  assert.equal(again.payment.proofCount, 2);
  assert.equal((await admin('POST', `/payments/${id}/confirm`, { staffName: 'Cara' })).status, 200);
  assert.equal((await admin('POST', `/payments/${id}/not-received`, {})).status, 409, 'not after confirmation');
  assert.equal((await admin('POST', '/payments/999999/not-received', {})).status, 404);
});

// ---------- balance, full plan, refunds ----------

test('50% balance paid in cash ends PAID; a second record, and a balance before the deposit, are refused', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  const id = await idOf(b.code);
  // before any deposit
  assert.equal((await srv.adminRaw('POST', `/payments/${id}/balance`, undefined, { 'x-balance-method': 'cash' })).status, 409, 'awaiting_proof');
  await uploadOk(b);
  assert.equal((await srv.adminRaw('POST', `/payments/${id}/balance`, undefined, { 'x-balance-method': 'cash' })).status, 409, 'proof_submitted');
  assert.equal((await confirm(b)).status, 200);

  // bad requests first
  const cash = (headers, body) => srv.adminRaw('POST', `/payments/${id}/balance`, body, headers);
  assert.equal((await cash({})).status, 400, 'no method');
  assert.equal((await cash({ 'x-balance-method': 'bitcoin' })).status, 400);
  assert.equal((await cash({ 'x-balance-method': 'cash', 'x-balance-amount': '100' })).status, 400, 'wrong amount');
  assert.equal((await cash({ 'x-balance-method': 'cash', 'x-balance-amount': 'abc' })).status, 400);
  assert.equal((await cash({ 'x-balance-method': 'cash', 'x-balance-amount': '-200' })).status, 400);
  assert.equal((await cash({ 'x-balance-method': 'cash', 'content-type': 'image/png' }, png())).status, 400, 'cash with a screenshot');
  assert.equal((await lookup(b)).payment.balancePaid, 0);

  const ok = await cash({ 'x-balance-method': 'cash', 'x-balance-amount': '200', 'x-staff-name': 'Dan', 'x-note': 'paid at the desk' });
  assert.equal(ok.status, 200, ok.text);
  const p = ok.body.booking.payment;
  assert.equal(p.balancePaid, 200);
  assert.equal(p.balanceMethod, 'cash');
  assert.equal(p.balanceDue, 0);
  assert.equal(p.paidInFull, true);
  assert.equal(p.stage, 'paid');
  const ev = ok.body.booking.events.find((e) => e.action === 'balance_collected');
  assert.equal(ev.staffName, 'Dan');
  assert.equal(ev.method, 'cash');
  assert.equal(ev.amount, 200);
  assert.equal(ev.note, 'paid at the desk');
  assert.equal((await cash({ 'x-balance-method': 'cash' })).status, 409, 'second record');
  assert.equal((await lookup(b)).payment.stage, 'paid');
});

test('50% balance paid by GCash needs a screenshot and ends PAID', async () => {
  const d = freshDay();
  const b = await confirmOk(await gcash(d, 14));
  const id = await idOf(b.code);
  const n0 = files(srv.receiptDir).length;
  const go = (headers, body) => srv.adminRaw('POST', `/payments/${id}/balance`, body, headers);

  assert.equal((await go({ 'x-balance-method': 'gcash' })).status, 400, 'gcash without an image');
  assert.equal((await go({ 'x-balance-method': 'gcash', 'content-type': 'image/png' }, Buffer.from('not an image at all, honest'))).status, 415);
  assert.equal((await go({ 'x-balance-method': 'gcash', 'content-type': 'image/jpeg' }, png())).status, 415, 'forged type');
  assert.equal((await go({ 'x-balance-method': 'gcash', 'content-type': 'text/plain' }, png())).status, 415, 'a body that is not an image type');
  assert.equal(files(srv.receiptDir).length, n0, 'nothing stored by failed attempts');
  assert.equal((await lookup(b)).payment.balancePaid, 0);

  const ok = await go({ 'x-balance-method': 'GCash', 'content-type': 'image/png', 'x-staff-name': 'Eli' }, png());
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.booking.payment.stage, 'paid');
  assert.equal(ok.body.booking.payment.balanceMethod, 'gcash');
  assert.equal(ok.body.booking.payment.balancePaid, 200);
  const proofs = ok.body.booking.proofs;
  assert.deepEqual(proofs.map((p) => [p.kind, p.uploadedBy]), [['deposit', 'customer'], ['balance', 'staff']]);
  assert.equal(files(srv.receiptDir).length, n0 + 1);
  // the customer-facing screenshot count counts deposit screenshots only
  assert.equal((await lookup(b)).payment.proofCount, 1);

  // a second record is refused and its image is not kept
  const second = await go({ 'x-balance-method': 'gcash', 'content-type': 'image/png' }, png());
  assert.equal(second.status, 409);
  assert.equal(files(srv.receiptDir).length, n0 + 1, 'refused image removed');
});

test('a 100% payment is PAID on confirm and has no balance to record', async () => {
  const d = freshDay();
  const b = await gcash(d, 14, { paymentPlan: 'full' });
  const bk = await confirmOk(b);
  assert.equal(bk.payment.stage, 'paid');
  assert.equal(bk.payment.paidAmount, 400);
  assert.equal(bk.payment.paidInFull, true);
  assert.equal(bk.payment.balanceDue, 0);
  const id = await idOf(b.code);
  assert.equal((await srv.adminRaw('POST', `/payments/${id}/balance`, undefined, { 'x-balance-method': 'cash' })).status, 409);
  const unknown = await srv.adminRaw('POST', '/payments/999999/balance', undefined, { 'x-balance-method': 'cash' });
  assert.equal(unknown.status, 404);
});

test('admin list filters: status values, balance=due and the waiting count', async () => {
  const d = freshDay();
  const awaiting = await gcash(d, 10);
  const submitted = await gcash(d, 12);
  await uploadOk(submitted);
  const notReceived = await gcash(d, 14);
  await uploadOk(notReceived);
  assert.equal((await admin('POST', `/payments/${await idOf(notReceived.code)}/not-received`, {})).status, 200);
  const half = await gcash(d, 16);
  await confirmOk(half);
  const full = await gcash(d, 18, { paymentPlan: 'full' });
  await confirmOk(full);
  const expired = await gcash(d, 20);
  expireHold(expired.code);
  withDb(srv.dbPath, (db) =>
    db.prepare(
      `INSERT INTO bookings (code, room_id, date, start_hour, paid_hours, end_hour, customer_name, phone, payment_method, payment_ref, hourly_rate, total, status)
       VALUES ('BK-OLDGCX', 2, ?, 12, 1, 13, 'Old GCash', ?, 'gcash', 'REF999', 300, 300, 'confirmed')`
    ).run(d, PHONE)
  );

  const codes = async (q) => (await admin('GET', `/payments?limit=200&${q}`)).body.bookings.map((x) => x.code);
  const mine = [awaiting, submitted, notReceived, half, full, expired].map((x) => x.code);
  const only = (list) => list.filter((c) => mine.includes(c)).sort();
  assert.deepEqual(only(await codes('status=awaiting_proof')), [awaiting.code]);
  assert.deepEqual(only(await codes('status=proof_submitted')), [submitted.code]);
  assert.deepEqual(only(await codes('status=not_received')), [notReceived.code]);
  assert.deepEqual(only(await codes('status=received')), [half.code, full.code].sort());
  assert.deepEqual(only(await codes('status=expired')), [expired.code]);
  assert.deepEqual(only(await codes('balance=due')), [half.code]);
  assert.deepEqual(only(await codes('')), mine.slice().sort(), 'no filter lists every GCash booking');
  const older = await codes('status=older');
  assert.ok(older.includes('BK-OLDGCX'));
  assert.ok(!older.some((c) => mine.includes(c)));
  const all = await codes('');
  assert.ok(all.includes('BK-OLDGCX'));
  assert.ok(!all.includes((await plain(d, 21)).code), 'non-GCash bookings are not listed');
  const list = (await admin('GET', '/payments?limit=200')).body;
  assert.ok(list.waitingCount >= 1);
  assert.equal(list.total, list.bookings.length);
  // each row carries screenshots and the audit trail
  const row = list.bookings.find((x) => x.code === submitted.code);
  assert.equal(row.proofs.length, 1);
  assert.ok(row.events.length >= 2);

  // an old-style booking cannot be driven through the new actions
  const oldId = await idOf('BK-OLDGCX');
  assert.equal((await admin('POST', `/payments/${oldId}/confirm`, {})).status, 409);
  assert.equal((await admin('POST', `/payments/${oldId}/not-received`, {})).status, 409);
  assert.equal((await admin('POST', `/payments/${oldId}/refund`, { method: 'cash', amount: 100 })).status, 409);
});

test('cancelling a paid booking makes a refund due, and recording the refund closes it', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  await confirmOk(b);
  const id = await idOf(b.code);
  assert.equal((await admin('POST', `/payments/${id}/refund`, { method: 'cash', amount: 200 })).status, 409, 'nothing to refund while active');

  const cancelled = await admin('PATCH', `/bookings/${id}`, { status: 'cancelled', staffName: 'Fay' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.booking.payment.refundStatus, 'refund_due');
  assert.equal(cancelled.body.booking.payment.stage, 'refund_due');
  const acts = (await events(b)).map((e) => [e.action, e.staffName]);
  assert.ok(acts.some(([a, s]) => a === 'cancelled' && s === 'Fay'));
  const due = (await events(b)).find((e) => e.action === 'refund_due');
  assert.equal(due.amount, 200);
  assert.deepEqual(await busyOf(d), [], 'the slot is free again');

  assert.equal((await admin('POST', `/payments/${id}/refund`, { amount: 200 })).status, 400, 'no method');
  assert.equal((await admin('POST', `/payments/${id}/refund`, { method: 'cheque', amount: 200 })).status, 400);
  assert.equal((await admin('POST', `/payments/${id}/refund`, { method: 'cash', amount: 0 })).status, 400);
  assert.equal((await admin('POST', `/payments/${id}/refund`, { method: 'cash', amount: 201 })).status, 400, 'more than was paid');
  assert.equal((await admin('POST', `/payments/${id}/refund`, { method: 'cash', amount: 'abc' })).status, 400);
  assert.equal((await lookup(b)).payment.refundStatus, 'refund_due');
  const refund = await admin('POST', `/payments/${id}/refund`, { method: 'gcash', amount: 200, staffName: 'Gus', note: 'sent back' });
  assert.equal(refund.status, 200, refund.text);
  assert.equal(refund.body.booking.payment.refundStatus, 'refunded');
  assert.equal(refund.body.booking.payment.stage, 'refunded');
  const ev = refund.body.booking.events.find((e) => e.action === 'refunded');
  assert.deepEqual([ev.staffName, ev.method, ev.amount, ev.note], ['Gus', 'gcash', 200, 'sent back']);
  assert.equal((await admin('POST', `/payments/${id}/refund`, { method: 'cash', amount: 200 })).status, 409, 'twice');

  // an unpaid GCash booking cancelled by staff owes nothing
  const u = await gcash(d, 17);
  const uid = await idOf(u.code);
  const uc = await admin('PATCH', `/bookings/${uid}`, { status: 'cancelled' });
  assert.equal(uc.body.booking.payment.refundStatus, '');
  assert.equal(uc.body.booking.payment.stage, 'cancelled');
  assert.equal((await admin('POST', `/payments/${uid}/refund`, { method: 'cash', amount: 100 })).status, 409);
});

test('a 50% booking cancelled after the balance was paid refunds the full amount taken', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  await confirmOk(b);
  const id = await idOf(b.code);
  assert.equal((await srv.adminRaw('POST', `/payments/${id}/balance`, undefined, { 'x-balance-method': 'cash' })).status, 200);
  const c = await admin('PATCH', `/bookings/${id}`, { status: 'cancelled' });
  assert.equal(c.body.booking.payment.refundStatus, 'refund_due');
  assert.equal((await events(b)).find((e) => e.action === 'refund_due').amount, 400);
  assert.equal((await admin('POST', `/payments/${id}/refund`, { method: 'cash', amount: 401 })).status, 400);
  assert.equal((await admin('POST', `/payments/${id}/refund`, { method: 'cash', amount: 400 })).status, 200);
});

test('a customer cannot cancel a paid GCash booking online but can reschedule it; unpaid ones can be cancelled', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  await confirmOk(b);
  const paid = await lookup(b);
  assert.equal(paid.canCancel, false);
  assert.equal(paid.canReschedule, true);
  const cancel = await pub('POST', '/bookings/cancel', creds(b));
  assert.equal(cancel.status, 409);
  assert.match(cancel.body.error, /payment was received/i);
  assert.equal((await lookup(b)).status, 'confirmed');

  const rs = await pub('POST', '/bookings/reschedule', { ...creds(b), date: d, startHour: 17 });
  assert.equal(rs.status, 200, rs.text);
  assert.equal(rs.body.booking.startHour, 17);
  assert.equal(rs.body.booking.status, 'confirmed');
  assert.equal(rs.body.booking.payment.stage, 'deposit_received');
  assert.equal(rs.body.booking.payment.paidAmount, 200);
  assert.ok((await actions(b)).includes('rescheduled'));

  // unpaid and with a screenshot waiting: allowed, and the audit trail notes it
  const u = await gcash(d, 11);
  const awaitingView = await lookup(u);
  assert.equal(awaitingView.canCancel, true);
  assert.equal(awaitingView.canReschedule, true);
  const w = await gcash(d, 20);
  await uploadOk(w);
  // once a screenshot exists the customer can no longer cancel online (but can still reschedule)
  assert.equal((await lookup(w)).canCancel, false);
  assert.equal((await lookup(w)).canReschedule, true);
  const cw = await pub('POST', '/bookings/cancel', creds(w));
  assert.equal(cw.status, 409);
  assert.match(cw.body.error, /message the studio/i);
  assert.equal((await lookup(w)).status, 'pending');
  // still awaiting a screenshot: cancelling online works and the audit trail names the customer
  const aw = await pub('POST', '/bookings/cancel', creds(u));
  assert.equal(aw.status, 200);
  assert.equal(aw.body.booking.status, 'cancelled');
  assert.equal((await events(u)).find((e) => e.action === 'cancelled').actor, 'customer');
  // staff cancel the one with a screenshot; that receipt can then be refunded
  assert.equal((await admin('PATCH', `/bookings/${await idOf(w.code)}`, { status: 'cancelled' })).status, 200);
  assert.equal((await admin('POST', `/payments/${await idOf(w.code)}/refund`, { method: 'gcash', amount: 200 })).status, 200);
});

test('the audit trail records every step in order, staff names are optional', async () => {
  const d = freshDay();
  const b = await gcash(d, 14);
  const ref = await srv.upload(b.code, PHONE, png(), { ref: 'REF-4242' });
  assert.equal(ref.status, 201);
  const id = await idOf(b.code);
  await admin('POST', `/payments/${id}/not-received`, { note: 'checking' });
  await uploadOk(b);
  await admin('POST', `/payments/${id}/confirm`, { staffName: 'Hana' });
  await srv.adminRaw('POST', `/payments/${id}/balance`, undefined, { 'x-balance-method': 'cash' });
  const ev = await events(b);
  assert.deepEqual(
    ev.map((e) => e.action),
    ['created', 'proof_uploaded', 'marked_not_received', 'proof_uploaded', 'confirmed_received', 'balance_collected']
  );
  assert.deepEqual(ev.map((e) => e.actor), ['customer', 'customer', 'staff', 'customer', 'staff', 'staff']);
  assert.deepEqual(ev.map((e) => e.staffName), ['', '', '', '', 'Hana', '']);
  assert.match(ev[1].note, /REF-4242/);
  assert.equal(ev[0].amount, 200);
  assert.ok(ev.every((e) => Date.parse(e.at)), 'timestamps are ISO');
  assert.ok(ev.every((e, i) => i === 0 || e.id > ev[i - 1].id));
});

// ---------- email ----------

function startFakeSmtp() {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = '';
    let inData = false;
    let authLine = false;
    let msg = { from: '', to: [], data: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          msg.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          received.push(msg);
          msg = { from: '', to: [], data: '' };
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i === -1) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const up = line.toUpperCase();
        if (authLine) {
          authLine = false;
          sock.write('235 ok\r\n');
        } else if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (up.startsWith('AUTH PLAIN')) {
          if (line.length > 11) sock.write('235 ok\r\n');
          else {
            authLine = true;
            sock.write('334 \r\n');
          }
        } else if (up.startsWith('MAIL FROM')) {
          msg.from = line;
          sock.write('250 ok\r\n');
        } else if (up.startsWith('RCPT TO')) {
          msg.to.push(line);
          sock.write('250 ok\r\n');
        } else if (up.startsWith('DATA')) {
          inData = true;
          sock.write('354 go\r\n');
        } else if (up.startsWith('QUIT')) {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      })
    );
  });
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const unfold = (s) => s.replace(/=\r\n/g, '').replace(/\r\n[ \t]/g, '');

// The studio inbox (SMTP_USER) gets its own staff emails in the same fake inbox, so the customer-email tests look at
// messages by recipient. Staff emails have their own tests in tests/staff-emails.test.js.
const STUDIO_INBOX = 'studio@example.test';
const sentTo = (smtp, address) => smtp.received.filter((m) => m.to.some((t) => t.includes(address)));

test('emails go to the booking address for confirmed, not received and hold expired; failures never break the action', async () => {
  const smtp = await startFakeSmtp();
  const s = await startServer('mail', { env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'studio@example.test', SMTP_PASS: 'fake-pass-not-real' } });
  const EMAIL = 'band.fan@example.test';
  try {
    const d = freshDay();
    // hold expired
    const lapsed = await gcash(d, 10, { email: EMAIL }, s);
    expireHold(lapsed.code, s);
    await s.admin('GET', '/payments');
    assert.ok(await waitFor(() => sentTo(smtp, EMAIL).length >= 1), 'hold expired email arrived');
    // not received
    const b = await gcash(d, 14, { email: EMAIL }, s);
    await uploadOk(b, s);
    const id = await idOf(b.code, s);
    const nr = await s.admin('POST', `/payments/${id}/not-received`, {});
    assert.equal(nr.status, 200);
    assert.equal(nr.body.emailQueued, true);
    assert.ok(await waitFor(() => sentTo(smtp, EMAIL).length >= 2), 'not received email arrived');
    // confirmed
    await uploadOk(b, s);
    const ok = await s.admin('POST', `/payments/${id}/confirm`, { staffName: 'Ivy' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.emailQueued, true);
    assert.ok(await waitFor(() => sentTo(smtp, EMAIL).length >= 3), 'confirmation email arrived');

    // every message has exactly one recipient: the customer for payment emails, the studio inbox for staff emails
    for (const m of smtp.received) {
      assert.equal(m.to.length, 1);
      assert.ok(m.to[0].includes(EMAIL) || m.to[0].includes(STUDIO_INBOX), m.to[0]);
    }
    const mine = sentTo(smtp, EMAIL);
    assert.equal(mine.length, 3, 'exactly the three payment emails went to the customer');
    for (const m of mine) assert.ok(m.to[0].includes(EMAIL) && !m.to[0].includes(STUDIO_INBOX), m.to[0]);
    // the payment emails (which greet the customer by name) never go to the studio inbox
    for (const m of sentTo(smtp, STUDIO_INBOX)) assert.ok(!unfold(m.data).includes('Hi Gina Gcash'), 'no customer email in the studio inbox');
    const bodies = mine.map((m) => unfold(m.data));
    assert.ok(bodies[0].includes(lapsed.code) && /released/i.test(bodies[0]));
    assert.ok(bodies[1].includes(b.code) && /not received/i.test(bodies[1]));
    assert.ok(bodies[2].includes(b.code) && /confirmed/i.test(bodies[2]));
    // the audit trail notes the sends
    assert.ok(await waitFor(async () => (await actions(b, s)).filter((a) => a === 'email_sent').length >= 2));

    // a booking with no address gets nothing
    const quiet = await gcash(d, 17, {}, s);
    await uploadOk(quiet, s);
    const before = sentTo(smtp, EMAIL).length;
    const q = await confirm(quiet, {}, s);
    assert.equal(q.body.emailQueued, false);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sentTo(smtp, EMAIL).length, before);
    assert.ok(!smtp.received.some((m) => /Hi Gina Gcash/.test(unfold(m.data)) && unfold(m.data).includes(quiet.code)), 'no payment email about the booking without an address');

    // now the mail server goes away: the action still succeeds and the log has no address
    await smtp.close();
    const c = await gcash(d, 20, { email: EMAIL, name: 'Zed Mailtest' }, s);
    await uploadOk(c, s);
    const failing = await s.admin('POST', `/payments/${await idOf(c.code, s)}/not-received`, {});
    assert.equal(failing.status, 200, 'the action does not fail when the email does');
    assert.ok(await waitFor(async () => (await actions(c, s)).includes('email_failed')), 'email_failed is recorded');
    const log = s.logs();
    assert.ok(!log.includes(EMAIL) && !log.includes('example.test'), 'no address in the log');
    assert.ok(!log.includes('fake-pass-not-real'), 'no password in the log');
    assert.ok(!log.includes('Zed Mailtest'), 'no customer name in the log');
  } finally {
    await smtp.close().catch(() => {});
    await s.stop();
  }
});

test('actions work without SMTP: no email is queued for bookings that have no address', async () => {
  // (SMTP_HOST points at a closed port for every test server; see the note at the top of this file.)
  const d = freshDay();
  const b = await gcash(d, 14);
  await uploadOk(b);
  const id = await idOf(b.code);
  const nr = await admin('POST', `/payments/${id}/not-received`, {});
  assert.equal(nr.status, 200);
  assert.equal(nr.body.emailQueued, false);
  await uploadOk(b);
  const ok = await admin('POST', `/payments/${id}/confirm`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.emailQueued, false);
  expireHold((await gcash(d, 17)).code);
  assert.equal((await admin('GET', '/payments')).status, 200);
});

// ---------- retention ----------

test('the receipt sweep deletes old screenshots (by booking date or by cancel/expiry age) and keeps recent ones', async () => {
  const dbPath = path.join(tmp, 'ret.db');
  const receiptDir = path.join(tmp, 'ret-receipts');
  const s1 = await startServer('ret', { dbPath, receiptDir });
  const d = freshDay();
  const oldDate = await gcash(d, 10, {}, s1);
  await uploadOk(oldDate, s1);
  const oldCancel = await gcash(d, 13, {}, s1);
  await uploadOk(oldCancel, s1);
  assert.equal((await s1.admin('PATCH', `/bookings/${await idOf(oldCancel.code, s1)}`, { status: 'cancelled' })).status, 200);
  const recent = await gcash(d, 16, {}, s1);
  await uploadOk(recent, s1);
  const proofIds = {};
  for (const [k, b] of Object.entries({ oldDate, oldCancel, recent })) proofIds[k] = (await detail(b, s1)).proofs[0].id;
  assert.equal(files(receiptDir).length, 3);
  await s1.stop();

  withDb(dbPath, (db) => {
    db.prepare("UPDATE bookings SET date = '2020-01-01' WHERE code = ?").run(oldDate.code);
    db.prepare("UPDATE bookings SET updated_at = '2020-01-01 00:00:00' WHERE code = ?").run(oldCancel.code);
  });
  const s2 = await startServer('ret', { dbPath, receiptDir });
  try {
    assert.equal(files(receiptDir).length, 1, 'two old screenshots deleted at startup, the recent one kept');
    const authz = { authorization: `Bearer ${s2.token}` };
    for (const k of ['oldDate', 'oldCancel']) {
      const res = await fetch(`${s2.base}/api/admin/payments/proofs/${proofIds[k]}`, { headers: authz });
      assert.equal(res.status, 404, `${k} proof is gone`);
    }
    assert.equal((await fetch(`${s2.base}/api/admin/payments/proofs/${proofIds.recent}`, { headers: authz })).status, 200);
    const old = await detail(oldDate, s2);
    assert.deepEqual(old.proofs, []);
    assert.ok(old.events.some((e) => e.action === 'receipt_deleted' && e.actor === 'system'));
    assert.ok(old.events.some((e) => e.action === 'proof_uploaded'), 'the audit trail is kept');
    assert.equal((await lookup(oldDate, s2)).payment.proofCount, 0);
    withDb(dbPath, (db) => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_proofs WHERE deleted_at IS NOT NULL').get().n, 2));
  } finally {
    await s2.stop();
  }
});

// ---------- migration ----------

test('migration: an old database gains the payment columns, old GCash rows stay readable, the old name and number stay private', async () => {
  const file = path.join(tmp, 'old-schema.db');
  const date = day(5);
  const date2 = day(6);
  const old = new Database(file);
  old.exec(`
    CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      hourly_rate INTEGER NOT NULL, capacity INTEGER NOT NULL DEFAULT 6, gear TEXT NOT NULL DEFAULT '[]',
      color TEXT NOT NULL DEFAULT '#F2B33D', active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
      room_id INTEGER NOT NULL REFERENCES rooms(id), date TEXT NOT NULL, start_hour INTEGER NOT NULL,
      start_minute INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE gallery_photos (id INTEGER PRIMARY KEY, file TEXT NOT NULL UNIQUE, alt TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO settings (key, value) VALUES ('open_hour', '9'), ('close_hour', '22'),
      ('gcash_enabled', 'true'), ('gcash_name', '"Old Merchant Name"'), ('gcash_number', '"09000000001"');
    INSERT INTO rooms (name, hourly_rate, capacity) VALUES ('Old Room', 350, 6);
  `);
  const ins = old.prepare(
    `INSERT INTO bookings (code, room_id, date, start_hour, paid_hours, end_hour, customer_name, phone, payment_method, payment_ref, hourly_rate, total, status)
     VALUES (?, 1, ?, ?, 1, ?, 'Old Timer', ?, 'gcash', ?, 350, 350, ?)`
  );
  ins.run('BK-OLDGC1', date, 12, 13, PHONE, 'REF1234567890', 'confirmed');
  ins.run('BK-OLDGC2', date2, 12, 13, PHONE, '', 'pending');
  assert.ok(!old.prepare('PRAGMA table_info(bookings)').all().some((c) => c.name === 'payment_plan'));
  old.close();

  const s = await startServer('old-schema', { dbPath: file, qr: false });
  try {
    // old rows are intact and read as non-new-style GCash bookings
    const one = await s.api('POST', '/bookings/lookup', { code: 'BK-OLDGC1', phone: PHONE });
    assert.equal(one.status, 200, one.text);
    assert.equal(one.body.booking.paymentRef, 'REF1234567890');
    assert.equal(one.body.booking.paymentMethod, 'gcash');
    assert.equal(one.body.booking.status, 'confirmed');
    assert.equal(one.body.booking.payment.plan, '');
    assert.equal(one.body.booking.payment.stage, '');
    assert.equal(one.body.booking.payment.canUploadProof, false);
    assert.equal(one.body.booking.payment.holdExpiresAt, null);
    const two = await s.api('POST', '/bookings/lookup', { code: 'BK-OLDGC2', phone: PHONE });
    assert.equal(two.body.booking.status, 'pending', 'an old pending GCash booking is not expired by the sweep');
    await s.admin('GET', '/payments');
    assert.equal((await s.api('POST', '/bookings/lookup', { code: 'BK-OLDGC2', phone: PHONE })).body.booking.status, 'pending');
    // ...and still holds its slot
    const clash = await s.api('POST', '/bookings', { roomId: 1, date: date2, startHour: 12, paidHours: 1, name: 'New', phone: PHONE, headcount: 1 });
    assert.equal(clash.status, 409);

    const older = await s.admin('GET', '/payments?status=older&limit=200');
    assert.deepEqual(older.body.bookings.map((x) => x.code).sort(), ['BK-OLDGC1', 'BK-OLDGC2']);
    const oldId = older.body.bookings.find((x) => x.code === 'BK-OLDGC2').id;
    assert.equal((await s.admin('POST', `/payments/${oldId}/confirm`, {})).status, 409);
    const bookings = await s.admin('GET', '/bookings');
    assert.equal(bookings.body.bookings.length, 2);

    // GCash needs a stored QR: the old settings do not count
    const site = await s.api('GET', '/site');
    assert.equal(site.body.settings.gcash_enabled, false);
    assert.equal(site.body.settings.gcash_hold_minutes, 30, 'new defaults are filled in');
    for (const text of [site.text, one.text]) {
      assert.ok(!text.includes('Old Merchant Name'));
      assert.ok(!text.includes('09000000001'));
    }
    const settings = await s.admin('GET', '/settings');
    assert.deepEqual(settings.body.legacy, { gcashName: 'Old Merchant Name', gcashNumber: '09000000001' });
    assert.equal(settings.body.settings.open_hour, 9, 'existing settings are kept');
    assert.ok(!('gcash_name' in settings.body.settings));
  } finally {
    await s.stop();
  }

  const check = new Database(file, { readonly: true });
  try {
    const cols = check.prepare('PRAGMA table_info(bookings)').all();
    for (const name of [
      'payment_plan', 'amount_due', 'payment_status', 'hold_expires_at', 'proof_submitted_at', 'paid_amount',
      'balance_paid', 'balance_method', 'balance_recorded_at', 'balance_recorded_by', 'refund_status',
    ]) {
      assert.ok(cols.some((c) => c.name === name), `column ${name} was added`);
    }
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    assert.ok(tables.includes('payment_proofs') && tables.includes('payment_events'));
    const row = check.prepare("SELECT payment_ref, status, payment_plan, amount_due, payment_status, hold_expires_at FROM bookings WHERE code = 'BK-OLDGC1'").get();
    assert.deepEqual(row, { payment_ref: 'REF1234567890', status: 'confirmed', payment_plan: '', amount_due: 0, payment_status: '', hold_expires_at: null });
    assert.equal(check.prepare("SELECT value FROM settings WHERE key = 'gcash_name'").get().value, '"Old Merchant Name"');
    assert.equal(check.prepare("SELECT value FROM settings WHERE key = 'gcash_number'").get().value, '"09000000001"');
  } finally {
    check.close();
  }

  // restarting the migrated database is a no-op
  const again = await startServer('old-schema', { dbPath: file, qr: false });
  try {
    assert.equal((await again.api('POST', '/bookings/lookup', { code: 'BK-OLDGC1', phone: PHONE })).body.booking.paymentRef, 'REF1234567890');
  } finally {
    await again.stop();
  }
});

// ---------- error handler logging ----------

test('the error handler neither logs nor echoes the body for malformed JSON or oversize requests', async () => {
  const MARKER = 'SECRETMARKER-QR-9f3a1c';
  const NAME = 'Leaky McLeakface';
  const before = srv.logs().length;
  const responses = [];

  // malformed JSON on a public route and on an admin route
  responses.push(await pub('POST', '/bookings', undefined, { rawBody: `{"name":"${NAME}","phone":"${PHONE}","notes":"${MARKER}", oops` }));
  responses.push(await srv.api('PUT', '/admin/settings/gcash-qr', undefined, { auth: true, rawBody: `{"payload":"${MARKER}", nope` }));
  responses.push(await pub('POST', '/bookings/lookup', undefined, { rawBody: `{"code":"${MARKER}` }));
  // oversize JSON (limit 100 KB)
  const pad = 'x'.repeat(150_000);
  responses.push(await pub('POST', '/bookings', undefined, { rawBody: `{"name":"${NAME}","notes":"${MARKER}${pad}"}` }));
  responses.push(await srv.api('PUT', '/admin/settings/gcash-qr', undefined, { auth: true, rawBody: `{"payload":"${MARKER}${pad}"}` }));
  // oversize screenshots on both raw routes (headers carry a code and phone)
  const d = freshDay();
  const b = await gcash(d, 14);
  const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16 * 1024 * 1024)]);
  try {
    responses.push(await srv.upload(b.code, PHONE, huge));
  } catch {
    /* connection closed mid-send is fine; the log check below still applies */
  }

  assert.equal(responses[0].status, 400);
  assert.equal(responses[1].status, 400);
  assert.equal(responses[2].status, 400);
  assert.equal(responses[3].status, 413);
  assert.equal(responses[4].status, 413);
  assert.match(responses[0].body.error, /valid JSON/i);
  for (const r of responses) {
    assert.ok(!r.text.includes(MARKER) && !r.text.includes(NAME) && !r.text.includes(PHONE), 'response does not echo the body');
  }
  await new Promise((r) => setTimeout(r, 300));
  const log = srv.logs().slice(before);
  for (const secret of [MARKER, NAME, PHONE, b.code, FAKE_ACCOUNT, 'xxxxxxxxxx']) {
    assert.ok(!log.includes(secret), `log must not contain ${secret.slice(0, 12)}`);
  }
});

test('the server log for this whole run holds no phone numbers, QR text or booking codes', async () => {
  const log = srv.logs();
  assert.ok(!log.includes(PHONE));
  assert.ok(!log.includes(FAKE_ACCOUNT));
  assert.ok(!log.includes(PAYLOAD));
  assert.ok(!/BK-[A-Z2-9]{6}/.test(log), 'no booking codes');
});

// ---------- fix round: PATCH guard ----------

const patchStatus = async (b, status, s = srv, extra = {}) => s.admin('PATCH', `/bookings/${await idOf(b.code, s)}`, { status, ...extra });
const GUARD = 'gcash_payment_required';

test('PATCH confirmed on a GCash booking that is not paid is refused with gcash_payment_required, whatever the screenshot state', async () => {
  const d = freshDay();
  const awaiting = await gcash(d, 10);
  const r = await patchStatus(awaiting, 'confirmed');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, GUARD);
  assert.ok(r.body.error, 'has a human message');
  const view = await lookup(awaiting);
  assert.equal(view.status, 'pending');
  assert.equal(view.payment.status, 'awaiting_proof');
  assert.ok(Date.parse(view.payment.holdExpiresAt), 'the hold timer is untouched');

  // refused as a whole: other fields in the same request are not applied
  const withNotes = await patchStatus(awaiting, 'confirmed', srv, { adminNotes: 'should not stick' });
  assert.equal(withNotes.status, 409);
  assert.equal((await admin('GET', `/bookings/${await idOf(awaiting.code)}`)).body.booking.adminNotes || '', '');

  // this is exactly what the Today page quick-confirm sends: PATCH { status: 'confirmed' }
  const waiting = await gcash(d, 13);
  await uploadOk(waiting);
  const quick = await admin('PATCH', `/bookings/${await idOf(waiting.code)}`, { status: 'confirmed' });
  assert.equal(quick.status, 409);
  assert.equal(quick.body.code, GUARD);
  assert.equal((await lookup(waiting)).payment.status, 'proof_submitted');
  assert.equal((await lookup(waiting)).status, 'pending');

  // not received
  await admin('POST', `/payments/${await idOf(waiting.code)}/not-received`, {});
  const nr = await patchStatus(waiting, 'confirmed');
  assert.equal(nr.status, 409);
  assert.equal(nr.body.code, GUARD);

  // the supported path still works, and PATCH confirmed is then allowed (nothing to flip)
  await uploadOk(waiting);
  const ok = await confirm(waiting);
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await patchStatus(waiting, 'confirmed')).status, 200, 'already confirmed and received: allowed');
});

test('PATCH pending on an expired or cancelled GCash booking is refused; other transitions on GCash bookings still work', async () => {
  const d = freshDay();
  const expired = await gcash(d, 10);
  expireHold(expired.code);
  assert.equal((await lookup(expired)).status, 'expired');
  const e1 = await patchStatus(expired, 'pending');
  assert.equal(e1.status, 409);
  assert.equal(e1.body.code, GUARD);
  const e2 = await patchStatus(expired, 'confirmed');
  assert.equal(e2.status, 409);
  assert.equal(e2.body.code, GUARD);
  assert.equal((await lookup(expired)).status, 'expired');

  const released = await gcash(d, 13);
  assert.equal((await pub('POST', '/bookings/cancel', creds(released))).status, 200);
  const c1 = await patchStatus(released, 'pending');
  assert.equal(c1.status, 409);
  assert.equal(c1.body.code, GUARD);
  assert.equal((await lookup(released)).status, 'cancelled');

  // cancelling is always fine, also from awaiting_proof and with a screenshot
  const cancelMe = await gcash(d, 16);
  assert.equal((await patchStatus(cancelMe, 'cancelled')).status, 200);
  const withProof = await gcash(d, 19);
  await uploadOk(withProof);
  assert.equal((await patchStatus(withProof, 'cancelled')).status, 200);
  assert.equal((await lookup(withProof)).status, 'cancelled');

  // a paid booking can go on to completed; unknown and expired statuses are still 400
  const paid = await gcash(freshDay(), 10);
  await confirmOk(paid);
  assert.equal((await patchStatus(paid, 'completed')).status, 200);
  assert.equal((await patchStatus(paid, 'expired')).status, 400);
  assert.equal((await patchStatus(paid, 'bogus')).status, 400);
});

test('pay-at-studio and older manual GCash bookings still PATCH normally', async () => {
  const d = freshDay();
  const studio = await plain(d, 10);
  assert.equal(studio.status, 'pending');
  assert.equal((await patchStatus(studio, 'confirmed')).status, 200);
  assert.equal((await patchStatus(studio, 'cancelled')).status, 200);
  assert.equal((await patchStatus(studio, 'pending')).status, 200, 'reopen a cancelled pay-at-studio booking');
  assert.equal((await patchStatus(studio, 'confirmed')).status, 200);

  // an older manual GCash booking has no payment plan (staff create it by hand)
  const made = await admin('POST', '/bookings', {
    roomId: 1, date: d, startHour: 14, paidHours: 1, name: 'Walk In', phone: PHONE, headcount: 2, paymentMethod: 'gcash',
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.booking.id;
  assert.equal(made.body.booking.payment.plan, '');
  for (const status of ['pending', 'confirmed', 'cancelled', 'pending', 'confirmed']) {
    const r = await admin('PATCH', `/bookings/${id}`, { status });
    assert.equal(r.status, 200, `${status}: ${r.text}`);
    assert.equal(r.body.booking.status, status);
  }
});

// ---------- fix round: early rejection in the proof route ----------

/**
 * Sends only the headers of an upload that claims a 15 MB body and never sends the body. A server that answers has not
 * waited for (or buffered) the body. Resolves with the status code, or 0 when nothing came back in `ms`.
 */
function earlyStatus(s, headers, ms = 2500) {
  return new Promise((resolve) => {
    const u = new URL(s.base);
    const sock = net.connect(Number(u.port), u.hostname);
    let buf = '';
    let timer;
    const done = (v) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    timer = setTimeout(() => done(0), ms);
    sock.on('error', () => done(-1));
    sock.on('data', (c) => {
      buf += c.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m && buf.includes('\r\n\r\n')) done(Number(m[1]));
    });
    const lines = [
      'POST /api/bookings/payment-proof HTTP/1.1',
      `Host: ${u.host}`,
      'Content-Length: 15728640',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '',
      '',
    ];
    sock.write(lines.join('\r\n'));
  });
}

test('the proof route answers from headers alone, before reading the body, in the order 429, 404, 409, 415', async () => {
  const s = await startServer('early', { env: { LOOKUP_FAIL_LIMIT: '4' } });
  try {
    const d = freshDay();
    const awaiting = await gcash(d, 10, {}, s);
    const studio = await plain(d, 13, {}, s);
    const h = (b, phone = PHONE, type = 'image/png') => ({ 'content-type': type, 'x-booking-code': b.code, 'x-booking-phone': phone });

    // 415: right booking, right phone, wrong content type
    assert.equal(await earlyStatus(s, h(awaiting, PHONE, 'text/plain')), 415);
    assert.equal(await earlyStatus(s, h(awaiting, PHONE, 'application/octet-stream')), 415);
    // 409 beats 415: a booking that takes no screenshots
    assert.equal(await earlyStatus(s, h(studio, PHONE, 'text/plain')), 409);
    // 404 beats 409 and 415: wrong phone (a miss), a code that does not exist (a miss), no headers at all (a miss)
    assert.equal(await earlyStatus(s, h(studio, '09170000000', 'text/plain')), 404);
    assert.equal(await earlyStatus(s, { 'content-type': 'text/plain', 'x-booking-code': 'BK-NOSUCH', 'x-booking-phone': PHONE }), 404);
    assert.equal(await earlyStatus(s, { 'content-type': 'image/png' }), 404);
    // a valid request is NOT answered early: the server waits for the body
    assert.equal(await earlyStatus(s, h(awaiting), 700), 0, 'valid request waits for its body');

    // one more miss reaches the limit of 4; from then on 429 comes first, even with correct details
    assert.equal(await earlyStatus(s, h(studio, '09170000000')), 404);
    assert.equal(await earlyStatus(s, h(awaiting)), 429);
    assert.equal(await earlyStatus(s, h(awaiting, PHONE, 'text/plain')), 429, '429 beats 415');
    assert.equal(await earlyStatus(s, h(studio, '09170000000', 'text/plain')), 429, '429 beats 404');

    // a real 15 MB body sent to the blocked client is refused quickly and nothing is stored
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(15 * 1024 * 1024 - 8)]);
    const t0 = Date.now();
    let status;
    try {
      status = (await s.upload(awaiting.code, PHONE, big)).status;
    } catch (err) {
      status = `error ${err.cause?.code || err.message}`;
    }
    const took = Date.now() - t0;
    assert.equal(status, 429, `big upload to a blocked client: ${status}`);
    assert.ok(took < 3000, `refused in ${took} ms`);
    assert.equal(files(s.receiptDir).length, 0, 'nothing stored');
  } finally {
    await s.stop();
  }
});

test('an exhausted upload allowance is a 429 before the booking is even looked up', async () => {
  const s = await startServer('early-upload', { env: { UPLOAD_RATE_LIMIT: '2' } });
  try {
    const hdr = { 'content-type': 'text/plain', 'x-booking-code': 'BK-NOSUCH', 'x-booking-phone': PHONE };
    assert.equal(await earlyStatus(s, hdr), 404);
    assert.equal(await earlyStatus(s, hdr), 404);
    assert.equal(await earlyStatus(s, hdr), 429);
  } finally {
    await s.stop();
  }
});

// ---------- fix round: canRefund ----------

const setDb = (sql, ...args) => withDb(srv.dbPath, (db) => db.prepare(sql).run(...args));
const canRefund = async (b, s = srv) => (await detail(b, s)).payment.canRefund;
const refundCall = async (b, body, s = srv) => s.admin('POST', `/payments/${await idOf(b.code, s)}/refund`, body);

test('payment.canRefund: false in every public view; admin true only for refund_due, or ended with a screenshot and nothing recorded', async () => {
  const d = freshDay();

  // awaiting, no screenshot: no
  const awaiting = await gcash(d, 10);
  assert.equal(await canRefund(awaiting), false);
  // cancelled without any screenshot: no refund to record
  assert.equal((await pub('POST', '/bookings/cancel', creds(awaiting))).status, 200);
  assert.equal(await canRefund(awaiting), false);
  assert.equal((await refundCall(awaiting, { method: 'cash', amount: 100 })).status, 409);

  // pending with a screenshot: not ended yet
  const proof = await gcash(d, 13);
  await uploadOk(proof);
  assert.equal(await canRefund(proof), false);
  assert.equal((await refundCall(proof, { method: 'cash', amount: 100 })).status, 409);
  // staff cancel it: ended with a screenshot and nothing recorded -> yes; the public view still says false
  assert.equal((await patchStatus(proof, 'cancelled')).status, 200);
  assert.equal(await canRefund(proof), true);
  const pubView = await lookup(proof);
  assert.equal(pubView.payment.canRefund, false);
  assert.equal(pubView.payment.refundStatus, '');

  // expired with a screenshot (cannot happen through the API, so set the state directly)
  const expired = await gcash(d, 16);
  await uploadOk(expired);
  setDb("UPDATE bookings SET status = 'expired' WHERE code = ?", expired.code);
  assert.equal(await canRefund(expired), true);
  assert.equal((await lookup(expired)).payment.canRefund, false);
  // expired without a screenshot: no
  const lapsed = await gcash(d, 19);
  expireHold(lapsed.code);
  assert.equal(await canRefund(lapsed), false);

  // confirmed and paid: no; cancelled after payment: refund_due -> yes
  const paid = await gcash(d, 11);
  await confirmOk(paid);
  assert.equal(await canRefund(paid), false);
  assert.equal((await lookup(paid)).payment.canRefund, false);
  assert.equal((await patchStatus(paid, 'cancelled')).status, 200);
  const due = await detail(paid);
  assert.equal(due.payment.refundStatus, 'refund_due');
  assert.equal(due.payment.canRefund, true);
  assert.equal((await lookup(paid)).payment.canRefund, false, 'public view stays false for refund_due');

  // the refund route follows the same rule
  assert.equal((await refundCall(paid, { method: 'cash', amount: 200 })).status, 200);
  assert.equal(await canRefund(paid), false, 'refunded');
  assert.equal((await refundCall(paid, { method: 'cash', amount: 200 })).status, 409, 'a second refund');
  assert.equal((await refundCall(proof, { method: 'gcash', amount: 200 })).status, 200);
  assert.equal(await canRefund(proof), false);
  assert.equal((await refundCall(expired, { method: 'gcash', amount: 200 })).status, 200);
  assert.equal((await refundCall(lapsed, { method: 'gcash', amount: 200 })).status, 409);
  assert.equal((await refundCall(awaiting, { method: 'gcash', amount: 200 })).status, 409);

  // pay-at-studio bookings: never
  const studio = await plain(d, 21);
  assert.equal((await refundCall(studio, { method: 'cash', amount: 100 })).status, 409);
  assert.equal(((await admin('GET', `/bookings/${await idOf(studio.code)}`)).body.booking.payment || {}).canRefund || false, false);
});

// ---------- fix round: balance top-up when the total goes up ----------

test('balance top-up: after a 50% booking is paid in full and its total goes up, the difference can be recorded, exactly once', async () => {
  const d = freshDay();
  const b = await confirmOk(await gcash(d, 10)); // 1 hour at 400: 200 deposit
  const id = await idOf(b.code);
  assert.equal(b.payment.paidAmount, 200);
  assert.equal(b.payment.balanceDue, 200);
  const cash = (amount) =>
    srv.adminRaw('POST', `/payments/${id}/balance`, undefined, { 'x-balance-method': 'cash', ...(amount !== undefined ? { 'x-balance-amount': String(amount) } : {}) });

  // pay the other half in cash: PAID
  assert.equal((await cash(200)).status, 200);
  let v = await detail(b);
  assert.equal(v.payment.stage, 'paid');
  assert.equal(v.payment.balanceDue, 0);
  assert.equal(v.payment.paidInFull, true);
  assert.equal((await cash()).status, 409, 'nothing left');

  // staff make the booking two hours: total 800, 400 already paid
  const patched = await admin('PATCH', `/bookings/${id}`, { paidHours: 2 });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.booking.total, 800);
  v = await detail(b);
  assert.equal(v.total, 800);
  assert.equal(v.payment.balanceDue, 400);
  assert.equal(v.payment.paidInFull, false);
  assert.equal(v.payment.stage, 'deposit_received');
  assert.equal((await lookup(b)).payment.balanceDue, 400);

  // wrong amounts are refused, nothing changes
  for (const wrong of [200, 399, 401, 800]) {
    const r = await cash(wrong);
    assert.equal(r.status, 400, `amount ${wrong}`);
    assert.match(r.body.error, /400/);
  }
  assert.equal((await detail(b)).payment.balanceDue, 400);
  assert.equal((await cash('12.5')).status, 400, 'not whole pesos');

  // the right amount (equal to the remaining balance) is accepted and the booking is PAID again
  const ok = await cash(400);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.booking.payment.balancePaid, 600, 'the difference is added on top of what was already paid');
  assert.equal(ok.body.booking.payment.balanceDue, 0);
  assert.equal(ok.body.booking.payment.stage, 'paid');
  assert.equal((await lookup(b)).payment.paidInFull, true);
  const ev = (await events(b)).filter((e) => e.action === 'balance_collected');
  assert.deepEqual(ev.map((e) => e.amount), [200, 400]);

  // nothing left now
  assert.equal((await cash(400)).status, 409);
  assert.equal((await cash()).status, 409);

  // a top-up by GCash needs a screenshot
  const g = await confirmOk(await gcash(freshDay(), 10));
  const gid = await idOf(g.code);
  assert.equal((await srv.adminRaw('POST', `/payments/${gid}/balance`, undefined, { 'x-balance-method': 'cash' })).status, 200);
  assert.equal((await admin('PATCH', `/bookings/${gid}`, { paidHours: 2 })).status, 200);
  const noImg = await srv.adminRaw('POST', `/payments/${gid}/balance`, undefined, { 'x-balance-method': 'gcash', 'x-balance-amount': '400' });
  assert.equal(noImg.status, 400);
  const withImg = await srv.adminRaw('POST', `/payments/${gid}/balance`, png(), {
    'x-balance-method': 'gcash', 'content-type': 'image/png', 'x-balance-amount': '400',
  });
  assert.equal(withImg.status, 200, withImg.text);
  assert.equal(withImg.body.booking.payment.stage, 'paid');
});

// ---------- fix round: TRUST_PROXY ----------

test('TRUST_PROXY: 0 ignores X-Forwarded-For, the default (1) trusts one hop, an invalid value falls back to 1', async () => {
  const miss = (s, ip) =>
    fetch(`${s.base}/api/bookings/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ code: 'BK-NOSUCH', phone: PHONE }),
      signal: AbortSignal.timeout(10_000),
    }).then((r) => r.status);
  const spoofed = async (s, n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await miss(s, `203.0.113.${i + 1}`));
    return out;
  };

  // TRUST_PROXY=0: the header is ignored, so a new fake address on every request does not help
  const s0 = await startServer('tp0', { env: { LOOKUP_FAIL_LIMIT: '2', TRUST_PROXY: '0' } });
  try {
    assert.deepEqual(await spoofed(s0, 4), [404, 404, 429, 429]);
  } finally {
    await s0.stop();
  }

  // default: one trusted hop, so the header decides the client and each fake address gets its own allowance
  const s1 = await startServer('tp-default', { env: { LOOKUP_FAIL_LIMIT: '2', TRUST_PROXY: undefined } });
  try {
    assert.deepEqual(await spoofed(s1, 6), [404, 404, 404, 404, 404, 404]);
    // while one forwarded address is still limited as usual
    assert.deepEqual([await miss(s1, '198.51.100.7'), await miss(s1, '198.51.100.7'), await miss(s1, '198.51.100.7')], [404, 404, 429]);
  } finally {
    await s1.stop();
  }

  // invalid values fall back to the default of 1
  for (const bad of ['abc', '-1', '1.5', 'true', ' ']) {
    const s = await startServer('tp-bad', { env: { LOOKUP_FAIL_LIMIT: '2', TRUST_PROXY: bad } });
    try {
      assert.deepEqual(await spoofed(s, 4), [404, 404, 404, 404], `TRUST_PROXY=${JSON.stringify(bad)} behaves like 1`);
    } finally {
      await s.stop();
    }
  }
});

// ---------- fix round: hold-expired emails for holds swept inside confirmDeposit ----------

test('holds that a confirm sweeps are emailed, also when that confirm is refused', async () => {
  const smtp = await startFakeSmtp();
  const s = await startServer('mail-sweep', { env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'studio@example.test', SMTP_PASS: 'fake-pass-not-real' } });
  const EMAIL = 'swept.fan@example.test';
  try {
    const d = freshDay();
    const target = await gcash(d, 14, {}, s); // no email: its own confirm sends nothing
    await uploadOk(target, s);
    const id = await idOf(target.code, s);
    const lapsed1 = await gcash(d, 10, { email: EMAIL }, s);
    const lapsed2 = await gcash(d, 17, { email: EMAIL }, s);
    expireHold(lapsed1.code, s);
    // the confirm is the first request after the hold lapsed, so its own sweep expires lapsed1
    const ok = await s.admin('POST', `/payments/${id}/confirm`, {});
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.emailQueued, false);
    assert.ok(await waitFor(() => sentTo(smtp, EMAIL).length >= 1), 'hold expired email arrived');
    assert.ok(unfold(sentTo(smtp, EMAIL)[0].data).includes(lapsed1.code));
    assert.equal(sentTo(smtp, EMAIL)[0].to.length, 1);

    // a refused confirm (already confirmed: 409) still emails the hold its sweep expired
    expireHold(lapsed2.code, s);
    const refused = await s.admin('POST', `/payments/${id}/confirm`, {});
    assert.equal(refused.status, 409);
    assert.ok(await waitFor(() => sentTo(smtp, EMAIL).length >= 2), 'second hold expired email arrived');
    assert.ok(unfold(sentTo(smtp, EMAIL)[1].data).includes(lapsed2.code));

    // exactly one email per expired hold: no duplicates, and none for the booking being confirmed
    await waitFor(() => sentTo(smtp, STUDIO_INBOX).length >= 4);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(sentTo(smtp, EMAIL).length, 2);
    // hold expiry and staff confirms send nothing to the studio inbox: it only holds the three "new booking" emails
    // and the one "receipt to check" email from the setup above
    const studio = sentTo(smtp, STUDIO_INBOX);
    assert.equal(studio.length, 4);
    assert.equal(studio.length + 2, smtp.received.length, 'every message went to the customer or the studio inbox');
    assert.equal((await lookup(lapsed1, s)).status, 'expired');
    assert.equal((await lookup(lapsed2, s)).status, 'expired');
  } finally {
    await smtp.close().catch(() => {});
    await s.stop();
  }
});
