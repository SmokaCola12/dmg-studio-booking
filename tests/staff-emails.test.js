// Emails to the studio inbox (staff notifications) and the settings around them.
//
// Every server is a child process on a free port (never 4000) with throwaway DB_PATH, UPLOAD_DIR and RECEIPT_DIR
// folders (tests/helpers/server.js). Mail goes to a fake SMTP server on 127.0.0.1 (tests/helpers/smtp.js); no real
// mail server is ever contacted. SMTP_USER, SMTP_PASS, MAIL_FROM and PUBLIC_SITE_URL are set explicitly for every
// server (to '' when a test needs them off) so a developer .env cannot leak into the run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { testEnv, root, PHONE, PAYLOAD, manilaToday, addDays, withDb } from './helpers/server.js';
import { FAKE_ACCOUNT, FAKE_MERCHANT } from './helpers/qr.js';
import { startFakeSmtp, waitFor, sleep } from './helpers/smtp.js';

const STUDIO = 'studio@example.test'; // the SMTP_USER address: the default staff inbox
const OWNER = 'owner.inbox@example.test'; // a notify_email value
const CUSTOMER = 'band.fan@example.test';
const SMTP_PASS = 'fake-pass-not-real';
const DOT = '·'; // ·
const DASH = '–'; // –
const PESO = '₱'; // ₱

const env = testEnv('dmg-staffmail-');
const smtpServers = [];
async function inbox() {
  const smtp = await startFakeSmtp();
  smtpServers.push(smtp);
  return smtp;
}
const mailEnv = (smtp, extra = {}) => ({
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtp.port),
  SMTP_USER: STUDIO,
  SMTP_PASS,
  MAIL_FROM: '',
  PUBLIC_SITE_URL: '',
  TEST_EMAIL_RATE_LIMIT: '1000',
  ...extra,
});

let srv; // main server: mail on, no PUBLIC_SITE_URL
let smtp;

before(async () => {
  smtp = await inbox();
  srv = await env.startServer('main', { env: mailEnv(smtp) });
});

after(async () => {
  await env.cleanup();
  await Promise.all(smtpServers.map((x) => x.close().catch(() => {})));
});

// ---------- helpers ----------

// Days well past the 24 hour cancel cutoff, one fresh day per use so tests never fight over a slot.
let dayCounter = 3;
const freshDay = () => addDays(manilaToday(), dayCounter++);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);

const bookingBody = (date, startHour, extra = {}) => ({
  roomId: 1, date, startHour, paidHours: 1, name: 'Pat Plain', phone: PHONE, headcount: 2, ...extra,
});
async function book(s, date, startHour, extra = {}) {
  const r = await s.api('POST', '/bookings', bookingBody(date, startHour, extra));
  assert.equal(r.status, 201, r.text);
  return r.body.booking;
}
const gcash = (s, date, startHour, extra = {}) =>
  book(s, date, startHour, { name: 'Gina Gcash', paymentMethod: 'gcash', paymentPlan: 'half', ...extra });
const creds = (b) => ({ code: b.code, phone: PHONE });
async function uploadOk(s, b) {
  const r = await s.upload(b.code, PHONE, png());
  assert.equal(r.status, 201, r.text);
  return r.body.booking;
}
async function idOf(s, b) {
  const r = await s.admin('GET', `/bookings?q=${b.code}&limit=200`);
  const hits = r.body.bookings.filter((x) => x.code === b.code);
  assert.equal(hits.length, 1);
  return hits[0].id;
}
async function putSettings(s, body) {
  const r = await s.admin('PUT', '/settings', body);
  assert.equal(r.status, 200, r.text);
  return r.body;
}
const getSettings = async (s) => (await s.admin('GET', '/settings')).body;
const DEFAULT_NOTIFY = { notify_email: '', notify_new_booking: true, notify_payment_proof: true, notify_customer_changes: true };

// The expected "Sat 14 Nov 5:00–7:00 PM" text, worked out here independently of the server code.
function whenText(date, startHour, startMinute, endHour) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
      .formatToParts(new Date(`${date}T12:00:00Z`))
      .map((p) => [p.type, p.value])
  );
  const mm = String(startMinute).padStart(2, '0');
  const clock = (h) => `${((h + 11) % 12) + 1}:${mm}`;
  const half = (h) => (h % 24 < 12 ? 'AM' : 'PM');
  const range =
    half(startHour) === half(endHour)
      ? `${clock(startHour)}${DASH}${clock(endHour)} ${half(endHour)}`
      : `${clock(startHour)} ${half(startHour)}${DASH}${clock(endHour)} ${half(endHour)}`;
  return `${parts.weekday} ${parts.day} ${parts.month} ${range}`;
}
const whenOf = (b) => whenText(b.date, b.startHour, b.startMinute, b.endHour);
const peso = (n) => `${PESO}${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const lines = (m) => m.text.split('\n');
const hasLine = (m, line) => assert.ok(lines(m).includes(line), `expected the line "${line}" in:\n${m.text}`);
const noLine = (m, re) => assert.ok(!lines(m).some((l) => re.test(l)), `unexpected line ${re} in:\n${m.text}`);

/** Waits until `n` messages are in the inbox, gives stragglers a moment, and returns exactly what arrived. */
async function arrived(box, n, { settle = 350 } = {}) {
  await waitFor(() => box.received.length >= n);
  await sleep(settle);
  const got = box.messages();
  assert.equal(got.length, n, `expected ${n} email(s), got ${got.length}: ${got.map((m) => `${m.to} | ${m.subject}`).join(' ; ')}`);
  return got;
}
const kind = (m) =>
  m.subject.startsWith('New booking ')
    ? 'new'
    : m.subject.startsWith('GCash receipt to check')
      ? 'proof'
      : /cancelled by customer$/.test(m.subject)
        ? 'cancelled'
        : /rescheduled by customer/.test(m.subject)
          ? 'rescheduled'
          : m.subject === 'DMG Studio: test email'
            ? 'test'
            : `other(${m.subject})`;

// ---------- settings contract ----------

test('settings: the notify keys default to "" and true, are admin only, and mail is { configured, notifyTo } without the password', async () => {
  const r = await srv.admin('GET', '/settings');
  assert.equal(r.status, 200);
  for (const [k, v] of Object.entries(DEFAULT_NOTIFY)) assert.equal(r.body.settings[k], v, k);
  assert.deepEqual(r.body.mail, { configured: true, notifyTo: STUDIO });
  assert.ok(!r.text.includes(SMTP_PASS), 'the SMTP password is never returned');
  assert.ok(!/smtp_pass|password/i.test(r.text), 'no password-like key in the response');

  // never in the public site response
  const site = await srv.api('GET', '/site');
  assert.equal(site.status, 200);
  for (const k of Object.keys(DEFAULT_NOTIFY)) assert.ok(!(k in site.body.settings), `${k} is not public`);
  assert.ok(!/notify_/.test(site.text));
  assert.ok(!site.text.includes(STUDIO) && !site.text.includes(SMTP_PASS));
  assert.ok(!('mail' in site.body));
});

test('settings: PUT returns { settings, mail }, trims notify_email, "" falls back to SMTP_USER, switches persist', async () => {
  try {
    const set = await srv.admin('PUT', '/settings', { notify_email: `  ${OWNER} ` });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(Object.keys(set.body).sort(), ['mail', 'settings']);
    assert.equal(set.body.settings.notify_email, OWNER);
    assert.deepEqual(set.body.mail, { configured: true, notifyTo: OWNER });
    assert.ok(!set.text.includes(SMTP_PASS));
    assert.deepEqual((await getSettings(srv)).mail, { configured: true, notifyTo: OWNER });

    const back = await putSettings(srv, { notify_email: '' });
    assert.equal(back.settings.notify_email, '');
    assert.deepEqual(back.mail, { configured: true, notifyTo: STUDIO });

    for (const k of ['notify_new_booking', 'notify_payment_proof', 'notify_customer_changes']) {
      const off = await putSettings(srv, { [k]: false });
      assert.equal(off.settings[k], false, k);
      assert.equal((await getSettings(srv)).settings[k], false, `${k} persisted`);
      // the other two are untouched
      for (const other of ['notify_new_booking', 'notify_payment_proof', 'notify_customer_changes']) {
        if (other !== k) assert.equal(off.settings[other], true, `${other} unchanged by ${k}`);
      }
      assert.equal((await putSettings(srv, { [k]: true })).settings[k], true);
    }
    // a PUT that does not mention the notify keys leaves them alone
    await putSettings(srv, { notify_email: OWNER, notify_payment_proof: false });
    const other = await putSettings(srv, { max_days_ahead: 60 });
    assert.equal(other.settings.notify_email, OWNER);
    assert.equal(other.settings.notify_payment_proof, false);
  } finally {
    await putSettings(srv, DEFAULT_NOTIFY);
  }
});

test('settings: a bad notify_email is 400 with fields.notify_email and nothing is saved', async () => {
  await putSettings(srv, { notify_email: OWNER, notify_new_booking: true });
  const long = (n) => `${'a'.repeat(n - '@example.test'.length)}@example.test`;
  const bad = {
    'two addresses, comma': 'a@example.test, b@example.test',
    'two addresses, comma no space': 'a@example.test,b@example.test',
    'two addresses, semicolon': 'a@example.test;b@example.test',
    'two addresses, space': 'a@example.test b@example.test',
    'display name': 'Studio Owner <a@example.test>',
    'quoted display name': '"Owner" <a@example.test>',
    'angle brackets only': '<a@example.test>',
    'CRLF header injection': 'a@example.test\r\nBcc: evil@example.test',
    'LF header injection': 'a@example.test\nBcc: evil@example.test',
    'CR in the middle': 'a@exam\rple.test',
    'mailto prefix': 'mailto:a@example.test',
    'no domain': 'not-an-email',
    'no dot in the domain': 'a@localhost',
    '255 characters': long(255),
    'a number': 42,
    null: null,
    true: true,
    'an array': ['a@example.test'],
    'an object': { address: 'a@example.test' },
  };
  try {
    for (const [name, value] of Object.entries(bad)) {
      // sent together with a valid change, which must not be saved either
      const r = await srv.admin('PUT', '/settings', { notify_email: value, notify_new_booking: false, max_days_ahead: 45 });
      assert.equal(r.status, 400, `${name}: ${r.text}`);
      assert.equal(typeof r.body.error, 'string', name);
      assert.deepEqual(Object.keys(r.body.fields || {}), ['notify_email'], name);
      assert.ok(r.body.fields.notify_email.length > 0, name);
      assert.ok(!('settings' in r.body) && !('mail' in r.body), name);
      const now = await getSettings(srv);
      assert.equal(now.settings.notify_email, OWNER, `${name}: notify_email unchanged`);
      assert.equal(now.settings.notify_new_booking, true, `${name}: nothing else saved`);
      assert.equal(now.settings.max_days_ahead, 60, `${name}: nothing else saved`);
      assert.equal(now.mail.notifyTo, OWNER, name);
    }
    // the limit is 254 characters: exactly 254 is fine
    const ok = await srv.admin('PUT', '/settings', { notify_email: long(254) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.settings.notify_email.length, 254);
    // whatever is stored is a single clean line
    const stored = withDb(srv.dbPath, (d) => d.prepare("SELECT value FROM settings WHERE key = 'notify_email'").get().value);
    assert.ok(!/\\r|\\n|[<>,;]/.test(stored), stored);
  } finally {
    await putSettings(srv, DEFAULT_NOTIFY);
  }
});

test('admin settings and test-email reject missing and invalid tokens, and send nothing', async () => {
  smtp.clear();
  for (const headers of [{}, { authorization: 'Bearer not-a-real-token' }, { authorization: `Bearer ${srv.token}x` }]) {
    const call = (method, url, body) =>
      fetch(`${srv.base}/api/admin${url}`, {
        method,
        headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    const get = await call('GET', '/settings');
    assert.equal(get.status, 401);
    assert.ok(!(await get.text()).includes(STUDIO), 'a 401 does not show the inbox address');
    assert.equal((await call('PUT', '/settings', { notify_email: OWNER, notify_new_booking: false })).status, 401);
    assert.equal((await call('POST', '/settings/test-email')).status, 401);
  }
  const now = await getSettings(srv);
  assert.equal(now.settings.notify_email, '');
  assert.equal(now.settings.notify_new_booking, true);
  await sleep(300);
  assert.equal(smtp.received.length, 0, 'no test email without a token');
});

// ---------- test email ----------

test('test-email: 200 { sent, to } to the effective recipient (SMTP_USER, then notify_email), plain text, no link without PUBLIC_SITE_URL', async () => {
  smtp.clear();
  try {
    const r = await srv.admin('POST', '/settings/test-email');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { sent: true, to: STUDIO });
    let [m] = await arrived(smtp, 1);
    assert.deepEqual(m.to, [STUDIO]);
    assert.equal(m.from, STUDIO, 'sent from the SMTP_USER address when MAIL_FROM is empty');
    assert.equal(m.subject, 'DMG Studio: test email');
    assert.match(m.text, /booking notifications will reach this inbox/);
    assert.ok(!/https?:\/\//.test(m.text), 'no link when PUBLIC_SITE_URL is not set');
    assert.ok(!/admin page/i.test(m.text));

    smtp.clear();
    await putSettings(srv, { notify_email: OWNER });
    const r2 = await srv.admin('POST', '/settings/test-email', {});
    assert.deepEqual(r2.body, { sent: true, to: OWNER });
    [m] = await arrived(smtp, 1);
    assert.deepEqual(m.to, [OWNER], 'only the notify address, not SMTP_USER as well');
    assert.equal(m.headers.to, OWNER);
    assert.ok(!('cc' in m.headers) && !('bcc' in m.headers));
  } finally {
    await putSettings(srv, DEFAULT_NOTIFY);
  }
});

test('test-email: 429 rate_limited after TEST_EMAIL_RATE_LIMIT sends; PUBLIC_SITE_URL adds the /admin link', async () => {
  const box = await inbox();
  const s = await env.startServer('limit', { env: mailEnv(box, { TEST_EMAIL_RATE_LIMIT: '3', PUBLIC_SITE_URL: 'https://studio.example.test/' }) });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await s.admin('POST', '/settings/test-email');
      assert.equal(r.status, 200, `send ${i + 1}: ${r.text}`);
    }
    for (let i = 0; i < 2; i++) {
      const r = await s.admin('POST', '/settings/test-email');
      assert.equal(r.status, 429, r.text);
      assert.equal(r.body.code, 'rate_limited');
      assert.equal(typeof r.body.error, 'string');
      assert.ok(!('sent' in r.body));
    }
    const got = await arrived(box, 3);
    for (const m of got) {
      assert.deepEqual(m.to, [STUDIO]);
      hasLine(m, 'Open the admin page: https://studio.example.test/admin');
    }
    // the limit is for the whole server: changing the recipient does not reset it
    await putSettings(s, { notify_email: OWNER });
    assert.equal((await s.admin('POST', '/settings/test-email')).status, 429);
    // a limited test email does not stop real notifications
    box.clear();
    await book(s, freshDay(), 14);
    const [m] = await arrived(box, 1);
    assert.equal(kind(m), 'new');
    assert.deepEqual(m.to, [OWNER]);
  } finally {
    await s.stop();
  }
});

test('without SMTP_USER and SMTP_PASS: mail.configured is false, test-email is 409 mail_not_configured (never counted), bookings still work', async () => {
  const box = await inbox();
  const s = await env.startServer('nomail', { env: mailEnv(box, { SMTP_USER: '', SMTP_PASS: '', TEST_EMAIL_RATE_LIMIT: '2' }) });
  try {
    assert.deepEqual((await getSettings(s)).mail, { configured: false, notifyTo: '' });
    for (let i = 0; i < 5; i++) {
      const r = await s.admin('POST', '/settings/test-email');
      assert.equal(r.status, 409, `try ${i + 1}: ${r.text}`);
      assert.equal(r.body.code, 'mail_not_configured');
      assert.equal(typeof r.body.error, 'string');
    }
    // a notify address alone does not switch mail on
    const set = await putSettings(s, { notify_email: OWNER });
    assert.deepEqual(set.mail, { configured: false, notifyTo: OWNER });
    assert.equal((await s.admin('POST', '/settings/test-email')).body.code, 'mail_not_configured');

    const d = freshDay();
    const b = await gcash(s, d, 14);
    await uploadOk(s, b);
    const p = await book(s, d, 18);
    assert.equal((await s.api('POST', '/bookings/reschedule', { ...creds(p), date: d, startHour: 20 })).status, 200);
    assert.equal((await s.api('POST', '/bookings/cancel', creds(p))).status, 200);
    await sleep(400);
    assert.equal(box.connections, 0, 'the mail server is never contacted');
    assert.ok(!s.logs().includes('[mail]'), 'skipped silently: nothing about mail in the log');
  } finally {
    await s.stop();
  }
});

test('only SMTP_USER or only SMTP_PASS is still "not configured"', async () => {
  const box = await inbox();
  const onlyUser = await env.startServer('onlyuser', { env: mailEnv(box, { SMTP_PASS: '' }), qr: false });
  const onlyPass = await env.startServer('onlypass', { env: mailEnv(box, { SMTP_USER: '' }), qr: false });
  try {
    // notifyTo still shows where emails would go; configured says they will not be sent
    assert.deepEqual((await getSettings(onlyUser)).mail, { configured: false, notifyTo: STUDIO });
    assert.deepEqual((await getSettings(onlyPass)).mail, { configured: false, notifyTo: '' });
    for (const s of [onlyUser, onlyPass]) {
      assert.equal((await s.admin('POST', '/settings/test-email')).body.code, 'mail_not_configured');
      await book(s, freshDay(), 14);
    }
    await sleep(400);
    assert.equal(box.connections, 0);
  } finally {
    await onlyUser.stop();
    await onlyPass.stop();
  }
});

test('no recipient: test-email is 409 no_recipient and does not use up the allowance; notifications are skipped', async () => {
  // A mailer that is on with no SMTP_USER address only exists with an injected transport (see the helper).
  const s = await env.startServer('norecipient', {
    entry: path.join(root, 'tests', 'helpers', 'server-no-smtp-user.js'),
    env: { TEST_EMAIL_RATE_LIMIT: '2', PUBLIC_SITE_URL: '' },
  });
  try {
    assert.deepEqual((await getSettings(s)).mail, { configured: true, notifyTo: '' });
    for (let i = 0; i < 4; i++) {
      const r = await s.admin('POST', '/settings/test-email');
      assert.equal(r.status, 409, `try ${i + 1}: ${r.text}`);
      assert.equal(r.body.code, 'no_recipient');
      assert.equal(typeof r.body.error, 'string');
    }
    // customer requests are fine with nowhere to send to
    const b = await book(s, freshDay(), 14);
    assert.equal((await s.api('POST', '/bookings/cancel', creds(b))).status, 200);

    // the four 409s above did not count: both tries of the allowance are still there
    await putSettings(s, { notify_email: OWNER });
    for (let i = 0; i < 2; i++) {
      const r = await s.admin('POST', '/settings/test-email');
      assert.equal(r.status, 200, `send ${i + 1}: ${r.text}`);
      assert.deepEqual(r.body, { sent: true, to: OWNER });
    }
    assert.equal((await s.admin('POST', '/settings/test-email')).body.code, 'rate_limited');
    assert.ok(!s.logs().includes('[mail]'));
  } finally {
    await s.stop();
  }
});

// ---------- new booking ----------

test('new booking, pay at the studio: exactly one email to the studio inbox with every detail, :30 start and free hour', async () => {
  smtp.clear();
  const d = freshDay();
  const b = await book(srv, d, 14, {
    startMinute: 30, paidHours: 2, name: 'Rico Blanco', bandName: 'The Test Pilots', phone: '+63 917-123 4567', headcount: 4,
    notes: 'Bringing our own snare',
  });
  assert.equal(b.freeHours, 1, 'the free hour applies on an empty day');
  assert.equal(b.endHour, 17);
  const [m] = await arrived(smtp, 1);
  assert.deepEqual(m.to, [STUDIO]);
  assert.equal(m.headers.to, STUDIO);
  assert.ok(!('cc' in m.headers) && !('bcc' in m.headers));
  const when = whenOf(b);
  assert.match(when, new RegExp(`^[A-Z][a-z]{2} \\d{1,2} [A-Z][a-z]{2} 2:30${DASH}5:30 PM$`));
  assert.equal(m.subject, `New booking ${b.code} ${DOT} ${when} ${DOT} ${b.room.name}`);
  assert.equal(lines(m)[0], 'A customer made a new booking on the website.');
  hasLine(m, `Booking code: ${b.code}`);
  hasLine(m, 'Status: Pending, waiting for your approval');
  hasLine(m, 'Customer: Rico Blanco (The Test Pilots)');
  hasLine(m, `Phone: ${PHONE}`);
  hasLine(m, `When: ${when}`);
  hasLine(m, 'Hours: 2 + 1 free');
  hasLine(m, `Total: ${peso(b.total)}`);
  assert.equal(b.total, 2 * b.hourlyRate);
  hasLine(m, 'Payment: Pay at the studio');
  noLine(m, /^Email:/); // no address given, so no Email line
  assert.ok(!/https?:\/\//.test(m.text), 'no admin link without PUBLIC_SITE_URL');
});

test('new booking: time ranges across noon, in the morning, at closing and up to midnight; thousands separator; auto-confirm status', async () => {
  smtp.clear();
  const d = freshDay();
  try {
    await putSettings(srv, { close_hour: 24, promo_enabled: false, buffer_minutes: 0 });
    const noon = await book(srv, d, 11, { startMinute: 30 });
    const morning = await book(srv, d, 10);
    const long = await book(srv, d, 13, { paidHours: 3, email: CUSTOMER });
    const late = await book(srv, d, 23);
    const got = await arrived(smtp, 4);
    const of = (b) => got.find((m) => m.subject.includes(b.code));
    const day = whenText(d, 0, 0, 0).split(' ').slice(0, 3).join(' ');
    assert.equal(of(noon).subject, `New booking ${noon.code} ${DOT} ${day} 11:30 AM${DASH}12:30 PM ${DOT} ${noon.room.name}`);
    assert.equal(of(morning).subject, `New booking ${morning.code} ${DOT} ${day} 10:00${DASH}11:00 AM ${DOT} ${morning.room.name}`);
    assert.equal(of(long).subject, `New booking ${long.code} ${DOT} ${day} 1:00${DASH}4:00 PM ${DOT} ${long.room.name}`);
    assert.equal(of(late).subject, `New booking ${late.code} ${DOT} ${day} 11:00 PM${DASH}12:00 AM ${DOT} ${late.room.name}`);
    hasLine(of(noon), `When: ${day} 11:30 AM${DASH}12:30 PM`);
    hasLine(of(noon), 'Hours: 1');
    hasLine(of(long), 'Hours: 3');
    assert.equal(long.total, 1200);
    hasLine(of(long), `Total: ${PESO}1,200`);
    hasLine(of(long), `Email: ${CUSTOMER}`);
    hasLine(of(long), 'Customer: Pat Plain'); // no band: no brackets
    // the weekday in the email is the weekday of the booked date
    assert.equal(day.slice(0, 3), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d}T00:00:00Z`).getUTCDay()]);
    // every message went to the studio only: a new booking sends the customer nothing
    for (const m of got) assert.deepEqual(m.to, [STUDIO]);

    smtp.clear();
    await putSettings(srv, { auto_confirm: true });
    const auto = await book(srv, d, 17);
    assert.equal(auto.status, 'confirmed');
    const [m] = await arrived(smtp, 1);
    hasLine(m, 'Status: Confirmed');
  } finally {
    await putSettings(srv, { close_hour: 22, promo_enabled: true, buffer_minutes: 30, auto_confirm: false });
  }
});

test('new booking: line breaks in customer text cannot add lines, headers or recipients to the email', async () => {
  smtp.clear();
  const b = await book(srv, freshDay(), 14, {
    name: 'Mallory\r\nBcc: evil@example.test\nStatus: Confirmed',
    bandName: 'Band\n\nTotal: 0',
  });
  const [m] = await arrived(smtp, 1);
  assert.deepEqual(m.to, [STUDIO]);
  assert.ok(!('bcc' in m.headers));
  hasLine(m, 'Customer: Mallory Bcc: evil@example.test Status: Confirmed (Band Total: 0)');
  assert.equal(lines(m).filter((l) => l.startsWith('Status:')).length, 1);
  assert.equal(lines(m).filter((l) => l.startsWith('Total:')).length, 1);
  assert.equal(m.subject, `New booking ${b.code} ${DOT} ${whenOf(b)} ${DOT} ${b.room.name}`);
});

test('new booking, GCash 50% and 100%: one email each with the amount due now, and never the QR text', async () => {
  smtp.clear();
  const d = freshDay();
  const half = await gcash(srv, d, 10, { startMinute: 30 });
  const full = await gcash(srv, d, 15, { paymentPlan: 'full', email: CUSTOMER });
  const got = await arrived(smtp, 2);
  const mh = got.find((m) => m.subject.includes(half.code));
  const mf = got.find((m) => m.subject.includes(full.code));
  assert.equal(mh.subject, `New booking ${half.code} ${DOT} ${whenOf(half)} ${DOT} ${half.room.name}`);
  assert.match(mh.subject, new RegExp(` 10:30${DASH}11:30 AM `));
  hasLine(mh, 'Status: Pending, waiting for the GCash receipt');
  hasLine(mh, `Total: ${peso(half.total)}`);
  assert.equal(half.payment.amountDue, Math.ceil(half.total / 2));
  hasLine(mh, `Payment: GCash 50%, ${peso(half.payment.amountDue)} due now by GCash`);
  hasLine(mf, 'Status: Pending, waiting for the GCash receipt');
  hasLine(mf, `Payment: GCash 100%, ${peso(full.total)} due now by GCash`);
  hasLine(mf, `Email: ${CUSTOMER}`);
  for (const m of got) {
    assert.deepEqual(m.to, [STUDIO]);
    for (const secret of [PAYLOAD, FAKE_ACCOUNT, FAKE_MERCHANT]) assert.ok(!m.raw.includes(secret) && !m.text.includes(secret), 'no QR text');
  }
});

// ---------- payment proof ----------

test('receipt upload: one email per screenshot with the amount; a re-upload after "not received" says so; no file names', async () => {
  smtp.clear();
  const d = freshDay();
  const b = await gcash(srv, d, 14, { startMinute: 30, paidHours: 2 });
  await arrived(smtp, 1);
  smtp.clear();
  const amount = peso(b.payment.amountDue);
  const subject = `GCash receipt to check ${DOT} ${b.code} ${DOT} ${amount}`;

  await uploadOk(srv, b);
  let [m] = await arrived(smtp, 1);
  assert.deepEqual(m.to, [STUDIO]);
  assert.equal(m.subject, subject);
  assert.equal(lines(m)[0], `A customer uploaded a GCash receipt screenshot for ${amount}.`);
  assert.equal(lines(m)[1], 'Check your GCash, then mark the payment as received or not received. The slot stays held until you do.');
  hasLine(m, `Booking code: ${b.code}`);
  hasLine(m, 'Status: Pending, GCash receipt uploaded and waiting for your check');
  hasLine(m, 'Customer: Gina Gcash');
  hasLine(m, `Phone: ${PHONE}`);
  hasLine(m, `When: ${whenOf(b)}`);
  hasLine(m, 'Hours: 2 + 1 free');
  hasLine(m, `Payment: GCash 50%, ${amount} due now by GCash`);
  assert.ok(!/https?:\/\//.test(m.text));

  // a second screenshot before staff looked: another email, still the first-upload wording
  smtp.clear();
  await uploadOk(srv, b);
  [m] = await arrived(smtp, 1);
  assert.equal(m.subject, subject);
  assert.equal(lines(m)[0], `A customer uploaded a GCash receipt screenshot for ${amount}.`);

  // staff: not yet received (no staff email), then the customer uploads again
  smtp.clear();
  const nr = await srv.admin('POST', `/payments/${await idOf(srv, b)}/not-received`, { staffName: 'Ivy' });
  assert.equal(nr.status, 200, nr.text);
  await uploadOk(srv, b);
  [m] = await arrived(smtp, 1);
  assert.equal(m.subject, subject);
  assert.equal(lines(m)[0], `The customer uploaded another GCash receipt screenshot for ${amount}, after the last one was marked not received.`);
  hasLine(m, 'Status: Pending, GCash receipt uploaded and waiting for your check');
  assert.ok(!m.text.includes('Ivy'), 'no staff name');

  // the three stored files are never named, and nothing is attached
  const stored = fs.readdirSync(srv.receiptDir).filter((f) => !f.endsWith('.tmp'));
  assert.ok(stored.length >= 3);
  for (const msg of smtp.all()) {
    for (const f of stored) {
      assert.ok(!msg.raw.includes(f) && !msg.text.includes(f), 'no receipt file name');
      assert.ok(!msg.text.includes(path.parse(f).name), 'no receipt file name without its extension');
    }
  }
  // a 4th screenshot is refused (limit 3) and sends nothing
  smtp.clear();
  assert.equal((await srv.upload(b.code, PHONE, png())).status, 409);
  await sleep(400);
  assert.equal(smtp.received.length, 0);
});

// ---------- customer cancel and reschedule ----------

test('customer cancel: "Booking <code> cancelled by customer" with the booking details', async () => {
  smtp.clear();
  const b = await book(srv, freshDay(), 16, { name: 'Cora Cancel', bandName: 'Second Thoughts' });
  await arrived(smtp, 1);
  smtp.clear();
  const r = await srv.api('POST', '/bookings/cancel', creds(b));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.booking.status, 'cancelled');
  const [m] = await arrived(smtp, 1);
  assert.deepEqual(m.to, [STUDIO]);
  assert.equal(m.subject, `Booking ${b.code} cancelled by customer`);
  assert.equal(lines(m)[0], 'The customer cancelled this booking online. The slot is free again.');
  hasLine(m, `Booking code: ${b.code}`);
  hasLine(m, 'Status: Cancelled');
  hasLine(m, 'Customer: Cora Cancel (Second Thoughts)');
  hasLine(m, `When: ${whenOf(b)}`);
  hasLine(m, 'Payment: Pay at the studio');
  noLine(m, /^(Was|Now):/);

  // a GCash hold that the customer cancels (before any screenshot) is reported too
  smtp.clear();
  const g = await gcash(srv, freshDay(), 16);
  await arrived(smtp, 1);
  smtp.clear();
  assert.equal((await srv.api('POST', '/bookings/cancel', creds(g))).status, 200);
  const [mg] = await arrived(smtp, 1);
  assert.equal(mg.subject, `Booking ${g.code} cancelled by customer`);
  hasLine(mg, 'Status: Cancelled');
  hasLine(mg, `Payment: GCash 50%, ${peso(g.payment.amountDue)} due now by GCash`);
});

test('customer reschedule: the subject has the new time, the body has Was and Now', async () => {
  smtp.clear();
  const d1 = freshDay();
  const d2 = freshDay();
  const b = await book(srv, d1, 10, { paidHours: 2, name: 'Remy Resched' });
  await arrived(smtp, 1);
  smtp.clear();
  const r = await srv.api('POST', '/bookings/reschedule', { ...creds(b), date: d2, startHour: 18, startMinute: 30 });
  assert.equal(r.status, 200, r.text);
  const moved = r.body.booking;
  assert.equal(moved.date, d2);
  assert.equal(moved.startMinute, 30);
  const was = whenOf(b);
  const now = whenOf(moved);
  assert.notEqual(was, now);
  assert.match(now, new RegExp(` 6:30${DASH}9:30 PM$`));
  const [m] = await arrived(smtp, 1);
  assert.deepEqual(m.to, [STUDIO]);
  assert.equal(m.subject, `Booking ${b.code} rescheduled by customer ${DOT} ${now}`);
  assert.equal(lines(m)[0], 'The customer moved this booking online.');
  hasLine(m, `Was: ${was}`);
  hasLine(m, `Now: ${now}`);
  hasLine(m, `When: ${now}`);
  hasLine(m, `Booking code: ${b.code}`);
  hasLine(m, 'Status: Pending, waiting for your approval');
  hasLine(m, 'Customer: Remy Resched');
  assert.ok(lines(m).indexOf(`Was: ${was}`) < lines(m).indexOf(`Now: ${now}`));

  // same day, :30 back to :00 across noon
  smtp.clear();
  const r2 = await srv.api('POST', '/bookings/reschedule', { ...creds(b), date: d2, startHour: 10 });
  assert.equal(r2.status, 200, r2.text);
  const [m2] = await arrived(smtp, 1);
  const now2 = whenOf(r2.body.booking);
  assert.match(now2, new RegExp(` 10:00 AM${DASH}1:00 PM$`));
  assert.equal(m2.subject, `Booking ${b.code} rescheduled by customer ${DOT} ${now2}`);
  hasLine(m2, `Was: ${now}`);
  hasLine(m2, `Now: ${now2}`);
});

// ---------- switches ----------

test('each switch off silences only its own event', async () => {
  const EVENTS = { notify_new_booking: ['new'], notify_payment_proof: ['proof'], notify_customer_changes: ['cancelled', 'rescheduled'] };
  const everything = ['new', 'new', 'proof', 'rescheduled', 'cancelled'];
  async function run() {
    const d = freshDay();
    const g = await gcash(srv, d, 10);
    await uploadOk(srv, g);
    const p = await book(srv, d, 14);
    assert.equal((await srv.api('POST', '/bookings/reschedule', { ...creds(p), date: d, startHour: 18 })).status, 200);
    assert.equal((await srv.api('POST', '/bookings/cancel', creds(p))).status, 200);
  }
  try {
    for (const [key, silenced] of Object.entries(EVENTS)) {
      await putSettings(srv, { ...DEFAULT_NOTIFY, [key]: false });
      smtp.clear();
      await run();
      const expected = everything.filter((k) => !silenced.includes(k)).sort();
      const got = await arrived(smtp, expected.length);
      assert.deepEqual(got.map(kind).sort(), expected, `${key} off`);
      for (const m of got) assert.deepEqual(m.to, [STUDIO]);
    }
    // all three off: nothing at all, and the mail server is not even contacted
    await putSettings(srv, { notify_new_booking: false, notify_payment_proof: false, notify_customer_changes: false });
    smtp.clear();
    const before = smtp.connections;
    await run();
    await sleep(500);
    assert.equal(smtp.received.length, 0);
    assert.equal(smtp.connections, before);
    // the test email is not behind any switch
    assert.equal((await srv.admin('POST', '/settings/test-email')).status, 200);
    await arrived(smtp, 1);
    // back on: emails flow again without a restart
    await putSettings(srv, DEFAULT_NOTIFY);
    smtp.clear();
    await run();
    assert.deepEqual((await arrived(smtp, 5)).map(kind).sort(), [...everything].sort());
  } finally {
    await putSettings(srv, DEFAULT_NOTIFY);
  }
});

// ---------- things that must stay silent ----------

test('no staff email for walk-ins, staff actions, Pay later, hold expiry or refused requests', async () => {
  const d = freshDay();
  const d2 = freshDay();
  // setup (these do email): bookings without a customer address, so the inbox only ever holds staff emails
  smtp.clear();
  const plain = await book(srv, d, 10);
  const moved = await book(srv, d, 12);
  const paid = await gcash(srv, d, 14);
  const unpaid = await gcash(srv, d, 16);
  const later = await gcash(srv, d, 18);
  const lapsing = await gcash(srv, d, 20);
  const blocker = await book(srv, d2, 10);
  await uploadOk(srv, paid);
  await uploadOk(srv, unpaid);
  await arrived(smtp, 9);
  smtp.clear();

  // staff: walk-in (also a GCash one), block, confirm, move, cancel, payment actions
  const walkIn = await srv.admin('POST', '/bookings', { roomId: 2, date: d, startHour: 10, paidHours: 1, name: 'Walk In', phone: PHONE });
  assert.equal(walkIn.status, 201, walkIn.text);
  const walkIn2 = await srv.admin('POST', '/bookings', { roomId: 2, date: d, startHour: 13, paidHours: 1, name: 'Phone Booking', paymentMethod: 'gcash', email: CUSTOMER });
  assert.equal(walkIn2.status, 201, walkIn2.text);
  const patch = async (b, body) => {
    const r = await srv.admin('PATCH', `/bookings/${await idOf(srv, b)}`, body);
    assert.equal(r.status, 200, r.text);
  };
  await patch(plain, { status: 'confirmed' });
  await patch(moved, { date: d2, startHour: 15, startMinute: 30 });
  await patch(moved, { status: 'cancelled' });
  await patch(plain, { status: 'completed' });
  const pay = async (b, action, body = {}) => {
    const r = await srv.admin('POST', `/payments/${await idOf(srv, b)}/${action}`, body);
    assert.equal(r.status, 200, r.text);
  };
  await pay(unpaid, 'not-received');
  await pay(paid, 'confirm', { staffName: 'Ivy' });
  const balance = await fetch(`${srv.base}/api/admin/payments/${await idOf(srv, paid)}/balance`, {
    method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-balance-method': 'cash' }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(balance.status, 200, await balance.text());
  await patch(paid, { status: 'cancelled' });
  await pay(paid, 'refund', { amount: 100, method: 'gcash' });

  // customer: Pay later
  const released = await srv.api('POST', '/bookings/release', creds(later));
  assert.equal(released.status, 200, released.text);
  assert.equal(released.body.booking.status, 'cancelled');

  // system: a hold runs out and is swept
  withDb(srv.dbPath, (db) => db.prepare('UPDATE bookings SET hold_expires_at = ? WHERE code = ?').run(new Date(Date.now() - 60_000).toISOString(), lapsing.code));
  assert.equal((await srv.api('POST', '/bookings/lookup', creds(lapsing))).body.booking.status, 'expired');

  // refused customer requests
  const refused = [
    [await srv.api('POST', '/bookings', bookingBody(d2, 10, { name: '' })), 400],
    [await srv.api('POST', '/bookings', bookingBody(d2, 10, { phone: '12345' })), 400],
    [await srv.api('POST', '/bookings', bookingBody(d2, 10, { startMinute: 15 })), 400],
    [await srv.api('POST', '/bookings', bookingBody(d2, 10, { paymentMethod: 'gcash', paymentPlan: 'third' })), 400],
    [await srv.api('POST', '/bookings', bookingBody(d, 16)), 409], // taken (held with a screenshot)
    [await srv.api('POST', '/bookings', bookingBody(d, 16, { startMinute: 30 })), 409], // overlaps it
    [await srv.api('POST', '/bookings', bookingBody(d2, 9)), 409], // before opening
    [await srv.api('POST', '/bookings', bookingBody(d2, 10, { paidHours: 9 })), 409], // over the maximum
    [await srv.api('POST', '/bookings/cancel', { code: plain.code, phone: '09170000000' }), 404],
    [await srv.api('POST', '/bookings/cancel', creds(unpaid)), 409], // a screenshot was sent
    [await srv.api('POST', '/bookings/cancel', creds(later)), 409], // already cancelled
    [await srv.api('POST', '/bookings/reschedule', { ...creds(unpaid), date: d, startHour: 16 }), 400], // the same time
    [await srv.api('POST', '/bookings/reschedule', { ...creds(unpaid), date: d2, startHour: 10 }), 409], // onto another booking
    [await srv.api('POST', '/bookings/reschedule', { ...creds(unpaid), date: 'tomorrow', startHour: 10 }), 400],
    [await srv.api('POST', '/bookings/reschedule', { code: unpaid.code, phone: '09170000000', date: d2, startHour: 10 }), 404],
    [await srv.api('POST', '/bookings/release', creds(unpaid)), 409],
    [await srv.upload(plain.code, PHONE, png()), 409], // not a GCash booking
    [await srv.upload(unpaid.code, PHONE, Buffer.from('not an image at all'), { type: 'text/plain' }), 415],
    [await srv.upload(unpaid.code, PHONE, Buffer.from('<html>not a png</html>')), 415], // wrong magic bytes
    [await srv.upload(unpaid.code, '09170000000', png()), 404],
  ];
  refused.forEach(([r, status], i) => assert.equal(r.status, status, `refused request ${i + 1}: ${r.text}`));
  const badJson = await fetch(`${srv.base}/api/bookings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name": "Pat"', signal: AbortSignal.timeout(10_000) });
  assert.equal(badJson.status, 400);

  // one real booking at the end proves mail is still flowing, and it is the only thing in the inbox
  assert.equal((await srv.api('POST', '/bookings/lookup', creds(blocker))).body.booking.status, 'pending');
  const sentinel = await book(srv, d2, 20);
  const got = await arrived(smtp, 1, { settle: 800 });
  assert.equal(kind(got[0]), 'new');
  assert.ok(got[0].subject.includes(sentinel.code));
});

// ---------- recipient ----------

test('with notify_email set every staff email goes there instead of SMTP_USER, and customer emails still go only to the customer', async () => {
  try {
    await putSettings(srv, { notify_email: OWNER });
    smtp.clear();
    const d = freshDay();
    const g = await gcash(srv, d, 10, { email: CUSTOMER, name: 'Carla Customer' });
    await uploadOk(srv, g);
    const id = await idOf(srv, g);
    assert.equal((await srv.admin('POST', `/payments/${id}/not-received`, {})).body.emailQueued, true);
    await uploadOk(srv, g);
    assert.equal((await srv.admin('POST', `/payments/${id}/confirm`, {})).body.emailQueued, true);
    const p = await book(srv, d, 14, { email: CUSTOMER, name: 'Carla Customer' });
    assert.equal((await srv.api('POST', '/bookings/reschedule', { ...creds(p), date: d, startHour: 18 })).status, 200);
    assert.equal((await srv.api('POST', '/bookings/cancel', creds(p))).status, 200);
    // a hold that runs out emails the customer only
    const lapsing = await gcash(srv, d, 20, { email: CUSTOMER, name: 'Carla Customer' });
    withDb(srv.dbPath, (db) => db.prepare('UPDATE bookings SET hold_expires_at = ? WHERE code = ?').run(new Date(Date.now() - 60_000).toISOString(), lapsing.code));
    await srv.api('POST', '/bookings/lookup', creds(lapsing));

    // staff: 3 new + 2 receipts + moved + cancelled = 7; customer: not received + confirmed + released = 3
    const got = await arrived(smtp, 10, { settle: 600 });
    for (const m of got) assert.equal(m.to.length, 1, 'one recipient per message');
    assert.equal(got.filter((m) => m.to[0] === STUDIO).length, 0, 'nothing to the SMTP_USER address any more');
    const staff = got.filter((m) => m.to[0] === OWNER);
    const customer = got.filter((m) => m.to[0] === CUSTOMER);
    assert.deepEqual(staff.map(kind).sort(), ['cancelled', 'new', 'new', 'new', 'proof', 'proof', 'rescheduled']);
    for (const m of staff) {
      assert.equal(m.headers.to, OWNER);
      assert.equal(m.from, STUDIO);
      assert.ok(!m.text.startsWith('Hi '), 'a staff email, not a customer one');
    }
    assert.equal(customer.length, 3);
    assert.deepEqual(
      customer.map((m) => m.subject).sort(),
      [
        `DMG Studio: payment received, booking ${g.code} confirmed`,
        `DMG Studio: we have not received your payment for ${g.code}`,
        `DMG Studio: your booking ${lapsing.code} was released`,
      ].sort()
    );
    for (const m of customer) {
      assert.equal(m.headers.to, CUSTOMER);
      assert.ok(!('cc' in m.headers) && !('bcc' in m.headers));
      assert.ok(m.text.startsWith('Hi Carla Customer,'));
      assert.ok(!m.text.includes(OWNER) && !m.text.includes(STUDIO), 'the studio inbox address is not shown to customers');
      assert.ok(!/\/admin/.test(m.text));
    }
  } finally {
    await putSettings(srv, DEFAULT_NOTIFY);
  }
});

// ---------- admin links ----------

test('PUBLIC_SITE_URL adds /admin links (/admin/gcash for receipts); customer emails never get an admin link', async () => {
  const box = await inbox();
  const s = await env.startServer('links', { env: mailEnv(box, { PUBLIC_SITE_URL: 'https://studio.example.test///' }) });
  try {
    const d = freshDay();
    const g = await gcash(s, d, 10, { email: CUSTOMER });
    await uploadOk(s, g);
    const p = await book(s, d, 14);
    assert.equal((await s.api('POST', '/bookings/reschedule', { ...creds(p), date: d, startHour: 18 })).status, 200);
    assert.equal((await s.api('POST', '/bookings/cancel', creds(p))).status, 200);
    assert.equal((await s.admin('POST', `/payments/${await idOf(s, g)}/confirm`, {})).status, 200);
    const got = await arrived(box, 6);
    const staff = got.filter((m) => m.to[0] === STUDIO);
    assert.deepEqual(staff.map(kind).sort(), ['cancelled', 'new', 'new', 'proof', 'rescheduled']);
    for (const m of staff) {
      const last = lines(m).at(-1);
      if (kind(m) === 'proof') assert.equal(last, 'Check the receipt: https://studio.example.test/admin/gcash');
      else assert.equal(last, 'Open the admin page: https://studio.example.test/admin');
      assert.equal((m.text.match(/https?:\/\//g) || []).length, 1, 'exactly one link');
    }
    const [customer] = got.filter((m) => m.to[0] === CUSTOMER);
    assert.ok(customer.text.includes('https://studio.example.test/check'));
    assert.ok(!customer.text.includes('/admin'));
  } finally {
    await s.stop();
  }
});

test('a PUBLIC_SITE_URL that is not an http(s) address adds no link', async () => {
  const box = await inbox();
  const s = await env.startServer('badlink', { env: mailEnv(box, { PUBLIC_SITE_URL: 'javascript:alert(1)//studio.example.test' }), qr: false });
  try {
    const b = await book(s, freshDay(), 14);
    assert.equal((await s.admin('POST', '/settings/test-email')).status, 200);
    const got = await arrived(box, 2);
    for (const m of got) {
      assert.ok(!/javascript|admin page|studio\.example\.test\//i.test(m.text), m.text);
    }
    assert.ok(got.some((m) => m.subject.includes(b.code)));
  } finally {
    await s.stop();
  }
});

// ---------- a broken mail server ----------

test('a mail server that refuses or hangs up never breaks the customer request; test-email answers 502; the log has no address', async () => {
  const box = await inbox();
  const s = await env.startServer('failing', { env: mailEnv(box, { PUBLIC_SITE_URL: 'https://studio.example.test' }) });
  const TEMPLATES = ['staffNewBooking', 'staffPaymentProof', 'staffCustomerChange', 'test'];
  const mailLines = () => s.logs().split(/\r?\n/).filter((l) => l.includes('[mail]'));
  let expectedFailures = 0;
  try {
    await putSettings(s, { notify_email: OWNER });
    async function customerFlow() {
      const d = freshDay();
      const g = await gcash(s, d, 10, { name: 'Zed Mailtest', email: CUSTOMER }); // 201 asserted inside
      const up = await s.upload(g.code, PHONE, png());
      assert.equal(up.status, 201, up.text);
      assert.equal(up.body.booking.payment.status, 'proof_submitted');
      const p = await book(s, d, 14, { name: 'Zed Mailtest' });
      const moved = await s.api('POST', '/bookings/reschedule', { ...creds(p), date: d, startHour: 18 });
      assert.equal(moved.status, 200, moved.text);
      assert.equal(moved.body.booking.startHour, 18);
      const cancelled = await s.api('POST', '/bookings/cancel', creds(p));
      assert.equal(cancelled.status, 200, cancelled.text);
      assert.equal(cancelled.body.booking.status, 'cancelled');
      // and the changes really were saved
      assert.equal((await s.api('POST', '/bookings/lookup', creds(g))).body.booking.payment.status, 'proof_submitted');
      assert.equal((await s.api('POST', '/bookings/lookup', creds(p))).body.booking.status, 'cancelled');
      expectedFailures += 5;
    }
    async function testEmailFails(label) {
      const r = await s.admin('POST', '/settings/test-email');
      assert.equal(r.status, 502, `${label}: ${r.text}`);
      assert.equal(r.body.code, 'mail_failed');
      assert.equal(typeof r.body.error, 'string');
      assert.ok(!r.text.includes(OWNER) && !r.text.includes(STUDIO) && !r.text.includes(SMTP_PASS), `${label}: nothing private in the answer`);
      assert.ok(!('sent' in r.body) && !('to' in r.body), label);
      expectedFailures += 1;
    }

    for (const mode of ['reject-auth', 'reject-rcpt', 'drop']) {
      box.mode = mode;
      await customerFlow();
      await testEmailFails(mode);
      assert.ok(await waitFor(() => mailLines().length >= expectedFailures), `${mode}: ${expectedFailures} failures logged, saw ${mailLines().length}`);
    }
    assert.equal(box.received.length, 0, 'nothing was accepted while the server refused');

    // it recovers by itself once the mail server is back
    box.mode = 'ok';
    const ok = await book(s, freshDay(), 14);
    const [m] = await arrived(box, 1);
    assert.ok(m.subject.includes(ok.code));
    assert.deepEqual(m.to, [OWNER]);
    assert.equal((await s.admin('POST', '/settings/test-email')).status, 200);
    await arrived(box, 2);

    // and when nothing listens on the port at all
    await box.close();
    await customerFlow();
    await testEmailFails('connection refused');
    assert.ok(await waitFor(() => mailLines().length >= expectedFailures), `closed port: ${expectedFailures} failures logged, saw ${mailLines().length}`);

    await sleep(300);
    const logged = mailLines();
    assert.equal(logged.length, expectedFailures, logged.join('\n'));
    for (const l of logged) assert.match(l, /^\[mail\] [A-Za-z]+ failed: [A-Za-z0-9_]+$/, l);
    const seen = new Set(logged.map((l) => l.split(' ')[1]));
    assert.deepEqual([...seen].sort(), [...TEMPLATES].sort(), 'every kind of staff email was tried and logged by its template name');
    const log = s.logs();
    for (const secret of [OWNER, STUDIO, CUSTOMER, 'example.test', SMTP_PASS, PHONE, 'Zed Mailtest', PAYLOAD]) {
      assert.ok(!log.includes(secret), `the log does not contain ${secret === SMTP_PASS ? 'the password' : secret}`);
    }
    assert.ok(!/BK-[A-Z0-9]{6}/.test(log), 'no booking codes in the log');
    assert.ok(!log.split(/\r?\n/).some((l) => l.includes('[api]') && l.includes('failed')), 'no request failed on the server');
  } finally {
    await s.stop();
  }
});

// ---------- every message of the run ----------

test('every email of this run: one recipient, plain text, no attachment, no QR text, no receipt file name, no password', async () => {
  const stored = fs.existsSync(srv.receiptDir) ? fs.readdirSync(srv.receiptDir).filter((f) => !f.endsWith('.tmp')) : [];
  assert.ok(stored.length > 0, 'receipts were uploaded during the run');
  let count = 0;
  for (const box of smtpServers) {
    for (const m of box.all()) {
      count += 1;
      assert.equal(m.to.length, 1, m.subject);
      assert.ok([STUDIO, OWNER, CUSTOMER].includes(m.to[0]), m.to[0]);
      assert.match(m.headers['content-type'] || '', /^text\/plain/i, m.subject);
      assert.ok(!/multipart|content-disposition|filename=|image\/(png|jpe?g|webp)/i.test(m.raw), `no attachment: ${m.subject}`);
      assert.ok(!('cc' in m.headers) && !('bcc' in m.headers) && !('reply-to' in m.headers), m.subject);
      for (const secret of [PAYLOAD, FAKE_ACCOUNT, SMTP_PASS]) assert.ok(!m.raw.includes(secret) && !m.text.includes(secret), m.subject);
      for (const f of stored) assert.ok(!m.text.includes(f) && !m.text.includes(path.parse(f).name), `no file name: ${m.subject}`);
      // staff templates only ever reach a staff address, customer templates only the customer
      const isStaff = /^(New booking |GCash receipt to check |Booking BK-|DMG Studio: test email$)/.test(m.subject);
      assert.equal(m.to[0] === CUSTOMER, !isStaff, `${m.to[0]} got "${m.subject}"`);
    }
  }
  assert.ok(count > 40, `looked at ${count} messages`);
});
