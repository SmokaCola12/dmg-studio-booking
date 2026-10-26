import { lazy, Suspense, useEffect } from 'react';
import { Link, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { SiteProvider } from './lib/site-data.jsx';
import { SiteFooter, SiteHeader } from './components/SiteChrome.jsx';
import Home from './pages/Home.jsx';
import Book from './pages/Book.jsx';
import BookingDone from './pages/BookingDone.jsx';
import CheckBooking from './pages/CheckBooking.jsx';

// The admin is a separate chunk so the public site stays light on phones.
const AdminApp = lazy(() => import('./pages/admin/AdminApp.jsx'));

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView();
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

function PublicLayout() {
  return (
    <SiteProvider>
      <SiteHeader />
      <main id="main">
        <Outlet />
      </main>
      <SiteFooter />
    </SiteProvider>
  );
}

function NotFound() {
  return (
    <div className="page wrap">
      <h1 className="page-title">This page doesn’t exist</h1>
      <p className="page-lead">The link might be old or mistyped.</p>
      <p style={{ marginTop: 24 }}>
        <Link to="/" className="btn btn-dark">
          Go to the home page
        </Link>
      </p>
    </div>
  );
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<Home />} />
          <Route path="book" element={<Book />} />
          <Route path="booking/:code" element={<BookingDone />} />
          <Route path="check" element={<CheckBooking />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route
          path="admin/*"
          element={
            <Suspense fallback={<div className="admin-loading" />}>
              <AdminApp />
            </Suspense>
          }
        />
      </Routes>
      <Toaster theme="system" position="top-center" mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }} closeButton={false} />
    </>
  );
}
