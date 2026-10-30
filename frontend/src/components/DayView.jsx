import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Info } from 'lucide-react';
import { ScheduleBoard } from './ScheduleBoard.jsx';
import { STATUS_LABELS, hourLabel, rangeLabel } from '../lib/format.js';

function readStored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === 'timeline' || v === 'list' ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Open stretches of the day for one room: hours not taken by a booking or block and not already past. */
function openStretches(roomItems, openHour, closeHour, earliest) {
  const taken = roomItems.filter((it) => it.kind === 'booking' || it.kind === 'block');
  const stretches = [];
  let from = null;
  for (let h = Math.max(openHour, earliest); h < closeHour; h++) {
    const busy = taken.some((it) => h < it.end && h + 1 > it.start);
    if (!busy && from === null) from = h;
    if (busy && from !== null) {
      stretches.push([from, h]);
      from = null;
    }
  }
  if (from !== null) stretches.push([from, closeHour]);
  return stretches;
}

function SimpleDay({ rooms, openHour, closeHour, items, earliest, isPublic, onSelectClip, onSelectFree }) {
  return (
    <div className="simple-day">
      {rooms.map((room) => {
        const roomItems = items[room.id] || [];
        const rows = [
          ...roomItems
            .filter((it) => it.kind === 'booking' || it.kind === 'block')
            .map((it) => ({ type: it.kind, start: it.start, end: it.end, it })),
          ...openStretches(roomItems, openHour, closeHour, earliest).map(([start, end]) => ({ type: 'open', start, end })),
        ].sort((a, b) => a.start - b.start);

        return (
          <section key={room.id} className="simple-room" style={{ '--room': room.color }}>
            <h3 className="simple-room-name">
              <span aria-hidden="true" className="room-swatch" />
              {room.name}
            </h3>
            {rows.length === 0 ? (
              <p className="simple-empty">Nothing open for the rest of the day.</p>
            ) : (
              <ul className="simple-rows">
                {rows.map((row) => (
                  <li key={`${row.type}-${row.start}`} className={clsx('simple-row', `simple-row--${row.type}`)}>
                    <span className="simple-time tnum">{rangeLabel(row.start, row.end)}</span>
                    {row.type === 'booking' && (
                      <>
                        <span className="simple-what">{isPublic ? 'Booked' : row.it.label}</span>
                        {!isPublic && row.it.status && (
                          <span className={clsx('badge', `badge-${row.it.status}`)}>{STATUS_LABELS[row.it.status] || row.it.status}</span>
                        )}
                        {!isPublic && onSelectClip && (
                          <button type="button" className="simple-act" onClick={() => onSelectClip(row.it, room)}>
                            View
                          </button>
                        )}
                      </>
                    )}
                    {row.type === 'block' && (
                      <span className="simple-what simple-what--muted">{isPublic ? 'Closed' : `Blocked: ${row.it.label}`}</span>
                    )}
                    {row.type === 'open' && (
                      <>
                        <span className="simple-what simple-what--muted">Open</span>
                        {onSelectFree && (
                          <button type="button" className="simple-act simple-act--primary" onClick={() => onSelectFree(room, row.start)}>
                            {isPublic ? 'Book' : 'Add booking'}
                          </button>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function Legend({ isPublic }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const chips = [
    ['open', 'Open'],
    ['booking', 'Booked'],
    ...(isPublic ? [] : [['pending', 'Waiting']]),
    ['block', 'Closed'],
    ['now', 'Now'],
  ];

  return (
    <div className="board-help" ref={ref}>
      <button
        type="button"
        className="info-btn"
        aria-label="How to read the timeline"
        aria-expanded={open}
        aria-controls="board-help-pop"
        onClick={() => setOpen((o) => !o)}
      >
        <Info aria-hidden="true" />
      </button>
      {open && (
        <div id="board-help-pop" className="info-pop" role="dialog" aria-label="How to read the timeline">
          <div className="pop-demo" aria-hidden="true">
            <div className="sc-lane">
              {Array.from({ length: 8 }, (_, n) => (
                <span key={n} className={n === 4 ? 'sc-cell sc-cell--target' : 'sc-cell'} />
              ))}
              <span className="sc-clip" />
              <span className="pop-block" />
              <span className="pop-now" />
            </div>
            <svg className="tc pop-cursor" viewBox="0 0 24 24">
              <path d="M5 3l14 7-6 2-2 6z" fill="#fff" stroke="#1e1729" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="pop-tip">{isPublic ? 'Tap an open hour to book' : 'Tap an open hour to add a booking'}</p>
          <ul className="pop-chips">
            {chips.map(([k, label]) => (
              <li key={k}>
                <span className={`key key--${k}`} aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Day schedule with a switcher: a plain list (default, easiest to read) or the timeline board,
 * plus an info popover explaining the timeline. The choice is remembered on this device.
 * `isPublic` is the customer-facing version: dark, no booker details.
 */
export function DayView({
  rooms,
  openHour,
  closeHour,
  items,
  nowHour,
  earliest = null,
  intro = false,
  isPublic = false,
  onHelp,
  onSelectClip,
  onSelectFree,
  freeLabel,
}) {
  const storeKey = isPublic ? 'dmg-site-day-view' : 'dmg-admin-day-view';
  const [view, setView] = useState(() => readStored(storeKey, 'list'));
  const choose = (v) => {
    setView(v);
    try {
      localStorage.setItem(storeKey, v);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  };
  const listEarliest = earliest ?? (nowHour === null ? openHour : Math.ceil(nowHour));

  return (
    <div className={clsx('day-view', isPublic && 'day-view--dark')}>
      <div className="day-view-bar">
        <div className="seg" role="group" aria-label="Schedule view">
          <button type="button" className="seg-btn" aria-pressed={view === 'list'} onClick={() => choose('list')}>
            List
          </button>
          <button type="button" className="seg-btn" aria-pressed={view === 'timeline'} onClick={() => choose('timeline')}>
            Timeline
          </button>
        </div>
        {!isPublic && (
          <span className="day-view-hours tnum">
            Open {hourLabel(openHour)} to {hourLabel(closeHour)}
          </span>
        )}
        {onHelp && (
          <button type="button" className="day-view-help" onClick={onHelp}>
            How to book
          </button>
        )}
        {view === 'timeline' && <Legend isPublic={isPublic} />}
      </div>

      {view === 'list' ? (
        <SimpleDay
          rooms={rooms}
          openHour={openHour}
          closeHour={closeHour}
          items={items}
          earliest={listEarliest}
          isPublic={isPublic}
          onSelectClip={onSelectClip}
          onSelectFree={onSelectFree}
        />
      ) : (
        <ScheduleBoard
          theme={isPublic ? 'dark' : 'light'}
          rooms={rooms}
          openHour={openHour}
          closeHour={closeHour}
          items={items}
          nowHour={nowHour}
          earliest={earliest}
          intro={intro}
          onSelectClip={onSelectClip}
          onSelectFree={onSelectFree}
          freeLabel={freeLabel}
        />
      )}
    </div>
  );
}
