import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': process.env.VITE_API_PROXY ?? 'http://localhost:4000' } },
});
