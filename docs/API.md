# DMG Studio API

REST API served by the Express backend. All requests and responses are JSON. Base path is `/api`.

- **Public** endpoints need no login.
- **Admin** endpoints live under `/api/admin` and need `Authorization: Bearer <token>` (get one from `POST /api/admin/login`; tokens last 12 hours).
- Dates are `YYYY-MM-DD`. Hours are whole numbers 0 to 24 in the studio time zone (`STUDIO_TZ`, default `Asia/Manila`). Booking durations are whole hours. Start times are on the hour or half hour: `startHour` plus `startMinute` (0 or 30). A booking ends at `endHour:startMinute`.
- Errors look like `{ "error": "message" }`. Booking form validation errors also include `"fields": { "name": "message" }`.
- Mobile numbers are stored as `09XXXXXXXXX`; `+63`, spaces and dashes are accepted on input.

> Keep this file in sync with `backend/routes/public.js` and `backend/routes/admin.js`. The `technical-writer` agent updates it whenever an endpoint changes.

## Booking statuses

`pending`, `confirmed`, `completed`, `cancelled`, `no_show`. Pending and confirmed bookings, and blocked times, hold a slot. Cancelled frees it.

## Cleaning buffer

After every booking, `buffer_minutes` (a setting: 0, 30, 60, 90 or 120; default 30) is kept clear for cleaning. A new booking `[s, e)` clashes with an existing booking `b` in the same room when `s < b.end + buffer && b.start < e + buffer`. Blocks have no buffer and stay on whole hours. A booking must end by closing time; its buffer may run past closing. The free promo hour is only added when it and the buffer fit before the next booking.

- A buffer clash returns `409` with `{ error, code: 'buffer', bufferMinutes, gapMinutes }`, where `gapMinutes` is the smallest gap to the clashing booking. This applies to `POST /api/bookings`, `POST /api/bookings/reschedule`, `POST /api/admin/bookings` and `PATCH /api/admin/bookings/:id`.
- Staff can book through a clash with `overrideBuffer: true`, which is accepted only on `POST /api/admin/bookings` and `PATCH /api/admin/bookings/:id`. Customers can never override it. Overlapping bookings are still refused.
- Admin create and PATCH responses include `bufferWarning` next to `booking`: `{ bufferMinutes, gapMinutes, message }` when a clash was allowed, otherwise `null`.

---

## Public endpoints

### `GET /api/site`
Rooms and booking settings for the public site.

Response: `{ rooms: [{ id, name, description, hourlyRate, capacity, gear, color }], settings: { open_hour, close_hour, min_hours, max_hours, lead_time_hours, max_days_ahead, buffer_minutes, cancel_cutoff_hours, auto_confirm, promo_enabled, promo_buy_hours, promo_free_hours, gcash_enabled, gcash_name, gcash_number, closed_weekdays }, content: { contact, gallery }, now, timeZone }`

`content.contact` is `{ address: string[] | null, landmark, mapsQuery, phone, email, messenger, socials: [{ label, href }] | null }`. A field is `null` when the owner has not set it; the frontend then uses its built-in default. `content.gallery` is `[{ id, src, alt }]` in display order; `src` is a path like `/media/gallery/<uuid>.jpg`.

### `GET /media/gallery/<file>`
Serves an uploaded gallery photo (static, cached for 30 days, `X-Content-Type-Options: nosniff`). Unknown or malformed paths return `404`.

### `GET /api/availability?date=YYYY-MM-DD`
Busy hours per room for a day. `date` defaults to today.

Response: `{ date, now, window, rooms: [{ id, busy: [...] }] }`

- `busy` items are `{ start, end, kind, bufferEnd? }` in decimal hours (15.5 = 3:30 PM). Values are multiples of 0.5. `kind` is `booking` or `block`. `bufferEnd` is only on bookings: the end plus the cleaning buffer.
- `window.earliest` can be x.5, because the lead time rounds up to the next half hour.

Errors: `400` for a bad date.

### `GET /api/availability/month?month=YYYY-MM`
Read-only summary of every day in a month, for calendars. Uses the same rules as `/availability`: pending and confirmed bookings and blocks take a slot (a block with no room blocks every room), cancelled bookings do not. Start times are counted every 30 minutes, and the cleaning buffer counts as taken.

Response: `{ month, now, days: [{ date, status, freeHours, reason? }] }`, one entry per day.

- `closed`: the day cannot be booked (past, beyond `max_days_ahead`, closed weekday, or no slots left today). `reason` explains why; `freeHours` is 0.
- `full`: no active room has `min_hours` free in a row between the earliest start and closing.
- `few`: fewer than 3 bookable start times (on the :00 and :30 grid) across all active rooms.
- `open`: otherwise.

`freeHours` is the free hours summed across active rooms between the earliest start and closing. It can be x.5, and cleaning time is not counted as free.
Errors: `400` for a missing or malformed month.

### `POST /api/bookings`
Create an online booking. Status becomes `confirmed` if `auto_confirm` is on, otherwise `pending`. Availability is re-checked inside a database transaction, so concurrent requests cannot double-book.

Body:

| Field | Required | Notes |
| --- | --- | --- |
| `roomId` | yes | integer |
| `date` | yes | `YYYY-MM-DD` |
| `startHour` | yes | integer |
| `startMinute` | no | `0` or `30`, default `0`. Any other value is `400`. |
| `paidHours` | yes | integer; the free-hour promo is added automatically when it fits |
| `name` | yes | up to 80 chars |
| `phone` | yes | PH mobile number |
| `bandName` | no | up to 80 chars |
| `email` | no | validated |
| `headcount` | no | 1 to 30, default 1, cannot exceed room capacity |
| `notes` | no | up to 500 chars |
| `paymentMethod` | no | `gcash` (only if enabled) or `pay_at_studio` |
| `paymentRef` | no | up to 40 chars |

Response `201`: `{ booking, freeNote }`. `booking` has `code, room, date, startHour, startMinute, endHour, paidHours, freeHours, name, bandName, phone, email, headcount, notes, paymentMethod, paymentRef, hourlyRate, total, status, canCancel, createdAt`.
Errors: `400` with `fields` for invalid input, `409` if the slot is taken or the rules are not met. A cleaning buffer clash is `409` with `code: 'buffer'` (see [Cleaning buffer](#cleaning-buffer)).

### `POST /api/bookings/lookup`
Body: `{ code, phone }`. Response: `{ booking }`. `404` if the code and mobile number do not match.

### `POST /api/bookings/cancel`
Body: `{ code, phone }`. Response: `{ booking }` with status `cancelled`.
Errors: `404` no match; `409` if inside the cancellation cutoff (`cancel_cutoff_hours`).

### `POST /api/bookings/reschedule`
Body: `{ code, phone, date, startHour, startMinute? }` (`startMinute` is `0` or `30`, default `0`). Keeps the room and paid hours; the free promo hour is recalculated for the new slot. Response: `{ booking, freeNote }`.
Errors: `400` bad date, invalid `startMinute`, or same time as now; `404` no match; `409` inside the cancellation cutoff, or the new time is taken, closed, past closing or inside another booking's cleaning buffer (`code: 'buffer'`, no override for customers).

---

## Admin endpoints (`/api/admin`)

### `POST /api/admin/login`
Body: `{ password }`. Response: `{ token }`.
Errors: `401` wrong password; `429` after 10 failed attempts from one IP in 15 minutes.

Everything below needs the bearer token. Missing or expired token returns `401`.

### `GET /api/admin/overview`
Dashboard data: `{ now, today: [booking], pending: [booking], pendingCount, week: { from, to, total, n }, month: { from, to, total, n }, upcoming: [booking] }`. Revenue counts `confirmed` and `completed` bookings.

### Bookings

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/bookings` | List with filters: `status`, `room`, `from`, `to`, `q` (code, name, band, phone, email), `sort` (`created`, `asc`, default newest date first), `limit` (max 200, default 50), `offset`. Response: `{ total, limit, offset, bookings }`. |
| `GET` | `/bookings/:id` | One booking. `404` if missing. |
| `POST` | `/bookings` | Walk-in or phone booking. Skips lead time, status `confirmed`, source `walk_in`. Body like the public one (including `startMinute`), plus optional `adminNotes` and `overrideBuffer: true` to book inside another booking's cleaning buffer; `phone` may be empty. Response `201`: `{ booking, bufferWarning }`. `409` if the slot is taken, or `code: 'buffer'` if it breaks the cleaning buffer and `overrideBuffer` is not set. |
| `PATCH` | `/bookings/:id` | Change `status`, `adminNotes`, `paymentRef`, or reschedule with `roomId`, `date`, `startHour`, `startMinute`, `paidHours` (price is recalculated) and `overrideBuffer: true`. `startHour` without `startMinute` means `:00`; with neither, the start time is kept. Reopening a cancelled booking re-checks the slot and the buffer. Response: `{ booking, bufferWarning }`. `409` with `code: 'buffer'` when the buffer clashes and `overrideBuffer` is not set. |

Admin `booking` objects add `id, roomId, roomName, roomColor, source, adminNotes, updatedAt`. They include `startMinute` as well.

### Schedule and blocked time

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/schedule?date=` | Day view: `{ date, now, settings, rooms, bookings, blocks, bufferConflicts }`. `bufferConflicts` lists back-to-back bookings in one room with less than `buffer_minutes` between them: `[{ roomId, bookingIds: [a, b], gapMinutes }]`. Pending, confirmed and completed bookings are checked; cancelled and no-show are ignored. Usually these come from bookings made before the buffer existed, or from staff overrides. |
| `GET` | `/calendar?month=YYYY-MM` | Counts for the staff calendar: `{ month, days: { "YYYY-MM-DD": { bookings, pending, blocks } } }`. Pending, confirmed and completed bookings count; cancelled and no-show do not. Days with nothing are left out. Defaults to the current month. `400` for a bad month. |
| `POST` | `/blocks` | Block time. Body: `{ roomId (null = all rooms), date, startHour, endHour, reason }`. Blocks are whole hours and have no cleaning buffer. The check and the insert run in one transaction. Response `201`: `{ id }`. `409` if a booking is in that time. |
| `DELETE` | `/blocks/:id` | Remove a block. Response: `{ ok: true }`. |

### Rooms

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/rooms` | All rooms, including hidden ones. |
| `POST` | `/rooms` | Create. Body: `{ name, description, hourlyRate, capacity, gear: [string], color: "#RRGGBB", active, sortOrder }`. Response `201`: `{ room }`. |
| `PUT` | `/rooms/:id` | Replace a room's fields (same body). `404` if missing. |
| `DELETE` | `/rooms/:id` | Delete. `409` if the room has any bookings on record; hide it instead (`active: false`). |

### Settings

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/settings` | `{ settings }`. |
| `PUT` | `/settings` | Update any subset of the settings keys: opening hours, `closed_weekdays` (0 to 6), min and max hours, lead time, days ahead, `buffer_minutes` (must be `0`, `30`, `60`, `90` or `120`, else `400`), cancellation cutoff, `auto_confirm`, free-hour promo, GCash details. `400` if the values are inconsistent (for example closing before opening). |

### Studio page content (contact details and gallery)

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/content` | `{ contact, gallery: [{ id, src, alt, sortOrder }] }`. Unset contact fields are `null`. |
| `PUT` | `/content/contact` | Partial update of `{ address: [string] (1-3 lines, 120 chars each), landmark (max 200), mapsQuery (max 200), phone, email, messenger, socials: [{ label (max 30), href }] (max 6) }`. An empty string, `null` or an empty list (`address`, `socials`) removes the value (back to the default). `address`, `landmark` and `mapsQuery` must not contain control characters. Links must be `https://`; `messenger` must be on m.me, messenger.com or facebook.com. Response: `{ contact }`. `400` with `{ error, fields: { name: message } }`. |
| `POST` | `/gallery?alt=<urlencoded text>` | Upload one photo. Send the raw bytes as the body with `Content-Type: image/jpeg`, `image/png` or `image/webp` (max 5 MB, type checked by file signature). The server picks the file name. Response `201`: `{ photo: { id, src, alt, sortOrder } }`. `415` wrong type, `413` too large, `409` when the gallery already has 24 photos, `400` if `alt` is over 160 characters. |
| `PATCH` | `/gallery/:id` | Body `{ alt }` (max 160). Response: `{ photo }`. `404` if missing. |
| `PUT` | `/gallery/order` | Body `{ ids: [3, 1, 2] }`, which must list every current photo id exactly once. Response: `{ gallery }`. `400` otherwise. |
| `DELETE` | `/gallery/:id` | Delete the photo and its file. Response: `{ ok: true }`. `404` if missing. |

Uploaded files are stored in `UPLOAD_DIR` (default `data/uploads`, photos under `gallery/`), not in the database.

## Out of scope

There is no public endpoint for payments, SMS or Messenger yet. They are listed under "next" in the README.

## Agents API

The agents have their own local API, separate from this one. See [`tools/agents-api/README.md`](../tools/agents-api/README.md).
