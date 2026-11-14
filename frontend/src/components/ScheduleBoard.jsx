import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Waveform } from './Waveform.jsx';
import { hourLabel, peso, rangeLabel } from '../lib/format.js';

/**
 * The day schedule drawn like a DAW arrangement: each room is a track,
 * each booking is a clip, the red line is "now". Open hours are tappable.
 *
 * items: { [roomId]: [{ start, end, kind: 'booking'|'block'|'selection'|'free-bonus'|'buffer', label, sub, status, id, data }] }
 * start/end are decimal hours (15.5 = 3:30 PM). 'buffer' is the cleaning time after a booking.
 */
export function ScheduleBoard({
  rooms,
  openHour,
  closeHour,
  items = {},
  nowHour = null,      // fractional hour (e.g. 15.5) when the board shows today
  earliest = null,     // hours before this can't be booked
  focusHour: focusProp, // hour to scroll into view on narrow screens (defaults to now)
  onSelectFree,        // (room, hour) => void
  onSelectClip,        // (item, room) => void
  theme = 'dark',
  intro = false,       // play the one-time "recording" reveal on first render
  showRates = true,
  freeLabel = 'Book',
}) {
  const hours = Math.max(closeHour - openHour, 1);
  const [playIntro, setPlayIntro] = useState(intro);
  const scrollRef = useRef(null);
  const focusHour = focusProp ?? nowHour ?? earliest;

  useEffect(() => {
    if (!intro) return;
    const t = setTimeout(() => setPlayIntro(false), 1400);
    return () => clearTimeout(t);
  }, [intro]);

  // On narrow screens the board scrolls sideways. Start near "now" (once — the clock ticks every
  // minute and we shouldn't yank the board away from where the user scrolled), and follow an
  // explicit focus hour such as the slot being booked.
  const scrolledOnce = useRef(false);
  const scrollKey = focusProp ?? (scrolledOnce.current ? 'done' : focusHour);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || focusHour === null || scrollKey === 'done') return;
    if (el.scrollWidth <= el.clientWidth) return;
    const p = Math.min(Math.max((focusHour - 1 - openHour) / hours, 0), 1);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ left: p * (el.scrollWidth - el.clientWidth), behavior: scrolledOnce.current && !reduce ? 'smooth' : 'auto' });
    scrolledOnce.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, openHour, hours]);

  const cols = Array.from({ length: hours }, (_, i) => openHour + i);
  // Start times can fall on :00 or :30, so the tappable cells are half hours.
  const cells = Array.from({ length: hours * 2 }, (_, i) => openHour + i / 2);
  const pct = (h) => ((h - openHour) / hours) * 100;
  const showNow = nowHour !== null && nowHour >= openHour && nowHour <= closeHour;
  const pastEnd = earliest !== null ? Math.min(Math.max(earliest, openHour), closeHour) : openHour;

  // Show the meridiem only where it changes, the way a printed schedule does.
  const rulerLabel = (h, i) => {
    if (i === 0 || h === 12 || h === 13) return hourLabel(h);
    return hourLabel(h, { short: true });
  };

  let clipIndex = 0;

  return (
    <div className={clsx('board', `board--${theme}`)} data-intro={playIntro || undefined}>
      <div className="board-scroll" ref={scrollRef}>
        <div className="board-grid" style={{ '--hours': hours }}>
          <div className="board-corner" aria-hidden="true" />
          <div className="board-ruler" aria-hidden="true">
            {cols.map((h, i) => (
              <span key={h} className="ruler-tick" style={{ left: `${pct(h)}%` }}>
                <span className="ruler-label tnum">{rulerLabel(h, i)}</span>
              </span>
            ))}
          </div>

          {rooms.map((room) => {
            const roomItems = items[room.id] || [];
            const blocked = (h) =>
              h < pastEnd ||
              roomItems.some((it) => it.kind !== 'free-bonus' && it.kind !== 'selection' && h < it.end && h + 0.5 > it.start);
            return (
              <div className="board-row" key={room.id} style={{ '--room': room.color }}>
                <div className="board-track">
                  <span className="track-name">{room.name}</span>
                  {showRates && room.hourlyRate !== undefined && (
                    <span className="track-meta tnum">{peso(room.hourlyRate)}/hr</span>
                  )}
                </div>

                <div className="board-lane">
                  {pastEnd > openHour && (
                    <div className="lane-past" style={{ left: 0, width: `${pct(pastEnd)}%` }} aria-hidden="true" />
                  )}

                  <div className="lane-cells" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}>
                    {cells.map((h) => {
                      const half = h % 1 !== 0;
                      return onSelectFree && !blocked(h) ? (
                        <button
                          key={h}
                          type="button"
                          className={clsx('lane-cell', half && 'lane-cell--half')}
                          onClick={() => onSelectFree(room, h)}
                          aria-label={`${freeLabel} ${room.name} at ${hourLabel(h)}`}
                        >
                          <span className="lane-cell-hint">+ {hourLabel(h)}</span>
                        </button>
                      ) : (
                        <span key={h} className={clsx('lane-cell lane-cell--off', half && 'lane-cell--half')} aria-hidden="true" />
                      );
                    })}
                  </div>

                  {roomItems.map((it) => {
                    const i = clipIndex++;
                    const width = pct(it.end) - pct(it.start);
                    const style = { left: `${pct(it.start)}%`, width: `${width}%`, '--i': i };
                    const clickable = onSelectClip && it.kind === 'booking' && it.data;
                    const Tag = clickable ? 'button' : 'div';
                    return (
                      <Tag
                        key={`${it.kind}-${it.id ?? it.start}`}
                        type={clickable ? 'button' : undefined}
                        className={clsx('clip', `clip--${it.kind}`, it.status && `clip--${it.status}`)}
                        style={style}
                        onClick={clickable ? () => onSelectClip(it, room) : undefined}
                        title={`${it.label || ''} ${rangeLabel(it.start, it.end)}`.trim()}
                      >
                        <span className="clip-head">
                          <span className="clip-label">{it.label}</span>
                          {it.sub && <span className="clip-sub tnum">{it.sub}</span>}
                        </span>
                        {(it.kind === 'booking' || it.kind === 'selection') && (
                          <Waveform seed={room.id * 100 + it.start} bars={Math.max(6, (it.end - it.start) * 10)} />
                        )}
                      </Tag>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {showNow && (
            <div
              className="board-playhead"
              style={{ '--p': (nowHour - openHour) / hours }}
              aria-label={`Current time, about ${hourLabel(Math.floor(nowHour * 2) / 2)}`}
              role="img"
            />
          )}
        </div>
      </div>
    </div>
  );
}
