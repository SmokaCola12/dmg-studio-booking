// Startup guard. Imported by index.js right after env.js, so it runs before the database is opened.
// Outside --dev the server refuses to start with a missing, default or short admin password. Values are never logged.
import { adminPasswordProblem, tokenSecretProblem } from './lib/startup-checks.js';

const isDev = process.argv.includes('--dev');
const passwordProblem = adminPasswordProblem(process.env.ADMIN_PASSWORD);
const secretProblem = tokenSecretProblem(process.env.ADMIN_TOKEN_SECRET);

if (passwordProblem && !isDev) {
  console.error(`[startup] Refusing to start: ${passwordProblem}. Set a real ADMIN_PASSWORD in .env (run "npm run check:env" to check).`);
  process.exit(1);
}
if (passwordProblem) {
  const fallback = process.env.ADMIN_PASSWORD?.trim() ? '' :' Using the default "changeme".';
  console.warn(`[auth] ${passwordProblem}.${fallback} Fine for --dev only: the server will not start without --dev until it is fixed.`);
}
if (secretProblem && !isDev) {
  const effect = process.env.ADMIN_TOKEN_SECRET
    ? 'It is too easy to guess: use a long random string in .env.'
    : 'Staff will be logged out every time the server restarts: set a long random string in .env.';
  console.warn(`[startup] Warning: ${secretProblem}. ${effect}`);
}
