# DMG Studio — booking site

A rehearsal studio website with online booking and a staff admin. Not Shopify — it's a custom app: **Vite + React** on the frontend, **Express + SQLite (better-sqlite3)** on the backend. One Node process when deployed.

## What's included

**Public site**
- Home: a booking card up top (pick a room and hours, pick a day on the month calendar, pick a start time, Book now), then a live schedule for the day styled like a DAW (each room is a track, each booking is a clip, the red line is now). Tap an open slot on the board to jump straight into booking.
- Rooms and rates, gallery, house rules, FAQ, map and contact. The contact details and gallery photos can be changed by the owner in admin.
- Booking flow: room → date → number of hours → start time → details → review. The free hour promo is applied automatically when it fits.
- Booking code and "Add to calendar" (.ics) after booking.
- **My booking** (`/check`): view, reschedule or cancel with the booking code and mobile number (subject to the cancellation cutoff).

**Admin** (`/admin`, password set in `.env`)
- **Today**: stats, bookings awaiting approval (with a quick Confirm), today's schedule and upcoming bookings. A toast appears when a new online booking comes in.
- **Bookings**: search (name, band, code, mobile), filter by status, room or date, and a detail dialog: confirm, decline, done, no-show, reopen, move to another time or room, staff notes, GCash reference.
- **Schedule**: any day; tap an open slot to add a walk-in; **Block time** for repairs or private events. Back-to-back bookings with less cleaning time than the setting are flagged with "Not enough cleaning time".
- **Rooms**: rate, capacity, gear list, schedule colour, show or hide on the website.
- **Settings**: opening hours, closed days, min/max hours, lead time, how far ahead people can book, cleaning time after each booking, cancellation cutoff, auto-confirm, free hour promo, GCash details.
- **Studio page** (`/admin/content`, linked from Settings and the sidebar on desktop): address, landmark, map search, phone, email, Messenger and social links, and the "Inside the studio" gallery photos.

## Run it locally

Requires Node 20.12 or newer (Node 22 recommended).

```bash
npm install
cp .env.example .env        # change ADMIN_PASSWORD
npm run dev                 # API on :4000, site on http://localhost:5173
npm run seed:demo           # optional: sample bookings so the schedule isn't empty
```

To test on a phone, open `http://<your computer's IP>:5173` (same Wi-Fi).

### Settings in `.env`

| Variable | What it does |
| --- | --- |
| `ADMIN_PASSWORD` | Password for `/admin`. If it is not set, the password is `changeme`, so change it before going live. |
| `ADMIN_TOKEN_SECRET` | Signs admin logins. Use a long random value so staff stay logged in after a restart. If it is not set, everyone is logged out on each restart. |
| `PORT` | Port for the API, and for the whole site in production. Default `4000`. |
| `STUDIO_TZ` | Time zone for bookings. Default `Asia/Manila`. |
| `DB_PATH` | Where the SQLite database file lives. Default `data/studio.db`. |
| `UPLOAD_DIR` | Where gallery photos are stored. Default `data/uploads`. On a host, point it at a folder on the persistent disk. |

## Production

```bash
npm run build
npm start                   # a single port (PORT in .env) serving both the site and the API
```

Works on any VPS or Node host with a persistent disk (Railway, Render with a disk, DigitalOcean, Hostinger VPS). **It will not work on static hosts like Vercel or Netlify**, because it needs a running server and a file for the SQLite database (`data/studio.db`) and the uploaded gallery photos in `data/uploads/` (or wherever `UPLOAD_DIR` points). Back up both. The photos are not in the database, and `data/uploads/` is git-ignored, so git won't keep a copy.

Behind Nginx or Caddy, just proxy everything to `PORT`.

## Changing content

| What | Where |
| --- | --- |
| Name, tagline, intro, house rules, FAQ, default address, map, phone, Messenger, socials | `frontend/src/config/site.js` (the defaults; the owner can override the contact details in admin) |
| Address, landmark, map search, phone, email, Messenger, socials, gallery photos | Admin → Studio page |
| Rooms, rates, gear, hours, promo, GCash | Admin → Rooms / Settings |
| Colours and fonts | tokens at the top of `frontend/src/styles/base.css` |

Until the owner fills in the Studio page, the site uses the defaults in `site.js`, and the address, phone and photos there are still placeholders. A blank field on the Studio page goes back to its default. With no photos uploaded, the gallery shows the labeled placeholders from `galleryPlaceholders` in `site.js`.

## Studio page: contact details and photos

Open **Admin → Studio page** (`/admin/content`). You can also reach it from the button at the top of **Settings**; on phones it is only there, not in the sidebar.

- **Contact details**: address (up to three lines), landmark, map search text, phone, email, Messenger link (`m.me`, `messenger.com` or `facebook.com`, starting with `https://`) and up to six social links. Clear a field to use the default again.
- **Gallery**: "Inside the studio" photos. You can add, caption, reorder and delete them. Up to 24 photos, each 5 MB or less, in JPEG, PNG or WebP. The browser resizes each photo to at most 1600 px on the long side and saves it as JPEG, so PNG and WebP work too and location data in the photo is removed.
- Photos are stored in `data/uploads/gallery/` (or `UPLOAD_DIR`), not in `studio.db`, and are served from `/media/gallery/`. Once any photo is uploaded, the gallery shows only the uploaded photos.

## How the booking rules work

- All times are in Asia/Manila (`STUDIO_TZ`). Bookings last whole hours and start at :00 or :30.
- **Pending** and **confirmed** bookings and **blocked time** take up a slot. A cancelled booking frees it again immediately.
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
    pages/            Home, Book, BookingDone, CheckBooking, admin/* (incl. Content.jsx for the Studio page)
    components/       ScheduleBoard, Waveform, dialogs, form parts
    styles/           base, board, site, booking, admin
  public/             favicon and other static files
backend/              Express API (:4000), serves frontend/dist in production
  index.js            Express app (API, /media photos, built site)
  db.js               schema, default settings, contact details, gallery rows, seed rooms
  routes/public.js    site data, availability, create/lookup/cancel booking
  routes/admin.js     login, overview, bookings, schedule, blocks, rooms, settings, Studio page (contact, gallery)
  lib/                time zone, scheduling rules, auth tokens, validation, photo checks and upload folder
data/                 SQLite database (studio.db) and uploads/ (gallery photos), stay at the project root
docs/API.md           reference for every endpoint
tools/agents-api/     local API that runs the Claude Code agents
.env                  stays at the project root
```

The commands are the same from the project root: `npm run dev`, `npm run build`, `npm start`, `npm run seed:demo`. After pulling a move like this, run `npm install` again.

## Ideas for later

- SMS or Messenger notification when a booking is confirmed (e.g. Semaphore for SMS).
- Online payment (PayMongo for GCash/Maya/cards) for automatic downpayments.
