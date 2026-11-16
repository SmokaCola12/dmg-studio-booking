// npm run backup:verify -- <path to a backup folder, or to a studio.db file>
// Test-restore check. Opens the backup's database READ-ONLY, runs an integrity check and counts what is in it.
// Changes nothing and prints counts only (no names, numbers or file names). Exit code 1 when anything is wrong.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { formatBytes } from './lib.mjs';

function finish(ok, text) {
  console[ok ? 'log' : 'error'](`[verify] ${ok ? 'OK' : 'FAILED'}: ${text}`);
  process.exit(ok ? 0 : 1);
}

const arg = process.argv[2];
if (!arg) finish(false, 'give the path to a backup folder. Example: npm run backup:verify -- "backups\\dmg-backup-20261116-043000"');
// npm runs scripts from the project folder; INIT_CWD is the folder the command was typed in, so relative paths match it.
const target = path.resolve(process.env.INIT_CWD || process.cwd(), arg);
if (!fs.existsSync(target)) finish(false, `nothing found at ${target}`);
if (target.toLowerCase().endsWith('.7z')) {
  finish(false, 'this is an encrypted archive. Extract it first (7-Zip asks for the backup passphrase), then verify the extracted folder');
}

const isDir = fs.statSync(target).isDirectory();
const dbFile = isDir ? path.join(target, 'studio.db') : target;
const folder = isDir ? target : path.dirname(target);
if (!fs.existsSync(dbFile)) finish(false, `there is no studio.db in ${target}`);

// A database still in WAL mode cannot be opened without SQLite creating -shm / -wal files beside it. Backups made by
// `npm run backup` are never in WAL mode; refuse anything else so that this command truly changes nothing.
const header = Buffer.alloc(20);
const fd = fs.openSync(dbFile, 'r');
fs.readSync(fd, header, 0, 20, 0);
fs.closeSync(fd);
if (header.toString('latin1', 0, 15) !== 'SQLite format 3') finish(false, 'studio.db is not a SQLite database');
if (header[18] === 2 || header[19] === 2) {
  finish(false, 'this database is in WAL mode, so it is a live database or a raw file copy, not a backup made by "npm run backup"');
}

const problems = [];
const notes = [];
let manifest = null;
const manifestFile = path.join(folder, 'manifest.json');
if (fs.existsSync(manifestFile)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    problems.push('manifest.json cannot be read');
  }
} else {
  notes.push('no manifest.json beside the database, so the checksum was not compared');
}

if (manifest?.database?.sha256) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
  if (sha !== manifest.database.sha256) problems.push('the database does not match the checksum in manifest.json (the file changed after the backup)');
}

const countFiles = (dir) =>
  !fs.existsSync(dir)
    ? 0
    : fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);

let counts = {};
let db = null;
try {
  db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const integrity = db.pragma('integrity_check').map((r) => r.integrity_check).join('; ');
  if (integrity !== 'ok') problems.push(`integrity check failed (${integrity.slice(0, 200)})`);
  const has = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
  for (const t of ['bookings', 'rooms', 'payment_proofs', 'gallery_photos']) {
    if (has(t)) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    else if (t === 'bookings' || t === 'rooms') problems.push(`the ${t} table is missing`);
  }
  // Every receipt and gallery photo the database still points at should be in the backup.
  if (isDir) {
    if (has('payment_proofs')) {
      const live = db.prepare('SELECT file FROM payment_proofs WHERE deleted_at IS NULL').all();
      const missing = live.filter((r) => !fs.existsSync(path.join(folder, 'receipts', path.basename(r.file)))).length;
      if (missing) notes.push(`${missing} of ${live.length} receipt files named in the database are not in the backup`);
    }
    if (has('gallery_photos')) {
      const photos = db.prepare('SELECT file FROM gallery_photos').all();
      const missing = photos.filter((r) => !fs.existsSync(path.join(folder, 'uploads', 'gallery', path.basename(r.file)))).length;
      if (missing) notes.push(`${missing} of ${photos.length} gallery photos named in the database are not in the backup`);
    }
  }
} catch (err) {
  problems.push(`the database could not be opened (${err.code || 'error'})`);
} finally {
  db?.close();
}

if (isDir && manifest) {
  for (const key of ['uploads', 'receipts']) {
    const expected = manifest[key]?.files;
    const found = countFiles(path.join(folder, key));
    if (Number.isInteger(expected) && expected !== found) problems.push(`${key}: manifest.json lists ${expected} files, the folder holds ${found}`);
  }
}

for (const n of notes) console.log(`[verify] note: ${n}`);
if (problems.length) finish(false, problems.join('; '));
finish(
  true,
  `${path.basename(folder)}: database is intact (${formatBytes(fs.statSync(dbFile).size)}), ${counts.bookings} bookings, ${counts.rooms} studios, ` +
    `${counts.payment_proofs ?? 0} payment receipts on record, ${counts.gallery_photos ?? 0} gallery photos` +
    (isDir ? `; ${countFiles(path.join(folder, 'receipts'))} receipt files and ${countFiles(path.join(folder, 'uploads'))} upload files in the backup` : '') +
    (manifest?.database?.sha256 ? '; checksum matches' : '')
);
