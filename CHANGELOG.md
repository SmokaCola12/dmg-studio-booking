# Changelog

All notable changes to DMG Studio are recorded here, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every pull request adds a line under **Unreleased**; the `technical-writer` agent keeps it tidy and `github-specialist` checks it before a PR.

Categories: **Added**, **Changed**, **Fixed**, **Removed**, **Security**.

## [Unreleased]

### Changed
- The server now refuses to start without `--dev` (exit code 1, one `[startup] Refusing to start: ...` line) when `ADMIN_PASSWORD` is missing, blank, `changeme`, the `.env.example` placeholder or shorter than 8 characters; there is no `changeme` fallback outside `npm run dev`. A missing or short (under 32 characters) `ADMIN_TOKEN_SECRET` only warns. Values are never logged.
- Customer and admin wording says "studio" instead of "room" everywhere (pages, admin, server messages and emails). Code names and API fields (`rooms`, `roomId`) are unchanged, and studio names saved in the database are left as typed.
- The line "30 min is kept after each session for cleaning." is no longer shown on the Book page, the home booking card or the reschedule dialog. The cleaning gap itself still applies.
- GCash: the manual "send to our number and type a reference" option is replaced by a QR in Settings. The studio uploads its GCash QR once and every GCash booking gets a QR with the exact amount; `gcash_name` and `gcash_number` are no longer shown to customers or returned by `GET /api/site` (the stored values are kept and shown read-only to staff), and `paymentRef` is now ignored on `POST /api/bookings` (the reference number comes with the screenshot). Older manual GCash bookings stay readable under the "Older" filter. `gcash_enabled` now also needs a stored QR.
- Customers can no longer cancel a GCash booking online once a screenshot was sent or the payment was received (`canCancel` is `false`, `409` with a "message the studio" note); they can still reschedule (new `canReschedule`). Cancelling a booking that took money sets it to "refund due" for staff.
- Admin Confirm and "Reopen as confirmed" are refused for a GCash booking until its deposit is received (`PATCH /api/admin/bookings/:id` returns `409` with `code: "gcash_payment_required"`); the booking dialog and Today page link to GCash payments instead.
- New booking status `expired` (a pending GCash booking whose hold ran out). `/api/admin/overview` `pending` counts GCash bookings still waiting for a screenshot. Booking code + phone matches are now rate limited: 30 failed matches per 15 minutes per IP (`LOOKUP_FAIL_LIMIT`), shared by lookup, cancel, reschedule and every payment route; an IP over the limit gets `429` even with a correct code and phone.
- The error handler no longer logs request bodies or error objects: body-parser errors are answered before anything is logged, and other errors log only the kind and message.
- `TRUST_PROXY` (new, default `1`) sets how many reverse proxies are trusted for the client IP used by the rate limits.
- Cleaning buffer: start times can be :00 or :30, and `buffer_minutes` (admin setting "Cleaning time after each booking", default 30, 0/30/60/90/120) is kept clear after every booking, so customers lose that gap after existing live bookings when this deploys; existing bookings are not moved or cancelled, and back-to-back pairs show a warning on the admin Schedule.
- "Book a room" is now just "Book" on the home page hero, the nav button, the Book page title and the page description.
- Default address, landmark and map are now the studio's real location (10-U-A Baltazar St, Grace Park West, Caloocan, near 5th Avenue LRT Station).
- Book page: arriving from the home card with a time already picked now opens on "Your details" (no tour popup); "Change room, day or time" goes back to the picker. If the time no longer fits, it returns to the picker with a notice.
- "How to book" tour: new animated calendar picture and updated steps for the home card and the Book page (the old Today / Tomorrow / Other picture is gone).
- Book page: the day picker is now the same month calendar as the home page card (open and few-left markers, full and closed days greyed), replacing the scrolling date strip and the "Or pick a date" popup. Calendar and start times now sit together under "Date and time", with the same "N left" time chips as the home card.
- Home page now opens with a plain booking card (room, hours, month calendar with open/few/full markers, start-time chips, "Book now" to /book with room, date, hours and start prefilled); the live board moves below it and the tour no longer opens by itself on Home. /book accepts a `hours` query param.
- Date picker: "Or pick a date" and "Other date" open a small themed calendar instead of the browser one; days you cannot book are greyed.
- Book page list: shows only taken hours and your pick (no "open" rows), top to bottom; "Your booking" is now "Your pick · N hr" and "Free" is "Bonus hour · free", so rows are not mistaken for existing bookings.
- Phone only (640px and under): nav links, day and List/Timeline switchers, "How to book" and dialog close buttons are now at least 44px tall for easier tapping. Tablet and desktop are unchanged.
- README rewritten in English (was Taglish) and now mentions rescheduling in My booking.
- Book page: the time preview has the same List / Timeline switcher as the home page; on phones the day switcher fits without scrolling.
- Phone layout: open slots in the list view show the Book button beside the time, the reschedule link is a full-width card, and dialogs get a bottom-sheet grab handle.
- Split the project into `frontend/` (Vite + React) and `backend/` (Express + SQLite) folders, managed as npm workspaces. Commands are unchanged (`npm run dev`, `build`, `start`, `seed:demo`); run `npm install` after pulling. `.env` and `data/` stay at the project root.

### Added
- `npm run check:env`: pre-deployment checklist that prints PASS / WARN / FAIL per setting by name only (no values, no paths) and exits with code 1 on any FAIL.
- Backups: `npm run backup` (online-consistent database copy, gallery uploads and private receipts in a `dmg-backup-YYYYMMDD-HHMMSS` folder under `BACKUP_DIR`, default `backups/`, git-ignored; optional AES-256 `.7z` with `BACKUP_PASSPHRASE` and 7-Zip; keeps the newest per day for 30 days and per month for 6 months; `backup.log`), `npm run backup:verify -- <path>` (read-only integrity check and counts), `deploy/schedule-backup.ps1` (daily 04:30 Windows task, registered only after typing YES) and the restore steps in `deploy/restore.md`. New optional `BACKUP_DIR`, `BACKUP_PASSPHRASE` and `SEVENZIP_PATH`.
- GCash screenshot payments with no gateway and no fee. A customer chooses **Pay 50%** or **Pay 100%** ("Book for ₱…"); the booking is `pending` and holds its slot for `gcash_hold_minutes` (default 30) while the customer scans a QR with the exact amount (`POST /api/bookings/payment-qr`) and uploads a receipt screenshot (`POST /api/bookings/payment-proof`, JPEG/PNG/WebP, 15 MB, up to 3). "Pay later" (`POST /api/bookings/release`) frees the slot; with no screenshot in time the booking becomes `expired` and the slot is freed. A new `/booking/:code/pay` page, plus payment notes on My booking and the booking page, show where a payment stands (`payment` object and `stage` on every booking, `serverTime` for the countdown).
- Admin **GCash payments** page: every GCash booking with its screenshots (private, admin-only) and history. **Received & Confirmed**, **Not yet received** (no auto-cancel; the customer can upload again), balance recording for 50% bookings (**paid at the studio (cash)** or **paid in GCash**, which needs a screenshot) that marks the booking **PAID**, top-up when the total goes up, and **Refund recorded**. Backed by `/api/admin/payments/*`; a badge on the sidebar and `overview.paymentsWaiting` count screenshots to check. Each action is saved in an audit trail (optional `staffName`).
- Settings: upload the studio's GCash QR once (decoded in the browser, stored privately, only a masked summary is shown) with a "Test QR (₱1.00)" preview (`/api/admin/settings/gcash-qr`), plus `gcash_hold_minutes` and `receipt_retention_days` (default 60).
- Payment emails (confirmed, not yet received, hold expired) through Gmail with `SMTP_USER` and `SMTP_PASS`, sent only when the customer gave an email. Email is skipped when those are not set and never blocks an action. New optional `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT` and `PUBLIC_SITE_URL`.
- Email notifications to the studio inbox: one email for each new booking made on the website, each GCash receipt upload, and each customer cancel or reschedule online (not for walk-ins, Pay later, hold expiry or staff actions). Admin Settings has a new "Email notifications" section with the recipient (`notify_email`, empty = `SMTP_USER`), three switches (`notify_new_booking`, `notify_payment_proof`, `notify_customer_changes`, default on) and **Send test email** (`POST /api/admin/settings/test-email`, limited by the new `TEST_EMAIL_RATE_LIMIT`, default 5 per 10 minutes). `GET` and `PUT /api/admin/settings` now return `mail: { configured, notifyTo }`, `PUBLIC_SITE_URL` also adds an admin link to studio emails, and SMTP connections now time out (15 s to connect, 30 s idle).
- Receipt screenshots are stored in `RECEIPT_DIR` (default `data/private/receipts`, git-ignored) and deleted after `receipt_retention_days`.
- Tests for GCash payments, the QR code with amount and the mailer (`tests/gcash-payments.test.js`, `tests/emv.test.js`, `tests/mailer.test.js`); run with `node --test tests/*.test.js`.
- Contact details (address, landmark, map search, phone, email, Messenger, social links) are editable by the owner; `GET /api/site` returns them as `content.contact` and `PUT /api/admin/content/contact` saves them (unset values fall back to the site defaults).
- Gallery uploads: the owner can add, caption, reorder and delete "Inside the studio" photos (`/api/admin/gallery`, up to 24 photos, JPEG/PNG/WebP, 5 MB each), served from `/media/gallery/`. Files live in `UPLOAD_DIR` (default `data/uploads/`, git-ignored).
- Admin Today page: a month calendar above the rooms board that shows how many bookings each day has (orange when some are waiting for approval); tap a day to see that day's rooms. Backed by `GET /api/admin/calendar?month=YYYY-MM`.
- `GET /api/availability/month?month=YYYY-MM`: per-day status (open, few, full, closed) for a whole month, for calendars.
- Customers can reschedule from My booking: `POST /api/bookings/reschedule` moves the date and start time (same room and hours, same cutoff as cancelling), with an animated walkthrough and a "Need to reschedule?" link on the home page.
- `docs/API.md`: reference for every public and admin endpoint.
- `CHANGELOG.md`: this file.
- `tools/agents-api/`: local HTTP API to list and run the project agents through the Claude Agent SDK (list, run, stream events, cancel, history).
- GCash pay page reads the receipt screenshot in the customer's browser (OCR, no third-party service) and pre-fills the reference number and shows the amount found; staff see these as admin-only hints with a flag for a reference used on another booking (`X-Receipt-Ref`, `X-Receipt-Amount`, `payment.receiptCheck`).
- OCR engine files are copied from `node_modules` into `frontend/public/ocr` before `npm run dev` and `npm run build` (git-ignored, about 15 MB).

### Security
- `.env.example` now has a placeholder `ADMIN_PASSWORD` that the server rejects. The example password in earlier versions of `.env.example` is in the git history and therefore public: any install still using it must change it now.
- GCash receipts hold names and phone numbers, so they are stored outside `/media` in a private folder (the server refuses to start if `RECEIPT_DIR` is inside `UPLOAD_DIR` or `frontend/dist`), checked by file signature against the declared type, saved under random names, and only ever streamed to a logged-in admin (`nosniff`, `Content-Security-Policy: default-src 'none'`, `no-store`).
- The studio's GCash QR text (it holds the owner's account details) is stored apart from the ordinary settings and is never returned, logged or sent to the public; staff see a masked summary and customers see one drawn QR per booking.
- Customer uploads need the booking code and phone (sent in headers, not the URL), are rate limited per IP (`UPLOAD_RATE_LIMIT`, `LOOKUP_FAIL_LIMIT`), and the limit, booking and content-type checks run before the image is read, so an anonymous client cannot make the server buffer 15 MB per request.
- Gallery uploads are admin-only, limited to 5 MB and 24 photos, accept only JPEG, PNG and WebP (checked by file signature, no GIF or SVG), are stored under server-generated names outside the database, and are served with `nosniff`; `/media` cannot reach files outside the upload folder.

### Removed
- Admin Today page: the separate "Waiting for approval" list; waiting bookings now show beside the calendar for the picked day, and the count stays in the stats and the Bookings badge.
- Public Home and Book pages and the admin Today page no longer offer the List view; they show the timeline only. The admin Schedule page keeps both.

## [1.0.0]

### Added
- Public site: live schedule of the day (DAW style), rooms and rates, gallery, house rules, FAQ, map and contact.
- Three-step booking flow with automatic free-hour promo, booking code and `.ics` calendar download.
- "My booking" page to look up or cancel a booking with the code and mobile number.
- Admin dashboard: today, bookings (search, filters, confirm, decline, reschedule, notes), schedule with walk-ins and blocked time, rooms, and settings.
- Express and SQLite backend with server-side double-booking protection.
