// @vitest-environment node
/**
 * `npm run convert`: DOMjudge Contest API in, spotboard static files out.
 * No network: the judge is a fetch stub. The project root is a temp folder, so
 * the real .env.local is never read.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConvertError,
  freezeMinuteFromContest,
  parseEnvFile,
  redactUrl,
  resolveSettings,
  runCli,
  runConvert,
  writeFileAtomic,
  type ConvertSettings,
} from '../../scripts/convert-domjudge';

const SECRET = 'reader:s3cr3t-pass';
const URL_ROOT = 'https://judge.test/api/v4';
const ROOT = `${URL_ROOT}/contests/c1`;

const tmp = mkdtempSync(join(tmpdir(), 'kimchi-convert-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
/** A fresh fake project root with an empty public/ folder. */
function makeProject(): string {
  const root = join(tmp, `project-${counter++}`);
  mkdirSync(join(root, 'public'), { recursive: true });
  return root;
}

const goodEnv = { KIMCHI_JUDGE_URL: URL_ROOT, KIMCHI_JUDGE_CRED: SECRET };

// --- Fake judge ---------------------------------------------------------------

const baseRoutes = (): Record<string, unknown> => ({
  [ROOT]: {
    id: 'c1',
    formal_name: 'Test Contest',
    start_time: '2026-10-17T10:00:00+00:00',
    duration: '5:00:00',
    scoreboard_freeze_duration: '1:00:00',
  },
  [`${ROOT}/access`]: { endpoints: [{ type: 'submissions' }, { type: 'judgements' }] },
  [`${ROOT}/state`]: { started: '2026-10-17T10:00:00+00:00', ended: null, thawed: null, end_of_updates: null },
  [`${ROOT}/problems`]: [
    { id: 'p1', label: 'A', name: 'Alpha', rgb: '#ff0000', ordinal: 0 },
    { id: 'p2', label: 'B', name: 'Beta', rgb: '#00ff00', ordinal: 1 },
  ],
  [`${ROOT}/teams?public=true`]: [
    { id: 't1', name: 'One', organization_id: 'o1' },
    { id: 't2', name: 'Two', affiliation: 'Free Text U' },
  ],
  [`${ROOT}/organizations`]: [{ id: 'o1', name: 'KAIST', formal_name: 'KAIST', country: 'KOR' }],
  [`${ROOT}/judgement-types`]: [
    { id: 'AC', solved: true, penalty: false },
    { id: 'WA', solved: false, penalty: true },
    { id: 'CE', solved: false, penalty: false },
  ],
  [`${ROOT}/submissions`]: [
    { id: 's1', team_id: 't1', problem_id: 'p1', contest_time: '1:00:00.000' },
    { id: 's2', team_id: 't1', problem_id: 'p2', contest_time: '3:59:59.000' },
    { id: 's3', team_id: 't2', problem_id: 'p1', contest_time: '4:00:00.000' }, // frozen
    { id: 's4', team_id: 't2', problem_id: 'p2', contest_time: '4:30:00.000' }, // frozen
    { id: 's5', team_id: 't2', problem_id: 'p2', contest_time: '0:10:00.000' },
  ],
  [`${ROOT}/judgements`]: [
    { id: 'j1', submission_id: 's1', judgement_type_id: 'AC', valid: true, end_contest_time: '1:00:10.000' },
    { id: 'j2', submission_id: 's2', judgement_type_id: 'WA', valid: true, end_contest_time: '4:00:10.000' },
    { id: 'j3', submission_id: 's3', judgement_type_id: 'AC', valid: true, end_contest_time: '4:00:30.000' },
    { id: 'j4', submission_id: 's4', judgement_type_id: 'WA', valid: true, end_contest_time: '4:30:30.000' },
    { id: 'j5', submission_id: 's5', judgement_type_id: 'CE', valid: true, end_contest_time: '0:10:10.000' },
  ],
});

interface Judge {
  routes: Record<string, unknown>;
  calls: Array<{ url: string; authorization: string | null }>;
  /** While true every request answers 500. */
  down: boolean;
  fetchImpl: typeof fetch;
}

function makeJudge(): Judge {
  const judge: Judge = {
    routes: baseRoutes(),
    calls: [],
    down: false,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      judge.calls.push({ url, authorization: headers.get('authorization') });
      if (judge.down) return new Response('boom', { status: 500, statusText: 'Server Error' });
      if (!(url in judge.routes)) return new Response('nope', { status: 404, statusText: 'Not Found' });
      return new Response(JSON.stringify(judge.routes[url]), { status: 200 });
    }) as typeof fetch,
  };
  return judge;
}

function settings(outDir: string, extra: Partial<ConvertSettings> = {}): ConvertSettings {
  return {
    contestId: 'c1',
    outDir,
    intervalSeconds: null,
    unfreeze: false,
    followThaw: false,
    baseUrl: URL_ROOT,
    auth: { username: 'reader', password: 's3cr3t-pass' },
    ...extra,
  };
}

const NOW = Date.parse('2026-10-17T11:00:00+00:00');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

// --- Arguments and environment -------------------------------------------------

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines', () => {
    expect(
      parseEnvFile(
        ['# comment', '', 'A=1', 'export B="two words"', "C='x:y'", 'D=u:p=q', 'no equals', '=bad'].join('\n'),
      ),
    ).toEqual({ A: '1', B: 'two words', C: 'x:y', D: 'u:p=q' });
  });
});

describe('resolveSettings', () => {
  it('needs --contest', () => {
    expect(() => resolveSettings([], { env: goodEnv, projectRoot: makeProject() })).toThrow(/--contest is required/);
  });

  it('applies the defaults', () => {
    const s = resolveSettings(['--', '--contest', 'c1'], { env: goodEnv, projectRoot: makeProject() });
    expect(s).toMatchObject({
      contestId: 'c1',
      intervalSeconds: null,
      unfreeze: false,
      baseUrl: URL_ROOT,
      auth: { username: 'reader', password: 's3cr3t-pass' },
    });
    expect(s.outDir.endsWith('feed-out')).toBe(true);
  });

  it('refuses an interval below 10 seconds, accepts 10', () => {
    const deps = { env: goodEnv, projectRoot: makeProject() };
    expect(() => resolveSettings(['--contest', 'c1', '--interval', '9'], deps)).toThrow(ConvertError);
    expect(() => resolveSettings(['--contest', 'c1', '--interval', '0'], deps)).toThrow(/minimum is 10/);
    expect(() => resolveSettings(['--contest', 'c1', '--interval', 'soon'], deps)).toThrow(/number of seconds/);
    expect(resolveSettings(['--contest', 'c1', '--interval', '10'], deps).intervalSeconds).toBe(10);
    expect(resolveSettings(['--contest=c1', '--interval=30'], deps).intervalSeconds).toBe(30);
  });

  it('errors without a credential or a URL', () => {
    const root = makeProject();
    expect(() => resolveSettings(['--contest', 'c1'], { env: { KIMCHI_JUDGE_URL: URL_ROOT }, projectRoot: root })).toThrow(
      /No credential/,
    );
    expect(() => resolveSettings(['--contest', 'c1'], { env: { KIMCHI_JUDGE_CRED: SECRET }, projectRoot: root })).toThrow(
      /No judge URL/,
    );
    // --url fills the URL.
    expect(
      resolveSettings(['--contest', 'c1', '--url', 'https://other/api'], { env: { KIMCHI_JUDGE_CRED: SECRET }, projectRoot: root })
        .baseUrl,
    ).toBe('https://other/api');
  });

  it('never repeats a malformed credential', () => {
    let message = '';
    try {
      resolveSettings(['--contest', 'c1'], {
        env: { KIMCHI_JUDGE_URL: URL_ROOT, KIMCHI_JUDGE_CRED: 'nocolonhere-secret' },
        projectRoot: makeProject(),
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/user:password/);
    expect(message).not.toContain('nocolonhere-secret');
  });

  it('reads .env.local for what process.env lacks; process.env wins', () => {
    const root = makeProject();
    writeFileSync(join(root, '.env.local'), `KIMCHI_JUDGE_URL=https://file/api\nKIMCHI_JUDGE_CRED=fileuser:filepass\n`);
    const fromFile = resolveSettings(['--contest', 'c1'], { env: {}, projectRoot: root });
    expect(fromFile.baseUrl).toBe('https://file/api');
    expect(fromFile.auth).toEqual({ username: 'fileuser', password: 'filepass' });

    const mixed = resolveSettings(['--contest', 'c1'], { env: { KIMCHI_JUDGE_CRED: 'envuser:envpass' }, projectRoot: root });
    expect(mixed.baseUrl).toBe('https://file/api');
    expect(mixed.auth.username).toBe('envuser');
  });

  it('refuses --unfreeze into public/, also through a link and a new subfolder', () => {
    const root = makeProject();
    const deps = { env: goodEnv, projectRoot: root };
    const args = (out: string) => ['--contest', 'c1', '--unfreeze', '--out', out];
    expect(() => resolveSettings(args(join(root, 'public')), deps)).toThrow(/inside public\//);
    expect(() => resolveSettings(args(join(root, 'public', 'feed', 'deep')), deps)).toThrow(ConvertError);

    const link = join(tmp, `link-${counter++}`);
    symlinkSync(join(root, 'public'), link);
    expect(() => resolveSettings(args(join(link, 'feed')), deps)).toThrow(/inside public\//);

    // dist/ and publish-dist/ are served or uploaded as well.
    expect(() => resolveSettings(args(join(root, 'dist')), deps)).toThrow(/inside dist\//);
    expect(() => resolveSettings(args(join(root, 'publish-dist', 'x')), deps)).toThrow(/inside publish-dist\//);

    // Outside public/ is fine, and so is a frozen output inside public/.
    expect(resolveSettings(args(join(root, 'feed-out')), deps).unfreeze).toBe(true);
    expect(
      resolveSettings(['--contest', 'c1', '--out', join(root, 'public', 'feed')], deps).unfreeze,
    ).toBe(false);
  });
});

describe('resolveSettings: guards', () => {
  const args = (out: string) => ['--contest', 'c1', '--unfreeze', '--out', out];

  it('treats a folder named "..foo" in public/ as inside, and a sibling "..foo" as outside', () => {
    const root = makeProject();
    const deps = { env: goodEnv, projectRoot: root };
    expect(() => resolveSettings(args(join(root, 'public', '..foo')), deps)).toThrow(/inside public\//);
    expect(() => resolveSettings(args(join(root, 'public', '..foo', 'x')), deps)).toThrow(/inside public\//);
    expect(resolveSettings(args(join(root, '..foo')), deps).unfreeze).toBe(true);
  });

  it('ignores case, as case-insensitive disks do', () => {
    const root = makeProject();
    const deps = { env: goodEnv, projectRoot: root };
    expect(() => resolveSettings(args(join(root, 'PUBLIC', 'x')), deps)).toThrow(/inside public\//);
    expect(() => resolveSettings(args(join(root, 'Public')), deps)).toThrow(/inside public\//);
    expect(() => resolveSettings(args(join(root, 'Publish-Dist')), deps)).toThrow(/inside publish-dist\//);
  });

  it('refuses an interval above the timer limit', () => {
    const deps = { env: goodEnv, projectRoot: makeProject() };
    expect(() => resolveSettings(['--contest', 'c1', '--interval', '3000000'], deps)).toThrow(/too long/);
    expect(resolveSettings(['--contest', 'c1', '--interval', '2147483'], deps).intervalSeconds).toBe(2147483);
  });

  it('refuses a URL with a login, and never repeats it', () => {
    const root = makeProject();
    const secretUrl = 'https://bob:hunter2pw@judge.test/api/v4';
    for (const deps of [
      { env: goodEnv, projectRoot: root, extra: ['--url', secretUrl] },
      { env: { ...goodEnv, KIMCHI_JUDGE_URL: secretUrl }, projectRoot: root, extra: [] as string[] },
    ]) {
      let message = '';
      try {
        resolveSettings(['--contest', 'c1', ...deps.extra], deps);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/must not contain a user name or password/);
      expect(message).not.toContain('hunter2pw');
      expect(message).not.toContain('bob');
    }
    expect(() => resolveSettings(['--contest', 'c1', '--url', 'not a url'], { env: goodEnv, projectRoot: root })).toThrow(
      /not a valid URL/,
    );
  });
});

describe('redactUrl', () => {
  it('hides a login in a URL', () => {
    expect(redactUrl('failed (https://bob:pw@judge.test/api)')).toBe('failed (https://***@judge.test/api)');
    expect(redactUrl('https://judge.test/api')).toBe('https://judge.test/api');
  });
});

describe('runCli', () => {
  it('prints the error and returns 1 (no credential)', async () => {
    const lines: string[] = [];
    const code = await runCli(['--contest', 'c1'], {
      env: { KIMCHI_JUDGE_URL: URL_ROOT },
      projectRoot: makeProject(),
      error: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/No credential/);
  });

  it('returns 1 for --unfreeze into public/, and writes nothing', async () => {
    const root = makeProject();
    const out = join(root, 'public', 'feed');
    const judge = makeJudge();
    const lines: string[] = [];
    const code = await runCli(['--contest', 'c1', '--unfreeze', '--out', out], {
      env: goodEnv,
      projectRoot: root,
      fetchImpl: judge.fetchImpl,
      error: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/inside public\//);
    expect(existsSync(out)).toBe(false);
    expect(judge.calls).toHaveLength(0);
  });

  it('returns 1 for an interval below 10', async () => {
    const judge = makeJudge();
    const code = await runCli(['--contest', 'c1', '--interval', '5'], {
      env: goodEnv,
      projectRoot: makeProject(),
      fetchImpl: judge.fetchImpl,
      error: () => {},
    });
    expect(code).toBe(1);
    expect(judge.calls).toHaveLength(0);
  });
});

// --- Freeze information ---------------------------------------------------------

describe('freezeMinuteFromContest', () => {
  it('is duration minus freeze duration, rounded down to a minute', () => {
    expect(freezeMinuteFromContest({ duration: '5:00:00', scoreboard_freeze_duration: '1:00:00' })).toBe(240);
    expect(freezeMinuteFromContest({ duration: '5:00:00.000', scoreboard_freeze_duration: '0:59:30.000' })).toBe(240);
  });

  it('is null for a contest without a freeze', () => {
    expect(freezeMinuteFromContest({ duration: '5:00:00', scoreboard_freeze_duration: null })).toBeNull();
  });

  it('fails closed when the freeze is not stated or not readable', () => {
    expect(() => freezeMinuteFromContest({ duration: '5:00:00' })).toThrow(ConvertError);
    expect(() => freezeMinuteFromContest({ duration: 'x', scoreboard_freeze_duration: '1:00:00' })).toThrow(ConvertError);
  });
});

// --- Atomic write -----------------------------------------------------------------

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp file', () => {
    const dir = join(tmp, `atomic-${counter++}`);
    mkdirSync(dir);
    const path = join(dir, 'runs.json');
    writeFileAtomic(path, 'one');
    writeFileAtomic(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['runs.json']);
  });

  it('keeps the old file and cleans up when the write fails', () => {
    const dir = join(tmp, `atomic-${counter++}`);
    mkdirSync(dir);
    const path = join(dir, 'runs.json');
    writeFileAtomic(path, 'good');
    // Renaming a file over a folder fails.
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked);
    expect(() => writeFileAtomic(blocked, 'x')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('good');
    expect(readdirSync(dir).sort()).toEqual(['blocked', 'runs.json']);
  });
});

// --- One run against the fake judge ------------------------------------------------

describe('runConvert (once)', () => {
  let judge: Judge;
  let out: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    judge = makeJudge();
    out = join(tmp, `out-${counter++}`);
    logs = [];
    errors = [];
  });

  const run = (s: ConvertSettings) =>
    runConvert(s, { fetchImpl: judge.fetchImpl, log: (l) => logs.push(l), error: (l) => errors.push(l), now: () => NOW });

  it('writes contest.json and a frozen runs.json', async () => {
    expect(await run(settings(out))).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['contest.json', 'runs.json']);

    const contest = readJson(join(out, 'contest.json'));
    expect(contest.title).toBe('Test Contest');
    expect(contest.problems).toEqual([
      { id: 'p1', name: 'A', title: 'Alpha', color: '#ff0000' },
      { id: 'p2', name: 'B', title: 'Beta', color: '#00ff00' },
    ]);
    expect(contest.teams).toEqual([
      { id: 't1', name: 'One', group: 'KAIST' },
      { id: 't2', name: 'Two', group: 'Free Text U' },
    ]);

    const runs = readJson(join(out, 'runs.json'));
    expect(runs.kimchiUnfrozen).toBeUndefined();
    expect(runs.time.contestTime).toBe(3600); // NOW is one hour after the start
    expect(runs.time.noMoreUpdate).toBe(false);
    expect(runs.runs).toEqual([
      { id: 1, team: 't1', problem: 'p1', result: 'Yes', submissionTime: 60 },
      { id: 2, team: 't1', problem: 'p2', result: 'No', submissionTime: 239 },
      { id: 3, team: 't2', problem: 'p1', result: '', submissionTime: 240 },
      { id: 4, team: 't2', problem: 'p2', result: '', submissionTime: 270 },
      { id: 5, team: 't2', problem: 'p2', result: 'No (no penalty)', submissionTime: 10 },
    ]);
  });

  it('sends the credential only as a header, and never prints or writes it', async () => {
    await run(settings(out));
    const expected = `Basic ${Buffer.from(SECRET).toString('base64')}`;
    expect(judge.calls.length).toBeGreaterThan(0);
    for (const call of judge.calls) {
      expect(call.authorization).toBe(expected);
      expect(call.url).not.toContain('s3cr3t');
    }
    const everything = [
      ...logs,
      ...errors,
      readFileSync(join(out, 'contest.json'), 'utf8'),
      readFileSync(join(out, 'runs.json'), 'utf8'),
    ].join('\n');
    expect(everything).not.toContain('s3cr3t-pass');
    expect(everything).not.toContain(Buffer.from(SECRET).toString('base64'));
  });

  it('--unfreeze keeps the real results and marks the file', async () => {
    expect(await run(settings(out, { unfreeze: true }))).toBe(0);
    const runs = readJson(join(out, 'runs.json'));
    expect(runs.kimchiUnfrozen).toBe(true);
    expect(runs.runs.map((r: { result: string }) => r.result)).toEqual(['Yes', 'No', 'Yes', 'No', 'No (no penalty)']);
  });

  it('keeps the mask after DOMjudge thaws, without --follow-thaw', async () => {
    judge.routes[`${ROOT}/state`] = {
      started: '2026-10-17T10:00:00+00:00',
      thawed: '2026-10-17T11:30:00+00:00',
      finalized: '2026-10-17T11:20:00+00:00',
    };
    await run(settings(out));
    expect(readJson(join(out, 'runs.json')).runs[2].result).toBe('');
  });

  it('--follow-thaw lifts the mask once DOMjudge has thawed the scoreboard', async () => {
    judge.routes[`${ROOT}/state`] = { started: '2026-10-17T10:00:00+00:00', thawed: '2026-10-17T11:30:00+00:00' };
    await run(settings(out, { followThaw: true }));
    const runs = readJson(join(out, 'runs.json'));
    expect(runs.kimchiUnfrozen).toBeUndefined();
    expect(runs.runs[2].result).toBe('Yes');
  });

  it('--follow-thaw keeps the mask when the contest is only finalized (the ceremony gap)', async () => {
    judge.routes[`${ROOT}/state`] = { started: '2026-10-17T10:00:00+00:00', thawed: null, finalized: '2026-10-17T16:00:00+00:00' };
    await run(settings(out, { followThaw: true }));
    expect(readJson(join(out, 'runs.json')).runs[2].result).toBe('');
  });

  it('parses --follow-thaw', () => {
    const deps = { env: goodEnv, projectRoot: makeProject() };
    expect(resolveSettings(['--contest', 'c1', '--follow-thaw'], deps).followThaw).toBe(true);
    expect(resolveSettings(['--contest', 'c1'], deps).followThaw).toBe(false);
  });

  it('keeps the mask when /state cannot be read', async () => {
    delete judge.routes[`${ROOT}/state`];
    await run(settings(out, { followThaw: true }));
    expect(readJson(join(out, 'runs.json')).runs[2].result).toBe('');
  });

  it('writes no freeze mask for a contest without a freeze', async () => {
    (judge.routes[ROOT] as Record<string, unknown>).scoreboard_freeze_duration = null;
    await run(settings(out));
    expect(readJson(join(out, 'runs.json')).runs[2].result).toBe('Yes');
  });

  it('fails closed when the freeze is not stated', async () => {
    delete (judge.routes[ROOT] as Record<string, unknown>).scoreboard_freeze_duration;
    expect(await run(settings(out))).toBe(1);
    expect(errors.join('\n')).toMatch(/scoreboard_freeze_duration/);
    expect(existsSync(join(out, 'runs.json'))).toBe(false);
  });

  it('reports a failed judge as exit code 1', async () => {
    judge.down = true;
    expect(await run(settings(out))).toBe(1);
    expect(errors).toHaveLength(1);
    expect(existsSync(join(out, 'runs.json'))).toBe(false);
  });
});

// --- Polling --------------------------------------------------------------------------

describe('runConvert (--interval)', () => {
  it('keeps polling, keeps the last good files on a failed poll, and stops on abort', async () => {
    const judge = makeJudge();
    const out = join(tmp, `out-${counter++}`);
    const logs: string[] = [];
    const errors: string[] = [];
    const controller = new AbortController();
    const sleeps: number[] = [];
    const seen: string[] = [];

    const code = await runConvert(settings(out, { intervalSeconds: 10 }), {
      fetchImpl: judge.fetchImpl,
      log: (l) => logs.push(l),
      error: (l) => errors.push(l),
      now: () => NOW,
      signal: controller.signal,
      sleep: async (ms) => {
        sleeps.push(ms);
        seen.push(readFileSync(join(out, 'runs.json'), 'utf8'));
        if (sleeps.length === 1) {
          // Between poll 1 and 2 the judge breaks.
          judge.down = true;
        } else if (sleeps.length === 2) {
          // Between poll 2 and 3 it recovers, and returns the list in another order.
          judge.down = false;
          const subs = judge.routes[`${ROOT}/submissions`] as unknown[];
          judge.routes[`${ROOT}/submissions`] = [...subs].reverse();
        } else {
          controller.abort();
        }
      },
    });

    expect(code).toBe(0);
    expect(sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/poll failed \(last files kept\)/);
    // Poll 2 failed: the file was not touched.
    expect(seen[1]).toBe(seen[0]);
    // Poll 3 read the list reversed, yet the cursor keeps every id where it was.
    const after = readJson(join(out, 'runs.json'));
    expect(after.runs.map((r: { id: number }) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(after.runs[0]).toMatchObject({ team: 't1', problem: 'p1' });
    expect(logs[logs.length - 1]).toMatch(/stopped/);
    expect(readdirSync(out).sort()).toEqual(['contest.json', 'runs.json']);
  });

  it('stops by itself when the judge ends the feed', async () => {
    const judge = makeJudge();
    judge.routes[`${ROOT}/state`] = {
      started: '2026-10-17T10:00:00+00:00',
      finalized: '2026-10-17T16:00:00+00:00',
      end_of_updates: '2026-10-17T16:00:00+00:00',
    };
    const out = join(tmp, `out-${counter++}`);
    let slept = 0;
    const code = await runConvert(settings(out, { intervalSeconds: 10 }), {
      fetchImpl: judge.fetchImpl,
      log: () => {},
      error: () => {},
      now: () => NOW,
      sleep: async () => {
        slept++;
      },
    });
    expect(code).toBe(0);
    expect(slept).toBe(0);
    expect(readJson(join(out, 'runs.json')).time.noMoreUpdate).toBe(true);
  });

  it('without --follow-thaw, end_of_updates is final and the mask stays', async () => {
    const judge = makeJudge();
    judge.routes[`${ROOT}/state`] = { started: '2026-10-17T10:00:00+00:00', thawed: null, end_of_updates: '2026-10-17T16:00:00+00:00' };
    const out = join(tmp, `out-${counter++}`);
    let slept = 0;
    const code = await runConvert(settings(out, { intervalSeconds: 10 }), {
      fetchImpl: judge.fetchImpl,
      log: () => {},
      error: () => {},
      now: () => NOW,
      sleep: async () => {
        slept++;
      },
    });
    expect(code).toBe(0);
    expect(slept).toBe(0);
    const runs = readJson(join(out, 'runs.json'));
    expect(runs.time.noMoreUpdate).toBe(true);
    expect(runs.runs[2].result).toBe('');
  });

  it('--follow-thaw: does not stop on end_of_updates while the freeze mask holds, and stops after the thaw', async () => {
    const judge = makeJudge();
    judge.routes[`${ROOT}/state`] = { started: '2026-10-17T10:00:00+00:00', thawed: null, end_of_updates: '2026-10-17T16:00:00+00:00' };
    const out = join(tmp, `out-${counter++}`);
    const logs: string[] = [];
    let slept = 0;
    const code = await runConvert(settings(out, { intervalSeconds: 10, followThaw: true }), {
      fetchImpl: judge.fetchImpl,
      log: (l) => logs.push(l),
      error: () => {},
      now: () => NOW,
      sleep: async () => {
        slept++;
        const runs = readJson(join(out, 'runs.json'));
        if (slept === 1) {
          // Masked, and the board is not told to stop.
          expect(runs.time.noMoreUpdate).toBe(false);
          expect(runs.runs[2].result).toBe('');
          judge.routes[`${ROOT}/state`] = {
            started: '2026-10-17T10:00:00+00:00',
            thawed: '2026-10-17T16:05:00+00:00',
            end_of_updates: '2026-10-17T16:05:00+00:00',
          };
        }
      },
    });
    expect(code).toBe(0);
    expect(slept).toBe(1);
    const runs = readJson(join(out, 'runs.json'));
    expect(runs.time.noMoreUpdate).toBe(true);
    expect(runs.runs[2].result).toBe('Yes');
    expect(logs.filter((l) => /still polling/.test(l))).toHaveLength(1);
  });

  it('keeps the old contest when a later reload says nothing about the freeze (ConvertError)', async () => {
    const judge = makeJudge();
    const out = join(tmp, `out-${counter++}`);
    const controller = new AbortController();
    const errors: string[] = [];
    let slept = 0;
    // RELOAD_EVERY is 10: poll 11 reloads the contest.
    const code = await runConvert(settings(out, { intervalSeconds: 10 }), {
      fetchImpl: judge.fetchImpl,
      log: () => {},
      error: (l) => errors.push(l),
      now: () => NOW,
      signal: controller.signal,
      sleep: async () => {
        slept++;
        if (slept === 10) {
          delete (judge.routes[ROOT] as Record<string, unknown>).scoreboard_freeze_duration;
        }
        if (slept === 11) controller.abort();
      },
    });
    expect(code).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/contest reload failed, keeping the old one/);
    // The old freeze minute still masks.
    expect(readJson(join(out, 'runs.json')).runs[2].result).toBe('');
  });

  it('says "last files kept" only when a file was written', async () => {
    const judge = makeJudge();
    // fetchRuns fails after loadContest succeeded.
    delete judge.routes[`${ROOT}/submissions`];
    const out = join(tmp, `out-${counter++}`);
    const controller = new AbortController();
    const errors: string[] = [];
    await runConvert(settings(out, { intervalSeconds: 10 }), {
      fetchImpl: judge.fetchImpl,
      log: () => {},
      error: (l) => errors.push(l),
      now: () => NOW,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/poll failed:/);
    expect(errors[0]).not.toMatch(/last files kept/);
    expect(existsSync(join(out, 'runs.json'))).toBe(false);
  });

  it('retries a failing first poll, and gives up at once on a setup error', async () => {
    const judge = makeJudge();
    judge.down = true;
    const out = join(tmp, `out-${counter++}`);
    const controller = new AbortController();
    let polls = 0;
    const code = await runConvert(settings(out, { intervalSeconds: 10 }), {
      fetchImpl: judge.fetchImpl,
      log: () => {},
      error: () => {},
      now: () => NOW,
      signal: controller.signal,
      sleep: async () => {
        polls++;
        if (polls === 1) judge.down = false;
        else controller.abort();
      },
    });
    expect(code).toBe(0);
    expect(existsSync(join(out, 'runs.json'))).toBe(true);

    delete (judge.routes[ROOT] as Record<string, unknown>).scoreboard_freeze_duration;
    const fatal = await runConvert(settings(join(tmp, `out-${counter++}`), { intervalSeconds: 10 }), {
      fetchImpl: judge.fetchImpl,
      log: () => {},
      error: () => {},
      now: () => NOW,
      sleep: async () => {
        throw new Error('must not sleep');
      },
    });
    expect(fatal).toBe(1);
  });
});

// --- Build guard for unfrozen output -------------------------------------------------------

describe('check-config-security.mjs', () => {
  const script = readFileSync(join(__dirname, '..', '..', 'scripts', 'check-config-security.mjs'), 'utf8');

  function check(runsJson: string | null, env: Record<string, string> = {}) {
    const root = makeProject();
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'check-config-security.mjs'), script);
    if (runsJson !== null) {
      mkdirSync(join(root, 'public', 'feed'));
      writeFileSync(join(root, 'public', 'feed', 'runs.json'), runsJson);
    }
    return spawnSync(process.execPath, [join(root, 'scripts', 'check-config-security.mjs')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
  }

  it('fails the build on an unfrozen runs.json under public/', () => {
    const result = check('{"kimchiUnfrozen":true,"time":{},"runs":[]}');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('public/feed/runs.json');
  });

  it('also scans dist/ and publish-dist/', () => {
    for (const folder of ['dist', 'publish-dist']) {
      const root = makeProject();
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'scripts', 'check-config-security.mjs'), script);
      mkdirSync(join(root, folder));
      writeFileSync(join(root, folder, 'runs.json'), '{"kimchiUnfrozen":true,"runs":[]}');
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-config-security.mjs')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${folder}/runs.json`);
    }
  });

  it('passes a frozen runs.json and an empty public/', () => {
    expect(check('{"time":{},"runs":[]}').status).toBe(0);
    expect(check(null).status).toBe(0);
  });

  it('can be overridden for a private deployment', () => {
    expect(check('{"kimchiUnfrozen": true}', { ALLOW_PUBLIC_AUTH: '1' }).status).toBe(0);
  });
});
