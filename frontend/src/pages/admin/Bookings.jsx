import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import clsx from 'clsx';
import { adminApi } from '../../lib/api.js';
import { addDays } from '../../lib/format.js';
import { LoadError, PageHead, useAdmin, useLoader } from './admin-shared.jsx';
import { BookingRow } from './BookingRow.jsx';
import { BookingDialog } from './BookingDialog.jsx';
import { NewBookingDialog } from './EntryDialogs.jsx';

const STATUS_FILTERS = [
  ['', 'All'],
  ['pending', 'Waiting'],
  ['confirmed', 'Confirmed'],
  ['completed', 'Done'],
  ['cancelled', 'Cancelled'],
  ['no_show', 'No-show'],
  ['expired', 'Expired'],
];

const WHEN = [
  ['upcoming', 'Upcoming'],
  ['past', 'Past'],
  ['all', 'All dates'],
];

const PAGE = 40;

export default function Bookings() {
  const { version } = useAdmin();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const when = params.get('when') || 'upcoming';
  const room = params.get('room') || '';
  const q = params.get('q') || '';
  const [search, setSearch] = useState(q);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setLimit(PAGE);
  };

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => search !== q && setParam('q', search.trim()), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const meta = useLoader(() => Promise.all([adminApi.rooms(), adminApi.overview()]), []);
  const today = meta.data?.[1].now.date;
  const rooms = meta.data?.[0].rooms || [];

  const list = useLoader(() => {
    if (!today) return Promise.resolve(null);
    const range =
      when === 'upcoming' ? { from: today, sort: 'asc' } : when === 'past' ? { to: addDays(today, -1) } : {};
    return adminApi.bookings({ status, room, q, limit, ...range });
  }, [today, status, room, q, when, limit, version]);

  const openBooking = (b) => {
    setOpen(b);
    setDialogOpen(true);
  };

  const data = list.data;

  return (
    <div className="a-page">
      <PageHead title="Bookings" sub={data ? `${data.total} ${data.total === 1 ? 'booking' : 'bookings'}` : ' '}>
        <button type="button" className="btn btn-dark" onClick={() => setNewOpen(true)} disabled={!today || !rooms.length}>
          <Plus /> New booking
        </button>
      </PageHead>

      <div className="filters">
        <label className="search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search bookings</span>
          <input
            type="search"
            className="input"
            placeholder="Name, band, code or mobile"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            enterKeyHint="search"
          />
        </label>
        <div className="seg" role="group" aria-label="Dates">
          {WHEN.map(([v, label]) => (
            <button key={v} type="button" className="seg-btn" aria-pressed={when === v} onClick={() => setParam('when', v === 'upcoming' ? '' : v)}>
              {label}
            </button>
          ))}
        </div>
        <select className="select filter-select" value={room} onChange={(e) => setParam('room', e.target.value)} aria-label="Studio">
          <option value="">All studios</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <div className="chips" role="group" aria-label="Status">
        {STATUS_FILTERS.map(([v, label]) => (
          <button key={v || 'all'} type="button" className={clsx('chip', `chip-${v || 'all'}`)} aria-pressed={status === v} onClick={() => setParam('status', v)}>
            {label}
          </button>
        ))}
      </div>

      {list.error && !data && <LoadError error={list.error} onRetry={list.reload} />}

      {!data && !list.error && (
        <div className="b-list-skeleton">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 64 }} />
          ))}
        </div>
      )}

      {data && data.bookings.length === 0 && (
        <p className="a-empty">
          {q || status || room
            ? 'No bookings match these filters. Clear the search or pick another status.'
            : when === 'upcoming'
              ? 'No upcoming bookings yet. Online bookings show up here as soon as they come in.'
              : 'Nothing here yet.'}
        </p>
      )}

      {data && data.bookings.length > 0 && (
        <>
          <ul className={clsx('b-list', list.loading && 'is-refreshing')}>
            {data.bookings.map((b) => (
              <BookingRow key={b.id} booking={b} today={today} onOpen={openBooking} />
            ))}
          </ul>
          {data.total > data.bookings.length && (
            <div className="more">
              <button type="button" className="btn btn-outline" onClick={() => setLimit((l) => l + PAGE)} disabled={list.loading}>
                Show more ({data.total - data.bookings.length} left)
              </button>
            </div>
          )}
        </>
      )}

      <BookingDialog booking={open} open={dialogOpen} onOpenChange={setDialogOpen} />
      <NewBookingDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        defaults={today && rooms.length ? { roomId: rooms.find((r) => r.active)?.id ?? rooms[0].id, date: today } : null}
      />
    </div>
  );
}
