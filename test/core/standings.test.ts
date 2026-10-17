import { describe, expect, it } from 'vitest';
import sampleContestJson from '../../public/sample/contest.json';
import sampleRunsJson from '../../public/sample/runs.json';
import type { AutoLabel, Contest, Problem, Run, Team, Verdict } from '@core/types';
import { computeStandings, compareTeamIds, PENALTY_PER_FAILURE } from '@core/standings';
import { normalizeSpotboardResult } from '@core/verdict';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function makeProblems(count: number): Problem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`,
    label: LABELS[i],
    title: `Problem ${LABELS[i]}`,
    color: 'red',
    order: i,
  }));
}

interface TeamSpec {
  id: string;
  name?: string;
  group?: string;
  foreign?: boolean;
}

function makeContest(teamSpecs: TeamSpec[], problemCount = 3): Contest {
  const teams = new Map<string, Team>();
  for (const spec of teamSpecs) {
    teams.set(spec.id, {
      id: spec.id,
      name: spec.name ?? `Team ${spec.id}`,
      group: spec.group ?? `Group ${spec.id}`,
      foreign: spec.foreign ?? false,
    });
  }
  return {
    title: 'Fixture Contest',
    systemName: 'fixture',
    systemVersion: '0',
    problems: makeProblems(problemCount),
    teams,
  };
}

let runSeq = 0;

function run(
  teamId: string,
  problemId: string,
  minute: number,
  verdict: Verdict,
  opts: { seq?: number; penaltyCounts?: boolean } = {},
): Run {
  const seq = opts.seq ?? ++runSeq;
  return {
    id: String(seq),
    teamId,
    problemId,
    minute,
    verdict,
    penaltyCounts: opts.penaltyCounts ?? (verdict === 'failed'),
    seq,
  };
}

function labelKinds(labels: AutoLabel[]): string[] {
  return labels.map((l) => l.kind);
}

// ---------------------------------------------------------------------------
// Penalty formula and net-run truncation
// ---------------------------------------------------------------------------

describe('penalty formula', () => {
  it('charges 20 * failedAttempts + solvedMinute per solved problem', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 10, 'failed'),
      run('1', 'p1', 25, 'failed'),
      run('1', 'p1', 30, 'accepted'),
      run('1', 'p2', 50, 'accepted'),
    ]);
    const s = snap.byTeam.get('1')!;
    expect(s.solved).toBe(2);
    expect(s.penalty).toBe(2 * PENALTY_PER_FAILURE + 30 + 50); // 120
    expect(s.lastSolvedMinute).toBe(50);
  });

  it('unsolved problems contribute zero penalty even with many failures', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 10, 'failed'),
      run('1', 'p1', 20, 'failed'),
      run('1', 'p1', 30, 'failed'),
    ]);
    const s = snap.byTeam.get('1')!;
    expect(s.solved).toBe(0);
    expect(s.penalty).toBe(0);
    expect(s.lastSolvedMinute).toBe(0);
    const cell = s.cells.get('p1')!;
    expect(cell.verdict).toBe('failed');
    expect(cell.failedAttempts).toBe(3);
  });

  it('pending runs contribute zero to solved, penalty, and failedAttempts', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 5, 'pending'),
      run('1', 'p2', 8, 'pending'),
    ]);
    const s = snap.byTeam.get('1')!;
    expect(s.solved).toBe(0);
    expect(s.penalty).toBe(0);
    const cell = s.cells.get('p1')!;
    expect(cell.verdict).toBe('pending');
    expect(cell.attempts).toBe(1);
    expect(cell.failedAttempts).toBe(0);
    // fully tied with the no-submission team → shared rank
    expect(s.icpcRank).toBe(1);
    expect(snap.byTeam.get('2')!.icpcRank).toBe(1);
  });

  it('a failed run before a pending run still counts toward failedAttempts once solved', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 5, 'failed'),
      run('1', 'p1', 9, 'pending'),
    ]);
    const cell = snap.byTeam.get('1')!.cells.get('p1')!;
    expect(cell.verdict).toBe('pending'); // last net run
    expect(cell.failedAttempts).toBe(1);
    expect(snap.byTeam.get('1')!.penalty).toBe(0); // not solved → no charge yet
  });

  it('"" and "Pending - Judging" produce the SAME penalty when later solved (bug not ported)', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }]);
    const emptyPending = normalizeSpotboardResult('');
    const judgingPending = normalizeSpotboardResult('Pending - Judging');
    const runs: Run[] = [
      { id: '1', teamId: '1', problemId: 'p1', minute: 5, seq: 1, ...emptyPending },
      { id: '2', teamId: '2', problemId: 'p1', minute: 5, seq: 2, ...judgingPending },
      run('1', 'p1', 10, 'accepted', { seq: 3 }),
      run('2', 'p1', 10, 'accepted', { seq: 4 }),
    ];
    const snap = computeStandings(contest, runs);
    expect(snap.byTeam.get('1')!.penalty).toBe(10);
    expect(snap.byTeam.get('2')!.penalty).toBe(10);
    expect(snap.byTeam.get('1')!.icpcRank).toBe(snap.byTeam.get('2')!.icpcRank);
  });

  it('excludes no-penalty failed runs (penaltyCounts=false, e.g. compile error) from failedAttempts', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 5, 'failed', { penaltyCounts: false }), // CE
      run('1', 'p1', 12, 'failed', { penaltyCounts: true }), // WA
      run('1', 'p1', 30, 'accepted'),
    ]);
    const s = snap.byTeam.get('1')!;
    const cell = s.cells.get('p1')!;
    expect(cell.attempts).toBe(3); // CE still counts as an attempt
    expect(cell.failedAttempts).toBe(1); // but not toward penalty
    expect(s.penalty).toBe(PENALTY_PER_FAILURE + 30); // 50, not 70
  });
});

describe('net-run truncation', () => {
  it('ignores every run after the first accepted, ordered by seq (not array order)', () => {
    const contest = makeContest([{ id: '1' }]);
    // Shuffled array; seq defines the true order: fail(1), accept(2), fail(3), accept(4)
    const runs = [
      run('1', 'p1', 90, 'accepted', { seq: 4 }),
      run('1', 'p1', 10, 'failed', { seq: 1 }),
      run('1', 'p1', 80, 'failed', { seq: 3 }),
      run('1', 'p1', 40, 'accepted', { seq: 2 }),
    ];
    const snap = computeStandings(contest, runs);
    const s = snap.byTeam.get('1')!;
    const cell = s.cells.get('p1')!;
    expect(cell.verdict).toBe('accepted');
    expect(cell.attempts).toBe(2); // truncated at first accepted (seq 2)
    expect(cell.failedAttempts).toBe(1);
    expect(cell.solvedMinute).toBe(40);
    expect(s.penalty).toBe(PENALTY_PER_FAILURE + 40);
    expect(s.lastSolvedMinute).toBe(40);
  });

  it('pending runs after an accepted run are also truncated', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 40, 'accepted', { seq: 1 }),
      run('1', 'p1', 50, 'pending', { seq: 2 }),
    ]);
    const cell = snap.byTeam.get('1')!.cells.get('p1')!;
    expect(cell.verdict).toBe('accepted');
    expect(cell.attempts).toBe(1);
  });

  it('never-attempted cells exist with null verdict', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, []);
    const s = snap.byTeam.get('1')!;
    expect(s.cells.size).toBe(3); // every contest problem has an entry
    for (const cell of s.cells.values()) {
      expect(cell.verdict).toBeNull();
      expect(cell.attempts).toBe(0);
      expect(cell.solvedMinute).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Comparator and ranking
// ---------------------------------------------------------------------------

describe('ranking comparator', () => {
  it('orders by solved desc, then penalty asc, then lastSolvedMinute asc, then team id asc', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }], 4);
    const snap = computeStandings(contest, [
      // team 4: 2 solved
      run('4', 'p1', 10, 'accepted'),
      run('4', 'p2', 20, 'accepted'),
      // team 3: 1 solved, penalty 30
      run('3', 'p1', 30, 'accepted'),
      // team 2: 1 solved, penalty 40 = 30 total? no: minute 40 → penalty 40
      run('2', 'p1', 40, 'accepted'),
      // team 1: 1 solved, penalty 40 but via 20+20: fail then accept at 20
      run('1', 'p1', 15, 'failed'),
      run('1', 'p1', 20, 'accepted'),
    ]);
    const order = snap.standings.map((s) => s.team.id);
    // team1 and team2 both have penalty 40, but team1 lastSolved=20 < team2's 40
    expect(order).toEqual(['4', '3', '1', '2']);
    expect(snap.standings.map((s) => s.icpcRank)).toEqual([1, 2, 3, 4]);
  });

  it('breaks equal (solved, penalty) by lastSolvedMinute ascending', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }], 2);
    const snap = computeStandings(contest, [
      // Both: 2 solved, penalty 100. team1 last solve at 60, team2 at 55.
      run('1', 'p1', 40, 'accepted'),
      run('1', 'p2', 60, 'accepted'),
      run('2', 'p1', 45, 'accepted'),
      run('2', 'p2', 55, 'accepted'),
    ]);
    expect(snap.standings.map((s) => s.team.id)).toEqual(['2', '1']);
    // Not a full tie → distinct ranks
    expect(snap.standings.map((s) => s.icpcRank)).toEqual([1, 2]);
  });

  it('uses numeric-aware team id ascending as the final tie-break', () => {
    const contest = makeContest([{ id: '10' }, { id: '9' }, { id: '100' }]);
    const runs = ['9', '10', '100'].flatMap((t) => [run(t, 'p1', 30, 'accepted')]);
    const snap = computeStandings(contest, runs);
    expect(snap.standings.map((s) => s.team.id)).toEqual(['9', '10', '100']);
    // fully tied → all share rank 1
    expect(snap.standings.map((s) => s.icpcRank)).toEqual([1, 1, 1]);
  });

  it('applies competition ranking with gaps: 1,2,2,2,5', () => {
    const contest = makeContest(
      [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }],
      2,
    );
    const snap = computeStandings(contest, [
      run('1', 'p1', 10, 'accepted'),
      run('1', 'p2', 20, 'accepted'),
      // teams 2,3,4 fully tied: 1 solved at minute 30
      run('2', 'p1', 30, 'accepted'),
      run('3', 'p1', 30, 'accepted'),
      run('4', 'p1', 30, 'accepted'),
      // team 5: no solve
    ]);
    expect(snap.standings.map((s) => s.icpcRank)).toEqual([1, 2, 2, 2, 5]);
    expect(snap.standings.map((s) => s.team.id)).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('compareTeamIds', () => {
  it('compares pure-numeric ids numerically', () => {
    expect(compareTeamIds('9', '10')).toBeLessThan(0);
    expect(compareTeamIds('10', '9')).toBeGreaterThan(0);
    expect(compareTeamIds('7', '7')).toBe(0);
  });

  it('falls back to string comparison for non-numeric ids', () => {
    expect(compareTeamIds('alpha', 'beta')).toBeLessThan(0);
    expect(compareTeamIds('beta', 'alpha')).toBeGreaterThan(0);
  });

  it('is deterministic for mixed numeric/non-numeric', () => {
    expect(compareTeamIds('9', 'alpha')).toBe(-compareTeamIds('alpha', '9'));
  });
});

// ---------------------------------------------------------------------------
// Dual ranking and school rank
// ---------------------------------------------------------------------------

describe('domestic ranking', () => {
  it('excludes foreign teams and gives them null domesticRank', () => {
    const contest = makeContest(
      [
        { id: '1', foreign: true }, // icpc 1st
        { id: '2' }, // icpc 2nd → domestic 1st
        { id: '3', foreign: true }, // icpc 3rd
        { id: '4' }, // icpc 4th → domestic 2nd
      ],
      2,
    );
    const snap = computeStandings(contest, [
      run('1', 'p1', 10, 'accepted'),
      run('1', 'p2', 20, 'accepted'),
      run('2', 'p1', 30, 'accepted'),
      run('2', 'p2', 40, 'accepted'),
      run('3', 'p1', 50, 'accepted'),
      run('4', 'p1', 60, 'accepted'),
    ]);
    expect(snap.byTeam.get('1')!.icpcRank).toBe(1);
    expect(snap.byTeam.get('1')!.domesticRank).toBeNull();
    expect(snap.byTeam.get('2')!.icpcRank).toBe(2);
    expect(snap.byTeam.get('2')!.domesticRank).toBe(1);
    expect(snap.byTeam.get('3')!.domesticRank).toBeNull();
    expect(snap.byTeam.get('4')!.icpcRank).toBe(4);
    expect(snap.byTeam.get('4')!.domesticRank).toBe(2);
  });

  it('applies rank gaps independently within the domestic population', () => {
    const contest = makeContest([
      { id: '1', foreign: true },
      { id: '2' },
      { id: '3' },
      { id: '4' },
    ]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 10, 'accepted'),
      // domestic teams 2 and 3 fully tied, team 4 behind
      run('2', 'p1', 30, 'accepted'),
      run('3', 'p1', 30, 'accepted'),
      run('4', 'p1', 50, 'accepted'),
    ]);
    expect(snap.byTeam.get('2')!.domesticRank).toBe(1);
    expect(snap.byTeam.get('3')!.domesticRank).toBe(1);
    expect(snap.byTeam.get('4')!.domesticRank).toBe(3); // gap after shared 1,1
  });
});

describe('schoolRank', () => {
  it('numbers teams 1..n within each group by standing order', () => {
    const contest = makeContest([
      { id: '1', group: 'KAIST' },
      { id: '2', group: 'SNU' },
      { id: '3', group: 'KAIST' },
      { id: '4', group: 'KAIST' },
    ]);
    const snap = computeStandings(contest, [
      run('3', 'p1', 10, 'accepted'), // KAIST best
      run('2', 'p1', 20, 'accepted'), // SNU best
      run('1', 'p1', 30, 'accepted'), // KAIST 2nd
      // team 4: no solve → KAIST 3rd
    ]);
    expect(snap.byTeam.get('3')!.schoolRank).toBe(1);
    expect(snap.byTeam.get('1')!.schoolRank).toBe(2);
    expect(snap.byTeam.get('4')!.schoolRank).toBe(3);
    expect(snap.byTeam.get('2')!.schoolRank).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// First/last solve and contest-wide first/last yes
// ---------------------------------------------------------------------------

describe('first solve', () => {
  it('marks ALL teams tied at the minimum minute as first solvers', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }, { id: '3' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 15, 'accepted', { seq: 1 }),
      run('2', 'p1', 15, 'accepted', { seq: 2 }),
      run('3', 'p1', 16, 'accepted', { seq: 3 }),
    ]);
    expect(snap.firstSolvers.get('p1')).toEqual(['1', '2']);
    expect(snap.byTeam.get('1')!.cells.get('p1')!.isFirstSolve).toBe(true);
    expect(snap.byTeam.get('2')!.cells.get('p1')!.isFirstSolve).toBe(true);
    expect(snap.byTeam.get('3')!.cells.get('p1')!.isFirstSolve).toBe(false);
  });

  it('has no firstSolvers entry for unsolved problems', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [run('1', 'p1', 10, 'failed')]);
    expect(snap.firstSolvers.has('p1')).toBe(false);
    expect(snap.firstSolvers.has('p2')).toBe(false);
  });
});

describe('last solve (per problem)', () => {
  it('marks the single latest accepted cell: max minute, then max seq', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }, { id: '3' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 100, 'accepted', { seq: 1 }),
      run('2', 'p1', 200, 'accepted', { seq: 2 }),
      run('3', 'p1', 200, 'accepted', { seq: 3 }), // same minute, higher seq → wins
    ]);
    expect(snap.byTeam.get('1')!.cells.get('p1')!.isLastSolve).toBe(false);
    expect(snap.byTeam.get('2')!.cells.get('p1')!.isLastSolve).toBe(false);
    expect(snap.byTeam.get('3')!.cells.get('p1')!.isLastSolve).toBe(true);
  });

  it('a sole solver is first solve only — first wins over last', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [run('1', 'p1', 10, 'accepted')]);
    const standing = snap.byTeam.get('1')!;
    const cell = standing.cells.get('p1')!;
    expect(cell.isFirstSolve).toBe(true);
    expect(cell.isLastSolve).toBe(false);
    expect(labelKinds(standing.autoLabels)).toContain('firstToSolve');
    expect(labelKinds(standing.autoLabels)).not.toContain('lastToSolve');
  });

  it('marks no last solve when every solver is tied at the first minute', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 15, 'accepted', { seq: 1 }),
      run('2', 'p1', 15, 'accepted', { seq: 2 }),
    ]);
    expect(snap.byTeam.get('1')!.cells.get('p1')!.isLastSolve).toBe(false);
    expect(snap.byTeam.get('2')!.cells.get('p1')!.isLastSolve).toBe(false);
  });
});

describe('contest-wide first/last yes', () => {
  it('picks single cells: first by min minute then min seq, last by max minute then max seq', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 10, 'accepted', { seq: 1 }), // contest first (min minute 10, min seq)
      run('2', 'p2', 10, 'accepted', { seq: 2 }), // same minute, higher seq → not first
      run('3', 'p1', 90, 'accepted', { seq: 3 }),
      run('4', 'p2', 90, 'accepted', { seq: 4 }), // contest last (max minute, max seq)
    ]);
    expect(snap.contestFirstYes).toEqual({ teamId: '1', problemId: 'p1' });
    expect(snap.contestLastYes).toEqual({ teamId: '4', problemId: 'p2' });
    expect(snap.byTeam.get('1')!.cells.get('p1')!.isContestFirstSolve).toBe(true);
    expect(snap.byTeam.get('2')!.cells.get('p2')!.isContestFirstSolve).toBe(false);
    expect(snap.byTeam.get('4')!.cells.get('p2')!.isContestLastSolve).toBe(true);
    expect(snap.byTeam.get('3')!.cells.get('p1')!.isContestLastSolve).toBe(false);
  });

  it('is null when nothing is accepted', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [run('1', 'p1', 10, 'failed')]);
    expect(snap.contestFirstYes).toBeNull();
    expect(snap.contestLastYes).toBeNull();
  });

  it('moves as more runs are applied (award-reveal semantics)', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }]);
    const runs = [
      run('1', 'p1', 10, 'accepted', { seq: 1 }),
      run('2', 'p2', 50, 'accepted', { seq: 2 }),
    ];
    const before = computeStandings(contest, runs.slice(0, 1));
    expect(before.contestLastYes).toEqual({ teamId: '1', problemId: 'p1' });
    const after = computeStandings(contest, runs);
    expect(after.contestLastYes).toEqual({ teamId: '2', problemId: 'p2' });
    // contest first is unchanged
    expect(after.contestFirstYes).toEqual({ teamId: '1', problemId: 'p1' });
  });
});

// ---------------------------------------------------------------------------
// Auto labels
// ---------------------------------------------------------------------------

describe('autoLabels', () => {
  function failuresThenYes(teamId: string, problemId: string, failures: number, solveMinute: number): Run[] {
    const runs: Run[] = [];
    for (let i = 0; i < failures; i++) runs.push(run(teamId, problemId, solveMinute - failures + i, 'failed'));
    runs.push(run(teamId, problemId, solveMinute, 'accepted'));
    return runs;
  }

  it('triedNTimes fires at exactly the threshold of net attempts (default 10) when solved', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }]);
    const snap = computeStandings(contest, [
      ...failuresThenYes('1', 'p1', 9, 100), // 10 net attempts
      ...failuresThenYes('2', 'p1', 8, 100), // 9 net attempts
    ]);
    expect(snap.byTeam.get('1')!.autoLabels).toContainEqual({ kind: 'triedNTimes', attempts: 10 });
    expect(labelKinds(snap.byTeam.get('2')!.autoLabels)).not.toContain('triedNTimes');
  });

  it('triedNTimes requires solved: 12 failures without a Yes emit nothing', () => {
    const contest = makeContest([{ id: '1' }]);
    const runs: Run[] = [];
    for (let i = 0; i < 12; i++) runs.push(run('1', 'p1', 10 + i, 'failed'));
    const snap = computeStandings(contest, runs);
    expect(labelKinds(snap.byTeam.get('1')!.autoLabels)).not.toContain('triedNTimes');
  });

  it('emits ONE triedNTimes label with the max attempts when multiple problems qualify', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [
      ...failuresThenYes('1', 'p1', 10, 100), // 11 attempts
      ...failuresThenYes('1', 'p2', 12, 200), // 13 attempts
    ]);
    const tried = snap.byTeam.get('1')!.autoLabels.filter((l) => l.kind === 'triedNTimes');
    expect(tried).toEqual([{ kind: 'triedNTimes', attempts: 13 }]);
  });

  it('respects a custom threshold argument', () => {
    const contest = makeContest([{ id: '1' }]);
    const runs = failuresThenYes('1', 'p1', 2, 50); // 3 net attempts
    const defaultSnap = computeStandings(contest, runs);
    expect(labelKinds(defaultSnap.byTeam.get('1')!.autoLabels)).not.toContain('triedNTimes');
    const customSnap = computeStandings(contest, runs, 3);
    expect(customSnap.byTeam.get('1')!.autoLabels).toContainEqual({
      kind: 'triedNTimes',
      attempts: 3,
    });
  });

  it('counts net attempts only: runs after the first Yes never qualify a cell', () => {
    const contest = makeContest([{ id: '1' }]);
    const runs = [
      ...failuresThenYes('1', 'p1', 3, 50), // 4 net attempts
      // 8 more (ignored) runs after the accepted one
      ...Array.from({ length: 8 }, (_, i) => run('1', 'p1', 60 + i, 'failed')),
    ];
    const snap = computeStandings(contest, runs);
    expect(labelKinds(snap.byTeam.get('1')!.autoLabels)).not.toContain('triedNTimes');
  });

  it('aggregates firstToSolve problems into ONE label sorted by problem order', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }], 4);
    const snap = computeStandings(contest, [
      run('1', 'p4', 10, 'accepted'), // D
      run('1', 'p1', 20, 'accepted'), // A
      run('1', 'p3', 30, 'accepted'), // C
      run('2', 'p2', 15, 'accepted'), // B → team 2's first solve
    ]);
    const firsts = snap.byTeam.get('1')!.autoLabels.filter((l) => l.kind === 'firstToSolve');
    expect(firsts).toEqual([{ kind: 'firstToSolve', problemLabels: ['A', 'C', 'D'] }]);
    expect(snap.byTeam.get('2')!.autoLabels).toContainEqual({
      kind: 'firstToSolve',
      problemLabels: ['B'],
    });
  });

  it('aggregates lastToSolve problems into ONE label sorted by problem order', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }], 3);
    const snap = computeStandings(contest, [
      run('2', 'p2', 10, 'accepted'),
      run('2', 'p3', 20, 'accepted'),
      run('1', 'p3', 100, 'accepted'), // last solve of C
      run('1', 'p2', 120, 'accepted'), // last solve of B
    ]);
    const lasts = snap.byTeam.get('1')!.autoLabels.filter((l) => l.kind === 'lastToSolve');
    expect(lasts).toEqual([{ kind: 'lastToSolve', problemLabels: ['B', 'C'] }]);
    expect(labelKinds(snap.byTeam.get('2')!.autoLabels)).not.toContain('lastToSolve');
  });

  it('attaches contestFirstYes and contestLastYes to the owning teams', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 10, 'accepted', { seq: 1 }),
      run('2', 'p2', 90, 'accepted', { seq: 2 }),
    ]);
    expect(labelKinds(snap.byTeam.get('1')!.autoLabels)).toContain('contestFirstYes');
    expect(labelKinds(snap.byTeam.get('1')!.autoLabels)).not.toContain('contestLastYes');
    expect(labelKinds(snap.byTeam.get('2')!.autoLabels)).toContain('contestLastYes');
    expect(labelKinds(snap.byTeam.get('2')!.autoLabels)).not.toContain('contestFirstYes');
  });

  it('a team can hold both contestFirstYes and contestLastYes', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [
      run('1', 'p1', 10, 'accepted'),
      run('1', 'p2', 90, 'accepted'),
    ]);
    const kinds = labelKinds(snap.byTeam.get('1')!.autoLabels);
    expect(kinds).toContain('contestFirstYes');
    expect(kinds).toContain('contestLastYes');
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('robustness', () => {
  it('ignores runs for teams or problems not in the contest (excluded teams)', () => {
    const contest = makeContest([{ id: '1' }]);
    const snap = computeStandings(contest, [
      run('ghost', 'p1', 5, 'accepted'), // excluded team → dropped earlier in the pipeline
      run('1', 'ghost-problem', 5, 'accepted'),
      run('1', 'p1', 10, 'accepted'),
    ]);
    expect(snap.standings).toHaveLength(1);
    expect(snap.contestFirstYes).toEqual({ teamId: '1', problemId: 'p1' });
    expect(snap.firstSolvers.get('p1')).toEqual(['1']);
  });

  it('does not mutate the input runs array', () => {
    const contest = makeContest([{ id: '1' }]);
    const runs = [
      run('1', 'p1', 90, 'accepted', { seq: 2 }),
      run('1', 'p1', 10, 'failed', { seq: 1 }),
    ];
    const before = runs.map((r) => r.id);
    computeStandings(contest, runs);
    expect(runs.map((r) => r.id)).toEqual(before);
  });

  it('ranks all teams as fully tied at rank 1 with an empty run list', () => {
    const contest = makeContest([{ id: '1' }, { id: '2' }, { id: '3' }]);
    const snap = computeStandings(contest, []);
    expect(snap.standings.map((s) => s.icpcRank)).toEqual([1, 1, 1]);
    expect(snap.standings.map((s) => s.team.id)).toEqual(['1', '2', '3']);
  });
});

// ---------------------------------------------------------------------------
// Golden test: 2025 ICPC Seoul sample (84 teams / 13 problems / 1227 runs)
// ---------------------------------------------------------------------------

describe('golden: 2025 ICPC Seoul sample', () => {
  interface SpotboardContestJson {
    title: string;
    systemName: string;
    systemVersion: string;
    problems: { id: number; name: string; title: string; color: string }[];
    teams: { id: number; name: string; group?: string }[];
  }
  interface SpotboardRunsJson {
    runs: { id: number; team: number; problem: number; result: string; submissionTime: number }[];
  }

  function loadSample(): { contest: Contest; runs: Run[] } {
    const cj = sampleContestJson as SpotboardContestJson;
    const rj = sampleRunsJson as SpotboardRunsJson;
    const contest: Contest = {
      title: cj.title,
      systemName: cj.systemName,
      systemVersion: cj.systemVersion,
      problems: cj.problems.map((p, i) => ({
        id: String(p.id),
        label: p.name,
        title: p.title,
        color: p.color,
        order: i,
      })),
      teams: new Map(
        cj.teams.map((t) => [
          String(t.id),
          { id: String(t.id), name: t.name, group: t.group ?? '', foreign: false },
        ]),
      ),
    };
    const runs: Run[] = rj.runs.map((r) => ({
      id: String(r.id),
      teamId: String(r.team),
      problemId: String(r.problem),
      minute: r.submissionTime,
      seq: r.id,
      ...normalizeSpotboardResult(r.result),
    }));
    return { contest, runs };
  }

  const { contest, runs } = loadSample();
  const snap = computeStandings(contest, runs);
  const problemByLabel = new Map(contest.problems.map((p) => [p.label, p.id]));

  it('covers all 84 teams', () => {
    expect(snap.standings).toHaveLength(84);
    expect(snap.byTeam.size).toBe(84);
  });

  it('pins the top 5 (team id, solved, penalty, rank)', () => {
    const top = snap.standings
      .slice(0, 5)
      .map((s) => [s.team.id, s.solved, s.penalty, s.icpcRank]);
    expect(top).toEqual([
      ['28', 10, 1041, 1],
      ['61', 10, 1085, 2],
      ['21', 10, 1095, 3],
      ['8', 10, 1149, 4],
      ['77', 9, 933, 5],
    ]);
  });

  it('shares the bottom rank between the two zero-solve teams (competition ranking)', () => {
    const bottom = snap.standings.slice(-2);
    expect(bottom.map((s) => s.solved)).toEqual([0, 0]);
    expect(bottom.map((s) => s.icpcRank)).toEqual([83, 83]);
    expect(bottom.map((s) => s.team.id)).toEqual(['33', '55']);
  });

  it('has 477 solved cells in total (net truncation applied to 480 accepted runs)', () => {
    const total = snap.standings.reduce((acc, s) => acc + s.solved, 0);
    expect(total).toBe(477);
  });

  it('pins the contest first yes: team 28 on M at minute 6', () => {
    const mId = problemByLabel.get('M')!;
    expect(snap.contestFirstYes).toEqual({ teamId: '28', problemId: mId });
    expect(snap.byTeam.get('28')!.cells.get(mId)!.solvedMinute).toBe(6);
    expect(labelKinds(snap.byTeam.get('28')!.autoLabels)).toContain('contestFirstYes');
  });

  it('pins the contest last yes: team 79 on K at minute 299', () => {
    const kId = problemByLabel.get('K')!;
    expect(snap.contestLastYes).toEqual({ teamId: '79', problemId: kId });
    expect(snap.byTeam.get('79')!.cells.get(kId)!.solvedMinute).toBe(299);
    expect(labelKinds(snap.byTeam.get('79')!.autoLabels)).toContain('contestLastYes');
  });

  it('pins problem L first solve as a two-team tie at minute 9 (teams 64 and 39)', () => {
    const lId = problemByLabel.get('L')!;
    const solvers = snap.firstSolvers.get(lId)!;
    expect(new Set(solvers)).toEqual(new Set(['64', '39']));
    expect(snap.byTeam.get('64')!.cells.get(lId)!.isFirstSolve).toBe(true);
    expect(snap.byTeam.get('39')!.cells.get(lId)!.isFirstSolve).toBe(true);
  });

  it('leaves unsolved problems A and B without first solvers or last-solve flags', () => {
    const aId = problemByLabel.get('A')!;
    const bId = problemByLabel.get('B')!;
    expect(snap.firstSolvers.has(aId)).toBe(false);
    expect(snap.firstSolvers.has(bId)).toBe(false);
    for (const s of snap.standings) {
      expect(s.cells.get(aId)!.isLastSolve).toBe(false);
      expect(s.cells.get(bId)!.isLastSolve).toBe(false);
    }
  });

  it('gives exactly teams 11, 37, 67 the triedNTimes label (all with 10 attempts)', () => {
    const tried = snap.standings
      .filter((s) => s.autoLabels.some((l) => l.kind === 'triedNTimes'))
      .map((s) => s.team.id)
      .sort();
    expect(tried).toEqual(['11', '37', '67']);
    for (const id of tried) {
      expect(snap.byTeam.get(id)!.autoLabels).toContainEqual({ kind: 'triedNTimes', attempts: 10 });
    }
  });

  it('pins first-to-solve badges: team 28 first-solved D, E, F, I, M', () => {
    const labels = snap.byTeam.get('28')!.autoLabels.find((l) => l.kind === 'firstToSolve');
    expect(labels).toEqual({ kind: 'firstToSolve', problemLabels: ['D', 'E', 'F', 'I', 'M'] });
  });

  it('keeps rank monotone and gap-consistent over the whole board', () => {
    let expectedNext = 1;
    let prev: (typeof snap.standings)[number] | null = null;
    for (let i = 0; i < snap.standings.length; i++) {
      const s = snap.standings[i];
      if (
        prev &&
        prev.solved === s.solved &&
        prev.penalty === s.penalty &&
        prev.lastSolvedMinute === s.lastSolvedMinute
      ) {
        expect(s.icpcRank).toBe(prev.icpcRank);
      } else {
        expect(s.icpcRank).toBe(i + 1);
        expectedNext = i + 1;
      }
      expect(s.icpcRank).toBeLessThanOrEqual(expectedNext);
      // all-domestic sample: domesticRank mirrors icpcRank
      expect(s.domesticRank).toBe(s.icpcRank);
      prev = s;
    }
  });

  it('assigns contiguous schoolRank sequences per group', () => {
    const seen = new Map<string, number>();
    for (const s of snap.standings) {
      const next = (seen.get(s.team.group) ?? 0) + 1;
      seen.set(s.team.group, next);
      expect(s.schoolRank).toBe(next);
    }
  });
});
