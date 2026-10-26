import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CalendarDays, DoorOpen, ExternalLink, LayoutList, LogOut, Settings as SettingsIcon, Sun } from 'lucide-react';
import { adminApi, adminToken } from '../../lib/api.js';
import { site } from '../../config/site.js';
import { AdminContext } from './admin-shared.jsx';
import Login from './Login.jsx';
import Overview from './Overview.jsx';
import Bookings from './Bookings.jsx';
import Schedule from './Schedule.jsx';
import Rooms from './Rooms.jsx';
import Settings from './Settings.jsx';
import '../../styles/admin.css';

const NAV = [
  { to: '/admin', label: 'Today', icon: Sun, end: true },
  { to: '/admin/bookings', label: 'Bookings', icon: LayoutList, badge: true },
  { to: '/admin/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/admin/rooms', label: 'Rooms', icon: DoorOpen },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];

export default function AdminApp() {
  const [authed, setAuthed] = useState(() => !!adminToken.get());

  useEffect(() => {
    document.title = `Admin | ${site.name}`;
    const onLogout = () => setAuthed(false);
    window.addEventListener('admin:logout', onLogout);
    return () => window.removeEventListener('admin:logout', onLogout);
  }, []);

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return <AdminShell onLogout={() => setAuthed(false)} />;
}

function AdminShell({ onLogout }) {
  const [pendingCount, setPendingCount] = useState(0);
  const [version, setVersion] = useState(0); // bump to make pages reload after a change elsewhere
  const lastCount = useRef(null);

  const refreshPending = useCallback(() => {
    adminApi
      .overview()
      .then((d) => {
        if (lastCount.current !== null && d.pendingCount > lastCount.current) {
          const n = d.pendingCount - lastCount.current;
          toast(n === 1 ? 'New booking request' : `${n} new booking requests`, {
            description: 'Open Bookings to confirm.',
          });
          setVersion((v) => v + 1);
        }
        lastCount.current = d.pendingCount;
        setPendingCount(d.pendingCount);
      })
      .catch(() => {});
  }, []);

  // New online bookings arrive while the admin is open; check every 45 seconds.
  useEffect(() => {
    refreshPending();
    const t = setInterval(() => document.visibilityState === 'visible' && refreshPending(), 45_000);
    return () => clearInterval(t);
  }, [refreshPending]);

  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    refreshPending();
  }, [refreshPending]);

  const logout = () => {
    adminToken.clear();
    onLogout();
  };

  return (
    <AdminContext.Provider value={{ pendingCount, changed, version }}>
      <div className="admin">
        <aside className="a-side">
          <Link to="/admin" className="wordmark a-wordmark">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <rect x="3" y="8" width="14" height="7" rx="2" fill="var(--marigold)" />
              <rect x="12" y="18" width="15" height="7" rx="2" fill="var(--teal)" />
              <rect x="20" y="4" width="2.4" height="24" rx="1.2" fill="var(--rec)" />
            </svg>
            <span>{site.shortName}</span>
          </Link>
          <nav className="a-nav" aria-label="Admin">
            {NAV.map(({ to, label, icon: Icon, end, badge }) => (
              <NavLink key={to} to={to} end={end} className="a-nav-link">
                <Icon aria-hidden="true" />
                <span>{label}</span>
                {badge && pendingCount > 0 && (
                  <span className="a-count" aria-label={`${pendingCount} waiting for approval`}>
                    {pendingCount}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="a-side-foot">
            <a href="/" target="_blank" rel="noreferrer" className="a-nav-link">
              <ExternalLink aria-hidden="true" />
              <span>View website</span>
            </a>
            <button type="button" className="a-nav-link" onClick={logout}>
              <LogOut aria-hidden="true" />
              <span>Log out</span>
            </button>
          </div>
        </aside>

        <header className="a-topbar">
          <Link to="/admin" className="wordmark a-wordmark">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <rect x="3" y="8" width="14" height="7" rx="2" fill="var(--marigold)" />
              <rect x="12" y="18" width="15" height="7" rx="2" fill="var(--teal)" />
              <rect x="20" y="4" width="2.4" height="24" rx="1.2" fill="var(--rec)" />
            </svg>
            <span>{site.shortName}</span>
          </Link>
          <div className="a-topbar-actions">
            <a href="/" target="_blank" rel="noreferrer" className="a-icon-btn" aria-label="View website">
              <ExternalLink />
            </a>
            <button type="button" className="a-icon-btn" onClick={logout} aria-label="Log out">
              <LogOut />
            </button>
          </div>
        </header>

        <main className="a-main">
          <Routes>
            <Route index element={<Overview />} />
            <Route path="bookings" element={<Bookings />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="rooms" element={<Rooms />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Overview />} />
          </Routes>
        </main>

        <nav className="a-tabbar" aria-label="Admin">
          {NAV.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink key={to} to={to} end={end} className="a-tab">
              <span className="a-tab-icon">
                <Icon aria-hidden="true" />
                {badge && pendingCount > 0 && <span className="a-dot">{pendingCount}</span>}
              </span>
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </AdminContext.Provider>
  );
}
