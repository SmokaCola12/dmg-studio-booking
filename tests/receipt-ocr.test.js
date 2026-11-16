import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGcashReceipt, amountText } from '../frontend/src/lib/receipt-ocr.js';

// Pure unit tests of the receipt text parser (frontend/src/lib/receipt-ocr.js). It runs in the customer's browser on
// the OCR text of a GCash screenshot; here we feed it SYNTHETIC receipt texts (made-up names, numbers and references).

const REF = '5046627354816';
const PHONE63 = '+63 917 555 0142';

/** A made-up GCash Express Send receipt, shaped like the OCR output of the real one. */
const expressSend = ({ ref = `Ref No. ${REF}`, amount = 'Amount 210.00', total = 'Total Amount Sent ₱210.00' } = {}) =>
  [
    'GCash',
    'Express Send',
    'JU•N D.',
    PHONE63,
    'Sent via GCash',
    amount,
    total,
    ref,
    'Oct 28, 2026 6:22 PM',
    '',
    'Get up to 5% cashback on your next load!',
    'Download the app. Terms apply. 1800 1234 5678',
  ].join('\n');

const inbox = (ref = 'Ref. No. 5047143694567.') =>
  `You have received PHP 10.00 from JU•N D. on 10-28-2026 06:22 PM. Your new balance is PHP 1,234.56. ${ref}`;

const p = parseGcashReceipt;

test('a clean Express Send receipt gives the reference, the amount and the date', () => {
  assert.deepEqual(p(expressSend()), { ref: REF, amount: 210, dateText: 'Oct 28, 2026 6:22 PM' });
});

test('the GCash inbox wording gives the reference and the received amount', () => {
  const r = p(inbox());
  assert.equal(r.ref, '5047143694567');
  assert.equal(r.amount, 10, 'the received amount, not the balance');
});

test('reference label variants', () => {
  for (const label of ['Ref No.', 'Ref No', 'Ref. No.', 'Ref No.:', 'Ref No:', 'Ref. No.:', 'REF NO.', 'ref no', 'Reference No.', 'Reference Number:', 'Ref #', 'Ref N0.']) {
    assert.equal(p(expressSend({ ref: `${label} ${REF}` })).ref, REF, label);
  }
  // Cyrillic о and е in the label (OCR picks these up from mixed fonts)
  assert.equal(p(expressSend({ ref: `Rеf Nо. ${REF}` })).ref, REF, 'Cyrillic e and o');
  assert.equal(p(expressSend({ ref: `Ref Nо. ${REF}` })).ref, REF, 'Cyrillic o');
  // label and number on separate lines
  // label right before the number with no space
  assert.equal(p(`Ref No.${REF}`).ref, REF);
});

test('only the GCash 4-3-6 grouping is joined after the label; other splits give nothing', () => {
  assert.equal(p(expressSend({ ref: 'Ref No. 5046 627 354816' })).ref, REF);
  assert.equal(p('Ref No. 5046\t627\t354816').ref, REF, 'tabs');
  assert.equal(p('Reference Number: 1234 567 890123').ref, '1234567890123');
  for (const spaced of ['5046 6273 54816', '5 0 4 6 6 2 7 3 5 4 8 1 6', '504662 7354816', '50466 27354816']) {
    assert.equal(p(expressSend({ ref: `Ref No. ${spaced}` })).ref, '', spaced);
  }
  // a digit-like token after the reference means it may be longer: not sure
  assert.equal(p(`Ref No. ${REF} 7`).ref, '');
  assert.equal(p(`Ref No. ${REF} +63`).ref, '');
  assert.equal(p('Ref No. 5046 627 354816 21').ref, '');
  // a word after it is fine
  assert.equal(p(`Ref No. ${REF} Copied`).ref, REF);
});

test('regressions from review: dates, phones and other references never become the reference', () => {
  for (const text of [
    'Ref No. 1234 567 89012 5 Nov 2026',
    'Ref No. 1234 567 8901 14 Nov 2026',
    'Ref No.\n0917 123 4567 21',
    'InstaPay Ref No. 123456\nTrace 1763112345678',
    'Ref No. 504662735481 28',
    'Ref No. 50466273548 28 Oct 2026',
  ]) {
    assert.equal(p(text).ref, '', JSON.stringify(text));
  }
  // two labels that disagree: not sure
  assert.equal(p(`Ref No. ${REF}\nRef No. 9999999999999`).ref, '');
  // two labels that agree are fine
  assert.equal(p(`Ref No. ${REF}\nRef. No. ${REF}.`).ref, REF);
  // the label does not cross a line break unless the reference is the whole next line
  assert.equal(p(`Ref No.\n${REF}`).ref, REF);
  assert.equal(p(`Ref No.\n${REF} 12`).ref, '');
  assert.equal(p(`Ref No.\n\n${REF}`).ref, '', 'a blank line in between');
  // with a label present the loose fallback never runs, even if the label's value is unreadable
  assert.equal(p(`Ref No. ???\nSomething ${REF}`).ref, '');
  // "Refund" is not a label, so the loose fallback still applies
  assert.equal(p(`Refund ${REF}`).ref, REF);
  assert.equal(p(`Refunded 5046 627 354816 ${REF}`).ref, REF);
});

test('look-alike letters inside the labelled digit run are read as digits, within limits', () => {
  assert.equal(p('Ref No. 5O46627354816').ref, REF, 'O for 0');
  assert.equal(p('Ref No. 5046627354Bl6').ref, REF, 'B and l');
  assert.equal(p('Ref No. 5046 627 3S48I6').ref, REF, 'S and I across a split');
  assert.equal(p('Ref No. 5o46 627 354816').ref, REF, 'lower-case o');
  // too many look-alikes in one chunk: not sure, so nothing
  assert.equal(p('Ref No. 5O466273S48l6').ref, '');
  // letters alone are not a reference
  assert.equal(p('Ref No. OOOOOOOOOOOOO').ref, '');
  // look-alikes are not applied without the label
  assert.equal(p('payment 5O46627354816 done').ref, '');
});

test('no label: exactly one 13-digit run is used; two different runs give nothing', () => {
  assert.equal(p(`Sent ${REF} ok`).ref, REF);
  assert.equal(p(`${REF} again ${REF}`).ref, REF, 'the same run twice is still one reference');
  assert.equal(p(`${REF} and 9999999999999`).ref, '');
  assert.equal(p(expressSend({ ref: `${REF}  1234567890123` })).ref, '');
});

test('12 or 14 digits are not a reference', () => {
  for (const digits of ['504662735481', '50466273548167']) {
    assert.equal(p(`Ref No. ${digits}`).ref, '', `labelled ${digits.length}`);
    assert.equal(p(`Sent ${digits} ok`).ref, '', `loose ${digits.length}`);
  }
  assert.equal(p('Ref No. 504 662 735 481').ref, '', '12 digits in groups');
});

test('the phone number and the amount digits are never returned as the reference', () => {
  const noRef = expressSend({ ref: 'Ref No.' });
  assert.equal(p(noRef).ref, '');
  for (const phone of ['+639175550142', '+63 917 555 0142', '+63-917-555-0142', '09175550142', '+6309175550142']) {
    assert.equal(p(`Sent to ${phone}\nAmount 210.00`).ref, '', phone);
    assert.equal(p(`Sent to ${phone}\nRef No. ${REF}`).ref, REF, `${phone} with a ref`);
  }
  assert.equal(p('Amount 1234567890.12').ref, '');
  assert.equal(p('Total Amount Sent ₱1,234,567,890,123.00').ref, '');
  // a 13-digit amount-like run with decimals is not taken loosely
  assert.equal(p('Paid 5046627354816.00').ref, '');
});

test('amounts: prefixes, thousands commas, Amount Due is skipped, missing decimals give null', () => {
  assert.equal(p('Total Amount Sent P210.00').amount, 210);
  assert.equal(p('Total Amount Sent PHP 1,210.50').amount, 1210.5);
  assert.equal(p('Total Amount Sent ₱ 12,345.00').amount, 12345);
  assert.equal(p('Amount 1,210.00').amount, 1210);
  assert.equal(p('Total Amount ₱400.00').amount, 400);
  assert.equal(p('Amount Due 500.00\nAmount 210.00').amount, 210, 'Amount Due is not the paid amount');
  assert.equal(p('You have received P 99.50 from X').amount, 99.5);
  assert.equal(p('Total Amount Sent ₱2O0.00').amount, 200, 'O inside the amount');
  // GCash always prints centavos; without them the parser prefers nothing to a guess
  assert.equal(p('Total Amount Sent ₱210').amount, null);
  assert.equal(p('Amount 0.00').amount, null, 'zero');
  assert.equal(p('Amount 12345678.00').amount, null, 'absurdly large');
  assert.equal(p('Amount 210.0').amount, null, 'one decimal');
});

test('dates', () => {
  assert.equal(p('Oct 28, 2026 6:22 PM').dateText, 'Oct 28, 2026 6:22 PM');
  assert.equal(p('October 28 2026, 6:22PM').dateText, 'October 28 2026, 6:22PM');
  assert.equal(p('Sept 3, 2026').dateText, 'Sept 3, 2026');
  assert.equal(p('no date here').dateText, '');
});

test('empty, garbage and non-string input never throw', () => {
  const empty = { ref: '', amount: null, dateText: '' };
  for (const x of ['', '   ', '\n\n', '@@@###', '���', 'Ref No.', 'Amount', null, undefined, 0, NaN, {}, [], true, () => 1, Symbol('s'), 10n]) {
    let r;
    assert.doesNotThrow(() => (r = p(x)), String(typeof x));
    assert.deepEqual(Object.keys(r).sort(), ['amount', 'dateText', 'ref']);
    assert.equal(typeof r.ref, 'string');
    if (typeof x === 'string') assert.deepEqual(r, empty, JSON.stringify(x));
  }
  // a number is turned into its text; a 13-digit number reads as a loose reference (harmless, still a string)
  assert.equal(p(5046627354816).ref, REF);
});

test('very long input (200 kB) returns quickly for typical shapes', () => {
  const big = 200_000;
  const shapes = {
    spaces: ' '.repeat(big),
    letters: 'a'.repeat(big),
    digits: '7'.repeat(big),
    labels: 'Ref No. '.repeat(big / 8),
    amounts: 'Amount '.repeat(big / 7),
    amountLines: '\nAmount '.repeat(big / 8),
    totals: 'Total Amount Sent '.repeat(big / 18),
    months: 'Jan '.repeat(big / 4),
    refs: `${REF} `.repeat(big / 14),
    receiptThenAds: expressSend() + '\nAd text with words. '.repeat(big / 21),
    receiptAfterBlank: '\n'.repeat(20_000) + expressSend(),
  };
  for (const [name, text] of Object.entries(shapes)) {
    const t0 = performance.now();
    const r = p(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${name} took ${ms.toFixed(0)} ms`);
    assert.equal(typeof r.ref, 'string');
  }
  assert.equal(p(shapes.receiptThenAds).ref, REF);
  assert.equal(p(shapes.receiptAfterBlank).amount, 210);
});

// Regression: the Amount-line regex used `\s*` and was quadratic on long runs of blank lines (200 kB of "\n" took ~28 s).
test('long runs of blank lines and whitespace return quickly', () => {
  for (const [name, text] of Object.entries({
    newlines: '\n'.repeat(200_000),
    crlf: '\r\n'.repeat(100_000),
    tabsAndNewlines: '\t\n'.repeat(100_000),
    spaceNewline: ' \n'.repeat(100_000),
    refThenBlank: `Ref No. ${REF}\n${'\n \n'.repeat(60_000)}`,
  })) {
    const t0 = performance.now();
    const r = p(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${name} took ${ms.toFixed(0)} ms`);
    assert.equal(r.amount, null);
  }
});

test('amountText formats a positive amount for the X-Receipt-Amount header, else empty', () => {
  assert.equal(amountText(210), '210.00');
  assert.equal(amountText(210.5), '210.50');
  assert.equal(amountText(1210), '1210.00', 'no thousands comma (the server rejects commas)');
  for (const bad of [0, -1, NaN, Infinity, -Infinity, '210', null, undefined, {}, true]) {
    assert.equal(amountText(bad), '', String(bad));
  }
  // what the parser gives always round-trips into a header the server accepts
  assert.match(amountText(p(expressSend()).amount), /^\d{1,7}\.\d{2}$/);
});
