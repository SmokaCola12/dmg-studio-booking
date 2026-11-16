import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import NumberFlow from '@number-flow/react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { AlertCircle, Check, Gift, Info } from 'lucide-react';
import { useSite } from '../lib/site-data.jsx';
import { useAvailability } from '../lib/useAvailability.js';
import { api } from '../lib/api.js';
import { bufferMinutes, startOptions, promoFreeHours, withBufferClips } from '../lib/schedule.js';
import { addDays, dateLabel, depositAmount, hourLabel, hoursText, peso, rangeLabel, splitStart } from '../lib/format.js';
import { MonthCalendar } from '../components/MonthCalendar.jsx';
import { useMonthAvailability } from '../lib/useMonthAvailability.js';
import { DayView } from '../components/DayView.jsx';
import { Field, Stepper } from '../components/ui.jsx';
import { HowToBook, claimTour } from '../components/HowToBook.jsx';

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
        <h1 className="page-title">Book</h1>
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
  const paramHours = params.get('hours');

  // Coming from the home card with a time already picked: go straight to the details.
  // If that time turns out not to fit, the check below sends them back to the picker.
  // start can be a half hour like 15.5 (3:30 PM)
  const validStart = paramStart !== null && paramStart !== '' && Number.isFinite(Number(paramStart)) && (Number(paramStart) * 2) % 1 === 0;
  const fromCard = validStart && Boolean(paramDate) && paramDate >= today && rooms.some((r) => String(r.id) === params.get('room'));
  const [step, setStep] = useState(fromCard ? 1 : 0);

  // First visit: show a short animated walkthrough. "How to book" reopens it.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => !fromCard && claimTour('book') && setTourOpen(true), 500);
    return () => clearTimeout(t);
  }, []);
  const onTourChange = setTourOpen;
  const [roomId, setRoomId] = useState(initialRoom?.id);
  const [date, setDate] = useState(paramDate && paramDate >= today ? paramDate : today);
  const [paidHours, setPaidHours] = useState(() => {
    const fromUrl = Number.parseInt(paramHours, 10);
    if (Number.isInteger(fromUrl) && String(fromUrl) === paramHours) return clamp(fromUrl, settings.min_hours, settings.max_hours);
    return clamp(settings.promo_enabled ? settings.promo_buy_hours : settings.min_hours, settings.min_hours, settings.max_hours);
  });
  // Decimal hour on the studio clock: 15.5 means 3:30 PM.
  const [startHour, setStartHour] = useState(validStart ? Number(paramStart) : null);
  const [details, setDetails] = useState(() => ({
    name: '',
    bandName: '',
    phone: '',
    email: '',
    headcount: 4,
    notes: '',
    ...readDraft(),
  }));
  // method: 'pay_at_studio' | 'gcash'. plan (GCash only): 'half' pays 50% now, 'full' pays 100% now.
  const [payment, setPayment] = useState({ method: 'pay_at_studio', plan: 'half' });
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
  // How many rooms can take each start hour, shown as "N left" like the home card.
  const lefts = useMemo(() => {
    if (!avail || avail.date !== date) return {};
    const count = {};
    for (const r of rooms) {
      const opts = startOptions({ busy: avail.rooms.find((x) => x.id === r.id)?.busy || [], settings, window: avail.window, paidHours });
      for (const o of opts) if (o.ok) count[o.hour] = (count[o.hour] || 0) + 1;
    }
    return count;
  }, [avail, rooms, settings, paidHours, date]);

  // Drop a start time that no longer fits (room, date or length changed, or someone booked it).
  useEffect(() => {
    if (!avail || avail.date !== date || startHour === null) return;
    const opt = options.find((o) => o.hour === startHour);
    if (!opt || !opt.ok) {
      if (!checkedParamStart.current && paramStart !== null) {
        setSlotNotice(`${hourLabel(startHour)} doesn’t fit ${hoursText(paidHours)} on this day. Pick another start time.`);
      }
      setStartHour(null);
      setStep(0);
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
  // GCash: what is paid now, rounded up to a whole peso. The rest is paid at the studio.
  const gcash = payment.method === 'gcash' && settings.gcash_enabled;
  const amountDue = gcash ? depositAmount(total, payment.plan) : total;

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
      if (validateDetails()) goTo(selected ? 2 : 0);
    } else {
      submit();
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const { booking, freeNote, serverTime } = await api.createBooking({
        roomId,
        date,
        ...splitStart(selected.hour),
        paidHours,
        ...details,
        paymentMethod: gcash ? 'gcash' : 'pay_at_studio',
        ...(gcash ? { paymentPlan: payment.plan } : {}),
      });
      try {
        sessionStorage.setItem('last_booking', JSON.stringify({ booking, phone: details.phone, serverTime }));
      } catch {
        /* ignore */
      }
      if (freeNote) toast(freeNote);
      // GCash bookings go straight to the QR and receipt upload; the slot is held while they pay.
      const nextPage = gcash ? `/booking/${booking.code}/pay` : `/booking/${booking.code}`;
      navigate(nextPage, { state: { booking, phone: details.phone, serverTime, justBooked: true } });
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

  // On the last step the button says what is paid now: the deposit for GCash, the total otherwise.
  const ctaLabel =
    step === 0 ? 'Continue' : step === 1 ? 'Review booking' : submitting ? 'Booking…' : `Book for ${peso(amountDue)}`;
  const ctaDisabled = (step === 0 && !selected) || submitting;

  return (
    <div className="page book-page" ref={topRef}>
      <div className="wrap">
        <HowToBook variant="book" open={tourOpen} onOpenChange={onTourChange} hideKey="book" />
        <div className="book-title-row">
          <h1 className="page-title">Book</h1>
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
                  <h2 id="pick-room" className="block-title">Studio</h2>
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
                  <h2 id="pick-time" className="block-title">Date and time</h2>
                  {slotNotice && (
                    <div className="notice notice-warn" style={{ marginBottom: 14 }}>
                      <Info /> {slotNotice}
                    </div>
                  )}
                  <div className="bk-pick">
                    <DatePicker
                      value={date}
                      onChange={(d) => {
                        setSlotNotice('');
                        setStartHour(null);
                        setDate(d);
                      }}
                      today={today}
                      settings={settings}
                    />
                    <div className="bk-times">
                      <h3 className="bk-day" aria-live="polite">{dateLabel(date, { long: true })}</h3>
                      <TimePicker
                        options={options}
                        lefts={lefts}
                        loading={availLoading && !avail}
                        window={avail?.window}
                        value={startHour}
                        paidHours={paidHours}
                        onChange={(h) => {
                          setSlotNotice('');
                          setStartHour(h);
                        }}
                      />
                    </div>
                  </div>
                  {avail && room && avail.window.open && (
                    <div className="lane-preview">
                      <DayView
                        isPublic
                        theme="light"
                        rooms={[room]}
                        boardProps={{ showRates: false, focusHour: selected ? selected.hour : avail.window.earliest }}
                        openHour={settings.open_hour}
                        closeHour={settings.close_hour}
                        nowHour={avail.date === avail.now.date ? avail.now.hour + avail.now.minute / 60 : null}
                        earliest={avail.window.earliest}
                        items={{
                          [room.id]: [
                            ...withBufferClips(
                              busy.map((b, i) => ({ ...b, id: b.id ?? `${b.kind}-${i}`, label: b.kind === 'block' ? 'Closed' : 'Booked' })),
                              bufferMinutes(settings)
                            ),
                            ...(selected
                              ? [
                                  { kind: 'selection', start: selected.hour, end: selected.hour + paidHours, label: `Your pick · ${hoursText(paidHours)}`, id: 'sel' },
                                  ...(freeHours
                                    ? [{ kind: 'free-bonus', start: selected.hour + paidHours, end: endHour, label: 'Bonus hour · free', id: 'free' }]
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
                        listReadOnly
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
                total={total}
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
                gcash={gcash}
                amountDue={amountDue}
                total={total}
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
                  <dt>Studio</dt>
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
              {step > 0 && step < 3 && (
                <button type="button" className="btn btn-ghost btn-sm summary-change" onClick={() => goTo(0)}>
                  Change studio, day or time
                </button>
              )}
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
                {gcash && (
                  <>
                    <div className="price-line price-now">
                      <span>Pay now by GCash ({payment.plan === 'half' ? '50%' : '100%'})</span>
                      <span className="tnum">{peso(amountDue)}</span>
                    </div>
                    {total - amountDue > 0 && (
                      <div className="price-line">
                        <span>Balance at the studio</span>
                        <span className="tnum">{peso(total - amountDue)}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
              <button type="button" className="btn btn-primary btn-lg btn-block summary-cta" onClick={next} disabled={ctaDisabled}>
                {ctaLabel}
              </button>
              {step === 2 && (
                <p className="summary-fine">
                  {gcash
                    ? `Next you’ll scan a QR and upload your GCash receipt. Your slot is held for ${settings.gcash_hold_minutes || 30} minutes while you pay.`
                    : settings.auto_confirm
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
          <span className="book-bar-amount">
            {/* GCash: the bar shows what is paid now (same as the button) and the total; pay at the studio: the total */}
            <NumberFlow
              className="book-bar-total tnum"
              value={gcash ? amountDue : total}
              locales="en-PH"
              format={{ style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }}
            />
            {gcash && total !== amountDue && <span className="book-bar-sub tnum"> now · {peso(total)} total</span>}
            {gcash && total === amountDue && <span className="book-bar-sub tnum"> now</span>}
          </span>
        </div>
        <button type="button" className="btn btn-primary btn-lg" onClick={next} disabled={ctaDisabled}>
          {step === 2 ? (submitting ? 'Booking…' : gcash ? ctaLabel : 'Book now') : ctaLabel}
        </button>
      </div>
    </div>
  );
}

/** Same month calendar as the home page card, so both pages pick a day the same way. */
function DatePicker({ value, onChange, today, settings }) {
  const [month, setMonth] = useState(value.slice(0, 7));
  const { data, error, loading } = useMonthAvailability(month);
  const dayMap = useMemo(() => Object.fromEntries((data?.days || []).map((d) => [d.date, d])), [data]);

  // Follow the date if it changes from outside (e.g. a prefilled link).
  useEffect(() => {
    setMonth(value.slice(0, 7));
  }, [value]);

  return (
    <div className="bk-cal">
      <MonthCalendar
        month={month}
        onMonthChange={setMonth}
        value={value}
        min={today}
        max={addDays(today, settings.max_days_ahead)}
        closedWeekdays={settings.closed_weekdays}
        days={dayMap}
        loading={loading}
        onPick={onChange}
      />
      {error && <p className="bk-note" role="alert">{error.message} Days may show as open when they are not.</p>}
    </div>
  );
}

function TimePicker({ options, lefts, loading, window: win, value, onChange, paidHours }) {
  if (loading) {
    return (
      <div className="bk-slots">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton bk-slot-skel" />
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
    <div className="bk-slots" role="radiogroup" aria-label="Start time">
      {options
        .filter((o) => o.ok)
        .map((o) => {
          const left = lefts[o.hour] || 1;
          return (
            <button
              key={o.hour}
              type="button"
              role="radio"
              aria-checked={value === o.hour}
              className="bk-slot"
              onClick={() => onChange(o.hour)}
            >
              <span className="tnum">{rangeLabel(o.hour, o.hour + paidHours + o.freeHours)}</span>
              <span className={clsx('bk-left', left === 1 && 'is-last')}>{left} left</span>
            </button>
          );
        })}
    </div>
  );
}

function DetailsStep({ details, setDetails, errors, setErrors, room, payment, setPayment, settings, total }) {
  const set = (k) => (e) => {
    const value = e.target.value;
    setDetails((d) => ({ ...d, [k]: value }));
    if (errors[k]) setErrors(({ [k]: _drop, ...rest }) => rest);
  };
  const holdMinutes = settings.gcash_hold_minutes || 30;
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
          <Field label="Email" optional error={errors.email} hint="Payment updates are sent here.">
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
              <span className="pay-option-title">Pay with GCash</span>
              <span className="pay-option-desc">Pay 50% or 100% now to hold your slot.</span>
            </button>
          )}
        </div>
        {payment.method === 'gcash' && settings.gcash_enabled && (
          <div className="pay-plans-wrap">
            <div className="pay-plans" role="radiogroup" aria-label="How much to pay now">
              {[
                ['half', 'Pay 50% now', total > 0 ? `${peso(depositAmount(total, 'half'))} now, ${peso(total - depositAmount(total, 'half'))} at the studio` : ''],
                ['full', 'Pay 100% now', total > 0 ? `${peso(total)} now, nothing left to pay` : ''],
              ].map(([plan, title, desc]) => (
                <button
                  key={plan}
                  type="button"
                  role="radio"
                  aria-checked={payment.plan === plan}
                  className="pay-plan"
                  onClick={() => setPayment((p) => ({ ...p, plan }))}
                >
                  <span className="pay-plan-title">{title}</span>
                  <span className="pay-plan-amount tnum">{peso(depositAmount(total, plan))}</span>
                  <span className="pay-plan-desc">{desc}</span>
                </button>
              ))}
            </div>
            <p className="bk-note">
              Next you’ll get a GCash QR with the exact amount. Pay, then upload a screenshot of your receipt. Your slot is held for {holdMinutes} minutes while you do.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

function ReviewStep({ room, date, start, end, paidHours, freeHours, details, payment, gcash, amountDue, total, settings, onEdit }) {
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
              {gcash
                ? `GCash, ${payment.plan === 'half' ? '50%' : '100%'} now (${peso(amountDue)})${total - amountDue > 0 ? `, ${peso(total - amountDue)} at the studio` : ''}`
                : 'Pay at the studio'}
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
