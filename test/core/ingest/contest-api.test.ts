import { describe, it, expect } from 'vitest';
import {
  createContestApiSource,
  contestTimeToMinute,
  iso3ToAlpha2,
  type ContestApiSourceOptions,
} from '@core/ingest/contest-api';
import type { OrgsIndex } from '@core/types';

// --- Fixtures (shapes follow ccs-specs Contest API examples) ----------------

const BASE = 'https://judge.example.org/api';
const CONTEST_ID = 'seoul25';
const ROOT = `${BASE}/contests/${CONTEST_ID}`;

const ccsContest = {
  id: CONTEST_ID,
  name: 'Seoul Regional',
  formal_name: '2025 ICPC Asia Seoul Regional Contest',
  start_time: '2025-11-22T10:00:00+09:00',
  duration: '5:00:00',
  penalty_time: 20,
};

// Deliberately out of ordinal order to exercise sorting.
const ccsProblems = [
  { id: 'badge', label: 'B', name: 'Badge Relay', ordinal: 1, rgb: '#000000', color: 'black' },
  { id: 'adv', label: 'A', name: 'Adventurer Dabi', ordinal: 0, rgb: '#ADD8E6', color: 'lightblue' },
];

const ccsOrganizations = [
  { id: 'kaist', icpc_id: '1', name: 'KAIST', formal_name: 'KAIST', country: 'KOR' },
  { id: 'utokyo', name: 'UTokyo', formal_name: 'University of Tokyo', country: 'JPN' },
  { id: 'nccu', name: 'NCCU', country: 'TWN' },
  { id: 'tum', name: 'TUM', country: 'DEU' }, // exercises the first-2-letters fallback
];

const ccsTeams = [
  { id: 't1', name: 'Preforce', organization_id: 'kaist' },
  { id: 't2', name: 'Sushi Masters', organization_id: 'utokyo' },
  { id: 't3', name: 'Bubble Tea', organization_id: 'nccu' },
  { id: 't4', name: 'Bretzel', display_name: 'Bretzel (display)', organization_id: 'tum' },
  { id: 't5', name: 'Orphans' }, // no organization
];

const ccsJudgementTypes = [
  { id: 'AC', name: 'correct', solved: true, penalty: false },
  { id: 'WA', name: 'wrong answer', solved: false, penalty: true },
  { id: 'TLE', name: 'timelimit', solved: false, penalty: true },
  { id: 'CE', name: 'compiler error', solved: false, penalty: false },
];

const ccsSubmissions = [
  { id: 's1', team_id: 't1', problem_id: 'adv', contest_time: '0:05:30.123', language_id: 'cpp' },
  { id: 's2', team_id: 't2', problem_id: 'adv', contest_time: '1:02:59', language_id: 'cpp' },
  { id: 's3', team_id: 't1', problem_id: 'badge', contest_time: '2:00:00.000', language_id: 'java' },
  { id: 's4', team_id: 't3', problem_id: 'badge', contest_time: '-0:03:00.000', language_id: 'py3' },
  { id: 's5', team_id: 't4', problem_id: 'adv', contest_time: '3:10:05.999', language_id: 'cpp' },
  { id: 's6', team_id: 't5', problem_id: 'badge', contest_time: '4:59:59.000', language_id: 'cpp' },
];

const ccsJudgements = [
  { id: 'j1', submission_id: 's1', judgement_type_id: 'AC' },
  { id: 'j2', submission_id: 's2', judgement_type_id: 'WA' },
  // s3: no judgement at all → pending.
  { id: 'j4', submission_id: 's4', judgement_type_id: 'CE' },
  // s5: rejudged — an earlier WA superseded by a later AC (latest valid wins).
  { id: 'j5a', submission_id: 's5', judgement_type_id: 'WA' },
  { id: 'j5b', submission_id: 's5', judgement_type_id: 'AC' },
  // s6: judgement exists but still running (null type) → pending.
  { id: 'j6', submission_id: 's6', judgement_type_id: null },
];

type Routes = Record<string, unknown>;

function defaultRoutes(): Routes {
  return {
    [ROOT]: ccsContest,
    [`${ROOT}/problems`]: ccsProblems,
    [`${ROOT}/teams`]: ccsTeams,
    [`${ROOT}/organizations`]: ccsOrganizations,
    [`${ROOT}/judgement-types`]: ccsJudgementTypes,
    [`${ROOT}/submissions`]: ccsSubmissions,
    [`${ROOT}/judgements`]: ccsJudgements,
  };
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function makeSource(overrides: Partial<ContestApiSourceOptions> = {}, routes: Routes = defaultRoutes()) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (!(url in routes)) return new Response('not found', { status: 404, statusText: 'Not Found' });
    return new Response(JSON.stringify(routes[url]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const source = createContestApiSource({
    baseUrl: BASE,
    contestId: CONTEST_ID,
    auth: null,
    fetchTimeout: 5000,
    excludeTeamIds: [],
    foreign: { ids: [], groups: [] },
    orgs: {},
    fetchImpl: impl,
    ...overrides,
  });
  return { source, calls };
}

// --- helpers ----------------------------------------------------------------

describe('contestTimeToMinute', () => {
  it('floors H:MM:SS.mmm to minutes', () => {
    expect(contestTimeToMinute('0:05:30.123')).toBe(5);
    expect(contestTimeToMinute('0:00:59.999')).toBe(0);
    expect(contestTimeToMinute('4:59:59.000')).toBe(299);
  });

  it('accepts HH:MM:SS without milliseconds', () => {
    expect(contestTimeToMinute('1:02:59')).toBe(62);
    expect(contestTimeToMinute('10:00:00')).toBe(600);
  });

  it('clamps negative (pre-start) times to 0', () => {
    expect(contestTimeToMinute('-0:03:00.000')).toBe(0);
    expect(contestTimeToMinute('-1:00:00')).toBe(0);
  });

  it('returns 0 for absent or malformed input', () => {
    expect(contestTimeToMinute(undefined)).toBe(0);
    expect(contestTimeToMinute('garbage')).toBe(0);
  });
});

describe('iso3ToAlpha2', () => {
  it('maps the known ICPC countries', () => {
    expect(iso3ToAlpha2('KOR')).toBe('KR');
    expect(iso3ToAlpha2('JPN')).toBe('JP');
    expect(iso3ToAlpha2('TWN')).toBe('TW');
    expect(iso3ToAlpha2('CHN')).toBe('CN');
    expect(iso3ToAlpha2('USA')).toBe('US');
  });

  it('falls back to the first two letters for unmapped codes', () => {
    expect(iso3ToAlpha2('DEU')).toBe('DE');
    expect(iso3ToAlpha2('CAN')).toBe('CA');
  });

  it('passes alpha-2 through and returns undefined for empty input', () => {
    expect(iso3ToAlpha2('KR')).toBe('KR');
    expect(iso3ToAlpha2(undefined)).toBeUndefined();
    expect(iso3ToAlpha2('')).toBeUndefined();
  });
});

// --- loadContest ------------------------------------------------------------

describe('createContestApiSource#loadContest', () => {
  it('maps contest, problems (rgb→color, ordinal→order, sorted) and teams', async () => {
    const { source } = makeSource();
    const contest = await source.loadContest();

    expect(contest.title).toBe('2025 ICPC Asia Seoul Regional Contest');
    expect(contest.problems).toHaveLength(2);
    // Sorted by ordinal even though the feed listed B first.
    expect(contest.problems[0]).toEqual({
      id: 'adv',
      label: 'A',
      title: 'Adventurer Dabi',
      color: '#ADD8E6',
      order: 0,
    });
    expect(contest.problems[1].label).toBe('B');
    expect(contest.problems[1].color).toBe('#000000');

    expect(contest.teams.size).toBe(5);
    const kaist = contest.teams.get('t1')!;
    expect(kaist.group).toBe('KAIST');
    expect(kaist.countryCode).toBe('KR');
    // display_name preferred over name.
    expect(contest.teams.get('t4')!.name).toBe('Bretzel (display)');
    // Team without an organization: empty group, no country, domestic.
    const orphan = contest.teams.get('t5')!;
    expect(orphan.group).toBe('');
    expect(orphan.countryCode).toBeUndefined();
    expect(orphan.foreign).toBe(false);
  });

  it('classifies foreign by country != KR with ISO3→alpha-2 conversion', async () => {
    const { source } = makeSource();
    const contest = await source.loadContest();

    expect(contest.teams.get('t1')!.foreign).toBe(false); // KOR → KR
    expect(contest.teams.get('t2')!.foreign).toBe(true); // JPN → JP
    expect(contest.teams.get('t2')!.countryCode).toBe('JP');
    expect(contest.teams.get('t3')!.countryCode).toBe('TW');
    expect(contest.teams.get('t4')!.countryCode).toBe('DE'); // DEU fallback
    expect(contest.teams.get('t4')!.foreign).toBe(true);
  });

  it('lets config foreign ids/groups force foreign over the country rule', async () => {
    const { source } = makeSource({ foreign: { ids: ['t1'], groups: ['University of Tokyo'] } });
    const contest = await source.loadContest();
    expect(contest.teams.get('t1')!.foreign).toBe(true); // KR org but id-listed
    expect(contest.teams.get('t2')!.foreign).toBe(true); // group-listed
  });

  it('prefers orgs.json country over /organizations country', async () => {
    const orgs: OrgsIndex = { 'University of Tokyo': { country: 'KR' } };
    const { source } = makeSource({ orgs });
    const contest = await source.loadContest();
    const team = contest.teams.get('t2')!;
    expect(team.countryCode).toBe('KR');
    expect(team.foreign).toBe(false); // orgs.json wins → domestic
  });

  it('removes excluded teams', async () => {
    const { source } = makeSource({ excludeTeamIds: ['t3'] });
    const contest = await source.loadContest();
    expect(contest.teams.has('t3')).toBe(false);
    expect(contest.teams.size).toBe(4);
  });

  it('sends a basic auth header when auth is given, none otherwise', async () => {
    const { source, calls } = makeSource({ auth: { username: 'judge', password: 's3cret' } });
    await source.loadContest();
    const expected = `Basic ${btoa('judge:s3cret')}`;
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>).Authorization).toBe(expected);
    }

    const { source: anon, calls: anonCalls } = makeSource();
    await anon.loadContest();
    for (const call of anonCalls) {
      expect((call.init?.headers as Record<string, string>).Authorization).toBeUndefined();
    }
  });

  it('attaches an abort signal derived from fetchTimeout and throws on non-ok', async () => {
    const { source, calls } = makeSource({ fetchTimeout: 1234 });
    await source.loadContest();
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);

    const { source: broken } = makeSource({}, {});
    await expect(broken.loadContest()).rejects.toThrow(/404/);
  });
});

// --- fetchRuns --------------------------------------------------------------

describe('createContestApiSource#fetchRuns', () => {
  async function loadedSource(overrides: Partial<ContestApiSourceOptions> = {}, routes?: Routes) {
    const made = makeSource(overrides, routes);
    await made.source.loadContest(); // caches judgement-types
    return made;
  }

  it('joins judgements by submission_id and normalizes verdicts', async () => {
    const { source } = await loadedSource();
    const { runs } = await source.fetchRuns(null);
    const byId = new Map(runs.map((r) => [r.id, r]));

    expect(byId.get('s1')).toMatchObject({ verdict: 'accepted', penaltyCounts: false });
    expect(byId.get('s2')).toMatchObject({ verdict: 'failed', penaltyCounts: true });
    // No judgement → pending.
    expect(byId.get('s3')).toMatchObject({ verdict: 'pending', penaltyCounts: false });
    // No-penalty judgement type (CE) → failed without penalty.
    expect(byId.get('s4')).toMatchObject({ verdict: 'failed', penaltyCounts: false });
    // Rejudge: latest valid judgement wins (WA then AC → accepted).
    expect(byId.get('s5')).toMatchObject({ verdict: 'accepted' });
    // Judgement present but judgement_type_id null → still pending.
    expect(byId.get('s6')).toMatchObject({ verdict: 'pending', penaltyCounts: false });
  });

  it('converts contest_time to floor minutes, clamping negatives to 0', async () => {
    const { source } = await loadedSource();
    const { runs } = await source.fetchRuns(null);
    const byId = new Map(runs.map((r) => [r.id, r.minute]));
    expect(byId.get('s1')).toBe(5); // 0:05:30.123
    expect(byId.get('s2')).toBe(62); // 1:02:59
    expect(byId.get('s3')).toBe(120); // 2:00:00.000
    expect(byId.get('s4')).toBe(0); // -0:03:00.000 → clamp
    expect(byId.get('s5')).toBe(190); // 3:10:05.999
  });

  it('maps team/problem ids and reports noMoreUpdate=false, contestTimeSec=null', async () => {
    const { source } = await loadedSource();
    const result = await source.fetchRuns(null);
    expect(result.noMoreUpdate).toBe(false);
    expect(result.contestTimeSec).toBeNull();
    const s1 = result.runs.find((r) => r.id === 's1')!;
    expect(s1.teamId).toBe('t1');
    expect(s1.problemId).toBe('adv');
  });

  it('assigns monotonic seq in first-seen order', async () => {
    const { source } = await loadedSource();
    const { runs } = await source.fetchRuns(null);
    expect(runs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(runs.map((r) => r.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
  });

  it('keeps seq stable across polls via a JSON-serializable cursor round-trip', async () => {
    const routes = defaultRoutes();
    const { source } = await loadedSource({}, routes);

    const first = await source.fetchRuns(null);
    // Simulate transport: the cursor must survive JSON serialization.
    const revived = JSON.parse(JSON.stringify(first.cursor));

    // Next poll returns the same submissions plus a new one, reordered.
    routes[`${ROOT}/submissions`] = [
      ccsSubmissions[2], // s3 first this time
      ...ccsSubmissions.filter((s) => s.id !== 's3'),
      { id: 's7', team_id: 't2', problem_id: 'badge', contest_time: '4:30:00.000' },
    ];
    const second = await source.fetchRuns(revived);
    const seqById = new Map(second.runs.map((r) => [r.id, r.seq]));

    // Previously seen submissions keep their original seq...
    expect(seqById.get('s1')).toBe(1);
    expect(seqById.get('s3')).toBe(3);
    expect(seqById.get('s6')).toBe(6);
    // ...and the newcomer gets the next counter value.
    expect(seqById.get('s7')).toBe(7);
  });

  it('drops runs of excluded teams while still consuming their seq slots deterministically', async () => {
    const { source } = await loadedSource({ excludeTeamIds: ['t1'] });
    const { runs } = await source.fetchRuns(null);
    expect(runs.some((r) => r.teamId === 't1')).toBe(false);
    // s1 (seq 1) and s3 (seq 3) belong to t1; the rest keep stable slots.
    expect(runs.map((r) => r.id)).toEqual(['s2', 's4', 's5', 's6']);
    expect(runs.map((r) => r.seq)).toEqual([2, 4, 5, 6]);
  });

  it('treats an unknown judgement type as pending', async () => {
    const routes = defaultRoutes();
    routes[`${ROOT}/judgements`] = [{ id: 'jx', submission_id: 's1', judgement_type_id: 'MYSTERY' }];
    const { source } = await loadedSource({}, routes);
    const { runs } = await source.fetchRuns(null);
    expect(runs.find((r) => r.id === 's1')!.verdict).toBe('pending');
  });
});
