# DMG Studio — booking site

A rehearsal studio website with online booking and a staff admin. Not Shopify — it's a custom app: **Vite + React** on the frontend, **Express + SQLite (better-sqlite3)** on the backend. One Node process when deployed.

## What's included

**Public site**
- Home: a live schedule for the day, styled like a DAW (each room is a track, each booking is a clip, the red line is now). Tap an open slot to jump straight into booking.
- Rooms and rates, gallery, house rules, FAQ, map and contact.
- Booking flow: room → date → number of hours → start time → details → review. The free hour promo is applied automatically when it fits.
- Booking code and "Add to calendar" (.ics) after booking.
- **My booking** (`/check`): view, reschedule or cancel with the booking code and mobile number (subject to the cancellation cutoff).

**Admin** (`/admin`, password set in `.env`)
- **Today**: stats, bookings awaiting approval (with a quick Confirm), today's schedule and upcoming bookings. A toast appears when a new online booking comes in.
- **Bookings**: search (name, band, code, mobile), filter by status, room or date, and a detail dialog: confirm, decline, done, no-show, reopen, move to another time or room, staff notes, GCash reference.
- **Schedule**: any day; tap an open slot to add a walk-in; **Block time** for repairs or private events.
- **Rooms**: rate, capacity, gear list, schedule colour, show or hide on the website.
- **Settings**: opening hours, closed days, min/max hours, lead time, how far ahead people can book, cancellation cutoff, auto-confirm, free hour promo, GCash details.

## Run it locally

Requires Node 20.12 or newer (Node 22 recommended).

```bash
npm install
cp .env.example .env        # change ADMIN_PASSWORD
npm run dev                 # API on :4000, site on http://localhost:5173
npm run seed:demo           # optional: sample bookings so the schedule isn't empty
```

To test on a phone, open `http://<your computer's IP>:5173` (same Wi-Fi).

## Production

```bash
npm run build
npm start                   # a single port (PORT in .env) serving both the site and the API
```

Works on any VPS or Node host with a persistent disk (Railway, Render with a disk, DigitalOcean, Hostinger VPS). **It will not work on static hosts like Vercel or Netlify**, because it needs a running server and a file for the SQLite database (`data/studio.db`). Back that file up.

Behind Nginx or Caddy, just proxy everything to `PORT`.

## Changing content

| What | Where |
| --- | --- |
| Name, tagline, intro, address, map, phone, Messenger, socials, house rules, FAQ, gallery | `frontend/src/config/site.js` |
| Rooms, rates, gear, hours, promo, GCash | Admin → Rooms / Settings |
| Photos | put them in `frontend/public/gallery/`, then list them under `gallery` in `frontend/src/config/site.js` |
| Colours and fonts | tokens at the top of `frontend/src/styles/base.css` |

The address, phone and photos are still placeholders.

## How the booking rules work

- All times are in Asia/Manila (`STUDIO_TZ`). Slots are whole hours.
- **Pending** and **confirmed** bookings and **blocked time** take up a slot. A cancelled booking frees it again immediately.
- Free hour promo: "Book X hours, get Y free", once per booking, added only when it doesn't run past closing or into the next booking. The server makes the final check inside a transaction, so double bookings can't happen even when two people book at once.
- Mobile numbers are stored as `09XXXXXXXXX`; `+63`, spaces and dashes are accepted on input.

## Structure

```
frontend/             Vite + React (site at :5173 in dev)
  src/
    config/site.js    studio content
    pages/            Home, Book, BookingDone, CheckBooking, admin/*
    components/       ScheduleBoard, Waveform, dialogs, form parts
    styles/           base, board, site, booking, admin
  public/             favicon, gallery photos
backend/              Express API (:4000), serves frontend/dist in production
  index.js            Express app (API + built site)
  db.js               schema, default settings, seed rooms
  routes/public.js    site data, availability, create/lookup/cancel booking
  routes/admin.js     login, overview, bookings, schedule, blocks, rooms, settings
  lib/                time zone, scheduling rules, auth tokens, validation
data/                 SQLite database (studio.db), stays at the project root
docs/API.md           reference for every endpoint
tools/agents-api/     local API that runs the Claude Code agents
.env                  stays at the project root
```

The commands are the same from the project root: `npm run dev`, `npm run build`, `npm start`, `npm run seed:demo`. After pulling a move like this, run `npm install` again.

## Ideas for later

- SMS or Messenger notification when a booking is confirmed (e.g. Semaphore for SMS).
- Online payment (PayMongo for GCash/Maya/cards) for automatic downpayments.
- Half-hour slots, if needed.
