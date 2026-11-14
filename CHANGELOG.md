# Changelog

All notable changes to DMG Studio are recorded here, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every pull request adds a line under **Unreleased**; the `technical-writer` agent keeps it tidy and `github-specialist` checks it before a PR.

Categories: **Added**, **Changed**, **Fixed**, **Removed**, **Security**.

## [Unreleased]

### Changed
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
- Contact details (address, landmark, map search, phone, email, Messenger, social links) are editable by the owner; `GET /api/site` returns them as `content.contact` and `PUT /api/admin/content/contact` saves them (unset values fall back to the site defaults).
- Gallery uploads: the owner can add, caption, reorder and delete "Inside the studio" photos (`/api/admin/gallery`, up to 24 photos, JPEG/PNG/WebP, 5 MB each), served from `/media/gallery/`. Files live in `UPLOAD_DIR` (default `data/uploads/`, git-ignored).
- Admin Today page: a month calendar above the rooms board that shows how many bookings each day has (orange when some are waiting for approval); tap a day to see that day's rooms. Backed by `GET /api/admin/calendar?month=YYYY-MM`.
- `GET /api/availability/month?month=YYYY-MM`: per-day status (open, few, full, closed) for a whole month, for calendars.
- Customers can reschedule from My booking: `POST /api/bookings/reschedule` moves the date and start time (same room and hours, same cutoff as cancelling), with an animated walkthrough and a "Need to reschedule?" link on the home page.
- `docs/API.md`: reference for every public and admin endpoint.
- `CHANGELOG.md`: this file.
- `tools/agents-api/`: local HTTP API to list and run the project agents through the Claude Agent SDK (list, run, stream events, cancel, history).

### Security
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
