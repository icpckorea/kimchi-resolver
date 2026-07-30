/**
 * App smoke test (jsdom): boots the real singleton store through <App /> with
 * a stubbed global fetch serving the bundled sample data (public/), then
 * checks the two headline integrations:
 * - spectator mode renders all 84 sample teams once the queue is fed, and
 * - ?publish=true boots into the publish gate with its input controls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import App from '../../src/App';
import { appStore } from '@store/appStore';
import { resetChromeUi } from '@ui/chrome';

// ---------------------------------------------------------------------------
// Fixtures: the actual sample data shipped in public/
// ---------------------------------------------------------------------------

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

function readJson(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(publicDir, rel), 'utf8'));
}

const files: Record<string, unknown> = {
  // autoPlay off: the smoke test drives the queue itself (feedAllQueued).
  'config.json': { ...(readJson('config.json') as object), autoPlay: false },
  'orgs/orgs.json': readJson('orgs/orgs.json'),
  'contest.json': readJson('sample/contest.json'),
  'runs.json': readJson('sample/runs.json'),
  'awards.json': readJson('sample/awards.sample.json'),
};

function stubFetch(): void {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const pathname = String(input).split('?')[0];
    for (const [suffix, body] of Object.entries(files)) {
      if (pathname.endsWith(suffix)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch);
}

const initialState = appStore.getState();

beforeEach(() => {
  localStorage.clear();
  resetChromeUi();
  stubFetch();
});

afterEach(() => {
  cleanup(); // unmount first so App's dispose() effect runs
  appStore.getState().dispose();
  appStore.setState(initialState, false);
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

async function bootApp(search: string): Promise<void> {
  window.history.replaceState({}, '', `/${search}`);
  render(<App />);
  await waitFor(() => expect(appStore.getState().status).toBe('ready'));
}

// ---------------------------------------------------------------------------
// Spectator
// ---------------------------------------------------------------------------

it('boots spectator mode and renders all 84 sample teams after feeding the queue', async () => {
  await bootApp('');
  expect(appStore.getState().mode).toBe('spectator');
  expect(screen.getByText('2025 ICPC Asia Seoul Regional Contest')).toBeTruthy();

  // All 1,227 sample runs are queued at boot; apply them all at once.
  act(() => {
    appStore.getState().feedAllQueued();
  });
  expect(appStore.getState().pendingCount).toBe(0);

  const rows = document.querySelectorAll('.board-wrap .team-row');
  expect(rows.length).toBe(84);
});

// ---------------------------------------------------------------------------
// Publish gate
// ---------------------------------------------------------------------------

it('?publish=true boots the publish gate with the site-score controls', async () => {
  await bootApp('?publish=true');
  expect(appStore.getState().mode).toBe('publish');

  // Gate: no site score yet → instruction panel + inputs, no board.
  expect(screen.getByText('site score를 입력하세요')).toBeTruthy();
  expect(document.getElementById('publish-site-score')).not.toBeNull();
  expect(document.getElementById('publish-invited-cutoff')).not.toBeNull();
  expect(document.querySelector('.publish-board')).toBeNull();
});
