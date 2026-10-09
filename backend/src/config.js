import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const onVercel = Boolean(process.env.VERCEL);
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;

export const config = {
  onVercel,
  port: Number(process.env.PORT || 4000),
  // Local development keeps the database and signing key here. Not used when the env vars below are set.
  dataDir: process.env.DATA_DIR || path.join(backendRoot, 'data'),
  // Turso / libSQL. Unset = local SQLite file in dataDir.
  databaseUrl: process.env.TURSO_DATABASE_URL || null,
  databaseAuthToken: process.env.TURSO_AUTH_TOKEN || null,
  // Ed25519 private key (PEM, or base64 of the PEM). Unset = key file in dataDir.
  privateKey: process.env.INSTITUTION_PRIVATE_KEY || null,
  publicUrl: (process.env.PUBLIC_URL || vercelUrl || 'http://localhost:5173').replace(/\/+$/, ''),
  institutionName: process.env.INSTITUTION_NAME || 'Demo Institute of Technology',
  // Vercel rejects request bodies over 4.5 MB.
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || (onVercel ? 4 : 15)),
  // Seed registrar account (first run only). See .env.example.
  adminEmail: (process.env.ADMIN_EMAIL || 'registrar@college.test').toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || 'ChangeMe!2026',
  sessionHours: 8,
};
