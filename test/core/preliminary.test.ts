import { describe, expect, it } from 'vitest';
import type { Contest, Problem, Run, Snapshot, Team } from '@core/types';
import { computeStandings } from '@core/standings';
import { selectPreliminary, type PrelimOptions } from '@core/preliminary';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const PROBLEM_COUNT = 12;

function makeProblems(): Problem[] {
  return Array.from({ length: PROBLEM_COUNT }, (_, i) => ({
    id: `p${i + 1}`,
    label: String.fromCharCode(65 + i),
    title: `Problem ${i + 1}`,
    color: 'red',
    order: i,
  }));
}

interface TeamSpec {
  id: string;
  group: string;
  solved: number;
  /** Minute of every accepted run; defaults to the list position + 1. */
  minute?: number;
}

/**
 * Builds a snapshot from team specs listed in the intended standing order.
 * Each team solves p1..p{solved} at one minute, so with `solved`
 * non-increasing the order is exactly the list order. Teams with the same
 * `solved` and the same explicit `minute` share an icpcRank.
 */
function snapshotOf(specs: TeamSpec[]): Snapshot {
  const teams = new Map<string, Team>();
  for (const spec of specs) {
    teams.set(spec.id, { id: spec.id, name: `Team ${spec.id}`, group: spec.group, foreign: false });
  }
  const contest: Contest = {
    title: 'Prelim Fixture',
    systemName: 'fixture',
    systemVersion: '0',
    problems: makeProblems(),
    teams,
  };
  const runs: Run[] = [];
  let seq = 0;
  specs.forEach((spec, i) => {
    for (let p = 1; p <= spec.solved; p++) {
      seq++;
      runs.push({
        id: String(seq),
        teamId: spec.id,
        problemId: `p${p}`,
        minute: spec.minute ?? i + 1,
        verdict: 'accepted',
        penaltyCounts: false,
        seq,
      });
    }
  });
  return computeStandings(contest, runs);
}

function opts(partial: Partial<PrelimOptions> = {}): PrelimOptions {
  return {
    totalTeams: 10,
    topN: 30,
    k: 0,
    ineligibleTeamIds: new Set<string>(),
    ...partial,
  };
}

function stages(result: ReturnType<typeof selectPreliminary>): Record<string, string> {
  return Object.fromEntries(result.selected);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectPreliminary', () => {
  it('selects the top N regardless of school', () => {
    const snap = snapshotOf([
      { id: 'a1', group: 'A', solved: 5 },
      { id: 'a2', group: 'A', solved: 5 },
      { id: 'a3', group: 'A', solved: 5 },
      { id: 'b1', group: 'B', solved: 4 },
      { id: 'c1', group: 'C', solved: 3 },
    ]);
    const result = selectPreliminary(snap, opts({ topN: 3, totalTeams: 5, k: 1 }));
    expect(stages(result)).toEqual({
      a1: 'top',
      a2: 'top',
      a3: 'top',
      b1: 'school',
      c1: 'school',
    });
    expect(result.counts).toEqual({ top: 3, school: 2, fill: 0 });
    expect(result.overflow).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('school step skips schools already in the top N (해석 1)', () => {
    const snap = snapshotOf([
      { id: 'a1', group: 'A', solved: 6 },
      { id: 'a2', group: 'A', solved: 5 },
      { id: 'a3', group: 'A', solved: 4 },
      { id: 'b1', group: 'B', solved: 3 },
    ]);
    const result = selectPreliminary(snap, opts({ topN: 2, totalTeams: 3, k: 1 }));
    expect(stages(result)).toEqual({ a1: 'top', a2: 'top', b1: 'school' });
    expect(result.selected.has('a3')).toBe(false);
  });

  it("school step takes only the school's best team and drops the school below K", () => {
    const snap = snapshotOf([
      { id: 'a1', group: 'A', solved: 5 },
      { id: 'c1', group: 'C', solved: 3 },
      { id: 'b1', group: 'B', solved: 2 }, // B's best team: K − 1
      { id: 'c2', group: 'C', solved: 2 },
      { id: 'b2', group: 'B', solved: 1 }, // lower, never looked at
    ]);
    const result = selectPreliminary(snap, opts({ topN: 1, totalTeams: 2, k: 3 }));
    expect(stages(result)).toEqual({ a1: 'top', c1: 'school' });
    expect(result.selected.has('b1')).toBe(false);
    expect(result.selected.has('b2')).toBe(false);
    expect(result.selected.has('c2')).toBe(false);
    expect(result.counts).toEqual({ top: 1, school: 1, fill: 0 });
  });

  it('ineligible teams are skipped in every step', () => {
    const snap = snapshotOf([
      { id: 'x1', group: 'X', solved: 5 }, // rank 1, ineligible
      { id: 'a1', group: 'A', solved: 4 },
      { id: 'b1', group: 'B', solved: 3 },
      { id: 'x2', group: 'X', solved: 1 }, // X's best ELIGIBLE team
    ]);
    const result = selectPreliminary(
      snap,
      opts({ topN: 2, totalTeams: 3, k: 1, ineligibleTeamIds: new Set(['x1']) }),
    );
    expect(stages(result)).toEqual({ a1: 'top', b1: 'top', x2: 'school' });
    expect(result.selected.has('x1')).toBe(false);

    // Fill also skips ineligible teams.
    const filled = selectPreliminary(
      snap,
      opts({ topN: 0, totalTeams: 4, k: 99, ineligibleTeamIds: new Set(['x1']) }),
    );
    expect([...filled.selected.keys()]).toEqual(['a1', 'b1', 'x2']);
    expect(filled.selected.has('x1')).toBe(false);
  });

  it('fill tops up to totalTeams in standings order', () => {
    const snap = snapshotOf([
      { id: 'a1', group: 'A', solved: 5 },
      { id: 'a2', group: 'A', solved: 4 },
      { id: 'b1', group: 'B', solved: 3 },
      { id: 'a3', group: 'A', solved: 2 },
      { id: 'c1', group: 'C', solved: 1 },
    ]);
    const result = selectPreliminary(snap, opts({ topN: 1, totalTeams: 4, k: 99 }));
    expect([...result.selected.entries()]).toEqual([
      ['a1', 'top'],
      ['a2', 'fill'],
      ['b1', 'fill'],
      ['a3', 'fill'],
    ]);
    expect(result.counts.fill).toBe(4 - result.counts.top - result.counts.school);
    expect(result.overflow).toBe(false);
  });

  it('overflow keeps every school pick, adds no fill, warns', () => {
    const snap = snapshotOf([
      { id: 'a1', group: 'A', solved: 5 },
      { id: 'b1', group: 'B', solved: 4 },
      { id: 'c1', group: 'C', solved: 3 },
      { id: 'd1', group: 'D', solved: 2 },
      { id: 'a2', group: 'A', solved: 1 },
    ]);
    const result = selectPreliminary(snap, opts({ topN: 2, totalTeams: 3, k: 1 }));
    expect(stages(result)).toEqual({ a1: 'top', b1: 'top', c1: 'school', d1: 'school' });
    expect(result.overflow).toBe(true);
    expect(result.counts).toEqual({ top: 2, school: 2, fill: 0 });
    expect(result.warnings.some((w) => w.includes('넘습니다') && w.includes('4팀'))).toBe(true);
  });

  it('fewer eligible teams than totalTeams selects all of them without error', () => {
    const snap = snapshotOf([
      { id: 'a1', group: 'A', solved: 3 },
      { id: 'a2', group: 'A', solved: 2 },
      { id: 'b1', group: 'B', solved: 1 },
      { id: 'b2', group: 'B', solved: 0 },
    ]);
    const result = selectPreliminary(
      snap,
      opts({ topN: 1, totalTeams: 10, k: 99, ineligibleTeamIds: new Set(['b2']) }),
    );
    expect([...result.selected.keys()]).toEqual(['a1', 'a2', 'b1']);
    expect(result.counts).toEqual({ top: 1, school: 0, fill: 2 });
    expect(result.overflow).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('topN ≥ totalTeams: overflow only when topN > totalTeams', () => {
    const snap = snapshotOf([
      { id: 'a1', group: 'A', solved: 5 },
      { id: 'b1', group: 'B', solved: 4 },
      { id: 'c1', group: 'C', solved: 3 },
      { id: 'd1', group: 'D', solved: 2 },
      { id: 'e1', group: 'E', solved: 1 },
    ]);
    const over = selectPreliminary(snap, opts({ topN: 4, totalTeams: 3, k: 99 }));
    expect(over.counts).toEqual({ top: 4, school: 0, fill: 0 });
    expect(over.overflow).toBe(true);

    const equal = selectPreliminary(snap, opts({ topN: 3, totalTeams: 3, k: 99 }));
    expect(equal.counts).toEqual({ top: 3, school: 0, fill: 0 });
    expect(equal.overflow).toBe(false);

    // topN larger than the whole field: every eligible team is 'top'.
    const all = selectPreliminary(snap, opts({ topN: 30, totalTeams: 10, k: 0 }));
    expect(all.counts).toEqual({ top: 5, school: 0, fill: 0 });
    expect(all.overflow).toBe(false);
  });

  it('org-less teams are separate schools in the school step', () => {
    const snap = snapshotOf([
      { id: 'a1', group: 'A', solved: 5 },
      { id: 'n1', group: '', solved: 4 },
      { id: 'n2', group: '', solved: 3 },
      { id: 'n3', group: '', solved: 0 }, // below K
    ]);
    const result = selectPreliminary(snap, opts({ topN: 1, totalTeams: 3, k: 1 }));
    expect(stages(result)).toEqual({ a1: 'top', n1: 'school', n2: 'school' });

    // An org-less team in the top N does not cover other org-less teams.
    const covered = selectPreliminary(snap, opts({ topN: 2, totalTeams: 3, k: 1 }));
    expect(stages(covered)).toEqual({ a1: 'top', n1: 'top', n2: 'school' });
  });

  it('warns on a tie at the top-N boundary', () => {
    const snap = snapshotOf([
      { id: 't1', group: 'A', solved: 3 },
      { id: 't2', group: 'B', solved: 2, minute: 50 },
      { id: 't3', group: 'C', solved: 2, minute: 50 },
      { id: 't4', group: 'D', solved: 1 },
    ]);
    expect(snap.byTeam.get('t2')!.icpcRank).toBe(snap.byTeam.get('t3')!.icpcRank);

    const result = selectPreliminary(snap, opts({ topN: 2, totalTeams: 2, k: 99 }));
    expect(stages(result)).toEqual({ t1: 'top', t2: 'top' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Team t2');
    expect(result.warnings[0]).toContain('Team t3');

    // No warning when the boundary does not split a tie.
    const clean = selectPreliminary(snap, opts({ topN: 1, totalTeams: 1, k: 99 }));
    expect(clean.warnings).toEqual([]);
  });

  it('does not warn on a top-N tie when the tied next team is selected by a later step', () => {
    const snap = snapshotOf([
      { id: 'a', group: 'A', solved: 2, minute: 50 },
      { id: 'b', group: 'B', solved: 2, minute: 50 },
    ]);
    expect(snap.byTeam.get('a')!.icpcRank).toBe(snap.byTeam.get('b')!.icpcRank);

    const result = selectPreliminary(snap, opts({ topN: 1, totalTeams: 3, k: 1 }));
    expect(stages(result)).toEqual({ a: 'top', b: 'school' });
    expect(result.warnings).toEqual([]);
  });

  it('warns on a tie at the totalTeams boundary of the fill step', () => {
    const snap = snapshotOf([
      { id: 't1', group: 'A', solved: 3 },
      { id: 't2', group: 'A', solved: 2, minute: 50 },
      { id: 't3', group: 'A', solved: 2, minute: 50 },
    ]);
    const result = selectPreliminary(snap, opts({ topN: 1, totalTeams: 2, k: 99 }));
    expect(stages(result)).toEqual({ t1: 'top', t2: 'fill' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Team t2');
    expect(result.warnings[0]).toContain('Team t3');
  });
});
