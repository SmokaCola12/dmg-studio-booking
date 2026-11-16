# DMG Studio API

REST API served by the Express backend. All requests and responses are JSON. Base path is `/api`.

- **Public** endpoints need no login.
- **Admin** endpoints live under `/api/admin` and need `Authorization: Bearer <token>` (get one from `POST /api/admin/login`; tokens last 12 hours).
- Dates are `YYYY-MM-DD`. Hours are whole numbers 0 to 24 in the studio time zone (`STUDIO_TZ`, default `Asia/Manila`). Booking durations are whole hours. Start times are on the hour or half hour: `startHour` plus `startMinute` (0 or 30). A booking ends at `endHour:startMinute`.
- Errors look like `{ "error": "message" }`. Booking form validation errors also include `"fields": { "name": "message" }`.
- Mobile numbers are stored as `09XXXXXXXXX`; `+63`, spaces and dashes are accepted on input.

> Keep this file in sync with `backend/routes/public.js` and `backend/routes/admin.js`. The `technical-writer` agent updates it whenever an endpoint changes.

## Booking statuses

`pending`, `confirmed`, `completed`, `cancelled`, `no_show`, `expired`. Pending and confirmed bookings, and blocked times, hold a slot. Cancelled and expired free it.

`expired` is only used by GCash bookings: a pending GCash booking whose hold ran out before a screenshot was uploaded (see [GCash payments](#gcash-payments)). It cannot be set through the API (`PATCH` with `status: "expired"` is `400`).

The single rule behind every slot check (availability, the month view, walk-ins, blocks, reschedules, the cleaning buffer): a booking holds its slot when its status is `pending` or `confirmed`, **except** a pending booking whose `hold_expires_at` has passed. That holds even before the one-minute sweep has marked it `expired`.

## GCash payments

Customers can pay 50% or 100% of a booking by GCash. There is no payment gateway: the studio uploads its own GCash (InstaPay QR Ph) QR once, each booking gets a QR with the exact amount in it, the customer uploads a screenshot of their receipt, and staff check the payment in the GCash app and confirm it in admin.

**Flow**

1. `POST /api/bookings` with `paymentMethod: "gcash"` and `paymentPlan: "half"` or `"full"`. The booking is created `pending` (whatever `auto_confirm` says) with `payment.stage` `awaiting_proof`, and holds its slot for `gcash_hold_minutes` (default 30).
2. The customer scans the QR from `POST /api/bookings/payment-qr`, pays, and uploads a screenshot with `POST /api/bookings/payment-proof`. The booking stays `pending` (`proof_submitted`) and the hold is cleared: the slot is held until staff act.
3. Staff open GCash Payments in admin and press **Received & Confirmed** (booking becomes `confirmed`, payment `received`) or **Not yet received** (stays `pending`, `not_received`, no auto-cancel; the customer can upload another screenshot).
4. For a 50% booking, staff later record the balance as cash or GCash (GCash needs a screenshot). The booking then reads `paid`. A 100% booking reads `paid` as soon as it is confirmed.
5. No screenshot within the hold time: the booking becomes `expired` and the slot is free again. "Pay later" (`POST /api/bookings/release`) gives the slot back at once (`cancelled`). A late screenshot on an expired booking revives it if the slot is still free, otherwise it is `409` with `code: "slot_taken"`.

**Amounts.** Whole pesos. `full` = the booking total. `half` = half of the total rounded up to a whole peso. The balance of a 50% booking is `total - paid - balance recorded`.

**The `payment` object.** Every public and admin booking has `payment`:

```
payment: {
  method,            // 'pay_at_studio' | 'gcash'
  plan,              // '' | 'half' | 'full'   ('' for pay-at-studio and older manual GCash bookings)
  amountDue,         // pesos due by GCash now
  paidAmount,        // pesos staff confirmed as received
  balanceDue,        // pesos still to pay; 0 until the deposit is received
  balancePaid,       // pesos recorded for the balance
  balanceMethod,     // '' | 'cash' | 'gcash'
  status,            // '' | awaiting_proof | proof_submitted | not_received | received
  stage,             // see below
  paidInFull,        // true once everything is paid
  holdExpiresAt,     // UTC ISO time, or null
  proofSubmittedAt,  // UTC ISO time, or null
  proofCount,        // customer screenshots on file (balance screenshots are not counted)
  canUploadProof,    // the customer can upload a (another) screenshot now
  refundStatus,      // '' | refund_due | refunded
  canRefund          // admin view only: a refund can be recorded (always false for customers)
}
```

`stage` is the one word to show in the UI: `''` (not a new-style GCash booking), `awaiting_proof`, `proof_submitted`, `not_received`, `deposit_received` (50% paid, balance due at the studio), `paid`, `expired`, `cancelled`, `refund_due`, `refunded`. Booking responses for customers also carry `serverTime` (UTC ISO); use it for the hold countdown instead of the device clock.

**Receipt hints (admin only).** The customer's browser reads the reference number and amount off the screenshot (see the pay page) and sends them with the upload in `X-Receipt-Ref` and `X-Receipt-Amount`. They are untrusted: they never confirm, block or change a payment, and staff must still check the payment in GCash. Admin booking objects carry them under `payment.receiptCheck` (the public view never has it):

```
receiptCheck: {
  ocrRef,            // reference read from the latest deposit screenshot, '' if none
  ocrAmount,         // pesos read from it, or null
  amountMatches,     // true or false against amountDue; null when no amount was read
  refMatchesOcr,     // true or false against the typed reference; null when either is missing
  duplicateRef: [{ id, code, status }]   // other bookings using the same reference (typed or read), in any status
}
```

`duplicateRef` is a flag, not a block. Balance screenshots carry no hints.

**Cancelling and moving.** A customer cannot cancel a GCash booking online once a screenshot exists or the payment was received (`canCancel` is `false`; they have to message the studio, because refunds are handled by hand). They can still move it (`canReschedule`), inside the usual cutoff. Cancelling a booking that already took money (admin `PATCH` to `cancelled`) sets `refundStatus` to `refund_due`; so does shrinking a paid booking below what was paid. A booking whose total goes up after the balance was recorded shows a balance again, and the difference can be recorded the same way.

**Limits.** Screenshots are JPEG, PNG or WebP (the file's first bytes must match its `Content-Type`), up to 15 MB each, and up to 3 per booking. Receipts are stored in `RECEIPT_DIR` (default `data/private/receipts`), never under `/media`, and only ever sent to an admin. They are deleted `receipt_retention_days` (default 60) after the booking date, or after a booking expired or was cancelled; the audit trail stays.

**Rate limits** (in memory, per IP): at most `UPLOAD_RATE_LIMIT` screenshot uploads (default 10) and `LOOKUP_FAIL_LIMIT` failed booking code + phone matches (default 30) per 15 minutes. The failed-match count is shared by lookup, cancel, reschedule and every payment route; an IP over the limit gets `429` even with a correct code and phone. The limits use the client IP the proxy reports, so set `TRUST_PROXY` to the real number of proxies in front of the server (default 1, `0` for none). If it is too high, a visitor can fake `X-Forwarded-For` and dodge the limits. The admin test email has its own limit, counted for the whole server (see `POST /api/admin/settings/test-email`).

**Email.** Staff actions (confirmed, not yet received) and hold expiry email the customer, but only if they gave an email and `SMTP_USER` and `SMTP_PASS` are set. Email never blocks an action; a failure is recorded in the audit trail as `email_failed`. `emailQueued` in the admin responses says whether an email was attempted. Emails to the studio's own inbox are separate: see [Studio notification emails](#studio-notification-emails).

**Audit trail.** Every GCash action is stored as an event: `created`, `proof_uploaded`, `released`, `hold_expired`, `revived`, `confirmed_received`, `marked_not_received`, `balance_collected`, `refund_due`, `refunded`, `status_changed`, `cancelled`, `rescheduled`, `receipt_deleted`, `email_sent`, `email_failed`, each with who (`customer`, `staff` or `system`), an optional `staffName`, an amount, a method and a note.

## Studio notification emails

The server emails the studio's own inbox when a customer does something online. These are plain-text emails to staff, separate from the payment emails to customers. No endpoint returns anything about them: they are sent after the change is saved, without waiting, so they never slow down or fail the customer's request.

| Event | Trigger | Switch (setting) | Subject looks like |
| --- | --- | --- | --- |
| New booking | `POST /api/bookings` succeeded (pay at the studio or GCash, pending or auto-confirmed) | `notify_new_booking` | `New booking <code> · <date and time> · <studio name>` |
| GCash receipt to check | `POST /api/bookings/payment-proof` succeeded; one email per screenshot | `notify_payment_proof` | `GCash receipt to check · <code> · <amount>` |
| Customer cancelled | `POST /api/bookings/cancel` succeeded | `notify_customer_changes` | `Booking <code> cancelled by customer` |
| Customer rescheduled | `POST /api/bookings/reschedule` succeeded | `notify_customer_changes` | `Booking <code> rescheduled by customer · <new date and time>` |

- **Body.** One line saying what happened, then the booking: code, status, customer name (and band), phone, the customer's email if they gave one, studio name, date and time, hours (with free hours), total and how it is paid. A rescheduled email also has `Was:` and `Now:` lines. A receipt email says the amount to look for and whether it is another upload after "Not yet received". The screenshot, its file name and the GCash QR text are never in an email.
- **Admin link.** When `PUBLIC_SITE_URL` is set, the email ends with a link to `/admin` (to `/admin/gcash` for a receipt email). Without it there is no link.
- **Recipient.** The `notify_email` setting, or the `SMTP_USER` address when it is empty.
- **Skipped** when its switch is off, when `SMTP_USER` or `SMTP_PASS` is not set, or when there is no recipient.
- **Not sent for:** walk-ins and other bookings staff create (`POST /api/admin/bookings`), "Pay later" (`POST /api/bookings/release`), a hold that expired, and anything staff do in admin (confirm, not received, cancel, move, balance, refund).
- **No audit events.** Unlike customer emails, these write nothing to the GCash audit trail (`email_sent` and `email_failed` are for customer emails only). A failure is logged on the server with the email kind and the error code only, never an address.
- **Timeouts.** Connections to the mail server give up after 15 seconds (connecting and greeting) or 30 seconds without activity, for customer emails too.

The settings and the test email are under [Settings](#settings).

## Cleaning buffer

After every booking, `buffer_minutes` (a setting: 0, 30, 60, 90 or 120; default 30) is kept clear for cleaning. A new booking `[s, e)` clashes with an existing booking `b` in the same room when `s < b.end + buffer && b.start < e + buffer`. Blocks have no buffer and stay on whole hours. A booking must end by closing time; its buffer may run past closing. The free promo hour is only added when it and the buffer fit before the next booking.

- A buffer clash returns `409` with `{ error, code: 'buffer', bufferMinutes, gapMinutes }`, where `gapMinutes` is the smallest gap to the clashing booking. This applies to `POST /api/bookings`, `POST /api/bookings/reschedule`, `POST /api/admin/bookings` and `PATCH /api/admin/bookings/:id`.
- Staff can book through a clash with `overrideBuffer: true`, which is accepted only on `POST /api/admin/bookings` and `PATCH /api/admin/bookings/:id`. Customers can never override it. Overlapping bookings are still refused.
- Admin create and PATCH responses include `bufferWarning` next to `booking`: `{ bufferMinutes, gapMinutes, message }` when a clash was allowed, otherwise `null`.

---

## Public endpoints

### `GET /api/site`
Rooms and booking settings for the public site.

Response: `{ rooms: [{ id, name, description, hourlyRate, capacity, gear, color }], settings: { open_hour, close_hour, min_hours, max_hours, lead_time_hours, max_days_ahead, buffer_minutes, cancel_cutoff_hours, auto_confirm, promo_enabled, promo_buy_hours, promo_free_hours, gcash_enabled, gcash_hold_minutes, closed_weekdays }, content: { contact, gallery }, now, timeZone }`

`gcash_enabled` is `true` only when the owner switched GCash on **and** uploaded the studio QR; otherwise customers only see pay at the studio. `gcash_hold_minutes` is how long a GCash booking holds its slot while no screenshot is uploaded. The old send-to `gcash_name` and `gcash_number` are no longer returned, and the stored QR text is never returned by any public or admin endpoint. The studio email settings (`notify_email`, `notify_new_booking`, `notify_payment_proof`, `notify_customer_changes`) are admin only and are never returned here.

`content.contact` is `{ address: string[] | null, landmark, mapsQuery, phone, email, messenger, socials: [{ label, href }] | null }`. A field is `null` when the owner has not set it; the frontend then uses its built-in default. `content.gallery` is `[{ id, src, alt }]` in display order; `src` is a path like `/media/gallery/<uuid>.jpg`.

### `GET /media/gallery/<file>`
Serves an uploaded gallery photo (static, cached for 30 days, `X-Content-Type-Options: nosniff`). Unknown or malformed paths return `404`.

### `GET /api/availability?date=YYYY-MM-DD`
Busy hours per room for a day. `date` defaults to today.

Response: `{ date, now, window, rooms: [{ id, busy: [...] }] }`

- `busy` items are `{ start, end, kind, bufferEnd? }` in decimal hours (15.5 = 3:30 PM). Values are multiples of 0.5. `kind` is `booking` or `block`. `bufferEnd` is only on bookings: the end plus the cleaning buffer. A pending GCash booking waiting for its screenshot is listed while its hold lasts and disappears when the hold ends.
- `window.earliest` can be x.5, because the lead time rounds up to the next half hour.

Errors: `400` for a bad date.

### `GET /api/availability/month?month=YYYY-MM`
Read-only summary of every day in a month, for calendars. Uses the same rules as `/availability`: pending and confirmed bookings and blocks take a slot (a block with no room blocks every room), cancelled and expired bookings do not, and neither does a pending GCash booking whose hold has run out. Start times are counted every 30 minutes, and the cleaning buffer counts as taken.

Response: `{ month, now, days: [{ date, status, freeHours, reason? }] }`, one entry per day.

- `closed`: the day cannot be booked (past, beyond `max_days_ahead`, closed weekday, or no slots left today). `reason` explains why; `freeHours` is 0.
- `full`: no active room has `min_hours` free in a row between the earliest start and closing.
- `few`: fewer than 3 bookable start times (on the :00 and :30 grid) across all active rooms.
- `open`: otherwise.

`freeHours` is the free hours summed across active rooms between the earliest start and closing. It can be x.5, and cleaning time is not counted as free.
Errors: `400` for a missing or malformed month.

### `POST /api/bookings`
Create an online booking. Status becomes `confirmed` if `auto_confirm` is on, otherwise `pending`. A GCash booking is always `pending` and holds its slot while it waits for a screenshot (see [GCash payments](#gcash-payments)). Availability is re-checked inside a database transaction, so concurrent requests cannot double-book.

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
| `email` | no | validated. GCash payment updates are emailed here. |
| `headcount` | no | 1 to 30, default 1, cannot exceed room capacity |
| `notes` | no | up to 500 chars |
| `paymentMethod` | no | `gcash` (only if `gcash_enabled` in `GET /api/site` is `true`) or `pay_at_studio` (default) |
| `paymentPlan` | with `gcash` | `half` (50%, rounded up to a whole peso) or `full` (100%) |

`paymentRef` is no longer read: a customer gives their GCash reference number with the screenshot (see `POST /api/bookings/payment-proof`).

Response `201`: `{ booking, serverTime, freeNote }`. `booking` has `code, room, date, startHour, startMinute, endHour, paidHours, freeHours, name, bandName, phone, email, headcount, notes, paymentMethod, paymentRef, hourlyRate, total, status, canCancel, canReschedule, payment, createdAt` (`payment` is described under [GCash payments](#gcash-payments)). For a GCash booking, `status` is `pending`, `payment.stage` is `awaiting_proof` and `payment.holdExpiresAt` is when the hold ends.
Errors: `400` with `fields` for invalid input (`fields.paymentMethod` when GCash is off or no QR is stored, `fields.paymentPlan` when the plan is missing or not `half`/`full`), `409` if the slot is taken or the rules are not met. A cleaning buffer clash is `409` with `code: 'buffer'` (see [Cleaning buffer](#cleaning-buffer)).

### `POST /api/bookings/lookup`
Body: `{ code, phone }`. Response: `{ booking, serverTime }`. Holds that ran out are expired first, so the status is current.
Errors: `404` if the code and mobile number do not match; `429` after too many failed matches from one IP (see [Rate limits](#gcash-payments)).

### `POST /api/bookings/cancel`
Body: `{ code, phone }`. Response: `{ booking, serverTime }` with status `cancelled`.
Errors: `404` no match; `429` too many failed matches; `409` if inside the cancellation cutoff (`cancel_cutoff_hours`), or if the booking is a GCash booking with a screenshot sent or the payment received (message the studio instead; there is no online cancel for those). Cancelling a GCash booking that is still waiting for its first screenshot works, but "Pay later" (`/bookings/release`) is the usual way.

### `POST /api/bookings/reschedule`
Body: `{ code, phone, date, startHour, startMinute? }` (`startMinute` is `0` or `30`, default `0`). Keeps the room and paid hours; the free promo hour is recalculated for the new slot. A GCash payment carries over, and an unfinished hold keeps its original timer. Response: `{ booking, serverTime, freeNote }`.
Errors: `400` bad date, invalid `startMinute`, or same time as now; `404` no match; `429` too many failed matches; `409` inside the cancellation cutoff, or the new time is taken, closed, past closing or inside another booking's cleaning buffer (`code: 'buffer'`, no override for customers).

### `POST /api/bookings/payment-qr`
The QR for a GCash booking, with its exact amount inside. Body: `{ code, phone }`. Only while the booking is `pending` and waiting for a screenshot (`awaiting_proof` or `not_received`).

Response: `{ amount: "250.00", qrSvg, holdExpiresAt, serverTime }`. `qrSvg` is an SVG picture of the QR. The studio's stored QR text itself is never returned. The response is `Cache-Control: no-store`.
Errors: `404` no match; `429` too many failed matches; `409` the booking is not waiting for a GCash payment; `503` GCash is not set up (no QR stored).

### `POST /api/bookings/payment-proof`
Upload a receipt screenshot. The body is the raw image bytes with `Content-Type: image/jpeg`, `image/png` or `image/webp`. The booking code and mobile number go in headers so they stay out of URLs and proxy logs:

| Header | Required | Notes |
| --- | --- | --- |
| `X-Booking-Code` | yes | the booking code |
| `X-Booking-Phone` | yes | the mobile number |
| `X-Payment-Ref` | no | the GCash reference number, up to 40 characters |
| `X-Receipt-Ref` | no | the reference number read from the screenshot in the browser (OCR). Kept only when it is 8 to 20 digits; otherwise dropped silently. Hint only, see [GCash payments](#gcash-payments). |
| `X-Receipt-Amount` | no | the amount read from the screenshot, like `210` or `210.00`. Kept only when above 0 and at most `1000000`; otherwise dropped silently. Hint only. |

Bad values in `X-Receipt-Ref` and `X-Receipt-Amount` never cause an error. On success the booking is `pending` with `payment.stage` `proof_submitted` and its hold is cleared. Uploading to an expired booking whose slot is still free revives it. Response `201`: `{ booking, serverTime }`.

Errors, checked in this order, and the first four before the image is read: `429` too many uploads or failed matches from this IP; `404` no match; `409` not a GCash booking, 3 screenshots already uploaded, or screenshots can no longer be added; `415` the `Content-Type` is not JPEG, PNG or WebP. After the image is read: `413` over 15 MB; `415` the bytes are not a real JPEG, PNG or WebP or do not match the `Content-Type`, or the body is empty; `409` with `code: "slot_taken"` for a late upload when the slot was taken or the start time has passed.

### `POST /api/bookings/release`
"Pay later": gives the slot back. Body: `{ code, phone }`. Only works while the booking is waiting for its first screenshot (`pending` / `awaiting_proof`). Response: `{ booking, serverTime }` with status `cancelled`.
Errors: `404` no match; `429` too many failed matches; `409` the booking can no longer be released here.

---

## Admin endpoints (`/api/admin`)

### `POST /api/admin/login`
Body: `{ password }`. Response: `{ token }`.
Errors: `401` wrong password; `429` after 10 failed attempts from one IP in 15 minutes.

Everything below needs the bearer token. Missing or expired token returns `401`.

### `GET /api/admin/overview`
Dashboard data: `{ now, today: [booking], pending: [booking], pendingCount, paymentsWaiting, week: { from, to, total, n }, month: { from, to, total, n }, upcoming: [booking] }`. Revenue counts `confirmed` and `completed` bookings. `pending` and `pendingCount` include GCash bookings that are still waiting for a screenshot; tell them apart with `payment.stage`. `paymentsWaiting` is the number of GCash bookings with a screenshot waiting to be checked (the badge on GCash Payments).

### Bookings

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/bookings` | List with filters: `status` (any of the booking statuses, including `expired`), `room`, `from`, `to`, `q` (code, name, band, phone, email), `sort` (`created`, `asc`, default newest date first), `limit` (max 200, default 50), `offset`. Response: `{ total, limit, offset, bookings }`. |
| `GET` | `/bookings/:id` | One booking. `404` if missing. |
| `POST` | `/bookings` | Walk-in or phone booking. Skips lead time, status `confirmed`, source `walk_in`. Body like the public one (including `startMinute`), plus optional `adminNotes` and `overrideBuffer: true` to book inside another booking's cleaning buffer; `phone` may be empty. `paymentMethod: "gcash"` only labels the booking: it has no plan, amount or hold, and shows under `status=older` on GCash Payments. Response `201`: `{ booking, bufferWarning }`. `409` if the slot is taken, or `code: 'buffer'` if it breaks the cleaning buffer and `overrideBuffer` is not set. |
| `PATCH` | `/bookings/:id` | Change `status`, `adminNotes`, `paymentRef`, or reschedule with `roomId`, `date`, `startHour`, `startMinute`, `paidHours` (price is recalculated) and `overrideBuffer: true`. `startHour` without `startMinute` means `:00`; with neither, the start time is kept. Reopening a cancelled booking re-checks the slot and the buffer. An optional `staffName` (up to 40 characters) is written to the GCash audit trail. Response: `{ booking, bufferWarning }`. `409` with `code: 'buffer'` when the buffer clashes and `overrideBuffer` is not set. |

Rules for GCash bookings (those with a `payment.plan`) on `PATCH`:

- `status: "confirmed"` is refused with `409` and `code: "gcash_payment_required"` until the deposit is received. Confirm it from GCash Payments (`POST /payments/:id/confirm`), which also records the payment. The same code is returned for setting an expired or cancelled GCash booking back to `pending`.
- A confirmed, moved or reopened booking never keeps a hold timer, so the sweep cannot expire it.
- Cancelling a booking that took money, or moving a paid booking to a cheaper slot so the total drops below what was paid, sets `payment.refundStatus` to `refund_due`. A move to a pricier slot after the balance was recorded leaves a balance due (see `POST /payments/:id/balance`).
- `status: "expired"` is not a valid target (`400`).

Older manual GCash bookings and pay-at-studio bookings behave as before.

Admin `booking` objects add `id, roomId, roomName, roomColor, source, adminNotes, updatedAt`. They include `startMinute` as well, and `payment` with `canRefund` and `receiptCheck` (see [GCash payments](#gcash-payments)).

### Schedule and blocked time

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/schedule?date=` | Day view: `{ date, now, settings, rooms, bookings, blocks, bufferConflicts }`. `bufferConflicts` lists back-to-back bookings in one room with less than `buffer_minutes` between them: `[{ roomId, bookingIds: [a, b], gapMinutes }]`. Pending and confirmed bookings are checked; cancelled, expired, completed and no-show are ignored. Usually these come from bookings made before the buffer existed, or from staff overrides. `bookings` includes every booking of the day, expired ones too (they hold no slot). |
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
| `GET` | `/settings` | `{ settings, legacy, mail }`. `legacy` is `{ gcashName, gcashNumber }`, the old send-to details from the manual GCash flow, read-only and kept only so they are not lost; `null` when none were stored. `mail` is `{ configured, notifyTo }`, read-only: `configured` is `true` when `SMTP_USER` and `SMTP_PASS` are set, and `notifyTo` is the address studio emails go to (`notify_email`, or the `SMTP_USER` address when that is empty; `''` when there is neither). The password is never returned. |
| `PUT` | `/settings` | Update any subset of the settings keys: opening hours, `closed_weekdays` (0 to 6), min and max hours, lead time, days ahead, `buffer_minutes` (must be `0`, `30`, `60`, `90` or `120`, else `400`), cancellation cutoff, `auto_confirm`, free-hour promo, `gcash_enabled` (online GCash on or off; it also needs the QR below), `gcash_hold_minutes` (5 to 240, default 30: how long a GCash booking holds its slot without a screenshot) and `receipt_retention_days` (7 to 365, default 60: how long receipt screenshots are kept). Also the studio email settings: `notify_email` (one email address, up to 254 characters, or `''` to use the `SMTP_USER` address; default `''`) and the switches `notify_new_booking`, `notify_payment_proof` and `notify_customer_changes` (booleans, default `true`; see [Studio notification emails](#studio-notification-emails)). Response: `{ settings, mail }` (`mail` as in `GET`). `400` if the values are inconsistent (for example closing before opening). A bad `notify_email` (not a string, not one plain address, or with a list or display name in it) is `400` with `{ error, fields: { notify_email: message } }` and nothing is saved. The old `gcash_name` and `gcash_number` can no longer be changed. |
| `POST` | `/settings/test-email` | Sends a short test email to the address studio emails go to (`mail.notifyTo`) and waits for the mail server's answer. No body. Response `200`: `{ sent: true, to }`. Errors, each `{ error, code }`, checked in this order: `409` `mail_not_configured` (`SMTP_USER` or `SMTP_PASS` is not set); `409` `no_recipient` (no address to send to); `429` `rate_limited` (more than `TEST_EMAIL_RATE_LIMIT` tries, default 5, in 10 minutes; counted for the whole server, not per IP, and the two `409`s do not count); `502` `mail_failed` (the mail server refused or timed out). `401` without a token, like every admin endpoint. |

### GCash payments (admin)

Everything here needs the admin token. `:id` is the booking id (the `id` on admin bookings). A "payment item" is an admin booking plus `proofs` and `events`:

```
{ ...adminBooking,
  proofs: [{ id, kind: 'deposit'|'balance', uploadedBy: 'customer'|'staff', uploadedAt, bytes, ocrRef, ocrAmount, duplicateOf? }],
  events: [{ id, at, actor: 'customer'|'staff'|'system', staffName, action, amount, method, note }] }
```

`duplicateOf` is the code of another booking that has a screenshot with identical bytes (a flag for staff, not a block). `ocrRef` and `ocrAmount` are the receipt hints read from that screenshot (`''` and `null` when none; see [Receipt hints](#gcash-payments)). File names are never exposed.

Staff actions accept an optional `staffName` (up to 40 characters) that is stored in the audit trail; the admin page does not ask for it. Every action response is the refreshed item, so the page can swap the row.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/payments` | Every GCash booking. Filters: `status` = `awaiting_proof`, `proof_submitted`, `not_received` (new-style bookings that are `pending` in that payment state), `received` (deposit confirmed), `expired`, or `older` (manual GCash bookings from before this flow, with no plan); `balance=due` (deposit received, money still owed, booking not cancelled or expired); `limit` (max 200, default 50), `offset`. Bookings with a screenshot waiting come first. Response: `{ total, waitingCount, bookings: [payment item] }`. There is no server-side "refunds" filter: the admin page loads up to 200 bookings and keeps those with `payment.canRefund`. |
| `GET` | `/payments/:id` | One payment item: `{ booking }`. `404` if missing. |
| `GET` | `/payments/proofs/:id` | The screenshot image itself, for the admin page (fetch it with the token and show it as a blob, because an `<img>` tag cannot send the token). Sent with the stored `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'` and `Cache-Control: private, no-store`. `404` if the file is gone or was deleted by the retention sweep. |
| `POST` | `/payments/:id/confirm` | **Received & Confirmed.** Body (all optional): `{ staffName, amount }`; `amount` is whole pesos received, default `payment.amountDue`, at most the booking total. The booking becomes `confirmed`, the deposit `received`, and the customer is emailed. Works from `awaiting_proof` (staff saw the payment without a screenshot), `proof_submitted`, `not_received` and `expired` (the slot is re-checked first, buffer included). Response: `{ booking, emailQueued }`. Errors: `400` bad amount; `404`; `409` already confirmed, cancelled, finished, an older manual booking, or `code: "slot_taken"` when an expired booking's slot was taken in the meantime (reschedule it or record a refund). |
| `POST` | `/payments/:id/not-received` | **Not yet received.** Body: `{ staffName?, note? }` (note up to 300 characters). The booking stays `pending` with `payment.stage` `not_received`, the slot stays held (no auto-cancel), the customer can upload another screenshot, and they are emailed. Only for a pending booking that has a screenshot. Response: `{ booking, emailQueued }`. `409` otherwise. |
| `POST` | `/payments/:id/balance` | Record the balance of a 50% booking (or a top-up after the total went up) as paid in full. Headers: `X-Balance-Method` = `cash` or `gcash` (required); `X-Balance-Amount` (optional whole pesos, must equal the balance still due); `X-Staff-Name` and `X-Note` (optional). For `gcash` the body is the raw screenshot of that payment (JPEG, PNG or WebP, up to 15 MB) and is **required**, stored as a `balance` proof. For `cash` there is no body. The booking then reads `payment.stage` `paid`. Response: `{ booking }`. Errors: `400` missing or bad method, wrong amount, GCash without an image, cash with an image; `404`; `409` the deposit is not received yet, the booking is not active, or nothing is left to pay; `413` too large; `415` not a JPEG, PNG or WebP image. |
| `POST` | `/payments/:id/refund` | **Refund recorded.** A refund is handed back by hand (outside the app); this only records it. Body: `{ method: 'cash'|'gcash', amount, staffName?, note? }`; `amount` is whole pesos, up to what was paid. Allowed when `payment.canRefund` is `true`: a refund is due, or the booking is expired or cancelled with at least one screenshot and no refund recorded. Sets `refundStatus` to `refunded`. Response: `{ booking }`. Errors: `400` bad method or amount; `404`; `409` no refund to record, or an older manual booking. |

### GCash QR

The studio's own GCash (InstaPay QR Ph) QR, uploaded once. The admin page decodes the picture in the browser and sends only its text. The text holds the owner's account details, so it is stored privately and **never returned**: the owner sees a masked summary, and a customer sees one drawn QR per booking with the amount added.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/settings/gcash-qr` | `{ configured, merchantName, city, accountHint }`. `merchantName` and `city` come from the QR. `accountHint` is the account reference with only its first two and last two characters visible and the rest as dots. All three are empty strings when no QR is stored. |
| `PUT` | `/settings/gcash-qr` | Body `{ payload }`, the decoded QR text. It must be a valid static payment QR (checksum, Philippine pesos, up to 500 plain-ASCII characters). Response: the same summary as `GET`. `400` with `{ error }` when it is not. |
| `DELETE` | `/settings/gcash-qr` | Removes the stored QR. Online GCash then turns itself off (`gcash_enabled` is `false` on `GET /api/site`). Existing bookings are not touched. Response: the summary. |
| `POST` | `/settings/gcash-qr/preview` | Body `{ amount }` (whole pesos). Response: `{ amount, qrSvg }`, a test QR so the owner can scan it in GCash (for example ₱1.00) and check the name and amount before customers do. `400` bad amount; `409` no QR uploaded. |

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

There is no payment gateway (PayMongo, Maya and the like), so payments are not confirmed automatically: GCash payments are checked by staff against a screenshot. Notifications are by email only; there is no SMS or Messenger notification yet. They are listed under "Ideas for later" in the README.

## Agents API

The agents have their own local API, separate from this one. See [`tools/agents-api/README.md`](../tools/agents-api/README.md).
