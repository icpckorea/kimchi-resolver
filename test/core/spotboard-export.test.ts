import { describe, expect, it } from 'vitest';
import { createSpotboardSource } from '@core/ingest/spotboard';
import { toSpotboardContest, toSpotboardRuns } from '@core/ingest/spotboard-export';
import { computeStandings } from '@core/standings';
import type { Contest, Run, Team, Verdict } from '@core/types';
import { SPOTBOARD_NO_PENALTY_RESULT, normalizeSpotboardResult, toSpotboardResult } from '@core/verdict';

// --- Fixtures ---------------------------------------------------------------

function team(id: string, name: string, group: string): Team {
  return { id, name, group, foreign: false };
}

const contest: Contest = {
  title: '2026 Test Regional',
  systemName: 'Contest API',
  systemVersion: '',
  problems: [
    { id: 'p-a', label: 'A', title: 'Adventurer', color: '#ADD8E6', order: 0 },
    { id: 'p-b', label: 'B', title: 'Badge Relay', color: '#000000', order: 1 },
    { id: 'p-c', label: 'C', title: 'Cake', color: '', order: 2 },
  ],
  teams: new Map([
    ['t1', team('t1', 'Preforce', 'KAIST')],
    ['t2', team('t2', 'Sushi (Masters)', 'KAIST')],
    ['t3', team('t3', 'Bubble Tea', 'NCCU')],
    ['t4', team('t4', 'Orphans', '')],
  ]),
};

function run(seq: number, teamId: string, problemId: string, minute: number, kind: 'AC' | 'WA' | 'CE' | 'PD'): Run {
  const verdict: Verdict = kind === 'AC' ? 'accepted' : kind === 'PD' ? 'pending' : 'failed';
  return {
    id: `s${seq}`,
    teamId,
    problemId,
    minute,
    verdict,
    penaltyCounts: kind === 'WA',
    seq,
  };
}

// Deliberately out of seq order. Seq starts at 7 and has gaps.
const runs: Run[] = [
  run(12, 't2', 'p-a', 31, 'AC'),
  run(7, 't1', 'p-a', 5, 'WA'),
  run(8, 't1', 'p-a', 10, 'AC'),
  run(9, 't1', 'p-b', 12, 'CE'), // no penalty
  run(10, 't1', 'p-b', 20, 'AC'),
  run(11, 't2', 'p-c', 25, 'CE'),
  run(13, 't2', 'p-c', 40, 'WA'),
  run(15, 't2', 'p-c', 41, 'PD'),
  run(14, 't3', 'p-a', 60, 'AC'),
  run(16, 't3', 'p-b', 70, 'WA'),
  run(17, 't4', 'p-c', 80, 'CE'), // only a no-penalty attempt
];

// --- Round trip through the real spotboard source ---------------------------

const BASE = 'http://feed.test/';

async function readBack(contestJson: unknown, runsJson: unknown) {
  const files: Record<string, unknown> = {
    [`${BASE}contest.json`]: contestJson,
    [`${BASE}runs.json?from=0`]: runsJson,
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const body = files[String(input)];
    if (body === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
    // The files go through real JSON text, as they would from disk.
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const source = createSpotboardSource({
    apiBase: BASE,
    fetchTimeout: 5000,
    excludeTeamIds: [],
    foreign: { ids: [], groups: [] },
    orgs: {},
    fetchImpl,
  });
  return { contest: await source.loadContest(), fetched: await source.fetchRuns(undefined) };
}

describe('toSpotboardContest / toSpotboardRuns', () => {
  it('writes the spotboard shapes', () => {
    expect(toSpotboardContest(contest)).toEqual({
      title: '2026 Test Regional',
      systemName: 'Contest API',
      systemVersion: '',
      problems: [
        { id: 'p-a', name: 'A', title: 'Adventurer', color: '#ADD8E6' },
        { id: 'p-b', name: 'B', title: 'Badge Relay', color: '#000000' },
        { id: 'p-c', name: 'C', title: 'Cake', color: '' },
      ],
      teams: [
        { id: 't1', name: 'Preforce', group: 'KAIST' },
        { id: 't2', name: 'Sushi (Masters)', group: 'KAIST' },
        { id: 't3', name: 'Bubble Tea', group: 'NCCU' },
        { id: 't4', name: 'Orphans', group: '' },
      ],
    });

    const file = toSpotboardRuns([runs[1], runs[2]], {
      contestTimeSeconds: 3725,
      noMoreUpdate: false,
      unfreeze: false,
      timestamp: 1000,
    });
    expect(file).toEqual({
      time: { contestTime: 3725, noMoreUpdate: false, timestamp: 1000 },
      runs: [
        { id: 7, team: 't1', problem: 'p-a', result: 'No', submissionTime: 5 },
        { id: 8, team: 't1', problem: 'p-a', result: 'Yes', submissionTime: 10 },
      ],
    });
  });

  it('sorts runs by seq and keeps a null contest time', () => {
    const file = toSpotboardRuns(runs, { contestTimeSeconds: null, noMoreUpdate: true, unfreeze: false });
    expect(file.runs.map((r) => r.id)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(file.time.contestTime).toBeNull();
    expect(file.time.noMoreUpdate).toBe(true);
    expect(Number.isInteger(file.time.timestamp)).toBe(true);
  });
});

describe('round trip through the spotboard source', () => {
  it('gives the same contest and the same standings', async () => {
    const contestFile = toSpotboardContest(contest);
    const runsFile = toSpotboardRuns(runs, { contestTimeSeconds: 600, noMoreUpdate: false, unfreeze: false });
    const back = await readBack(contestFile, runsFile);

    expect(back.contest).toEqual(contest);
    expect(back.fetched.contestTimeSec).toBe(600);
    expect(back.fetched.runs).toHaveLength(runs.length);

    const before = computeStandings(contest, runs);
    const after = computeStandings(back.contest, back.fetched.runs);
    expect(after).toEqual(before);

    // Spell out what the full comparison covers.
    for (const row of before.standings) {
      const other = after.byTeam.get(row.team.id)!;
      expect(other.solved).toBe(row.solved);
      expect(other.penalty).toBe(row.penalty);
      expect(other.icpcRank).toBe(row.icpcRank);
      for (const [problemId, cell] of row.cells) {
        const otherCell = other.cells.get(problemId)!;
        expect(otherCell.verdict).toBe(cell.verdict);
        expect(otherCell.failedAttempts).toBe(cell.failedAttempts);
        expect(otherCell.attempts).toBe(cell.attempts);
      }
    }
    // t1: A solved at 10 after one WA (+20), B solved at 20 after a free CE.
    const t1 = after.byTeam.get('t1')!;
    expect(t1.solved).toBe(2);
    expect(t1.penalty).toBe(10 + 20 + 20);
  });

  it('keeps a compile error free of penalty', async () => {
    const only: Run[] = [run(1, 't4', 'p-c', 80, 'CE'), run(2, 't4', 'p-c', 90, 'AC')];
    const runsFile = toSpotboardRuns(only, { contestTimeSeconds: 0, noMoreUpdate: false, unfreeze: false });
    expect(runsFile.runs[0].result).toBe(SPOTBOARD_NO_PENALTY_RESULT);
    const back = await readBack(toSpotboardContest(contest), runsFile);
    expect(back.fetched.runs[0]).toMatchObject({ verdict: 'failed', penaltyCounts: false });
    const cell = computeStandings(back.contest, back.fetched.runs).byTeam.get('t4')!.cells.get('p-c')!;
    expect(cell.failedAttempts).toBe(0);
    expect(cell.verdict).toBe('accepted');
  });

  it('survives the freeze marker (the adapter ignores unknown keys)', async () => {
    const runsFile = toSpotboardRuns(runs, { contestTimeSeconds: 0, noMoreUpdate: false, unfreeze: true });
    expect(runsFile.kimchiUnfrozen).toBe(true);
    const back = await readBack(toSpotboardContest(contest), runsFile);
    expect(computeStandings(back.contest, back.fetched.runs)).toEqual(computeStandings(contest, runs));
  });

  it('maps every verdict back exactly', () => {
    for (const [verdict, penaltyCounts] of [
      ['accepted', false],
      ['pending', false],
      ['failed', true],
      ['failed', false],
    ] as const) {
      expect(normalizeSpotboardResult(toSpotboardResult(verdict, penaltyCounts))).toEqual({ verdict, penaltyCounts });
    }
  });
});

describe('freeze masking', () => {
  const opts = { contestTimeSeconds: 0, noMoreUpdate: false };

  it('writes a run at or after the freeze minute as pending, and leaves earlier ones', () => {
    const file = toSpotboardRuns(runs, { ...opts, freezeMinute: 31, unfreeze: false });
    const byId = new Map(file.runs.map((r) => [r.id, r]));
    // minute 25 (seq 11) is before 31; minute 31 (seq 12) is the first frozen minute.
    expect(byId.get(11)!.result).toBe(SPOTBOARD_NO_PENALTY_RESULT);
    expect(byId.get(12)!.result).toBe('');
    expect(byId.get(13)!.result).toBe('');
    expect(byId.get(14)!.result).toBe('');
    expect(byId.get(8)!.result).toBe('Yes');
    // Minutes are kept: only the result is hidden.
    expect(byId.get(12)!.submissionTime).toBe(31);
    expect(file.kimchiUnfrozen).toBeUndefined();
  });

  it('turns the frozen cells pending in the standings', async () => {
    const file = toSpotboardRuns(runs, { ...opts, freezeMinute: 31, unfreeze: false });
    const back = await readBack(toSpotboardContest(contest), file);
    const t3 = computeStandings(back.contest, back.fetched.runs).byTeam.get('t3')!;
    expect(t3.solved).toBe(0);
    expect(t3.cells.get('p-a')!.verdict).toBe('pending');
  });

  it('keeps the real results with unfreeze, and marks the file', () => {
    const open = toSpotboardRuns(runs, { ...opts, freezeMinute: 31, unfreeze: true });
    const plain = toSpotboardRuns(runs, { ...opts, unfreeze: true });
    expect(open.runs).toEqual(plain.runs);
    expect(open.runs.find((r) => r.id === 12)!.result).toBe('Yes');
    expect(open.kimchiUnfrozen).toBe(true);
  });

  it('masks nothing when the contest has no freeze', () => {
    for (const freezeMinute of [null, undefined]) {
      const file = toSpotboardRuns(runs, { ...opts, freezeMinute, unfreeze: false });
      expect(file.runs.find((r) => r.id === 14)!.result).toBe('Yes');
    }
  });
});
