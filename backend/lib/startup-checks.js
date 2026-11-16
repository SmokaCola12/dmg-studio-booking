// Checks on the two admin secrets, shared by the startup guard (guard.js) and `npm run check:env`.
// Pure functions: they return a short reason and never include the value itself.
import { createHash } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 8;
export const MIN_SECRET_LENGTH = 32;

// The old built-in default and the placeholder from .env.example.
const KNOWN_PASSWORDS = ['changeme', 'change-me-to-a-long-password'];

// SHA-256 of passwords that were published in this repository's git history (the old .env.example value). They are
// public, so they must never protect a live site. Only the hash is stored here, never the password itself.
const LEAKED_PASSWORD_HASHES = new Set(['47d0ad0cdaf428f604252121e08c326170f7c103a952b0d75fe8fd980688aa7f']);

/** Why this ADMIN_PASSWORD must not be used on a live site, or null when it is fine. */
export function adminPasswordProblem(value) {
  const pw = typeof value === 'string' ? value : '';
  if (!pw.trim()) return 'ADMIN_PASSWORD is not set';
  if (KNOWN_PASSWORDS.includes(pw.trim().toLowerCase())) return 'ADMIN_PASSWORD is still the default or the example placeholder';
  if (LEAKED_PASSWORD_HASHES.has(createHash('sha256').update(pw.trim()).digest('hex'))) {
    return 'ADMIN_PASSWORD is a published example password (it is in the public git history), choose a new one';
  }
  if (pw.length < MIN_PASSWORD_LENGTH) return `ADMIN_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

/** Why this ADMIN_TOKEN_SECRET does not keep staff logged in across restarts, or null when it is fine. */
export function tokenSecretProblem(value) {
  const secret = typeof value === 'string' ? value : '';
  if (!secret) return 'ADMIN_TOKEN_SECRET is not set';
  if (secret.length < MIN_SECRET_LENGTH) return `ADMIN_TOKEN_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`;
  return null;
}
