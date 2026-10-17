/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Dev server only: serve the git-ignored `config.local.json` at /config.json
 * when it exists, so a local judge connection never touches the tracked
 * public/config.json.
 */
function localConfig(): Plugin {
  const path = fileURLToPath(new URL('./config.local.json', import.meta.url));
  return {
    name: 'kimchi-local-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!existsSync(path) || req.url?.split('?')[0] !== '/config.json')
          return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(readFileSync(path));
      });
    },
  };
}

/**
 * Dev server only: `/judge-api` → KIMCHI_JUDGE_URL (the API root, with
 * /api/v4), with basic auth from KIMCHI_JUDGE_CRED ("user:password").
 * Both come from the git-ignored .env.local. The credential stays in this
 * Node process; the browser never sees it, and the proxy makes the API
 * same-origin (DOMjudge sends no CORS headers). Read-only: GET and HEAD.
 */
function judgeProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const target = env.KIMCHI_JUDGE_URL;
  if (!target) return {};
  const cred = env.KIMCHI_JUDGE_CRED;
  return {
    '/judge-api': {
      target,
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/judge-api/, ''),
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq, req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405;
            res.end();
            return;
          }
          if (cred)
            proxyReq.setHeader(
              'Authorization',
              `Basic ${Buffer.from(cred).toString('base64')}`,
            );
        });
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'KIMCHI_');
  return {
    plugins: [react(), localConfig()],
    server: { proxy: judgeProxy(env) },
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
  };
});
