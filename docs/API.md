# DMG Studio API

REST API served by the Express backend. All requests and responses are JSON. Base path is `/api`.

- **Public** endpoints need no login.
- **Admin** endpoints live under `/api/admin` and need `Authorization: Bearer <token>` (get one from `POST /api/admin/login`; tokens last 12 hours).
- Dates are `YYYY-MM-DD`. Hours are whole numbers 0 to 24 in the studio time zone (`STUDIO_TZ`, default `Asia/Manila`).
- Errors look like `{ "error": "message" }`. Booking form validation errors also include `"fields": { "name": "message" }`.
- Mobile numbers are stored as `09XXXXXXXXX`; `+63`, spaces and dashes are accepted on input.

> Keep this file in sync with `backend/routes/public.js` and `backend/routes/admin.js`. The `technical-writer` agent updates it whenever an endpoint changes.

## Booking statuses

`pending`, `confirmed`, `completed`, `cancelled`, `no_show`. Pending and confirmed bookings, and blocked times, hold a slot. Cancelled frees it.

---

## Public endpoints

### `GET /api/site`
Rooms and booking settings for the public site.

Response: `{ rooms: [{ id, name, description, hourlyRate, capacity, gear, color }], settings: { open_hour, close_hour, min_hours, max_hours, lead_time_hours, max_days_ahead, cancel_cutoff_hours, auto_confirm, promo_enabled, promo_buy_hours, promo_free_hours, gcash_enabled, gcash_name, gcash_number, closed_weekdays }, now, timeZone }`

### `GET /api/availability?date=YYYY-MM-DD`
Busy hours per room for a day. `date` defaults to today.

Response: `{ date, now, window, rooms: [{ id, busy: [...] }] }`
Errors: `400` for a bad date.

### `POST /api/bookings`
Create an online booking. Status becomes `confirmed` if `auto_confirm` is on, otherwise `pending`. Availability is re-checked inside a database transaction, so concurrent requests cannot double-book.

Body:

| Field | Required | Notes |
| --- | --- | --- |
| `roomId` | yes | integer |
| `date` | yes | `YYYY-MM-DD` |
| `startHour` | yes | integer |
| `paidHours` | yes | integer; the free-hour promo is added automatically when it fits |
| `name` | yes | up to 80 chars |
| `phone` | yes | PH mobile number |
| `bandName` | no | up to 80 chars |
| `email` | no | validated |
| `headcount` | no | 1 to 30, default 1, cannot exceed room capacity |
| `notes` | no | up to 500 chars |
| `paymentMethod` | no | `gcash` (only if enabled) or `pay_at_studio` |
| `paymentRef` | no | up to 40 chars |

Response `201`: `{ booking, freeNote }`. `booking` has `code, room, date, startHour, endHour, paidHours, freeHours, name, bandName, phone, email, headcount, notes, paymentMethod, paymentRef, hourlyRate, total, status, canCancel, createdAt`.
Errors: `400` with `fields` for invalid input, `409` if the slot is taken or the rules are not met.

### `POST /api/bookings/lookup`
Body: `{ code, phone }`. Response: `{ booking }`. `404` if the code and mobile number do not match.

### `POST /api/bookings/cancel`
Body: `{ code, phone }`. Response: `{ booking }` with status `cancelled`.
Errors: `404` no match; `409` if inside the cancellation cutoff (`cancel_cutoff_hours`).

### `POST /api/bookings/reschedule`
Body: `{ code, phone, date, startHour }`. Keeps the room and paid hours; the free promo hour is recalculated for the new slot. Response: `{ booking, freeNote }`.
Errors: `400` bad date or same time as now; `404` no match; `409` inside the cancellation cutoff, or the new time is taken, closed or past closing.

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
| `POST` | `/bookings` | Walk-in or phone booking. Skips lead time, status `confirmed`, source `walk_in`. Body like the public one, plus optional `adminNotes`; `phone` may be empty. Response `201`: `{ booking }`. `409` if the slot is taken. |
| `PATCH` | `/bookings/:id` | Change `status`, `adminNotes`, `paymentRef`, or reschedule with `roomId`, `date`, `startHour`, `paidHours` (price is recalculated). Reopening a cancelled booking re-checks the slot. Response: `{ booking }`. |

Admin `booking` objects add `id, roomId, roomName, roomColor, source, adminNotes, updatedAt`.

### Schedule and blocked time

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/schedule?date=` | Day view: `{ date, now, settings, rooms, bookings, blocks }`. |
| `POST` | `/blocks` | Block time. Body: `{ roomId (null = all rooms), date, startHour, endHour, reason }`. Response `201`: `{ id }`. `409` if a booking is in that time. |
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
| `PUT` | `/settings` | Update any subset of the settings keys: opening hours, `closed_weekdays` (0 to 6), min and max hours, lead time, days ahead, cancellation cutoff, `auto_confirm`, free-hour promo, GCash details. `400` if the values are inconsistent (for example closing before opening). |

## Out of scope

There is no public endpoint for payments, SMS or Messenger yet. They are listed under "next" in the README.

## Agents API

The agents have their own local API, separate from this one. See [`tools/agents-api/README.md`](../tools/agents-api/README.md).
