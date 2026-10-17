import { describe, expect, it } from 'vitest';
import type { Contest, Problem, Run, Snapshot, Team } from '@core/types';
import { computeStandings } from '@core/standings';
import {
  computeApacFilteredRanks,
  computeSiteScore,
  countSiteInputs,
  simulateRegional,
  DEFAULT_SCHOOL_QUOTA,
  DEFAULT_SITE_SCORE_COEFFICIENTS,
  SUPER_REGION_COUNTRIES,
  WF_MEDAL_QUOTA,
  type SchoolQuota,
} from '@core/apac';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const PROBLEM_COUNT = 4;

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
  /** Problems solved; defaults to 1. */
  solved?: number;
  countryCode?: string;
  /** The domestic-rank flag (config.foreign); never used by the site score. */
  foreign?: boolean;
}

/**
 * Builds a snapshot from team specs listed in the intended standing order.
 * Each solving team solves p1..p{solved} at minute = list position + 1, so
 * with `solved` non-increasing the standing order is exactly the list order.
 */
function snapshotOf(specs: TeamSpec[]): Snapshot {
  const teams = new Map<string, Team>();
  for (const spec of specs) {
    teams.set(spec.id, {
      id: spec.id,
      name: `Team ${spec.id}`,
      group: spec.group,
      foreign: spec.foreign ?? false,
      ...(spec.countryCode !== undefined ? { countryCode: spec.countryCode } : {}),
    });
  }
  const contest: Contest = {
    title: 'APAC 2026-27 Fixture',
    systemName: 'fixture',
    systemVersion: '0',
    problems: makeProblems(),
    teams,
  };
  const runs: Run[] = [];
  let seq = 0;
  specs.forEach((spec, i) => {
    for (let p = 1; p <= (spec.solved ?? 1); p++) {
      seq++;
      runs.push({
        id: String(seq),
        teamId: spec.id,
        problemId: `p${p}`,
        minute: i + 1,
        verdict: 'accepted',
        penaltyCounts: false,
        seq,
      });
    }
  });
  return computeStandings(contest, runs);
}

function asObject<V>(map: Map<string, V>): Record<string, V> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

const DEFAULT_QUOTA: SchoolQuota = { base: DEFAULT_SCHOOL_QUOTA, wfMedalGroups: [] };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('APAC 2026-27 constants', () => {
  it('quota 2 per school, 3 for a WF medal school; AU and NZ are super-region', () => {
    expect(DEFAULT_SCHOOL_QUOTA).toBe(2);
    expect(WF_MEDAL_QUOTA).toBe(3);
    expect([...SUPER_REGION_COUNTRIES]).toEqual(['AU', 'NZ']);
  });

  it('default site score coefficients are 0.56, 0.24, 0.14, 0.06, 0.30', () => {
    expect(DEFAULT_SITE_SCORE_COEFFICIENTS).toEqual({
      regionalSchools: 0.56,
      regionalTeams: 0.24,
      prelimSchools: 0.14,
      prelimTeams: 0.06,
      foreignTeams: 0.3,
    });
  });
});

// ---------------------------------------------------------------------------
// Per-school quota (C2)
// ---------------------------------------------------------------------------

describe('computeApacFilteredRanks — 2026-27 school quota', () => {
  const specs: TeamSpec[] = [
    { id: 'a1', group: 'A' },
    { id: 'b1', group: 'B' },
    { id: 'a2', group: 'A' },
    { id: 'b2', group: 'B' },
    { id: 'a3', group: 'A' },
    { id: 'b3', group: 'B' },
    { id: 'c1', group: 'C' },
  ];

  it('default quota keeps 2 teams per school', () => {
    const ranks = computeApacFilteredRanks(snapshotOf(specs), { championTeamId: null });
    // a3 and b3 are each school's 3rd team → absent, and take no slot.
    expect(asObject(ranks)).toEqual({ a1: 1, b1: 2, a2: 3, b2: 4, c1: 5 });
  });

  it('a WF medal school keeps 3 (mixed with Q=2 schools)', () => {
    const ranks = computeApacFilteredRanks(snapshotOf(specs), {
      championTeamId: null,
      quota: { base: DEFAULT_SCHOOL_QUOTA, wfMedalGroups: ['A'] },
    });
    // A is a medal school (Q=3); B keeps 2.
    expect(asObject(ranks)).toEqual({ a1: 1, b1: 2, a2: 3, b2: 4, a3: 5, c1: 6 });
  });

  it('the quota counts only teams that survive the other rules', () => {
    // a1 solves nothing (rule: 0-solve out), so a2 and a3 are A's two slots.
    const snap = snapshotOf([
      { id: 'a2', group: 'A' },
      { id: 'a3', group: 'A' },
      { id: 'a4', group: 'A' },
      { id: 'a1', group: 'A', solved: 0 },
    ]);
    const ranks = computeApacFilteredRanks(snap, { championTeamId: null });
    expect(asObject(ranks)).toEqual({ a2: 1, a3: 2 });
  });

  it('every org-less team ("") is still its own school under the 2026-27 quota', () => {
    const snap = snapshotOf([
      { id: 'n1', group: '' },
      { id: 'n2', group: '' },
      { id: 'n3', group: '' },
    ]);
    const ranks = computeApacFilteredRanks(snap, { championTeamId: null });
    expect(asObject(ranks)).toEqual({ n1: 1, n2: 2, n3: 3 });
  });
});

// ---------------------------------------------------------------------------
// Super-region (D3 step 1)
// ---------------------------------------------------------------------------

describe('super-region teams', () => {
  const specs: TeamSpec[] = [
    { id: 'k1', group: 'K', countryCode: 'KR' },
    { id: 'au1', group: 'AUS', countryCode: 'AU' },
    { id: 'nz1', group: 'NZL', countryCode: 'NZ' },
    { id: 'k2', group: 'L', countryCode: 'KR' },
  ];

  it('super-region teams are removed from the list but counted in S', () => {
    const snap = snapshotOf(specs);
    const ranks = computeApacFilteredRanks(snap, { championTeamId: null });
    expect(asObject(ranks)).toEqual({ k1: 1, k2: 2 });

    const counts = countSiteInputs(snap);
    expect(counts).toEqual({ schools: 4, teams: 4, foreign: 2 });
  });

  it('superRegionCountries can be overridden (empty → nobody is removed)', () => {
    const ranks = computeApacFilteredRanks(snapshotOf(specs), {
      championTeamId: null,
      superRegionCountries: [],
    });
    expect(asObject(ranks)).toEqual({ k1: 1, au1: 2, nz1: 3, k2: 4 });
  });
});

// ---------------------------------------------------------------------------
// Site score inputs and formula (C1)
// ---------------------------------------------------------------------------

describe('countSiteInputs', () => {
  it('counts solving teams only, schools with ≥1 solving team, foreign = non-KR with a country code', () => {
    const snap = snapshotOf([
      { id: 'k1', group: 'K', countryCode: 'KR' },
      { id: 'k2', group: 'K', countryCode: 'KR' },
      { id: 'j1', group: 'J', countryCode: 'JP' },
      // No country code → domestic, even with the domestic-rank foreign flag.
      { id: 'u1', group: 'U', foreign: true },
      // A KR team flagged foreign for the domestic ranking is still not foreign here.
      { id: 'k3', group: 'M', countryCode: 'KR', foreign: true },
      // 0-solve teams: neither the team nor its otherwise-empty school counts.
      { id: 't1', group: 'T', countryCode: 'TW', solved: 0 },
      { id: 'k4', group: 'K', countryCode: 'KR', solved: 0 },
    ]);
    expect(countSiteInputs(snap)).toEqual({ schools: 4, teams: 5, foreign: 1 });
  });

  it('every solving org-less team ("") counts as its own school', () => {
    const snap = snapshotOf([
      { id: 'n1', group: '' },
      { id: 'n2', group: '' },
      { id: 'k1', group: 'K' },
    ]);
    expect(countSiteInputs(snap)).toEqual({ schools: 3, teams: 3, foreign: 0 });
  });

  it('an empty snapshot counts zero', () => {
    expect(countSiteInputs(snapshotOf([]))).toEqual({ schools: 0, teams: 0, foreign: 0 });
  });
});

describe('computeSiteScore', () => {
  it('computeSiteScore applies the formula', () => {
    const s = computeSiteScore({
      regional: { schools: 40, teams: 80, foreign: 5 },
      prelimSchools: 60,
      prelimTeams: 150,
      coefficients: DEFAULT_SITE_SCORE_COEFFICIENTS,
    });
    // 0.56·40 + 0.24·80 + 0.14·60 + 0.06·150 + 0.30·5 = 60.5
    expect(s).toBeCloseTo(60.5, 10);
  });

  it('uses the given coefficients', () => {
    const s = computeSiteScore({
      regional: { schools: 1, teams: 10, foreign: 100 },
      prelimSchools: 1000,
      prelimTeams: 10000,
      coefficients: {
        regionalSchools: 1,
        regionalTeams: 0,
        prelimSchools: 0,
        prelimTeams: 0,
        foreignTeams: 0.01,
      },
    });
    expect(s).toBeCloseTo(2, 10);
  });

  it('all inputs empty → 0', () => {
    const s = computeSiteScore({
      regional: { schools: 0, teams: 0, foreign: 0 },
      prelimSchools: 0,
      prelimTeams: 0,
      coefficients: DEFAULT_SITE_SCORE_COEFFICIENTS,
    });
    expect(s).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Regional simulation
// ---------------------------------------------------------------------------

describe('simulateRegional', () => {
  /** champ (school C) wins; t1..t5 are single-team schools → filteredRank 1..5. */
  function simSnapshot(): Snapshot {
    return snapshotOf([
      { id: 'champ', group: 'C' },
      { id: 'c2', group: 'C' },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `t${i + 1}`, group: `T${i + 1}` })),
      { id: 'zero', group: 'Z', solved: 0 },
    ]);
  }

  it('simulateRegional values are (R−1)/S and stars follow the cutoff', () => {
    const sim = simulateRegional(simSnapshot(), {
      siteScore: 10,
      cutoff: 0.2,
      quota: DEFAULT_QUOTA,
      alreadyInvited: null,
    });
    expect(sim.siteScore).toBe(10);
    // The champion (standings[0]) and its school take no slot.
    expect(asObject(sim.values)).toEqual({ t1: 0, t2: 0.1, t3: 0.2, t4: 0.3, t5: 0.4 });
    expect(sim.stars.get('champ')).toBe('gold');
    expect(sim.stars.has('c2')).toBe(false); // champion's schoolmate: out of the running
    expect(sim.stars.get('t3')).toBe('gold'); // 0.2 ≤ 0.2
    expect(sim.stars.get('t4')).toBe('silver'); // 0.3 > 0.2
    expect(sim.stars.has('zero')).toBe(false); // 0 solved
  });

  it('a null cutoff leaves gold to the champion only', () => {
    const sim = simulateRegional(simSnapshot(), {
      siteScore: 10,
      cutoff: null,
      quota: DEFAULT_QUOTA,
      alreadyInvited: null,
    });
    const gold = [...sim.stars.entries()].filter(([, t]) => t === 'gold').map(([id]) => id);
    expect(gold).toEqual(['champ']);
    expect(sim.values.size).toBe(5);
  });

  it('applies the quota and the excluded schools', () => {
    const snap = snapshotOf([
      { id: 'champ', group: 'C' },
      { id: 'a1', group: 'A' },
      { id: 'a2', group: 'A' },
      { id: 'a3', group: 'A' },
      { id: 'w1', group: 'W' },
      { id: 'b1', group: 'B' },
    ]);
    const sim = simulateRegional(snap, {
      siteScore: 4,
      cutoff: 0,
      quota: { base: DEFAULT_SCHOOL_QUOTA, wfMedalGroups: [] },
      alreadyInvited: { groups: ['W'] },
    });
    // a3 is over the Q=2 cap; W is a winner school elsewhere → out.
    expect(asObject(sim.values)).toEqual({ a1: 0, a2: 0.25, b1: 0.5 });
    expect(sim.stars.get('a1')).toBe('gold'); // value 0 ≤ cutoff 0
    expect(sim.stars.get('a2')).toBe('silver');
    expect(sim.stars.has('w1')).toBe(false); // school W is invited elsewhere
    expect(sim.stars.has('a3')).toBe(false); // over the Q=2 cap
  });

  it('simulateRegional with siteScore 0 returns no values and promotes nobody', () => {
    const sim = simulateRegional(simSnapshot(), {
      siteScore: 0,
      cutoff: 100,
      quota: DEFAULT_QUOTA,
      alreadyInvited: null,
    });
    expect(sim.siteScore).toBe(0);
    expect(sim.values.size).toBe(0);
    for (const value of sim.values.values()) expect(Number.isFinite(value)).toBe(true);
    // Only the champion is gold (settled by rule); the scored list stays silver.
    expect(sim.stars.get('champ')).toBe('gold');
    for (const id of ['t1', 't2', 't3', 't4', 't5']) expect(sim.stars.get(id)).toBe('silver');
  });

  it('a non-finite or negative site score is treated like 0', () => {
    for (const siteScore of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const sim = simulateRegional(simSnapshot(), {
        siteScore,
        cutoff: 100,
        quota: DEFAULT_QUOTA,
        alreadyInvited: null,
      });
      expect(sim.values.size).toBe(0);
      expect(sim.stars.get('t1')).toBe('silver');
    }
  });

  it('S = 0 from all-empty inputs on an all-0-solve board does not crash', () => {
    const snap = snapshotOf([
      { id: 'z1', group: 'Z1', solved: 0 },
      { id: 'z2', group: 'Z2', solved: 0 },
    ]);
    const counts = countSiteInputs(snap);
    const siteScore = computeSiteScore({
      regional: counts,
      prelimSchools: 0,
      prelimTeams: 0,
      coefficients: DEFAULT_SITE_SCORE_COEFFICIENTS,
    });
    expect(siteScore).toBe(0);
    const sim = simulateRegional(snap, {
      siteScore,
      cutoff: 0.5,
      quota: DEFAULT_QUOTA,
      alreadyInvited: null,
    });
    expect(sim.values.size).toBe(0);
  });

  it('an empty snapshot has no champion and no values', () => {
    const sim = simulateRegional(snapshotOf([]), {
      siteScore: 10,
      cutoff: 0.5,
      quota: DEFAULT_QUOTA,
      alreadyInvited: null,
    });
    expect(sim.values.size).toBe(0);
    expect(sim.stars.size).toBe(0);
  });

  it('super-region teams have no value', () => {
    const snap = snapshotOf([
      { id: 'champ', group: 'C', countryCode: 'KR' },
      { id: 'au1', group: 'AUS', countryCode: 'AU' },
      { id: 'k1', group: 'K', countryCode: 'KR' },
    ]);
    const sim = simulateRegional(snap, {
      siteScore: 10,
      cutoff: 0,
      quota: DEFAULT_QUOTA,
      alreadyInvited: null,
    });
    expect(asObject(sim.values)).toEqual({ k1: 0 });
    expect(sim.stars.has('au1')).toBe(false); // super-region: out of the list, no star
  });
});
