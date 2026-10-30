# Changelog

All notable changes to DMG Studio are recorded here, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every pull request adds a line under **Unreleased**; the `technical-writer` agent keeps it tidy and `github-specialist` checks it before a PR.

Categories: **Added**, **Changed**, **Fixed**, **Removed**, **Security**.

## [Unreleased]

### Added
- Customers can reschedule from My booking: `POST /api/bookings/reschedule` moves the date and start time (same room and hours, same cutoff as cancelling), with an animated walkthrough and a "Need to resched?" link on the home page.
- `docs/API.md`: reference for every public and admin endpoint.
- `CHANGELOG.md`: this file.
- `tools/agents-api/`: local HTTP API to list and run the project agents through the Claude Agent SDK (list, run, stream events, cancel, history).

### Changed
- Split the project into `frontend/` (Vite + React) and `backend/` (Express + SQLite) folders, managed as npm workspaces. Commands are unchanged (`npm run dev`, `build`, `start`, `seed:demo`); run `npm install` after pulling. `.env` and `data/` stay at the project root.

## [1.0.0]

### Added
- Public site: live schedule of the day (DAW style), rooms and rates, gallery, house rules, FAQ, map and contact.
- Three-step booking flow with automatic free-hour promo, booking code and `.ics` calendar download.
- "My booking" page to look up or cancel a booking with the code and mobile number.
- Admin dashboard: today, bookings (search, filters, confirm, decline, reschedule, notes), schedule with walk-ins and blocked time, rooms, and settings.
- Express and SQLite backend with server-side double-booking protection.
