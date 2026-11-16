// A tiny fake SMTP server for tests (same pattern as the one in tests/gcash-payments.test.js), plus a parser that turns
// what it received into { to, subject, text, ... } so tests can read non-ASCII subjects and bodies. Nothing leaves the
// machine: it only listens on 127.0.0.1.
//
// `mode` can be changed at any time and applies to the next connection:
//   'ok'           accept everything
//   'reject-auth'  answer 535 to AUTH (wrong password)
//   'reject-rcpt'  answer 550 to RCPT TO (the server refuses the recipient)
//   'drop'         close the connection as soon as it opens
import net from 'node:net';

const utf8 = (latin1) => Buffer.from(latin1, 'latin1').toString('utf8');
const qp = (s) => s.replace(/=\r\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/** Decodes RFC 2047 encoded words in one (already unfolded) header value. */
function decodeHeader(value) {
  const bytes = value
    .replace(/(\?=)[ \t]+(?==\?)/g, '$1')
    .replace(/=\?[^?]+\?([bqBQ])\?([^?]*)\?=/g, (_, enc, body) =>
      enc.toUpperCase() === 'B' ? Buffer.from(body, 'base64').toString('latin1') : qp(body.replace(/_/g, ' '))
    );
  return utf8(bytes);
}

const address = (line) => (/<([^>]*)>/.exec(line)?.[1] ?? line).trim();

/** One received message: the envelope plus decoded headers and the decoded text body. */
export function parseMessage(m) {
  const raw = m.data.replace(/\r\n\.\./g, '\r\n.');
  const split = raw.indexOf('\r\n\r\n');
  const head = split === -1 ? raw : raw.slice(0, split);
  const bodyRaw = split === -1 ? '' : raw.slice(split + 4);
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = decodeHeader(line.slice(i + 1).trim());
  }
  const encoding = (headers['content-transfer-encoding'] || '7bit').toLowerCase();
  const text =
    encoding === 'base64'
      ? Buffer.from(bodyRaw, 'base64').toString('utf8')
      : encoding === 'quoted-printable'
        ? utf8(qp(bodyRaw))
        : utf8(bodyRaw);
  return {
    to: m.to.map(address),
    from: address(m.from),
    headers,
    subject: headers.subject || '',
    text: text.replace(/\r\n/g, '\n').replace(/\n+$/, ''),
    raw,
  };
}

export function startFakeSmtp() {
  const received = []; // can be cleared by tests
  const everything = []; // every message of the whole run, never cleared
  const sockets = new Set();
  const state = { mode: 'ok', connections: 0 };
  const server = net.createServer((sock) => {
    sockets.add(sock);
    state.connections += 1;
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    const mode = state.mode;
    if (mode === 'drop') return sock.destroy();
    let buf = '';
    let inData = false;
    let authLine = false;
    let msg = { from: '', to: [], data: '' };
    const authAnswer = () => (mode === 'reject-auth' ? '535 5.7.8 Username and Password not accepted\r\n' : '235 ok\r\n');
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
          everything.push(msg);
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
          sock.write(authAnswer());
        } else if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (up.startsWith('AUTH PLAIN')) {
          if (line.length > 11) sock.write(authAnswer());
          else {
            authLine = true;
            sock.write('334 \r\n');
          }
        } else if (up.startsWith('MAIL FROM')) {
          msg.from = line;
          sock.write('250 ok\r\n');
        } else if (up.startsWith('RCPT TO')) {
          if (mode === 'reject-rcpt') sock.write('550 5.1.1 no such user\r\n');
          else {
            msg.to.push(line);
            sock.write('250 ok\r\n');
          }
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
        get mode() {
          return state.mode;
        },
        set mode(v) {
          state.mode = v;
        },
        get connections() {
          return state.connections;
        },
        /** Parsed messages currently in the inbox, optionally only those sent to one address. */
        messages: (to) => received.map(parseMessage).filter((m) => !to || m.to.includes(to)),
        /** Parsed messages of the whole run, including the ones removed by clear(). */
        all: () => everything.map(parseMessage),
        clear: () => received.splice(0, received.length),
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      })
    );
  });
}

export async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
