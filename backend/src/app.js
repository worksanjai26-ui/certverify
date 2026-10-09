import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { backendRoot, config } from './config.js';
import { openDb, seed } from './db.js';
import { resolveKeys } from './crypto.js';
import { createAuth } from './auth.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';

export async function createApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const db = await openDb(cfg);
  const keys = await resolveKeys(cfg, db);
  await seed(db, cfg);
  const auth = createAuth(db, cfg);
  const ctx = { db, keys, auth, cfg };

  const app = express();
  app.disable('x-powered-by');
  // On Vercel the client IP arrives via the platform's proxy headers.
  app.set('trust proxy', cfg.onVercel ? true : 'loopback');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use('/api', publicRouter(ctx));
  app.use('/api/admin', adminRouter(ctx));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // Serve the built React app (npm run build) with SPA fallback.
  const dist = path.resolve(backendRoot, '..', 'frontend', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()));
  }

  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `The file is larger than ${cfg.maxUploadMb} MB. Compress the scan and try again.` });
    }
    const status = err.name === 'MulterError' ? 400 : err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error.' : err.message });
  });

  return { app, ...ctx };
}
