import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock, CalendarDays, MessageCircle, Navigation, Phone } from 'lucide-react';
import { site } from '../config/site.js';
import { useSite, useStudioInfo, useGallery } from '../lib/site-data.jsx';
import { useAvailability } from '../lib/useAvailability.js';
import { Calendar } from '../components/Calendar.jsx';
import { DayView } from '../components/DayView.jsx';
import { BookingCard } from '../components/BookingCard.jsx';
import { HowToBook } from '../components/HowToBook.jsx';
import { addDays, dateLabel, hourLabel, hoursSentence, peso, relativeDay, rangeLabel } from '../lib/format.js';
import { bufferMinutes, promoText, withBufferClips } from '../lib/schedule.js';

/** "Room A is open until 6 PM" style summary of the current hour, for today only. */
function nowSummary(rooms, avail, settings) {
  if (!avail || avail.date !== avail.now.date) return null;
  const now = avail.now.hour + avail.now.minute / 60;
  if (now < settings.open_hour) return `Opens at ${hourLabel(settings.open_hour)} today.`;
  if (now >= settings.close_hour) return 'Closed for today. Book a slot for tomorrow.';
  const parts = rooms.map((room) => {
    const busy = avail.rooms.find((r) => r.id === room.id)?.busy || [];
    const current = busy.find((b) => now >= b.start && now < b.end);
    if (current) return `${room.name} is in use until ${hourLabel(current.end)}`;
    // Right after a booking the room is being cleaned and can't be started yet.
    const cleaning = busy.find((b) => b.kind !== 'block' && b.bufferEnd && now >= b.end && now < b.bufferEnd);
    if (cleaning) return `${room.name} is being cleaned until ${hourLabel(cleaning.bufferEnd)}`;
    const next = busy.filter((b) => b.start > now).sort((a, b) => a.start - b.start)[0];
    return `${room.name} is open${next ? ` until ${hourLabel(next.start)}` : ' for the rest of the day'}`;
  });
  return `Right now: ${parts.join('. ')}.`;
}

export default function Home() {
  const { data: siteData, status } = useSite();
  const info = useStudioInfo();
  const photos = useGallery();
  const navigate = useNavigate();
  const today = siteData?.now.date;
  const [date, setDate] = useState(null);
  const [calOpen, setCalOpen] = useState(false);
  const shownDate = date || today;
  const { data: avail, error: availError } = useAvailability(shownDate);

  const settings = siteData?.settings;
  const rooms = siteData?.rooms || [];

  // The tour no longer opens by itself on Home; "How to book" on the board still opens it.
  const [tourOpen, setTourOpen] = useState(false);

  const items = useMemo(() => {
    if (!avail) return {};
    return Object.fromEntries(
      avail.rooms.map((r) => [
        r.id,
        withBufferClips(
          r.busy.map((b, i) => ({
            ...b,
            id: b.id ?? `${b.kind}-${i}`,
            label: b.kind === 'block' ? 'Closed' : 'Booked',
            sub: rangeLabel(b.start, b.end),
          })),
          bufferMinutes(siteData?.settings)
        ),
      ])
    );
  }, [avail, siteData]);

  const isToday = avail && avail.date === avail.now.date;
  const nowHour = isToday ? avail.now.hour + avail.now.minute / 60 : null;
  const earliest = avail?.window?.open ? avail.window.earliest : avail ? settings?.close_hour : null;
  const promo = promoText(settings);

  const startBooking = (room, hour) => {
    navigate(`/book?room=${room.id}&date=${shownDate}&start=${hour}`);
  };

  return (
    <>
      <HowToBook open={tourOpen} onOpenChange={setTourOpen} hideKey="home" />
      <section className="hero" aria-labelledby="hero-title">
        <div className="wrap">
          <div className="hero-intro">
            <p className="hero-kicker label">
              <i className="rec-dot" aria-hidden="true" /> {site.name}
            </p>
            <h1 id="hero-title" className="hero-title">
              Book
            </h1>
            <p className="hero-lead">Pick a day, a start time and a room. Your details come on the next page.</p>
            <Link className="resched-nudge" to="/check">
              <CalendarClock aria-hidden="true" /> Need to reschedule? Move your booking
            </Link>
          </div>

          {settings && rooms.length > 0 && today && <BookingCard rooms={rooms} settings={settings} today={today} />}

          <div className="hero-board">
            <div className="board-bar">
              <div>
                <h2 className="board-title">
                  {shownDate ? `${relativeDay(shownDate, today)}${shownDate !== today ? '' : `, ${dateLabel(shownDate)}`}` : 'Today'}
                </h2>
                <p className="board-status" aria-live="polite">
                  {(avail && settings && nowSummary(rooms, avail, settings)) ||
                    (avail && !avail.window.open ? avail.window.reason : 'The live board. Tap an open hour to start booking it.')}
                </p>
              </div>
              {today && (
                <div className="day-switch" role="group" aria-label="Choose a day">
                  {[0, 1, 2].map((n) => {
                    const d = addDays(today, n);
                    return (
                      <button
                        key={d}
                        type="button"
                        className="day-btn"
                        aria-pressed={shownDate === d}
                        onClick={() => setDate(d)}
                      >
                        {n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : dateLabel(d).split(',')[0]}
                      </button>
                    );
                  })}
                  {(() => {
                    const custom = shownDate && addDays(today, 2) < shownDate;
                    return (
                      <button
                        type="button"
                        className="day-btn"
                        aria-pressed={custom}
                        onClick={() => setCalOpen(true)}
                      >
                        <CalendarDays aria-hidden="true" />
                        {custom ? dateLabel(shownDate) : 'Other date'}
                      </button>
                    );
                  })()}
                  {calOpen && (
                    <Calendar
                      value={shownDate}
                      min={today}
                      max={settings ? addDays(today, settings.max_days_ahead) : undefined}
                      closedWeekdays={settings?.closed_weekdays}
                      onPick={(d) => {
                        setDate(d);
                        setCalOpen(false);
                      }}
                      onClose={() => setCalOpen(false)}
                    />
                  )}
                </div>
              )}
            </div>

            {status === 'error' || availError ? (
              <div className="board-empty">
                <p>The schedule didn’t load. Check your connection, then refresh the page.</p>
              </div>
            ) : siteData && rooms.length === 0 ? (
              <div className="board-empty">
                <p>The schedule shows up here once the studio adds its rooms.</p>
              </div>
            ) : !siteData || !avail ? (
              <div className="board-skeleton" aria-label="Loading schedule">
                {[0, 1].map((i) => (
                  <div key={i} className="skeleton" />
                ))}
              </div>
            ) : (
              <DayView
                isPublic
                onHelp={() => setTourOpen(true)}
                rooms={rooms}
                openHour={settings.open_hour}
                closeHour={settings.close_hour}
                settings={settings}
                items={items}
                nowHour={nowHour}
                earliest={earliest}
                onSelectFree={startBooking}
                intro
              />
            )}
          </div>
        </div>
      </section>

      {promo && (
        <section className="promo" aria-label="Promo">
          <div className="wrap promo-inner">
            <div className="promo-graphic" aria-hidden="true">
              {Array.from({ length: settings.promo_buy_hours }, (_, i) => (
                <span key={i} />
              ))}
              {Array.from({ length: settings.promo_free_hours }, (_, i) => (
                <span key={`f${i}`} className="free" />
              ))}
            </div>
            <p className="promo-text">{promo}</p>
            <p className="promo-note">Added to your booking automatically whenever the next hour is open.</p>
          </div>
        </section>
      )}

      <section className="section" id="rooms" aria-labelledby="rooms-title">
        <div className="wrap">
          <div className="section-head">
            <p className="label section-kicker">Rooms / rates</p>
            <h2 id="rooms-title" className="section-title">Pick your room</h2>
            <p className="section-lead">Backline is set up and checked before you walk in. The rate is per hour for the whole band, not per head.</p>
          </div>

          <div className="room-list">
            {rooms.map((room) => (
              <article key={room.id} className="room" style={{ '--room': room.color }}>
                <div className="room-main">
                  <h3 className="room-name">{room.name}</h3>
                  <p className="room-desc">{room.description}</p>
                  <p className="room-cap label">Fits up to {room.capacity} people</p>
                </div>
                {room.gear.length > 0 && (
                  <ul className="room-gear" aria-label={`Gear in ${room.name}`}>
                    {room.gear.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                )}
                <div className="room-book">
                  <p className="room-price">
                    <span className="tnum">{peso(room.hourlyRate)}</span>
                    <span className="room-per">per hour</span>
                  </p>
                  <Link className="btn btn-dark" to={`/book?room=${room.id}`}>
                    Book {room.name}
                  </Link>
                </div>
              </article>
            ))}
            {status === 'ready' && rooms.length === 0 && (
              <p className="section-lead">Rooms will show up here once the studio adds them.</p>
            )}
          </div>
        </div>
      </section>

      <section className="section section-alt" aria-labelledby="gallery-title">
        <div className="wrap">
          <div className="section-head">
            <p className="label section-kicker">The rooms, as they are</p>
            <h2 id="gallery-title" className="section-title">Inside the studio</h2>
          </div>
          <div className="gallery">
            {photos.length > 0
              ? photos.map((g) => (
                  <figure key={g.id ?? g.src} className="gallery-item">
                    <img src={g.src} alt={g.alt} loading="lazy" />
                  </figure>
                ))
              : site.galleryPlaceholders.map((label) => (
                  <figure key={label} className="gallery-item gallery-placeholder">
                    <span className="label">Photo to come</span>
                    <figcaption>{label}</figcaption>
                  </figure>
                ))}
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="rules-title">
        <div className="wrap two-col">
          <div>
            <p className="label section-kicker">House rules</p>
            <h2 id="rules-title" className="section-title">Before you come</h2>
            <ul className="rules">
              {site.houseRules.map((r) => (
                <li key={r}>{r}</li>
              ))}
              {settings && (
                <li>
                  Cancel online up to {settings.cancel_cutoff_hours} hours before your slot, using your booking code and mobile number.
                </li>
              )}
            </ul>
          </div>
          <div>
            <p className="label section-kicker">FAQ</p>
            <h2 className="section-title">Questions</h2>
            <div className="faq">
              {site.faqs.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt" id="visit" aria-labelledby="visit-title">
        <div className="wrap visit">
          <div className="visit-info">
            <p className="label section-kicker">Find the door</p>
            <h2 id="visit-title" className="section-title">Visit</h2>
            <address className="visit-address">
              {info.address.map((l, i) => (
                <span key={i} className="block">
                  {l}
                </span>
              ))}
            </address>
            {info.landmark && <p className="visit-landmark">{info.landmark}</p>}
            {settings && <p className="visit-hours">{hoursSentence(settings)}.</p>}
            <div className="visit-actions">
              <a className="btn btn-dark" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(info.mapsQuery)}`} target="_blank" rel="noreferrer">
                <Navigation /> Get directions
              </a>
              <a className="btn btn-outline" href={`tel:${info.phone.replace(/\s/g, '')}`}>
                <Phone /> Call
              </a>
              <a className="btn btn-outline" href={info.messenger} target="_blank" rel="noreferrer">
                <MessageCircle /> Messenger
              </a>
            </div>
          </div>
          <div className="visit-map">
            <iframe
              title={`Map showing ${site.name}`}
              src={`https://www.google.com/maps?q=${encodeURIComponent(info.mapsQuery)}&output=embed`}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>
      </section>
    </>
  );
}
