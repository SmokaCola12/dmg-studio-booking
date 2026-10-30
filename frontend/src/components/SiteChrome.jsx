import { Link, NavLink, useLocation } from 'react-router-dom';
import { MapPin, Phone, MessageCircle } from 'lucide-react';
import { site } from '../config/site.js';

export function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label={`${site.name}, home`}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3" y="8" width="14" height="7" rx="2" fill="var(--marigold)" />
        <rect x="12" y="18" width="15" height="7" rx="2" fill="var(--teal)" />
        <rect x="20" y="4" width="2.4" height="24" rx="1.2" fill="var(--rec)" />
      </svg>
      <span>{site.shortName}</span>
    </Link>
  );
}

export function SiteHeader() {
  const { pathname } = useLocation();
  const onBooking = pathname.startsWith('/book');
  return (
    <header className="site-header">
      <div className="wrap site-header-inner">
        <Wordmark />
        <nav className="site-nav" aria-label="Main">
          <a href="/#rooms" className="nav-link nav-hide-sm">Rooms</a>
          <a href="/#visit" className="nav-link nav-hide-sm">Visit</a>
          <NavLink to="/check" className="nav-link">My booking</NavLink>
          {!onBooking && (
            <Link to="/book" className="btn btn-primary btn-sm nav-cta">
              Book a room
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div className="footer-brand">
          <Wordmark />
          <p>{site.tagline}</p>
        </div>
        <div className="footer-col">
          <h2>Find us</h2>
          <p className="footer-line">
            <MapPin aria-hidden="true" />
            <span>
              {site.address.map((l) => (
                <span key={l} className="block">
                  {l}
                </span>
              ))}
            </span>
          </p>
        </div>
        <div className="footer-col">
          <h2>Talk to us</h2>
          <p className="footer-line">
            <Phone aria-hidden="true" />
            <a href={`tel:${site.phone.replace(/\s/g, '')}`}>{site.phone}</a>
          </p>
          <p className="footer-line">
            <MessageCircle aria-hidden="true" />
            <a href={site.messenger} target="_blank" rel="noreferrer">
              Message us on Messenger
            </a>
          </p>
        </div>
        <div className="footer-col">
          <h2>Follow</h2>
          {site.socials.map((s) => (
            <p key={s.label}>
              <a href={s.href} target="_blank" rel="noreferrer">
                {s.label}
              </a>
            </p>
          ))}
        </div>
      </div>
      <div className="wrap footer-base">
        <span>
          © {new Date().getFullYear()} {site.name}
        </span>
        <Link to="/admin">Staff login</Link>
      </div>
    </footer>
  );
}
