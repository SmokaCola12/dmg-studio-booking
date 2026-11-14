import { StatusBadge } from '../../components/ui.jsx';
import { bookingEnd, bookingStart, formatPhone, peso, rangeLabel, relativeDay } from '../../lib/format.js';

/** One booking in a list. The whole row opens the booking; `action` sits at the end. */
export function BookingRow({ booking: b, today, onOpen, action, showStatus = true }) {
  return (
    <li className="b-row" style={{ '--room': b.roomColor }}>
      <button type="button" className="b-row-main" onClick={() => onOpen(b)}>
        <span className="b-row-when tnum">
          <span className="b-row-day">{relativeDay(b.date, today)}</span>
          <span className="b-row-time">{rangeLabel(bookingStart(b), bookingEnd(b))}</span>
        </span>
        <span className="b-row-who">
          <span className="b-row-name">{b.bandName || b.name}</span>
          <span className="b-row-meta">
            {b.roomName}
            {b.bandName ? `, ${b.name}` : ''}
            {b.phone ? `, ${formatPhone(b.phone)}` : ''}
          </span>
        </span>
        <span className="b-row-end">
          {showStatus && <StatusBadge status={b.status} />}
          <span className="b-row-total tnum">{peso(b.total)}</span>
        </span>
      </button>
      {action && <div className="b-row-action">{action}</div>}
    </li>
  );
}
