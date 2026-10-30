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
`);

// ---------- Settings ----------

export const DEFAULT_SETTINGS = {
  open_hour: 10,
  close_hour: 22,
  min_hours: 1,
  max_hours: 6,
  lead_time_hours: 1,        // earliest a slot can start, counted from now
  max_days_ahead: 60,
  cancel_cutoff_hours: 24,   // customers can cancel online until this many hours before
  auto_confirm: false,       // false = new online bookings wait for admin approval
  promo_enabled: true,
  promo_buy_hours: 2,
  promo_free_hours: 1,
  gcash_enabled: true,
  gcash_name: 'Studio Owner',
  gcash_number: '0917 000 0000',
  closed_weekdays: [],       // 0 = Sunday ... 6 = Saturday
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

// ---------- Seed rooms on first run ----------

const roomCount = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
if (roomCount === 0) {
  const insertRoom = db.prepare(
    'INSERT INTO rooms (name, description, hourly_rate, capacity, gear, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertRoom.run(
    'Room A',
    'Our biggest room. Fits a five-piece band with space to move. Good for full-band rehearsals and live demo takes.',
    400,
    8,
    JSON.stringify(['5-piece drum kit with cymbals', '2 guitar amps', 'Bass amp', 'Keyboard stand', '4 vocal mics', 'PA with 8-channel mixer']),
    '#F2B33D',
    1
  );
  insertRoom.run(
    'Room B',
    'A smaller room for duos, acoustic sets, songwriting, and practice sessions.',
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
