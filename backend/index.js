import './env.js';
import './guard.js';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import { STUDIO_TZ } from './lib/time.js';
import { GALLERY_DIR } from './lib/uploads.js';
import { sweepAndNotify, cleanupReceipts } from './lib/payments.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');
const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.disable('x-powered-by');
// How many reverse proxies sit in front of this server (their X-Forwarded-For hop is trusted for req.ip). The rate
// limits are keyed by req.ip, so this must match the real setup: if it is too high a client can spoof the header and
// dodge the limits. 0 trusts no proxy. Default 1, which is a single proxy (Nginx, Caddy or a host's load balancer).
const trustProxyEnv = (process.env.TRUST_PROXY ?? '').trim();
app.set('trust proxy', /^\d+$/.test(trustProxyEnv) ? Number(trustProxyEnv) : 1);
app.use(express.json({ limit: '100kb' }));

// Uploaded gallery photos. File names are random, so they can be cached for good.
app.use(
  '/media/gallery',
  (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  },
  express.static(GALLERY_DIR, { dotfiles: 'deny', index: false, fallthrough: false, maxAge: '30d', immutable: true })
);
app.use('/media', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// In production, serve the built React app and let the client router handle paths.
const dist = path.join(__dirname, '..', 'frontend', 'dist');
if (!isDev && fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (req.path.startsWith('/media/') && [400, 403, 404].includes(err.status)) {
    return res.status(404).json({ error: 'Not found.' });
  }
  // Body-parser errors carry the raw request body (booking details, QR text, emails), so they are answered before
  // anything is logged and are never logged themselves.
  if (err.type === 'entity.too.large') {
    const isPhoto = req.method === 'POST' && req.path === '/api/admin/gallery';
    const isScreenshot =
      req.method === 'POST' && (req.path === '/api/bookings/payment-proof' || /^\/api\/admin\/payments\/\d+\/balance$/.test(req.path));
    return res.status(413).json({
      error: isPhoto
        ? 'That file is too large. Photos can be up to 5 MB.'
        : isScreenshot
          ? 'That screenshot is too large. Screenshots can be up to 15 MB.'
          : 'The request is too large.',
    });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
  // Log the kind and message only: never the error object, which can hold request data.
  console.error(`[api] ${req.method} ${req.path} failed: ${err.type || err.name}: ${err.message}`);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

// Holds that ran out are released every minute (reads also sweep lazily), and old receipt screenshots are deleted hourly.
setInterval(sweepAndNotify, 60_000).unref();
setInterval(cleanupReceipts, 3_600_000).unref();
sweepAndNotify();
cleanupReceipts();

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT} (${isDev ? 'dev' : 'production'}, time zone ${STUDIO_TZ})`);
});
