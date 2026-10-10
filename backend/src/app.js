import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { backendRoot, config } from './config.js';
import { hashPassword, resolveKeys } from './crypto.js';
import { createAuth } from './auth.js';
import { openStore } from './store/index.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';

// The registrar account is created on first start (from ADMIN_EMAIL / ADMIN_PASSWORD or the seed defaults).
async function seedAdmin(store, cfg) {
  const created = await store.ensureAdmin({ email: cfg.adminEmail, name: 'Registrar', passwordHash: hashPassword(cfg.adminPassword) });
  if (created) console.log(`[seed] created registrar account ${cfg.adminEmail} (password from ADMIN_PASSWORD)`);
}

export async function createApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  // Reading the text on a certificate photo (Tesseract) is lazy: it only costs anything on the first use,
  // and tests inject a stub instead of the real engine.
  cfg.ocr = typeof overrides.ocr === 'function' ? overrides.ocr : (await import('./ocr.js')).recognizeText;
  const store = await openStore(cfg);
  const keys = await resolveKeys(cfg, store);
  await seedAdmin(store, cfg);
  const auth = createAuth(store, cfg);
  const ctx = { store, keys, auth, cfg };

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
