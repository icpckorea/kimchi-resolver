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
 *   icpcRank 1: x1 (X)   schoolRank 1   filteredRank 1
 *   icpcRank 2: x2 (X)   schoolRank 2   filteredRank 2
 *   icpcRank 3: y1 (Y)   schoolRank 1   filteredRank 3
 *   icpcRank 4: y2 (Y)   schoolRank 2   filteredRank 4
 *   icpcRank 5: x3 (X)   schoolRank 3   filteredRank 5
 *   icpcRank 6: y3 (Y)   schoolRank 3   filteredRank 6
 *   icpcRank 7: x4 (X)   schoolRank 4  ← never starred (per-school cap)
 *   icpcRank 8: z1 (Z)   schoolRank 1   filteredRank 7  (0 solved)
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
// Final phase — gold champion, bronze champion schoolmates, silver the rest
// ---------------------------------------------------------------------------

describe('computeApacStars — final phase', () => {
  it("champion gold, champion's schoolmates keep bronze, all other schoolRank ≤ 3 teams silver", () => {
    const stars = computeApacStars(
      fixtureSnapshot(),
      opts({ phase: 'final', championTeamId: 'x1' }),
    );
    expect(asObject(stars)).toEqual({
      x1: 'gold', // champion
      x2: 'bronze', // champion's schoolmate — WF takes one team per school
      x3: 'bronze',
      y1: 'silver',
      y2: 'silver',
      y3: 'silver',
      z1: 'silver',
    });
    expect(stars.has('x4')).toBe(false);
  });

  it('with championTeamId null, all starred teams are silver (no gold)', () => {
    const stars = computeApacStars(fixtureSnapshot(), opts({ phase: 'final' }));
    for (const tier of stars.values()) expect(tier).toBe('silver');
    expect(stars.size).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Publish promotion — (filteredRank − 1) / siteScore ≤ invitedScoreCutoff
//
// filteredRank = 1-based position in the candidate list: all schoolRank ≤ 3
// teams in ICPC standing order, champion included (APAC rule D3 removes
// schoolRank ≥ 4 teams before scoring).
// ---------------------------------------------------------------------------

describe('computeApacStars — invited-score promotion (filteredRank)', () => {
  const finalOpts = (siteScore: number | null, invitedScoreCutoff: number | null) =>
    opts({ phase: 'final', championTeamId: 'x1', siteScore, invitedScoreCutoff });

  it('promotes silver teams at or below the cutoff (boundary is ≤, inclusive)', () => {
    // siteScore 2, cutoff 1 → invited iff (filteredRank − 1) / 2 ≤ 1
    // ⇔ filteredRank ≤ 3.
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, 1));
    expect(stars.get('x1')).toBe('gold'); // champion (filteredRank 1)
    expect(stars.get('x2')).toBe('bronze'); // schoolmate — occupies slot 2, never promoted
    expect(stars.get('y1')).toBe('gold'); // filteredRank 3: 1 — exactly the cutoff
    expect(stars.get('y2')).toBe('silver'); // filteredRank 4: 1.5 > 1
    expect(stars.get('x3')).toBe('bronze'); // schoolmate — occupies slot 5
    expect(stars.get('y3')).toBe('silver');
    expect(stars.get('z1')).toBe('silver');
  });

  it("never promotes the champion's schoolmate even when its score qualifies", () => {
    // x2 is the champion's schoolmate at filteredRank 2 → (2−1)/2 = 0.5 ≤ 1,
    // but WF takes one team per school: the slot counts, the star stays bronze.
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, 1));
    expect(stars.get('x2')).toBe('bronze');
    expect(stars.get('x1')).toBe('gold'); // champion unaffected
  });

  it('uses filteredRank, not raw icpcRank (schoolRank ≥ 4 teams removed)', () => {
    // z1: icpcRank 8 but filteredRank 7 (x4 is filtered out by the cap).
    // siteScore 4, cutoff 1.5: filtered (7−1)/4 = 1.5 ≤ 1.5 → gold, while the
    // raw score (8−1)/4 = 1.75 would have failed.
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(4, 1.5));
    expect(stars.get('z1')).toBe('gold');
  });

  it('does not promote when siteScore is missing', () => {
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(null, 100));
    expect(stars.get('y1')).toBe('silver');
    expect(stars.get('x2')).toBe('bronze'); // champion's schoolmate
    expect(stars.get('x1')).toBe('gold'); // champion gold does not need the cutoff
  });

  it('does not promote when invitedScoreCutoff is missing', () => {
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, null));
    expect(stars.get('y1')).toBe('silver');
    expect(stars.get('x2')).toBe('bronze'); // champion's schoolmate
  });

  it('ignores a non-positive siteScore', () => {
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(0, 100));
    expect(stars.get('y1')).toBe('silver');
  });

  it('cutoff 0 promotes only the filteredRank-1 team', () => {
    // No champion: the first candidate (filteredRank 1) scores (1−1)/5 = 0.
    const contest = makeContest([
      { id: 'b1', group: 'B' },
      { id: 'c1', group: 'C' },
      { id: 'd1', group: 'D' },
    ]);
    const snap = computeStandings(contest, [
      run('b1', 'p1', 10),
      run('c1', 'p1', 20),
      run('d1', 'p1', 30),
    ]);
    const stars = computeApacStars(
      snap,
      opts({ phase: 'final', championTeamId: null, siteScore: 5, invitedScoreCutoff: 0 }),
    );
    expect(stars.get('b1')).toBe('gold'); // (1−1)/5 = 0 ≤ 0
    expect(stars.get('c1')).toBe('silver'); // (2−1)/5 = 0.2 > 0
    expect(stars.get('d1')).toBe('silver');
  });

  it('teams tied on icpcRank still get sequential filteredRanks (list position)', () => {
    // b1/c1 are an exact tie → both icpcRank 2, but filteredRank is the
    // 1-based POSITION in the candidate list, so they occupy 2 and 3.
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
    expect(snap.byTeam.get('b1')!.icpcRank).toBe(2);
    expect(snap.byTeam.get('c1')!.icpcRank).toBe(2);

    // siteScore 1, cutoff 1 → invited iff filteredRank ≤ 2.
    const stars = computeApacStars(
      snap,
      opts({ phase: 'final', championTeamId: 'x1', siteScore: 1, invitedScoreCutoff: 1 }),
    );
    expect(stars.get('x1')).toBe('gold'); // champion (position 1)
    expect(stars.get('b1')).toBe('gold'); // position 2: (2−1)/1 = 1 ≤ 1
    expect(stars.get('c1')).toBe('silver'); // position 3: 2 > 1
    expect(stars.get('d1')).toBe('silver'); // position 4: 3 > 1
  });
});

// ---------------------------------------------------------------------------
// Regression — 2025-26 Seoul: siteScore 68.98, invited cutoff 0.1838.
//
// Mirrors JustRebootJungsanghwa (부산대): its raw icpcRank is inflated by
// schoolRank ≥ 4 teams of large schools ranked above it, but its filteredRank
// is 13 → score (13−1)/68.98 ≈ 0.1740 ≤ 0.1838 → gold (matches
// icpcapac.solved.ac/2026). The next candidate (filteredRank 14) scores
// (14−1)/68.98 ≈ 0.1885 > cutoff → stays silver.
// ---------------------------------------------------------------------------

describe('computeApacStars — 2025-26 Seoul regression (siteScore 68.98, cutoff 0.1838)', () => {
  const SITE_SCORE = 68.98;
  const CUTOFF = 0.1838;

  /**
   * Standings (solve minute of p1 orders everything):
   *   ranks 1..6  — a1..a6 (school A): a1 champion; a4..a6 filtered out.
   *   ranks 7..15 — b1..b9 (nine single-team schools) → filteredRank 4..12.
   *   rank 16     — target (school T): filteredRank 13 (raw rank inflated
   *                 by a4..a6 above it).
   *   rank 17     — next (school U): filteredRank 14.
   */
  function seoulSnapshot(): Snapshot {
    const specs: TeamSpec[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i + 1}`, group: 'A' })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: `b${i + 1}`, group: `B${i + 1}` })),
      { id: 'target', group: 'T' },
      { id: 'next', group: 'U' },
    ];
    const order = [...Array.from({ length: 6 }, (_, i) => `a${i + 1}`),
      ...Array.from({ length: 9 }, (_, i) => `b${i + 1}`),
      'target',
      'next'];
    return computeStandings(
      makeContest(specs),
      order.map((id, i) => run(id, 'p1', 10 * (i + 1))),
    );
  }

  it('fixture sanity: raw rank 16 vs filteredRank 13 for the target team', () => {
    const snap = seoulSnapshot();
    expect(snap.byTeam.get('target')!.icpcRank).toBe(16);
    expect(snap.byTeam.get('next')!.icpcRank).toBe(17);
    expect(snap.byTeam.get('a4')!.schoolRank).toBe(4); // filtered out of the list
    // Raw rank would NOT have qualified: (16−1)/68.98 ≈ 0.2175 > 0.1838.
    expect((16 - 1) / SITE_SCORE).toBeGreaterThan(CUTOFF);
    // Filtered rank does: (13−1)/68.98 ≈ 0.1740 ≤ 0.1838.
    expect((13 - 1) / SITE_SCORE).toBeLessThanOrEqual(CUTOFF);
  });

  it('filteredRank 13 → gold, filteredRank 14 → silver', () => {
    const stars = computeApacStars(
      seoulSnapshot(),
      opts({
        phase: 'final',
        championTeamId: 'a1',
        siteScore: SITE_SCORE,
        invitedScoreCutoff: CUTOFF,
      }),
    );
    expect(stars.get('target')).toBe('gold'); // (13−1)/68.98 ≈ 0.1740
    expect(stars.get('next')).toBe('silver'); // (14−1)/68.98 ≈ 0.1885
    // Filtered-out large-school teams get no star at all.
    expect(stars.has('a4')).toBe(false);
    expect(stars.has('a5')).toBe(false);
    expect(stars.has('a6')).toBe(false);
  });

  it("champion's schoolmates keep bronze but still occupy filtered-rank slots", () => {
    const stars = computeApacStars(
      seoulSnapshot(),
      opts({
        phase: 'final',
        championTeamId: 'a1',
        siteScore: SITE_SCORE,
        invitedScoreCutoff: CUTOFF,
      }),
    );
    expect(stars.get('a1')).toBe('gold'); // champion
    // a2/a3 occupy filteredRank slots 2 and 3 (the target still lands on 13)
    // but are never promoted: WF takes one team per school.
    expect(stars.get('a2')).toBe('bronze');
    expect(stars.get('a3')).toBe('bronze');
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
