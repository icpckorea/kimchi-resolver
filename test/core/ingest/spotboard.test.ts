import { describe, it, expect } from 'vitest';
import { createSpotboardSource, type SpotboardSourceOptions } from '@core/ingest/spotboard';
import type { OrgsIndex } from '@core/types';

// --- Fixtures (2025 ICPC Seoul sample, via resolveJsonModule) ---------------

import sampleContest from '../../../public/sample/contest.json';
import sampleRuns from '../../../public/sample/runs.json';

const sampleOrgs: OrgsIndex = {
  KAIST: { country: 'KR', logo: 'kaist.png' },
  'Seoul National University': { country: 'KR' },
  'National Cheng-Chi University': { country: 'TW' },
};

// --- fetch stub -------------------------------------------------------------

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(resolver: (url: string) => unknown) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = resolver(url);
    if (body === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function makeSource(
  overrides: Partial<SpotboardSourceOptions> = {},
  resolver?: (url: string) => unknown,
) {
  const defaultResolver = (url: string) => {
    if (url.includes('contest.json')) return sampleContest;
    if (url.includes('runs.json')) return sampleRuns;
    return undefined;
  };
  const { impl, calls } = stubFetch(resolver ?? defaultResolver);
  const source = createSpotboardSource({
    apiBase: './sample/',
    fetchTimeout: 5000,
    excludeTeamIds: [],
    foreign: { ids: [], groups: [] },
    orgs: sampleOrgs,
    fetchImpl: impl,
    ...overrides,
  });
  return { source, calls };
}

// --- loadContest ------------------------------------------------------------

describe('createSpotboardSource#loadContest', () => {
  it('maps the 2025 sample contest.json with stringified ids', async () => {
    const { source } = makeSource();
    const contest = await source.loadContest();

    expect(contest.title).toBe('2025 ICPC Asia Seoul Regional Contest');
    expect(contest.systemName).toBe('DOMjudge');
    expect(contest.systemVersion).toBe('');
    expect(contest.problems).toHaveLength(13);
    expect(contest.teams.size).toBe(84);

    const first = contest.problems[0];
    expect(first).toEqual({
      id: '2229881430',
      label: 'A',
      title: 'Adventurer Dabi',
      color: 'lightblue',
      order: 0,
    });
    // Display order = input order.
    expect(contest.problems.map((p) => p.order)).toEqual([...contest.problems.keys()]);
    expect(contest.problems[12].label).toBe('M');

    const kaistTeam = contest.teams.get('6');
    expect(kaistTeam).toBeDefined();
    expect(kaistTeam!.name).toBe('Preforce');
    expect(kaistTeam!.group).toBe('KAIST');
  });

  it('falls back to the first character of the title when "name" is absent', async () => {
    const { source } = makeSource({}, (url) =>
      url.includes('contest.json')
        ? {
            title: 't',
            systemName: 's',
            systemVersion: 'v',
            problems: [{ id: 7, title: 'Zebra Crossing', color: 'red' }],
            teams: [],
          }
        : undefined,
    );
    const contest = await source.loadContest();
    expect(contest.problems[0].label).toBe('Z');
    expect(contest.problems[0].id).toBe('7');
  });

  it('parses "Name (Group)" only when the group field is absent', async () => {
    const { source } = makeSource({}, (url) =>
      url.includes('contest.json')
        ? {
            title: 't',
            systemName: 's',
            systemVersion: 'v',
            problems: [],
            teams: [
              { id: 1, name: 'Preforce (KAIST)' },
              { id: 2, name: 'Weird (Name)', group: 'Snu' },
              { id: 3, name: 'NoParens' },
            ],
          }
        : undefined,
    );
    const contest = await source.loadContest();
    expect(contest.teams.get('1')).toMatchObject({ name: 'Preforce', group: 'KAIST' });
    // group field present → name kept verbatim, no parsing.
    expect(contest.teams.get('2')).toMatchObject({ name: 'Weird (Name)', group: 'Snu' });
    // no parentheses and no group → empty group.
    expect(contest.teams.get('3')).toMatchObject({ name: 'NoParens', group: '' });
  });

  it('removes excluded teams entirely', async () => {
    const { source } = makeSource({ excludeTeamIds: ['6', '84'] });
    const contest = await source.loadContest();
    expect(contest.teams.size).toBe(82);
    expect(contest.teams.has('6')).toBe(false);
    expect(contest.teams.has('84')).toBe(false);
    expect(contest.teams.has('1')).toBe(true);
  });

  it('fills countryCode from orgs and derives foreign from country != KR', async () => {
    const { source } = makeSource();
    const contest = await source.loadContest();

    // KAIST → KR → domestic.
    expect(contest.teams.get('6')!.countryCode).toBe('KR');
    expect(contest.teams.get('6')!.foreign).toBe(false);
    // National Cheng-Chi University → TW → foreign.
    expect(contest.teams.get('5')!.countryCode).toBe('TW');
    expect(contest.teams.get('5')!.foreign).toBe(true);
    // Unknown org → no countryCode, not foreign.
    const unknownOrgTeam = contest.teams.get('1')!; // Kongju National University (not in orgs)
    expect(unknownOrgTeam.countryCode).toBeUndefined();
    expect(unknownOrgTeam.foreign).toBe(false);
  });

  it('lets config foreign ids/groups override orgs country (KR org forced foreign)', async () => {
    const { source } = makeSource({ foreign: { ids: ['6'], groups: ['Seoul National University'] } });
    const contest = await source.loadContest();

    // KAIST (KR by orgs) but id-listed → foreign.
    expect(contest.teams.get('6')!.foreign).toBe(true);
    expect(contest.teams.get('6')!.countryCode).toBe('KR'); // countryCode untouched
    // SNU (KR by orgs) but group-listed → every SNU team foreign.
    const snuTeams = [...contest.teams.values()].filter((t) => t.group === 'Seoul National University');
    expect(snuTeams.length).toBeGreaterThan(0);
    for (const team of snuTeams) expect(team.foreign).toBe(true);
  });

  it('throws on a non-ok response', async () => {
    const { source } = makeSource({}, () => undefined);
    await expect(source.loadContest()).rejects.toThrow(/404/);
  });
});

// --- fetchRuns --------------------------------------------------------------

describe('createSpotboardSource#fetchRuns', () => {
  it('requests runs.json?from=0 when no cursor is given', async () => {
    const { source, calls } = makeSource();
    await source.fetchRuns(null);
    expect(calls[0].url).toContain('runs.json?from=0');
  });

  it('passes the cursor through as ?from= and round-trips it', async () => {
    const { source, calls } = makeSource();
    const first = await source.fetchRuns(null);
    // Sample file: timestamp 0.
    expect(first.cursor).toBe(sampleRuns.time.timestamp);

    const { source: source2, calls: calls2 } = makeSource({}, (url) =>
      url.includes('runs.json')
        ? { time: { contestTime: 60, noMoreUpdate: false, timestamp: 987654 }, runs: [] }
        : undefined,
    );
    const result = await source2.fetchRuns(12345);
    expect(calls2[0].url).toContain('runs.json?from=12345');
    expect(result.cursor).toBe(987654);
    await source2.fetchRuns(result.cursor);
    expect(calls2[1].url).toContain('runs.json?from=987654');
    expect(calls.length).toBe(1);
  });

  it('normalizes the 2025 sample runs.json (1227 runs)', async () => {
    const { source } = makeSource();
    const result = await source.fetchRuns(null);

    expect(result.runs).toHaveLength(1227);
    expect(result.contestTimeSec).toBe(18000);
    expect(result.noMoreUpdate).toBe(false);

    const run = result.runs[0];
    expect(run).toEqual({
      id: '70',
      teamId: '56',
      problemId: '2632534615',
      minute: 6,
      verdict: 'failed',
      penaltyCounts: true,
      seq: 70,
    });
    const yes = result.runs[1];
    expect(yes.verdict).toBe('accepted');
    expect(yes.penaltyCounts).toBe(false);
  });

  it('normalizes verdicts: Yes / empty / Pending prefix / other', async () => {
    const { source } = makeSource({}, (url) =>
      url.includes('runs.json')
        ? {
            time: { contestTime: 600, noMoreUpdate: false, timestamp: 1 },
            runs: [
              { id: 1, team: 1, problem: 9, result: 'Yes', submissionTime: 10 },
              { id: 2, team: 1, problem: 9, result: '', submissionTime: 11 },
              { id: 3, team: 1, problem: 9, result: 'Pending - Judging', submissionTime: 12 },
              { id: 4, team: 1, problem: 9, result: 'No - Wrong Answer', submissionTime: 13 },
            ],
          }
        : undefined,
    );
    const { runs } = await source.fetchRuns(null);
    expect(runs.map((r) => r.verdict)).toEqual(['accepted', 'pending', 'pending', 'failed']);
    expect(runs.map((r) => r.penaltyCounts)).toEqual([false, false, false, true]);
  });

  it('parses string submissionTime (changed_runs.json quirk) and numeric alike', async () => {
    const { source } = makeSource({}, (url) =>
      url.includes('runs.json')
        ? {
            time: { contestTime: 600, noMoreUpdate: false, timestamp: 1 },
            runs: [
              { id: 1, team: 1, problem: 9, result: 'Yes', submissionTime: '34' },
              { id: 2, team: 1, problem: 9, result: 'Yes', submissionTime: 35 },
            ],
          }
        : undefined,
    );
    const { runs } = await source.fetchRuns(null);
    expect(runs[0].minute).toBe(34);
    expect(runs[1].minute).toBe(35);
  });

  it('uses the numeric run id as seq', async () => {
    const { source } = makeSource();
    const { runs } = await source.fetchRuns(null);
    for (const run of runs.slice(0, 20)) {
      expect(run.seq).toBe(Number(run.id));
      expect(Number.isFinite(run.seq)).toBe(true);
    }
  });

  it('treats absent noMoreUpdate as false (original bug fixed) and true as true', async () => {
    const make = (time: Record<string, unknown>) =>
      makeSource({}, (url) => (url.includes('runs.json') ? { time, runs: [] } : undefined)).source;

    expect((await make({ contestTime: 1, timestamp: 0 }).fetchRuns(null)).noMoreUpdate).toBe(false);
    expect(
      (await make({ contestTime: 1, timestamp: 0, noMoreUpdate: true }).fetchRuns(null)).noMoreUpdate,
    ).toBe(true);
    expect(
      (await make({ contestTime: 1, timestamp: 0, noMoreUpdate: false }).fetchRuns(null)).noMoreUpdate,
    ).toBe(false);
  });

  it('returns null contestTimeSec when absent or NaN', async () => {
    const make = (time: Record<string, unknown> | undefined) =>
      makeSource({}, (url) => (url.includes('runs.json') ? { time, runs: [] } : undefined)).source;

    expect((await make({ timestamp: 0 }).fetchRuns(null)).contestTimeSec).toBeNull();
    expect((await make({ contestTime: 'abc', timestamp: 0 }).fetchRuns(null)).contestTimeSec).toBeNull();
    expect((await make(undefined).fetchRuns(null)).contestTimeSec).toBeNull();
    // String-encoded number is tolerated.
    expect((await make({ contestTime: '120', timestamp: 0 }).fetchRuns(null)).contestTimeSec).toBe(120);
  });

  it('discards runs of excluded teams before the diff stage', async () => {
    const { source } = makeSource({ excludeTeamIds: ['56'] });
    const { runs } = await source.fetchRuns(null);
    expect(runs.some((r) => r.teamId === '56')).toBe(false);
    expect(runs.length).toBeLessThan(1227);
  });

  it('attaches an abort signal derived from fetchTimeout', async () => {
    const { source, calls } = makeSource({ fetchTimeout: 1234 });
    await source.fetchRuns(null);
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
