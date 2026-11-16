import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTlv, crc16ccitt, validateStaticQr, withAmount, pesoText, maskSummary } from '../backend/lib/emv.js';
import { buildQr, crc16, tlv, FAKE_ACCOUNT } from './helpers/qr.js';

// Pure unit tests of backend/lib/emv.js. Payloads are synthetic (see helpers/qr.js).

test('CRC-16/CCITT-FALSE matches the standard check value', () => {
  assert.equal(crc16ccitt('123456789'), '29B1');
  assert.equal(crc16('123456789'), '29B1', 'the test helper agrees');
  assert.equal(crc16ccitt(''), 'FFFF');
});

test('parseTlv splits a payload and rejects malformed input', () => {
  const items = parseTlv(buildQr());
  assert.equal(items[0].id, '00');
  assert.equal(items[0].val, '01');
  assert.equal(items.at(-1).id, '63');
  assert.equal(items.at(-1).len, 4);
  assert.equal(parseTlv('0002'), null, 'length runs past the end');
  assert.equal(parseTlv('AB02XX'), null, 'non-numeric id');
  assert.equal(parseTlv('00'), null, 'truncated header');
  assert.equal(parseTlv(null), null);
  assert.deepEqual(parseTlv(''), []);
});

test('a valid static QR is accepted', () => {
  const r = validateStaticQr(buildQr());
  assert.equal(r.ok, true);
  assert.equal(r.items.find((x) => x.id === '01').val, '11');
});

test('withAmount round trips: valid, dynamic, amount right after the currency, fields kept', () => {
  const out = withAmount(buildQr(), '250.00');
  const check = validateStaticQr(out);
  assert.equal(check.ok, true, 'result passes validation, so the CRC is valid');
  const ids = check.items.map((x) => x.id);
  assert.equal(check.items.find((x) => x.id === '01').val, '12', 'static 11 becomes dynamic 12');
  assert.equal(ids[ids.indexOf('53') + 1], '54', 'tag 54 sits right after tag 53');
  assert.equal(check.items.find((x) => x.id === '54').val, '250.00');
  assert.equal(ids.at(-1), '63');
  assert.equal(ids.filter((x) => x === '54').length, 1);
  assert.equal(crc16(out.slice(0, -4)), out.slice(-4));
  const before = parseTlv(buildQr());
  for (const id of ['00', '28', '52', '53', '58', '59', '60']) {
    assert.equal(check.items.find((x) => x.id === id).val, before.find((x) => x.id === id).val, `tag ${id} kept`);
  }
});

test('withAmount replaces an existing tag 54 and works on an already dynamic code', () => {
  const withOld = buildQr({ initiation: '12', amount: '99.00' });
  assert.equal(validateStaticQr(withOld).ok, true);
  const out = withAmount(withOld, '175.00');
  const items = validateStaticQr(out).items;
  assert.equal(items.filter((x) => x.id === '54').length, 1);
  assert.equal(items.find((x) => x.id === '54').val, '175.00');
  assert.equal(items.find((x) => x.id === '01').val, '12');
});

test('withAmount rejects bad amounts and an invalid stored payload', () => {
  for (const bad of ['250', '250.5', 'abc', '', '-5.00', '12345678.00']) {
    assert.throws(() => withAmount(buildQr(), bad), undefined, `amount ${bad}`);
  }
  assert.throws(() => withAmount('not a qr', '10.00'));
});

test('pesoText accepts whole positive pesos only', () => {
  assert.equal(pesoText(250), '250.00');
  assert.equal(pesoText(1), '1.00');
  for (const bad of [0, -1, 1.5, '250', null, undefined, NaN, 1_000_001]) assert.equal(pesoText(bad), null, String(bad));
});

test('validateStaticQr rejects a bad CRC, missing currency, non-ASCII and other bad shapes', () => {
  assert.equal(validateStaticQr(buildQr({ badCrc: true })).ok, false);
  assert.equal(validateStaticQr(buildQr({ currency: '' })).ok, false, 'missing tag 53');
  assert.equal(validateStaticQr(buildQr({ currency: '840' })).ok, false, 'not pesos');
  assert.equal(validateStaticQr(buildQr({ country: 'US' })).ok, false, 'not PH');
  assert.equal(validateStaticQr(buildQr({ initiation: '13' })).ok, false);
  assert.equal(validateStaticQr(buildQr({ merchant: 'CAFÉ TEST' })).ok, false, 'non-ASCII merchant name');
  assert.equal(validateStaticQr('').ok, false);
  assert.equal(validateStaticQr(undefined).ok, false);
  assert.equal(validateStaticQr(42).ok, false);
  assert.equal(validateStaticQr('hello world').ok, false);
  assert.equal(validateStaticQr(buildQr().slice(0, -4)).ok, false, 'checksum cut off');
  assert.equal(validateStaticQr(`${buildQr()}${'0'.repeat(600)}`).ok, false, 'too long');
  // a correct CRC over a payload with a missing 53 is still rejected for the missing field
  const body = `${tlv('00', '01')}${tlv('01', '11')}${tlv('52', '0000')}${tlv('58', 'PH')}${tlv('59', 'X')}6304`;
  assert.equal(validateStaticQr(body + crc16(body)).ok, false);
});

test('validateStaticQr error texts never contain the payload', () => {
  const bad = buildQr({ badCrc: true });
  const { error } = validateStaticQr(bad);
  assert.ok(error);
  assert.ok(!error.includes(FAKE_ACCOUNT));
  assert.ok(!error.includes(bad));
});

test('maskSummary shows merchant, city and a masked account, never the raw account', () => {
  const s = maskSummary(buildQr());
  assert.equal(s.merchantName, 'TEST MERCHANT');
  assert.equal(s.city, 'TESTVILLE');
  assert.ok(s.accountHint.length > 0);
  assert.ok(!s.accountHint.includes(FAKE_ACCOUNT));
  assert.ok(s.accountHint.startsWith(FAKE_ACCOUNT.slice(0, 2)));
  assert.ok(s.accountHint.endsWith(FAKE_ACCOUNT.slice(-2)));
  assert.ok(s.accountHint.includes('•'));
  assert.deepEqual(maskSummary('garbage'), { merchantName: '', city: '', accountHint: '' });
  assert.ok(!JSON.stringify(s).includes(FAKE_ACCOUNT));
});
