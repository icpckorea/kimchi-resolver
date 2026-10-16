/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@store': fileURLToPath(new URL('./src/store', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environmentMatchGlobs: [['test/ui/**', 'jsdom']],
    // Node ≥ 25 ships a global localStorage that shadows jsdom's (and has no
    // clear() without --localstorage-file). Turn it off in the test workers.
    poolOptions: { forks: { execArgv: ['--no-experimental-webstorage'] } },
  },
});
