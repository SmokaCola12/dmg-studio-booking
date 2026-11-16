import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer, TEMPLATES } from '../backend/lib/mailer.js';

// In-process tests of backend/lib/mailer.js with an injected fake transport. No network, no real SMTP settings.

const data = {
  name: 'Tess Tester', code: 'BK-TEST234', room: 'Room A', when: 'Sat, Dec 5, 2:00 PM to 4:00 PM',
  amount: 400, balanceDue: 400, holdMinutes: 30, siteUrl: '',
};
const ADDRESS = 'fan.of.bands@example.test';

function fakeTransport(fail = false) {
  const sent = [];
  return {
    sent,
    async sendMail(msg) {
      if (fail) throw Object.assign(new Error(`SMTP refused ${msg.to}`), { code: 'EAUTH' });
      sent.push(msg);
    },
  };
}

test('without SMTP settings and no transport, send is skipped and does nothing', async () => {
  const m = createMailer({ env: {} });
  assert.equal(m.enabled, false);
  assert.deepEqual(await m.send('confirmed', ADDRESS, data), { skipped: true });
  const half = createMailer({ env: { SMTP_USER: 'someone@example.test' } });
  assert.equal(half.enabled, false, 'password missing');
  assert.deepEqual(await half.send('confirmed', ADDRESS, data), { skipped: true });
});

test('an empty recipient or an unknown template is skipped even with a transport', async () => {
  const transport = fakeTransport();
  const m = createMailer({ env: {}, transport });
  assert.equal(m.enabled, true);
  assert.deepEqual(await m.send('confirmed', '', data), { skipped: true });
  assert.deepEqual(await m.send('nope', ADDRESS, data), { skipped: true });
  assert.equal(transport.sent.length, 0);
});

test('the three templates reach the right recipient with booking details', async () => {
  const transport = fakeTransport();
  const m = createMailer({ env: { MAIL_FROM: 'studio@example.test' }, transport });
  for (const t of ['confirmed', 'notReceived', 'holdExpired']) {
    assert.deepEqual(await m.send(t, ADDRESS, data), { sent: true });
  }
  assert.equal(transport.sent.length, 3);
  for (const msg of transport.sent) {
    assert.equal(msg.to, ADDRESS);
    assert.equal(msg.from, 'studio@example.test');
    assert.ok(msg.subject.includes('BK-TEST234'));
    assert.ok(msg.text.includes('Tess Tester'));
    assert.ok(msg.text.includes('Room A'));
  }
  const [confirmed, notReceived, expired] = transport.sent;
  assert.match(confirmed.subject, /confirmed/i);
  assert.match(confirmed.text, /PHP 400/);
  assert.match(confirmed.text, /Balance of PHP 400/);
  assert.match(notReceived.subject, /not received/i);
  assert.match(expired.subject, /released/i);
  assert.match(expired.text, /30 minutes/);
});

test('confirmed email has no balance line when nothing is due, and links to the site when configured', () => {
  const paid = TEMPLATES.confirmed({ ...data, balanceDue: 0 });
  assert.ok(!paid.text.includes('Balance of'));
  const linked = TEMPLATES.confirmed({ ...data, siteUrl: 'https://studio.example.test' });
  assert.ok(linked.text.includes('https://studio.example.test/check'));
});

test('a throwing transport resolves, reports failure and logs no address', async () => {
  const lines = [];
  const original = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const m = createMailer({ env: { SMTP_USER: 'u@example.test', SMTP_PASS: 'secret-pass' }, transport: fakeTransport(true) });
    const result = await m.send('confirmed', ADDRESS, data);
    assert.deepEqual(result, { sent: false, failed: true });
  } finally {
    console.error = original;
  }
  assert.ok(lines.length >= 1, 'a failure line was logged');
  const log = lines.join('\n');
  assert.ok(!log.includes(ADDRESS), 'recipient address not logged');
  assert.ok(!log.includes('example.test'), 'no address fragment logged');
  assert.ok(!log.includes('secret-pass'), 'no credentials logged');
  assert.ok(!log.includes('Tess'), 'no customer name logged');
});

test('a transport that throws synchronously also resolves', async () => {
  const m = createMailer({ env: {}, transport: { sendMail() { throw new Error('boom'); } } });
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await m.send('holdExpired', ADDRESS, data), { sent: false, failed: true });
  } finally {
    console.error = original;
  }
});
