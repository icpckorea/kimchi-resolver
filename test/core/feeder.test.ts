import { describe, expect, it } from 'vitest';
// JSON imports (resolveJsonModule) keep this test free of Node builtins,
// since tsconfig `types` does not include @types/node.
import rawContestJson from '../../public/sample/contest.json';
import rawRunsJson from '../../public/sample/runs.json';
import { createRunFeeder, QueuedRunFeeder } from '@core/feeder';
import { normalizeSpotboardResult } from '@core/verdict';
import type { Contest, FetchRunsResult, Run, Team, Verdict } from '@core/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContest(teamIds: string[] = ['1', '2', '3']): Contest {
  const teams = new Map<string, Team>();
  for (const id of teamIds) {
    teams.set(id, { id, name: `Team ${id}`, group: `School ${id}`, foreign: false });
  }
  return {
    title: 'Test Contest',
    systemName: 'test',
    systemVersion: '0',
    problems: [
      { id: 'p1', label: 'A', title: 'Alpha', color: 'red', order: 0 },
      { id: 'p2', label: 'B', title: 'Bravo', color: 'blue', order: 1 },
    ],
    teams,
  };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    teamId: '1',
    problemId: 'p1',
    minute: 10,
    verdict: 'pending' as Verdict,
    penaltyCounts: false,
    seq: Number(id),
    ...overrides,
  };
}

function result(runs: Run[], overrides: Partial<FetchRunsResult> = {}): FetchRunsResult {
  return { runs, contestTimeSec: 600, noMoreUpdate: false, cursor: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// Pinned original test cases (test/runfeeder.coffee lineage)
// ---------------------------------------------------------------------------

describe('RunFeeder: pinned original behaviors', () => {
  it('initial feed: all runs of an initial fetch are queued and applied in order', () => {
    const feeder = createRunFeeder(makeContest());
    const runs = [
      run('1', { verdict: 'failed', penaltyCounts: true }),
      run('2', { teamId: '2', verdict: 'accepted', minute: 20 }),
      run('3', { teamId: '3', problemId: 'p2', minute: 30 }),
    ];
    const queued = feeder.ingest(result(runs));

    expect(queued).toBe(3);
    expect(feeder.queueLength).toBe(3);
    expect(feeder.appliedRuns).toEqual([]);

    const applied = feeder.feedAll();
    expect(applied.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(feeder.queueLength).toBe(0);
    expect(feeder.appliedRuns.map((r) => r.id)).toEqual(['1', '2', '3']);
  });

  it('pending -> Yes replaces the queued run in place and yields exactly 1 change', () => {
    const feeder = createRunFeeder(makeContest());
    const pendingRun = run('7', { verdict: 'pending' });
    feeder.ingest(result([pendingRun]));
    expect(feeder.queueLength).toBe(1);

    // Same full runs list again, with run 7 now judged Yes (client-side diff).
    const acceptedRun = run('7', { verdict: 'accepted' });
    const changes = feeder.ingest(result([acceptedRun]));

    expect(changes).toBe(1);
    expect(feeder.queueLength).toBe(1); // replaced, not appended

    const applied = feeder.feedAll();
    expect(applied).toHaveLength(1);
    expect(applied[0].verdict).toBe('accepted');
  });

  it('an already-accepted run is never re-fed, whatever the incoming version says', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([run('5', { verdict: 'accepted', minute: 12 })]));
    feeder.feedAll();
    expect(feeder.appliedRuns).toHaveLength(1);

    // Changed minute, changed verdict — still rejected.
    expect(feeder.ingest(result([run('5', { verdict: 'accepted', minute: 99 })]))).toBe(0);
    expect(feeder.ingest(result([run('5', { verdict: 'failed', penaltyCounts: true })]))).toBe(0);
    expect(feeder.ingest(result([run('5', { verdict: 'pending', minute: 1 })]))).toBe(0);
    expect(feeder.queueLength).toBe(0);
    expect(feeder.appliedRuns).toHaveLength(1);
    expect(feeder.appliedRuns[0].minute).toBe(12);
  });

  it('a queued accepted run also rejects any update (queue is checked before applied)', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([run('5', { verdict: 'accepted' })]));
    expect(feeder.ingest(result([run('5', { verdict: 'failed', minute: 99, penaltyCounts: true })]))).toBe(0);
    expect(feeder.queueLength).toBe(1);
    expect(feeder.feedAll()[0].verdict).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// Diff rules
// ---------------------------------------------------------------------------

describe('RunFeeder diff rules', () => {
  it('accepts unknown run ids', () => {
    const feeder = createRunFeeder(makeContest());
    expect(feeder.ingest(result([run('1'), run('2', { teamId: '2' })]))).toBe(2);
  });

  it('rejects an identical known run (same minute and verdict)', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([run('1', { minute: 10, verdict: 'pending' })]));
    // Still queued:
    expect(feeder.ingest(result([run('1', { minute: 10, verdict: 'pending' })]))).toBe(0);
    feeder.feedAll();
    // Now applied:
    expect(feeder.ingest(result([run('1', { minute: 10, verdict: 'pending' })]))).toBe(0);
    expect(feeder.queueLength).toBe(0);
  });

  it('accepts a known run when only the minute changed', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([run('1', { minute: 10, verdict: 'failed', penaltyCounts: true })]));
    feeder.feedAll();

    const changes = feeder.ingest(
      result([run('1', { minute: 11, verdict: 'failed', penaltyCounts: true })]),
    );
    expect(changes).toBe(1);
    const applied = feeder.feedAll();
    expect(applied).toHaveLength(1);
    expect(applied[0].minute).toBe(11);
  });

  it('accepts a known run when only the verdict changed (applied pending -> failed)', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([run('1', { verdict: 'pending' })]));
    feeder.feedAll();
    expect(feeder.ingest(result([run('1', { verdict: 'failed', penaltyCounts: true })]))).toBe(1);
  });

  it('accepts a rejudgement that changes only penaltyCounts (CE -> WA, same minute/verdict)', () => {
    const feeder = createRunFeeder(makeContest());
    // First judged Compile Error: failed, no penalty.
    feeder.ingest(result([run('1', { verdict: 'failed', penaltyCounts: false })]));
    feeder.feedAll();
    expect(feeder.appliedRuns[0].penaltyCounts).toBe(false);

    // Rejudged Wrong Answer: same minute + verdict, but the failure now
    // counts toward the 20-minute penalty — it must be re-queued.
    expect(feeder.ingest(result([run('1', { verdict: 'failed', penaltyCounts: true })]))).toBe(1);
    const refed = feeder.feedAll();
    expect(refed).toHaveLength(1);
    expect(feeder.appliedRuns).toHaveLength(1); // replaced in place, not duplicated
    expect(feeder.appliedRuns[0].penaltyCounts).toBe(true);
  });

  it('penaltyCounts-only change is also detected while the run is still queued', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([run('1', { verdict: 'failed', penaltyCounts: false })]));
    expect(feeder.ingest(result([run('1', { verdict: 'failed', penaltyCounts: true })]))).toBe(1);
    expect(feeder.queueLength).toBe(1); // replaced in place
    expect(feeder.feedAll()[0].penaltyCounts).toBe(true);
  });

  it('in-place replacement keeps the queue position', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(
      result([
        run('1', { teamId: '1' }),
        run('2', { teamId: '2' }),
        run('3', { teamId: '3' }),
      ]),
    );
    feeder.ingest(result([run('2', { teamId: '2', verdict: 'accepted' })]));

    const applied = feeder.feedAll();
    expect(applied.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(applied[1].verdict).toBe('accepted');
  });

  it('rejects a NEW run id targeting a cell already accepted in the applied set', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([run('1', { verdict: 'accepted' })]));
    feeder.feedAll();

    // Different run id, same (team, problem) cell.
    expect(feeder.ingest(result([run('2', { verdict: 'failed', penaltyCounts: true })]))).toBe(0);
    // Same team, other problem is fine.
    expect(feeder.ingest(result([run('3', { problemId: 'p2' })]))).toBe(1);
    // Other team, same problem is fine.
    expect(feeder.ingest(result([run('4', { teamId: '2' })]))).toBe(1);
  });

  it('does NOT reject for a cell whose accepted run is only queued (applied set decides)', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([run('1', { verdict: 'accepted' })]));
    // Cell not accepted in APPLIED yet — a second run for the cell may enter the queue.
    expect(feeder.ingest(result([run('2', { verdict: 'failed', penaltyCounts: true })]))).toBe(1);
    expect(feeder.queueLength).toBe(2);

    // At feed time the late run is dropped by the manager-side cell skip.
    const applied = feeder.feedAll();
    expect(applied.map((r) => r.id)).toEqual(['1']);
    expect(feeder.appliedRuns.map((r) => r.id)).toEqual(['1']);
    expect(feeder.queueLength).toBe(0);
  });

  it('drops runs from teams not present in contest.teams (excluded teams)', () => {
    const feeder = createRunFeeder(makeContest(['1', '2']));
    const changes = feeder.ingest(
      result([
        run('1', { teamId: '99' }), // excluded
        run('2', { teamId: '2' }),
      ]),
    );
    expect(changes).toBe(1);
    expect(feeder.feedAll().map((r) => r.teamId)).toEqual(['2']);
  });

  it('re-feeding the same id keeps a single canonical copy in appliedRuns', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([run('1', { verdict: 'pending' }), run('2', { teamId: '2' })]));
    feeder.feedAll();
    feeder.ingest(result([run('1', { verdict: 'accepted' })]));
    feeder.feedAll();

    expect(feeder.appliedRuns).toHaveLength(2);
    expect(feeder.appliedRuns[0].id).toBe('1');
    expect(feeder.appliedRuns[0].verdict).toBe('accepted');
    expect(feeder.appliedRuns[1].id).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// ingest metadata (clock / noMoreUpdate / cursor)
// ---------------------------------------------------------------------------

describe('RunFeeder ingest metadata', () => {
  it('updates contestTimeSec, noMoreUpdate and cursor from the fetch result', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([], { contestTimeSec: 1234, noMoreUpdate: true, cursor: 'ts-9' }));
    expect(feeder.contestTimeSec).toBe(1234);
    expect(feeder.noMoreUpdate).toBe(true);
    expect(feeder.cursor).toBe('ts-9');
  });

  it('starts with null clock, false noMoreUpdate, empty applied set', () => {
    const feeder = createRunFeeder(makeContest());
    expect(feeder.contestTimeSec).toBeNull();
    expect(feeder.noMoreUpdate).toBe(false);
    expect(feeder.queueLength).toBe(0);
    expect(feeder.appliedRuns).toEqual([]);
  });

  it('null contestTimeSec keeps the previous clock value', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([], { contestTimeSec: 300 }));
    feeder.ingest(result([], { contestTimeSec: null }));
    expect(feeder.contestTimeSec).toBe(300);
  });

  it('a partial/corrupt time object (undefined or NaN seconds) does not corrupt the clock', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([], { contestTimeSec: 300 }));

    feeder.ingest(result([], { contestTimeSec: Number.NaN }));
    expect(feeder.contestTimeSec).toBe(300);

    // Simulates an adapter passing a partial time object at runtime.
    feeder.ingest(result([], { contestTimeSec: undefined as unknown as number }));
    expect(feeder.contestTimeSec).toBe(300);

    feeder.ingest(result([], { contestTimeSec: '600' as unknown as number }));
    expect(feeder.contestTimeSec).toBe(300);

    feeder.ingest(result([], { contestTimeSec: 601 }));
    expect(feeder.contestTimeSec).toBe(601);
  });

  it('noMoreUpdate absent at runtime -> false (original parsing bug fixed)', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(result([], { noMoreUpdate: undefined as unknown as boolean }));
    expect(feeder.noMoreUpdate).toBe(false);
  });

  it('noMoreUpdate is strictly boolean: truthy junk does not end the contest', () => {
    const feeder = createRunFeeder(makeContest());
    // The original CoffeeScript bug turned an absent field into a truthy object.
    feeder.ingest(result([], { noMoreUpdate: { true: false } as unknown as boolean }));
    expect(feeder.noMoreUpdate).toBe(false);
    feeder.ingest(result([], { noMoreUpdate: true }));
    expect(feeder.noMoreUpdate).toBe(true);
    // A later poll without the field flips it back to false.
    feeder.ingest(result([], { noMoreUpdate: undefined as unknown as boolean }));
    expect(feeder.noMoreUpdate).toBe(false);
  });

  it('cursor updates on every result that carries one, and survives an omitted cursor', () => {
    const feeder = createRunFeeder(makeContest());
    expect(feeder.cursor).toBeNull();
    feeder.ingest(result([], { cursor: 100 }));
    expect(feeder.cursor).toBe(100);
    feeder.ingest(result([], { cursor: 200 }));
    expect(feeder.cursor).toBe(200);
    feeder.ingest(result([], { cursor: undefined }));
    expect(feeder.cursor).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Queue consumption: feed / feedWhile / feedAll
// ---------------------------------------------------------------------------

describe('RunFeeder queue consumption', () => {
  function seeded(): ReturnType<typeof createRunFeeder> {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(
      result([
        run('1', { teamId: '1', minute: 5 }),
        run('2', { teamId: '2', minute: 10 }),
        run('3', { teamId: '3', minute: 15 }),
        run('4', { teamId: '1', problemId: 'p2', minute: 20 }),
      ]),
    );
    return feeder;
  }

  it('feed(n) applies up to n runs in queue order', () => {
    const feeder = seeded();
    const first = feeder.feed(2);
    expect(first.map((r) => r.id)).toEqual(['1', '2']);
    expect(feeder.queueLength).toBe(2);
    expect(feeder.appliedRuns.map((r) => r.id)).toEqual(['1', '2']);

    const rest = feeder.feed(10);
    expect(rest.map((r) => r.id)).toEqual(['3', '4']);
    expect(feeder.queueLength).toBe(0);
  });

  it('feed(0) and feed on an empty queue return []', () => {
    const feeder = seeded();
    expect(feeder.feed(0)).toEqual([]);
    feeder.feedAll();
    expect(feeder.feed(5)).toEqual([]);
  });

  it('feedWhile stops at the first run failing the predicate (peek, no consume)', () => {
    const feeder = seeded();
    const fed = feeder.feedWhile((r) => r.minute <= 10);
    expect(fed.map((r) => r.id)).toEqual(['1', '2']);
    // Run 3 failed the predicate and must still be at the head of the queue.
    expect(feeder.queueLength).toBe(2);
    expect(feeder.feed(1).map((r) => r.id)).toEqual(['3']);
  });

  it('feedWhile with an always-false predicate applies nothing', () => {
    const feeder = seeded();
    expect(feeder.feedWhile(() => false)).toEqual([]);
    expect(feeder.queueLength).toBe(4);
  });

  it('feedAll drains the queue and appliedRuns preserves application order', () => {
    const feeder = seeded();
    feeder.feed(1);
    feeder.ingest(result([run('5', { teamId: '2', problemId: 'p2', minute: 25 })]));
    feeder.feedAll();
    expect(feeder.queueLength).toBe(0);
    expect(feeder.appliedRuns.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('runs skipped at feed time (cell accepted while queued) do not count toward feed(n)', () => {
    const feeder = createRunFeeder(makeContest());
    feeder.ingest(
      result([
        run('1', { verdict: 'accepted' }),
        run('2', { verdict: 'failed', penaltyCounts: true }), // same cell, dropped at feed time
        run('3', { teamId: '2' }),
      ]),
    );
    const fed = feeder.feed(2);
    expect(fed.map((r) => r.id)).toEqual(['1', '3']);
    expect(feeder.queueLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Realistic fixture: 2025 ICPC Seoul sample (84 teams / 13 problems / 1227 runs)
// ---------------------------------------------------------------------------

describe('RunFeeder against the 2025 Seoul sample data', () => {
  interface SampleContest {
    title: string;
    systemName: string;
    systemVersion: string;
    problems: { id: number; name: string; title: string; color: string }[];
    teams: { id: number; name: string; group?: string }[];
  }
  interface SampleRuns {
    time: { contestTime: number; noMoreUpdate: boolean; timestamp: number };
    runs: { id: number; team: number; problem: number; result: string; submissionTime: number }[];
  }

  const rawContest = rawContestJson as unknown as SampleContest;
  const rawRuns = rawRunsJson as unknown as SampleRuns;

  function sampleContest(): Contest {
    const teams = new Map<string, Team>();
    for (const t of rawContest.teams) {
      teams.set(String(t.id), {
        id: String(t.id),
        name: t.name,
        group: t.group ?? '',
        foreign: false,
      });
    }
    return {
      title: rawContest.title,
      systemName: rawContest.systemName,
      systemVersion: rawContest.systemVersion,
      problems: rawContest.problems.map((p, order) => ({
        id: String(p.id),
        label: p.name,
        title: p.title,
        color: p.color,
        order,
      })),
      teams,
    };
  }

  function sampleRun(raw: SampleRuns['runs'][number]): Run {
    const { verdict, penaltyCounts } = normalizeSpotboardResult(raw.result);
    return {
      id: String(raw.id),
      teamId: String(raw.team),
      problemId: String(raw.problem),
      minute: Number(raw.submissionTime),
      verdict,
      penaltyCounts,
      seq: raw.id,
    };
  }

  it('ingests all 1227 runs, applies 1223 (4 target already-accepted cells), second poll is a no-op', () => {
    const feeder = createRunFeeder(sampleContest());
    const runs = rawRuns.runs.map(sampleRun);
    const first = feeder.ingest({
      runs,
      contestTimeSec: rawRuns.time.contestTime,
      noMoreUpdate: rawRuns.time.noMoreUpdate,
      cursor: rawRuns.time.timestamp,
    });

    expect(first).toBe(1227);
    expect(feeder.contestTimeSec).toBe(18000);
    expect(feeder.noMoreUpdate).toBe(false);

    const applied = feeder.feedAll();
    // 4 runs (ids 107, 746, 1213, 1253) were submitted after their cell was
    // already accepted — the manager-side cell skip drops them at feed time.
    expect(applied).toHaveLength(1223);
    expect(feeder.appliedRuns).toHaveLength(1223);
    const appliedIds = new Set(applied.map((r) => r.id));
    for (const skippedId of ['107', '746', '1213', '1253']) {
      expect(appliedIds.has(skippedId)).toBe(false);
    }

    // Client-side diff: the same full runs.json again yields zero changes.
    const second = feeder.ingest({
      runs: rawRuns.runs.map(sampleRun),
      contestTimeSec: rawRuns.time.contestTime,
      noMoreUpdate: rawRuns.time.noMoreUpdate,
      cursor: rawRuns.time.timestamp,
    });
    expect(second).toBe(0);
    expect(feeder.queueLength).toBe(0);
  });

  it('never applies more than one accepted run per cell', () => {
    const feeder = createRunFeeder(sampleContest());
    feeder.ingest({
      runs: rawRuns.runs.map(sampleRun),
      contestTimeSec: rawRuns.time.contestTime,
      noMoreUpdate: rawRuns.time.noMoreUpdate,
      cursor: rawRuns.time.timestamp,
    });
    feeder.feedAll();

    const acceptedPerCell = new Map<string, number>();
    for (const r of feeder.appliedRuns) {
      if (r.verdict !== 'accepted') continue;
      const key = `${r.teamId}/${r.problemId}`;
      acceptedPerCell.set(key, (acceptedPerCell.get(key) ?? 0) + 1);
    }
    for (const count of acceptedPerCell.values()) {
      expect(count).toBe(1);
    }
    expect(acceptedPerCell.size).toBeGreaterThan(0);
  });

  it('incremental polling in 5 chunks applies the same run set as one shot', () => {
    const oneShot = createRunFeeder(sampleContest());
    const allRuns = rawRuns.runs.map(sampleRun);
    oneShot.ingest({ runs: allRuns, contestTimeSec: 18000, noMoreUpdate: false, cursor: 0 });
    oneShot.feedAll();

    const chunked = createRunFeeder(sampleContest());
    const chunkSize = Math.ceil(allRuns.length / 5);
    for (let i = 0; i < allRuns.length; i += chunkSize) {
      // Cumulative prefix: mimics polling the full runs.json repeatedly mid-contest.
      const prefix = rawRuns.runs.slice(0, i + chunkSize).map(sampleRun);
      chunked.ingest({ runs: prefix, contestTimeSec: null, noMoreUpdate: false, cursor: i });
      chunked.feedAll();
    }

    expect(chunked.appliedRuns.map((r) => r.id)).toEqual(oneShot.appliedRuns.map((r) => r.id));
    expect(chunked.appliedRuns.map((r) => r.verdict)).toEqual(
      oneShot.appliedRuns.map((r) => r.verdict),
    );
  });

  it('QueuedRunFeeder class is directly constructible too', () => {
    const feeder = new QueuedRunFeeder(sampleContest());
    feeder.ingest({ runs: [], contestTimeSec: 1, noMoreUpdate: false, cursor: null });
    expect(feeder.queueLength).toBe(0);
  });
});
