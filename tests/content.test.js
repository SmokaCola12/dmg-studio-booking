import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolation.js';

// The real server (backend/index.js) runs as a child process against a throwaway
// database and upload folder, because /media and the error handler live in index.js.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-content-'));
const uploadDir = path.join(tmp, 'uploads');
const PASSWORD = 'test-password-content';

let child;
let port;
let base;
let token;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'backend', 'index.js')], {
    cwd: root,
    // All app variables pinned (tests/helpers/isolation.js): RECEIPT_DIR in the temp folder (never data/private/receipts),
    // SMTP to a closed local port with no credentials, blanks for the rest so the real .env cannot fill anything in.
    env: isolatedEnv(tmp, {
      PORT: String(port),
      DB_PATH: path.join(tmp, 'test.db'),
      UPLOAD_DIR: uploadDir,
      RECEIPT_DIR: path.join(tmp, 'receipts'),
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      ADMIN_PASSWORD: PASSWORD,
      ADMIN_TOKEN_SECRET: 'test-secret-content',
    }),
    stdio: 'ignore',
  });
  process.on('exit', () => child.kill());
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/site`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  token = (await res.json()).token;
  assert.ok(token, 'could not log in to the test server');
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  await new Promise((r) => setTimeout(r, 200));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
});

const galleryDir = path.join(uploadDir, 'gallery');

async function api(method, url, body, { auth = true } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body: json };
}

async function upload(bytes, type, { alt, auth = true } = {}) {
  const headers = { 'content-type': type };
  if (auth) headers.authorization = `Bearer ${token}`;
  const q = alt === undefined ? '' : `?alt=${encodeURIComponent(alt)}`;
  const res = await fetch(`${base}/api/admin/gallery${q}`, { method: 'POST', headers, body: bytes });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body: json };
}

// Minimal valid-looking images: only the magic bytes matter to the server.
const pad = (head, n = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(n)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);
const GIF = pad(Buffer.from('GIF89a'));
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function clearGallery() {
  const { body } = await api('GET', '/admin/content');
  for (const p of body.gallery) await api('DELETE', `/admin/gallery/${p.id}`);
}

const NULL_CONTACT = {
  address: null,
  landmark: null,
  mapsQuery: null,
  phone: null,
  email: null,
  messenger: null,
  socials: null,
};

beforeEach(async () => {
  await clearGallery();
  await api('PUT', '/admin/content/contact', {
    address: '',
    landmark: '',
    mapsQuery: '',
    phone: '',
    email: '',
    messenger: '',
    socials: null,
  });
});

// ---------- auth ----------

test('every new admin route returns 401 without a token', async () => {
  const routes = [
    ['GET', '/admin/content'],
    ['PUT', '/admin/content/contact', {}],
    ['PUT', '/admin/gallery/order', { ids: [] }],
    ['PATCH', '/admin/gallery/1', { alt: 'x' }],
    ['DELETE', '/admin/gallery/1'],
  ];
  for (const [m, u, b] of routes) {
    const r = await api(m, u, b, { auth: false });
    assert.equal(r.status, 401, `${m} ${u}`);
  }
  assert.equal((await upload(JPEG, 'image/jpeg', { auth: false })).status, 401);
});

test('admin routes reject a bad token', async () => {
  const res = await fetch(`${base}/api/admin/content`, { headers: { authorization: 'Bearer nope.nope' } });
  assert.equal(res.status, 401);
  const up = await fetch(`${base}/api/admin/gallery`, {
    method: 'POST',
    headers: { authorization: 'Bearer nope.nope', 'content-type': 'image/jpeg' },
    body: JPEG,
  });
  assert.equal(up.status, 401);
});

// ---------- contact validation ----------

test('contact: rejects http: and javascript: links', async () => {
  for (const href of ['http://m.me/dmg', 'javascript:alert(1)', 'ftp://m.me/dmg', 'not a url']) {
    const r = await api('PUT', '/admin/content/contact', { messenger: href });
    assert.equal(r.status, 400, href);
    assert.ok(r.body.fields.messenger, href);
  }
  for (const href of ['http://example.com', 'javascript:alert(1)']) {
    const r = await api('PUT', '/admin/content/contact', { socials: [{ label: 'X', href }] });
    assert.equal(r.status, 400, href);
    assert.ok(r.body.fields.socials, href);
  }
});

test('contact: rejects bad email and bad phone', async () => {
  for (const email of ['nope', 'a@b', 'a b@c.com', 123]) {
    const r = await api('PUT', '/admin/content/contact', { email });
    assert.equal(r.status, 400, String(email));
    assert.ok(r.body.fields.email);
  }
  for (const phone of ['abc', '12', '0917<script>', '09'.repeat(20), 12345678]) {
    const r = await api('PUT', '/admin/content/contact', { phone });
    assert.equal(r.status, 400, String(phone));
    assert.ok(r.body.fields.phone);
  }
});

test('contact: rejects lookalike Messenger hosts', async () => {
  for (const href of [
    'https://m.me.evil.com/x',
    'https://evilm.me/x',
    'https://facebook.com.evil.com/x',
    'https://notfacebook.com/x',
    'https://evil.com/m.me',
    'https://m.me@evil.com/x',
  ]) {
    const r = await api('PUT', '/admin/content/contact', { messenger: href });
    assert.equal(r.status, 400, href);
  }
});

test('contact: accepts real Messenger hosts', async () => {
  for (const href of ['https://m.me/dmgstudio', 'https://www.messenger.com/t/dmg', 'https://www.facebook.com/dmg']) {
    const r = await api('PUT', '/admin/content/contact', { messenger: href });
    assert.equal(r.status, 200, href);
    assert.equal(r.body.contact.messenger, href);
  }
});

test('contact: rejects 4 address lines, accepts 3', async () => {
  const bad = await api('PUT', '/admin/content/contact', { address: ['a', 'b', 'c', 'd'] });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.address);
  const long = await api('PUT', '/admin/content/contact', { address: ['x'.repeat(121)] });
  assert.equal(long.status, 400);
  const ok = await api('PUT', '/admin/content/contact', { address: ['a', 'b', 'c'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.contact.address, ['a', 'b', 'c']);
});

test('contact: rejects more than 6 socials and long labels', async () => {
  const s = (n) => Array.from({ length: n }, (_, i) => ({ label: `S${i}`, href: 'https://example.com/x' }));
  assert.equal((await api('PUT', '/admin/content/contact', { socials: s(7) })).status, 400);
  assert.equal((await api('PUT', '/admin/content/contact', { socials: s(6) })).status, 200);
  const r = await api('PUT', '/admin/content/contact', { socials: [{ label: 'x'.repeat(31), href: 'https://example.com' }] });
  assert.equal(r.status, 400);
});

test('contact: bad JSON returns 400', async () => {
  const res = await fetch(`${base}/api/admin/content/contact`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{"phone": ',
  });
  assert.equal(res.status, 400);
});

// ---------- GET /api/site ----------

test('GET /api/site has contact nulls when nothing is set', async () => {
  const res = await fetch(`${base}/api/site`);
  const body = await res.json();
  assert.deepEqual(body.content.contact, NULL_CONTACT);
  assert.deepEqual(body.content.gallery, []);
});

test('GET /api/site reflects a saved value, and empty string resets it', async () => {
  const put = await api('PUT', '/admin/content/contact', { phone: ' 0917 123 4567 ', landmark: 'Beside the bakery' });
  assert.equal(put.status, 200);
  assert.equal(put.body.contact.phone, '0917 123 4567');

  let site = await (await fetch(`${base}/api/site`)).json();
  assert.equal(site.content.contact.phone, '0917 123 4567');
  assert.equal(site.content.contact.landmark, 'Beside the bakery');
  assert.equal(site.content.contact.email, null);

  const reset = await api('PUT', '/admin/content/contact', { phone: '' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.contact.phone, null);
  site = await (await fetch(`${base}/api/site`)).json();
  assert.equal(site.content.contact.phone, null);
  assert.equal(site.content.contact.landmark, 'Beside the bakery', 'untouched fields stay');
});

test('partial PUT leaves other fields alone; empty address list resets', async () => {
  await api('PUT', '/admin/content/contact', { address: ['1 Main St'], email: 'hi@example.com' });
  await api('PUT', '/admin/content/contact', { email: 'new@example.com' });
  let { body } = await api('GET', '/admin/content');
  assert.deepEqual(body.contact.address, ['1 Main St']);
  assert.equal(body.contact.email, 'new@example.com');
  await api('PUT', '/admin/content/contact', { address: [] });
  ({ body } = await api('GET', '/admin/content'));
  assert.equal(body.contact.address, null);
});

// ---------- gallery upload ----------

test('upload: JPEG, PNG and WebP are accepted and served', async () => {
  for (const [bytes, type, ext] of [
    [JPEG, 'image/jpeg', '.jpg'],
    [PNG, 'image/png', '.png'],
    [WEBP, 'image/webp', '.webp'],
  ]) {
    const r = await upload(bytes, type, { alt: 'Drum kit' });
    assert.equal(r.status, 201, type);
    assert.equal(r.body.photo.alt, 'Drum kit');
    assert.match(r.body.photo.src, new RegExp(`^/media/gallery/[0-9a-f-]{36}\\${ext}$`));
    const file = await fetch(`${base}${r.body.photo.src}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  }
  const { body } = await api('GET', '/admin/content');
  assert.equal(body.gallery.length, 3);
});

test('upload: SVG, GIF and wrong content type return 415', async () => {
  assert.equal((await upload(SVG, 'image/svg+xml')).status, 415);
  assert.equal((await upload(GIF, 'image/gif')).status, 415);
  assert.equal((await upload(SVG, 'image/png')).status, 415);
  assert.equal((await upload(GIF, 'image/jpeg')).status, 415);
  assert.equal((await upload(Buffer.from('just some text, not an image at all'), 'image/png')).status, 415);
  assert.equal((await upload(Buffer.alloc(0), 'image/png')).status, 415);
  assert.equal((await upload(Buffer.from('plain'), 'text/plain')).status, 415);
  assert.equal(fs.readdirSync(galleryDir).length, 0, 'nothing written for rejected uploads');
});

test('upload: over 5 MB returns 413', async () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
  const r = await upload(big, 'image/jpeg');
  assert.equal(r.status, 413);
  assert.equal(fs.readdirSync(galleryDir).length, 0);
});

test('upload: alt over 160 characters returns 400', async () => {
  const r = await upload(JPEG, 'image/jpeg', { alt: 'x'.repeat(161) });
  assert.equal(r.status, 400);
});

test('upload: the 25th photo returns 409', async () => {
  for (let i = 0; i < 24; i++) {
    const r = await upload(JPEG, 'image/jpeg', { alt: `p${i}` });
    assert.equal(r.status, 201, `photo ${i}`);
  }
  const over = await upload(JPEG, 'image/jpeg');
  assert.equal(over.status, 409);
  assert.equal(fs.readdirSync(galleryDir).length, 24);
});

// ---------- order, patch, delete ----------

test('order: reorders, and rejects a mismatched id set', async () => {
  const ids = [];
  for (const alt of ['a', 'b', 'c']) ids.push((await upload(JPEG, 'image/jpeg', { alt })).body.photo.id);

  const ok = await api('PUT', '/admin/gallery/order', { ids: [ids[2], ids[0], ids[1]] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.gallery.map((p) => p.alt), ['c', 'a', 'b']);
  const site = await (await fetch(`${base}/api/site`)).json();
  assert.deepEqual(site.content.gallery.map((p) => p.alt), ['c', 'a', 'b']);

  const before = (await api('GET', '/admin/content')).body.gallery.map((p) => p.id);
  for (const bad of [
    [ids[0], ids[1]], // missing one
    [...ids, 99999], // extra
    [ids[0], ids[0], ids[1]], // duplicate
    [ids[0], ids[1], 99999], // unknown
    [String(ids[0]), ids[1], ids[2]], // wrong type
    'nope',
  ]) {
    const r = await api('PUT', '/admin/gallery/order', { ids: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await api('PUT', '/admin/gallery/order', {})).status, 400);
  const after = (await api('GET', '/admin/content')).body.gallery.map((p) => p.id);
  assert.deepEqual(after, before, 'order unchanged after rejected requests');
});

test('patch: edits alt, rejects long alt, 404 for unknown id', async () => {
  const { photo } = (await upload(JPEG, 'image/jpeg', { alt: 'old' })).body;
  const ok = await api('PATCH', `/admin/gallery/${photo.id}`, { alt: '  new  ' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.photo.alt, 'new');
  assert.equal((await api('PATCH', `/admin/gallery/${photo.id}`, { alt: 'x'.repeat(161) })).status, 400);
  assert.equal((await api('PATCH', `/admin/gallery/${photo.id}`, { alt: 5 })).status, 400);
  assert.equal((await api('PATCH', '/admin/gallery/99999', { alt: 'x' })).status, 404);
});

test('delete: removes the row and the file from UPLOAD_DIR', async () => {
  const { photo } = (await upload(PNG, 'image/png')).body;
  const onDisk = path.join(uploadDir, photo.src.replace(/^\/media\//, ''));
  assert.ok(fs.existsSync(onDisk), 'file exists after upload');
  const r = await api('DELETE', `/admin/gallery/${photo.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.ok(!fs.existsSync(onDisk), 'file removed');
  assert.equal((await fetch(`${base}${photo.src}`)).status, 404);
  assert.equal((await api('DELETE', `/admin/gallery/${photo.id}`)).status, 404);
  const { body } = await api('GET', '/admin/content');
  assert.equal(body.gallery.length, 0);
});

// ---------- /media traversal ----------

// Raw request so the client does not normalise "../" out of the path.
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('/media path traversal returns 404 and never leaks the database', async () => {
  const paths = [
    '/media/../test.db',
    '/media/gallery/../../test.db',
    '/media/%2e%2e/test.db',
    '/media/%2e%2e%2ftest.db',
    '/media/gallery/%2e%2e/%2e%2e/test.db',
    '/media/..%2f..%2fbackend%2findex.js',
    '/media/gallery/..%5c..%5ctest.db',
    '/media/%2e%2e/%2e%2e/package.json',
    '/media/gallery/%00',
    '/media/.hidden',
  ];
  for (const p of paths) {
    const r = await rawGet(p);
    assert.equal(r.status, 404, `${p} gave ${r.status}`);
    assert.ok(!r.body.toString('latin1').startsWith('SQLite format 3'), `${p} leaked the database`);
  }
});

test('/media missing file returns 404', async () => {
  assert.equal((await rawGet('/media/gallery/does-not-exist.jpg')).status, 404);
});

test('/media serves only the gallery folder, not the rest of UPLOAD_DIR', async () => {
  fs.writeFileSync(path.join(uploadDir, 'secret.txt'), 'top secret');
  for (const p of ['/media/secret.txt', '/media/gallery/../secret.txt', '/media/gallery%2f..%2fsecret.txt']) {
    const r = await rawGet(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.toString().includes('top secret'), p);
  }
});

// ---------- review fixes ----------

test('413 message: photo wording only for the gallery upload', async () => {
  const big = await api('PUT', '/admin/content/contact', { landmark: 'x'.repeat(150 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(big.body.error, 'The request is too large.');
  const photo = await upload(Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]), 'image/jpeg');
  assert.equal(photo.status, 413);
  assert.match(photo.body.error, /5 MB/);
});

test('socials: [], "" and null all reset to default', async () => {
  for (const empty of [[], '', null]) {
    await api('PUT', '/admin/content/contact', { socials: [{ label: 'IG', href: 'https://example.com/x' }] });
    const r = await api('PUT', '/admin/content/contact', { socials: empty });
    assert.equal(r.status, 200, JSON.stringify(empty));
    assert.equal(r.body.contact.socials, null, JSON.stringify(empty));
  }
});

test('contact: control characters in address, landmark and mapsQuery return 400', async () => {
  for (const [field, value] of [
    ['address', ['1 Main St\nInjected']],
    ['address', ['ok', 'bad\u0000']],
    ['landmark', 'near\tthe bakery'],
    ['landmark', 'bell\x07'],
    ['mapsQuery', 'dmg\r\nstudio'],
    ['mapsQuery', 'del\x7f'],
  ]) {
    const r = await api('PUT', '/admin/content/contact', { [field]: value });
    assert.equal(r.status, 400, `${field} ${JSON.stringify(value)}`);
    assert.ok(r.body.fields[field]);
  }
});

test('delete: a file that cannot be removed still returns ok', async () => {
  const { photo } = (await upload(PNG, 'image/png')).body;
  const onDisk = path.join(uploadDir, photo.src.replace(/^\/media\//, ''));
  fs.rmSync(onDisk);
  fs.mkdirSync(onDisk);
  fs.writeFileSync(path.join(onDisk, 'stuck'), 'x'); // rmSync on a non-empty dir throws
  const r = await api('DELETE', `/admin/gallery/${photo.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal((await api('GET', '/admin/content')).body.gallery.length, 0);
  fs.rmSync(onDisk, { recursive: true, force: true });
});
