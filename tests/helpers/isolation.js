// Shared env isolation for every test that starts a child process (the server or a deploy script) or loads backend code
// in-process. backend/env.js fills in any variable that is NOT already set from the real .env (process.loadEnvFile never
// overrides), so every name the app reads is pinned here: data paths go to the test's temp folder, mail goes to a closed
// local port with no credentials, and everything else is blank ('' means "use the default" everywhere in the app, and a
// blank value still blocks the .env value). A test that wants a value passes it in `overrides`; `undefined` there means
// "default", which is pinned as '' for the same reason.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every variable backend/ and deploy/ read (see .env.example), plus the rate-limit knobs.
export const APP_ENV_NAMES = [
  'PORT', 'ADMIN_PASSWORD', 'ADMIN_TOKEN_SECRET', 'STUDIO_TZ', 'TRUST_PROXY',
  'DB_PATH', 'UPLOAD_DIR', 'RECEIPT_DIR', 'BACKUP_DIR', 'BACKUP_PASSPHRASE', 'SEVENZIP_PATH',
  'SMTP_USER', 'SMTP_PASS', 'SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM', 'PUBLIC_SITE_URL',
  'UPLOAD_RATE_LIMIT', 'LOOKUP_FAIL_LIMIT', 'TEST_EMAIL_RATE_LIMIT',
];

/** Preload that turns process.loadEnvFile into a no-op, for tests that need a variable truly ABSENT (not just blank). */
export const NO_DOTENV_ARGS = ['--import', pathToFileURL(path.join(root, 'tests', 'helpers', 'no-dotenv.mjs')).href];

const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (child, parent) => fold(child) === fold(parent) || fold(child).startsWith(fold(parent) + path.sep);
const tmpRoot = fs.realpathSync.native(os.tmpdir());

/** Throws unless `p` is under the OS temp folder and outside the project (so never data/studio.db or data/private). */
export function assertTempPath(name, p) {
  if (typeof p !== 'string' || !p) throw new Error(`test isolation: ${name} must be set to a temp path`);
  const resolved = path.resolve(p);
  const real = (() => {
    try {
      return fs.realpathSync.native(path.dirname(resolved));
    } catch {
      return path.dirname(resolved);
    }
  })();
  const okTemp = inside(resolved, os.tmpdir()) || inside(resolved, tmpRoot) || inside(real, tmpRoot);
  if (!okTemp || inside(resolved, root)) throw new Error(`test isolation: ${name} must be inside the OS temp folder and outside the project`);
}

/** Guard for every spawner: DB_PATH, UPLOAD_DIR and RECEIPT_DIR must all be temp paths. */
export function assertIsolated(env) {
  for (const name of ['DB_PATH', 'UPLOAD_DIR', 'RECEIPT_DIR']) assertTempPath(name, env[name]);
  if (env.BACKUP_DIR) assertTempPath('BACKUP_DIR', env.BACKUP_DIR);
}

/**
 * A child env with every app variable pinned. `dir` is the test's temp folder: DB_PATH, UPLOAD_DIR, RECEIPT_DIR and
 * BACKUP_DIR default to sub paths of it. Throws when the result would touch anything outside the temp area.
 */
export function isolatedEnv(dir, overrides = {}, { check = true } = {}) {
  const env = { ...process.env };
  for (const name of APP_ENV_NAMES) env[name] = '';
  Object.assign(env, {
    DB_PATH: path.join(dir, 'studio.db'),
    UPLOAD_DIR: path.join(dir, 'uploads'),
    RECEIPT_DIR: path.join(dir, 'receipts'),
    BACKUP_DIR: path.join(dir, 'backups'),
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1',
  });
  for (const [k, v] of Object.entries(overrides)) env[k] = v === undefined ? '' : v;
  // npm sets INIT_CWD; verify-backup resolves relative paths against it. Tests always pass absolute paths.
  delete env.INIT_CWD;
  if (check) assertIsolated(env);
  return env;
}

/** Same pins applied to this process, for tests that import backend modules directly. */
export function isolateThisProcess(dir, overrides = {}) {
  const env = isolatedEnv(dir, overrides);
  for (const name of APP_ENV_NAMES) process.env[name] = env[name];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v ?? '';
}
