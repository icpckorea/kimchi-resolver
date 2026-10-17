/**
 * App smoke test (jsdom): boots the real singleton store through <App /> with
 * a stubbed global fetch serving the bundled sample data (public/), then
 * checks the two headline integrations:
 * - spectator mode renders all 84 sample teams once the queue is fed, and
 * - ?publish=true boots into the publish board with its input controls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import App from '../../src/App';
import { appStore } from '@store/appStore';
import { resetChromeUi } from '@ui/chrome';
import { APAC_STAR_TITLES } from '@ui/scoreboard/TeamRow';

// ---------------------------------------------------------------------------
// Fixtures: the actual sample data shipped in public/
// ---------------------------------------------------------------------------

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

function readJson(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(publicDir, rel), 'utf8'));
}

// autoPlay off: the smoke test drives the queue itself (feedAllQueued).
const baseConfig = {
  ...(readJson('config.json') as { publish: { regional: object } }),
  autoPlay: false,
};

const files: Record<string, unknown> = {
  'config.json': baseConfig,
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
  files['config.json'] = baseConfig;
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
// Publish (no site-score gate: publish-modes spec §7)
// ---------------------------------------------------------------------------

it('?publish=true boots straight into the final publish board', async () => {
  await bootApp('?publish=true');
  expect(appStore.getState().mode).toBe('publish');

  expect(screen.queryByText('site score를 입력하세요')).toBeNull();
  expect(document.getElementById('publish-site-score')).toBeNull();
  // Default mode is off: the board and the save button, no inputs.
  expect(document.getElementById('publish-invited-cutoff')).toBeNull();
  expect(screen.getByRole('button', { name: '확정 결과 저장' })).toBeTruthy();
  expect(document.querySelectorAll('.publish-board .team-row').length).toBe(84);
});

it('publish_mode=preliminary boots the preliminary inputs', async () => {
  await bootApp('?publish=true&publish_mode=preliminary');
  expect(document.getElementById('publish-prelim-total')).not.toBeNull();
  expect(document.getElementById('publish-invited-cutoff')).toBeNull();
});

it('publish_mode=regional boots the simulation panel and the board', async () => {
  await bootApp('?publish=true&publish_mode=regional');
  expect(document.getElementById('publish-invited-cutoff')).not.toBeNull();
  expect(document.querySelectorAll('.publish-board .team-row').length).toBe(84);
});

it('publish_mode=regional reads the stored inputs of this contest from localStorage', async () => {
  const key =
    'kimchi.publish:regional:./sample/:2025 ICPC Asia Seoul Regional Contest';
  const stored = { ...appStore.getState().regionalInputs, cutoff: 1.25 };
  localStorage.setItem(key, JSON.stringify(stored));
  await bootApp('?publish=true&publish_mode=regional');
  expect(appStore.getState().publishInputsFromStorage).toBe(true);
  expect((document.getElementById('publish-invited-cutoff') as HTMLInputElement).value).toBe(
    '1.25',
  );
});

// ---------------------------------------------------------------------------
// Award mode APAC stars (spec §13): the App wires config.publish into the
// star decision (quota base 2, WF-medal schools 3, already-invited schools out
// of the running and without a star).
// ---------------------------------------------------------------------------

/** Boots award mode over the sample, reveals everything, returns tier by team id. */
async function finishAwardAndReadTiers(publishPatch: object): Promise<(teamId: string) => string | null> {
  const publish = baseConfig.publish;
  files['config.json'] = { ...baseConfig, publish: { ...publish, ...publishPatch } };
  await bootApp('?award=true&r=1000');
  expect(appStore.getState().mode).toBe('award');

  act(() => {
    const store = appStore.getState();
    for (let i = 0; i < 5000 && !store.awardMachine!.finished; i++) store.awardAdvance();
    store.awardCommitSnapshot();
  });
  expect(appStore.getState().awardMachine!.finished).toBe(true);

  const titleToTier = new Map(
    Object.entries(APAC_STAR_TITLES).map(([tier, title]) => [title, tier]),
  );
  return (teamId) => {
    const title = document
      .querySelector(`[data-team-id="${teamId}"] .team-apac-star title`)
      ?.textContent;
    return title === undefined || title === null ? null : (titleToTier.get(title) ?? null);
  };
}

// Sample standings after the ceremony (champion: team 28, Seoul National Univ.):
// KAIST 39/14/46 (school ranks 1-3), Korea Univ. 29/18/26, Yonsei 9/30/74.
it('award mode: a WF-medal school keeps three silver slots, a normal school two', async () => {
  const tierOf = await finishAwardAndReadTiers({
    regional: {
      ...baseConfig.publish.regional,
      wfMedalGroups: ['KAIST'],
    },
  });
  // KAIST (WF medal): quota 3, so the 3rd team is still in the running.
  expect(tierOf('39')).toBe('silver');
  expect(tierOf('14')).toBe('silver');
  expect(tierOf('46')).toBe('silver');
  // Korea University (normal): quota 2, so the 3rd team has no star.
  expect(tierOf('29')).toBe('silver');
  expect(tierOf('18')).toBe('silver');
  expect(tierOf('26')).toBeNull();
  // The champion is gold.
  expect(tierOf('28')).toBe('gold');
});

it('award mode: schools of winnerGroups and invitedGroups have no stars', async () => {
  const tierOf = await finishAwardAndReadTiers({
    alreadyInvited: {
      teamIds: [],
      winnerGroups: ['Yonsei University'],
      invitedGroups: ['Korea University'],
    },
  });
  for (const id of ['9', '30', '74']) expect(tierOf(id), `Yonsei team ${id}`).toBeNull();
  for (const id of ['29', '18', '26']) expect(tierOf(id), `Korea Univ. team ${id}`).toBeNull();
  // KAIST has no invitation: its first two teams stay silver, the 3rd has no star.
  expect(tierOf('39')).toBe('silver');
  expect(tierOf('46')).toBeNull();
});
