import clsx from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { weekdayOf } from '../lib/format.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

const STATUS_TEXT = {
  open: 'open',
  few: 'few slots left',
  full: 'fully booked',
  closed: 'closed',
};

/**
 * Inline month calendar. `days` maps 'YYYY-MM-DD' to { status, reason }; while it is missing
 * (loading or failed) only the date range and closed weekdays limit the choice.
 * month is 'YYYY-MM'. Dates outside min..max are disabled.
 */
export function MonthCalendar({ month, onMonthChange, value, min, max, today = min, closedWeekdays = [], days, marks, loading, onPick }) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const first = `${month}-01`;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${month}-${pad(count)}`;
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'long', year: 'numeric' });

  const canPrev = first > min;
  const canNext = !max || last < max;
  const go = (n) => {
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    onMonthChange(`${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`);
  };

  return (
    <div className={clsx('mc', marks && 'mc--marks')} aria-busy={loading || undefined}>
      <div className="mc-head">
        <h3 className="mc-title" aria-live="polite">{title}</h3>
        <div className="mc-nav">
          <button type="button" aria-label="Previous month" disabled={!canPrev} onClick={() => go(-1)}>
            <ChevronLeft aria-hidden="true" />
          </button>
          <button type="button" aria-label="Next month" disabled={!canNext} onClick={() => go(1)}>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="mc-grid" role="group" aria-label={title}>
        {WEEKDAYS.map((w) => (
          <span key={w} className="mc-wd" aria-hidden="true">
            {w}
          </span>
        ))}
        {Array.from({ length: weekdayOf(first) }, (_, i) => (
          <span key={`b${i}`} />
        ))}
        {Array.from({ length: count }, (_, i) => {
          const d = `${month}-${pad(i + 1)}`;
          const info = days?.[d];
          const status = info?.status || (closedWeekdays.includes(weekdayOf(d)) ? 'closed' : null);
          const off = d < min || (max && d > max) || status === 'closed' || status === 'full';
          const mark = marks?.[d];
          const label = `${SHORT_MONTHS[m - 1]} ${i + 1}, ${
            marks
              ? mark?.bookings
                ? `${mark.bookings} ${mark.bookings === 1 ? 'booking' : 'bookings'}${mark.pending ? `, ${mark.pending} waiting` : ''}`
                : 'no bookings'
              : d < min || (max && d > max) ? 'not available' : STATUS_TEXT[status] || 'check times'
          }`;
          return (
            <button
              key={d}
              type="button"
              className={clsx('mc-day', `mc-day--${status || 'unknown'}`, d === value && 'is-on', d === today && 'is-today')}
              disabled={off}
              aria-pressed={d === value}
              aria-label={label}
              onClick={() => onPick(d)}
            >
              <span aria-hidden="true">{i + 1}</span>
              {mark?.bookings > 0 && (
                <span className={clsx('mc-count', mark.pending > 0 && 'mc-count--pending')} aria-hidden="true">
                  {mark.bookings}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {marks ? (
        <p className="mc-legend">
          <span><i className="mc-dot mc-dot--open" aria-hidden="true" /> Number = bookings that day</span>
          <span><i className="mc-dot mc-dot--few" aria-hidden="true" /> Some waiting for approval</span>
        </p>
      ) : (
        <p className="mc-legend">
          <span><i className="mc-dot mc-dot--open" aria-hidden="true" /> Open</span>
          <span><i className="mc-dot mc-dot--few" aria-hidden="true" /> Few left</span>
          <span>Greyed out: full or closed</span>
        </p>
      )}
    </div>
  );
}
