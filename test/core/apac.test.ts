import { describe, expect, it } from 'vitest';
import type { Contest, Problem, Run, Snapshot, Team, Verdict } from '@core/types';
import { computeStandings } from '@core/standings';
import { computeApacStars, APAC_SCHOOL_RANK_CAP, type ApacStarOptions } from '@core/apac';

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
  group: string;
  foreign?: boolean;
}

function makeContest(teamSpecs: TeamSpec[], problemCount = 2): Contest {
  const teams = new Map<string, Team>();
  for (const spec of teamSpecs) {
    teams.set(spec.id, {
      id: spec.id,
      name: `Team ${spec.id}`,
      group: spec.group,
      foreign: spec.foreign ?? false,
    });
  }
  return {
    title: 'APAC Fixture',
    systemName: 'fixture',
    systemVersion: '0',
    problems: makeProblems(problemCount),
    teams,
  };
}

let runSeq = 0;

function run(teamId: string, problemId: string, minute: number, verdict: Verdict = 'accepted'): Run {
  const seq = ++runSeq;
  return {
    id: String(seq),
    teamId,
    problemId,
    minute,
    verdict,
    penaltyCounts: verdict === 'failed',
    seq,
  };
}

/**
 * Standard fixture: three schools, ranks fully determined by the solve minute
 * of problem p1 (penalty = minute, all 1-solved).
 *
 *   icpcRank 1: x1 (X)   schoolRank 1
 *   icpcRank 2: x2 (X)   schoolRank 2
 *   icpcRank 3: y1 (Y)   schoolRank 1
 *   icpcRank 4: y2 (Y)   schoolRank 2
 *   icpcRank 5: x3 (X)   schoolRank 3
 *   icpcRank 6: y3 (Y)   schoolRank 3
 *   icpcRank 7: x4 (X)   schoolRank 4  ← never starred (per-school cap)
 *   icpcRank 8: z1 (Z)   schoolRank 1  (0 solved)
 */
function fixtureSnapshot(): Snapshot {
  const contest = makeContest([
    { id: 'x1', group: 'X' },
    { id: 'x2', group: 'X' },
    { id: 'x3', group: 'X' },
    { id: 'x4', group: 'X' },
    { id: 'y1', group: 'Y' },
    { id: 'y2', group: 'Y' },
    { id: 'y3', group: 'Y' },
    { id: 'z1', group: 'Z' },
  ]);
  return computeStandings(contest, [
    run('x1', 'p1', 10),
    run('x2', 'p1', 20),
    run('y1', 'p1', 30),
    run('y2', 'p1', 40),
    run('x3', 'p1', 50),
    run('y3', 'p1', 60),
    run('x4', 'p1', 70),
    // z1 solves nothing → last place.
  ]);
}

function opts(partial: Partial<ApacStarOptions> = {}): ApacStarOptions {
  return {
    phase: 'ceremony',
    championTeamId: null,
    siteScore: null,
    invitedScoreCutoff: null,
    ...partial,
  };
}

function asObject(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Ceremony phase — bronze for schoolRank ≤ 3
// ---------------------------------------------------------------------------

describe('computeApacStars — ceremony phase', () => {
  it('gives bronze to every schoolRank ≤ 3 team and nothing to the rest', () => {
    const stars = computeApacStars(fixtureSnapshot(), opts());
    expect(asObject(stars)).toEqual({
      x1: 'bronze',
      x2: 'bronze',
      x3: 'bronze',
      y1: 'bronze',
      y2: 'bronze',
      y3: 'bronze',
      z1: 'bronze', // schoolRank 1 even with 0 solved
    });
    expect(stars.has('x4')).toBe(false); // schoolRank 4 > cap
  });

  it('ignores champion/siteScore/cutoff inputs in ceremony phase', () => {
    const stars = computeApacStars(
      fixtureSnapshot(),
      opts({ championTeamId: 'x1', siteScore: 2, invitedScoreCutoff: 100 }),
    );
    for (const tier of stars.values()) expect(tier).toBe('bronze');
    expect(stars.get('x1')).toBe('bronze');
  });

  it('exposes the per-school cap constant', () => {
    expect(APAC_SCHOOL_RANK_CAP).toBe(3);
  });

  it('ties share icpcRank but still push schoolRank sequentially', () => {
    // a1/a2/a3 of school A are an exact tie (same minute) → icpcRank 1,1,1
    // but schoolRank 1,2,3 (standing order); a4 ranks 4th in school → no star.
    const contest = makeContest([
      { id: 'a1', group: 'A' },
      { id: 'a2', group: 'A' },
      { id: 'a3', group: 'A' },
      { id: 'a4', group: 'A' },
      { id: 'b1', group: 'B' },
    ]);
    const snap = computeStandings(contest, [
      run('a1', 'p1', 10),
      run('a2', 'p1', 10),
      run('a3', 'p1', 10),
      run('a4', 'p1', 10),
      run('b1', 'p1', 99),
    ]);
    // Sanity: full tie shares the icpc rank.
    expect(snap.byTeam.get('a1')!.icpcRank).toBe(1);
    expect(snap.byTeam.get('a4')!.icpcRank).toBe(1);
    expect(snap.byTeam.get('a4')!.schoolRank).toBe(4);

    const stars = computeApacStars(snap, opts());
    expect(asObject(stars)).toEqual({
      a1: 'bronze',
      a2: 'bronze',
      a3: 'bronze',
      b1: 'bronze',
    });
    expect(stars.has('a4')).toBe(false);
  });

  it('returns an empty map for an empty snapshot', () => {
    const snap = computeStandings(makeContest([]), []);
    expect(computeApacStars(snap, opts()).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Final phase — gold champion, silver others, bronze schoolmates
// ---------------------------------------------------------------------------

describe('computeApacStars — final phase', () => {
  it('champion gold, non-champion schools silver, champion schoolmates bronze', () => {
    const stars = computeApacStars(
      fixtureSnapshot(),
      opts({ phase: 'final', championTeamId: 'x1' }),
    );
    expect(asObject(stars)).toEqual({
      x1: 'gold', // champion
      x2: 'bronze', // champion schoolmate stays bronze
      x3: 'bronze',
      y1: 'silver',
      y2: 'silver',
      y3: 'silver',
      z1: 'silver',
    });
    expect(stars.has('x4')).toBe(false);
  });

  it('with championTeamId null, all starred teams are silver (no gold, no bronze)', () => {
    const stars = computeApacStars(fixtureSnapshot(), opts({ phase: 'final' }));
    for (const tier of stars.values()) expect(tier).toBe('silver');
    expect(stars.size).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Publish promotion — (icpcRank − 1) / siteScore ≤ invitedScoreCutoff
// ---------------------------------------------------------------------------

describe('computeApacStars — invited-score promotion', () => {
  const finalOpts = (siteScore: number | null, invitedScoreCutoff: number | null) =>
    opts({ phase: 'final', championTeamId: 'x1', siteScore, invitedScoreCutoff });

  it('promotes silver teams at or below the cutoff (boundary is ≤, inclusive)', () => {
    // siteScore 2, cutoff 1 → invited iff (icpcRank − 1) / 2 ≤ 1 ⇔ icpcRank ≤ 3.
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, 1));
    expect(stars.get('y1')).toBe('gold'); // rank 3: (3−1)/2 = 1 — exactly the cutoff
    expect(stars.get('y2')).toBe('silver'); // rank 4: 1.5 > 1
    expect(stars.get('y3')).toBe('silver');
    expect(stars.get('z1')).toBe('silver');
  });

  it('never promotes champion schoolmates even when their score passes', () => {
    // x2 has rank 2: (2−1)/2 = 0.5 ≤ 1, but it is bronze, not silver.
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, 1));
    expect(stars.get('x2')).toBe('bronze');
    expect(stars.get('x3')).toBe('bronze');
    expect(stars.get('x1')).toBe('gold'); // champion unaffected
  });

  it('does not promote when siteScore is missing', () => {
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(null, 100));
    expect(stars.get('y1')).toBe('silver');
    expect(stars.get('x1')).toBe('gold'); // champion gold does not need the cutoff
  });

  it('does not promote when invitedScoreCutoff is missing', () => {
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, null));
    expect(stars.get('y1')).toBe('silver');
  });

  it('ignores a non-positive siteScore', () => {
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(0, 100));
    expect(stars.get('y1')).toBe('silver');
  });

  it('cutoff 0 promotes only rank-1 silver teams', () => {
    // Champion of school X; b1 ties x1 at rank 1 from another school.
    const contest = makeContest([
      { id: 'x1', group: 'X' },
      { id: 'b1', group: 'B' },
      { id: 'c1', group: 'C' },
    ]);
    const snap = computeStandings(contest, [
      run('x1', 'p1', 10),
      run('b1', 'p1', 10), // exact tie with x1 → both icpcRank 1
      run('c1', 'p1', 20),
    ]);
    const stars = computeApacStars(
      snap,
      opts({ phase: 'final', championTeamId: 'x1', siteScore: 5, invitedScoreCutoff: 0 }),
    );
    expect(stars.get('x1')).toBe('gold'); // champion
    expect(stars.get('b1')).toBe('gold'); // (1−1)/5 = 0 ≤ 0
    expect(stars.get('c1')).toBe('silver'); // (3−1)/5 = 0.4 > 0
  });

  it('teams sharing an icpcRank get the same promotion verdict', () => {
    const contest = makeContest([
      { id: 'x1', group: 'X' },
      { id: 'b1', group: 'B' },
      { id: 'c1', group: 'C' },
      { id: 'd1', group: 'D' },
    ]);
    const snap = computeStandings(contest, [
      run('x1', 'p1', 10),
      run('b1', 'p1', 30),
      run('c1', 'p1', 30), // ties b1 → both icpcRank 2
      run('d1', 'p1', 90),
    ]);
    const stars = computeApacStars(
      snap,
      opts({ phase: 'final', championTeamId: 'x1', siteScore: 1, invitedScoreCutoff: 1 }),
    );
    expect(stars.get('b1')).toBe('gold'); // (2−1)/1 = 1 ≤ 1
    expect(stars.get('c1')).toBe('gold');
    expect(stars.get('d1')).toBe('silver'); // rank 4: 3 > 1
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('computeApacStars — determinism', () => {
  it('same inputs produce identical maps', () => {
    const snap = fixtureSnapshot();
    const o = opts({ phase: 'final', championTeamId: 'x1', siteScore: 2, invitedScoreCutoff: 1 });
    const a = computeApacStars(snap, o);
    const b = computeApacStars(snap, o);
    expect(asObject(a)).toEqual(asObject(b));
    expect([...a.keys()]).toEqual([...b.keys()]); // same iteration order too
  });

  it('does not mutate the snapshot', () => {
    const snap = fixtureSnapshot();
    const before = snap.standings.map((s) => ({ ...s, cells: undefined, autoLabels: undefined }));
    computeApacStars(snap, opts({ phase: 'final', championTeamId: 'x1', siteScore: 2, invitedScoreCutoff: 5 }));
    const after = snap.standings.map((s) => ({ ...s, cells: undefined, autoLabels: undefined }));
    expect(after).toEqual(before);
  });
});
