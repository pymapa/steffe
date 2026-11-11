import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.STEFFE_SERVER ?? 'http://localhost:4010';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/ws': { target: SERVER.replace('http', 'ws'), ws: true },
    },
  },
});
