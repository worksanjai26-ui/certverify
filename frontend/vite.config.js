import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // reachable from a phone on the same network for QR scanning
    proxy: { '/api': 'http://localhost:4000' },
  },
});
