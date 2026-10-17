/**
 * Published-reality test for the APAC filtered list (spec §13).
 *
 * Ground truth: the ICPC APAC Championship 2025-26 site list published at
 * icpcapac.solved.ac/2026 for Seoul. It has 59 rows: 58 numbered slots plus
 * one un-numbered row (the champion, "Just use CRT" of Seoul National
 * University), which is displayed for reference but occupies NO slot.
 *
 * This test runs public/sample/{contest,runs}.json through the real pipeline
 * (spotboard adapter → feeder → standings) and asserts that
 * `computeApacFilteredRanks` reproduces those 58 rows EXACTLY: same order,
 * same 1-based slot number, and same score to 4 decimals.
 *
 * Published numbers are copied in below as a literal fixture on purpose — the
 * test must not depend on any scratch file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSpotboardSource } from '@core/ingest/spotboard';
import { createRunFeeder } from '@core/feeder';
import { computeStandings } from '@core/standings';
import { computeApacFilteredRanks, computeApacStars } from '@core/apac';
import type { AlreadyInvited, SchoolQuota } from '@core/apac';
import type { OrgsIndex, Snapshot } from '@core/types';

const ROOT = resolve(__dirname, '../..');
const contestJson = JSON.parse(
  readFileSync(resolve(ROOT, 'public/sample/contest.json'), 'utf8'),
);
const runsJson = JSON.parse(readFileSync(resolve(ROOT, 'public/sample/runs.json'), 'utf8'));
const orgs: OrgsIndex = JSON.parse(readFileSync(resolve(ROOT, 'public/orgs/orgs.json'), 'utf8'));

/** fetch stub serving the sample files from disk (same shape as golden.test.ts). */
const fetchStub = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.includes('contest.json')
    ? contestJson
    : url.includes('runs.json')
      ? runsJson
      : undefined;
  if (body === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

/** Published values for the Seoul site (2025-26). */
const SITE_SCORE = 68.98;
const INVITED_SCORE_CUTOFF = 0.1838;
/** The 2025-26 per-school cap: every school keeps its top 3. */
const QUOTA_2025_26: SchoolQuota = { base: 3, wfMedalGroups: [] };

/**
 * Schools that already held an APAC invitation from another regional.
 * Derived from the published list: a school present in contest.json with ZERO
 * published rows was invited elsewhere. Of the 51 schools at Seoul, exactly
 * three are absent from the list — Kangwon National University and Chosun
 * University (0 solves, excluded by rule 2) and National Taiwan University,
 * whose teams were invited at Manila/Jakarta. Seoul National University needs
 * no entry here: it is covered by the champion rule (B1).
 */
const ALREADY_INVITED: AlreadyInvited = {
  teamIds: [],
  groups: ['National Taiwan University'],
};

/** Published 58 numbered rows: [sitenum, score (4 decimals), team name]. */
const PUBLISHED: readonly (readonly [number, string, string])[] = [
  [1, '0.0000', 'AMATSUKAZE'],
  [2, '0.0145', 'DaiMonge'],
  [3, '0.0290', 'Fox is cute'],
  [4, '0.0435', 'Magical Fish'],
  [5, '0.0580', 'junhoLover'],
  [6, '0.0725', 'SEVERANCE'],
  [7, '0.0870', 'NTNU_2beatdown'],
  [8, '0.1015', 'NJG'],
  [9, '0.1160', 'UmJongNo'],
  [10, '0.1305', 'SMALLSHOT'],
  [11, '0.1450', '2 3 5 8 14'],
  [12, '0.1595', 'Endgame'],
  [13, '0.1740', 'Just Reboot JungSangHwa'],
  [14, '0.1885', 'Memoria'],
  [15, '0.2030', '541'],
  [16, '0.2175', 'finimage'],
  [17, '0.2320', 'ConSpirito'],
  [18, '0.2464', 'goraani'],
  [19, '0.2609', 'Delusion'],
  [20, '0.2754', 'PIMM'],
  [21, '0.2899', 'Kpop Ssal Hunters'],
  [22, '0.3044', 'Greenbelt'],
  [23, '0.3189', 'Seoulved AC'],
  [24, '0.3334', 'AwesomeTeamNameV2'],
  [25, '0.3479', 'GeongongiIsMae'],
  [26, '0.3624', 'NaNiGaSuKi'],
  [27, '0.3769', 'junhaLover'],
  [28, '0.3914', 'Three Sigma'],
  [29, '0.4059', 'ProofByAC'],
  [30, '0.4204', 'kumayuC'],
  [31, '0.4349', 'TBNTB'],
  [32, '0.4494', 'HwangGyoseon'],
  [33, '0.4639', 'TwoMinuteSearch'],
  [34, '0.4784', 'Marttians'],
  [35, '0.4929', 'ATRI'],
  [36, '0.5074', 'REREREAD'],
  [37, '0.5219', 'ANA'],
  [38, '0.5364', 'MSG'],
  [39, '0.5509', 'Team ALGOS'],
  [40, '0.5654', 'kim hu ha'],
  [41, '0.5799', '1st'],
  [42, '0.5944', 'hambugihambook'],
  [43, '0.6089', '1Che0ngDam'],
  [44, '0.6234', 'BEXCOTour'],
  [45, '0.6379', 'TeamKoala'],
  [46, '0.6524', 'isSnakeCase'],
  [47, '0.6669', 'Make ChAOS Great Again'],
  [48, '0.6814', 'HahahahahaHiarc'],
  [49, '0.6959', 'JKK 22'],
  [50, '0.7104', 'OlympicJeongSin'],
  [51, '0.7248', 'Solutio'],
  [52, '0.7393', 'CAPS'],
  [53, '0.7538', 'KimChangKimchi'],
  [54, '0.7683', 'stoi'],
  [55, '0.7828', 'I am Who'],
  [56, '0.7973', 'CatBoost'],
  [57, '0.8118', 'La Mer'],
  [58, '0.8263', 'RASP'],
];

/** The single un-numbered published row: shown, but holding no slot. */
const PUBLISHED_NO_SLOT = ['Just use CRT'];

describe('APAC filtered list reproduces the published 2025-26 Seoul list', () => {
  let snapshot: Snapshot;
  let championTeamId: string;

  beforeAll(async () => {
    const source = createSpotboardSource({
      apiBase: './sample/',
      fetchTimeout: 5000,
      excludeTeamIds: [],
      foreign: { ids: [], groups: [] },
      orgs,
      fetchImpl: fetchStub,
    });
    const contest = await source.loadContest();
    const feeder = createRunFeeder(contest);
    feeder.ingest(await source.fetchRuns(null));
    feeder.feedAll();
    snapshot = computeStandings(contest, feeder.appliedRuns);
    championTeamId = snapshot.standings[0].team.id;
  });

  it('team names are unique, so name-keyed comparison is exact', () => {
    const names = new Set(snapshot.standings.map((s) => s.team.name));
    expect(names.size).toBe(snapshot.standings.length);
  });

  it('the champion is Seoul National University "Just use CRT"', () => {
    expect(snapshot.standings[0].team.name).toBe(PUBLISHED_NO_SLOT[0]);
    expect(snapshot.standings[0].team.group).toBe('Seoul National University');
  });

  it('matches all 58 published rows: order, sitenum and 4-decimal score', () => {
    const ranks = computeApacFilteredRanks(snapshot, {
      quota: QUOTA_2025_26,
      championTeamId,
      alreadyInvited: ALREADY_INVITED,
    });

    // Rebuild the published table from the snapshot: standing order, keeping
    // only teams that hold a slot.
    const actual = snapshot.standings
      .filter((s) => ranks.has(s.team.id))
      .map((s) => {
        const filteredRank = ranks.get(s.team.id) as number;
        return [filteredRank, ((filteredRank - 1) / SITE_SCORE).toFixed(4), s.team.name] as const;
      });

    expect(actual).toHaveLength(58);
    expect(actual).toEqual(PUBLISHED);
  });

  it('the champion is displayed but holds no slot', () => {
    const ranks = computeApacFilteredRanks(snapshot, {
      quota: QUOTA_2025_26,
      championTeamId,
      alreadyInvited: ALREADY_INVITED,
    });
    expect(ranks.has(championTeamId)).toBe(false);

    const stars = computeApacStars(snapshot, {
      quota: QUOTA_2025_26,
      phase: 'final',
      championTeamId,
      alreadyInvited: ALREADY_INVITED,
      siteScore: SITE_SCORE,
      invitedScoreCutoff: INVITED_SCORE_CUTOFF,
    });
    expect(stars.get(championTeamId)).toBe('gold');
  });

  it('every other Seoul National University team is off the list entirely', () => {
    const ranks = computeApacFilteredRanks(snapshot, {
      quota: QUOTA_2025_26,
      championTeamId,
      alreadyInvited: ALREADY_INVITED,
    });
    const snu = snapshot.standings.filter((s) => s.team.group === 'Seoul National University');
    expect(snu.length).toBe(13);
    for (const s of snu) expect(ranks.has(s.team.id)).toBe(false);
  });

  it('National Taiwan University holds zero rows (invited at another regional)', () => {
    const ranks = computeApacFilteredRanks(snapshot, {
      quota: QUOTA_2025_26,
      championTeamId,
      alreadyInvited: ALREADY_INVITED,
    });
    const ntu = snapshot.standings.filter((s) => s.team.group === 'National Taiwan University');
    expect(ntu.length).toBeGreaterThan(0);
    for (const s of ntu) expect(ranks.has(s.team.id)).toBe(false);
  });

  it('0-solve teams are excluded; the last slot (58) is a 1-solve team', () => {
    const ranks = computeApacFilteredRanks(snapshot, {
      quota: QUOTA_2025_26,
      championTeamId,
      alreadyInvited: ALREADY_INVITED,
    });
    const zeroSolve = snapshot.standings.filter((s) => s.solved === 0);
    expect(zeroSolve.length).toBeGreaterThan(0);
    for (const s of zeroSolve) expect(ranks.has(s.team.id)).toBe(false);

    const last = snapshot.standings.find((s) => ranks.get(s.team.id) === 58);
    expect(last?.solved).toBe(1);
  });

  it('the cutoff promotes exactly filteredRank 1..13 to gold (plus the champion)', () => {
    const ranks = computeApacFilteredRanks(snapshot, {
      quota: QUOTA_2025_26,
      championTeamId,
      alreadyInvited: ALREADY_INVITED,
    });
    const stars = computeApacStars(snapshot, {
      quota: QUOTA_2025_26,
      phase: 'final',
      championTeamId,
      alreadyInvited: ALREADY_INVITED,
      siteScore: SITE_SCORE,
      invitedScoreCutoff: INVITED_SCORE_CUTOFF,
    });

    for (const s of snapshot.standings) {
      const filteredRank = ranks.get(s.team.id);
      if (filteredRank === undefined) continue;
      expect(stars.get(s.team.id)).toBe(filteredRank <= 13 ? 'gold' : 'silver');
    }

    // Spec §13 worked example: Just Reboot JungSangHwa (Pusan National U) is
    // filteredRank 13 → (13−1)/68.98 = 0.1740 ≤ 0.1838 → qualifies.
    const pusan = snapshot.standings.find((s) => s.team.name === 'Just Reboot JungSangHwa');
    expect(pusan).toBeDefined();
    expect(ranks.get((pusan as NonNullable<typeof pusan>).team.id)).toBe(13);
    expect(stars.get((pusan as NonNullable<typeof pusan>).team.id)).toBe('gold');

    const goldCount = [...stars.values()].filter((tier) => tier === 'gold').length;
    expect(goldCount).toBe(14);
  });
});
