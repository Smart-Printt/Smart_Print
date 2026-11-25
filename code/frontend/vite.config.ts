import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Where the dev server forwards /api calls. Outside Docker the backend is on
// localhost:4321 (the PORT default in backend/src/config/env.ts and
// backend/.env.example). docker-compose.yml sets
// VITE_PROXY_TARGET=http://backend:4000, because inside the frontend
// container "localhost" is the container itself, and the backend container
// listens on 4000 (the host's 4321 is mapped to it).
const apiTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:4321'

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
