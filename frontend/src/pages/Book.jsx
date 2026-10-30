import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import NumberFlow from '@number-flow/react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { AlertCircle, Check, Copy, Gift, Info } from 'lucide-react';
import { useSite } from '../lib/site-data.jsx';
import { useAvailability } from '../lib/useAvailability.js';
import { api } from '../lib/api.js';
import { startOptions, promoFreeHours } from '../lib/schedule.js';
import { addDays, dateLabel, hourLabel, hoursText, peso, rangeLabel, weekdayOf } from '../lib/format.js';
import { ScheduleBoard } from '../components/ScheduleBoard.jsx';
import { Field, Stepper } from '../components/ui.jsx';
import { HowToBook, claimTour } from '../components/HowToBook.jsx';
import { Legend } from '../components/DayView.jsx';

const STEPS = ['Time', 'Your details', 'Review'];
const DRAFT_KEY = 'booking_details_draft';

const readDraft = () => {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}');
  } catch {
    return {};
  }
};

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

export default function Book() {
  const { data: siteData, status } = useSite();
  if (status === 'error') {
    return (
      <div className="page wrap">
        <h1 className="page-title">Book a room</h1>
        <div className="notice notice-bad" style={{ marginTop: 20 }}>
          <AlertCircle /> The booking page didn’t load. Check your connection, then refresh.
        </div>
      </div>
    );
  }
  if (!siteData) {
    return (
      <div className="page wrap">
        <div className="skeleton" style={{ height: 40, width: 260 }} />
        <div className="skeleton" style={{ height: 320, marginTop: 24 }} />
      </div>
    );
  }
  return <BookingFlow siteData={siteData} />;
}

function BookingFlow({ siteData }) {
  const { rooms, settings, now } = siteData;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const today = now.date;

  const initialRoom = rooms.find((r) => String(r.id) === params.get('room')) || rooms[0];
  const paramDate = params.get('date');
  const paramStart = params.get('start');

  const [step, setStep] = useState(0);

  // First visit: show a short animated walkthrough. "How to book" reopens it.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => claimTour('book') && setTourOpen(true), 500);
    return () => clearTimeout(t);
  }, []);
  const onTourChange = setTourOpen;
  const [roomId, setRoomId] = useState(initialRoom?.id);
  const [date, setDate] = useState(paramDate && paramDate >= today ? paramDate : today);
  const [paidHours, setPaidHours] = useState(
    clamp(settings.promo_enabled ? settings.promo_buy_hours : settings.min_hours, settings.min_hours, settings.max_hours)
  );
  const [startHour, setStartHour] = useState(paramStart !== null ? Number(paramStart) : null);
  const [details, setDetails] = useState(() => ({
    name: '',
    bandName: '',
    phone: '',
    email: '',
    headcount: 4,
    notes: '',
    ...readDraft(),
  }));
  const [payment, setPayment] = useState({ method: 'pay_at_studio', ref: '' });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [slotNotice, setSlotNotice] = useState('');
  const checkedParamStart = useRef(false);
  const topRef = useRef(null);

  const room = rooms.find((r) => r.id === roomId);
  const { data: avail, loading: availLoading, reload } = useAvailability(date);
  const busy = useMemo(() => avail?.rooms.find((r) => r.id === roomId)?.busy || [], [avail, roomId]);
  const options = useMemo(
    () => (avail && avail.date === date ? startOptions({ busy, settings, window: avail.window, paidHours }) : []),
    [avail, busy, settings, paidHours, date]
  );
  const selected = options.find((o) => o.hour === startHour && o.ok) || null;

  // Drop a start time that no longer fits (room, date or length changed, or someone booked it).
  useEffect(() => {
    if (!avail || avail.date !== date || startHour === null) return;
    const opt = options.find((o) => o.hour === startHour);
    if (!opt || !opt.ok) {
      if (!checkedParamStart.current && paramStart !== null) {
        setSlotNotice(`${hourLabel(startHour)} doesn’t fit ${hoursText(paidHours)} on this day. Pick another start time.`);
      }
      setStartHour(null);
    }
    checkedParamStart.current = true;
  }, [avail, date, options, startHour, paidHours, paramStart]);

  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(details));
    } catch {
      /* ignore */
    }
  }, [details]);

  useEffect(() => {
    if (room && details.headcount > room.capacity) setDetails((d) => ({ ...d, headcount: room.capacity }));
  }, [room, details.headcount]);

  const freeHours = selected?.freeHours || 0;
  const endHour = selected ? selected.hour + paidHours + freeHours : null;
  const total = room ? room.hourlyRate * paidHours : 0;
  const promoEligible = promoFreeHours(paidHours, settings) > 0;

  const goTo = (n) => {
    setStep(n);
    requestAnimationFrame(() => topRef.current?.scrollIntoView({ block: 'start' }));
  };

  const validateDetails = () => {
    const e = {};
    if (!details.name.trim()) e.name = 'Enter the name of the person booking.';
    const digits = details.phone.replace(/\D/g, '');
    if (!/^(09\d{9}|639\d{9}|9\d{9})$/.test(digits)) e.phone = 'Enter a mobile number like 0917 123 4567.';
    if (details.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) e.email = 'Check the email address.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const next = () => {
    if (step === 0) {
      if (!selected) return;
      goTo(1);
    } else if (step === 1) {
      if (validateDetails()) goTo(2);
    } else {
      submit();
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const { booking, freeNote } = await api.createBooking({
        roomId,
        date,
        startHour: selected.hour,
        paidHours,
        ...details,
        paymentMethod: payment.method,
        paymentRef: payment.method === 'gcash' ? payment.ref : '',
      });
      try {
        sessionStorage.setItem('last_booking', JSON.stringify({ booking, phone: details.phone }));
      } catch {
        /* ignore */
      }
      if (freeNote) toast(freeNote);
      navigate(`/booking/${booking.code}`, { state: { booking, phone: details.phone, justBooked: true } });
    } catch (err) {
      if (err.status === 400 && Object.keys(err.fields).length) {
        setErrors(err.fields);
        goTo(1);
        toast.error(err.message);
      } else if (err.status === 409) {
        toast.error(err.message);
        reload();
        setStartHour(null);
        goTo(0);
      } else {
        toast.error(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const ctaLabel =
    step === 0 ? 'Continue' : step === 1 ? 'Review booking' : submitting ? 'Booking…' : `Book for ${peso(total)}`;
  const ctaDisabled = (step === 0 && !selected) || submitting;

  return (
    <div className="page book-page" ref={topRef}>
      <div className="wrap">
        <HowToBook variant="book" open={tourOpen} onOpenChange={onTourChange} hideKey="book" />
        <div className="book-title-row">
          <h1 className="page-title">Book a room</h1>
          <button type="button" className="day-view-help" onClick={() => setTourOpen(true)}>
            How to book
          </button>
        </div>
        <ol className="steps" aria-label="Booking steps">
          {STEPS.map((label, i) => (
            <li key={label} className={clsx('step', i === step && 'is-current', i < step && 'is-done')}>
              {i < step ? (
                <button type="button" className="step-btn" onClick={() => goTo(i)}>
                  <span className="step-num" aria-hidden="true">
                    <Check size={14} strokeWidth={3} />
                  </span>
                  {label}
                </button>
              ) : (
                <span className="step-btn" aria-current={i === step ? 'step' : undefined}>
                  <span className="step-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  {label}
                </span>
              )}
            </li>
          ))}
        </ol>

        <div className="book-layout">
          <div className="book-main" key={step}>
            {step === 0 && (
              <>
                <section className="book-block" aria-labelledby="pick-room">
                  <h2 id="pick-room" className="block-title">Room</h2>
                  <div className="room-options" role="radiogroup" aria-labelledby="pick-room">
                    {rooms.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        role="radio"
                        aria-checked={r.id === roomId}
                        className="room-option"
                        style={{ '--room': r.color }}
                        onClick={() => setRoomId(r.id)}
                      >
                        <span className="room-option-name">{r.name}</span>
                        <span className="room-option-price tnum">
                          {peso(r.hourlyRate)}
                          <small>/hr</small>
                        </span>
                        <span className="room-option-meta">Up to {r.capacity} people</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="book-block" aria-labelledby="pick-date">
                  <h2 id="pick-date" className="block-title">Date</h2>
                  <DateStrip value={date} onChange={setDate} today={today} settings={settings} />
                </section>

                <section className="book-block" aria-labelledby="pick-length">
                  <h2 id="pick-length" className="block-title">How long</h2>
                  <div className="length-row">
                    <Stepper
                      label="Hours"
                      value={paidHours}
                      onChange={setPaidHours}
                      min={settings.min_hours}
                      max={settings.max_hours}
                      format={hoursText}
                    />
                    {settings.promo_enabled && (
                      <p className={clsx('promo-hint', promoEligible && 'is-on')}>
                        <Gift aria-hidden="true" />
                        {promoEligible
                          ? `Plus ${hoursText(settings.promo_free_hours)} free when the next hour is open`
                          : `Book ${hoursText(settings.promo_buy_hours)} to get the next hour free`}
                      </p>
                    )}
                  </div>
                </section>

                <section className="book-block" aria-labelledby="pick-time">
                  <h2 id="pick-time" className="block-title">Start time</h2>
                  {slotNotice && (
                    <div className="notice notice-warn" style={{ marginBottom: 14 }}>
                      <Info /> {slotNotice}
                    </div>
                  )}
                  <TimePicker
                    options={options}
                    loading={availLoading && !avail}
                    window={avail?.window}
                    value={startHour}
                    paidHours={paidHours}
                    onChange={(h) => {
                      setSlotNotice('');
                      setStartHour(h);
                    }}
                  />
                  {avail && room && avail.window.open && (
                    <div className="lane-preview">
                      <div className="lane-preview-bar">
                        <Legend isPublic />
                      </div>
                      <ScheduleBoard
                        theme="light"
                        rooms={[room]}
                        showRates={false}
                        openHour={settings.open_hour}
                        closeHour={settings.close_hour}
                        nowHour={avail.date === avail.now.date ? avail.now.hour + avail.now.minute / 60 : null}
                        earliest={avail.window.earliest}
                        focusHour={selected ? selected.hour : avail.window.earliest}
                        items={{
                          [room.id]: [
                            ...busy.map((b) => ({ ...b, label: b.kind === 'block' ? 'Closed' : 'Booked' })),
                            ...(selected
                              ? [
                                  { kind: 'selection', start: selected.hour, end: selected.hour + paidHours, label: 'Your booking', id: 'sel' },
                                  ...(freeHours
                                    ? [{ kind: 'free-bonus', start: selected.hour + paidHours, end: endHour, label: 'Free', id: 'free' }]
                                    : []),
                                ]
                              : []),
                          ],
                        }}
                        onSelectFree={(_, h) => {
                          const opt = options.find((o) => o.hour === h);
                          if (opt?.ok) {
                            setSlotNotice('');
                            setStartHour(h);
                          } else {
                            toast(`${hoursText(paidHours)} from ${hourLabel(h)} runs into another booking or closing time.`);
                          }
                        }}
                        freeLabel="Start at"
                      />
                    </div>
                  )}
                </section>
              </>
            )}

            {step === 1 && (
              <DetailsStep
                details={details}
                setDetails={setDetails}
                errors={errors}
                setErrors={setErrors}
                room={room}
                payment={payment}
                setPayment={setPayment}
                settings={settings}
              />
            )}

            {step === 2 && selected && (
              <ReviewStep
                room={room}
                date={date}
                start={selected.hour}
                end={endHour}
                paidHours={paidHours}
                freeHours={freeHours}
                details={details}
                payment={payment}
                settings={settings}
                onEdit={goTo}
              />
            )}
          </div>

          <aside className="book-summary" aria-label="Booking summary">
            <div className="summary-card">
              <h2 className="summary-title">Your booking</h2>
              <dl className="summary-list">
                <div>
                  <dt>Room</dt>
                  <dd>{room?.name}</dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd>{dateLabel(date, { long: true })}</dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd className="tnum">{selected ? rangeLabel(selected.hour, endHour) : 'Pick a start time'}</dd>
                </div>
              </dl>
              <div className="summary-price">
                <div className="price-line">
                  <span className="tnum">
                    {hoursText(paidHours)} × {peso(room?.hourlyRate)}
                  </span>
                  <span className="tnum">{peso(total)}</span>
                </div>
                {freeHours > 0 && (
                  <div className="price-line price-free">
                    <span>{hoursText(freeHours)} free</span>
                    <span className="tnum">{peso(0)}</span>
                  </div>
                )}
                <div className="price-total">
                  <span>Total</span>
                  <NumberFlow
                    className="tnum"
                    value={total}
                    locales="en-PH"
                    format={{ style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }}
                  />
                </div>
              </div>
              <button type="button" className="btn btn-primary btn-lg btn-block summary-cta" onClick={next} disabled={ctaDisabled}>
                {ctaLabel}
              </button>
              {step === 2 && (
                <p className="summary-fine">
                  {settings.auto_confirm
                    ? 'Your booking is confirmed as soon as you book.'
                    : 'The studio confirms new bookings. You’ll get a booking code to check the status.'}
                </p>
              )}
            </div>
          </aside>
        </div>
      </div>

      {/* Phones: the total and the next step stay within thumb reach */}
      <div className="book-bar">
        <div className="book-bar-info">
          <span className="book-bar-time tnum">
            {selected ? `${dateLabel(date)}, ${rangeLabel(selected.hour, endHour)}` : 'Pick a start time'}
          </span>
          <NumberFlow
            className="book-bar-total tnum"
            value={total}
            locales="en-PH"
            format={{ style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }}
          />
        </div>
        <button type="button" className="btn btn-primary btn-lg" onClick={next} disabled={ctaDisabled}>
          {step === 2 ? (submitting ? 'Booking…' : 'Book now') : ctaLabel}
        </button>
      </div>
    </div>
  );
}

function DateStrip({ value, onChange, today, settings }) {
  const stripRef = useRef(null);
  const days = useMemo(
    () => Array.from({ length: settings.max_days_ahead + 1 }, (_, i) => addDays(today, i)),
    [today, settings.max_days_ahead]
  );

  useEffect(() => {
    const el = stripRef.current?.querySelector('[aria-checked="true"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  return (
    <div className="date-strip-wrap">
      <div className="date-strip" ref={stripRef} role="radiogroup" aria-label="Date">
        {days.map((d, i) => {
          const closed = settings.closed_weekdays.includes(weekdayOf(d));
          const [wd, md] = dateLabel(d).split(', ');
          const showMonth = i === 0 || d.endsWith('-01');
          return (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={d === value}
              aria-label={`${dateLabel(d, { long: true })}${closed ? ', closed' : ''}`}
              className="date-pill"
              disabled={closed}
              onClick={() => onChange(d)}
            >
              <span className="date-pill-wd">{i === 0 ? 'Today' : wd}</span>
              <span className="date-pill-day tnum">{md.split(' ')[1]}</span>
              <span className="date-pill-mo">{showMonth || d === value ? md.split(' ')[0] : ' '}</span>
            </button>
          );
        })}
      </div>
      <label className="date-jump">
        <span>Or pick a date</span>
        <input
          type="date"
          className="input"
          min={today}
          max={days[days.length - 1]}
          value={value}
          onChange={(e) => e.target.value && onChange(e.target.value)}
        />
      </label>
    </div>
  );
}

function TimePicker({ options, loading, window: win, value, onChange, paidHours }) {
  if (loading) {
    return (
      <div className="time-grid">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 56 }} />
        ))}
      </div>
    );
  }
  if (win && !win.open) {
    return <p className="empty-note">{win.reason} Pick another date.</p>;
  }
  const available = options.filter((o) => o.ok);
  if (!available.length) {
    return (
      <p className="empty-note">
        Nothing fits {hoursText(paidHours)} on this day. Try fewer hours or another date.
      </p>
    );
  }
  return (
    <div className="time-grid" role="radiogroup" aria-label="Start time">
      {options
        .filter((o) => !o.past)
        .map((o) => (
          <button
            key={o.hour}
            type="button"
            role="radio"
            aria-checked={value === o.hour}
            disabled={!o.ok}
            className={clsx('time-chip', o.freeHours > 0 && 'has-free')}
            onClick={() => onChange(o.hour)}
          >
            <span className="time-chip-start tnum">{hourLabel(o.hour)}</span>
            <span className="time-chip-end tnum">
              {o.ok ? `until ${hourLabel(o.hour + paidHours + o.freeHours)}` : o.reason === 'closing' ? 'Past closing' : 'Taken'}
            </span>
          </button>
        ))}
    </div>
  );
}

function DetailsStep({ details, setDetails, errors, setErrors, room, payment, setPayment, settings }) {
  const set = (k) => (e) => {
    const value = e.target.value;
    setDetails((d) => ({ ...d, [k]: value }));
    if (errors[k]) setErrors(({ [k]: _drop, ...rest }) => rest);
  };
  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(settings.gcash_number.replace(/\s/g, ''));
      toast.success('GCash number copied');
    } catch {
      toast('Copy didn’t work here. The number is ' + settings.gcash_number);
    }
  };
  return (
    <>
      <section className="book-block" aria-labelledby="who">
        <h2 id="who" className="block-title">Who’s coming</h2>
        <div className="form-grid">
          <Field label="Your name" error={errors.name}>
            {(p) => <input {...p} className="input" autoComplete="name" value={details.name} onChange={set('name')} maxLength={80} />}
          </Field>
          <Field label="Band name" optional>
            {(p) => <input {...p} className="input" value={details.bandName} onChange={set('bandName')} maxLength={80} />}
          </Field>
          <Field label="Mobile number" error={errors.phone} hint="We’ll use this to reach you about your booking.">
            {(p) => (
              <input
                {...p}
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0917 123 4567"
                value={details.phone}
                onChange={set('phone')}
                maxLength={16}
              />
            )}
          </Field>
          <Field label="Email" optional error={errors.email}>
            {(p) => (
              <input
                {...p}
                className="input"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                value={details.email}
                onChange={set('email')}
                maxLength={120}
              />
            )}
          </Field>
          <div className="field">
            <span className="field-label" id="headcount-label">
              How many people
            </span>
            <Stepper
              label="People"
              value={details.headcount}
              onChange={(v) => setDetails((d) => ({ ...d, headcount: v }))}
              min={1}
              max={room?.capacity || 10}
              format={(v) => `${v} ${v === 1 ? 'person' : 'people'}`}
            />
            {errors.headcount ? (
              <span className="field-error">{errors.headcount}</span>
            ) : (
              <span className="field-hint">{room?.name} fits up to {room?.capacity}.</span>
            )}
          </div>
          <Field label="Anything we should prepare?" optional className="span-2">
            {(p) => (
              <textarea
                {...p}
                className="textarea"
                placeholder="Extra mic, keyboard stand, recording the session…"
                value={details.notes}
                onChange={set('notes')}
                maxLength={500}
              />
            )}
          </Field>
        </div>
      </section>

      <section className="book-block" aria-labelledby="pay">
        <h2 id="pay" className="block-title">Payment</h2>
        <div className="pay-options" role="radiogroup" aria-labelledby="pay">
          <button
            type="button"
            role="radio"
            aria-checked={payment.method === 'pay_at_studio'}
            className="pay-option"
            onClick={() => setPayment((p) => ({ ...p, method: 'pay_at_studio' }))}
          >
            <span className="pay-option-title">Pay at the studio</span>
            <span className="pay-option-desc">Cash or GCash when you arrive.</span>
          </button>
          {settings.gcash_enabled && (
            <button
              type="button"
              role="radio"
              aria-checked={payment.method === 'gcash'}
              className="pay-option"
              onClick={() => setPayment((p) => ({ ...p, method: 'gcash' }))}
            >
              <span className="pay-option-title">Send a GCash downpayment</span>
              <span className="pay-option-desc">Holds your slot while the studio confirms.</span>
            </button>
          )}
        </div>
        {payment.method === 'gcash' && settings.gcash_enabled && (
          <div className="gcash-box">
            <div className="gcash-account">
              <div>
                <span className="gcash-label">Send to</span>
                <span className="gcash-name">{settings.gcash_name}</span>
                <span className="gcash-number tnum">{settings.gcash_number}</span>
              </div>
              <button type="button" className="btn btn-outline btn-sm" onClick={copyNumber}>
                <Copy /> Copy number
              </button>
            </div>
            <Field label="GCash reference number" optional hint="You can also send the receipt on Messenger later.">
              {(p) => (
                <input
                  {...p}
                  className="input tnum"
                  inputMode="numeric"
                  autoComplete="off"
                  value={payment.ref}
                  onChange={(e) => setPayment((x) => ({ ...x, ref: e.target.value }))}
                  maxLength={40}
                />
              )}
            </Field>
          </div>
        )}
      </section>
    </>
  );
}

function ReviewStep({ room, date, start, end, paidHours, freeHours, details, payment, settings, onEdit }) {
  return (
    <>
      <section className="book-block" aria-labelledby="review-time">
        <div className="review-head">
          <h2 id="review-time" className="block-title">When</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(0)}>
            Change
          </button>
        </div>
        <p className="review-big">
          {room.name}, {dateLabel(date, { long: true })}
        </p>
        <p className="review-sub tnum">
          {rangeLabel(start, end)} ({hoursText(paidHours)}
          {freeHours ? ` + ${hoursText(freeHours)} free` : ''})
        </p>
      </section>

      <section className="book-block" aria-labelledby="review-who">
        <div className="review-head">
          <h2 id="review-who" className="block-title">Who’s coming</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(1)}>
            Change
          </button>
        </div>
        <dl className="review-list">
          <div>
            <dt>Name</dt>
            <dd>{details.name}</dd>
          </div>
          {details.bandName && (
            <div>
              <dt>Band</dt>
              <dd>{details.bandName}</dd>
            </div>
          )}
          <div>
            <dt>Mobile</dt>
            <dd className="tnum">{details.phone}</dd>
          </div>
          {details.email && (
            <div>
              <dt>Email</dt>
              <dd className="break">{details.email}</dd>
            </div>
          )}
          <div>
            <dt>People</dt>
            <dd>{details.headcount}</dd>
          </div>
          <div>
            <dt>Payment</dt>
            <dd>
              {payment.method === 'gcash' ? `GCash downpayment${payment.ref ? `, ref ${payment.ref}` : ''}` : 'Pay at the studio'}
            </dd>
          </div>
          {details.notes && (
            <div>
              <dt>Notes</dt>
              <dd className="break">{details.notes}</dd>
            </div>
          )}
        </dl>
      </section>

      <div className="notice">
        <Info />
        <span>
          You can cancel online up to {settings.cancel_cutoff_hours} hours before your slot. After that, message the studio.
        </span>
      </div>
    </>
  );
}
