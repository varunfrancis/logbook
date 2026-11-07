import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const daemon = `http://127.0.0.1:${process.env.LOGBOOK_PORT || 7777}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: { port: 5177, proxy: { '/api': daemon, '/hook': daemon } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
