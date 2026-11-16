// npm run backup
// Backs up the database, the gallery uploads and the private payment receipts into one timestamped folder under
// BACKUP_DIR (default <repo>/backups), then prunes old backups. Safe to run while the server is running: the database
// is copied with SQLite's online backup API, which gives a consistent snapshot even in WAL mode.
//
//   BACKUP_DIR         where backups go (default <repo>/backups). Put it on another disk if you can.
//   BACKUP_PASSPHRASE  when set and 7-Zip is installed, the backup is packed into an AES-256 encrypted .7z
//   SEVENZIP_PATH      full path to 7z.exe when it is not on PATH or in C:\Program Files\7-Zip
//
// The passphrase is never printed and never put on a command line: 7-Zip is started with a bare -p switch and reads the
// passphrase from its standard input, so it does not show in the process list.
// Exit code is 0 only when the backup was written and verified.
import '../backend/env.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { dataPaths, receiptDirProblem, backupDirProblem, find7z, BACKUP_NAME, formatBytes } from './lib.mjs';

const KEEP_DAYS = 30;
const KEEP_MONTHS = 6;
const TZ = 'Asia/Manila';
const STALE_PARTIAL = /^dmg-backup-\d{8}-\d{6}\.partial(\.7z)?$/;

const paths = dataPaths();
const { dbPath, uploadDir, receiptDir, backupDir } = paths;

/** Manila date and time parts of an instant. */
function manilaParts(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return { ymd: `${p.year}${p.month}${p.day}`, hms: `${p.hour}${p.minute}${p.second}`, year: Number(p.year), month: Number(p.month) };
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Copies a folder tree. Skips half-written .tmp files and links, and files the server deletes while we copy. */
function copyTree(src, dest) {
  const out = { present: fs.existsSync(src), files: 0, bytes: 0 };
  if (!out.present) return out;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isDirectory()) walk(a, b);
      else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
        try {
          fs.copyFileSync(a, b);
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        out.files += 1;
        out.bytes += fs.statSync(b).size;
      }
    }
  };
  walk(src, dest);
  return out;
}

function treeBytes(target) {
  const st = fs.lstatSync(target);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(target).reduce((sum, name) => sum + treeBytes(path.join(target, name)), 0);
}

/** Backups in BACKUP_DIR, newest first. Only real folders / .7z files whose name matches the backup pattern. */
function listBackups() {
  return fs
    .readdirSync(backupDir, { withFileTypes: true })
    .map((entry) => {
      const m = BACKUP_NAME.exec(entry.name);
      if (!m) return null;
      const archive = Boolean(m[5]);
      if (archive ? !entry.isFile() : !entry.isDirectory()) return null;
      return { name: entry.name, day: `${m[1]}${m[2]}${m[3]}`, month: `${m[1]}${m[2]}`, stamp: `${m[1]}${m[2]}${m[3]}-${m[4]}` };
    })
    .filter(Boolean)
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

/**
 * Retention: the newest backup of each of the 30 most recent days that have one, plus the newest backup of each of the
 * last 6 calendar months (this month and the 5 before it). Everything else that matches the backup name is removed.
 */
function prune(justMade) {
  const all = listBackups();
  const keep = new Set([justMade]);
  const days = new Set();
  for (const b of all) {
    if (days.has(b.day)) continue;
    if (days.size >= KEEP_DAYS) break;
    days.add(b.day);
    keep.add(b.name);
  }
  const now = manilaParts();
  const months = new Set();
  for (let i = 0; i < KEEP_MONTHS; i++) {
    const d = new Date(Date.UTC(now.year, now.month - 1 - i, 1));
    months.add(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  for (const b of all) {
    if (!months.has(b.month)) continue;
    months.delete(b.month); // `all` is newest first, so the first hit is the newest of its month
    keep.add(b.name);
  }
  let removed = 0;
  const failed = [];
  for (const b of all) {
    if (keep.has(b.name) || !BACKUP_NAME.test(b.name)) continue;
    // A locked file (an open Explorer window, a virus scan) must not turn a good backup into a failed run.
    try {
      fs.rmSync(path.join(backupDir, b.name), { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    } catch (err) {
      failed.push(`${b.name} (${err.code || 'error'})`);
    }
  }
  return { kept: all.length - removed, removed, failed };
}

/** Runs 7-Zip with the passphrase on standard input (never on the command line or in the environment). */
function run7z(exe, args, passphrase) {
  const childEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'windir']) if (process.env[k]) childEnv[k] = process.env[k];
  const r = spawnSync(exe, args, {
    cwd: backupDir,
    env: childEnv,
    input: `${passphrase}\n${passphrase}\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    timeout: 60 * 60_000,
  });
  return !r.error && r.status === 0;
}

function encrypt(exe, name, passphrase) {
  const partial = `${name}.partial.7z`;
  const partialPath = path.join(backupDir, partial);
  fs.rmSync(partialPath, { force: true });
  try {
    if (!run7z(exe, ['a', '-t7z', '-mhe=on', '-mx=3', '-y', '-bd', '-p', partial, name], passphrase)) {
      throw new Error('7-Zip could not create the encrypted archive');
    }
    if (!fs.existsSync(partialPath)) throw new Error('7-Zip reported success but wrote no archive');
    // The archive must open with the passphrase, and must NOT open with a different one. The second test proves the
    // passphrase really was applied (and that file names are hidden), not just that the archive is readable.
    if (!run7z(exe, ['t', '-y', '-bd', '-p', partial], passphrase)) throw new Error('the encrypted archive failed its test');
    if (run7z(exe, ['t', '-y', '-bd', '-p', partial], `${passphrase}-not-the-passphrase`)) {
      throw new Error('the archive opens with a wrong passphrase, so it is not protected');
    }
  } catch (err) {
    fs.rmSync(partialPath, { force: true });
    throw err;
  }
  fs.renameSync(partialPath, path.join(backupDir, `${name}.7z`));
  fs.rmSync(path.join(backupDir, name), { recursive: true, force: true });
  return `${name}.7z`;
}

function logLine(text) {
  try {
    fs.appendFileSync(path.join(backupDir, 'backup.log'), `${new Date().toISOString()} ${text}\n`);
  } catch {
    /* the log is a convenience only */
  }
}

async function main() {
  const problem = receiptDirProblem(paths) || backupDirProblem(paths);
  if (problem) throw new Error(problem);
  if (!fs.existsSync(dbPath)) throw new Error(`there is no database at ${dbPath} (check DB_PATH)`);
  if (paths.relative.length) {
    console.warn(`[backup] Warning: ${paths.relative.join(', ')} ${paths.relative.length > 1 ? 'are relative paths' : 'is a relative path'}, read from this folder. Use full paths so the server and the backup always agree.`);
  }

  const passphrase = process.env.BACKUP_PASSPHRASE || '';
  if (passphrase && !/^[\x20-\x7e]+$/.test(passphrase)) {
    throw new Error('BACKUP_PASSPHRASE may only use plain keyboard letters, digits, spaces and symbols (no accents, no line breaks)');
  }
  const sevenZip = passphrase ? find7z() : null;

  fs.mkdirSync(backupDir, { recursive: true });
  // Leftovers of a run that crashed more than a day ago.
  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    const full = path.join(backupDir, entry.name);
    if (STALE_PARTIAL.test(entry.name) && !entry.isSymbolicLink() && Date.now() - fs.lstatSync(full).mtimeMs > 86_400_000) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }

  const now = manilaParts();
  const name = `dmg-backup-${now.ymd}-${now.hms}`;
  const finalDir = path.join(backupDir, name);
  const workDir = `${finalDir}.partial`;
  if (fs.existsSync(finalDir) || fs.existsSync(`${finalDir}.7z`) || fs.existsSync(workDir)) {
    throw new Error(`a backup named ${name} already exists; wait a second and run it again`);
  }

  let finalName = name;
  try {
    fs.mkdirSync(workDir);

    // 1. Database first: a consistent snapshot through the online backup API. Receipts uploaded after this moment are
    //    copied too and are simply extra files; every receipt the snapshot knows about is already on disk.
    const dbCopy = path.join(workDir, 'studio.db');
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(dbCopy);
    } finally {
      source.close();
    }

    // 2. Check the copy, and turn it into a single plain file (no -wal / -shm beside it).
    const copy = new Database(dbCopy, { fileMustExist: true });
    let tables;
    try {
      copy.pragma('journal_mode = DELETE');
      const integrity = copy.pragma('integrity_check').map((r) => r.integrity_check).join('; ');
      if (integrity !== 'ok') throw new Error(`the database copy failed its integrity check (${integrity.slice(0, 200)})`);
      const names = copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      tables = Object.fromEntries(names.map(({ name: t }) => [t, copy.prepare(`SELECT COUNT(*) AS n FROM "${t.replaceAll('"', '""')}"`).get().n]));
    } finally {
      copy.close();
    }
    for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(dbCopy + suffix, { force: true });

    // 3. Files.
    const uploads = copyTree(uploadDir, path.join(workDir, 'uploads'));
    const receipts = copyTree(receiptDir, path.join(workDir, 'receipts'));

    // 4. Manifest: counts, sizes and a checksum only. No names, phone numbers or file names.
    const manifest = {
      name,
      created_at: new Date().toISOString(),
      time_zone: TZ,
      database: { file: 'studio.db', bytes: fs.statSync(dbCopy).size, sha256: sha256File(dbCopy), integrity_check: 'ok', rows: tables },
      uploads: { folder: 'uploads', present: uploads.present, files: uploads.files, bytes: uploads.bytes },
      receipts: { folder: 'receipts', present: receipts.present, files: receipts.files, bytes: receipts.bytes },
      encrypted: Boolean(sevenZip),
    };
    fs.writeFileSync(path.join(workDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(workDir, finalDir);

    // 5. Encrypt.
    if (sevenZip) {
      try {
        finalName = encrypt(sevenZip, name, passphrase);
      } catch (err) {
        manifest.encrypted = false;
        try {
          fs.writeFileSync(path.join(finalDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        } catch {
          /* the folder is already (partly) gone; the error below still says what happened */
        }
        throw new Error(`${err.message}. The backup itself is complete but was left UNENCRYPTED in ${finalDir}`);
      }
    }

    const size = formatBytes(treeBytes(path.join(backupDir, finalName)));
    const { kept, removed, failed } = prune(finalName);
    if (failed.length) {
      console.warn(`[backup] Warning: could not remove ${failed.length} old backup(s): ${failed.join(', ')}. They are tried again next run.`);
      logLine(`WARN could not prune ${failed.join(', ')}`);
    }

    if (!sevenZip) {
      const why = passphrase ? '7-Zip was not found (install it from 7-zip.org, or set SEVENZIP_PATH)' : 'BACKUP_PASSPHRASE is not set';
      console.warn(`[backup] WARNING: this backup is NOT ENCRYPTED because ${why}. It contains customer names, phone numbers and payment receipts: keep the folder private.`);
    }
    const summary = `${finalName} (${size}; ${tables.bookings ?? 0} bookings, ${uploads.files} gallery files, ${receipts.files} receipts; ${sevenZip ? 'encrypted' : 'NOT encrypted'}; ${kept} kept, ${removed} pruned)`;
    logLine(`OK ${summary}`);
    console.log(`[backup] OK: ${summary} in ${backupDir}`);
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}

main().catch((err) => {
  const reason = err.code && !err.message ? err.code : err.message;
  if (fs.existsSync(backupDir)) logLine(`FAILED ${reason}`);
  console.error(`[backup] FAILED: ${reason}`);
  process.exitCode = 1;
});
