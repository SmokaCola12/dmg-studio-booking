import './env.js';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import { STUDIO_TZ } from './lib/time.js';
import { GALLERY_DIR } from './lib/uploads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');
const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
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
  if (err.type === 'entity.too.large') {
    const isUpload = req.method === 'POST' && req.path === '/api/admin/gallery';
    return res.status(413).json({ error: isUpload ? 'That file is too large. Photos can be up to 5 MB.' : 'The request is too large.' });
  }
  console.error(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT} (${isDev ? 'dev' : 'production'}, time zone ${STUDIO_TZ})`);
});
