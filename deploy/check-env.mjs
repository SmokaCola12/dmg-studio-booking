// npm run check:env
// Pre-deployment checklist. Loads .env exactly like the server (backend/env.js) and reports PASS / WARN / FAIL for each
// setting BY NAME ONLY: no value from .env is ever printed. Changes nothing. Exit code 1 when anything FAILs.
import '../backend/env.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { adminPasswordProblem, tokenSecretProblem } from '../backend/lib/startup-checks.js';
import { repoRoot, distDir, dataPaths, receiptDirProblem, backupDirProblem, find7z } from './lib.mjs';

const env = process.env;
const counts = { PASS: 0, WARN: 0, FAIL: 0 };
function report(level, name, note) {
  counts[level] += 1;
  console.log(`${level}  ${name.padEnd(20)} ${note}`);
}
const pass = (name, note) => report('PASS', name, note);
const warn = (name, note) => report('WARN', name, note);
const fail = (name, note) => report('FAIL', name, note);
const isSet = (name) => typeof env[name] === 'string' && env[name].trim() !== '';
// The checks say what is wrong without the "NAME is" prefix, since the name is already in its own column.
const reason = (problem, name) => problem.replace(`${name} is `, '');

function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

console.log('DMG Studio: environment check (names only, values are never shown)\n');

// ---------- Node and .env ----------
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 20 || (major === 20 && minor >= 12)) pass('Node.js', 'version is 20.12 or newer');
else fail('Node.js', 'version 20.12 or newer is required');

if (fs.existsSync(path.join(repoRoot, '.env'))) pass('.env', 'found');
else warn('.env', 'no .env file in the project folder: only variables already set in this shell are checked');

// ---------- Admin login ----------
const pwProblem = adminPasswordProblem(env.ADMIN_PASSWORD);
if (pwProblem) fail('ADMIN_PASSWORD', `${reason(pwProblem, 'ADMIN_PASSWORD')}: the server will not start`);
else pass('ADMIN_PASSWORD', 'set, not a default, long enough');

const secretProblem = tokenSecretProblem(env.ADMIN_TOKEN_SECRET);
if (secretProblem) warn('ADMIN_TOKEN_SECRET', `${reason(secretProblem, 'ADMIN_TOKEN_SECRET')}: staff are logged out on every restart, or sessions are easy to forge`);
else pass('ADMIN_TOKEN_SECRET', 'set, 32 characters or more');

// ---------- Email ----------
const hasUser = isSet('SMTP_USER');
const hasPass = isSet('SMTP_PASS');
if (hasUser && hasPass) {
  pass('SMTP_USER', 'set');
  pass('SMTP_PASS', 'set');
} else if (!hasUser && !hasPass) {
  warn('SMTP_USER', 'not set: emails are off');
  warn('SMTP_PASS', 'not set: emails are off');
} else {
  (hasUser ? pass : fail)('SMTP_USER', hasUser ? 'set' : 'not set, but SMTP_PASS is: set both or neither (emails are off)');
  (hasPass ? pass : fail)('SMTP_PASS', hasPass ? 'set' : 'not set, but SMTP_USER is: set both or neither (emails are off)');
}
if (isSet('SMTP_PORT') && !(Number.isInteger(Number(env.SMTP_PORT)) && Number(env.SMTP_PORT) > 0 && Number(env.SMTP_PORT) < 65536)) {
  fail('SMTP_PORT', 'not a valid port number');
}
pass('MAIL_FROM', isSet('MAIL_FROM') ? 'set' : 'not set (optional: SMTP_USER is used as the sender)');

// ---------- Site address ----------
if (!isSet('PUBLIC_SITE_URL')) {
  warn('PUBLIC_SITE_URL', 'not set: emails carry no link to My booking or the admin page');
} else {
  const raw = env.PUBLIC_SITE_URL;
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    /* not a URL */
  }
  if (!url || !['http:', 'https:'].includes(url.protocol)) fail('PUBLIC_SITE_URL', 'not a valid web address (expected https://...)');
  else if (raw !== raw.trim() || raw.endsWith('/')) fail('PUBLIC_SITE_URL', 'must not end with a slash or have spaces around it');
  else if (url.search || url.hash) fail('PUBLIC_SITE_URL', 'must be a plain address without ? or #');
  else if (url.protocol !== 'https:') warn('PUBLIC_SITE_URL', 'set, but it is http, not https: links in emails will not be secure');
  else pass('PUBLIC_SITE_URL', 'set, https, no trailing slash');
}

// ---------- Server ----------
if (!isSet('PORT')) pass('PORT', 'not set (default 4000)');
else if (/^\d+$/.test(env.PORT.trim()) && Number(env.PORT) >= 1 && Number(env.PORT) <= 65535) pass('PORT', 'set, a valid port number');
else fail('PORT', 'not a valid port number (1 to 65535)');

if (!isSet('TRUST_PROXY')) pass('TRUST_PROXY', 'not set (default: 1 reverse proxy in front of the server)');
else if (/^\d+$/.test(env.TRUST_PROXY.trim())) pass('TRUST_PROXY', 'set, a valid number');
else fail('TRUST_PROXY', 'not a whole number (0, 1, 2 ...): the server would silently use 1');

if (isSet('STUDIO_TZ')) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: env.STUDIO_TZ });
    if (env.STUDIO_TZ === 'Asia/Manila') pass('STUDIO_TZ', 'set to the studio time zone');
    else warn('STUDIO_TZ', 'set, but not to Asia/Manila');
  } catch {
    fail('STUDIO_TZ', 'not a valid time zone name');
  }
} else {
  pass('STUDIO_TZ', 'not set (default Asia/Manila)');
}

// ---------- Data folders ----------
const paths = dataPaths(env);
function checkLocation(name, target, { isFile }) {
  if (!isSet(name)) {
    // The server creates the default folders under <repo>/data on first start, so the nearest folder that exists must be writable.
    let folder = isFile ? path.dirname(target) : target;
    while (!fs.existsSync(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder);
    if (!canWrite(folder)) return fail(name, 'not set, and the default location under the project data folder is not writable');
    return pass(name, 'not set (default location under the project data folder, writable)');
  }
  const relativeNote = paths.relative.includes(name)
    ? 'a relative path: it depends on the folder the server is started from, use a full path'
    : null;
  const parent = path.dirname(target);
  // A data folder that already exists must itself be writable; otherwise its parent must be.
  const folder = !isFile && fs.existsSync(target) ? target : parent;
  if (!fs.existsSync(folder)) {
    // A typo in DB_PATH would make the server quietly start a new, empty database, so a missing folder is a FAIL there.
    if (isFile) return fail(name, 'set, but its parent folder does not exist (a typo would start a new, empty database)');
    // The server creates the upload and receipt folders (and their parents) on start: fine if it may write there.
    let ancestor = path.dirname(folder);
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    if (!canWrite(ancestor)) return fail(name, 'set, but its parent folder does not exist and cannot be created');
    return warn(name, 'set, but its parent folder does not exist yet: the server creates it on start (check the path for typos)');
  }
  if (!canWrite(folder)) return fail(name, 'set, but its folder is not writable');
  if (relativeNote) return warn(name, `set, folder is writable, but it is ${relativeNote}`);
  return pass(name, 'set, folder exists and is writable');
}
checkLocation('DB_PATH', paths.dbPath, { isFile: true });
checkLocation('UPLOAD_DIR', paths.uploadDir, { isFile: false });
checkLocation('RECEIPT_DIR', paths.receiptDir, { isFile: false });

const privacy = receiptDirProblem(paths);
if (privacy) fail('Receipts are private', `${privacy}: the server will not start`);
else pass('Receipts are private', 'RECEIPT_DIR is outside UPLOAD_DIR and frontend/dist');

// ---------- Backups ----------
const backupProblem = backupDirProblem(paths);
if (backupProblem) fail('BACKUP_DIR', backupProblem);
else if (paths.relative.includes('BACKUP_DIR')) warn('BACKUP_DIR', 'set, but it is a relative path: use a full path');
else pass('BACKUP_DIR', isSet('BACKUP_DIR') ? 'set, outside the public folders' : 'not set (default: backups folder in the project)');

if (!env.BACKUP_PASSPHRASE) {
  warn('BACKUP_PASSPHRASE', 'not set: backups are NOT encrypted and hold customer data and receipts');
} else if (!/^[\x20-\x7e]+$/.test(env.BACKUP_PASSPHRASE)) {
  fail('BACKUP_PASSPHRASE', 'has characters outside plain keyboard letters, digits and symbols: the backup will refuse to run');
} else if (!find7z()) {
  warn('BACKUP_PASSPHRASE', 'set, but 7-Zip is not installed: backups are NOT encrypted until it is');
} else {
  pass('BACKUP_PASSPHRASE', 'set, and 7-Zip is installed');
}

// ---------- Built site ----------
if (fs.existsSync(path.join(distDir, 'index.html'))) pass('frontend/dist', 'the built site is there');
else fail('frontend/dist', 'missing: run "npm run build" (the server would answer the API only)');

const ocrDir = path.join(distDir, 'ocr');
if (fs.existsSync(ocrDir) && fs.readdirSync(ocrDir).length > 0) pass('frontend/dist/ocr', 'the receipt reader files are there');
else fail('frontend/dist/ocr', 'missing: run "npm run build" (receipt screenshots could not be read in the browser)');

// ---------- GCash QR (yes or no only; the QR itself is never read out) ----------
if (!fs.existsSync(paths.dbPath)) {
  warn('GCash QR stored', 'no database yet: it is created on the first start, then upload the QR in the admin');
} else {
  let db = null;
  try {
    db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT length(value) > 4 AS stored FROM settings WHERE key = 'gcash_qr_payload'").get();
    if (row?.stored) pass('GCash QR stored', 'yes');
    else warn('GCash QR stored', 'no: online GCash payment stays off until the QR is uploaded in the admin under Settings');
  } catch (err) {
    fail('GCash QR stored', `could not read the database (${err.code || 'error'})`);
  } finally {
    db?.close();
  }
}

console.log(`\n${counts.PASS} passed, ${counts.WARN} warning${counts.WARN === 1 ? '' : 's'}, ${counts.FAIL} failed.`);
if (counts.FAIL) console.log('Fix every FAIL before going live.');
process.exitCode = counts.FAIL ? 1 : 0;
