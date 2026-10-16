import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Contest, OrgsIndex, Problem, Run, Snapshot, Team, Verdict } from '@core/types';
import { computeStandings } from '@core/standings';
import { createSpotboardSource } from '@core/ingest/spotboard';
import {
  computeApacFilteredRanks,
  computeApacStars,
  APAC_SCHOOL_RANK_CAP,
  type ApacStarOptions,
  type SchoolQuota,
} from '@core/apac';

/**
 * The 2025-26 per-school cap (every school keeps 3). These tests pin the
 * 2025-26 behavior and the published Seoul list; the 2026-27 quota (2, or 3
 * for a WF medal school) is covered in apac-2026.test.ts.
 */
const QUOTA_2025_26: SchoolQuota = { base: 3, wfMedalGroups: [] };

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

/** Builds a snapshot whose standing order is exactly `order` (1 solve each). */
function snapshotOf(specs: TeamSpec[], order: string[]): Snapshot {
  return computeStandings(
    makeContest(specs),
    order.map((id, i) => run(id, 'p1', 10 * (i + 1))),
  );
}

/**
 * Standard fixture: three schools, ranks fully determined by the solve minute
 * of problem p1 (penalty = minute, all 1-solved) — except z1, which solves
 * nothing.
 *
 *   icpcRank 1: x1 (X)  schoolRank 1   filteredRank 1  ← champion in most tests
 *   icpcRank 2: x2 (X)  schoolRank 2
 *   icpcRank 3: y1 (Y)  schoolRank 1
 *   icpcRank 4: y2 (Y)  schoolRank 2
 *   icpcRank 5: x3 (X)  schoolRank 3
 *   icpcRank 6: y3 (Y)  schoolRank 3
 *   icpcRank 7: x4 (X)  schoolRank 4  ← beyond the per-school cap
 *   icpcRank 8: z1 (Z)  schoolRank 1  ← 0 solved
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
    quota: QUOTA_2025_26,
    ...partial,
  };
}

function asObject(map: Map<string, string | number>): Record<string, string | number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Ceremony phase — bronze for schoolRank ≤ 3 (unchanged by the filtering rules)
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

  it('ignores champion/siteScore/cutoff/alreadyInvited inputs in ceremony phase', () => {
    const stars = computeApacStars(
      fixtureSnapshot(),
      opts({
        championTeamId: 'x1',
        siteScore: 2,
        invitedScoreCutoff: 100,
        alreadyInvited: { groups: ['Y'] },
      }),
    );
    for (const tier of stars.values()) expect(tier).toBe('bronze');
    expect(stars.get('x1')).toBe('bronze');
    expect(stars.get('y1')).toBe('bronze');
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
// The scored list (spec §13 rule 3): who is in it, and at which position
// ---------------------------------------------------------------------------

describe('computeApacFilteredRanks — scored list construction', () => {
  it("drops the champion's whole school and every 0-solve team", () => {
    const ranks = computeApacFilteredRanks(fixtureSnapshot(), {
      quota: QUOTA_2025_26,
      championTeamId: 'x1',
    });
    // School X is gone entirely (champion school), z1 has 0 solves.
    expect(asObject(ranks)).toEqual({ y1: 1, y2: 2, y3: 3 });
  });

  it('keeps every school when there is no champion and no cross-site input', () => {
    const ranks = computeApacFilteredRanks(fixtureSnapshot(), {
      quota: QUOTA_2025_26,
      championTeamId: null,
    });
    // x4 (4th of school X) and z1 (0 solves) stay out; everyone else is in.
    expect(asObject(ranks)).toEqual({ x1: 1, x2: 2, y1: 3, y2: 4, x3: 5, y3: 6 });
  });

  it('removes a school named in alreadyInvited.groups, all of its teams', () => {
    const ranks = computeApacFilteredRanks(fixtureSnapshot(), {
      quota: QUOTA_2025_26,
      championTeamId: null,
      alreadyInvited: { groups: ['X'] },
    });
    expect(asObject(ranks)).toEqual({ y1: 1, y2: 2, y3: 3 });
  });

  it("removes the school of a team named in alreadyInvited.teamIds — the invited team's schoolmates included", () => {
    // y2 is invited elsewhere → y1/y2/y3 all leave the list; y2 takes no slot.
    const ranks = computeApacFilteredRanks(fixtureSnapshot(), {
      quota: QUOTA_2025_26,
      championTeamId: null,
      alreadyInvited: { teamIds: ['y2'] },
    });
    expect(asObject(ranks)).toEqual({ x1: 1, x2: 2, x3: 3 });
  });

  it('caps each school at 3 teams, counting only surviving teams', () => {
    // School A fields five teams; only the first three make the list, and the
    // 4th/5th do NOT push school B's teams down.
    const specs: TeamSpec[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i + 1}`, group: 'A' })),
      { id: 'b1', group: 'B' },
    ];
    const ranks = computeApacFilteredRanks(
      snapshotOf(specs, ['a1', 'a2', 'a3', 'a4', 'a5', 'b1']),
      { quota: QUOTA_2025_26, championTeamId: null },
    );
    expect(asObject(ranks)).toEqual({ a1: 1, a2: 2, a3: 3, b1: 4 });
  });

  it('foreign teams occupy slots normally (the 3-per-school cap is per site)', () => {
    const specs: TeamSpec[] = [
      { id: 'f1', group: 'F', foreign: true },
      { id: 'k1', group: 'K' },
      { id: 'f2', group: 'F', foreign: true },
      { id: 'k2', group: 'K' },
    ];
    const ranks = computeApacFilteredRanks(snapshotOf(specs, ['f1', 'k1', 'f2', 'k2']), {
      quota: QUOTA_2025_26,
      championTeamId: null,
    });
    expect(asObject(ranks)).toEqual({ f1: 1, k1: 2, f2: 3, k2: 4 });
  });

  it('treats an unknown organization ("") as not-a-school: it is never removed', () => {
    // The champion has no org. Only the champion itself leaves the list —
    // otherwise every org-less team would vanish at once.
    const specs: TeamSpec[] = [
      { id: 'n1', group: '' },
      { id: 'n2', group: '' },
      { id: 'k1', group: 'K' },
    ];
    const ranks = computeApacFilteredRanks(snapshotOf(specs, ['n1', 'n2', 'k1']), {
      quota: QUOTA_2025_26,
      championTeamId: 'n1',
    });
    expect(asObject(ranks)).toEqual({ n2: 1, k1: 2 });
  });

  it('gives every org-less team its own school: the 3-per-school cap never applies to ""', () => {
    // Five teams with an unknown organization plus one school of four. Sharing
    // a single '' budget would have dropped n4/n5 (and shifted every rank after
    // them); each org-less team is its own school, so only a4 is capped.
    const specs: TeamSpec[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `n${i + 1}`, group: '' })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i + 1}`, group: 'A' })),
    ];
    const order = ['n1', 'a1', 'n2', 'a2', 'n3', 'a3', 'n4', 'a4', 'n5'];
    const ranks = computeApacFilteredRanks(snapshotOf(specs, order), {
      quota: QUOTA_2025_26,
      championTeamId: null,
    });
    expect(asObject(ranks)).toEqual({
      n1: 1,
      a1: 2,
      n2: 3,
      a2: 4,
      n3: 5,
      a3: 6,
      // a4 is school A's 4th team → capped out, taking no slot.
      n4: 7,
      n5: 8,
    });
  });

  it('org-less teams still obey every other rule (0 solves out, invited team out, neighbours keep their slots)', () => {
    const contest = makeContest([
      { id: 'n1', group: '' },
      { id: 'n2', group: '' },
      { id: 'n3', group: '' },
      { id: 'n4', group: '' },
      { id: 'k1', group: 'K' },
    ]);
    const snap = computeStandings(contest, [
      run('n1', 'p1', 10),
      run('n2', 'p1', 20),
      run('n3', 'p1', 30),
      run('k1', 'p1', 40),
      // n4 solves nothing → last place.
    ]);
    const ranks = computeApacFilteredRanks(snap, {
      quota: QUOTA_2025_26,
      championTeamId: null,
      alreadyInvited: { teamIds: ['n2'] },
    });
    // n2 leaves by team id only — no school of org-less teams goes with it;
    // n4 leaves on 0 solves. n1/n3/k1 renumber over the survivors.
    expect(asObject(ranks)).toEqual({ n1: 1, n3: 2, k1: 3 });
  });

  it('does not mutate the snapshot and is deterministic', () => {
    const snap = fixtureSnapshot();
    const a = computeApacFilteredRanks(snap, { quota: QUOTA_2025_26, championTeamId: 'x1' });
    const b = computeApacFilteredRanks(snap, { quota: QUOTA_2025_26, championTeamId: 'x1' });
    expect(asObject(a)).toEqual(asObject(b));
    expect([...a.keys()]).toEqual([...b.keys()]);
  });
});

// ---------------------------------------------------------------------------
// Final phase — gold invited, silver scored list, bronze the rest
// ---------------------------------------------------------------------------

describe('computeApacStars — final phase', () => {
  it("champion gold, champion's schoolmates bronze, the scored list silver", () => {
    const stars = computeApacStars(
      fixtureSnapshot(),
      opts({ phase: 'final', championTeamId: 'x1' }),
    );
    expect(asObject(stars)).toEqual({
      x1: 'gold', // champion — World Finals direct entry
      x2: 'bronze', // champion's school is out of the running entirely…
      x3: 'bronze', // …but both are still 학내 3등 이내
      y1: 'silver',
      y2: 'silver',
      y3: 'silver',
      z1: 'bronze', // 0 solved → excluded from the scored list
    });
    expect(stars.has('x4')).toBe(false); // schoolRank 4 → no star at all
  });

  it('gives every already-invited team gold and its schoolmates bronze', () => {
    const stars = computeApacStars(
      fixtureSnapshot(),
      opts({ phase: 'final', championTeamId: 'x1', alreadyInvited: { teamIds: ['y2'] } }),
    );
    expect(asObject(stars)).toEqual({
      x1: 'gold',
      x2: 'bronze',
      x3: 'bronze',
      y1: 'bronze', // school Y already has an invited team → out of the running
      y2: 'gold', // the invited team itself
      y3: 'bronze',
      z1: 'bronze',
    });
  });

  it('an alreadyInvited group with no invited team present still empties the school', () => {
    // Only the school name is known (its invited team competed elsewhere):
    // nobody from school Y is gold, and nobody is a candidate either.
    const stars = computeApacStars(
      fixtureSnapshot(),
      opts({ phase: 'final', championTeamId: 'x1', alreadyInvited: { groups: ['Y'] } }),
    );
    expect(stars.get('y1')).toBe('bronze');
    expect(stars.get('y2')).toBe('bronze');
    expect(stars.get('y3')).toBe('bronze');
    expect(stars.get('z1')).toBe('bronze'); // 0 solved
  });

  it('with championTeamId null and no invitations, every scored team is silver', () => {
    const stars = computeApacStars(fixtureSnapshot(), opts({ phase: 'final' }));
    expect(asObject(stars)).toEqual({
      x1: 'silver',
      x2: 'silver',
      x3: 'silver',
      y1: 'silver',
      y2: 'silver',
      y3: 'silver',
      z1: 'bronze', // 0 solved is excluded regardless of the champion
    });
  });
});

// ---------------------------------------------------------------------------
// Publish promotion — (filteredRank − 1) / siteScore ≤ invitedScoreCutoff
// ---------------------------------------------------------------------------

describe('computeApacStars — invited-score promotion (filteredRank)', () => {
  const finalOpts = (siteScore: number | null, invitedScoreCutoff: number | null) =>
    opts({ phase: 'final', championTeamId: 'x1', siteScore, invitedScoreCutoff });

  it('promotes teams at or below the cutoff (boundary is ≤, inclusive)', () => {
    // School X is out (champion), z1 has 0 solves → the list is y1,y2,y3.
    // siteScore 2, cutoff 1 → invited iff (filteredRank − 1)/2 ≤ 1 ⇔ fr ≤ 3.
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, 1));
    expect(stars.get('x1')).toBe('gold'); // champion, no slot
    expect(stars.get('y1')).toBe('gold'); // fr 1 → 0
    expect(stars.get('y2')).toBe('gold'); // fr 2 → 0.5
    expect(stars.get('y3')).toBe('gold'); // fr 3 → 1 — exactly the cutoff
  });

  it('leaves the first team past the cutoff silver', () => {
    // siteScore 2, cutoff 0.4 → invited iff fr ≤ 1.8 ⇔ fr = 1.
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, 0.4));
    expect(stars.get('y1')).toBe('gold'); // fr 1 → 0 ≤ 0.4
    expect(stars.get('y2')).toBe('silver'); // fr 2 → 0.5 > 0.4
    expect(stars.get('y3')).toBe('silver');
  });

  it('never promotes bronze — invited schools and 0-solve teams stay bronze', () => {
    // A cutoff large enough to promote everything still leaves them bronze.
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, 100));
    expect(stars.get('x2')).toBe('bronze'); // champion's schoolmate
    expect(stars.get('x3')).toBe('bronze');
    expect(stars.get('z1')).toBe('bronze'); // 0 solved
    expect(stars.get('y3')).toBe('gold');
  });

  it("removing the champion's school lifts everyone below it", () => {
    // Without rule 1 the champion's school would occupy slots 1..3 and y1
    // would be fr 4 (score 1.5 > 1 → silver). It is fr 1 instead.
    const stars = computeApacStars(fixtureSnapshot(), finalOpts(2, 1));
    expect(stars.get('y1')).toBe('gold');
    const ranks = computeApacFilteredRanks(fixtureSnapshot(), {
      quota: QUOTA_2025_26,
      championTeamId: 'x1',
    });
    expect(ranks.get('y1')).toBe(1);
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

  it('cutoff 0 promotes only the filteredRank-1 team', () => {
    const snap = snapshotOf(
      [
        { id: 'b1', group: 'B' },
        { id: 'c1', group: 'C' },
        { id: 'd1', group: 'D' },
      ],
      ['b1', 'c1', 'd1'],
    );
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
    // 1-based POSITION in the scored list, so they occupy 1 and 2 (the
    // champion's school X is gone).
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
    expect(stars.get('x1')).toBe('gold'); // champion
    expect(stars.get('b1')).toBe('gold'); // position 1: 0 ≤ 1
    expect(stars.get('c1')).toBe('gold'); // position 2: (2−1)/1 = 1 ≤ 1
    expect(stars.get('d1')).toBe('silver'); // position 3: 2 > 1
  });
});

// ---------------------------------------------------------------------------
// Regression — 2025-26 Seoul: siteScore 68.98, invited cutoff 0.1838.
//
// Reproduces the published list (icpcapac.solved.ac/2026) shape through the
// corrected pipeline: the champion's school (SNU) and one cross-site invited
// school (NTU, invited at Manila/Jakarta) are removed whole, 0-solve teams are
// dropped, and every remaining school keeps its top 3. Just Reboot
// JungSangHwa (부산대) lands on filteredRank 13 → (13−1)/68.98 ≈ 0.1740 ≤
// 0.1838 → gold; filteredRank 14 (0.1885) is the first team past the cutoff.
// ---------------------------------------------------------------------------

describe('computeApacStars — 2025-26 Seoul regression (siteScore 68.98, cutoff 0.1838)', () => {
  const SITE_SCORE = 68.98;
  const CUTOFF = 0.1838;

  /**
   * Standing order (solve minute of p1 orders everything):
   *   snu1..snu3  — the champion's school, removed whole (snu1 = champion).
   *   ntu1, ntu2  — invited at another regional, removed whole (ntu1 named).
   *   f1..f12     — twelve single-team schools → filteredRank 1..12.
   *   target (T)  — filteredRank 13.
   *   next (U)    — filteredRank 14.
   *   zero (V)    — 0 solved, no slot (mirrors the published list ending at a
   *                 1-solve team).
   */
  function seoulSnapshot(): Snapshot {
    const specs: TeamSpec[] = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `snu${i + 1}`, group: 'SNU' })),
      { id: 'ntu1', group: 'NTU', foreign: true },
      { id: 'ntu2', group: 'NTU', foreign: true },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `f${i + 1}`, group: `F${i + 1}` })),
      { id: 'target', group: 'T' },
      { id: 'next', group: 'U' },
      { id: 'zero', group: 'V' },
    ];
    const order = [
      'snu1',
      'snu2',
      'ntu1',
      'snu3',
      'ntu2',
      ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
      'target',
      'next',
      // 'zero' solves nothing.
    ];
    return computeStandings(
      makeContest(specs),
      order.map((id, i) => run(id, 'p1', 10 * (i + 1))),
    );
  }

  const seoulOpts = () =>
    opts({
      phase: 'final',
      championTeamId: 'snu1',
      siteScore: SITE_SCORE,
      invitedScoreCutoff: CUTOFF,
      alreadyInvited: { teamIds: ['ntu1'] },
    });

  it('fixture sanity: raw rank 18 vs filteredRank 13 for the target team', () => {
    const snap = seoulSnapshot();
    expect(snap.byTeam.get('target')!.icpcRank).toBe(18);
    expect(snap.byTeam.get('next')!.icpcRank).toBe(19);
    // Raw rank would NOT have qualified: (18−1)/68.98 ≈ 0.2464 > 0.1838.
    expect((18 - 1) / SITE_SCORE).toBeGreaterThan(CUTOFF);
    // Filtered rank does: (13−1)/68.98 ≈ 0.1740 ≤ 0.1838.
    expect((13 - 1) / SITE_SCORE).toBeLessThanOrEqual(CUTOFF);
    expect((14 - 1) / SITE_SCORE).toBeGreaterThan(CUTOFF);
  });

  it('the scored list drops both invited schools and the 0-solve team', () => {
    const ranks = computeApacFilteredRanks(seoulSnapshot(), {
      quota: QUOTA_2025_26,
      championTeamId: 'snu1',
      alreadyInvited: { teamIds: ['ntu1'] },
    });
    expect(ranks.size).toBe(14);
    expect(ranks.get('target')).toBe(13);
    expect(ranks.get('next')).toBe(14);
    for (const id of ['snu1', 'snu2', 'snu3', 'ntu1', 'ntu2', 'zero']) {
      expect(ranks.has(id)).toBe(false);
    }
  });

  it('filteredRank 13 → gold (0.1740), filteredRank 14 → silver (0.1885)', () => {
    const stars = computeApacStars(seoulSnapshot(), seoulOpts());
    expect(stars.get('target')).toBe('gold');
    expect(stars.get('next')).toBe('silver');
  });

  it('both invited teams are gold and their schoolmates are bronze, never promoted', () => {
    const stars = computeApacStars(seoulSnapshot(), seoulOpts());
    expect(stars.get('snu1')).toBe('gold'); // champion
    expect(stars.get('ntu1')).toBe('gold'); // invited at another regional
    expect(stars.get('snu2')).toBe('bronze');
    expect(stars.get('snu3')).toBe('bronze');
    expect(stars.get('ntu2')).toBe('bronze');
    expect(stars.get('zero')).toBe('bronze'); // 0 solved
  });

  it('forgetting the cross-site invitation pushes the target past the cutoff (optimistic ranks)', () => {
    // Without alreadyInvited, NTU keeps two slots → target slides to 15.
    const ranks = computeApacFilteredRanks(seoulSnapshot(), {
      quota: QUOTA_2025_26,
      championTeamId: 'snu1',
    });
    expect(ranks.get('target')).toBe(15);
    const stars = computeApacStars(
      seoulSnapshot(),
      opts({
        phase: 'final',
        championTeamId: 'snu1',
        siteScore: SITE_SCORE,
        invitedScoreCutoff: CUTOFF,
      }),
    );
    expect(stars.get('target')).toBe('silver'); // (15−1)/68.98 ≈ 0.2030 > cutoff
  });
});

// ---------------------------------------------------------------------------
// Published-list reproduction on the real 2025-26 Seoul data (public/sample).
//
// The scored list published at icpcapac.solved.ac/2026 has 58 rows. Feeding
// the bundled sample feed through the same pipeline must reproduce it: the
// champion's school (Seoul National University) and National Taiwan University
// (invited at Manila/Jakarta) are removed whole, 0-solve teams are dropped,
// and every school keeps its top 3.
// ---------------------------------------------------------------------------

describe('computeApacFilteredRanks — published 2025-26 Seoul list', () => {
  const SITE_SCORE = 68.98;
  const CUTOFF = 0.1838;
  /** Not derivable from the feed — the cross-site invitation config input. */
  const NTU = 'National Taiwan University';

  const publicDir = path.resolve(__dirname, '../../public');
  const readJson = (rel: string): unknown =>
    JSON.parse(fs.readFileSync(path.join(publicDir, rel), 'utf8'));

  async function sampleSnapshot(): Promise<Snapshot> {
    const files: Record<string, unknown> = {
      'contest.json': readJson('sample/contest.json'),
      'runs.json': readJson('sample/runs.json'),
    };
    const source = createSpotboardSource({
      apiBase: './sample/',
      fetchTimeout: 5000,
      excludeTeamIds: [],
      foreign: { ids: [], groups: [] },
      orgs: readJson('orgs/orgs.json') as OrgsIndex,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const name = String(input).split('?')[0].split('/').pop() as string;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => files[name],
        } as Response;
      }) as typeof fetch,
    });
    const contest = await source.loadContest();
    const { runs } = await source.fetchRuns(null);
    return computeStandings(contest, runs);
  }

  it('produces exactly 58 scored rows, matching the published head and tail', async () => {
    const snapshot = await sampleSnapshot();
    const champion = snapshot.standings[0]!;
    expect(champion.team.name).toBe('Just use CRT');
    expect(champion.team.group).toBe('Seoul National University');

    const ranks = computeApacFilteredRanks(snapshot, {
      quota: QUOTA_2025_26,
      championTeamId: champion.team.id,
      alreadyInvited: { groups: [NTU] },
    });
    expect(ranks.size).toBe(58);

    const nameAt = (rank: number): string => {
      for (const [teamId, r] of ranks) {
        if (r === rank) return snapshot.byTeam.get(teamId)!.team.name;
      }
      return '(missing)';
    };
    // Published rows 1-4 and the last row (58 = a 1-solve team).
    expect(nameAt(1)).toBe('AMATSUKAZE');
    expect(nameAt(2)).toBe('DaiMonge');
    expect(nameAt(3)).toBe('Fox is cute');
    expect(nameAt(4)).toBe('Magical Fish');
    expect(nameAt(58)).toBe('RASP');

    // No Seoul National University or NTU team takes a slot.
    for (const [teamId] of ranks) {
      const group = snapshot.byTeam.get(teamId)!.team.group;
      expect(group).not.toBe('Seoul National University');
      expect(group).not.toBe(NTU);
    }
  });

  it('puts Just Reboot JungSangHwa on filteredRank 13 → 0.1740 ≤ 0.1838 → gold', async () => {
    const snapshot = await sampleSnapshot();
    const champion = snapshot.standings[0]!;
    const target = snapshot.standings.find((s) => s.team.name === 'Just Reboot JungSangHwa')!;
    expect(target.team.group).toBe('Pusan National University');

    const ranks = computeApacFilteredRanks(snapshot, {
      quota: QUOTA_2025_26,
      championTeamId: champion.team.id,
      alreadyInvited: { groups: [NTU] },
    });
    expect(ranks.get(target.team.id)).toBe(13);
    expect((13 - 1) / SITE_SCORE).toBeCloseTo(0.174, 4);

    const stars = computeApacStars(snapshot, {
      quota: QUOTA_2025_26,
      phase: 'final',
      championTeamId: champion.team.id,
      siteScore: SITE_SCORE,
      invitedScoreCutoff: CUTOFF,
      alreadyInvited: { groups: [NTU] },
    });
    expect(stars.get(target.team.id)).toBe('gold');
    expect(stars.get(champion.team.id)).toBe('gold');
    // filteredRank 14 is the first team past the cutoff (0.1885 > 0.1838).
    const next = [...ranks.entries()].find(([, r]) => r === 14)![0];
    expect(stars.get(next)).toBe('silver');
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
    computeApacStars(
      snap,
      opts({
        phase: 'final',
        championTeamId: 'x1',
        siteScore: 2,
        invitedScoreCutoff: 5,
        alreadyInvited: { teamIds: ['y1'], groups: ['Z'] },
      }),
    );
    const after = snap.standings.map((s) => ({ ...s, cells: undefined, autoLabels: undefined }));
    expect(after).toEqual(before);
  });
});
