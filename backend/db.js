import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'studio.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    hourly_rate  INTEGER NOT NULL,           -- in pesos
    capacity     INTEGER NOT NULL DEFAULT 6,
    gear         TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
    color        TEXT NOT NULL DEFAULT '#F2B33D',
    active       INTEGER NOT NULL DEFAULT 1,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL UNIQUE,
    room_id         INTEGER NOT NULL REFERENCES rooms(id),
    date            TEXT NOT NULL,            -- YYYY-MM-DD, studio local time
    start_hour      INTEGER NOT NULL,         -- 0-23
    start_minute    INTEGER NOT NULL DEFAULT 0, -- 0 or 30 (the booking ends at end_hour:start_minute)
    paid_hours      INTEGER NOT NULL,
    free_hours      INTEGER NOT NULL DEFAULT 0,
    end_hour        INTEGER NOT NULL,         -- start_hour + paid_hours + free_hours
    customer_name   TEXT NOT NULL,
    band_name       TEXT NOT NULL DEFAULT '',
    phone           TEXT NOT NULL,            -- normalized 09XXXXXXXXX
    email           TEXT NOT NULL DEFAULT '',
    headcount       INTEGER NOT NULL DEFAULT 1,
    notes           TEXT NOT NULL DEFAULT '',
    payment_method  TEXT NOT NULL DEFAULT 'pay_at_studio', -- pay_at_studio | gcash
    payment_ref     TEXT NOT NULL DEFAULT '',
    hourly_rate     INTEGER NOT NULL,
    total           INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | completed | cancelled | no_show
    source          TEXT NOT NULL DEFAULT 'online',  -- online | walk_in
    admin_notes     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_date_room ON bookings(date, room_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

  CREATE TABLE IF NOT EXISTS blocks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     INTEGER REFERENCES rooms(id), -- NULL = all rooms
    date        TEXT NOT NULL,
    start_hour  INTEGER NOT NULL,
    end_hour    INTEGER NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks(date);

  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gallery_photos (
    id          INTEGER PRIMARY KEY,
    file        TEXT NOT NULL UNIQUE,
    alt         TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

// ---------- Additive migrations for databases created before a column existed ----------

const bookingColumns = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
if (!bookingColumns.includes('start_minute')) {
  db.exec('ALTER TABLE bookings ADD COLUMN start_minute INTEGER NOT NULL DEFAULT 0');
}

// GCash payments confirmed by staff. Existing rows keep the defaults, which read as "not a new-style GCash booking".
//   payment_plan:    '' | 'half' | 'full'
//   amount_due:      whole pesos due by GCash now
//   payment_status:  '' | awaiting_proof | proof_submitted | not_received | received
//   hold_expires_at: UTC ISO instant; only set while a pending booking waits for its first screenshot
//   refund_status:   '' | refund_due | refunded
const PAYMENT_COLUMNS = [
  ["payment_plan", "TEXT NOT NULL DEFAULT ''"],
  ['amount_due', 'INTEGER NOT NULL DEFAULT 0'],
  ["payment_status", "TEXT NOT NULL DEFAULT ''"],
  ['hold_expires_at', 'TEXT'],
  ['proof_submitted_at', 'TEXT'],
  ['paid_amount', 'INTEGER NOT NULL DEFAULT 0'],
  ['balance_paid', 'INTEGER NOT NULL DEFAULT 0'],
  ["balance_method", "TEXT NOT NULL DEFAULT ''"],
  ['balance_recorded_at', 'TEXT'],
  ["balance_recorded_by", "TEXT NOT NULL DEFAULT ''"],
  ["refund_status", "TEXT NOT NULL DEFAULT ''"],
];
for (const [name, ddl] of PAYMENT_COLUMNS) {
  if (!bookingColumns.includes(name)) db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${ddl}`);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_bookings_hold ON bookings(status, hold_expires_at);
  CREATE INDEX IF NOT EXISTS idx_bookings_payment ON bookings(payment_status);

  CREATE TABLE IF NOT EXISTS payment_proofs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id   INTEGER NOT NULL REFERENCES bookings(id),
    file         TEXT NOT NULL UNIQUE,
    mime         TEXT NOT NULL,
    bytes        INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'deposit',   -- deposit | balance
    uploaded_by  TEXT NOT NULL DEFAULT 'customer',  -- customer | staff
    uploaded_at  TEXT NOT NULL,                     -- UTC ISO
    deleted_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_proofs_booking ON payment_proofs(booking_id);
  CREATE INDEX IF NOT EXISTS idx_proofs_sha ON payment_proofs(sha256);

  -- Audit trail. Rows are never deleted.
  CREATE TABLE IF NOT EXISTS payment_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id  INTEGER NOT NULL REFERENCES bookings(id),
    at          TEXT NOT NULL,                      -- UTC ISO
    actor       TEXT NOT NULL,                      -- customer | staff | system
    staff_name  TEXT NOT NULL DEFAULT '',
    action      TEXT NOT NULL,
    amount      INTEGER,
    method      TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_events_booking ON payment_events(booking_id);
`);

// Receipt hints read from the screenshot by the customer's browser (OCR). Untrusted: staff-only, never used to confirm.
const proofColumns = db.prepare('PRAGMA table_info(payment_proofs)').all().map((c) => c.name);
if (!proofColumns.includes('ocr_ref')) db.exec("ALTER TABLE payment_proofs ADD COLUMN ocr_ref TEXT NOT NULL DEFAULT ''");
if (!proofColumns.includes('ocr_amount_centavos')) db.exec('ALTER TABLE payment_proofs ADD COLUMN ocr_amount_centavos INTEGER');

/** Digits of a GCash reference, or '' when there are fewer than 8 or more than 20 (too short to compare safely). */
export function refDigits(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 20 ? digits : '';
}

// bookings.ref_digits mirrors payment_ref as digits only, so the same reference on two bookings can be found by index.
if (!bookingColumns.includes('ref_digits')) {
  db.exec("ALTER TABLE bookings ADD COLUMN ref_digits TEXT NOT NULL DEFAULT ''");
}
// The backfill runs on every start, not only right after the ALTER, so a start that died in between is finished by the
// next one. It only looks at rows that have a reference but no digits yet, and writes nothing when those are all
// references too short or too long to compare.
db.transaction(() => {
  const fill = db.prepare('UPDATE bookings SET ref_digits = ? WHERE id = ?');
  for (const row of db.prepare("SELECT id, payment_ref FROM bookings WHERE payment_ref != '' AND ref_digits = ''").all()) {
    const digits = refDigits(row.payment_ref);
    if (digits) fill.run(digits, row.id);
  }
})();
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_bookings_ref_digits ON bookings(ref_digits) WHERE ref_digits != '';
  CREATE INDEX IF NOT EXISTS idx_proofs_ocr_ref ON payment_proofs(ocr_ref) WHERE ocr_ref != '';
`);

// ---------- Settings ----------

export const DEFAULT_SETTINGS = {
  open_hour: 10,
  close_hour: 22,
  min_hours: 1,
  max_hours: 6,
  lead_time_hours: 1,        // earliest a slot can start, counted from now
  max_days_ahead: 60,
  buffer_minutes: 30,        // cleaning gap kept after every booking (0, 30, 60, 90 or 120)
  cancel_cutoff_hours: 24,   // customers can cancel online until this many hours before
  auto_confirm: false,       // false = new online bookings wait for admin approval
  promo_enabled: true,
  promo_buy_hours: 2,
  promo_free_hours: 1,
  gcash_enabled: true,       // online GCash also needs the studio's QR to be uploaded (see getGcashQr)
  gcash_hold_minutes: 30,    // a pending GCash booking holds its slot this long while no screenshot is uploaded
  receipt_retention_days: 60, // payment screenshots are deleted this long after the booking date
  closed_weekdays: [],       // 0 = Sunday ... 6 = Saturday
  // Emails to the studio inbox. Admin only: never add these to PUBLIC_SETTING_KEYS.
  notify_email: '',              // where staff emails go; '' = the SMTP_USER address
  notify_new_booking: true,      // a customer booked on the website
  notify_payment_proof: true,    // a customer uploaded a GCash receipt screenshot
  notify_customer_changes: true, // a customer cancelled or rescheduled online
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, JSON.stringify(v));

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) out[r.key] = JSON.parse(r.value);
  }
  return out;
}

export function saveSettings(partial) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(k, JSON.stringify(v));
  });
  tx(Object.entries(partial).filter(([k]) => k in DEFAULT_SETTINGS));
  return getSettings();
}

// ---------- Studio GCash QR ----------
// The uploaded QR text holds the owner's account details. It is stored under its own key (NOT in DEFAULT_SETTINGS, so
// getSettings(), /api/site and /api/admin/schedule can never return it) and is read only through these two functions.

const GCASH_QR_KEY = 'gcash_qr_payload';

export function getGcashQr() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(GCASH_QR_KEY);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value);
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** Saves the validated QR text, or removes it when `payload` is null. */
export function saveGcashQr(payload) {
  if (payload === null) db.prepare('DELETE FROM settings WHERE key = ?').run(GCASH_QR_KEY);
  else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      GCASH_QR_KEY,
      JSON.stringify(payload)
    );
  }
}

/** Old manual-GCash settings (send-to name and number), kept readable but no longer used. Null when never stored. */
export function getLegacyGcash() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('gcash_name', 'gcash_number')").all();
  if (!rows.length) return null;
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const read = (k) => {
    try {
      return typeof JSON.parse(byKey[k]) === 'string' ? JSON.parse(byKey[k]) : '';
    } catch {
      return '';
    }
  };
  return { gcashName: read('gcash_name'), gcashNumber: read('gcash_number') };
}

// ---------- Owner-editable contact details ----------
// Stored in the settings table but kept out of DEFAULT_SETTINGS: a missing row means
// "use the default from the frontend", so nothing is seeded.

export const CONTENT_KEYS = {
  address: 'contact_address',
  landmark: 'contact_landmark',
  mapsQuery: 'contact_maps_query',
  phone: 'contact_phone',
  email: 'contact_email',
  messenger: 'contact_messenger',
  socials: 'contact_socials',
};

export function getContent() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'contact\\_%' ESCAPE '\\'").all();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const [field, key] of Object.entries(CONTENT_KEYS)) {
    out[field] = key in byKey ? JSON.parse(byKey[key]) : null;
  }
  return out;
}

// `partial` maps field name to a validated value; null removes the row (back to the default).
export function saveContent(partial) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const remove = db.prepare('DELETE FROM settings WHERE key = ?');
  const tx = db.transaction((entries) => {
    for (const [field, v] of entries) {
      if (v === null) remove.run(CONTENT_KEYS[field]);
      else upsert.run(CONTENT_KEYS[field], JSON.stringify(v));
    }
  });
  tx(Object.entries(partial).filter(([f]) => f in CONTENT_KEYS));
  return getContent();
}

export function galleryPhoto(row) {
  return { id: row.id, src: `/media/gallery/${row.file}`, alt: row.alt, sortOrder: row.sort_order };
}

export function listGallery() {
  return db.prepare('SELECT * FROM gallery_photos ORDER BY sort_order, id').all().map(galleryPhoto);
}

// ---------- Seed rooms on first run ----------

const roomCount = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
if (roomCount === 0) {
  const insertRoom = db.prepare(
    'INSERT INTO rooms (name, description, hourly_rate, capacity, gear, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertRoom.run(
    'Studio A',
    'Our biggest studio. Fits a five-piece band with space to move. Good for full-band rehearsals and live demo takes.',
    400,
    8,
    JSON.stringify(['5-piece drum kit with cymbals', '2 guitar amps', 'Bass amp', 'Keyboard stand', '4 vocal mics', 'PA with 8-channel mixer']),
    '#F2B33D',
    1
  );
  insertRoom.run(
    'Studio B',
    'A smaller studio for duos, acoustic sets, songwriting, and practice sessions.',
    300,
    4,
    JSON.stringify(['Compact drum kit', 'Guitar amp', 'Bass amp', '2 vocal mics', 'PA with 4-channel mixer']),
    '#4FC1B0',
    2
  );
}

export function parseRoom(r) {
  return r ? { ...r, gear: JSON.parse(r.gear || '[]'), active: !!r.active } : r;
}
