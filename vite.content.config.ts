import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Build 3/3: LinkedIn content script as a self-contained IIFE.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      name: 'SyncUpContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
