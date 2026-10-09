// Prints the institution's private signing key as one base64 line, ready to paste into Vercel as
// INSTITUTION_PRIVATE_KEY. Uses the local key in backend/data/keys (creating one if there is none).
//
//   npm run key:export
//
// Treat the output like a password: anyone holding it can sign certificates as the institution.
// Keep a safe copy; if it is ever lost or changed, every certificate signed with it stops verifying.
import fs from 'node:fs';
import { config } from '../src/config.js';
import { loadOrCreateKeyFile, privateKeyPath } from '../src/crypto.js';

loadOrCreateKeyFile(config.dataDir);
const pem = fs.readFileSync(privateKeyPath(config.dataDir), 'utf8');
process.stderr.write('\nINSTITUTION_PRIVATE_KEY (copy the single line below into Vercel > Settings > Environment Variables):\n\n');
process.stdout.write(`${Buffer.from(pem).toString('base64')}\n`);
process.stderr.write('\nKeep this secret. Never commit it or share it in chat.\n\n');
