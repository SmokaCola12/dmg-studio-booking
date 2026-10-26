# DMG Studio — booking site

Website ng rehearsal studio na may online booking at staff admin. Hindi Shopify — sariling app ito: **Vite + React** sa frontend, **Express + SQLite (better-sqlite3)** sa backend. Iisang Node process lang pag naka-deploy.

## Ano ang laman

**Public site**
- Home: live na schedule ng araw (parang DAW — bawat room ay track, bawat booking ay clip, pulang linya = ngayon). Tap sa bakanteng oras → diretso sa booking.
- Rooms and rates, gallery, house rules, FAQ, map at contact.
- Booking flow (3 steps): room → date → ilang oras → start time → details → review. Automatic yung free hour promo kapag kasya.
- Booking code + "Add to calendar" (.ics) pagkatapos mag-book.
- **My booking** (`/check`): tingnan o i-cancel gamit ang code + mobile number (may cancellation cutoff).

**Admin** (`/admin`, password sa `.env`)
- **Today**: stats, mga booking na naghihintay ng approval (may quick Confirm), schedule ng araw, mga susunod na booking. May toast kapag may bagong online booking.
- **Bookings**: search (name, band, code, mobile), filter by status/room/date, at detail dialog: confirm, decline, done, no-show, reopen, ilipat ng oras/room, staff notes, GCash reference.
- **Schedule**: kahit anong araw; tap sa bakanteng oras para mag-add ng walk-in; **Block time** para sa repairs/private events.
- **Rooms**: rate, capacity, gear list, kulay sa schedule, show/hide sa website.
- **Settings**: opening hours, closed days, min/max hours, lead time, ilang araw in advance, cancellation cutoff, auto-confirm, free hour promo, GCash details.

## Patakbuhin

Kailangan: Node 20.12 pataas (Node 22 recommended).

```bash
npm install
cp .env.example .env        # palitan ang ADMIN_PASSWORD
npm run dev                 # API sa :4000, site sa http://localhost:5173
npm run seed:demo           # optional: sample bookings para may laman ang schedule
```

Para ma-test sa phone: buksan ang `http://<IP ng computer mo>:5173` (same Wi-Fi).

## Production

```bash
npm run build
npm start                   # isang port lang (PORT sa .env), kasama na ang site at API
```

Pwede sa kahit anong VPS o Node host na may persistent disk (Railway, Render with disk, DigitalOcean, Hostinger VPS). **Hindi pwede sa Vercel/Netlify static** kasi kailangan ng tumatakbong server at file para sa SQLite database (`data/studio.db`). I-backup ang file na iyon.

Sa likod ng Nginx o Caddy, i-proxy lang lahat papunta sa `PORT`.

## Saan papalitan ang content

| Ano | Saan |
| --- | --- |
| Pangalan, tagline, intro, address, map, phone, Messenger, socials, house rules, FAQ, gallery | `src/config/site.js` |
| Rooms, rates, gear, oras, promo, GCash | Admin → Rooms / Settings |
| Photos | ilagay sa `public/gallery/` tapos ilista sa `gallery` sa `src/config/site.js` |
| Kulay at fonts | tokens sa itaas ng `src/styles/base.css` |

Placeholder pa ang address, phone at photos.

## Paano gumagana ang booking rules

- Lahat ng oras ay naka-Asia/Manila (`STUDIO_TZ`). Whole hours ang slots.
- Ang **pending** at **confirmed** na bookings at mga **blocked time** ang humaharang sa slot. Kapag cancelled, bukas na ulit agad.
- Free hour promo: "Book X hours, get Y free", isang beses kada booking, idinadagdag lang kapag hindi tatama sa closing o sa susunod na booking. Ang server ang final na nagche-check (sa loob ng transaction), kaya walang double booking kahit sabay mag-book.
- Mobile numbers ay ini-store bilang `09XXXXXXXXX`; tinatanggap ang `+63`, may spaces o dashes.

## Structure

```
server/
  index.js            Express app (API + built site sa production)
  db.js               schema, default settings, seed rooms
  routes/public.js    site data, availability, create/lookup/cancel booking
  routes/admin.js     login, overview, bookings, schedule, blocks, rooms, settings
  lib/                time zone, scheduling rules, auth tokens, validation
src/
  config/site.js      studio content
  pages/              Home, Book, BookingDone, CheckBooking, admin/*
  components/         ScheduleBoard, Waveform, dialogs, form parts
  styles/             base, board, site, booking, admin
```

## Susunod na pwedeng idagdag

- SMS o Messenger notification kapag na-confirm ang booking (hal. Semaphore para sa SMS).
- Online payment (PayMongo para sa GCash/Maya/cards) para sa automatic downpayment.
- Half-hour slots, kung kailangan.
