import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const VENDOR_SERVER_PORT = Number(process.env['VENDOR_SERVER_PORT'] ?? 5174);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Permit non-localhost Host headers so the demo can be reached from
    // MCP browsers, Docker host bridges, or LAN devices during dev.
    cors: true,
    allowedHosts: true,
    proxy: {
      // Real-vendor proxy. The SPA POSTs /api/vendor/* and Vite forwards
      // to the standalone `vendor-server.ts` Node process (started via
      // `concurrently` from `pnpm dev`). Vendor sandbox credentials live
      // in the Node process's .env — never bundled into the browser.
      '/api/vendor': {
        target: `http://127.0.0.1:${VENDOR_SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
