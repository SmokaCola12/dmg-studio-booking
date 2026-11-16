import { Link, NavLink, useLocation } from 'react-router-dom';
import { MapPin, Phone, Mail, MessageCircle } from 'lucide-react';
import { site } from '../config/site.js';
import { useStudioInfo } from '../lib/site-data.jsx';

/** The DMG logo and the word "Studio". Takes its text colour from where it sits. */
export function BrandMark() {
  return (
    <>
      <i className="logo-mark" role="img" aria-label="DMG" />
      <span className="brand-word">Studio</span>
    </>
  );
}

export function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label={`${site.name}, home`}>
      <BrandMark />
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
          <a href="/#rooms" className="nav-link nav-hide-sm">Studios</a>
          <a href="/#visit" className="nav-link nav-hide-sm">Visit</a>
          <NavLink to="/check" className="nav-link">My booking</NavLink>
          {!onBooking && (
            <Link to="/book" className="btn btn-primary btn-sm nav-cta">
              Book
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const info = useStudioInfo();
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
              {info.address.map((l, i) => (
                <span key={i} className="block">
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
            <a href={`tel:${info.phone.replace(/\s/g, '')}`}>{info.phone}</a>
          </p>
          {info.email && (
            <p className="footer-line">
              <Mail aria-hidden="true" />
              <a href={`mailto:${info.email}`}>{info.email}</a>
            </p>
          )}
          <p className="footer-line">
            <MessageCircle aria-hidden="true" />
            <a href={info.messenger} target="_blank" rel="noreferrer">
              Message us on Messenger
            </a>
          </p>
        </div>
        <div className="footer-col">
          <h2>Follow</h2>
          {info.socials.map((s) => (
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
