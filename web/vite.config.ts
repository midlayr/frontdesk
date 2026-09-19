import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app is static; every call goes to the Worker. In dev we proxy so the browser sees one
// origin — that keeps cookies, the ?org= dev fallback and WebSocket upgrades all working.
const WORKER = process.env.WORKER_ORIGIN ?? 'https://dumont-frontdesk.matt-dee.workers.dev';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: WORKER, changeOrigin: true, ws: true, secure: true },
      '/widget': { target: WORKER, changeOrigin: true, ws: true, secure: true },
    },
  },
});
