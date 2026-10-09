import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Deterministic JSON: keys sorted at every level, so the same record always
// produces the same bytes (and therefore the same hash and signature).
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const privateKeyPath = (dataDir) => path.join(dataDir, 'keys', 'institution-private.pem');

// Accepts the PEM itself (with real or \n-escaped newlines) or base64 of the PEM.
export function parsePrivateKey(value) {
  const pem = value.includes('BEGIN') ? value.replace(/\\n/g, '\n') : Buffer.from(value, 'base64').toString('utf8');
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('INSTITUTION_PRIVATE_KEY must be an Ed25519 private key.');
  return key;
}

// Local development: generate once into dataDir.
export function loadOrCreateKeyFile(dataDir) {
  const privPath = privateKeyPath(dataDir);
  if (!fs.existsSync(privPath)) {
    fs.mkdirSync(path.dirname(privPath), { recursive: true });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(path.join(path.dirname(privPath), 'institution-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    console.log(`[keys] generated new institution key pair in ${path.dirname(privPath)}`);
  }
  return crypto.createPrivateKey(fs.readFileSync(privPath));
}

// Institution signing key (Ed25519). The private key never leaves the server, and it must stay the same
// forever, or every earlier signature stops verifying. Sources, in order:
//   INSTITUTION_PRIVATE_KEY env var  >  key file in dataDir (local dev)  >  key generated once into the database (Vercel)
export function loadKeys(cfg) {
  let privateKey;
  if (cfg.privateKey) privateKey = parsePrivateKey(cfg.privateKey);
  else if (cfg.onVercel) throw new Error('INSTITUTION_PRIVATE_KEY is not set and no database key is available.');
  else privateKey = loadOrCreateKeyFile(cfg.dataDir);
  return keysFrom(privateKey);
}

export async function resolveKeys(cfg, store) {
  if (cfg.privateKey || !cfg.onVercel) return loadKeys(cfg);
  // Serverless has no disk: generate the key once and keep it in the database. The store only keeps
  // the first value written, so concurrent cold starts all end up with the same key.
  const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  return keysFrom(parsePrivateKey(await store.getOrInitSetting('institution_private_key', pem)));
}

function keysFrom(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const digest = sha256(publicKey.export({ type: 'spki', format: 'der' }));
  return {
    privateKey,
    publicKey,
    publicKeyPem,
    keyId: digest.slice(0, 16),
    fingerprint: digest.toUpperCase().match(/.{4}/g).join(' '),
  };
}

// base64url so the signature can sit in a QR-code URL without escaping.
export const signPayload = (privateKey, payload) =>
  crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');

export function verifySignature(publicKey, payload, signature) {
  try {
    return crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function checkPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
