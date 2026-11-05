import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { weekdayOf } from '../lib/format.js';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad = (n) => String(n).padStart(2, '0');

/**
 * Small month calendar in a centered sheet. Days outside min/max or on closed weekdays are greyed out.
 * Dates are 'YYYY-MM-DD' strings.
 */
export function Calendar({ value, min, max, closedWeekdays = [], onPick, onClose }) {
  const start = value || min;
  const [ym, setYm] = useState([Number(start.slice(0, 4)), Number(start.slice(5, 7))]);
  const [y, m] = ym;

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const first = `${y}-${pad(m)}-01`;
  const blanks = weekdayOf(first);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const canPrev = first > min.slice(0, 7) + '-01';
  const canNext = max ? `${y}-${pad(m)}-${pad(count)}` < max : true;
  const go = (n) => setYm(([yy, mm]) => {
    const t = new Date(Date.UTC(yy, mm - 1 + n, 1));
    return [t.getUTCFullYear(), t.getUTCMonth() + 1];
  });

  return (
    <div className="cal-backdrop" onClick={onClose}>
      <div className="cal" role="dialog" aria-label="Pick a date" onClick={(e) => e.stopPropagation()}>
        <div className="cal-head">
          <button type="button" className="cal-nav" aria-label="Previous month" disabled={!canPrev} onClick={() => go(-1)}>
            <ChevronLeft aria-hidden="true" />
          </button>
          <strong className="cal-month">{monthName}</strong>
          <button type="button" className="cal-nav" aria-label="Next month" disabled={!canNext} onClick={() => go(1)}>
            <ChevronRight aria-hidden="true" />
          </button>
          <button type="button" className="cal-nav" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="cal-grid">
          {WEEKDAYS.map((w) => (
            <span key={w} className="cal-wd" aria-hidden="true">
              {w}
            </span>
          ))}
          {Array.from({ length: blanks }, (_, i) => (
            <span key={`b${i}`} />
          ))}
          {Array.from({ length: count }, (_, i) => {
            const d = `${y}-${pad(m)}-${pad(i + 1)}`;
            const off = d < min || (max && d > max) || closedWeekdays.includes(weekdayOf(d));
            return (
              <button
                key={d}
                type="button"
                className={clsx('cal-day', d === value && 'cal-day--on', d === min && 'cal-day--today')}
                disabled={off}
                aria-pressed={d === value}
                onClick={() => onPick(d)}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
        <p className="cal-note">Greyed days can't be booked.</p>
      </div>
    </div>
  );
}
