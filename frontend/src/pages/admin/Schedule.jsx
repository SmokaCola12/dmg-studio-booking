import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Ban, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { adminApi } from '../../lib/api.js';
import { addDays, dateLabel, rangeLabel, relativeDay } from '../../lib/format.js';
import { DayView } from '../../components/DayView.jsx';
import { LoadError, PageHead, useAdmin, useLoader } from './admin-shared.jsx';
import { BookingRow } from './BookingRow.jsx';
import { BookingDialog } from './BookingDialog.jsx';
import { BlockDialog, NewBookingDialog } from './EntryDialogs.jsx';
import { BufferConflicts, boardItems, boardRooms } from './Overview.jsx';
import { isDead } from '../../lib/schedule.js';

export default function Schedule() {
  const { version, changed } = useAdmin();
  const [date, setDate] = useState(null);
  const day = useLoader(() => adminApi.schedule(date || undefined), [date, version]);
  const d = day.data;
  const shown = date || d?.date;
  const today = d?.now.date;

  const [open, setOpen] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newDefaults, setNewDefaults] = useState(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockDefaults, setBlockDefaults] = useState(null);

  const items = useMemo(() => (d ? boardItems(d) : {}), [d]);
  const s = d?.settings;

  const removeBlock = async (id) => {
    try {
      await adminApi.deleteBlock(id);
      toast.success('Time opened up again');
      changed();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const openBooking = (b) => {
    setOpen(b);
    setDialogOpen(true);
  };

  if (day.error && !d) return <LoadError error={day.error} onRetry={day.reload} />;
  const roomName = (id) => d?.rooms.find((r) => r.id === id)?.name;
  const activeBookings = d ? d.bookings.filter((b) => !isDead(b.status)) : [];
  const cancelled = d ? d.bookings.filter((b) => isDead(b.status)) : [];

  return (
    <div className="a-page">
      <PageHead title="Schedule" sub={shown ? dateLabel(shown, { long: true, year: true }) : ' '}>
        <button
          type="button"
          className="btn btn-outline"
          disabled={!d}
          onClick={() => {
            setBlockDefaults({ date: shown, openHour: s.open_hour, closeHour: s.close_hour });
            setBlockOpen(true);
          }}
        >
          <Ban /> Block time
        </button>
        <button
          type="button"
          className="btn btn-dark"
          disabled={!d}
          onClick={() => {
            setNewDefaults({ roomId: d.rooms[0]?.id, date: shown });
            setNewOpen(true);
          }}
        >
          <Plus /> New booking
        </button>
      </PageHead>

      <div className="day-nav">
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setDate(addDays(shown, -1))} disabled={!shown} aria-label="Previous day">
          <ChevronLeft />
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setDate(addDays(shown, 1))} disabled={!shown} aria-label="Next day">
          <ChevronRight />
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDate(today)} disabled={!today || shown === today}>
          Today
        </button>
        <input type="date" className="input day-nav-date" value={shown || ''} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Go to date" />
        {shown && today && shown !== today && <span className="day-nav-rel">{relativeDay(shown, today)}</span>}
      </div>

      <BufferConflicts day={d} />
      {d && s ? (
        <DayView
          rooms={boardRooms(d)}
          openHour={s.open_hour}
          closeHour={s.close_hour}
          settings={s}
          items={items}
          nowHour={d.date === d.now.date ? d.now.hour + d.now.minute / 60 : null}
          onSelectClip={(it) => openBooking(it.data)}
          onSelectFree={(room, h) => {
            setNewDefaults({ roomId: room.id, date: shown, startHour: h });
            setNewOpen(true);
          }}
          freeLabel="New booking in"
        />
      ) : (
        <div className="skeleton" style={{ height: 180 }} />
      )}

      {d && d.blocks.length > 0 && (
        <section className="a-section" aria-labelledby="blocks-title">
          <h2 id="blocks-title" className="a-h2">
            Blocked time
          </h2>
          <ul className="block-list">
            {d.blocks.map((bl) => (
              <li key={bl.id}>
                <span>
                  <strong className="tnum">{rangeLabel(bl.startHour, bl.endHour)}</strong>
                  {', '}
                  {bl.roomId === null ? 'All studios' : roomName(bl.roomId)}
                  {bl.reason && <span className="muted">, {bl.reason}</span>}
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeBlock(bl.id)}>
                  <Trash2 /> Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d && (
        <section className="a-section" aria-labelledby="day-list-title">
          <h2 id="day-list-title" className="a-h2">
            Bookings this day
          </h2>
          {activeBookings.length === 0 ? (
            <p className="a-empty">No bookings yet for this day.</p>
          ) : (
            <ul className="b-list">
              {activeBookings.map((b) => (
                <BookingRow key={b.id} booking={b} today={today} onOpen={openBooking} />
              ))}
            </ul>
          )}
          {cancelled.length > 0 && (
            <details className="a-details">
              <summary>
                {cancelled.length} cancelled or expired {cancelled.length === 1 ? 'booking' : 'bookings'}
              </summary>
              <ul className="b-list">
                {cancelled.map((b) => (
                  <BookingRow key={b.id} booking={b} today={today} onOpen={openBooking} />
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <BookingDialog booking={open} open={dialogOpen} onOpenChange={setDialogOpen} />
      <NewBookingDialog open={newOpen} onOpenChange={setNewOpen} defaults={newDefaults} />
      <BlockDialog open={blockOpen} onOpenChange={setBlockOpen} defaults={blockDefaults} />
    </div>
  );
}
