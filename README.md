# DMG Studio — booking site

A rehearsal studio website with online booking and a staff admin. Not Shopify — it's a custom app: **Vite + React** on the frontend, **Express + SQLite (better-sqlite3)** on the backend. One Node process when deployed.

## What's included

**Public site**
- Home: a booking card up top (pick a room and hours, pick a day on the month calendar, pick a start time, Book now), then a live schedule for the day styled like a DAW (each room is a track, each booking is a clip, the red line is now). Tap an open slot on the board to jump straight into booking.
- Rooms and rates, gallery, house rules, FAQ, map and contact. The contact details and gallery photos can be changed by the owner in admin.
- Booking flow: room → date → number of hours → start time → details → review. The free hour promo is applied automatically when it fits.
- Payment: **pay at the studio**, or **pay 50% or 100% by GCash** when booking (the button reads "Book for ₱…"). The GCash page shows a QR with the exact amount, a hold countdown and an upload for a screenshot of the receipt. See [GCash payments](#gcash-payments).
- Booking code and "Add to calendar" (.ics) after booking.
- **My booking** (`/check`): view, reschedule or cancel with the booking code and mobile number (subject to the cancellation cutoff), and see where a GCash payment stands (waiting for the studio, confirmed, not received yet, paid). A GCash booking with a screenshot sent or the payment received cannot be cancelled online; the page tells the customer to message the studio.

**Admin** (`/admin`, password set in `.env`)
- **Today**: stats, bookings awaiting approval (with a quick Confirm), today's schedule and upcoming bookings. A toast appears when a new online booking comes in.
- **Bookings**: search (name, band, code, mobile), filter by status (including **expired**), room or date, and a detail dialog: confirm, decline, done, no-show, reopen, move to another time or room, staff notes. A GCash booking shows its payment and links to GCash payments instead of a plain Confirm button.
- **GCash payments**: every GCash booking with its screenshots (tap to enlarge) and history. See [GCash payments](#gcash-payments).
- **Schedule**: any day; tap an open slot to add a walk-in; **Block time** for repairs or private events. Back-to-back bookings with less cleaning time than the setting are flagged with "Not enough cleaning time".
- **Rooms**: rate, capacity, gear list, schedule colour, show or hide on the website.
- **Settings**: opening hours, closed days, min/max hours, lead time, how far ahead people can book, cleaning time after each booking, cancellation cutoff, auto-confirm, free hour promo, the online GCash section (on/off, the studio QR, how long a slot is held, how long receipts are kept), and **Email notifications** (where studio alerts go, which ones to send, Send test email). See [Emails](#emails).
- **Studio page** (`/admin/content`, linked from Settings and the sidebar on desktop): address, landmark, map search, phone, email, Messenger and social links, and the "Inside the studio" gallery photos.

## Run it locally

Requires Node 20.12 or newer (Node 22 recommended).

```bash
npm install
cp .env.example .env        # change ADMIN_PASSWORD
npm run dev                 # API on :4000, site on http://localhost:5173
npm run seed:demo           # optional: sample bookings so the schedule isn't empty
```

`npm run dev` starts the server with `--dev`, so a placeholder or short `ADMIN_PASSWORD` only gives a warning there. `npm start` refuses to start with it (see [Startup check](#startup-check)).

To test on a phone, open `http://<your computer's IP>:5173` (same Wi-Fi).

`npm run dev` and `npm run build` first copy the OCR engine for the pay page from `node_modules` into `frontend/public/ocr`. That folder is git-ignored and is recreated automatically if you delete it; you don't commit it.

### Settings in `.env`

| Variable | What it does |
| --- | --- |
| `ADMIN_PASSWORD` | Password for `/admin`. Use a long one. Outside `npm run dev` the server refuses to start when it is empty, `changeme`, the placeholder from `.env.example`, or shorter than 8 characters. See [Startup check](#startup-check). |
| `ADMIN_TOKEN_SECRET` | Signs admin logins. Use a long random value (32 characters or more) so staff stay logged in after a restart. If it is not set, everyone is logged out on each restart; if it is missing or shorter than 32 characters, the server prints a warning at startup. |
| `PORT` | Port for the API, and for the whole site in production. Default `4000`. |
| `STUDIO_TZ` | Time zone for bookings. Default `Asia/Manila`. |
| `DB_PATH` | Where the SQLite database file lives. Default `data/studio.db`. |
| `UPLOAD_DIR` | Where gallery photos are stored. Default `data/uploads`. On a host, point it at a folder on the persistent disk. |
| `RECEIPT_DIR` | Where GCash receipt screenshots are stored. Default `data/private/receipts`. It must be a private folder: the server refuses to start if it is inside `UPLOAD_DIR` or `frontend/dist`. On a host, point it at the persistent disk. |
| `SMTP_USER`, `SMTP_PASS` | Gmail address and its **App Password**, for the payment emails to customers and the alert emails to the studio. If either is empty, no emails are sent and everything else still works. Studio alerts go to `SMTP_USER` unless another address is set in Admin → Settings. See [Emails](#emails). |
| `MAIL_FROM` | Sender shown in the emails. Default: `SMTP_USER`. |
| `SMTP_HOST`, `SMTP_PORT` | Mail server. Default `smtp.gmail.com` and `465`. |
| `PUBLIC_SITE_URL` | Optional. The public address of the site (no trailing slash), used for the "check your booking" link in customer emails and the link to the admin page in studio emails. Without it the customer emails say to use the website and the studio emails have no link. |
| `TEST_EMAIL_RATE_LIMIT` | Test emails allowed from Admin → Settings per 10 minutes, counted for the whole server (staff share one login). Default `5`. |
| `TRUST_PROXY` | How many reverse proxies (Nginx, Caddy, a host's load balancer) sit in front of the server. Default `1`; use `0` if the server is reached directly. The rate limits are keyed by IP, so set the real number: if it is too high, a visitor can fake the `X-Forwarded-For` header and dodge them. |
| `UPLOAD_RATE_LIMIT` | Screenshot uploads allowed per IP per 15 minutes. Default `10`. |
| `LOOKUP_FAIL_LIMIT` | Failed booking code + phone matches allowed per IP per 15 minutes. Default `30`. Many phones share one carrier IP, so the default is not tiny. |
| `BACKUP_DIR` | Where `npm run backup` writes backups. Default `backups/` in the project folder (git-ignored). Use a full path, ideally on another disk. It must not be inside `UPLOAD_DIR`, `RECEIPT_DIR` or `frontend/dist`. See [Backups](#backups). |
| `BACKUP_PASSPHRASE` | When set and 7-Zip is installed, every backup is packed into an AES-256 encrypted `.7z`. Plain keyboard characters only (no accents). Keep a copy somewhere else: without it a backup cannot be opened. Without it, backups are **not** encrypted. |
| `SEVENZIP_PATH` | Full path to `7z.exe`, only needed when 7-Zip is not on PATH and not in `C:\Program Files\7-Zip`. |

## Production

```bash
npm run build
npm start                   # a single port (PORT in .env) serving both the site and the API
```

Works on any VPS or Node host with a persistent disk (Railway, Render with a disk, DigitalOcean, Hostinger VPS). **It will not work on static hosts like Vercel or Netlify**, because it needs a running server and a file for the SQLite database (`data/studio.db`), the uploaded gallery photos in `data/uploads/` (or wherever `UPLOAD_DIR` points) and the GCash receipt screenshots in `data/private/receipts/` (or wherever `RECEIPT_DIR` points). **Back up all three** with `npm run backup` (see [Backups](#backups)). The photos and receipts are not in the database, and `data/uploads/` and `data/private/` are git-ignored, so git won't keep a copy. Receipts are personal data (names, phone numbers); keep that folder private and never serve it.

Behind Nginx or Caddy, just proxy everything to `PORT`.

The app itself sends no `Content-Security-Policy`. If you add a strict one at the proxy or the host, it must allow same-origin workers and WebAssembly (for example `worker-src 'self'` and `'wasm-unsafe-eval'` in `script-src`). Without that, the screenshot reading on the pay page stops working, but uploads still go through.

### Before you go live

Do these on the machine that will run the site:

1. In `.env`, set a long `ADMIN_PASSWORD` and a long `ADMIN_TOKEN_SECRET`. To generate a random value for each:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   Never use the example password from older versions of `.env.example` (see [Startup check](#startup-check)).
2. Set `SMTP_USER` and `SMTP_PASS` with a Gmail **App Password** (see [Emails](#emails)), and `PUBLIC_SITE_URL` (the `https://` address, no trailing slash).
3. Set `TRUST_PROXY` to the number of proxies really in front of the server on your hosting (`0` when visitors reach the server directly).
4. Run `npm run build`, then `npm run check:env` and fix every `FAIL` (see [Check the settings](#check-the-settings-npm-run-checkenv)).
5. Start the site, upload the GCash QR in **Admin → Settings → GCash** and run **Test QR (₱1.00)** (see [GCash payments](#gcash-payments)).
6. Run `npm run backup` once, then `npm run backup:verify -- <the new backup folder>`, and schedule the daily backup (see [Backups](#backups)).
7. When the site is reached through a tunnel or a proxy, block direct access to the app port (`PORT`) from outside, for example in the firewall. Otherwise visitors can skip the proxy, fake the `X-Forwarded-For` header and get around the rate limits.

### Startup check

Unless the server is started with `--dev` (which `npm run dev` does), it checks the admin password before it opens the database. It **refuses to start** (exit code 1) with one line such as:

```
[startup] Refusing to start: ADMIN_PASSWORD is not set. Set a real ADMIN_PASSWORD in .env (run "npm run check:env" to check).
```

when `ADMIN_PASSWORD` is:

- not set or blank,
- `changeme` or the placeholder from `.env.example` (in any capitals),
- shorter than 8 characters.

`ADMIN_TOKEN_SECRET` only gives a warning: when it is missing, everyone is logged out on every restart; when it is shorter than 32 characters, it is easy to guess. With `--dev`, password problems are also only warnings. The startup lines never show the values.

`.env.example` now holds a placeholder password, which the server rejects. **The example password from older versions of `.env.example` is in the git history, so it is public.** Never use it; if your `.env` still has it, change it now.

### Check the settings: `npm run check:env`

```bash
npm run check:env
```

Reads `.env` the same way the server does and prints one line per setting: `PASS`, `WARN` or `FAIL`, then the setting's name and a short note. It shows names only, never values or folder paths, and changes nothing. It ends with a count (`N passed, N warnings, N failed.`) and exits with code 1 when anything fails. Run it on the production machine before going live, since it checks that machine's `.env`, folders, built site and database.

It checks:

- Node.js is 20.12 or newer, and there is a `.env` file.
- `ADMIN_PASSWORD` follows the [Startup check](#startup-check) rules (`FAIL` otherwise) and `ADMIN_TOKEN_SECRET` is 32 characters or more (`WARN` otherwise).
- `SMTP_USER` and `SMTP_PASS` are both set or both empty (both empty is a `WARN`: emails are off), and `SMTP_PORT` is a valid port.
- `PUBLIC_SITE_URL` is a plain `https://` address with no trailing slash (`WARN` when it is not set or is `http`).
- `PORT`, `TRUST_PROXY` and `STUDIO_TZ` are valid (`WARN` when the time zone is not Asia/Manila).
- The folders for `DB_PATH`, `UPLOAD_DIR` and `RECEIPT_DIR` exist or can be created and are writable, and the receipts folder is private.
- `BACKUP_DIR` is outside the public folders, and `BACKUP_PASSPHRASE` is set with 7-Zip installed (`WARN` when backups would not be encrypted).
- `frontend/dist` and its OCR files are there (run `npm run build` if not).
- A GCash QR is stored (yes or no only).

How to read it: `PASS` is fine. `WARN` works, but check that it is what you want (for example, no emails or unencrypted backups). `FAIL` must be fixed before going live: the server will not start, or a part of the site will not work. A relative path for a folder setting is a `WARN`: use full paths so the server and the backup always agree.

### Backups

```bash
npm run backup
```

Makes one backup and is safe to run while the server is running. Each backup is a folder `dmg-backup-YYYYMMDD-HHMMSS` (Manila time) in `BACKUP_DIR` (default `backups/` in the project folder, git-ignored), holding:

- `studio.db`: a consistent copy of the database, taken with SQLite's online backup and checked with an integrity check,
- `uploads/`: the gallery photos,
- `receipts/`: the private GCash screenshots,
- `manifest.json`: counts, sizes and a checksum only (no names or phone numbers).

`.env` is **not** in the backup.

- **Encryption.** When `BACKUP_PASSPHRASE` is set and 7-Zip is installed, the folder is packed into an AES-256 encrypted `dmg-backup-....7z` (file names hidden too) and the plain folder is deleted. The passphrase must use plain keyboard characters only and is never printed. It is handed to 7-Zip on its standard input; this has not been confirmed on every 7-Zip version, so the script test-opens the archive with the right passphrase and with a wrong one. If either test fails, it stops with exit code 1 and leaves the backup complete but **unencrypted**. When a backup is not encrypted, it prints a `WARNING: this backup is NOT ENCRYPTED` line saying why.
- **What is kept.** The newest backup of each of the last 30 days that have one, plus the newest backup of each of the last 6 months. Older ones are deleted after each run. A second backup on the same day replaces the earlier one of that day.
- **Result.** It ends with `[backup] OK: ...` and exit code 0 only when the backup was written and checked. On any problem it prints `[backup] FAILED: ...` and exits with a non-zero code. Every run adds a line to `backup.log` in `BACKUP_DIR`.

**Check a backup** (read-only, changes nothing):

```bash
npm run backup:verify -- "backups\dmg-backup-20261116-043000"
```

It runs an integrity check, compares the checksum with `manifest.json` and prints how many bookings, studios, receipts and photos are in it. An encrypted `.7z` has to be extracted first; see `deploy/restore.md`.

**Daily backup on Windows.** `deploy/backup.ps1` runs one backup (the same as `npm run backup`). `deploy/schedule-backup.ps1` registers it as a Windows Task Scheduler job, by default every day at 04:30 on the PC's clock. It shows the plan and registers nothing until you type `YES`:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\schedule-backup.ps1            # show the plan, ask, then register
powershell -ExecutionPolicy Bypass -File deploy\schedule-backup.ps1 -WhatIf    # show the plan only
powershell -ExecutionPolicy Bypass -File deploy\schedule-backup.ps1 -Remove    # remove the job (asks first)
```

Add `-Time 05:00` for another time. Running it again replaces the existing job instead of adding a second one. By default the job runs only while the same Windows user is logged on; `-WhetherLoggedOnOrNot` (PowerShell started with "Run as administrator") makes it run anyway. A missed run starts as soon as the PC is on again. Check `backup.log` now and then.

**Restore.** Follow `deploy/restore.md` step by step.

**Keep copies off this machine.** Copy the backups to another disk or place regularly, and keep `.env` and `BACKUP_PASSPHRASE` somewhere else too (not beside the backups). Backups hold receipts and customer names and phone numbers, which are personal data: set `BACKUP_PASSPHRASE` so they are encrypted, and keep every copy private.

## Changing content

| What | Where |
| --- | --- |
| Name, tagline, intro, house rules, FAQ, default address, map, phone, Messenger, socials | `frontend/src/config/site.js` (the defaults; the owner can override the contact details in admin) |
| Address, landmark, map search, phone, email, Messenger, socials, gallery photos | Admin → Studio page |
| Rooms, rates, gear, hours, promo, GCash (on/off, QR, hold time), email notifications | Admin → Rooms / Settings |
| Colours and fonts | tokens at the top of `frontend/src/styles/base.css` |

Until the owner fills in the Studio page, the site uses the defaults in `site.js`, and the address, phone and photos there are still placeholders. A blank field on the Studio page goes back to its default. With no photos uploaded, the gallery shows the labeled placeholders from `galleryPlaceholders` in `site.js`.

## Studio page: contact details and photos

Open **Admin → Studio page** (`/admin/content`). You can also reach it from the button at the top of **Settings**; on phones it is only there, not in the sidebar.

- **Contact details**: address (up to three lines), landmark, map search text, phone, email, Messenger link (`m.me`, `messenger.com` or `facebook.com`, starting with `https://`) and up to six social links. Clear a field to use the default again.
- **Gallery**: "Inside the studio" photos. You can add, caption, reorder and delete them. Up to 24 photos, each 5 MB or less, in JPEG, PNG or WebP. The browser resizes each photo to at most 1600 px on the long side and saves it as JPEG, so PNG and WebP work too and location data in the photo is removed.
- Photos are stored in `data/uploads/gallery/` (or `UPLOAD_DIR`), not in `studio.db`, and are served from `/media/gallery/`. Once any photo is uploaded, the gallery shows only the uploaded photos.

## GCash payments

Customers can pay 50% or 100% of a booking by GCash. There is no payment gateway and no fee: the customer pays your own GCash account, and your staff confirm the payment in admin by looking at the receipt screenshot and the GCash app. Nothing is confirmed automatically.

### Set it up (once)

1. Open **Admin → Settings → GCash**. Upload a picture of your GCash **Receive Money** QR (the InstaPay QR Ph code from the GCash app). The browser reads the QR and sends only its text to the server. The text contains your account details, so it is stored privately and never shown or logged; you only see the account name, city and a masked account hint.
2. Press **Test QR (₱1.00)** and scan the test code with the GCash app on another phone. It should show ₱1.00 and your account name. Don't send the payment.
3. Check **Pay with GCash** is on. GCash is offered to customers only when it is on **and** a QR is stored. Removing the QR turns it off.
4. Set how long a slot is held while no screenshot is uploaded (default 30 minutes) and how long receipts are kept (default 60 days).
5. Optional: set up emails (below), so the studio inbox is told about each new booking and receipt.

### How a payment goes

1. The customer picks **Pay 50%** or **Pay 100%** on the Book page and presses **Book for ₱…**. The booking is **pending** and the slot is held. The 50% amount is half the total, rounded up to a whole peso.
2. The pay page shows a QR with the exact amount, a countdown, and the hold rules. The customer pays in GCash, then uploads a screenshot of the receipt (JPEG, PNG or WebP, up to 15 MB, up to 3 screenshots; the GCash reference number is optional). The screenshot is required before they can continue.
3. **No screenshot in time:** the booking becomes **expired** and the slot is free again. **Pay later** gives the slot back at once. If the customer uploads a screenshot after the hold ended and the slot is still free, the booking comes back; if someone else took the slot, they are told to message the studio.
4. **Screenshot sent:** the booking stays pending and the slot is held until staff act. It appears first on **Admin → GCash payments** ("To check"), with a badge on the sidebar and a toast.
5. Staff open the screenshot, check the payment in the GCash app, and press:
   - **Received & Confirmed**: the booking becomes confirmed and the deposit is recorded. A 100% booking now reads **PAID**.
   - **Not yet received**: the booking stays pending, the customer sees a note and can upload another screenshot. Nothing is cancelled automatically; staff can cancel the booking later.
6. **The other half of a 50% booking** is paid at the studio. When it is, staff record it on the GCash payments page (or the booking dialog) with one of two buttons: **paid at the studio (cash)**, or **paid in GCash**, which needs a screenshot of that payment. The booking then reads **PAID**. If the total goes up later (for example a longer slot), the difference can be recorded the same way.
7. **Refunds** are handed back by hand, outside the app. A booking that took money and is then cancelled by staff (or shrunk below what was paid) shows **Refund due**; press **Refund recorded** after paying it back so the audit trail is complete. A customer cannot cancel online once a screenshot was sent or the payment was received; they have to message the studio.

Every action is saved in a history list on the booking (who, what, how much, when). Staff names are optional and the admin pages do not ask for them.

Pay-at-studio bookings work as before. Older bookings made with the previous manual flow (customer sent money to a number and typed a reference) stay readable under the **Older** filter. The old send-to name and number are no longer shown to customers; they stay in the database.

### Reading the receipt (OCR)

When the customer picks their screenshot on the pay page, their browser reads it with OCR (the tesseract.js library). It looks for the GCash reference number and the amount, then:

- fills in the **GCash reference number** field, but never overwrites a number the customer typed,
- shows what it found, and whether the amount matches what the booking needs.

If nothing can be read, the customer types the reference by hand. Reading never blocks sending. The picture is not sent anywhere for this: the reading happens on the customer's phone, and the OCR files are served by your own site (no CDN).

Staff see the same reading on **GCash payments** and in the booking dialog, as hints: the reference and amount found, whether they match, and a warning when the same reference number is on another booking (in any status).

Limits:

- A screenshot can be edited or faked, so a match does **not** prove payment. Always check the payment in the GCash app.
- The first time a customer uses it, their phone downloads about 7 MB of OCR data. If the reading fails or times out (25 seconds), the upload still goes through without it.

### Screenshots and privacy

- Receipts are stored in `data/private/receipts/` (or `RECEIPT_DIR`), outside everything the site serves. Only a logged-in admin can open them, never a public link. Back this folder up with the database.
- Each screenshot is checked by its file signature (not just its name), gets a random file name, and is deleted after `receipt_retention_days` (default 60) from the booking date, or after a booking expired or was cancelled. The history stays.
- Staff are warned when the same image was used on another booking.
- Rate limits stop people from guessing booking codes or flooding uploads. They are kept per IP address, so set `TRUST_PROXY` to the real number of proxies in front of the server (see the table above).

### Emails

There are two kinds of email, both sent from the same Gmail.

**To customers.** Customers who gave an email get a message when their payment is confirmed, when it was not received, and when a hold expired. Customers without an email see the same updates under **My booking**.

**To the studio.** The studio inbox gets one email each time a customer does something online:

- **New bookings**: every booking made on the website, pay at the studio or GCash. Walk-ins that staff add in admin do not send one.
- **GCash receipts to check**: each time a customer uploads a payment screenshot (one email per screenshot).
- **Cancellations and changes**: when a customer cancels or moves a booking online. A moved booking shows the old and the new time.

Each email has the booking code, status, customer name and phone, the studio, the date and time, the hours, the total and how it is paid. The screenshot itself is not attached; open it in admin. Nothing is sent for **Pay later**, for a hold that expired, or for anything staff do in admin.

Manage these under **Admin → Settings → Email notifications**:

- **Send studio alerts to**: the address the alerts go to. Leave it empty to use the Gmail that sends the emails (`SMTP_USER`).
- **Email the studio about**: three switches, one per kind above. All are on by default.
- **Send test email**: sends a short test to the saved address and tells you if Gmail accepted it. Save your changes first; the button is off while email is not set up. Up to 5 tests per 10 minutes (`TEST_EMAIL_RATE_LIMIT`).

To turn emails on, put these in `.env` (the names only are shown here; never put real values in the README or commit `.env`), then restart the server:

- `SMTP_USER`: the Gmail address.
- `SMTP_PASS`: a Google **App Password**, not your normal password. Turn on 2-Step Verification, then Google Account → Security → App passwords.
- Optional: `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, and `PUBLIC_SITE_URL` for a link to My booking in customer emails and to the admin page in studio emails.

If `SMTP_USER` or `SMTP_PASS` is empty, all emails are skipped and nothing else changes; the Settings page then says "Email is off". A studio alert is also skipped when its switch is off. A failed email never blocks a booking or a staff action. A failed customer email is recorded in the booking's history as "Email could not be sent"; studio alerts are not written to the history. If the mail server does not answer, the app gives up after 15 to 30 seconds instead of waiting.

## How the booking rules work

- All times are in Asia/Manila (`STUDIO_TZ`). Bookings last whole hours and start at :00 or :30.
- **Pending** and **confirmed** bookings and **blocked time** take up a slot. A cancelled or expired booking frees it again immediately. A pending GCash booking whose hold has run out no longer takes the slot, even in the minute before it is marked expired.
- **Cleaning time**: after every booking the room is kept clear for cleaning. The gap is the setting `buffer_minutes` (Admin → Settings: 0, 30, 60, 90 or 120 minutes; default 30). Another booking in the same room cannot start or end inside that gap. Blocked time has no cleaning gap, so a block can sit right after a booking. A booking must end by closing time, but its cleaning gap may run past closing.
- Free hour promo: "Book X hours, get Y free", once per booking, added only when it doesn't run past closing, and only when the free hour and its cleaning gap fit before the next booking.
- **Staff override**: when staff book, move or reopen a booking inside another booking's cleaning gap, the app asks "Book anyway" or "Save anyway". Customers cannot override the gap; they have to pick another time.
- Changing the cleaning time does not move or cancel existing bookings. Back-to-back pairs that are now too close show up as a warning on the admin Schedule.
- The server makes the final check inside a transaction, so double bookings can't happen even when two people book at once.
- Mobile numbers are stored as `09XXXXXXXXX`; `+63`, spaces and dashes are accepted on input.

## Structure

```
frontend/             Vite + React (site at :5173 in dev)
  src/
    config/site.js    studio content
    pages/            Home, Book, PayBooking (GCash pay page), BookingDone, CheckBooking, admin/* (incl. Content.jsx for the Studio page, GcashPayments.jsx)
    components/       ScheduleBoard, Waveform, PaymentNote, dialogs, form parts
    lib/              receipt-reader.js (OCR in the browser), receipt-ocr.js (reads the reference and amount from text)
    styles/           base, board, site, booking, admin
  scripts/
    copy-ocr.mjs     copies the OCR engine into public/ocr before dev and build
  public/             favicon and other static files (public/ocr is generated, git-ignored)
backend/              Express API (:4000), serves frontend/dist in production
  index.js            Express app (API, /media photos, built site, hold and receipt cleanup timers)
  guard.js            startup check: refuses to start without --dev when the admin password is missing, default or short
  db.js               schema, default settings, contact details, gallery rows, GCash QR, seed rooms
  routes/public.js    site data, availability, create/lookup/cancel booking, GCash QR, screenshot upload, release
  routes/admin.js     login, overview, bookings, schedule, blocks, rooms, settings, GCash payments and QR, Studio page (contact, gallery)
  lib/                time zone, scheduling rules, auth tokens, validation, photo checks and upload folder,
                      emv.js (QR with amount), payments.js (GCash states and receipt hints), receipts.js (private screenshots), mailer.js, throttle.js,
                      startup-checks.js (admin password and token secret rules, shared with check:env)
deploy/               scripts for running the site
  check-env.mjs       npm run check:env (PASS / WARN / FAIL checklist)
  backup.mjs          npm run backup
  verify-backup.mjs   npm run backup:verify
  lib.mjs             shared by the three scripts above (data folders, 7-Zip lookup)
  backup.ps1          runs one backup; started by the scheduled task
  schedule-backup.ps1 registers or removes the daily Windows backup task
  restore.md          how to restore from a backup
tests/                node --test suites (run them with the command below)
data/                 SQLite database (studio.db), uploads/ (gallery photos) and private/receipts/ (GCash screenshots), stay at the project root
backups/              default BACKUP_DIR (git-ignored)
docs/API.md           reference for every endpoint
tools/agents-api/     local API that runs the Claude Code agents
.env                  stays at the project root
```

The commands are the same from the project root: `npm run dev`, `npm run build`, `npm start`, `npm run seed:demo`, plus `npm run check:env`, `npm run backup` and `npm run backup:verify`. After pulling a move like this, run `npm install` again.

## Tests

```bash
npm test
```

`npm test` runs `node --test` one file at a time (the test files each start their own servers, so running them in parallel is flaky). Pointing `node --test` at the bare `tests/` folder fails on newer Node versions. The tests start the server on temporary databases and folders, so they never touch `data/studio.db`, your uploads or your receipts.

## Ideas for later

- SMS or Messenger notification when a booking is confirmed (e.g. Semaphore for SMS). Today notifications are by email only.
- Copy each backup off the machine automatically (another disk or cloud storage). Today that copy is made by hand.
- Automatic payment confirmation through a gateway (PayMongo for GCash/Maya/cards), so staff no longer check each GCash screenshot by hand. It would charge a percentage fee and need business registration documents.
