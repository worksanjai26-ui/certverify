import { createApp } from './app.js';

const { app, cfg, keys } = await createApp();

app.listen(cfg.port, () => {
  console.log(`CertVerify API listening on http://localhost:${cfg.port}`);
  console.log(`  Database:          ${cfg.databaseUrl ? 'Turso (TURSO_DATABASE_URL)' : `local file in ${cfg.dataDir}`}`);
  console.log(`  QR codes point to: ${cfg.publicUrl}/verify/<id>`);
  console.log(`  Institution key:   ${keys.keyId}`);
});
