import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandMark } from '../../components/SiteChrome.jsx';
import { NavLink, Route, Routes, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CalendarDays, DoorOpen, ExternalLink, LayoutList, LogOut, Settings as SettingsIcon, Sun, Images, Wallet } from 'lucide-react';
import { adminApi, adminToken } from '../../lib/api.js';
import { site } from '../../config/site.js';
import { AdminContext } from './admin-shared.jsx';
import Login from './Login.jsx';
import Overview from './Overview.jsx';
import Bookings from './Bookings.jsx';
import Schedule from './Schedule.jsx';
import Rooms from './Rooms.jsx';
import Settings from './Settings.jsx';
import Content from './Content.jsx';
import GcashPayments from './GcashPayments.jsx';
import '../../styles/admin.css';

// badge: 'pending' counts bookings waiting for approval, 'payments' counts GCash receipts waiting to be checked.
const NAV = [
  { to: '/admin', label: 'Today', icon: Sun, end: true },
  { to: '/admin/bookings', label: 'Bookings', icon: LayoutList, badge: 'pending' },
  { to: '/admin/gcash', label: 'GCash payments', short: 'GCash', icon: Wallet, badge: 'payments' },
  { to: '/admin/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/admin/rooms', label: 'Studios', icon: DoorOpen },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon },
  { to: '/admin/content', label: 'Studio page', icon: Images, desktopOnly: true }, // reached from Settings on phones
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
  const [paymentsWaiting, setPaymentsWaiting] = useState(0);
  const [version, setVersion] = useState(0); // bump to make pages reload after a change elsewhere
  const lastCount = useRef(null);
  const lastPayments = useRef(null);

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

        const waiting = d.paymentsWaiting || 0;
        if (lastPayments.current !== null && waiting > lastPayments.current) {
          toast('New GCash receipt to check', { description: 'Open GCash payments to confirm it.' });
          setVersion((v) => v + 1);
        }
        lastPayments.current = waiting;
        setPaymentsWaiting(waiting);
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
    <AdminContext.Provider value={{ pendingCount, paymentsWaiting, changed, version }}>
      <div className="admin">
        <aside className="a-side">
          <Link to="/admin" className="wordmark a-wordmark">
            <BrandMark />
          </Link>
          <nav className="a-nav" aria-label="Admin">
            {NAV.map(({ to, label, icon: Icon, end, badge }) => {
              const count = badge === 'pending' ? pendingCount : badge === 'payments' ? paymentsWaiting : 0;
              return (
                <NavLink key={to} to={to} end={end} className="a-nav-link">
                  <Icon aria-hidden="true" />
                  <span>{label}</span>
                  {count > 0 && (
                    <span className="a-count" aria-label={`${count} ${badge === 'payments' ? 'receipts to check' : 'waiting for approval'}`}>
                      {count}
                    </span>
                  )}
                </NavLink>
              );
            })}
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
            <BrandMark />
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
            <Route path="gcash" element={<GcashPayments />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="rooms" element={<Rooms />} />
            <Route path="settings" element={<Settings />} />
            <Route path="content" element={<Content />} />
            <Route path="*" element={<Overview />} />
          </Routes>
        </main>

        <nav className="a-tabbar" aria-label="Admin">
          {NAV.filter((n) => !n.desktopOnly).map(({ to, label, short, icon: Icon, end, badge }) => {
            const count = badge === 'pending' ? pendingCount : badge === 'payments' ? paymentsWaiting : 0;
            return (
              <NavLink key={to} to={to} end={end} className="a-tab">
                <span className="a-tab-icon">
                  <Icon aria-hidden="true" />
                  {count > 0 && <span className="a-dot">{count}</span>}
                </span>
                <span>{short || label}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>
    </AdminContext.Provider>
  );
}
