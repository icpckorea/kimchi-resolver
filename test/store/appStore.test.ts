/**
 * App store tests (node env, headless): boot pipeline, replay bounds,
 * spectator loop timers, poll dedup, publish mode, award machine split,
 * asset warnings, WebSocket doorbell.
 *
 * All effects are injected: fetch serves in-memory JSON fixtures (plus the
 * real 2025 sample data from public/ for the happy path), timers go through
 * a manual scheduler, and the WebSocket factory returns a stub.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createAppStore,
  type AppStore,
  type Scheduler,
  type StoreDeps,
  type WebSocketLike,
} from '@store/appStore';
import type { OrgsIndex } from '@core/types';

const ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Small synthetic spotboard contest: 2 problems, 3 teams, 3 groups. */
const smallContest = {
  title: 'Store Test Contest',
  systemName: 'test',
  systemVersion: '1',
  problems: [
    { id: 1, name: 'A', title: 'Alpha', color: 'red' },
    { id: 2, name: 'B', title: 'Beta', color: 'blue' },
  ],
  teams: [
    { id: 1, name: 'One', group: 'KAIST' },
    { id: 2, name: 'Two', group: 'SNU' },
    { id: 3, name: 'Three', group: 'Kyoto University' },
  ],
};

/** 6 runs, ids 1..6 ascending, minutes 5..50. */
function smallRuns(noMoreUpdate = false) {
  return {
    time: { contestTime: 18000, noMoreUpdate, timestamp: 0 },
    runs: [
      { id: 1, team: 1, problem: 1, result: 'No - Wrong Answer', submissionTime: 5 },
      { id: 2, team: 1, problem: 1, result: 'Yes', submissionTime: 10 },
      { id: 3, team: 2, problem: 1, result: 'Yes', submissionTime: 20 },
      { id: 4, team: 2, problem: 2, result: 'No - Wrong Answer', submissionTime: 30 },
      { id: 5, team: 3, problem: 2, result: 'Yes', submissionTime: 40 },
      { id: 6, team: 1, problem: 2, result: 'Yes', submissionTime: 50 },
    ],
  };
}

const smallOrgs: OrgsIndex = {
  KAIST: { country: 'KR', logo: 'kaist.png' },
  SNU: { country: 'KR' },
  // 'Kyoto University' intentionally absent.
};

// ---------------------------------------------------------------------------
// Injectable stubs
// ---------------------------------------------------------------------------

type StubValue = unknown | (() => unknown);

/** fetch stub: matches by path suffix (query string ignored), else 404. */
function makeFetch(files: Record<string, StubValue>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const path = url.split('?')[0];
    for (const [suffix, value] of Object.entries(files)) {
      if (path.endsWith(suffix)) {
        const body = typeof value === 'function' ? (value as () => unknown)() : value;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;
  return { impl, calls };
}

interface StubInterval {
  id: number;
  fn: () => void;
  ms: number;
}

/** Manual scheduler: intervals fire only via fire(ms). */
function makeScheduler() {
  let nextId = 1;
  const intervals = new Map<number, StubInterval>();
  const cleared: number[] = [];
  const scheduler: Scheduler = {
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { id, fn, ms });
      return id;
    },
    clearInterval: (handle) => {
      if (intervals.delete(handle as number)) cleared.push(handle as number);
    },
  };
  return {
    scheduler,
    cleared,
    active: (ms?: number) =>
      [...intervals.values()].filter((entry) => ms === undefined || entry.ms === ms),
    fire: (ms: number) => {
      for (const entry of [...intervals.values()]) {
        if (entry.ms === ms) entry.fn();
      }
    },
  };
}

function makeWsStub() {
  const sockets: WebSocketLike[] = [];
  const factory = (url: string): WebSocketLike => {
    void url;
    const socket: WebSocketLike = {
      onmessage: null,
      onerror: null,
      onclose: null,
      close: vi.fn(),
    };
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

interface Harness {
  store: AppStore;
  calls: string[];
  timers: ReturnType<typeof makeScheduler>;
  ws: ReturnType<typeof makeWsStub>;
}

function makeHarness(files: Record<string, StubValue>, deps: Partial<StoreDeps> = {}): Harness {
  const { impl, calls } = makeFetch(files);
  const timers = makeScheduler();
  const ws = makeWsStub();
  const store = createAppStore({
    fetchImpl: impl,
    scheduler: timers.scheduler,
    createWebSocket: ws.factory,
    rng: () => 0.99, // gacha "No" roll never fires unless overridden
    ...deps,
  });
  return { store, calls, timers, ws };
}

const smallFiles = (): Record<string, StubValue> => ({
  'contest.json': smallContest,
  'runs.json': smallRuns(),
  'orgs/orgs.json': smallOrgs,
});

function messages(store: AppStore): string[] {
  return store.getState().systemMessages.map((message) => message.text);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

describe('boot', () => {
  it('missing config.json and orgs.json fall back to defaults with system messages', async () => {
    const { store } = makeHarness({
      'contest.json': smallContest,
      'runs.json': smallRuns(),
      // no config.json, no orgs.json
    });
    await store.getState().boot('');
    const state = store.getState();

    expect(state.status).toBe('ready');
    expect(state.mode).toBe('spectator');
    expect(messages(store).some((text) => text.includes('config.json'))).toBe(true);
    expect(messages(store).some((text) => text.includes('orgs/orgs.json'))).toBe(true);
    // Spectator without a replay bound: everything applied at boot.
    expect(state.appliedRunCount).toBe(6);
    expect(state.pendingCount).toBe(0);
    expect(state.contestTimeSec).toBe(18000);
    expect(state.noMoreUpdate).toBe(false);
    expect(state.playing).toBe(true); // default autoPlay
    expect(state.snapshot?.standings).toHaveLength(3);
    // Team 1 solved both problems → rank 1.
    expect(state.snapshot?.byTeam.get('1')?.solved).toBe(2);
    expect(state.snapshot?.byTeam.get('1')?.icpcRank).toBe(1);
  });

  it('boots against the real 2025 sample feed', async () => {
    const contestJson = JSON.parse(readFileSync(resolve(ROOT, 'public/sample/contest.json'), 'utf8'));
    const runsJson = JSON.parse(readFileSync(resolve(ROOT, 'public/sample/runs.json'), 'utf8'));
    const orgsJson = JSON.parse(readFileSync(resolve(ROOT, 'public/orgs/orgs.json'), 'utf8'));
    const { store } = makeHarness({
      'contest.json': contestJson,
      'runs.json': runsJson,
      'orgs/orgs.json': orgsJson,
    });
    await store.getState().boot('');
    const state = store.getState();

    expect(state.status).toBe('ready');
    expect(state.contest?.teams.size).toBe(84);
    expect(state.snapshot?.standings).toHaveLength(84);
    expect(state.pendingCount).toBe(0);
    expect(state.contestTimeSec).toBe(18000);
  });

  it('applies config.json values and reports invalid keys as warnings', async () => {
    const { store } = makeHarness({
      ...smallFiles(),
      'config.json': { autoPlay: false, maxNotifications: 'lots' },
    });
    await store.getState().boot('');
    const state = store.getState();

    expect(state.status).toBe('ready');
    expect(state.playing).toBe(false); // autoPlay: false honored
    expect(state.config.maxNotifications).toBe(100); // invalid → default
    expect(messages(store).some((text) => text.includes('maxNotifications'))).toBe(true);
  });

  it('contest load failure is fatal (status error + message)', async () => {
    const { store } = makeHarness({ 'runs.json': smallRuns() }); // no contest.json
    await store.getState().boot('');
    expect(store.getState().status).toBe('error');
    expect(messages(store).some((text) => text.includes('contest'))).toBe(true);
  });

  it('initial run fetch failure is non-fatal', async () => {
    const { store } = makeHarness({
      'contest.json': smallContest,
      'orgs/orgs.json': smallOrgs,
    }); // no runs.json
    await store.getState().boot('');
    const state = store.getState();
    expect(state.status).toBe('ready');
    expect(state.appliedRunCount).toBe(0);
    expect(state.snapshot?.standings).toHaveLength(3);
    expect(messages(store).some((text) => text.includes('Initial run fetch failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Asset warnings (spec §8)
// ---------------------------------------------------------------------------

describe('asset warnings', () => {
  it('warns about groups missing from orgs.json and missing logos', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = makeHarness({
      ...smallFiles(),
      'config.json': { showSchoolLogos: true },
    });
    await store.getState().boot('');

    const texts = messages(store);
    expect(texts.some((text) => text.includes('no entry') && text.includes('Kyoto University'))).toBe(
      true,
    );
    expect(texts.some((text) => text.includes('logo') && text.includes('SNU'))).toBe(true);
    // KAIST has country + logo → never mentioned.
    expect(texts.some((text) => text.includes('KAIST'))).toBe(false);
    warnSpy.mockRestore();
  });

  it('does not warn about logos when showSchoolLogos is off', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store } = makeHarness(smallFiles());
    await store.getState().boot('');
    expect(messages(store).some((text) => text.includes('logo'))).toBe(false);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Replay bounds (r= / time=)
// ---------------------------------------------------------------------------

describe('replay', () => {
  it('r= applies only runs with seq <= cutoff, rest stays queued', async () => {
    const { store } = makeHarness(smallFiles());
    await store.getState().boot('?r=3');
    const state = store.getState();

    expect(state.appliedRunCount).toBe(3);
    expect(state.pendingCount).toBe(3);
    expect(state.snapshot?.byTeam.get('1')?.solved).toBe(1);
    expect(state.snapshot?.byTeam.get('3')?.solved).toBe(0);
    expect(state.playing).toBe(true); // r= does not touch autoPlay
  });

  it('time= applies only runs with minute <= cutoff and forces autoplay off', async () => {
    const { store } = makeHarness(smallFiles());
    await store.getState().boot('?time=30');
    const state = store.getState();

    expect(state.appliedRunCount).toBe(4); // minutes 5, 10, 20, 30
    expect(state.pendingCount).toBe(2);
    expect(state.playing).toBe(false); // forced off (spec §5)
  });
});

// ---------------------------------------------------------------------------
// Spectator loop
// ---------------------------------------------------------------------------

describe('spectator loop', () => {
  it('autoplay tick applies exactly one queued run', async () => {
    const { store, timers } = makeHarness(smallFiles());
    await store.getState().boot('?r=3');

    timers.fire(100); // autoPlayDelay default
    let state = store.getState();
    expect(state.appliedRunCount).toBe(4);
    expect(state.pendingCount).toBe(2);
    expect(state.recentEvents[0]?.run.id).toBe('4'); // newest first

    // Paused → tick is a no-op.
    store.getState().setPlaying(false);
    timers.fire(100);
    state = store.getState();
    expect(state.appliedRunCount).toBe(4);

    // Resume → one more.
    store.getState().togglePlaying();
    timers.fire(100);
    expect(store.getState().appliedRunCount).toBe(5);
  });

  it('live application publishes a flip batch; the boot replay does not', async () => {
    const { store, timers } = makeHarness(smallFiles());
    await store.getState().boot('?r=3');

    // Replay of runs 1..3 at boot applied without animation → no batch.
    expect(store.getState().lastAppliedFlips).toBeNull();

    // Autoplay tick applies run 4 live → its cell flips.
    timers.fire(100);
    const first = store.getState().lastAppliedFlips;
    expect(first).not.toBeNull();
    expect(first!.cells).toEqual([{ teamId: '2', problemId: '2' }]);

    // feed-one applies run 5 → a NEW batch (flipId is monotonic).
    store.getState().feedOne();
    const second = store.getState().lastAppliedFlips;
    expect(second!.cells).toEqual([{ teamId: '3', problemId: '2' }]);
    expect(second!.flipId).toBeGreaterThan(first!.flipId);

    // feed-all batches the rest into one update.
    store.getState().feedAllQueued();
    const third = store.getState().lastAppliedFlips;
    expect(third!.cells).toEqual([{ teamId: '1', problemId: '2' }]);
    expect(third!.flipId).toBeGreaterThan(second!.flipId);
  });

  it('poll dedups already-known runs via the feeder', async () => {
    let served: unknown = smallRuns();
    const { store, timers } = makeHarness({
      'contest.json': smallContest,
      'orgs/orgs.json': smallOrgs,
      'runs.json': () => served,
    });
    await store.getState().boot('');
    expect(store.getState().appliedRunCount).toBe(6);

    // Poll timer refetches the same feed → nothing new. pollNow() joins the
    // in-flight timer poll, so awaiting it is deterministic.
    timers.fire(10000); // autoRefreshInterval default
    await store.getState().pollNow();
    expect(store.getState().pendingCount).toBe(0);

    // A new run + a verdict change on a non-accepted applied run both queue.
    const next = smallRuns();
    next.runs[3] = { ...next.runs[3], result: 'Yes' }; // run 4: No → Yes
    next.runs.push({ id: 7, team: 3, problem: 1, result: 'Yes', submissionTime: 55 });
    served = next;
    await store.getState().pollNow();
    expect(store.getState().pendingCount).toBe(2);

    // Same feed again → still 2 (queued versions dedup too).
    await store.getState().pollNow();
    expect(store.getState().pendingCount).toBe(2);

    store.getState().feedAllQueued();
    const state = store.getState();
    expect(state.pendingCount).toBe(0);
    expect(state.snapshot?.byTeam.get('2')?.solved).toBe(2); // run 4 now accepted
    expect(state.snapshot?.byTeam.get('3')?.solved).toBe(2); // run 7 applied
  });

  it('manual pollNow resets the poll timer', async () => {
    const { store, timers } = makeHarness(smallFiles());
    await store.getState().boot('');

    const before = timers.active(10000);
    expect(before).toHaveLength(1);
    await store.getState().pollNow();
    const after = timers.active(10000);
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(before[0].id); // re-armed
    expect(timers.cleared).toContain(before[0].id);
  });

  it('noMoreUpdate at boot suppresses the poll timer', async () => {
    const { store, timers } = makeHarness({
      ...smallFiles(),
      'runs.json': smallRuns(true),
    });
    await store.getState().boot('');
    expect(store.getState().noMoreUpdate).toBe(true);
    expect(timers.active(10000)).toHaveLength(0); // no polling
    expect(timers.active(100)).toHaveLength(1); // autoplay still ticks the queue
  });

  it('recentEvents is capped at maxNotifications, newest first', async () => {
    const { store } = makeHarness({
      ...smallFiles(),
      'config.json': { maxNotifications: 3 },
    });
    await store.getState().boot('?r=0'); // nothing applied at boot
    expect(store.getState().pendingCount).toBe(6);

    store.getState().feedAllQueued();
    const events = store.getState().recentEvents;
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.run.id)).toEqual(['6', '5', '4']);
  });

  it('emits teamUpdated events for applied runs', async () => {
    const { store, timers } = makeHarness(smallFiles());
    await store.getState().boot('?r=3');

    const seen: string[] = [];
    const unsubscribe = store.getState().subscribeTeamUpdated((event) => {
      seen.push(event.run.id);
    });
    timers.fire(100);
    store.getState().feedOne();
    expect(seen).toEqual(['4', '5']);

    unsubscribe();
    timers.fire(100);
    expect(seen).toEqual(['4', '5']); // no longer notified
  });

  it('dispose stops the timers', async () => {
    const { store, timers } = makeHarness(smallFiles());
    await store.getState().boot('?r=3');
    expect(timers.active()).toHaveLength(2);
    store.getState().dispose();
    expect(timers.active()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Publish mode (spec §13)
// ---------------------------------------------------------------------------

describe('publish mode', () => {
  it('feeds everything at boot, starts no timers, tracks site score state', async () => {
    const { store, timers, ws } = makeHarness(smallFiles());
    await store.getState().boot('?publish=true&site_score=3&invited_cutoff=1.5');
    const state = store.getState();

    expect(state.mode).toBe('publish');
    expect(state.appliedRunCount).toBe(6);
    expect(state.pendingCount).toBe(0);
    expect(timers.active()).toHaveLength(0);
    expect(ws.sockets).toHaveLength(0);
    expect(state.playing).toBe(false);
    expect(state.siteScore).toBe(3);
    expect(state.invitedCutoff).toBe(1.5);

    store.getState().setSiteScore(5);
    store.getState().setInvitedCutoff(2);
    expect(store.getState().siteScore).toBe(5);
    expect(store.getState().invitedCutoff).toBe(2);
  });

  it('publish wins over award when both are requested', async () => {
    const { store } = makeHarness(smallFiles());
    await store.getState().boot('?publish=true&award=true');
    expect(store.getState().mode).toBe('publish');
    expect(store.getState().awardMachine).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Award mode (spec §6)
// ---------------------------------------------------------------------------

describe('award mode', () => {
  it('splits revealed (seq <= r) from hidden runs and masks hidden verdicts', async () => {
    const { store, timers, ws } = makeHarness(smallFiles());
    await store.getState().boot('?award=true&r=3');
    const state = store.getState();

    expect(state.mode).toBe('award');
    expect(timers.active()).toHaveLength(0); // no polling/autoplay
    expect(ws.sockets).toHaveLength(0);

    const machine = state.awardMachine;
    expect(machine).not.toBeNull();
    // Hidden runs 4, 5, 6 hit three distinct cells → 3 reveals.
    expect(machine!.remainingReveals).toBe(3);

    // Frozen projection: pre-cutoff verdicts visible, post-cutoff masked.
    const snapshot = state.snapshot!;
    expect(snapshot.byTeam.get('1')?.cells.get('1')?.verdict).toBe('accepted'); // run 2
    expect(snapshot.byTeam.get('1')?.cells.get('2')?.verdict).toBe('pending'); // run 6 masked
    expect(snapshot.byTeam.get('3')?.cells.get('2')?.verdict).toBe('pending'); // run 5 masked
    expect(snapshot.byTeam.get('3')?.solved).toBe(0);
  });

  it('reveal steps defer the snapshot commit until awardCommitSnapshot (spoiler prevention)', async () => {
    const { store } = makeHarness(smallFiles());
    await store.getState().boot('?award=true&r=3');
    expect(store.getState().awardTick).toBe(0);

    const focus = store.getState().awardAdvance();
    expect(focus?.type).toBe('focus'); // team 3 (bottom)
    expect(store.getState().awardTick).toBe(1);

    const blink = store.getState().awardAdvance();
    expect(blink?.type).toBe('blink'); // default focusBlinking: rank 3 ≤ 10

    const reveal = store.getState().awardAdvance();
    expect(reveal?.type).toBe('reveal');
    expect(store.getState().awardTick).toBe(3);
    // The machine applied the hidden Yes, but the STORE snapshot must stay
    // pre-reveal so the UI cannot spoil the flip.
    expect(store.getState().awardMachine?.snapshot.byTeam.get('3')?.solved).toBe(1);
    expect(store.getState().snapshot?.byTeam.get('3')?.solved).toBe(0);

    // The reveal animation finished → the award UI commits.
    store.getState().awardCommitSnapshot();
    expect(store.getState().awardTick).toBe(4);
    expect(store.getState().snapshot?.byTeam.get('3')?.solved).toBe(1);
  });

  it('non-reveal steps commit immediately; dismiss only bumps the tick', async () => {
    const { store } = makeHarness(smallFiles());
    await store.getState().boot('?award=true&r=3');

    store.getState().awardAdvance(); // focus team 3
    store.getState().awardAdvance(); // blink team 3 B (default focusBlinking)
    store.getState().awardAdvance(); // reveal team 3 B (deferred)
    const finalize = store.getState().awardAdvance(); // finalize → commits (backstop)
    expect(finalize?.type).toBe('finalize');
    expect(store.getState().snapshot?.byTeam.get('3')?.solved).toBe(1);

    const tickBefore = store.getState().awardTick;
    store.getState().awardDismiss();
    expect(store.getState().awardTick).toBe(tickBefore + 1);
  });

  it('without a replay bound everything is revealed (no hidden runs)', async () => {
    const { store } = makeHarness(smallFiles());
    await store.getState().boot('?award=true');
    const machine = store.getState().awardMachine;
    expect(machine).not.toBeNull();
    expect(machine!.remainingReveals).toBe(0);
    expect(store.getState().snapshot?.byTeam.get('1')?.solved).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// WebSocket doorbell
// ---------------------------------------------------------------------------

describe('websocket doorbell', () => {
  it('onmessage triggers an immediate poll', async () => {
    const { store, calls, ws } = makeHarness({
      ...smallFiles(),
      'config.json': { source: { eventsWs: 'ws://doorbell' } },
    });
    await store.getState().boot('');
    expect(ws.sockets).toHaveLength(1);

    const runsCallsBefore = calls.filter((url) => url.includes('runs.json')).length;
    ws.sockets[0].onmessage?.({});
    await vi.waitFor(() => {
      const runsCalls = calls.filter((url) => url.includes('runs.json')).length;
      expect(runsCalls).toBe(runsCallsBefore + 1);
    });
  });

  it('failures produce exactly one system message and no reconnect', async () => {
    const { store, ws } = makeHarness({
      ...smallFiles(),
      'config.json': { source: { eventsWs: 'ws://doorbell' } },
    });
    await store.getState().boot('');

    ws.sockets[0].onerror?.({});
    ws.sockets[0].onerror?.({});
    const wsMessages = messages(store).filter((text) => text.includes('WebSocket'));
    expect(wsMessages).toHaveLength(1);
    expect(ws.sockets).toHaveLength(1); // no reconnect attempts
  });

  it('a throwing WebSocket factory degrades to polling with one message', async () => {
    const { impl } = makeFetch({
      ...smallFiles(),
      'config.json': { source: { eventsWs: 'ws://doorbell' } },
    });
    const timers = makeScheduler();
    const store = createAppStore({
      fetchImpl: impl,
      scheduler: timers.scheduler,
      createWebSocket: () => {
        throw new Error('no ws in this environment');
      },
    });
    await store.getState().boot('');
    expect(store.getState().status).toBe('ready');
    expect(messages(store).filter((text) => text.includes('WebSocket'))).toHaveLength(1);
    expect(timers.active(10000)).toHaveLength(1); // polling still on
  });
});
