import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// UPLOAD_DIR is the root served at /media; gallery photos live in <root>/gallery.
export const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'data', 'uploads'));
export const GALLERY_DIR = path.join(UPLOAD_ROOT, 'gallery');
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_PHOTOS = 24;

fs.mkdirSync(GALLERY_DIR, { recursive: true });

// Leftovers from an upload that crashed between write and rename.
for (const name of fs.readdirSync(GALLERY_DIR)) {
  if (name.endsWith('.tmp')) fs.rmSync(path.join(GALLERY_DIR, name), { force: true });
}

/** Returns the file extension for a JPEG, PNG or WebP buffer, judged by its first bytes, or null. */
export function imageExtension(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return null;
}

/** Full path of a gallery file, or null if it would fall outside the gallery folder. */
export function galleryPath(file) {
  const full = path.resolve(GALLERY_DIR, String(file));
  return full.startsWith(GALLERY_DIR + path.sep) ? full : null;
}
