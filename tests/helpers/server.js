// Child-server helper for tests that need the real API. Same pattern as tests/gcash-payments.test.js:
// backend/index.js runs as a child process on a free port (never 4000) against throwaway DB_PATH, UPLOAD_DIR and
// RECEIPT_DIR folders under a temp folder. SMTP_HOST=127.0.0.1 and SMTP_PORT=1 are pinned so no test can send mail
// even if a developer .env holds credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { buildQr } from './qr.js';
import { isolatedEnv } from './isolation.js';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PASSWORD = 'test-password-hints';
export const PHONE = '09171234567';
export const PAYLOAD = buildQr();

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

/** A temp folder plus a registry of child servers, cleaned up by `cleanup()`. */
export function testEnv(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const servers = [];
  process.on('exit', () => servers.forEach((x) => x.kill?.()));

  async function startServer(name, opts) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await startServerOnce(name, opts);
      } catch (err) {
        if (attempt >= 3 || !/did not start/.test(String(err.message))) throw err;
      }
    }
  }

  // `entry` is the script to run (default backend/index.js); a test can pass a small wrapper that swaps something in first.
  async function startServerOnce(name, { env: extraEnv = {}, dbPath, qr = true, entry = path.join(root, 'backend', 'index.js') } = {}) {
    let port = await freePort();
    while (port === 4000) port = await freePort(); // the owner's server lives on 4000
    const base = `http://127.0.0.1:${port}`;
    dbPath ||= path.join(tmp, `${name}.db`);
    const uploadDir = path.join(tmp, `${name}-uploads`);
    const receiptDir = path.join(tmp, `${name}-receipts`);
    // Every app variable is pinned (tests/helpers/isolation.js): temp data paths, mail to a closed local port with no
    // credentials unless a test passes its own, blanks for the rest (a blank blocks the .env value; `undefined` in
    // extraEnv means "default" and is pinned blank too). Throws if DB_PATH, UPLOAD_DIR or RECEIPT_DIR is not a temp path.
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
    const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push({ kill: () => child.kill() });
    const logLines = [];
    child.stdout.on('data', (d) => logLines.push(String(d)));
    child.stderr.on('data', (d) => logLines.push(String(d)));
    let up = false;
    for (let i = 0; i < 150 && !up && child.exitCode === null; i++) {
      try {
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
    async function api(method, url, body, { auth = false } = {}) {
      const headers = {};
      if (auth) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${base}/api${url}`, {
        signal: AbortSignal.timeout(30_000),
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return read(res);
    }
    /** Customer screenshot upload. `ref` is the typed X-Payment-Ref; `ocrRef`/`ocrAmount` are the OCR hint headers. */
    async function upload(code, phone, buf, { type = 'image/png', ref, ocrRef, ocrAmount, headers = {} } = {}) {
      const h = { 'content-type': type, ...headers };
      if (code !== null) h['x-booking-code'] = code;
      if (phone !== null) h['x-booking-phone'] = phone;
      if (ref !== undefined) h['x-payment-ref'] = ref;
      if (ocrRef !== undefined) h['x-receipt-ref'] = ocrRef;
      if (ocrAmount !== undefined) h['x-receipt-amount'] = ocrAmount;
      return read(await fetch(`${base}/api/bookings/payment-proof`, { method: 'POST', headers: h, body: buf, signal: AbortSignal.timeout(30_000) }));
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
      name, base, token, dbPath, uploadDir, receiptDir, api, upload, stop,
      kill: () => child.kill(),
      admin: (m, u, b) => api(m, `/admin${u}`, b, { auth: true }),
      logs: () => logLines.join(''),
    };
    servers.push(srv);
    if (qr) assert.equal((await srv.admin('PUT', '/settings/gcash-qr', { payload: PAYLOAD })).status, 200);
    return srv;
  }

  async function cleanup() {
    await Promise.all(servers.map((x) => (x.stop ? x.stop() : Promise.resolve(x.kill())).catch(() => {})));
    await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }

  return { tmp, startServer, cleanup };
}

export function manilaToday() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const withDb = (file, fn) => {
  const d = new Database(file);
  try {
    return fn(d);
  } finally {
    d.close();
  }
};
