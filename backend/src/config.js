import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.PORT || 4000),
  dataDir: process.env.DATA_DIR || path.join(backendRoot, 'data'),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  institutionName: process.env.INSTITUTION_NAME || 'Demo Institute of Technology',
  // Seed registrar account (first run only). See .env.example.
  adminEmail: (process.env.ADMIN_EMAIL || 'registrar@college.test').toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || 'ChangeMe!2026',
  sessionHours: 8,
};
