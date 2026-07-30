import { describe, it, expect } from 'vitest';
import {
  createContestApiSource,
  contestTimeToMinute,
  parseContestTimeSeconds,
  type ContestApiSourceOptions,
} from '@core/ingest/contest-api';
import type { OrgsIndex } from '@core/types';

// --- Fixtures ---------------------------------------------------------------
// Payload shapes follow the DOMjudge 9.0.0 OpenAPI document + ccs-specs; they
// are hand-built, NOT captured from a live instance.

const BASE = 'https://judge.example.org/api';
const CONTEST_ID = 'seoul25';
const ROOT = `${BASE}/contests/${CONTEST_ID}`;
/** DOMjudge filters jury/test teams only when asked (spec P1-1). */
const TEAMS_URL = `${ROOT}/teams?public=true`;

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
  { id: 'tum', name: 'TUM', country: 'DEU' },
];

const ccsTeams = [
  { id: 't1', name: 'Preforce', organization_id: 'kaist' },
  { id: 't2', name: 'Sushi Masters', organization_id: 'utokyo' },
  { id: 't3', name: 'Bubble Tea', organization_id: 'nccu' },
  { id: 't4', name: 'Bretzel', display_name: 'Bretzel (display)', organization_id: 'tum' },
  { id: 't5', name: 'Orphans' }, // no organization, no affiliation, no nationality
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
  { id: 'j1', submission_id: 's1', judgement_type_id: 'AC', valid: true, end_contest_time: '0:05:40.000' },
  { id: 'j2', submission_id: 's2', judgement_type_id: 'WA', valid: true, end_contest_time: '1:03:10.000' },
  // s3: no judgement at all → pending.
  { id: 'j4', submission_id: 's4', judgement_type_id: 'CE', valid: true, end_contest_time: '0:00:05.000' },
  // s5: rejudged — the superseded WA is marked invalid, the AC replaces it.
  { id: 'j5a', submission_id: 's5', judgement_type_id: 'WA', valid: false, end_contest_time: '3:10:20.000' },
  { id: 'j5b', submission_id: 's5', judgement_type_id: 'AC', valid: true, end_contest_time: '3:12:00.000' },
  // s6: judging started but still running (null type, no end time) → pending.
  { id: 'j6', submission_id: 's6', judgement_type_id: null, valid: true, end_contest_time: null },
];

/** An api_reader-grade access document: every endpoint we need is readable. */
const ccsAccess = {
  capabilities: [],
  endpoints: [
    { type: 'contest', properties: ['id', 'name'] },
    { type: 'problems', properties: ['id', 'label'] },
    { type: 'teams', properties: ['id', 'name'] },
    { type: 'organizations', properties: ['id', 'name'] },
    { type: 'judgement-types', properties: ['id', 'solved'] },
    { type: 'submissions', properties: ['id', 'team_id'] },
    { type: 'judgements', properties: ['id', 'submission_id'] },
  ],
};

/** Contest not started → the clock is "--:--" and the feed is still open. */
const ccsState = {
  started: null,
  ended: null,
  frozen: null,
  thawed: null,
  finalized: null,
  end_of_updates: null,
};

type Routes = Record<string, unknown>;

function defaultRoutes(): Routes {
  return {
    [ROOT]: ccsContest,
    [`${ROOT}/access`]: ccsAccess,
    [`${ROOT}/state`]: ccsState,
    [`${ROOT}/problems`]: ccsProblems,
    [TEAMS_URL]: ccsTeams,
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
  const warnings: string[] = [];
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
    onWarning: (m) => warnings.push(m),
    ...overrides,
  });
  return { source, calls, warnings };
}

/** Routes with a replacement /teams payload (everything else default). */
function routesWithTeams(teams: unknown[]): Routes {
  const routes = defaultRoutes();
  routes[TEAMS_URL] = teams;
  return routes;
}

// --- helpers ----------------------------------------------------------------

describe('parseContestTimeSeconds', () => {
  it('keeps sub-minute precision and the sign', () => {
    expect(parseContestTimeSeconds('0:05:30.500')).toBeCloseTo(330.5, 6);
    expect(parseContestTimeSeconds('1:02:59')).toBe(3779);
    expect(parseContestTimeSeconds('-0:03:00.000')).toBe(-180);
  });

  it('returns undefined for absent/malformed input so callers can tell it from 0', () => {
    expect(parseContestTimeSeconds(undefined)).toBeUndefined();
    expect(parseContestTimeSeconds(null)).toBeUndefined();
    expect(parseContestTimeSeconds('garbage')).toBeUndefined();
    expect(parseContestTimeSeconds('0:00:00.000')).toBe(0);
  });
});

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
    expect(contestTimeToMinute(null)).toBe(0);
    expect(contestTimeToMinute('garbage')).toBe(0);
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
    // Team with no organization AND no affiliation: empty group, no country.
    const orphan = contest.teams.get('t5')!;
    expect(orphan.group).toBe('');
    expect(orphan.countryCode).toBeUndefined();
    expect(orphan.foreign).toBe(false);
  });

  it('classifies foreign by country != KR with alpha-3 → alpha-2 conversion', async () => {
    const { source } = makeSource();
    const contest = await source.loadContest();

    expect(contest.teams.get('t1')!.foreign).toBe(false); // KOR → KR
    expect(contest.teams.get('t2')!.foreign).toBe(true); // JPN → JP
    expect(contest.teams.get('t2')!.countryCode).toBe('JP');
    expect(contest.teams.get('t3')!.countryCode).toBe('TW');
    expect(contest.teams.get('t4')!.countryCode).toBe('DE');
    expect(contest.teams.get('t4')!.foreign).toBe(true);
  });

  it('lets config foreign ids/groups force foreign over the country rule', async () => {
    const { source } = makeSource({ foreign: { ids: ['t1'], groups: ['University of Tokyo'] } });
    const contest = await source.loadContest();
    expect(contest.teams.get('t1')!.foreign).toBe(true); // KR org but id-listed
    expect(contest.teams.get('t2')!.foreign).toBe(true); // group-listed
  });

  it('never lets an empty entry in foreign.groups catch the group-less teams', async () => {
    const { source } = makeSource({ foreign: { ids: [], groups: [''] } });
    const contest = await source.loadContest();
    expect(contest.teams.get('t5')!.group).toBe('');
    expect(contest.teams.get('t5')!.foreign).toBe(false);
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

// --- P1-1 hidden teams ------------------------------------------------------

describe('loadContest: hidden (jury/test) teams', () => {
  it('requests /teams with public=true so DOMjudge filters jury teams server-side', async () => {
    const { source, calls } = makeSource();
    await source.loadContest();
    const teamCalls = calls.filter((c) => c.url.startsWith(`${ROOT}/teams`));
    expect(teamCalls).toHaveLength(1);
    expect(teamCalls[0].url).toBe(TEAMS_URL);
  });

  it('skips hidden === true teams even if the server still returns them', async () => {
    const routes = routesWithTeams([
      ...ccsTeams,
      { id: 'jury1', name: 'Jury', organization_id: 'kaist', hidden: true },
      { id: 'test1', name: 'Test team', organization_id: 'kaist', hidden: false },
    ]);
    const { source, warnings } = makeSource({}, routes);
    const contest = await source.loadContest();

    expect(contest.teams.has('jury1')).toBe(false);
    expect(contest.teams.has('test1')).toBe(true); // hidden:false is a real team
    expect(warnings.some((w) => /hidden/i.test(w))).toBe(true);
  });

  it('drops hidden teams’ submissions from the run feed as well', async () => {
    const routes = routesWithTeams([
      ...ccsTeams,
      { id: 'jury1', name: 'Jury', organization_id: 'kaist', hidden: true },
    ]);
    routes[`${ROOT}/submissions`] = [
      ...ccsSubmissions,
      { id: 's99', team_id: 'jury1', problem_id: 'adv', contest_time: '0:01:00.000' },
    ];
    const { source } = makeSource({}, routes);
    await source.loadContest();
    const { runs } = await source.fetchRuns(null);
    expect(runs.some((r) => r.teamId === 'jury1')).toBe(false);
    // The dropped run still consumed its seq slot, so nobody else shifts.
    expect(runs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// --- P1-2 organization-less teams -------------------------------------------

describe('loadContest: teams without an organization', () => {
  const orglessTeams = [
    { id: 'a1', name: 'Alpha', affiliation: 'Seoul National University', nationality: 'KOR' },
    { id: 'a2', name: 'Beta', affiliation: 'Seoul National University', nationality: 'KOR' },
    { id: 'b1', name: 'Gamma', affiliation: 'Yonsei University', nationality: 'KOR' },
    { id: 'c1', name: 'Delta' }, // truly unaffiliated
    { id: 'c2', name: 'Epsilon', affiliation: '   ' }, // whitespace is not an affiliation
  ];

  it('falls back to the affiliation string, keeping distinct schools distinct', async () => {
    const { source } = makeSource({}, routesWithTeams(orglessTeams));
    const contest = await source.loadContest();

    expect(contest.teams.get('a1')!.group).toBe('Seoul National University');
    expect(contest.teams.get('a2')!.group).toBe('Seoul National University');
    expect(contest.teams.get('b1')!.group).toBe('Yonsei University');
    // The bug this replaces: all four would have shared group '' and become a
    // single giant "school" for schoolRank (and so for APAC stars).
    const groups = new Set([...contest.teams.values()].map((t) => t.group));
    expect(groups).toEqual(new Set(['Seoul National University', 'Yonsei University', '']));
  });

  it('emits "" only when there is genuinely no organization and no affiliation', async () => {
    const { source, warnings } = makeSource({}, routesWithTeams(orglessTeams));
    const contest = await source.loadContest();

    expect(contest.teams.get('c1')!.group).toBe('');
    expect(contest.teams.get('c2')!.group).toBe('');
    const warning = warnings.find((w) => w.includes('no school'));
    expect(warning).toBeDefined();
    expect(warning).toContain('2 team(s)');
    expect(warning).toContain('c1');
    expect(warning).toContain('c2');
  });

  it('prefers the organization over the affiliation when both are present', async () => {
    const routes = routesWithTeams([
      { id: 'x1', name: 'X', organization_id: 'kaist', affiliation: 'stale text' },
      // formal_name wins over name, per the existing mapping.
      { id: 'x2', name: 'Y', organization_id: 'utokyo', affiliation: 'stale text' },
      // Organization exists but has only `name`.
      { id: 'x3', name: 'Z', organization_id: 'nccu' },
      // Dangling organization_id → affiliation still saves the group.
      { id: 'x4', name: 'W', organization_id: 'ghost', affiliation: 'Ghost University' },
    ]);
    const { source } = makeSource({}, routes);
    const contest = await source.loadContest();
    expect(contest.teams.get('x1')!.group).toBe('KAIST');
    expect(contest.teams.get('x2')!.group).toBe('University of Tokyo');
    expect(contest.teams.get('x3')!.group).toBe('NCCU');
    expect(contest.teams.get('x4')!.group).toBe('Ghost University');
  });

  it('uses team nationality when no organization country is available', async () => {
    const routes = routesWithTeams([
      { id: 'n1', name: 'Local', affiliation: 'Korea University', nationality: 'KOR' },
      { id: 'n2', name: 'Visitor', affiliation: 'NUS', nationality: 'SGP' },
      // Organization country wins over nationality when both exist.
      { id: 'n3', name: 'Mixed', organization_id: 'utokyo', nationality: 'KOR' },
    ]);
    const { source } = makeSource({}, routes);
    const contest = await source.loadContest();

    expect(contest.teams.get('n1')!.countryCode).toBe('KR');
    expect(contest.teams.get('n1')!.foreign).toBe(false);
    expect(contest.teams.get('n2')!.countryCode).toBe('SG');
    expect(contest.teams.get('n2')!.foreign).toBe(true);
    expect(contest.teams.get('n3')!.countryCode).toBe('JP');
  });

  it('still lets orgs.json override the country for an affiliation-derived group', async () => {
    const routes = routesWithTeams([
      { id: 'n1', name: 'Local', affiliation: 'Korea University', nationality: 'JPN' },
    ]);
    const orgs: OrgsIndex = { 'Korea University': { country: 'KR' } };
    const { source } = makeSource({ orgs }, routes);
    const contest = await source.loadContest();
    expect(contest.teams.get('n1')!.countryCode).toBe('KR');
    expect(contest.teams.get('n1')!.foreign).toBe(false);
  });

  it('does not look up orgs.json under the empty group key', async () => {
    const routes = routesWithTeams([{ id: 'c1', name: 'Delta' }]);
    const orgs: OrgsIndex = { '': { country: 'JP' } };
    const { source } = makeSource({ orgs }, routes);
    const contest = await source.loadContest();
    expect(contest.teams.get('c1')!.countryCode).toBeUndefined();
  });
});

// --- P1-3 country codes -----------------------------------------------------

describe('loadContest: country codes', () => {
  it('maps the APAC alpha-3 codes the old slice fallback got wrong', async () => {
    const routes = defaultRoutes();
    routes[`${ROOT}/organizations`] = [
      { id: 'buet', name: 'BUET', country: 'BGD' },
      { id: 'utb', name: 'UTB', country: 'BRN' },
      { id: 'umac', name: 'UMac', country: 'MAC' },
    ];
    routes[TEAMS_URL] = [
      { id: 'bd', name: 'Dhaka', organization_id: 'buet' },
      { id: 'bn', name: 'Bandar', organization_id: 'utb' },
      { id: 'mo', name: 'Macau', organization_id: 'umac' },
    ];
    const { source } = makeSource({}, routes);
    const contest = await source.loadContest();

    expect(contest.teams.get('bd')!.countryCode).toBe('BD'); // was "BG" (Bulgaria)
    expect(contest.teams.get('bn')!.countryCode).toBe('BN'); // was "BR" (Brazil)
    expect(contest.teams.get('mo')!.countryCode).toBe('MO'); // was "MA" (Morocco)
  });

  it('leaves the country undefined and warns once for an unrecognized code', async () => {
    const routes = defaultRoutes();
    routes[`${ROOT}/organizations`] = [
      { id: 'o1', name: 'Somewhere', country: 'XXX' },
      { id: 'o2', name: 'Elsewhere', country: 'Republic of Korea' },
    ];
    routes[TEAMS_URL] = [
      { id: 'u1', name: 'A', organization_id: 'o1' },
      { id: 'u2', name: 'B', organization_id: 'o1' },
      { id: 'u3', name: 'C', organization_id: 'o2' },
    ];
    const { source, warnings } = makeSource({}, routes);
    const contest = await source.loadContest();

    expect(contest.teams.get('u1')!.countryCode).toBeUndefined();
    expect(contest.teams.get('u3')!.countryCode).toBeUndefined();
    // No country → no flag, and no foreign classification from the country rule.
    expect(contest.teams.get('u1')!.foreign).toBe(false);

    const countryWarnings = warnings.filter((w) => w.includes('unrecognized country code'));
    expect(countryWarnings).toHaveLength(1); // one-time, not once per team
    expect(countryWarnings[0]).toContain('XXX');
    expect(countryWarnings[0]).toContain('REPUBLIC OF KOREA');
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
    // Rejudge: the invalid WA is ignored, the valid AC wins.
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
});

// --- P1-4 unknown judgement types -------------------------------------------

describe('fetchRuns: unknown judgement types', () => {
  it('scores an unknown type as a penalized failure and warns, instead of pending forever', async () => {
    const routes = defaultRoutes();
    // A judgement type added mid-contest, after loadContest cached the table.
    routes[`${ROOT}/judgements`] = [
      { id: 'jx', submission_id: 's1', judgement_type_id: 'MYSTERY', valid: true, end_contest_time: '0:06:00' },
      { id: 'jy', submission_id: 's2', judgement_type_id: 'MYSTERY', valid: true, end_contest_time: '1:04:00' },
    ];
    const { source, warnings } = makeSource({}, routes);
    await source.loadContest();
    const { runs } = await source.fetchRuns(null);

    const s1 = runs.find((r) => r.id === 's1')!;
    expect(s1.verdict).toBe('failed');
    expect(s1.penaltyCounts).toBe(true);

    const typeWarnings = warnings.filter((w) => w.includes('unknown judgement type'));
    expect(typeWarnings).toHaveLength(1); // once per type, not once per run
    expect(typeWarnings[0]).toContain('MYSTERY');
  });

  it('warns once per distinct unknown type across repeated polls', async () => {
    const routes = defaultRoutes();
    routes[`${ROOT}/judgements`] = [
      { id: 'jx', submission_id: 's1', judgement_type_id: 'MYSTERY', valid: true },
      { id: 'jz', submission_id: 's2', judgement_type_id: 'ENIGMA', valid: true },
    ];
    const { source, warnings } = makeSource({}, routes);
    await source.loadContest();
    await source.fetchRuns(null);
    await source.fetchRuns(null);
    expect(warnings.filter((w) => w.includes('unknown judgement type'))).toHaveLength(2);
  });

  it('keeps runs pending (and says so) when the judgement-type table was never loaded', async () => {
    // fetchRuns without loadContest: the cache is empty, so "unknown type"
    // means "we know nothing yet" rather than "the judge rejected it".
    const { source, warnings } = makeSource();
    const { runs } = await source.fetchRuns(null);
    expect(runs.find((r) => r.id === 's1')!.verdict).toBe('pending');
    expect(warnings.some((w) => w.includes('/judgement-types has not been loaded'))).toBe(true);
  });
});

// --- P1-5 judgement selection ------------------------------------------------

describe('fetchRuns: judgement selection', () => {
  async function verdictOf(judgements: unknown[]): Promise<{ verdict: string; penaltyCounts: boolean }> {
    const routes = defaultRoutes();
    routes[`${ROOT}/judgements`] = judgements;
    const { source } = makeSource({}, routes);
    await source.loadContest();
    const { runs } = await source.fetchRuns(null);
    const run = runs.find((r) => r.id === 's1')!;
    return { verdict: run.verdict, penaltyCounts: run.penaltyCounts };
  }

  it('ignores judgements marked valid === false, whatever their position', async () => {
    // The superseded judging is listed LAST — array order must not save it.
    expect(
      await verdictOf([
        { id: 'j1', submission_id: 's1', judgement_type_id: 'AC', valid: true, end_contest_time: '0:06:00' },
        { id: 'j2', submission_id: 's1', judgement_type_id: 'WA', valid: false, end_contest_time: '0:09:00' },
      ]),
    ).toEqual({ verdict: 'accepted', penaltyCounts: false });
  });

  it('picks the greatest end_contest_time regardless of array order', async () => {
    // Latest judging (AC) listed first, stale WA last.
    expect(
      await verdictOf([
        { id: 'j2', submission_id: 's1', judgement_type_id: 'AC', valid: true, end_contest_time: '0:09:00' },
        { id: 'j1', submission_id: 's1', judgement_type_id: 'WA', valid: true, end_contest_time: '0:06:00' },
      ]),
    ).toEqual({ verdict: 'accepted', penaltyCounts: false });

    // ...and the mirror case: the last element must not automatically win.
    expect(
      await verdictOf([
        { id: 'j1', submission_id: 's1', judgement_type_id: 'AC', valid: true, end_contest_time: '0:09:00' },
        { id: 'j2', submission_id: 's1', judgement_type_id: 'WA', valid: true, end_contest_time: '0:06:00' },
      ]),
    ).toEqual({ verdict: 'accepted', penaltyCounts: false });
  });

  it('falls back to the greatest id, comparing numeric ids numerically', async () => {
    expect(
      await verdictOf([
        { id: '10', submission_id: 's1', judgement_type_id: 'AC', valid: true },
        { id: '9', submission_id: 's1', judgement_type_id: 'WA', valid: true },
      ]),
    ).toEqual({ verdict: 'accepted', penaltyCounts: false });

    // Same end time → id decides.
    expect(
      await verdictOf([
        { id: '2', submission_id: 's1', judgement_type_id: 'WA', valid: true, end_contest_time: '0:06:00' },
        { id: '11', submission_id: 's1', judgement_type_id: 'TLE', valid: true, end_contest_time: '0:06:00' },
      ]),
    ).toEqual({ verdict: 'failed', penaltyCounts: true });
  });

  it('returns to pending while a rejudging is in flight', async () => {
    // The new judging has no end_contest_time yet; the id fallback still
    // ranks it above the finished one, so the cell goes back to pending.
    expect(
      await verdictOf([
        { id: '1', submission_id: 's1', judgement_type_id: 'AC', valid: true, end_contest_time: '0:06:00' },
        { id: '2', submission_id: 's1', judgement_type_id: null, valid: true, end_contest_time: null },
      ]),
    ).toEqual({ verdict: 'pending', penaltyCounts: false });
  });

  it('treats an empty judgement_type_id as no judgement', async () => {
    expect(
      await verdictOf([{ id: 'j1', submission_id: 's1', judgement_type_id: '', valid: true }]),
    ).toEqual({ verdict: 'pending', penaltyCounts: false });
  });
});

// --- Submission id handling --------------------------------------------------

describe('fetchRuns: submission ids', () => {
  it('falls back to submitid when id is null, instead of colliding on "null"', async () => {
    const routes = defaultRoutes();
    routes[`${ROOT}/submissions`] = [
      { id: null, submitid: 101, team_id: 't1', problem_id: 'adv', contest_time: '0:05:00' },
      { id: null, submitid: 102, team_id: 't2', problem_id: 'adv', contest_time: '0:06:00' },
    ];
    routes[`${ROOT}/judgements`] = [
      { id: 'j1', submission_id: '101', judgement_type_id: 'AC', valid: true, end_contest_time: '0:05:30' },
      { id: 'j2', submission_id: '102', judgement_type_id: 'WA', valid: true, end_contest_time: '0:06:30' },
    ];
    const { source } = makeSource({}, routes);
    await source.loadContest();
    const { runs } = await source.fetchRuns(null);

    // String(null) === "null" would have merged these into one run id.
    expect(runs.map((r) => r.id)).toEqual(['101', '102']);
    expect(runs.map((r) => r.seq)).toEqual([1, 2]);
    // ...and each keeps its own judgement.
    expect(runs[0].verdict).toBe('accepted');
    expect(runs[1].verdict).toBe('failed');
  });

  it('drops (and reports) a submission with neither id nor submitid', async () => {
    const routes = defaultRoutes();
    routes[`${ROOT}/submissions`] = [
      { id: null, team_id: 't1', problem_id: 'adv', contest_time: '0:05:00' },
      { id: 's2', team_id: 't2', problem_id: 'adv', contest_time: '0:06:00' },
    ];
    const { source, warnings } = makeSource({}, routes);
    await source.loadContest();
    const { runs } = await source.fetchRuns(null);

    expect(runs.map((r) => r.id)).toEqual(['s2']);
    expect(warnings.some((w) => w.includes('neither `id` nor `submitid`'))).toBe(true);
  });

  it('warns once about submissions from a team that was not in /teams', async () => {
    const routes = defaultRoutes();
    routes[`${ROOT}/submissions`] = [
      { id: 'z1', team_id: 'ghost', problem_id: 'adv', contest_time: '0:05:00' },
      { id: 'z2', team_id: 'ghost', problem_id: 'adv', contest_time: '0:06:00' },
    ];
    const { source, warnings } = makeSource({}, routes);
    await source.loadContest();
    await source.fetchRuns(null);
    expect(warnings.filter((w) => w.includes('absent from /teams'))).toHaveLength(1);
  });
});

// --- P0 helpers --------------------------------------------------------------

const START_MS = Date.parse(ccsContest.start_time);
const HOUR = 3_600_000;

/** defaultRoutes with `path` (relative to the contest root) removed → 404. */
function routesWithout(path: string): Routes {
  const routes = defaultRoutes();
  delete routes[`${ROOT}${path}`];
  return routes;
}

/** defaultRoutes with one contest-root path replaced. */
function routesWith(path: string, payload: unknown): Routes {
  const routes = defaultRoutes();
  routes[`${ROOT}${path}`] = payload;
  return routes;
}

/** A /state document; every field defaults to null (= "not yet"). */
function stateDoc(overrides: Record<string, string | null> = {}): Record<string, string | null> {
  return { started: null, ended: null, frozen: null, thawed: null, finalized: null, end_of_updates: null, ...overrides };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// --- P0-1 access role gate ---------------------------------------------------

describe('loadContest: access role gate (P0-1)', () => {
  /** An access document listing exactly `types`. */
  function accessDoc(types: string[]): unknown {
    return { capabilities: [], endpoints: types.map((type) => ({ type, properties: [] })) };
  }

  it('checks /access before touching anything else and starts when judgements are granted', async () => {
    const { source, calls } = makeSource();
    await expect(source.loadContest()).resolves.toBeDefined();
    // Sequential first request: a role problem must be diagnosed as such,
    // not as whatever 403 the parallel loads reject with first.
    expect(calls[0].url).toBe(`${ROOT}/access`);
    expect(calls.filter((c) => c.url === `${ROOT}/access`)).toHaveLength(1);
  });

  it('refuses to start and names api_reader when /access withholds judgements', async () => {
    // Exactly what a DOMjudge TEAM account sees: submissions but no judgements.
    const routes = routesWith('/access', accessDoc(['contest', 'problems', 'teams', 'submissions']));
    const { source } = makeSource({}, routes);
    await expect(source.loadContest()).rejects.toThrow(/api_reader/);
    await expect(source.loadContest()).rejects.toThrow(/"judgements"/);
    // The message must say what to do, not just what failed.
    await expect(source.loadContest()).rejects.toThrow(/team.*account is not enough|not enough/i);
  });

  it('names every missing endpoint, not just the first', async () => {
    const routes = routesWith('/access', accessDoc(['contest', 'problems', 'teams']));
    const { source } = makeSource({}, routes);
    await expect(source.loadContest()).rejects.toThrow(/"submissions" and "judgements"/);
  });

  it('accepts an endpoint list of bare strings', async () => {
    const routes = routesWith('/access', { endpoints: ['contest', 'submissions', 'judgements'] });
    const { source } = makeSource({}, routes);
    await expect(source.loadContest()).resolves.toBeDefined();
  });

  it('continues (with a warning) when /access itself is unavailable', async () => {
    // Old CDS builds have no access endpoint — that must not block a contest.
    const { source, warnings } = makeSource({}, routesWithout('/access'));
    await expect(source.loadContest()).resolves.toBeDefined();
    expect(warnings.filter((w) => w.includes('access check was skipped'))).toHaveLength(1);
    expect(warnings.some((w) => w.includes('api_reader'))).toBe(true);
  });

  it('continues (with a warning) when the access document carries no endpoint list', async () => {
    const { source, warnings } = makeSource({}, routesWith('/access', { capabilities: ['team_submit'] }));
    await expect(source.loadContest()).resolves.toBeDefined();
    expect(warnings.filter((w) => w.includes('no endpoint list'))).toHaveLength(1);
  });
});

// --- P0-1 runtime: team-filtered judgements ----------------------------------

describe('fetchRuns: team-filtered judgements diagnosis (P0-1)', () => {
  const FILTER_HINT = 'filtered to a single team';

  it('stays quiet when judgements span several teams', async () => {
    const { source, warnings } = makeSource();
    await source.loadContest();
    const result = await source.fetchRuns(null);
    expect(result.warnings).toEqual([]);
    expect(warnings.some((w) => w.includes(FILTER_HINT))).toBe(false);
  });

  it('diagnoses judgements confined to one team while submissions span many', async () => {
    // s1/s3 are t1's; every other team's submissions come back unjudged —
    // the exact shape of DOMjudge filtering /judgements to the caller's team.
    const routes = routesWith('/judgements', [
      { id: 'j1', submission_id: 's1', judgement_type_id: 'AC', valid: true, end_contest_time: '0:05:40.000' },
      { id: 'j3', submission_id: 's3', judgement_type_id: 'WA', valid: true, end_contest_time: '2:00:30.000' },
    ]);
    const { source } = makeSource({}, routes);
    await source.loadContest();

    const first = await source.fetchRuns(null);
    expect(first.warnings.filter((w) => w.includes(FILTER_HINT))).toHaveLength(1);
    expect(first.warnings[0]).toMatch(/api_reader/);

    // Diagnosed once, not once per poll (10 s polling would spam the operator).
    const second = await source.fetchRuns(first.cursor);
    expect(second.warnings).toEqual([]);
  });

  it('reports a board where nobody has any judgement once it holds real traffic', async () => {
    const { source } = makeSource({}, routesWith('/judgements', []));
    await source.loadContest();
    const result = await source.fetchRuns(null);
    expect(result.warnings.filter((w) => w.includes(FILTER_HINT))).toHaveLength(1);
  });

  it('stays quiet on a barely-started contest whose few runs are all pending', async () => {
    const routes = routesWith('/judgements', []);
    routes[`${ROOT}/submissions`] = ccsSubmissions.slice(0, 3); // 3 teams, nothing judged yet
    const { source } = makeSource({}, routes);
    await source.loadContest();
    const result = await source.fetchRuns(null);
    expect(result.warnings.some((w) => w.includes(FILTER_HINT))).toBe(false);
  });

  it('stays quiet in the first minutes, when only the earliest run is judged', async () => {
    // The opening of a real contest: three runs from three teams, the first one
    // judged, the rest still in the queue. That is the same shape as a filtered
    // feed, so only the traffic volume tells them apart — and this warning
    // accuses the operator's account of being broken, so it must not fire here.
    const routes = routesWith('/judgements', [
      { id: 'j1', submission_id: 's1', judgement_type_id: 'AC', valid: true, end_contest_time: '0:05:40.000' },
    ]);
    routes[`${ROOT}/submissions`] = ccsSubmissions.slice(0, 3); // t1, t2, t1
    const { source } = makeSource({}, routes);
    await source.loadContest();
    const result = await source.fetchRuns(null);
    expect(result.warnings.some((w) => w.includes(FILTER_HINT))).toBe(false);
  });

  it('stays quiet when only one team has submitted at all', async () => {
    const routes = routesWith('/judgements', []);
    routes[`${ROOT}/submissions`] = ccsSubmissions.filter((s) => s.team_id === 't1');
    const { source } = makeSource({}, routes);
    await source.loadContest();
    const result = await source.fetchRuns(null);
    expect(result.warnings.some((w) => w.includes(FILTER_HINT))).toBe(false);
  });
});

// --- P0-2 contest clock ------------------------------------------------------

describe('fetchRuns: contest clock (P0-2)', () => {
  /** A loaded source whose wall clock reads `nowMs`. */
  async function clockSource(routes: Routes, nowMs: number) {
    const made = makeSource({ now: () => nowMs }, routes);
    await made.source.loadContest();
    return made;
  }

  it('derives elapsed seconds from state.started plus the wall clock', async () => {
    const routes = routesWith('/state', stateDoc({ started: ccsContest.start_time }));
    const { source } = await clockSource(routes, START_MS + HOUR + 61_000);
    const result = await source.fetchRuns(null);
    expect(result.contestTimeSec).toBe(3661);
  });

  it('reports null (--:--) while the contest has not started', async () => {
    // /state says started: null even though start_time is in the past.
    const { source } = await clockSource(defaultRoutes(), START_MS + HOUR);
    const result = await source.fetchRuns(null);
    expect(result.contestTimeSec).toBeNull();
  });

  it('clamps to the contest duration once the contest is over', async () => {
    const routes = routesWith('/state', stateDoc({ started: ccsContest.start_time }));
    const { source } = await clockSource(routes, START_MS + 7 * HOUR); // duration is 5:00:00
    const result = await source.fetchRuns(null);
    expect(result.contestTimeSec).toBe(5 * 3600);
  });

  it('stops at state.ended when the contest ended early', async () => {
    const routes = routesWith(
      '/state',
      stateDoc({ started: ccsContest.start_time, ended: iso(START_MS + 4 * HOUR) }),
    );
    const { source } = await clockSource(routes, START_MS + 6 * HOUR);
    const result = await source.fetchRuns(null);
    expect(result.contestTimeSec).toBe(4 * 3600);
  });

  it('falls back to start_time when /state is unavailable, without failing the poll', async () => {
    const { source } = await clockSource(routesWithout('/state'), START_MS + 30 * 60_000);
    const result = await source.fetchRuns(null);
    expect(result.contestTimeSec).toBe(1800);
    expect(result.runs.length).toBeGreaterThan(0); // the poll itself still succeeded
    expect(result.warnings.filter((w) => w.includes('/state is unavailable'))).toHaveLength(1);
  });

  it('reports null before the start when only start_time is known', async () => {
    const { source } = await clockSource(routesWithout('/state'), START_MS - 60_000);
    expect((await source.fetchRuns(null)).contestTimeSec).toBeNull();
  });

  it('reports null for a contest that is not scheduled at all', async () => {
    const routes = routesWithout('/state');
    routes[ROOT] = { ...ccsContest, start_time: null };
    const { source } = await clockSource(routes, START_MS + HOUR);
    expect((await source.fetchRuns(null)).contestTimeSec).toBeNull();
  });

  it('derives the duration from end_time when duration is absent', async () => {
    const routes = routesWith('/state', stateDoc({ started: ccsContest.start_time }));
    routes[ROOT] = { ...ccsContest, duration: undefined, end_time: iso(START_MS + 2 * HOUR) };
    const { source } = await clockSource(routes, START_MS + 5 * HOUR);
    expect((await source.fetchRuns(null)).contestTimeSec).toBe(2 * 3600);
  });

  it('follows the judge clock from the Date header instead of a wrong local clock', async () => {
    const routes = routesWith('/state', stateDoc({ started: ccsContest.start_time }));
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!(url in routes)) return new Response('not found', { status: 404, statusText: 'Not Found' });
      return new Response(JSON.stringify(routes[url]), {
        status: 200,
        // The judge says one hour into the contest.
        headers: { 'Content-Type': 'application/json', date: new Date(START_MS + HOUR).toUTCString() },
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
      onWarning: () => {},
      // Operator's laptop is nine hours off.
      now: () => START_MS + 10 * HOUR,
    });
    await source.loadContest();
    expect((await source.fetchRuns(null)).contestTimeSec).toBe(3600);
  });
});

// --- P0-3 end of updates -----------------------------------------------------

describe('fetchRuns: end of the feed (P0-3)', () => {
  it('reports noMoreUpdate once end_of_updates is set', async () => {
    const routes = routesWith(
      '/state',
      stateDoc({
        started: ccsContest.start_time,
        ended: iso(START_MS + 5 * HOUR),
        finalized: iso(START_MS + 5 * HOUR),
        end_of_updates: iso(START_MS + 5 * HOUR),
      }),
    );
    const { source } = makeSource({ now: () => START_MS + 6 * HOUR }, routes);
    await source.loadContest();
    expect((await source.fetchRuns(null)).noMoreUpdate).toBe(true);
  });

  it('keeps the feed open while end_of_updates is null, even after finalization', async () => {
    const routes = routesWith(
      '/state',
      stateDoc({
        started: ccsContest.start_time,
        ended: iso(START_MS + 5 * HOUR),
        finalized: iso(START_MS + 5 * HOUR),
      }),
    );
    const { source } = makeSource({ now: () => START_MS + 6 * HOUR }, routes);
    await source.loadContest();
    expect((await source.fetchRuns(null)).noMoreUpdate).toBe(false);
  });

  it('reports the feed as open, once, when /state is unavailable', async () => {
    const { source, warnings } = makeSource({}, routesWithout('/state'));
    await source.loadContest();
    const first = await source.fetchRuns(null);
    const second = await source.fetchRuns(first.cursor);
    expect(first.noMoreUpdate).toBe(false);
    expect(second.noMoreUpdate).toBe(false);
    expect(warnings.filter((w) => w.includes('/state is unavailable'))).toHaveLength(1);
    expect(second.warnings).toEqual([]);
  });
});
