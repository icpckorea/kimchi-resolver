/**
 * Build config of the static public page (`npm run publish`).
 *
 * The entry is publish.html -> src/published/main.tsx, which never imports the
 * app store or the ingest code, so the bundle holds no feed or judge code.
 * `publicDir` is off: nothing from public/ (config.json, sample/, awards.json)
 * is copied. scripts/publish.ts passes `build.outDir` and adds the data.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // Relative URLs: the folder works under any S3 prefix.
  base: './',
  publicDir: false,
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@store': fileURLToPath(new URL('./src/store', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
    },
  },
  build: {
    outDir: 'publish-dist',
    emptyOutDir: true,
    // framer-motion and zod put the single chunk over the 500 kB default; it is one page.
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: 'publish.html' },
  },
});
