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

// Institution signing key (Ed25519). Generated once; the private key never leaves the server.
export function loadKeys(dataDir) {
  const dir = path.join(dataDir, 'keys');
  const privPath = path.join(dir, 'institution-private.pem');
  const pubPath = path.join(dir, 'institution-public.pem');
  if (!fs.existsSync(privPath)) {
    fs.mkdirSync(dir, { recursive: true });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
    console.log(`[keys] generated new institution key pair in ${dir}`);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath));
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
