/**
 * Timeline state in the app store: raw runs (incl. runs the feeder drops),
 * view/team seeding from the URL, selection slots and the 6-team cap.
 */
import { describe, expect, it } from 'vitest';

import { createAppStore, type AppStore, type Scheduler } from '@store/appStore';

const contest = {
  title: 'Timeline Store Contest',
  systemName: 'test',
  systemVersion: '1',
  problems: [{ id: 1, name: 'A', title: 'Alpha', color: 'red' }],
  teams: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `T${i + 1}`, group: `G${i + 1}` })),
};

const runs = {
  time: { contestTime: 18000, noMoreUpdate: true, timestamp: 0 },
  runs: [
    { id: 1, team: 1, problem: 1, result: 'Yes', submissionTime: 10 },
    // After team 1 solved A: the feeder drops it, the timeline keeps it.
    { id: 2, team: 1, problem: 1, result: 'No - Wrong Answer', submissionTime: 60 },
    { id: 3, team: 2, problem: 1, result: 'Yes', submissionTime: 20 },
  ],
};

function makeStore(config: unknown): AppStore {
  const files: Record<string, unknown> = {
    'config.json': config,
    'contest.json': contest,
    'runs.json': runs,
    'orgs/orgs.json': {},
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0];
    for (const [suffix, body] of Object.entries(files)) {
      if (path.endsWith(suffix)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const scheduler: Scheduler = { setInterval: () => 0, clearInterval: () => {} };
  return createAppStore({ fetchImpl, scheduler, storage: null, createWebSocket: () => ({ onmessage: null, onerror: null, onclose: null, close() {} }) });
}

const ENABLED = { source: { type: 'spotboard', apiBase: './' }, autoPlay: false, timeline: { enabled: true } };
const DISABLED = { source: { type: 'spotboard', apiBase: './' }, autoPlay: false };

describe('timeline store state', () => {
  it('seeds view and teams from the URL: unknown ids and duplicates dropped, no message', async () => {
    const store = makeStore(ENABLED);
    await store.getState().boot('?view=timeline&teams=2,99,2,1');
    const s = store.getState();
    expect(s.view).toBe('timeline');
    expect(s.timelineTeams).toEqual([
      { id: '2', slot: 0 },
      { id: '1', slot: 1 },
    ]);
    expect(s.systemMessages.map((m) => m.text).filter((t) => t.includes('teams'))).toEqual([]);
  });

  it('ignores view= and teams= when the timeline is disabled', async () => {
    const store = makeStore(DISABLED);
    await store.getState().boot('?view=timeline&teams=1,2');
    const s = store.getState();
    expect(s.view).toBe('board');
    expect(s.timelineTeams).toEqual([]);
    expect(s.timelineRuns).toEqual([]);
  });

  it('keeps every raw run, including the ones the feeder drops', async () => {
    const store = makeStore(ENABLED);
    await store.getState().boot('');
    const ids = store.getState().timelineRuns.map((r) => r.id).sort();
    expect(ids).toEqual(['1', '2', '3']);
    expect(store.getState().appliedRunCount).toBe(2);
  });

  it('caps at 6 teams and gives a new team the lowest free slot', async () => {
    const store = makeStore(ENABLED);
    await store.getState().boot('?teams=1,2,3,4,5,6,7');
    const st = () => store.getState();
    expect(st().timelineTeams.map((t) => t.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(st().toggleTimelineTeam('8')).toBe('full');
    expect(st().toggleTimelineTeam('1')).toBe('removed');
    expect(st().toggleTimelineTeam('8')).toBe('added');
    expect(st().timelineTeams.find((t) => t.id === '8')).toEqual({ id: '8', slot: 0 });
    expect(st().timelineTeams.find((t) => t.id === '2')).toEqual({ id: '2', slot: 1 });
    st().removeTimelineTeam('2');
    expect(st().timelineTeams.map((t) => t.id)).toEqual(['3', '4', '5', '6', '8']);
    st().setView('timeline');
    expect(st().view).toBe('timeline');
  });

  it('keeps colors across a reload: a slot that differs from the position travels in the URL', async () => {
    const { timelineHref } = await import('@ui/timeline/timelineUrl');
    const live = makeStore(ENABLED);
    await live.getState().boot('?teams=1,2,3');
    live.getState().removeTimelineTeam('2');
    const href = timelineHref('https://x.test/?time=5', 'board', live.getState().timelineTeams);
    expect(new URL(href).searchParams.get('teams')).toBe('1,3:2');
    const reloaded = makeStore(ENABLED);
    await reloaded.getState().boot(new URL(href).search);
    expect(reloaded.getState().timelineTeams).toEqual(live.getState().timelineTeams);
  });

  it('a bad or taken slot in the URL falls back to the lowest free slot', async () => {
    const store = makeStore(ENABLED);
    await store.getState().boot('?teams=1:2,2:2,3:9,1:4');
    expect(store.getState().timelineTeams).toEqual([
      { id: '1', slot: 2 },
      { id: '2', slot: 0 },
      { id: '3', slot: 1 },
    ]);
  });
});

