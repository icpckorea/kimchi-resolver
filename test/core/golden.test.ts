/**
 * Golden end-to-end test: real 2025 ICPC Seoul sample feed through the full
 * pipeline — spotboard adapter → feeder → standings — with invariants derived
 * independently from the raw JSON, plus a pinned top-10 snapshot.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSpotboardSource } from '@core/ingest/spotboard';
import { createRunFeeder } from '@core/feeder';
import { computeStandings } from '@core/standings';
import type { OrgsIndex, Snapshot } from '@core/types';

const ROOT = resolve(__dirname, '../..');
const contestJson = JSON.parse(
  readFileSync(resolve(ROOT, 'public/sample/contest.json'), 'utf8'),
);
const runsJson = JSON.parse(readFileSync(resolve(ROOT, 'public/sample/runs.json'), 'utf8'));
const orgs: OrgsIndex = JSON.parse(readFileSync(resolve(ROOT, 'public/orgs/orgs.json'), 'utf8'));

/** fetch stub serving the sample files from disk. */
const fetchStub = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.includes('contest.json') ? contestJson : url.includes('runs.json') ? runsJson : undefined;
  if (body === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

// --- Expectations derived independently from the raw JSON -------------------

interface RawRun {
  id: number;
  team: number;
  problem: number;
  result: string;
  submissionTime: number;
}

const rawRuns: RawRun[] = runsJson.runs;
const acceptedRuns = rawRuns.filter((r) => r.result === 'Yes');
/** Dedupe accepted runs per (team, problem) cell. */
const acceptedCellCount = new Set(acceptedRuns.map((r) => `${r.team} ${r.problem}`)).size;

const foreignGroups = new Set(
  Object.entries(orgs)
    .filter(([, entry]) => entry.country !== undefined && entry.country.toUpperCase() !== 'KR')
    .map(([group]) => group),
);

describe('golden: 2025 ICPC Seoul sample end-to-end', () => {
  let snapshot: Snapshot;

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
  });

  it('ranks exactly 84 teams', () => {
    expect(snapshot.standings).toHaveLength(84);
    expect(snapshot.byTeam.size).toBe(84);
    for (const s of snapshot.standings) {
      expect(s.icpcRank).toBeGreaterThanOrEqual(1);
      expect(s.icpcRank).toBeLessThanOrEqual(84);
    }
  });

  it('total solved equals the accepted runs deduped per cell (480 accepted runs)', () => {
    expect(acceptedRuns).toHaveLength(480);
    const totalSolved = snapshot.standings.reduce((sum, s) => sum + s.solved, 0);
    expect(totalSolved).toBe(acceptedCellCount);
    // Cross-check against the snapshot's own cells.
    let acceptedCellsInSnapshot = 0;
    for (const s of snapshot.standings) {
      for (const cell of s.cells.values()) {
        if (cell.verdict === 'accepted') acceptedCellsInSnapshot += 1;
      }
    }
    expect(acceptedCellsInSnapshot).toBe(acceptedCellCount);
  });

  it('rank 1 team has the maximum solved count', () => {
    const maxSolved = Math.max(...snapshot.standings.map((s) => s.solved));
    const rankOne = snapshot.standings[0];
    expect(rankOne.icpcRank).toBe(1);
    expect(rankOne.solved).toBe(maxSolved);
  });

  it('every foreign team (orgs country != KR) has domesticRank null', () => {
    const foreignTeams = snapshot.standings.filter((s) => foreignGroups.has(s.team.group));
    expect(foreignTeams.length).toBeGreaterThan(0);
    for (const s of foreignTeams) {
      expect(s.team.foreign).toBe(true);
      expect(s.domesticRank).toBeNull();
    }
    // And the converse: non-foreign teams all have a domestic rank.
    for (const s of snapshot.standings) {
      if (!foreignGroups.has(s.team.group)) {
        expect(s.team.foreign).toBe(false);
        expect(s.domesticRank).not.toBeNull();
      }
    }
  });

  it('contestFirstYes and contestLastYes are non-null', () => {
    expect(snapshot.contestFirstYes).not.toBeNull();
    expect(snapshot.contestLastYes).not.toBeNull();
  });

  it('matches the pinned top-10 snapshot (name, solved, penalty)', () => {
    const top10 = snapshot.standings
      .slice(0, 10)
      .map((s) => ({ name: s.team.name, solved: s.solved, penalty: s.penalty }));
    // Pinned from a verified run (cross-checked with an independent
    // computation from the raw JSON).
    const expected = [
      { name: 'Just use CRT', solved: 10, penalty: 1041 },
      { name: 'floorsum', solved: 10, penalty: 1085 },
      { name: 'AMATSUKAZE', solved: 10, penalty: 1095 },
      { name: 'DaiMonge', solved: 10, penalty: 1149 },
      { name: 'revoNTUlet', solved: 9, penalty: 933 },
      { name: 'Fox is cute', solved: 9, penalty: 988 },
      { name: 'Ssalhur', solved: 8, penalty: 742 },
      { name: 'ThirdHighSchool', solved: 8, penalty: 760 },
      { name: 'GENGFaker', solved: 8, penalty: 785 },
      { name: '20s', solved: 8, penalty: 790 },
    ];
    expect(top10).toEqual(expected);
  });
});
