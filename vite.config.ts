import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Build 1/3: side-panel dashboard (React). The service worker (vite.worker.config.ts) and the
// content script (vite.content.config.ts) are built separately as single self-contained files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'sidepanel.html'),
      },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as never);
