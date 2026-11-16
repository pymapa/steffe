import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.STEFFE_SERVER ?? 'http://localhost:4010';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // `npm run dev` picks a free port and sets STEFFE_WEB_PORT; run alone,
    // Vite starts at 3000 and moves up if that is taken.
    port: Number(process.env.STEFFE_WEB_PORT ?? 3000),
    strictPort: process.env.STEFFE_WEB_PORT != null,
    proxy: {
      '/api': SERVER,
      '/ws': { target: SERVER.replace('http', 'ws'), ws: true },
    },
  },
});
