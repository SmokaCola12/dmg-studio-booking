import { useState } from 'react';
import { Dialog } from './ui.jsx';

function Cursor() {
  return (
    <svg className="tc" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 3l14 7-6 2-2 6z" fill="#fff" stroke="#1e1729" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

const SCENES = {
  code: (
    <div className="sc sc-find">
      <span className="sc-label">Booking code</span>
      <div className="sc-input">
        <span className="sc-type sc-type--9">BK-7K2M9Q</span>
        <i className="sc-caret" />
      </div>
    </div>
  ),
  phone: (
    <div className="sc sc-find">
      <span className="sc-label">Mobile number</span>
      <div className="sc-input">
        <span className="sc-type sc-type--13">0917 123 4567</span>
        <i className="sc-caret" />
      </div>
    </div>
  ),
  result: (
    <div className="sc sc-result">
      <b className="sc-find-btn">Find booking</b>
      <div className="sc-ticket">
        <p><strong>Room A</strong></p>
        <p>Today, 2 – 4 PM</p>
        <span className="sc-ok">Confirmed</span>
      </div>
      <Cursor />
    </div>
  ),
  moveBtn: (
    <div className="sc sc-result sc-move">
      <div className="sc-ticket sc-ticket--static">
        <p><strong>Room A</strong></p>
        <p>Sat, 2 – 4 PM</p>
        <span className="sc-ok">Confirmed</span>
      </div>
      <b className="sc-find-btn sc-change-btn">Change time</b>
      <Cursor />
    </div>
  ),
  moved: (
    <div className="sc sc-moved">
      <div className="sc-ticket sc-ticket--static">
        <p><strong>Room A</strong></p>
        <p className="sc-time-swap">
          <s>Sat, 2 – 4 PM</s>
          <span>Sun, 5 – 7 PM</span>
        </p>
        <span className="sc-ok sc-ok--moved">Moved</span>
      </div>
    </div>
  ),
  room: (
    <div className="sc sc-room-pick">
      <div className="sc-days sc-days--2">
        <span className="sc-hl" />
        <span>Room A</span>
        <span>Room B</span>
      </div>
      <Cursor />
    </div>
  ),
  time: (
    <div className="sc sc-time">
      <div className="sc-times">
        {['10 AM', '11 AM', '12 NN', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM'].map((t, n) => (
          <span key={t} className={n === 5 ? 'sc-chip sc-chip--target' : 'sc-chip'}>{t}</span>
        ))}
      </div>
      <Cursor />
    </div>
  ),
  day: (
    <div className="sc sc-day">
      <div className="sc-days">
        <span className="sc-hl" />
        <span>Today</span>
        <span>Tomorrow</span>
        <span>Other</span>
      </div>
      <Cursor />
    </div>
  ),
  list: (
    <div className="sc sc-list">
      <p className="sc-room"><i /> Room A</p>
      <div className="sc-row sc-row--off"><span>10 – 12</span><span>Booked</span></div>
      <div className="sc-row"><span>12 – 10 PM</span><span>Open</span><b className="sc-book">Book</b></div>
      <Cursor />
    </div>
  ),
  timeline: (
    <div className="sc sc-tl">
      <p className="sc-room"><i /> Room A</p>
      <div className="sc-lane">
        {Array.from({ length: 8 }, (_, n) => (
          <span key={n} className={n === 5 ? 'sc-cell sc-cell--target' : 'sc-cell'} />
        ))}
        <span className="sc-clip" />
      </div>
      <Cursor />
    </div>
  ),
  hours: (
    <div className="sc sc-hours">
      <div className="sc-stepper">
        <span className="sc-minus">−</span>
        <span className="sc-count">
          <b className="n1">1</b>
          <b className="n2">2</b>
          <small>hours</small>
        </span>
        <span className="sc-plus">+</span>
      </div>
      <Cursor />
    </div>
  ),
  confirm: (
    <div className="sc sc-confirm">
      <span className="sc-field f1" />
      <span className="sc-field f2" />
      <span className="sc-field f3" />
      <b className="sc-confirm-btn">Confirm</b>
      <span className="sc-done" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" /></svg>
      </span>
      <Cursor />
    </div>
  ),
};

const HOME_STEPS = [
  { scene: 'day', title: 'Pick a day', line: 'Today, tomorrow or another date.' },
  { scene: 'timeline', title: 'Tap an empty hour', line: 'Gaps are open. Colored bars are taken.' },
  { scene: 'hours', title: 'Choose how many hours', line: 'Only times that fit can be picked.' },
  { scene: 'confirm', title: 'Add your details, confirm', line: 'You get a booking code. Find it later in My booking.' },
];

const BOOK_STEPS = [
  { scene: 'room', title: 'Pick a room', line: 'Each room has its own price and size.' },
  { scene: 'day', title: 'Pick a day', line: 'Today, tomorrow or another date.' },
  { scene: 'hours', title: 'Choose how many hours', line: 'Only times that fit can be picked.' },
  { scene: 'time', title: 'Tap a start time', line: 'Open times only. Then press Continue.' },
  { scene: 'confirm', title: 'Add your details, confirm', line: 'You get a booking code. Find it later in My booking.' },
];

const FIND_STEPS = [
  { scene: 'code', title: 'Enter your booking code', line: 'It starts with BK- and was shown when you booked.' },
  { scene: 'phone', title: 'Enter your mobile number', line: 'The same number you booked with.' },
  { scene: 'result', title: 'Tap Find booking', line: 'See your booking, or cancel it if plans change.' },
];

const RESCHED_STEPS = [
  { scene: 'moveBtn', title: 'Find your booking, tap Change time', line: 'Same room, same hours. Only the day and start move.' },
  { scene: 'time', title: 'Pick a new day and start time', line: 'Open times only. Your own slot is shown as yours.' },
  { scene: 'moved', title: 'Done, it is moved', line: 'Same booking code. Add the new time to your calendar.' },
];

const VARIANTS = { book: BOOK_STEPS, find: FIND_STEPS, resched: RESCHED_STEPS };

const hideStorageKey = (key) => `dmg-site-tour-hide-${key}`;

// Lives in memory, so a full page reload clears it but moving between pages does not.
const shownThisLoad = new Set();

/**
 * Whether a page should open its walkthrough by itself: once per page load,
 * and never after the visitor ticked "Never show this again".
 */
export function claimTour(key) {
  if (shownThisLoad.has(key)) return false;
  try {
    if (localStorage.getItem(hideStorageKey(key))) return false;
  } catch {
    return false;
  }
  shownThisLoad.add(key);
  return true;
}

/** Animated step-by-step explainer. Pages open it on every load; `hideKey` adds a "Never show this again" checkbox. */
export function HowToBook({ open, onOpenChange, variant = 'home', hideKey }) {
  const STEPS = VARIANTS[variant] || HOME_STEPS;
  const [i, setI] = useState(0);
  const [never, setNever] = useState(false);
  const last = i === STEPS.length - 1;
  const step = STEPS[i];

  const handleOpenChange = (next) => {
    if (!next) {
      setI(0);
      if (hideKey && never) {
        try {
          localStorage.setItem(hideStorageKey(hideKey), '1');
        } catch {
          /* not remembered in private mode */
        }
      }
    }
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={step.title}
      description={`${i + 1} of ${STEPS.length}`}
      footer={
        <>
          {i > 0 ? (
            <button type="button" className="btn btn-outline" onClick={() => setI(i - 1)}>
              Back
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => handleOpenChange(false)}>
              Skip
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => (last ? handleOpenChange(false) : setI(i + 1))}>
            {last ? 'Got it' : 'Next'}
          </button>
        </>
      }
    >
      <div className="tour-stage" key={step.scene}>
        {SCENES[step.scene]}
      </div>
      <p className="tour-line">{step.line}</p>
      <div className="tour-dots" aria-hidden="true">
        {STEPS.map((_, n) => (
          <span key={n} className={n === i ? 'is-on' : undefined} />
        ))}
      </div>
      {hideKey && (
        <label className="tour-never">
          <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
          Never show this again
        </label>
      )}
    </Dialog>
  );
}
