import crypto from 'node:crypto';

// guard.js stops the server before this point when the password is missing, default or short, unless it runs with --dev
// (where it only warns). The "changeme" fallback is therefore only ever reachable in --dev.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() ? process.env.ADMIN_PASSWORD : 'changeme';
// Without a fixed secret, tokens are signed with a random key and admins are logged out on restart.
const SECRET = process.env.ADMIN_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_HOURS = 12;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function checkPassword(pw) {
  return typeof pw === 'string' && safeEqual(pw, ADMIN_PASSWORD);
}

export function issueToken() {
  const payload = b64url(JSON.stringify({ role: 'admin', exp: Date.now() + TOKEN_TTL_HOURS * 3600_000 }));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!safeEqual(sig, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.role === 'admin' && data.exp > Date.now();
  } catch {
    return false;
  }
}

export function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!verifyToken(token)) return res.status(401).json({ error: 'Your session has ended. Log in again.' });
  next();
}

// Simple in-memory throttle for login attempts (per IP).
const attempts = new Map();
export function loginThrottle(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, first: now };
  if (now - entry.first > 15 * 60_000) {
    entry.count = 0;
    entry.first = now;
  }
  if (entry.count >= 10) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  entry.count += 1;
  attempts.set(key, entry);
  res.on('finish', () => {
    if (res.statusCode === 200) attempts.delete(key);
  });
  next();
}
