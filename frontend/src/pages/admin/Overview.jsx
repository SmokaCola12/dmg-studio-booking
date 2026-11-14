import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, Plus } from 'lucide-react';
import { adminApi } from '../../lib/api.js';
import { bookingEnd, bookingStart, dateLabel, minutesText, peso, rangeLabel } from '../../lib/format.js';
import { bufferMinutes, withBufferClips } from '../../lib/schedule.js';
import { DayView } from '../../components/DayView.jsx';
import { MonthCalendar } from '../../components/MonthCalendar.jsx';
import { LoadError, PageHead, useAdmin, useLoader } from './admin-shared.jsx';
import { BookingRow } from './BookingRow.jsx';
import { BookingDialog } from './BookingDialog.jsx';
import { NewBookingDialog } from './EntryDialogs.jsx';

export function boardItems(day) {
  const items = {};
  for (const r of day.rooms) items[r.id] = [];
  for (const b of day.bookings) {
    if (b.status === 'cancelled' || !items[b.roomId]) continue;
    items[b.roomId].push({
      kind: 'booking',
      id: b.id,
      start: bookingStart(b),
      end: bookingEnd(b),
      label: b.bandName || b.name,
      sub: rangeLabel(bookingStart(b), bookingEnd(b)),
      status: b.status,
      data: b,
    });
  }
  for (const bl of day.blocks) {
    const targets = bl.roomId === null ? day.rooms.map((r) => r.id) : [bl.roomId];
    for (const id of targets) {
      items[id]?.push({ kind: 'block', id: `bl${bl.id}`, start: bl.startHour, end: bl.endHour, label: bl.reason || 'Blocked' });
    }
  }
  // A muted "Cleaning" clip after each booking that is still on.
  const buffer = bufferMinutes(day.settings);
  for (const id of Object.keys(items)) items[id] = withBufferClips(items[id], buffer);
  return items;
}

/** Warns about bookings that sit closer together than the cleaning time (made before the buffer existed, or overridden by staff). */
export function BufferConflicts({ day }) {
  const list = day?.bufferConflicts || [];
  if (!list.length) return null;
  const roomName = (id) => day.rooms.find((r) => r.id === id)?.name || 'a room';
  const byId = Object.fromEntries(day.bookings.map((b) => [b.id, b]));
  return (
    <div className="buffer-conflicts" role="status">
      <p className="buffer-conflicts-title">
        <AlertTriangle aria-hidden="true" />
        Not enough cleaning time
      </p>
      <ul className="buffer-conflicts-list">
        {list.map((c) => {
          const [a, b] = c.bookingIds.map((id) => byId[id]);
          return (
            <li key={`${c.roomId}-${c.bookingIds.join('-')}`}>
              <b>{roomName(c.roomId)}</b>
              <span className="tnum">
                {a ? rangeLabel(bookingStart(a), bookingEnd(a)) : ''} then {b ? rangeLabel(bookingStart(b), bookingEnd(b)) : ''}
              </span>
              <span className="buffer-conflicts-gap">{c.gapMinutes > 0 ? `${minutesText(c.gapMinutes)} gap` : 'no gap'}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const boardRooms = (day) =>
  day.rooms.map((r) => ({ id: r.id, name: r.name, color: r.color, hourlyRate: r.hourly_rate }));

export default function Overview() {
  const { version, changed } = useAdmin();
  const overview = useLoader(() => adminApi.overview(), [version]);
  const today = overview.data?.now.date;
  const [picked, setPicked] = useState(null);
  const [month, setMonth] = useState(null);
  const date = picked || today;
  const shownMonth = month || today?.slice(0, 7);
  const day = useLoader(() => (date ? adminApi.schedule(date) : Promise.resolve(null)), [date, version]);
  const calendar = useLoader(() => (shownMonth ? adminApi.calendar(shownMonth) : Promise.resolve(null)), [shownMonth, version]);
  const [open, setOpen] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newDefaults, setNewDefaults] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const [confirming, setConfirming] = useState(null);

  const items = useMemo(() => (day.data ? boardItems(day.data) : {}), [day.data]);
  const dayWaiting = day.data ? day.data.bookings.filter((b) => b.status === 'pending') : [];
  const dayConfirmed = day.data ? day.data.bookings.filter((b) => b.status === 'confirmed' || b.status === 'completed') : [];

  const openBooking = (b) => {
    setOpen(b);
    setDialogOpen(true);
  };

  const quickConfirm = async (b) => {
    setConfirming(b.id);
    try {
      await adminApi.updateBooking(b.id, { status: 'confirmed' });
      toast.success(`Confirmed ${b.bandName || b.name}`);
      changed();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setConfirming(null);
    }
  };

  if (overview.error && !overview.data) return <LoadError error={overview.error} onRetry={overview.reload} />;
  const d = overview.data;
  const s = day.data?.settings;
  const nowHour = d ? d.now.hour + d.now.minute / 60 : null;
  const todayHours = d ? d.today.filter((b) => b.status !== 'no_show').reduce((n, b) => n + (b.endHour - b.startHour), 0) : 0;

  return (
    <div className="a-page">
      <PageHead title="Today" sub={today ? dateLabel(today, { long: true, year: true }) : ' '}>
        <button
          type="button"
          className="btn btn-dark"
          disabled={!day.data}
          onClick={() => {
            setNewDefaults({ roomId: day.data.rooms[0]?.id, date });
            setNewOpen(true);
          }}
        >
          <Plus /> New booking
        </button>
      </PageHead>

      <dl className="stats">
        <div>
          <dt>Bookings today</dt>
          <dd className="tnum">{d ? d.today.length : '–'}</dd>
          <span className="stat-sub">{d ? `${todayHours} ${todayHours === 1 ? 'hour' : 'hours'} of room time` : ' '}</span>
        </div>
        <div>
          <dt>Waiting for approval</dt>
          <dd className="tnum">{d ? d.pendingCount : '–'}</dd>
          <span className="stat-sub">Online bookings to confirm</span>
        </div>
        <div>
          <dt>This week</dt>
          <dd className="tnum">{d ? peso(d.week.total) : '–'}</dd>
          <span className="stat-sub">{d ? `${d.week.n} confirmed or done, ${dateLabel(d.week.from).split(', ')[1]}–${dateLabel(d.week.to).split(', ')[1]}` : ' '}</span>
        </div>
        <div>
          <dt>This month</dt>
          <dd className="tnum">{d ? peso(d.month.total) : '–'}</dd>
          <span className="stat-sub">{d ? `${d.month.n} confirmed or done` : ' '}</span>
        </div>
      </dl>

      {today && (
        <section className="a-section" aria-labelledby="calendar-title">
          <div className="a-section-head">
            <h2 id="calendar-title" className="a-h2">
              Calendar
            </h2>
            {picked && picked !== today && (
              <button type="button" className="a-link" onClick={() => { setPicked(null); setMonth(null); }}>
                Back to today
              </button>
            )}
          </div>
          <div className="admin-cal">
            <MonthCalendar
              month={shownMonth}
              onMonthChange={setMonth}
              value={date}
              min="2000-01-01"
              today={today}
              marks={calendar.data?.month === shownMonth ? calendar.data.days : {}}
              loading={calendar.loading}
              onPick={setPicked}
            />
            <div className="admin-cal-day" aria-live="polite">
              <h3 className="admin-cal-date">{dateLabel(date, { long: true })}</h3>
              {!day.data ? (
                <div className="skeleton" style={{ height: 96 }} />
              ) : dayWaiting.length === 0 && dayConfirmed.length === 0 ? (
                <p className="a-empty">No confirmed or waiting bookings on this day.</p>
              ) : (
                <>
                  {dayWaiting.length > 0 && (
                    <>
                      <h4 className="a-h3">Waiting for approval</h4>
                      <ul className="b-list">
                        {dayWaiting.map((b) => (
                          <BookingRow
                            key={b.id}
                            booking={b}
                            today={today}
                            onOpen={openBooking}
                            showStatus={false}
                            action={
                              <button type="button" className="btn btn-dark btn-sm" disabled={confirming === b.id} onClick={() => quickConfirm(b)}>
                                {confirming === b.id ? 'Confirming…' : 'Confirm'}
                              </button>
                            }
                          />
                        ))}
                      </ul>
                    </>
                  )}
                  {dayConfirmed.length > 0 && (
                    <>
                      <h4 className="a-h3">Confirmed</h4>
                      <ul className="b-list">
                        {dayConfirmed.map((b) => (
                          <BookingRow key={b.id} booking={b} today={today} onOpen={openBooking} showStatus={false} />
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="a-section" aria-labelledby="board-title">
        <div className="a-section-head">
          <h2 id="board-title" className="a-h2">
            {date === today ? 'Today’s rooms' : `Rooms on ${date ? dateLabel(date, { long: true }) : ''}`}
          </h2>
          <Link to="/admin/schedule" className="a-link">
            Open schedule
          </Link>
        </div>
        <BufferConflicts day={day.data} />
        {day.data && s ? (
          <DayView
            timelineOnly
            rooms={boardRooms(day.data)}
            openHour={s.open_hour}
            closeHour={s.close_hour}
            items={items}
            nowHour={date === today ? nowHour : null}
            onSelectClip={(it) => openBooking(it.data)}
            onSelectFree={(room, h) => {
              setNewDefaults({ roomId: room.id, date, startHour: h });
              setNewOpen(true);
            }}
            freeLabel="New booking in"
          />
        ) : (
          <div className="skeleton" style={{ height: 160 }} />
        )}
      </section>

      <section className="a-section" aria-labelledby="upcoming-title">
        <div className="a-section-head">
          <h2 id="upcoming-title" className="a-h2">
            Coming up
          </h2>
          <Link to="/admin/bookings" className="a-link">
            All bookings
          </Link>
        </div>
        {d && d.upcoming.length === 0 && <p className="a-empty">No confirmed bookings coming up. New online bookings show up under Waiting for approval.</p>}
        {d && d.upcoming.length > 0 && (
          <ul className="b-list">
            {d.upcoming.map((b) => (
              <BookingRow key={b.id} booking={b} today={today} onOpen={openBooking} />
            ))}
          </ul>
        )}
      </section>

      <BookingDialog booking={open} open={dialogOpen} onOpenChange={setDialogOpen} />
      <NewBookingDialog open={newOpen} onOpenChange={setNewOpen} defaults={newDefaults} />
    </div>
  );
}
