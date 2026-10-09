import { createApp } from './app.js';
import { storageLabel } from './store/index.js';

const { app, cfg, keys } = await createApp();

app.listen(cfg.port, () => {
  console.log(`CertVerify API listening on http://localhost:${cfg.port}`);
  const storage = storageLabel(cfg);
  console.log(`  Storage:           ${storage === 'local' ? `SQLite file in ${cfg.dataDir}` : storage}`);
  console.log(`  QR codes point to: ${cfg.publicUrl}/verify/<id>`);
  console.log(`  Institution key:   ${keys.keyId}`);
});
