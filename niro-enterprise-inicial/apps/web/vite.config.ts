import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // Native fs.watch crashes intermittently in this environment (Windows + a network-mapped
      // drive) under heavy concurrent file writes. Polling is slower but doesn't hit that bug.
      usePolling: true,
      interval: 300
    },
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:4000',
        changeOrigin: true
      },
      '/socket.io': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:4000',
        changeOrigin: true,
        ws: true
      }
    }
  }
});
