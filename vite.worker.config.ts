import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Background service worker as ONE self-contained ES module: MV3 service workers can't use
// dynamic import(), so every lazy chunk (e.g. SDK shims) must be inlined.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    lib: {
      entry: resolve(import.meta.dirname, 'src/background/index.ts'),
      formats: ['es'],
      fileName: () => 'background.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
