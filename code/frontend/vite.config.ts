import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Where the dev server forwards /api calls. Outside Docker the backend is on
// localhost:4000 (the PORT in backend/.env.example). docker-compose.yml sets
// VITE_PROXY_TARGET=http://backend:4000, because inside the frontend
// container "localhost" is the container itself, not the backend.
const apiTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Listen on all interfaces so the browser can reach it through Docker's port mapping.
    host: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
})
