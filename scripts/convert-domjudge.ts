/**
 * `npm run convert -- --contest <id> [--out <dir>] [--interval <seconds>] [--unfreeze] [--url <api root>]`
 *
 * In-repo replacement for spotboard/domjudge-converter. Reads the DOMjudge
 * Contest API through the app's own adapter (src/core/ingest/contest-api.ts)
 * and writes the spotboard static files contest.json + runs.json into --out.
 * The 'spotboard' source (or the original Spotboard) serves them with no
 * credential. See docs/operations.md, "DOMjudge -> spotboard converter".
 *
 * The credential comes from KIMCHI_JUDGE_CRED ("user:password"), the judge URL
 * from --url or KIMCHI_JUDGE_URL. Both are read from process.env first, then
 * from the git-ignored .env.local. The credential is never printed and never
 * written to an output file.
 *
 * Freeze: a run at or after the freeze minute is written as pending, like the
 * original converter, until DOMjudge itself thaws the scoreboard. --unfreeze
 * keeps the real results; it is refused for an --out folder inside public/,
 * dist/ or publish-dist/.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContestApiSource, parseContestTimeSeconds } from '../src/core/ingest/contest-api';
import { toSpotboardContest, toSpotboardRuns } from '../src/core/ingest/spotboard-export';
import type { Contest } from '../src/core/types';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_OUT_DIR = 'feed-out';
/** Shortest poll interval. The adapter re-reads the whole feed on each poll. */
export const MIN_INTERVAL_SECONDS = 10;
/** setTimeout takes at most 2^31-1 ms; a larger value fires after 1 ms (a tight loop on the judge). */
export const MAX_INTERVAL_SECONDS = 2_147_483;
/** Folders that are served or uploaded as they are: unfrozen output must not go there. */
const PUBLIC_FOLDERS = ['public', 'dist', 'publish-dist'];
/** The contest (teams, problems, judgement types) is reloaded every N polls. */
const RELOAD_EVERY = 10;
const FETCH_TIMEOUT_MS = 15_000;

/** Hides a login in a URL before it reaches a log line. */
export function redactUrl(text: string): string {
  return text.replace(/(\w+:\/\/)[^/\s@]*@/g, '$1***@');
}

/** Failure the CLI prints as is (no stack) before it exits with code 1. */
export class ConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvertError';
  }
}

export interface ConvertSettings {
  contestId: string;
  /** Absolute. */
  outDir: string;
  /** null: run once. */
  intervalSeconds: number | null;
  unfreeze: boolean;
  baseUrl: string;
  auth: { username: string; password: string };
}

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

/** KEY=VALUE lines. `#` comments, blank lines, `export ` prefix, one pair of quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

interface RawArgs {
  contest?: string;
  out?: string;
  interval?: string;
  unfreeze: boolean;
  url?: string;
}

const VALUE_FLAGS = new Set(['contest', 'out', 'interval', 'url']);

function parseArgs(argv: readonly string[]): RawArgs {
  const raw: RawArgs = { unfreeze: false };
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new ConvertError(`Unexpected argument "${arg}". ${USAGE}`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === 'unfreeze') {
      raw.unfreeze = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new ConvertError(`Unknown option "--${name}". ${USAGE}`);
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') throw new ConvertError(`--${name} needs a value. ${USAGE}`);
    raw[name as 'contest' | 'out' | 'interval' | 'url'] = value;
  }
  return raw;
}

const USAGE =
  'Usage: npm run convert -- --contest <id> [--out <dir>] [--interval <seconds>] [--unfreeze] [--url <api root>]';

/**
 * Resolves symlinks of the deepest existing ancestor, so a link cannot hide a
 * folder. Lower case: macOS and Windows disks ignore case, so "PUBLIC" is
 * public/. On a case-sensitive disk this refuses a little more, which is safe.
 */
function realResolve(path: string): string {
  const abs = resolve(path);
  const rest: string[] = [];
  let current = abs;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return abs.toLowerCase();
    rest.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync.native(current), ...rest).toLowerCase();
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  // "..foo" is a normal folder name; only ".." and "../x" leave the parent.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Unfrozen output holds the verdicts of the freeze. public/ is copied into
 * dist/ by the build, dist/ is served, and publish-dist/ is uploaded by hand.
 */
export function assertOutDirAllowed(outDir: string, unfreeze: boolean, projectRoot: string = PROJECT_ROOT): void {
  if (!unfreeze) return;
  const target = realResolve(outDir);
  for (const folder of PUBLIC_FOLDERS) {
    if (isInside(target, realResolve(join(projectRoot, folder)))) {
      throw new ConvertError(
        `Refusing --unfreeze with --out ${outDir}: it is inside ${folder}/, which is served or uploaded ` +
          'to everyone. Use a folder outside public/, dist/ and publish-dist/.',
      );
    }
  }
}

export interface SettingsDeps {
  env?: Record<string, string | undefined>;
  projectRoot?: string;
}

/** Validates the CLI arguments and the environment. Throws ConvertError. */
export function resolveSettings(argv: readonly string[], deps: SettingsDeps = {}): ConvertSettings {
  const env = deps.env ?? process.env;
  const projectRoot = deps.projectRoot ?? PROJECT_ROOT;
  const raw = parseArgs(argv);

  if (raw.contest === undefined) throw new ConvertError(`--contest is required. ${USAGE}`);

  let intervalSeconds: number | null = null;
  if (raw.interval !== undefined) {
    const n = Number(raw.interval);
    if (!Number.isFinite(n)) throw new ConvertError(`--interval must be a number of seconds, got "${raw.interval}".`);
    if (n < MIN_INTERVAL_SECONDS) {
      throw new ConvertError(
        `--interval ${raw.interval} is too short. The minimum is ${MIN_INTERVAL_SECONDS} seconds ` +
          'because every poll reads the whole feed from the judge.',
      );
    }
    if (n > MAX_INTERVAL_SECONDS) {
      throw new ConvertError(`--interval ${raw.interval} is too long. The maximum is ${MAX_INTERVAL_SECONDS} seconds.`);
    }
    intervalSeconds = n;
  }

  const outDir = resolve(raw.out ?? DEFAULT_OUT_DIR);
  assertOutDirAllowed(outDir, raw.unfreeze, projectRoot);

  // process.env wins; .env.local fills only what is missing.
  let fileEnv: Record<string, string> | undefined;
  const lookup = (key: string): string | undefined => {
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    if (fileEnv === undefined) {
      const path = join(projectRoot, '.env.local');
      fileEnv = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
    }
    const fromFile = fileEnv[key];
    return fromFile !== undefined && fromFile !== '' ? fromFile : undefined;
  };

  const baseUrl = raw.url ?? lookup('KIMCHI_JUDGE_URL');
  if (baseUrl === undefined) {
    throw new ConvertError('No judge URL. Pass --url or set KIMCHI_JUDGE_URL (environment or .env.local).');
  }
  // The URL must not carry a login: fetch would echo it in its error text.
  // Neither the URL nor the login is repeated here.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new ConvertError('The judge URL is not a valid URL.');
  }
  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    throw new ConvertError(
      'The judge URL must not contain a user name or password. Put them in KIMCHI_JUDGE_CRED ("user:password").',
    );
  }
  const cred = lookup('KIMCHI_JUDGE_CRED');
  if (cred === undefined) {
    throw new ConvertError('No credential. Set KIMCHI_JUDGE_CRED="user:password" (environment or .env.local).');
  }
  const colon = cred.indexOf(':');
  if (colon <= 0) {
    // The value itself is never echoed.
    throw new ConvertError('KIMCHI_JUDGE_CRED must look like "user:password".');
  }
  return {
    contestId: raw.contest,
    outDir,
    intervalSeconds,
    unfreeze: raw.unfreeze,
    baseUrl,
    auth: { username: cred.slice(0, colon), password: cred.slice(colon + 1) },
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Writes a temp file in the same folder, then renames it: a reader never sees half a file. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Freeze information
// ---------------------------------------------------------------------------

/**
 * First frozen contest minute from GET /contests/{id}: (duration - freeze
 * duration), rounded down to a whole minute, which masks slightly more rather
 * than less. null when the contest has no freeze. Fails closed: a document
 * that does not say either way is an error, never "no freeze".
 */
export function freezeMinuteFromContest(rawContest: unknown): number | null {
  const doc = (rawContest ?? {}) as { duration?: unknown; scoreboard_freeze_duration?: unknown };
  if (!('scoreboard_freeze_duration' in doc)) {
    throw new ConvertError(
      'The contest has no "scoreboard_freeze_duration" field, so the freeze time is unknown. ' +
        'Refusing to publish real verdicts. Use --unfreeze only if that is intended.',
    );
  }
  if (doc.scoreboard_freeze_duration === null) return null;
  const freezeSec = parseContestTimeSeconds(doc.scoreboard_freeze_duration as string);
  const durationSec = parseContestTimeSeconds(doc.duration as string);
  if (freezeSec === undefined || durationSec === undefined) {
    throw new ConvertError(
      'Cannot read "duration" and "scoreboard_freeze_duration" of the contest. ' +
        'Refusing to publish real verdicts. Use --unfreeze only if that is intended.',
    );
  }
  return Math.max(0, Math.floor((durationSec - freezeSec) / 60));
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

export interface RunDeps {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Resolves after ms, or at once when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Ctrl-C: aborts the loop. */
  signal?: AbortSignal;
  now?: () => number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}

function stamp(now: () => number): string {
  return new Date(now()).toISOString().slice(11, 19);
}

/** Converts once, or keeps polling. Resolves with the process exit code. */
export async function runConvert(settings: ConvertSettings, deps: RunDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const sleep = deps.sleep ?? defaultSleep;
  const signal = deps.signal ?? new AbortController().signal;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const contestBase = `${settings.baseUrl.replace(/\/$/, '')}/contests/${encodeURIComponent(settings.contestId)}`;

  const source = createContestApiSource({
    baseUrl: settings.baseUrl,
    contestId: settings.contestId,
    auth: settings.auth,
    fetchTimeout: FETCH_TIMEOUT_MS,
    // The board side adds country and foreign flags from orgs.json.
    excludeTeamIds: [],
    foreign: { ids: [], groups: [] },
    orgs: {},
    fetchImpl,
    onWarning: (message) => log(`[${stamp(now)}] warning: ${message}`),
    now,
  });

  /** GET {contestBase}{path} with the credential in the header only. */
  async function getJson(path: string): Promise<unknown> {
    const basic = Buffer.from(`${settings.auth.username}:${settings.auth.password}`).toString('base64');
    const res = await fetchImpl(`${contestBase}${path}`, {
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Judge request failed: ${res.status} ${res.statusText} (${redactUrl(contestBase)}${path})`);
    return res.json();
  }

  mkdirSync(settings.outDir, { recursive: true });
  const contestPath = join(settings.outDir, 'contest.json');
  const runsPath = join(settings.outDir, 'runs.json');

  let contest: Contest | null = null;
  let freezeMinute: number | null = null;
  let cursor: unknown = undefined;
  let polls = 0;
  let noMoreUpdate = false;
  let wroteOnce = false;
  let maskedEndLogged = false;

  async function pollOnce(): Promise<string> {
    if (contest === null || polls % RELOAD_EVERY === 0) {
      try {
        const loaded = await source.loadContest();
        const minute = settings.unfreeze ? null : freezeMinuteFromContest(await getJson(''));
        contest = loaded;
        freezeMinute = minute;
      } catch (e) {
        // Only the first load is fatal. A later bad reload keeps the old contest and freeze.
        if (contest === null) throw e;
        error(`[${stamp(now)}] contest reload failed, keeping the old one: ${redactUrl((e as Error).message)}`);
      }
    }
    polls++;
    const result = await source.fetchRuns(cursor);

    // DOMjudge thawed or finalized the contest: its own scoreboard shows the
    // real results, so the freeze mask ends. An unreadable /state keeps the mask.
    let effectiveFreeze = freezeMinute;
    if (!settings.unfreeze && freezeMinute !== null) {
      try {
        const state = (await getJson('/state')) as { thawed?: unknown; finalized?: unknown } | null;
        if (state?.thawed != null || state?.finalized != null) effectiveFreeze = null;
      } catch {
        // keep the mask
      }
    }
    const masking = !settings.unfreeze && effectiveFreeze !== null;
    // While the mask holds, the feed is not done: end_of_updates without a thaw
    // must not stop the converter or tell the board to stop. A later thaw still has to arrive.
    const noMore = result.noMoreUpdate && !masking;
    if (result.noMoreUpdate && masking && !maskedEndLogged) {
      maskedEndLogged = true;
      log(`[${stamp(now)}] the judge set end_of_updates but the freeze is not thawed or finalized; still polling.`);
    }

    const runsFile = toSpotboardRuns(result.runs, {
      contestTimeSeconds: result.contestTimeSec,
      noMoreUpdate: noMore,
      freezeMinute: effectiveFreeze,
      unfreeze: settings.unfreeze,
      timestamp: Math.floor(now() / 1000),
    });
    const contestFile = toSpotboardContest(contest!);

    writeFileAtomic(contestPath, `${JSON.stringify(contestFile, null, 2)}\n`);
    writeFileAtomic(runsPath, `${JSON.stringify(runsFile)}\n`);
    cursor = result.cursor;
    wroteOnce = true;

    const judged = result.runs.filter((r) => r.verdict !== 'pending').length;
    const shown = runsFile.runs.filter((r) => r.result !== '').length;
    const mode = settings.unfreeze ? 'UNFROZEN' : effectiveFreeze === null ? 'no freeze' : `freeze at minute ${effectiveFreeze}`;
    if (noMore) noMoreUpdate = true;
    return (
      `teams=${contestFile.teams.length} problems=${contestFile.problems.length} runs=${runsFile.runs.length} ` +
      `masked=${settings.unfreeze ? 0 : judged - shown} (${mode})`
    );
  }

  if (settings.unfreeze) {
    log(`[${stamp(now)}] --unfreeze: the output holds real verdicts. Keep ${settings.outDir} private.`);
  }

  for (;;) {
    try {
      log(`[${stamp(now)}] ok ${await pollOnce()} -> ${settings.outDir}`);
    } catch (e) {
      const message = redactUrl(e instanceof Error ? e.message : String(e));
      const kept = settings.intervalSeconds !== null && wroteOnce ? ' (last files kept)' : '';
      error(`[${stamp(now)}] poll failed${kept}: ${message}`);
      // A fatal setup problem (or a one-shot run) must not look like success.
      if (settings.intervalSeconds === null || e instanceof ConvertError) return 1;
    }
    if (settings.intervalSeconds === null) return 0;
    if (noMoreUpdate) {
      log(`[${stamp(now)}] the judge ended the feed (end_of_updates); stopping.`);
      return 0;
    }
    await sleep(settings.intervalSeconds * 1000, signal);
    if (signal.aborted) {
      log(`[${stamp(now)}] stopped.`);
      return 0;
    }
  }
}

/** Parses arguments, runs, and returns the exit code. Never throws on user error. */
export async function runCli(argv: readonly string[], deps: RunDeps & SettingsDeps = {}): Promise<number> {
  const error = deps.error ?? ((line: string) => console.error(line));
  try {
    return await runConvert(resolveSettings(argv, deps), deps);
  } catch (e) {
    if (e instanceof ConvertError) {
      error(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

// `vite-node scripts/convert-domjudge.ts` is the CLI. A test that imports this
// file runs under vitest, where argv[1] is another binary, so nothing starts.
if (basename(process.argv[1] ?? '').startsWith('vite-node')) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runCli(process.argv.slice(2), { signal: controller.signal }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
