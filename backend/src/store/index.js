// Picks the storage backend: Firebase Firestore, Turso, or a SQLite file.
import { FirestoreStore } from './firestore.js';
import { SqlStore } from './sql.js';

// FIREBASE_SERVICE_ACCOUNT holds the service-account key: the JSON itself, or base64 of it.
export function parseServiceAccount(value) {
  const text = value.trim().startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8');
  const sa = JSON.parse(text);
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT must be a service-account key JSON (project_id, client_email, private_key).');
  }
  return sa;
}

async function openFirebase(cfg) {
  const { cert, getApps, initializeApp } = await import('firebase-admin/app');
  const { FieldValue, getFirestore } = await import('firebase-admin/firestore');
  const sa = parseServiceAccount(cfg.firebaseServiceAccount);
  let app = getApps().find((a) => a.name === 'certverify');
  const fresh = !app;
  app ??= initializeApp({ credential: cert(sa), projectId: sa.project_id }, 'certverify');
  const db = getFirestore(app);
  // Optional fields (e.g. a verifier's email) may be undefined; Firestore rejects those unless told to skip them.
  if (fresh) db.settings({ ignoreUndefinedProperties: true });
  return new FirestoreStore(db, { increment: (n) => FieldValue.increment(n) });
}

export async function openStore(cfg) {
  if (cfg.firestore) return new FirestoreStore(cfg.firestore, { increment: cfg.firestoreIncrement }); // tests
  if (cfg.firebaseServiceAccount) return openFirebase(cfg);
  return SqlStore.open(cfg);
}

export const storageLabel = (cfg) =>
  cfg.firestore || cfg.firebaseServiceAccount ? 'firebase' : cfg.databaseUrl ? 'turso' : cfg.ephemeral ? 'temporary' : 'local';
