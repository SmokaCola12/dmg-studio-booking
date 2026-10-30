import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.PORT || 4000;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on your LAN too, so you can open the dev site on your phone at http://<your-computer-ip>:5173
    host: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
});
