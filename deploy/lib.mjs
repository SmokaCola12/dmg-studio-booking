// Shared by the deploy scripts (check-env, backup, verify-backup). No side effects on import.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const distDir = path.join(repoRoot, 'frontend', 'dist');

/**
 * The data locations, resolved the same way the server does (backend/db.js, lib/uploads.js, lib/receipts.js): the env
 * value when set, else the default under <repo>/data. `relative` lists the names whose value is a relative path; those
 * resolve against the folder a command is started from, which can differ between the server and these scripts.
 */
export function dataPaths(env = process.env) {
  const pick = (name, ...fallback) => path.resolve(env[name] || path.join(repoRoot, ...fallback));
  return {
    dbPath: pick('DB_PATH', 'data', 'studio.db'),
    uploadDir: pick('UPLOAD_DIR', 'data', 'uploads'),
    receiptDir: pick('RECEIPT_DIR', 'data', 'private', 'receipts'),
    backupDir: pick('BACKUP_DIR', 'backups'),
    relative: ['DB_PATH', 'UPLOAD_DIR', 'RECEIPT_DIR', 'BACKUP_DIR'].filter((n) => env[n] && !path.isAbsolute(env[n])),
  };
}

// Windows file names are not case sensitive, so compare folded there.
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
export const isInside = (child, parent) => fold(child) === fold(parent) || fold(child).startsWith(fold(parent) + path.sep);

/** The server's rule for the private receipts folder (backend/lib/receipts.js). Returns a reason or null. */
export function receiptDirProblem({ uploadDir, receiptDir }) {
  if (isInside(receiptDir, uploadDir)) return 'RECEIPT_DIR is inside UPLOAD_DIR, which is served to the public at /media';
  if (isInside(uploadDir, receiptDir)) return 'UPLOAD_DIR is inside RECEIPT_DIR, which must stay private';
  if (isInside(receiptDir, distDir)) return 'RECEIPT_DIR is inside frontend/dist, which is served to the public';
  return null;
}

/** Why backups must not be written to this BACKUP_DIR, or null. */
export function backupDirProblem({ dbPath, uploadDir, receiptDir, backupDir }) {
  if (isInside(backupDir, uploadDir)) return 'BACKUP_DIR is inside UPLOAD_DIR, which is served to the public at /media';
  if (isInside(backupDir, distDir)) return 'BACKUP_DIR is inside frontend/dist, which is served to the public';
  if (isInside(backupDir, receiptDir)) return 'BACKUP_DIR is inside RECEIPT_DIR (a backup would copy itself)';
  if (isInside(uploadDir, backupDir) || isInside(receiptDir, backupDir)) return 'UPLOAD_DIR or RECEIPT_DIR is inside BACKUP_DIR';
  if (fold(path.dirname(dbPath)) === fold(backupDir)) return 'BACKUP_DIR is the folder that holds the live database';
  return null;
}

/** A working 7-Zip command line program (SEVENZIP_PATH, then 7z on PATH, then the usual install folder), or null. */
export function find7z(env = process.env) {
  const candidates = [env.SEVENZIP_PATH, '7z', 'C:\\Program Files\\7-Zip\\7z.exe'].filter(Boolean);
  for (const exe of candidates) {
    if (path.isAbsolute(exe) && !fs.existsSync(exe)) continue;
    try {
      const r = spawnSync(exe, ['i'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
      if (!r.error && r.status === 0) return exe;
    } catch {
      /* not there */
    }
  }
  return null;
}

// Backups are a folder `dmg-backup-YYYYMMDD-HHMMSS`, or that name plus `.7z` when encrypted.
export const BACKUP_NAME = /^dmg-backup-(\d{4})(\d{2})(\d{2})-(\d{6})(\.7z)?$/;

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
