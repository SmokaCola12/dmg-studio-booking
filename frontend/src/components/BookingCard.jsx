import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Clock, MapPin } from 'lucide-react';
import { site } from '../config/site.js';
import { useStudioInfo } from '../lib/site-data.jsx';
import { useAvailability } from '../lib/useAvailability.js';
import { useMonthAvailability } from '../lib/useMonthAvailability.js';
import { bufferText, startOptions } from '../lib/schedule.js';
import { addDays, dateLabel, hoursSentence, hoursText, peso, rangeLabel } from '../lib/format.js';
import { MonthCalendar } from './MonthCalendar.jsx';

/**
 * The plain booking card at the top of Home: room, hours, date, start time, then /book.
 * `today` must come from the server (siteData.now.date), never the browser clock.
 */
export function BookingCard({ rooms, settings, today }) {
  const navigate = useNavigate();
  const info = useStudioInfo();
  const [roomId, setRoomId] = useState(rooms[0]?.id);
  const [hours, setHours] = useState(
    Math.min(Math.max(settings.promo_enabled ? settings.promo_buy_hours : settings.min_hours, settings.min_hours), settings.max_hours),
  );
  const [date, setDate] = useState(null);
  const [start, setStart] = useState(null);
  const [month, setMonth] = useState(today.slice(0, 7));

  const shownDate = date || today;
  const maxDate = addDays(today, settings.max_days_ahead);
  const room = rooms.find((r) => r.id === roomId) || rooms[0];

  const { data: monthData, error: monthError, loading: monthLoading } = useMonthAvailability(month);
  const { data: avail, error: availError, loading: availLoading, reload } = useAvailability(shownDate);

  const dayMap = useMemo(() => Object.fromEntries((monthData?.days || []).map((d) => [d.date, d])), [monthData]);

  // Chips: start hours that fit the chosen hours in the chosen room, plus how many rooms fit each one.
  const chips = useMemo(() => {
    if (!avail || avail.date !== shownDate || !room) return null;
    const perRoom = rooms.map((r) => ({
      id: r.id,
      opts: startOptions({
        busy: avail.rooms.find((x) => x.id === r.id)?.busy || [],
        settings,
        window: avail.window,
        paidHours: hours,
      }),
    }));
    const mine = perRoom.find((p) => p.id === room.id)?.opts || [];
    return mine
      .filter((o) => o.ok)
      .map((o) => ({
        hour: o.hour,
        left: perRoom.filter((p) => p.opts.find((x) => x.hour === o.hour)?.ok).length,
      }));
  }, [avail, shownDate, room, rooms, settings, hours]);

  // A picked start only counts while it is still offered (room, hours or date changed, or it got taken).
  const chosen = chips?.find((c) => c.hour === start) || null;
  const total = room ? room.hourlyRate * hours : 0;
  const dayInfo = dayMap[shownDate];
  const closedReason = avail?.window && !avail.window.open ? avail.window.reason : dayInfo?.status === 'closed' ? dayInfo.reason : '';

  const hourChoices = Array.from({ length: settings.max_hours - settings.min_hours + 1 }, (_, i) => settings.min_hours + i);

  const book = () => {
    if (!chosen || !room) return;
    navigate(`/book?room=${room.id}&date=${shownDate}&hours=${hours}&start=${chosen.hour}`);
  };

  return (
    <section className="bk" aria-labelledby="bk-title">
      <header className="bk-head">
        <h2 id="bk-title" className="bk-title">{site.name}</h2>
        <p className="bk-desc">{site.intro}</p>
      </header>

      <dl className="bk-facts">
        <div>
          <dt className="sr-only">Hours</dt>
          <dd><Clock aria-hidden="true" /> {hoursSentence(settings)}</dd>
        </div>
        <div>
          <dt className="sr-only">Location</dt>
          <dd>
            <MapPin aria-hidden="true" />{' '}
            <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(info.mapsQuery)}`} target="_blank" rel="noreferrer">
              {info.address[info.address.length - 1]}
            </a>
          </dd>
        </div>
      </dl>

      <div className="bk-options">
        <div className="bk-opt">
          <span className={rooms.length > 1 ? 'label' : 'sr-only'} id="bk-room-label">Room</span>
          <div className="bk-chips" role="radiogroup" aria-labelledby="bk-room-label">
            {rooms.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={r.id === room?.id}
                className="bk-chip"
                onClick={() => setRoomId(r.id)}
              >
                {r.name} <small className="tnum">{peso(r.hourlyRate)}/hr</small>
              </button>
            ))}
          </div>
        </div>
        <div className="bk-opt">
          <span className="label" id="bk-hours-label">How long</span>
          <div className="bk-chips" role="radiogroup" aria-labelledby="bk-hours-label">
            {hourChoices.map((h) => (
              <button
                key={h}
                type="button"
                role="radio"
                aria-checked={h === hours}
                aria-label={hoursText(h)}
                className="bk-chip bk-chip--narrow"
                onClick={() => setHours(h)}
              >
                {h} hr
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bk-pick">
        <div className="bk-cal">
          <MonthCalendar
            month={month}
            onMonthChange={setMonth}
            value={shownDate}
            min={today}
            max={maxDate}
            closedWeekdays={settings.closed_weekdays}
            days={dayMap}
            loading={monthLoading}
            onPick={(d) => {
              setDate(d);
              setStart(null);
            }}
          />
          {monthError && <p className="bk-note" role="alert">{monthError.message} Days may show as open when they are not.</p>}
        </div>

        <div className="bk-times">
          <h3 className="bk-day" aria-live="polite">{dateLabel(shownDate, { long: true })}</h3>
          {availError && !chips ? (
            <div className="bk-note" role="alert">
              {availError.message}{' '}
              <button type="button" className="bk-link" onClick={() => reload()}>Try again</button>
            </div>
          ) : !chips ? (
            <div className="bk-slots" aria-label="Loading times">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton bk-slot-skel" />
              ))}
            </div>
          ) : closedReason ? (
            <p className="bk-empty">{closedReason} Pick another day.</p>
          ) : chips.length === 0 ? (
            <p className="bk-empty">
              Nothing open for {hoursText(hours)} in {room.name} on this day. Try fewer hours, another room or another day.
            </p>
          ) : (
            <div className="bk-slots" role="radiogroup" aria-label="Start time">
              {chips.map((c) => (
                <button
                  key={c.hour}
                  type="button"
                  role="radio"
                  aria-checked={c.hour === start}
                  className="bk-slot"
                  onClick={() => setStart(c.hour)}
                >
                  <span className="tnum">{rangeLabel(c.hour, c.hour + hours)}</span>
                  <span className={clsx('bk-left', c.left === 1 && 'is-last')}>{c.left} left</span>
                </button>
              ))}
            </div>
          )}
          {bufferText(settings) && <p className="bk-note bk-buffer-note">{bufferText(settings)}</p>}
          <p id="bk-hint" className={clsx('bk-hint', chosen && 'is-ready')} aria-live="polite">
            {chosen
              ? `${room.name}, ${dateLabel(shownDate)}, ${rangeLabel(chosen.hour, chosen.hour + hours)} · ${peso(total)}`
              : 'Please select a time slot'}
          </p>
        </div>
      </div>

      <div className="bk-foot">
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!chosen} aria-describedby="bk-hint" onClick={book}>
          Book now
        </button>
      </div>
    </section>
  );
}
