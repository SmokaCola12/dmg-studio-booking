import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { testEnv, PHONE, manilaToday, addDays, withDb } from './helpers/server.js';

// Receipt hints (OCR) on GCash screenshot uploads: X-Receipt-Ref / X-Receipt-Amount headers, the staff-only
// payment.receiptCheck, duplicate reference flags and the ref_digits column. The real server runs as a child process
// against temp DB_PATH / UPLOAD_DIR / RECEIPT_DIR (tests/helpers/server.js); all references here are made up.

const { tmp, startServer, cleanup } = testEnv('dmg-hints-');
let srv;

before(async () => {
  srv = await startServer('hints');
});
after(cleanup);

// ---------- helpers ----------

const day = (n) => addDays(manilaToday(), n);
let dayCounter = 2;
const freshDay = () => day(dayCounter++);

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);
/** A fresh made-up 13-digit reference, unique within this run. */
let refSeed = 0;
const newRef = () => `50${String(Date.now() % 1e8).padStart(8, '0')}${String(++refSeed).padStart(3, '0')}`;

async function gcash(date, startHour = 14, extra = {}, s = srv) {
  const r = await s.api('POST', '/bookings', {
    roomId: 1, date, startHour, paidHours: 1, name: 'Hint Tester', phone: PHONE, headcount: 2,
    paymentMethod: 'gcash', paymentPlan: 'half', ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.booking;
}
async function idOf(code, s = srv) {
  // The admin search also matches phone numbers by the digits in the query, so pick the exact code out of the page.
  const r = await s.admin('GET', `/bookings?q=${code}&limit=200`);
  const hits = r.body.bookings.filter((x) => x.code === code);
  assert.equal(hits.length, 1);
  return hits[0].id;
}
const detail = async (b, s = srv) => (await s.admin('GET', `/payments/${await idOf(b.code, s)}`)).body.booking;
const check = async (b, s = srv) => (await detail(b, s)).payment.receiptCheck;
async function uploadOk(b, opts = {}, s = srv) {
  const r = await s.upload(b.code, PHONE, png(), opts);
  assert.equal(r.status, 201, r.text);
  return r;
}
const dupCodes = (c) => c.duplicateRef.map((x) => x.code);
const refDigitsOf = (code, s = srv) => withDb(s.dbPath, (d) => d.prepare('SELECT ref_digits FROM bookings WHERE code = ?').get(code).ref_digits);

const PRIVATE_KEYS = /receiptCheck|ocrRef|ocrAmount|ocr_ref|ocr_amount|ref_digits|refDigits|duplicateRef|amountMatches|refMatchesOcr/;

// ---------- hints stored and compared ----------

test('valid hints: 201, receiptCheck and the proof item carry them, amountMatches true', async () => {
  const b = await gcash(freshDay(), 10); // Room A 400/h, half -> 200 due
  const ref = newRef();
  const up = await uploadOk(b, { ocrRef: ref, ocrAmount: '200.00' });
  assert.ok(!PRIVATE_KEYS.test(up.text), 'upload response is public');
  assert.ok(!up.text.includes(ref), 'the OCR ref is not echoed to the customer');

  const d = await detail(b);
  assert.deepEqual(d.payment.receiptCheck, { ocrRef: ref, ocrAmount: 200, amountMatches: true, refMatchesOcr: null, duplicateRef: [] });
  assert.equal(d.proofs.length, 1);
  assert.equal(d.proofs[0].ocrRef, ref);
  assert.equal(d.proofs[0].ocrAmount, 200);
  // the admin booking route and lists carry the same check
  assert.deepEqual((await srv.admin('GET', `/bookings/${d.id}`)).body.booking.payment.receiptCheck, d.payment.receiptCheck);
  const list = await srv.admin('GET', `/bookings?q=${b.code}&limit=200`);
  assert.deepEqual(list.body.bookings.find((x) => x.code === b.code).payment.receiptCheck, d.payment.receiptCheck);
  // the event note says a hint was found, never its value
  const ev = d.events.find((e) => e.action === 'proof_uploaded');
  assert.match(ev.note, /ocr ref found/);
  assert.match(ev.note, /ocr amount found/);
  assert.ok(!JSON.stringify(d.events).includes(ref));

  // whole-peso and one-decimal hints are accepted too; the full plan compares against the total
  const f = await gcash(freshDay(), 10, { paymentPlan: 'full' });
  await uploadOk(f, { ocrAmount: '400' });
  assert.equal((await check(f)).amountMatches, true);
  const g = await gcash(freshDay(), 10);
  await uploadOk(g, { ocrAmount: '200.0' });
  assert.equal((await check(g)).ocrAmount, 200);
});

test('amount mismatch gives amountMatches false; no hints give nulls; the latest screenshot wins', async () => {
  const b = await gcash(freshDay(), 10);
  await uploadOk(b, { ocrAmount: '210.00' });
  const c = await check(b);
  assert.equal(c.ocrAmount, 210);
  assert.equal(c.amountMatches, false);
  assert.equal(c.ocrRef, '');

  const n = await gcash(freshDay(), 10);
  await uploadOk(n);
  assert.deepEqual(await check(n), { ocrRef: '', ocrAmount: null, amountMatches: null, refMatchesOcr: null, duplicateRef: [] });
  const proof = (await detail(n)).proofs[0];
  assert.equal(proof.ocrRef, '');
  assert.equal(proof.ocrAmount, null);

  // before any upload
  const fresh = await gcash(freshDay(), 10);
  assert.deepEqual(await check(fresh), { ocrRef: '', ocrAmount: null, amountMatches: null, refMatchesOcr: null, duplicateRef: [] });

  // a second screenshot without hints replaces the comparison
  await uploadOk(b);
  assert.equal((await check(b)).ocrAmount, null);
  assert.equal((await check(b)).amountMatches, null);
  assert.equal((await detail(b)).proofs[0].ocrAmount, 210, 'the first proof keeps its own hint');
});

test('refMatchesOcr compares the typed reference (spaces and dashes ignored) with the OCR one', async () => {
  const ref = newRef();
  const spaced = `${ref.slice(0, 4)} ${ref.slice(4, 7)}-${ref.slice(7)}`;
  const yes = await gcash(freshDay(), 10);
  await uploadOk(yes, { ref: spaced, ocrRef: ref });
  assert.equal((await check(yes)).refMatchesOcr, true);
  assert.deepEqual((await check(yes)).duplicateRef, [], 'its own typed and OCR ref are not a duplicate');

  const no = await gcash(freshDay(), 10);
  await uploadOk(no, { ref: newRef(), ocrRef: newRef() });
  assert.equal((await check(no)).refMatchesOcr, false);

  const typedOnly = await gcash(freshDay(), 10);
  await uploadOk(typedOnly, { ref: newRef() });
  assert.equal((await check(typedOnly)).refMatchesOcr, null);
  const ocrOnly = await gcash(freshDay(), 10);
  await uploadOk(ocrOnly, { ocrRef: newRef() });
  assert.equal((await check(ocrOnly)).refMatchesOcr, null);
  // a typed reference under 8 digits cannot be compared
  const short = await gcash(freshDay(), 10);
  await uploadOk(short, { ref: '1234-567', ocrRef: newRef() });
  assert.equal((await check(short)).refMatchesOcr, null);
});

test('garbage hints are dropped silently and the upload still succeeds', async () => {
  const d = freshDay();
  const cases = [
    ['letters', { ocrRef: 'abcdefghijklm' }],
    // the OCR ref must be 8 to 20 digits and nothing else: no stripping of letters, spaces or dashes
    ['letters around digits', { ocrRef: 'abc1234-5678x' }],
    ['dashes', { ocrRef: '5046-627-354816' }],
    ['spaces', { ocrRef: '5046 627 354816' }],
    ['label text', { ocrRef: 'Ref No. 5046627354816' }],
    ['decimal', { ocrRef: '5046627354816.0' }],
    ['7 digits', { ocrRef: '1234567' }],
    ['21 digits', { ocrRef: '123456789012345678901' }],
    // over 64 characters (trailing spaces would be trimmed by HTTP, so they sit inside)
    ['ref too long', { ocrRef: `${'1'.repeat(13)}${' '.repeat(60)}x` }],
    ['very long ref header', { ocrRef: '5'.repeat(8000) }],
    ['thousands comma', { ocrAmount: '1,000.00' }],
    ['negative', { ocrAmount: '-200.00' }],
    ['zero', { ocrAmount: '0' }],
    ['zero decimals', { ocrAmount: '0.00' }],
    ['over a million', { ocrAmount: '1000000.01' }],
    ['8 digits', { ocrAmount: '10000000' }],
    ['three decimals', { ocrAmount: '200.005' }],
    ['P prefix', { ocrAmount: 'P200.00' }], // (a literal peso sign cannot be sent: header values are Latin-1)
    ['exponent', { ocrAmount: '2e2' }],
    ['hex', { ocrAmount: '0x10' }],
    ['very long amount header', { ocrAmount: `200.00${' '.repeat(5000)}x` }],
    ['NaN', { ocrAmount: 'NaN' }],
    ['Infinity', { ocrAmount: 'Infinity' }],
  ];
  let hour = 10;
  let day2 = d;
  for (const [label, hints] of cases) {
    if (hour > 20) {
      day2 = freshDay();
      hour = 10;
    }
    const b = await gcash(day2, hour);
    hour += 2;
    const r = await srv.upload(b.code, PHONE, png(), hints);
    assert.equal(r.status, 201, `${label}: ${r.text}`);
    const c = await check(b);
    if (hints.ocrRef !== undefined) assert.equal(c.ocrRef, '', label);
    if (hints.ocrAmount !== undefined) {
      assert.equal(c.ocrAmount, null, label);
      assert.equal(c.amountMatches, null, label);
    }
  }
  assert.ok(!/at |TypeError|RangeError/.test(srv.logs()), 'no stack traces in the log');

  // a header sent twice arrives joined by ", " and is dropped
  const twice = await gcash(freshDay(), 10);
  const res = await fetch(`${srv.base}/api/bookings/payment-proof`, {
    method: 'POST',
    headers: [
      ['content-type', 'image/png'], ['x-booking-code', twice.code], ['x-booking-phone', PHONE],
      ['x-receipt-ref', '12345678'], ['x-receipt-ref', '12345678'],
      ['x-receipt-amount', '200.00'], ['x-receipt-amount', '200.00'],
    ],
    body: png(),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(res.status, 201, await res.text());
  assert.equal((await check(twice)).ocrRef, '', 'repeated ref header');
  assert.equal((await check(twice)).ocrAmount, null, 'repeated amount header');

  // the boundaries that ARE accepted
  const edge = await gcash(freshDay(), 10);
  await uploadOk(edge, { ocrRef: '12345678', ocrAmount: '1000000' });
  assert.equal((await check(edge)).ocrRef, '12345678', '8 digits is the minimum');
  assert.equal((await check(edge)).ocrAmount, 1_000_000, 'exactly a million is the maximum');
  const edge2 = await gcash(freshDay(), 10);
  await uploadOk(edge2, { ocrRef: '12345678901234567890', ocrAmount: ' 0.01 ' });
  assert.equal((await check(edge2)).ocrRef, '12345678901234567890', '20 digits is the maximum');
  assert.equal((await check(edge2)).ocrAmount, 0.01);
});

// ---------- duplicate references ----------

test('duplicateRef across two bookings: typed vs typed, typed vs OCR, OCR vs OCR', async () => {
  for (const [label, aHints, bHints] of [
    ['typed vs typed', (r) => ({ ref: r }), (r) => ({ ref: `${r.slice(0, 6)} ${r.slice(6)}` })],
    ['typed vs OCR', (r) => ({ ref: r }), (r) => ({ ocrRef: r })],
    ['OCR vs typed', (r) => ({ ocrRef: r }), (r) => ({ ref: r })],
    ['OCR vs OCR', (r) => ({ ocrRef: r }), (r) => ({ ocrRef: r })],
  ]) {
    const ref = newRef();
    const d = freshDay();
    const a = await gcash(d, 10);
    const b = await gcash(d, 14);
    const other = await gcash(d, 18);
    await uploadOk(a, aHints(ref));
    assert.deepEqual((await check(a)).duplicateRef, [], `${label}: alone`);
    await uploadOk(b, bHints(ref));
    await uploadOk(other, { ref: newRef(), ocrRef: newRef() });
    const ca = await check(a);
    const cb = await check(b);
    assert.deepEqual(dupCodes(ca), [b.code], `${label}: a sees b`);
    assert.deepEqual(dupCodes(cb), [a.code], `${label}: b sees a`);
    assert.deepEqual(Object.keys(ca.duplicateRef[0]).sort(), ['code', 'id', 'status']);
    assert.equal(ca.duplicateRef[0].status, 'pending');
    assert.deepEqual((await check(other)).duplicateRef, [], `${label}: unrelated booking`);
    // the admin payments list shows the same flag
    const list = await srv.admin('GET', '/payments?limit=200');
    assert.deepEqual(dupCodes(list.body.bookings.find((x) => x.code === b.code).payment.receiptCheck), [a.code]);
  }
});

test('duplicateRef also finds cancelled and expired bookings, and lists every other booking once', async () => {
  const ref = newRef();
  const d = freshDay();
  const cancelled = await gcash(d, 10);
  await uploadOk(cancelled, { ref });
  assert.equal((await srv.admin('PATCH', `/bookings/${await idOf(cancelled.code)}`, { status: 'cancelled' })).status, 200);

  const expired = await gcash(d, 12);
  withDb(srv.dbPath, (db) => db.prepare('UPDATE bookings SET hold_expires_at = ? WHERE code = ?').run(new Date(Date.now() - 60_000).toISOString(), expired.code));
  // staff note the customer's reference on the expired booking
  const patched = await srv.admin('PATCH', `/bookings/${await idOf(expired.code)}`, { paymentRef: ref });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.booking.status, 'expired');

  const now = await gcash(d, 16);
  await uploadOk(now, { ref, ocrRef: ref }); // the same ref twice on one booking still lists each other booking once
  const c = await check(now);
  assert.deepEqual(dupCodes(c), [cancelled.code, expired.code]);
  assert.deepEqual(c.duplicateRef.map((x) => x.status), ['cancelled', 'expired']);
  assert.equal(c.refMatchesOcr, true);
});

test('no duplicate for refs under 8 digits, for empty refs, or for itself', async () => {
  const d = freshDay();
  const a = await gcash(d, 10);
  const b = await gcash(d, 14);
  await uploadOk(a, { ref: '1234567', ocrRef: '1234567' });
  await uploadOk(b, { ref: '123-4567' });
  assert.deepEqual((await check(a)).duplicateRef, []);
  assert.deepEqual((await check(b)).duplicateRef, []);
  assert.equal(refDigitsOf(a.code), '');
  assert.equal(refDigitsOf(b.code), '');

  const e1 = await gcash(d, 18);
  await uploadOk(e1, { ref: '', ocrRef: '' });
  const e2 = await gcash(d, 20);
  await uploadOk(e2, { ref: 'n/a' });
  assert.deepEqual((await check(e1)).duplicateRef, []);
  assert.deepEqual((await check(e2)).duplicateRef, []);

  // one booking uploading the same screenshot reference three times is not a duplicate of itself
  const self = await gcash(freshDay(), 10);
  const ref = newRef();
  for (let i = 0; i < 3; i++) await uploadOk(self, { ref, ocrRef: ref });
  assert.deepEqual((await check(self)).duplicateRef, []);
});

test('a duplicate reference never blocks an upload or a confirm', async () => {
  const ref = newRef();
  const d = freshDay();
  const a = await gcash(d, 10);
  const b = await gcash(d, 14);
  await uploadOk(a, { ref, ocrRef: ref, ocrAmount: '200.00' });
  const r = await srv.upload(b.code, PHONE, png(), { ref, ocrRef: ref, ocrAmount: '200.00' });
  assert.equal(r.status, 201, r.text);
  for (const x of [a, b]) {
    const ok = await srv.admin('POST', `/payments/${await idOf(x.code)}/confirm`, {});
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.booking.status, 'confirmed');
    assert.equal(ok.body.booking.payment.receiptCheck.duplicateRef.length, 1, 'the flag is still shown after confirming');
  }
});

// ---------- ref_digits kept in step by staff edits ----------

test('ref_digits follows admin walk-in create and PATCH paymentRef; the duplicate appears and disappears', async () => {
  const ref = newRef();
  const d = freshDay();
  const online = await gcash(d, 10);
  await uploadOk(online, { ocrRef: ref });

  const walk = await srv.admin('POST', '/bookings', {
    roomId: 1, date: d, startHour: 14, paidHours: 1, name: 'Walk In', paymentMethod: 'gcash', paymentRef: `GC ${ref.slice(0, 5)}-${ref.slice(5)}`,
  });
  assert.equal(walk.status, 201, walk.text);
  assert.equal(refDigitsOf(walk.body.booking.code), ref);
  assert.deepEqual(dupCodes(walk.body.booking.payment.receiptCheck), [online.code], 'the create response already flags it');
  assert.deepEqual(dupCodes(await check(online)), [walk.body.booking.code]);

  const walkId = walk.body.booking.id;
  const changed = await srv.admin('PATCH', `/bookings/${walkId}`, { paymentRef: newRef() });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.booking.payment.receiptCheck.duplicateRef, []);
  assert.deepEqual((await check(online)).duplicateRef, [], 'gone after the walk-in ref changed');

  await srv.admin('PATCH', `/bookings/${walkId}`, { paymentRef: ref });
  assert.equal(refDigitsOf(walk.body.booking.code), ref);
  assert.deepEqual(dupCodes(await check(online)), [walk.body.booking.code], 'back again');

  await srv.admin('PATCH', `/bookings/${walkId}`, { paymentRef: '' });
  assert.equal(refDigitsOf(walk.body.booking.code), '');
  assert.deepEqual((await check(online)).duplicateRef, [], 'cleared ref');

  // a PATCH that does not touch paymentRef keeps ref_digits
  await srv.admin('PATCH', `/bookings/${walkId}`, { paymentRef: ref });
  await srv.admin('PATCH', `/bookings/${walkId}`, { adminNotes: 'note only' });
  assert.equal(refDigitsOf(walk.body.booking.code), ref);

  // a walk-in with a short or no reference stores none
  const w2 = await srv.admin('POST', '/bookings', { roomId: 2, date: d, startHour: 10, paidHours: 1, name: 'Short', paymentRef: '1234' });
  assert.equal(refDigitsOf(w2.body.booking.code), '');
  // and a customer upload with a typed ref sets it, while an upload without one keeps the earlier one
  const c = await gcash(d, 18);
  await uploadOk(c, { ref });
  assert.equal(refDigitsOf(c.code), ref);
  await uploadOk(c);
  assert.equal(refDigitsOf(c.code), ref);
});

// ---------- privacy ----------

test('public views and server logs never carry the hints or the check', async () => {
  const ref = newRef();
  const amount = '4321.09';
  const d = freshDay();
  const b = await gcash(d, 10);
  const other = await gcash(d, 14);
  await uploadOk(other, { ref, ocrRef: ref });
  const up = await uploadOk(b, { ocrRef: ref, ocrAmount: amount, ref: newRef() });
  const creds = { code: b.code, phone: PHONE };

  const fresh = await gcash(d, 18); // still waiting: payment-qr and cancel answer 200 for this one
  const freshCreds = { code: fresh.code, phone: PHONE };
  const surfaces = {
    upload: up.text,
    lookup: (await srv.api('POST', '/bookings/lookup', creds)).text,
    site: (await srv.api('GET', '/site')).text,
    availability: (await srv.api('GET', `/availability?date=${d}`)).text,
    month: (await srv.api('GET', `/availability/month?month=${d.slice(0, 7)}`)).text,
    qrRefused: (await srv.api('POST', '/bookings/payment-qr', creds)).text,
    qr: (await srv.api('POST', '/bookings/payment-qr', freshCreds)).text,
    reschedule: (await srv.api('POST', '/bookings/reschedule', { ...creds, date: freshDay(), startHour: 12 })).text,
    lookupAfter: (await srv.api('POST', '/bookings/lookup', creds)).text,
    cancel: (await srv.api('POST', '/bookings/cancel', creds)).text,
    cancelFresh: (await srv.api('POST', '/bookings/cancel', freshCreds)).text,
  };
  for (const [name, text] of Object.entries(surfaces)) {
    assert.ok(!PRIVATE_KEYS.test(text), `${name} has no private keys: ${text.slice(0, 300)}`);
    assert.ok(!text.includes(ref), `${name} has no OCR ref`);
    assert.ok(!text.includes(amount) && !text.includes('4321.09') && !text.includes('432109'), `${name} has no OCR amount`);
    assert.ok(!text.includes(other.code), `${name} does not name the other booking`);
  }
  const logs = srv.logs();
  assert.ok(!logs.includes(ref), 'no OCR ref in the server log');
  assert.ok(!logs.includes(amount), 'no OCR amount in the server log');
  // staff do see it
  assert.equal((await check(b)).ocrRef, ref);
});

// ---------- migration ----------

test('migration: a DB without the OCR columns gains them, ref_digits is backfilled, and restarting is safe', async () => {
  const file = path.join(tmp, 'pre-ocr.db');
  const d = day(40);
  // Build the pre-OCR schema: start once on a fresh file, then remove what the OCR change added.
  const first = await startServer('pre-ocr-build', { dbPath: file, qr: false });
  await first.stop();
  withDb(file, (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_bookings_ref_digits;
      DROP INDEX IF EXISTS idx_proofs_ocr_ref;
      ALTER TABLE bookings DROP COLUMN ref_digits;
      ALTER TABLE payment_proofs DROP COLUMN ocr_ref;
      ALTER TABLE payment_proofs DROP COLUMN ocr_amount_centavos;
    `);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols('bookings').includes('ref_digits'));
    assert.ok(!cols('payment_proofs').includes('ocr_ref'));
    const ins = db.prepare(
      `INSERT INTO bookings (code, room_id, date, start_hour, paid_hours, end_hour, customer_name, phone, payment_method, payment_ref,
         hourly_rate, total, status, payment_plan, amount_due, payment_status)
       VALUES (?, 1, ?, ?, 1, ?, 'Old Row', ?, 'gcash', ?, 400, 400, ?, 'half', 200, 'proof_submitted')`
    );
    const rows = [
      ['BK-MIG001', 10, 'REF 5046-627-354816', 'pending'],
      ['BK-MIG002', 12, '5046627354816', 'cancelled'],
      ['BK-MIG003', 14, '1234567', 'pending'],
      ['BK-MIG004', 16, '', 'pending'],
      ['BK-MIG005', 18, '123456789012345678901', 'confirmed'],
      ['BK-MIG006', 20, 'gcash #9988 7766 55', 'pending'],
    ];
    for (const [code, h, ref, status] of rows) ins.run(code, d, h, h + 1, PHONE, ref, status);
    db.prepare(
      `INSERT INTO payment_proofs (booking_id, file, mime, bytes, sha256, kind, uploaded_by, uploaded_at)
       VALUES ((SELECT id FROM bookings WHERE code = 'BK-MIG001'), 'old-proof.png', 'image/png', 48, 'abc', 'deposit', 'customer', ?)`
    ).run(new Date().toISOString());
  });

  const s = await startServer('pre-ocr', { dbPath: file, qr: false });
  try {
    const expect = { 'BK-MIG001': '5046627354816', 'BK-MIG002': '5046627354816', 'BK-MIG003': '', 'BK-MIG004': '', 'BK-MIG005': '', 'BK-MIG006': '9988776655' };
    withDb(file, (db) => {
      for (const [code, digits] of Object.entries(expect)) {
        assert.equal(db.prepare('SELECT ref_digits FROM bookings WHERE code = ?').get(code).ref_digits, digits, code);
      }
      const proof = db.prepare("SELECT ocr_ref, ocr_amount_centavos FROM payment_proofs WHERE file = 'old-proof.png'").get();
      assert.deepEqual(proof, { ocr_ref: '', ocr_amount_centavos: null });
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
      assert.ok(idx.includes('idx_bookings_ref_digits') && idx.includes('idx_proofs_ocr_ref'));
    });
    const list = await s.admin('GET', '/payments?limit=200');
    assert.equal(list.status, 200, list.text);
    const one = list.body.bookings.find((x) => x.code === 'BK-MIG001');
    assert.deepEqual(dupCodes(one.payment.receiptCheck), ['BK-MIG002'], 'backfilled refs are compared');
    assert.equal(one.payment.receiptCheck.ocrRef, '');
    assert.equal(one.proofs[0].ocrRef, '');
    assert.equal(one.proofs[0].ocrAmount, null);
  } finally {
    await s.stop();
  }
  // a second start leaves rows without a reference and rows already filled alone, and repairs a row that has a
  // reference but lost its digits (e.g. a start that died between the ALTER and the backfill)
  withDb(file, (db) => {
    db.prepare("UPDATE bookings SET ref_digits = 'sentinel' WHERE code = 'BK-MIG004'").run();
    db.prepare("UPDATE bookings SET ref_digits = '' WHERE code = 'BK-MIG001'").run();
    db.prepare("UPDATE bookings SET ref_digits = '11112222333' WHERE code = 'BK-MIG006'").run();
  });
  const again = await startServer('pre-ocr-again', { dbPath: file, qr: false });
  try {
    assert.equal((await again.admin('GET', '/payments?limit=200')).status, 200);
    withDb(file, (db) => {
      const digitsOf = (code) => db.prepare('SELECT ref_digits FROM bookings WHERE code = ?').get(code).ref_digits;
      assert.equal(digitsOf('BK-MIG004'), 'sentinel', 'a row without payment_ref is not touched');
      assert.equal(digitsOf('BK-MIG001'), '5046627354816', 'an emptied ref_digits is repaired');
      assert.equal(digitsOf('BK-MIG006'), '11112222333', 'a filled ref_digits is not rewritten');
      assert.equal(digitsOf('BK-MIG003'), '', 'a too-short reference stays empty');
    });
  } finally {
    await again.stop();
  }
});

// ---------- many bookings ----------

test('the admin payments list with 60 bookings returns a correct receiptCheck for each', async () => {
  const s = await startServer('hints-many');
  try {
    const made = [];
    const shared = newRef();
    for (let dn = 0; made.length < 60; dn++) {
      const d = day(3 + dn);
      for (const roomId of [1, 2]) {
        for (const h of [10, 12, 14, 16, 18, 20]) {
          if (made.length >= 60) break;
          const b = await gcash(d, h, { roomId }, s);
          const i = made.length;
          // every 10th booking shares one reference (6 bookings); the rest have their own
          const ocrRef = i % 10 === 0 ? shared : newRef();
          const ocrAmount = i % 2 ? '1.00' : (b.payment.amountDue).toFixed(2);
          const r = await s.upload(b.code, PHONE, png(), { ocrRef, ocrAmount });
          assert.equal(r.status, 201, r.text);
          made.push({ code: b.code, ocrRef, match: i % 2 === 0, shared: i % 10 === 0 });
        }
      }
    }
    const t0 = Date.now();
    const list = await s.admin('GET', '/payments?limit=200');
    const ms = Date.now() - t0;
    assert.equal(list.status, 200);
    assert.equal(list.body.bookings.length, 60);
    assert.ok(ms < 5000, `list took ${ms} ms`);
    const sharedCodes = made.filter((m) => m.shared).map((m) => m.code);
    for (const m of made) {
      const row = list.body.bookings.find((x) => x.code === m.code);
      const c = row.payment.receiptCheck;
      assert.ok(c, m.code);
      assert.equal(c.ocrRef, m.ocrRef);
      assert.equal(c.amountMatches, m.match);
      assert.deepEqual(dupCodes(c).sort(), m.shared ? sharedCodes.filter((x) => x !== m.code).sort() : [], m.code);
    }
    // the first page of 50 too
    const page = await s.admin('GET', '/payments');
    assert.equal(page.body.bookings.length, 50);
    assert.ok(page.body.bookings.every((x) => x.payment.receiptCheck && Array.isArray(x.payment.receiptCheck.duplicateRef)));
  } finally {
    await s.stop();
  }
});
