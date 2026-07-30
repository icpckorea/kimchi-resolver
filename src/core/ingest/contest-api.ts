/**
 * ICPC Contest API (CCS) adapter (spec §5) — DOMjudge / CDS direct connection.
 *
 * loadContest():  GET {baseUrl}/contests/{id}/access (role gate, see below),
 *                 then /contests/{id}, /problems, /teams?public=true,
 *                 /organizations, /judgement-types (judgement-type flags cached)
 * fetchRuns():    GET /submissions + /judgements, joined by submission_id,
 *                 plus /state for the contest clock and the end of the feed.
 *
 * Normalization notes:
 * - ids are strings already (CCS spec), but stringified defensively.
 * - contest_time "H:MM:SS.mmm" (or "HH:MM:SS") → floor minutes, negative → 0.
 * - seq is an adapter-assigned monotonic counter in first-seen order, persisted
 *   across polls through the opaque cursor object (JSON-serializable).
 *
 * Access / role gate (P0-1):
 *   DOMjudge's judgement endpoint is restricted to jury/team/judgehost/
 *   api_reader accounts and, for a plain TEAM account, is silently narrowed to
 *   that team's own judgements — while /submissions stays unfiltered. The board
 *   then fills with submissions that never receive a verdict, which is
 *   indistinguishable from a stuck freeze. loadContest() therefore asks the CCS
 *   `access` endpoint what this account may read and refuses to start when
 *   `judgements` is missing, and fetchRuns() additionally reports the
 *   "submissions from many teams, judgements from at most one" shape at runtime.
 *
 * Clock and end of feed (P0-2 / P0-3):
 *   The CCS `state` endpoint carries started/ended/frozen/thawed/finalized and
 *   end_of_updates ("setting this to non-null must be the very last change in
 *   the contest"). Elapsed contest seconds come from `started` (falling back to
 *   the contest's own start_time) plus the wall clock, clamped to [0, duration];
 *   end_of_updates != null maps to noMoreUpdate. Both degrade gracefully — a
 *   missing /state endpoint never fails a poll.
 *
 * Field shapes below were validated against the DOMjudge 9.0.0 OpenAPI document
 * and its controllers (not against a live instance) — hence the defensive
 * `?? undefined` handling on every field DOMjudge declares nullable.
 */

import type { Contest, FeedSource, FetchRunsResult, OrgsIndex, Problem, Run, Team } from '../types';
import { normalizeJudgementType, type JudgementTypeFlags } from '../verdict';
import { normalizeCountryCode } from './iso3166';

export interface ContestApiSourceOptions {
  /** API root, e.g. "https://judge.example.org/api". */
  baseUrl: string;
  contestId: string;
  /** HTTP basic auth credentials, or null for anonymous access. */
  auth: { username: string; password: string } | null;
  /** Milliseconds before an in-flight request is aborted. */
  fetchTimeout: number;
  excludeTeamIds: string[];
  foreign: { ids: string[]; groups: string[] };
  /** School metadata keyed by group (organization) name; wins over /organizations country. */
  orgs: OrgsIndex;
  fetchImpl?: typeof fetch;
  /**
   * Diagnostics sink for feed anomalies the operator must know about (unknown
   * judgement types, unmappable country codes, teams with no affiliation,
   * submissions with no usable id, team-filtered judgements, a missing /state
   * endpoint). Each distinct problem is reported ONCE per source instance, so
   * this is safe to wire to a SystemMessage. Defaults to `console.warn`.
   * Poll-time diagnoses are also returned in
   * {@link ContestApiFetchRunsResult.warnings}.
   */
  onWarning?: (message: string) => void;
  /** Wall clock in epoch ms, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Serializable cursor persisted across polls: submission id → assigned seq. */
export interface ContestApiCursor {
  seenSeq: Array<[string, number]>;
}

/** fetchRuns result plus the diagnoses raised by that poll. */
export interface ContestApiFetchRunsResult extends FetchRunsResult {
  /** Warnings emitted by THIS poll (each distinct one fires only once). */
  warnings: string[];
}

/** FeedSource whose fetchRuns also exposes the adapter's own diagnostics. */
export interface ContestApiSource extends FeedSource {
  fetchRuns(cursor: unknown): Promise<ContestApiFetchRunsResult>;
}

// --- Raw CCS shapes (only the fields we consume) ---------------------------

interface RawCcsContest {
  formal_name?: string;
  name?: string;
  /** ISO 8601 with offset. Null/absent → the contest is not scheduled yet. */
  start_time?: string | null;
  /** RELTIME "H:MM:SS(.uuu)" — the contest length. */
  duration?: string | null;
  /** DOMjudge also emits this; used only when `duration` is unusable. */
  end_time?: string | null;
}

/**
 * GET /contests/{id}/access — what THIS account may read. CCS shape:
 * `{ capabilities: [...], endpoints: [{ type: "judgements", properties: [...] }, ...] }`.
 */
interface RawCcsAccess {
  endpoints?: unknown;
}

/**
 * GET /contests/{id}/state — CCS contest state. Every member is a timestamp or
 * null. `end_of_updates` non-null means the contest will not change again.
 */
interface RawCcsState {
  started?: string | null;
  ended?: string | null;
  frozen?: string | null;
  thawed?: string | null;
  finalized?: string | null;
  end_of_updates?: string | null;
}

interface RawCcsProblem {
  id: string | number;
  label?: string;
  name?: string;
  rgb?: string;
  color?: string;
  ordinal?: number;
}

interface RawCcsTeam {
  id: string | number;
  name?: string | null;
  display_name?: string | null;
  organization_id?: string | number | null;
  /**
   * DOMjudge extension: free-text affiliation name. Present on teams that have
   * no linked organization, which is why it is our group fallback (P1-2).
   */
  affiliation?: string | null;
  /** DOMjudge extension: ISO 3166-1 alpha-3, independent of the organization. */
  nationality?: string | null;
  /**
   * DOMjudge extension: jury / test / system teams. Never belongs on a public
   * scoreboard. `?public=true` already filters these out for us, but an
   * api_reader token on an older/patched instance may still see them.
   */
  hidden?: boolean;
}

interface RawCcsOrganization {
  id: string | number;
  name?: string | null;
  formal_name?: string | null;
  country?: string | null;
}

interface RawCcsJudgementType {
  id: string;
  solved?: boolean;
  penalty?: boolean;
}

interface RawCcsSubmission {
  /** Declared nullable by DOMjudge's OpenAPI document. */
  id?: string | number | null;
  /** DOMjudge internal id, used only when `id` is missing. */
  submitid?: string | number | null;
  team_id: string | number;
  problem_id: string | number;
  contest_time?: string | null;
}

interface RawCcsJudgement {
  id?: string | number | null;
  submission_id: string | number;
  judgement_type_id?: string | null;
  /**
   * DOMjudge JudgingWrapper: false once this judging has been superseded (a
   * rejudging was started). Superseded judgings MUST NOT decide the verdict.
   */
  valid?: boolean;
  /** Absent/null while the judging is still running. */
  end_contest_time?: string | null;
}

// --- Helpers ---------------------------------------------------------------

const CONTEST_TIME_RE = /^(-)?(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/;

/**
 * "H:MM:SS.mmm" / "HH:MM:SS", optionally negative → seconds (may be negative).
 * Returns undefined when absent or malformed, so callers can distinguish
 * "no time" from "time zero".
 */
export function parseContestTimeSeconds(contestTime: string | null | undefined): number | undefined {
  if (contestTime == null) return undefined;
  const m = CONTEST_TIME_RE.exec(contestTime.trim());
  if (!m) return undefined;
  const total = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]) + Number(`0.${m[5] ?? '0'}`);
  return m[1] === '-' ? -total : total;
}

/** "H:MM:SS.mmm" or "HH:MM:SS" (optionally negative) → floor contest minute, clamped to 0. */
export function contestTimeToMinute(contestTime: string | null | undefined): number {
  const sec = parseContestTimeSeconds(contestTime);
  if (sec === undefined || sec < 0) return 0; // absent, malformed, or pre-start
  return Math.floor(sec / 60);
}

/** ISO 8601 timestamp → epoch ms; undefined when absent or unparseable. */
export function parseTimestamp(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Endpoint names from an `access` document. CCS defines objects carrying a
 * `type`; a bare string list is accepted too, so a slightly different server
 * never triggers a bogus hard failure. Returns undefined when the document has
 * no usable endpoint list at all — that means "cannot tell", not "denied".
 */
export function accessibleEndpoints(access: unknown): Set<string> | undefined {
  if (access == null || typeof access !== 'object') return undefined;
  const raw = (access as RawCcsAccess).endpoints;
  if (!Array.isArray(raw)) return undefined;
  const names = new Set<string>();
  for (const entry of raw) {
    if (typeof entry === 'string') names.add(entry);
    else if (entry != null && typeof entry === 'object') {
      const type = (entry as { type?: unknown }).type;
      if (typeof type === 'string') names.add(type);
    }
  }
  return names.size > 0 ? names : undefined;
}

/** Endpoints this adapter cannot produce a scoreboard without. */
const REQUIRED_ENDPOINTS = ['submissions', 'judgements'] as const;

/**
 * How much traffic must exist before "judgements cover at most one team" counts
 * as evidence of a filtered feed. The first minutes of a contest legitimately
 * look filtered — a handful of submissions with only the earliest one judged —
 * and this warning names the operator's account as broken, so it must not fire
 * on that. It applies to the one-judged-team case and to the nobody-judged case
 * alike: neither is conclusive on a board that has barely started.
 */
const TEAM_FILTER_MIN_SUBMISSIONS = 5;

/**
 * The runtime half of the role gate (P0-1). /submissions is never filtered, so
 * "many teams submitted, at most one team has any judgement" is the signature
 * of a team-scoped account.
 */
const TEAM_FILTER_DIAGNOSIS =
  'Contest API: judgements look filtered to a single team — this poll saw submissions from several teams ' +
  'but judgements from at most one. DOMjudge does exactly that for a team account (it narrows /judgements ' +
  'to your own team while leaving /submissions untouched), so the board will fill with runs that never get ' +
  'a verdict and will look permanently frozen. Use an account with the api_reader role (or a jury account).';

function roleGateError(missing: readonly string[], accessUrl: string): Error {
  return new Error(
    `Contest API access denied: GET ${accessUrl} does not list the ` +
      `${missing.map((name) => `"${name}"`).join(' and ')} endpoint for this account. ` +
      'DOMjudge limits /judgements to jury/api_reader accounts and silently narrows them to your own team ' +
      'for a team account, so every submission would stay pending and the scoreboard would look permanently ' +
      'frozen. Give the API user the api_reader role (DOMjudge: Users → edit the user → Roles → ' +
      '"API reader"), or use a jury account — a team, public or anonymous account is not enough.',
  );
}

const NUMERIC_RE = /^\d+$/;

/** Numeric-aware ascending id comparison ("9" < "10"); numeric ids sort first. */
function compareIdsAsc(a: string, b: string): number {
  const aNum = NUMERIC_RE.test(a);
  const bNum = NUMERIC_RE.test(b);
  if (aNum && bNum) {
    const diff = Number(a) - Number(b);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  } else if (aNum !== bNum) {
    return aNum ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * "Is `a` the more recent judgement than `b`?" (>0 → yes).
 *
 * CCS guarantees no array ordering, so we order explicitly: greatest
 * `end_contest_time` wins; when either side is still running (no end time) or
 * the two finished in the same instant, the greatest id wins. That fallback is
 * what makes an in-flight rejudging (no end time, higher id) beat the stale
 * finished judging it replaces — the cell correctly goes back to pending.
 */
function compareJudgementRecency(a: RawCcsJudgement, b: RawCcsJudgement): number {
  const ta = parseContestTimeSeconds(a.end_contest_time);
  const tb = parseContestTimeSeconds(b.end_contest_time);
  if (ta !== undefined && tb !== undefined && ta !== tb) return ta < tb ? -1 : 1;
  return compareIdsAsc(String(a.id ?? ''), String(b.id ?? ''));
}

/** Trimmed non-empty string, or undefined. */
function text(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function toBase64(raw: string): string {
  if (typeof btoa === 'function') return btoa(raw);
  // Node fallback without importing node:buffer types.
  const buf = (globalThis as { Buffer?: { from(s: string): { toString(enc: string): string } } }).Buffer;
  if (buf) return buf.from(raw).toString('base64');
  throw new Error('No base64 encoder available');
}

function parseCursor(cursor: unknown): { seenSeq: Map<string, number>; nextSeq: number } {
  const seenSeq = new Map<string, number>();
  if (cursor && typeof cursor === 'object' && 'seenSeq' in cursor) {
    const raw = (cursor as ContestApiCursor).seenSeq;
    const entries = raw instanceof Map ? [...(raw as Map<string, number>)] : Array.isArray(raw) ? raw : [];
    for (const entry of entries) {
      if (Array.isArray(entry) && entry.length === 2) {
        seenSeq.set(String(entry[0]), Number(entry[1]));
      }
    }
  }
  let nextSeq = 1;
  for (const seq of seenSeq.values()) {
    if (seq >= nextSeq) nextSeq = seq + 1;
  }
  return { seenSeq, nextSeq };
}

/**
 * Fail-safe flags for a judgement type the feed reports but `/judgement-types`
 * never listed (a type added mid-contest, or a gap in the cached snapshot).
 *
 * Failed WITH penalty, deliberately: leaving such a run pending forever hides a
 * real verdict from the board and silently understates the team's penalty, and
 * a stuck-pending cell looks like a working board. A penalized failure is the
 * conservative reading of "the judge rejected it", and the warning tells the
 * operator to reload the contest.
 */
const UNKNOWN_JUDGEMENT_TYPE_FLAGS: JudgementTypeFlags = { solved: false, penalty: true };

// --- Adapter ---------------------------------------------------------------

export function createContestApiSource(opts: ContestApiSourceOptions): ContestApiSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const warnSink = opts.onWarning ?? ((message: string) => console.warn(`[kimchi-resolver] ${message}`));
  const excluded = new Set(opts.excludeTeamIds.map((id) => String(id)));
  const foreignIds = new Set(opts.foreign.ids.map((id) => String(id)));
  const foreignGroups = new Set(opts.foreign.groups.filter((g) => g !== ''));
  const contestBase = `${opts.baseUrl.replace(/\/$/, '')}/contests/${encodeURIComponent(opts.contestId)}`;

  /** judgement-type id → flags, cached by loadContest for fetchRuns. */
  const judgementTypes = new Map<string, JudgementTypeFlags>();
  /** Team ids kept out of the board entirely: config-excluded plus DOMjudge-hidden. */
  const suppressedTeamIds = new Set<string>(excluded);
  /** Team ids present in the loaded contest (for unknown-team diagnostics). */
  const knownTeamIds = new Set<string>();
  let contestLoaded = false;

  /** Clock inputs cached by loadContest; the fallback when /state is absent. */
  let clockMeta: { startMs: number | undefined; durationSec: number | undefined } = {
    startMs: undefined,
    durationSec: undefined,
  };
  /**
   * Server clock − local clock, taken from the last response's `Date` header.
   * The contest clock must follow the judge, not the operator's laptop.
   */
  let serverSkewMs = 0;

  const warnedKeys = new Set<string>();
  /**
   * Emits `message` the first time `key` is seen; later calls are no-ops.
   * `sink` (a poll's warning list) receives the message on that first emission.
   */
  function warnOnce(key: string, message: string, sink?: string[]): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    sink?.push(message);
    warnSink(message);
  }

  /** Wall clock corrected towards the judge's clock. */
  function serverNow(): number {
    return now() + serverSkewMs;
  }

  async function getJson(path: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (opts.auth) {
      headers['Authorization'] = `Basic ${toBase64(`${opts.auth.username}:${opts.auth.password}`)}`;
    }
    const res = await fetchImpl(`${contestBase}${path}`, {
      headers,
      signal: AbortSignal.timeout(opts.fetchTimeout),
    });
    // Follow the judge's clock. The header has one-second resolution, which is
    // ample for an HH:MM display and immune to a mis-set operator machine.
    const serverDate = parseTimestamp(res.headers?.get?.('date'));
    if (serverDate !== undefined) serverSkewMs = serverDate - now();
    if (!res.ok) {
      throw new Error(`Contest API request failed: ${res.status} ${res.statusText} (${contestBase}${path})`);
    }
    return res.json();
  }

  /** getJson that reports any failure as undefined — for OPTIONAL endpoints. */
  async function getJsonOptional(path: string): Promise<unknown | undefined> {
    try {
      return await getJson(path);
    } catch {
      return undefined;
    }
  }

  /**
   * P0-1: refuse to start when this account cannot read judgements. An access
   * endpoint that is itself unreachable, or that carries no endpoint list, only
   * warns — older CDS builds have no such endpoint and must still work.
   */
  async function assertJudgementAccess(): Promise<void> {
    const access = await getJsonOptional('/access');
    if (access === undefined) {
      warnOnce(
        'access-unavailable',
        `Contest API: the access check was skipped — GET ${contestBase}/access is unavailable. ` +
          'If the board shows submissions that never get a verdict, this account most likely lacks the ' +
          'api_reader role.',
      );
      return;
    }
    const endpoints = accessibleEndpoints(access);
    if (endpoints === undefined) {
      warnOnce(
        'access-unreadable',
        `Contest API: the access check was skipped — GET ${contestBase}/access returned no endpoint list.`,
      );
      return;
    }
    const missing = REQUIRED_ENDPOINTS.filter((name) => !endpoints.has(name));
    if (missing.length > 0) throw roleGateError(missing, `${contestBase}/access`);
  }

  async function loadContest(): Promise<Contest> {
    // Sequential on purpose: a role problem must be diagnosed as such, not as
    // whatever 403 the parallel loads below happen to reject with first.
    await assertJudgementAccess();

    const [rawContest, rawProblems, rawTeams, rawOrgs, rawJudgementTypes] = (await Promise.all([
      getJson(''),
      getJson('/problems'),
      // public=true: "Only show visible teams, even for users with more
      // permissions". Without it an api_reader account puts jury/test teams on
      // the board (P1-1).
      getJson('/teams?public=true'),
      getJson('/organizations'),
      getJson('/judgement-types'),
    ])) as [RawCcsContest, RawCcsProblem[], RawCcsTeam[], RawCcsOrganization[], RawCcsJudgementType[]];

    judgementTypes.clear();
    for (const jt of rawJudgementTypes) {
      judgementTypes.set(String(jt.id), { solved: jt.solved === true, penalty: jt.penalty === true });
    }

    // Clock inputs (P0-2). `duration` is authoritative; end_time − start_time is
    // the fallback for feeds that omit it.
    const startMs = parseTimestamp(rawContest.start_time);
    let durationSec = parseContestTimeSeconds(rawContest.duration);
    if (durationSec === undefined || durationSec <= 0) {
      const endMs = parseTimestamp(rawContest.end_time);
      durationSec =
        endMs !== undefined && startMs !== undefined && endMs > startMs ? (endMs - startMs) / 1000 : undefined;
    }
    clockMeta = { startMs, durationSec };

    const problems: Problem[] = rawProblems
      .map((p, index) => ({
        id: String(p.id),
        label: p.label ?? (p.name ?? '').charAt(0),
        title: p.name ?? '',
        color: p.rgb ?? p.color ?? '',
        order: p.ordinal ?? index,
      }))
      .sort((a, b) => a.order - b.order);

    const orgsById = new Map<string, RawCcsOrganization>();
    for (const org of rawOrgs) orgsById.set(String(org.id), org);

    suppressedTeamIds.clear();
    for (const id of excluded) suppressedTeamIds.add(id);
    knownTeamIds.clear();

    const teams = new Map<string, Team>();
    const unknownCountries = new Set<string>();
    const groupless: string[] = [];
    let hiddenCount = 0;

    for (const rawTeam of rawTeams) {
      const id = String(rawTeam.id);
      if (excluded.has(id)) continue;
      // Defence in depth behind ?public=true: never show a jury/test team.
      if (rawTeam.hidden === true) {
        hiddenCount++;
        suppressedTeamIds.add(id);
        continue;
      }

      const org = rawTeam.organization_id != null ? orgsById.get(String(rawTeam.organization_id)) : undefined;
      // Group precedence: organization formal_name → organization name →
      // DOMjudge's free-text `affiliation`. organization_id is nullable, and
      // collapsing every org-less team into one shared '' bucket would make
      // them a single giant "school" for schoolRank (and therefore for APAC
      // stars, which key on schoolRank <= 3). '' is emitted ONLY when the feed
      // carries no affiliation at all — downstream (core/apac.ts) treats '' as
      // "no school", never as a group.
      const group = text(org?.formal_name) ?? text(org?.name) ?? text(rawTeam.affiliation) ?? '';
      if (group === '') groupless.push(id);

      // Country precedence: orgs.json (spec §8) → organization country →
      // DOMjudge team nationality. Unknown codes yield undefined (no flag)
      // instead of a plausible-looking wrong one.
      const orgsEntry = group !== '' ? opts.orgs[group] : undefined;
      const rawCountry = text(orgsEntry?.country) ?? text(org?.country) ?? text(rawTeam.nationality);
      const countryCode = normalizeCountryCode(rawCountry);
      if (rawCountry !== undefined && countryCode === undefined) {
        unknownCountries.add(rawCountry.toUpperCase());
      }

      // Precedence: config override (forces foreign) > country != 'KR'.
      const foreign =
        foreignIds.has(id) ||
        (group !== '' && foreignGroups.has(group)) ||
        (countryCode !== undefined && countryCode !== 'KR');
      const team: Team = {
        id,
        name: text(rawTeam.display_name) ?? text(rawTeam.name) ?? '',
        group,
        foreign,
      };
      if (countryCode !== undefined) team.countryCode = countryCode;
      teams.set(id, team);
      knownTeamIds.add(id);
    }

    if (hiddenCount > 0) {
      warnOnce(
        'hidden-teams',
        `Contest API: dropped ${hiddenCount} hidden (jury/test) team(s) that /teams?public=true still returned.`,
      );
    }
    if (unknownCountries.size > 0) {
      warnOnce(
        'unknown-country',
        `Contest API: unrecognized country code(s) ${[...unknownCountries].sort().join(', ')} — ` +
          'those teams get no flag. Use ISO 3166-1 alpha-3 (or alpha-2) codes.',
      );
    }
    if (groupless.length > 0) {
      warnOnce(
        'groupless-teams',
        `Contest API: ${groupless.length} team(s) have neither an organization nor an affiliation ` +
          `(ids: ${groupless.slice(0, 10).join(', ')}${groupless.length > 10 ? ', …' : ''}). ` +
          'They are treated as "no school" — no school rank, no APAC star.',
      );
    }

    contestLoaded = true;
    return {
      title: rawContest.formal_name ?? rawContest.name ?? '',
      systemName: 'Contest API',
      systemVersion: '',
      problems,
      teams,
    };
  }

  /** Resolves the verdict flags for a submission, warning on gaps. */
  function resolveFlags(judgement: RawCcsJudgement | undefined): JudgementTypeFlags | null {
    const typeId = text(judgement?.judgement_type_id);
    if (typeId === undefined) return null; // no judgement, or still running → pending
    const known = judgementTypes.get(typeId);
    if (known !== undefined) return known;
    if (judgementTypes.size === 0) {
      // fetchRuns ran before loadContest cached the table; every verdict would
      // otherwise be mislabelled. Pending is right here — nothing is known yet.
      warnOnce(
        'judgement-types-missing',
        'Contest API: /judgement-types has not been loaded, so judged runs stay pending. ' +
          'Call loadContest() before fetchRuns().',
      );
      return null;
    }
    warnOnce(
      `judgement-type:${typeId}`,
      `Contest API: unknown judgement type "${typeId}" (not in the /judgement-types snapshot taken at load). ` +
        'Scoring it as a penalized rejection; reload the contest to pick up the real flags.',
    );
    return UNKNOWN_JUDGEMENT_TYPE_FLAGS;
  }

  /**
   * P0-2: elapsed contest seconds. `state` wins when present — `started: null`
   * there means the contest has NOT begun, which is a real "--:--", not a zero.
   * Without /state the contest's own start_time drives the same computation.
   * Always clamped to [0, duration], so a finished contest stops counting.
   */
  function deriveContestTimeSec(state: RawCcsState | undefined): number | null {
    const stateKnowsStart = state !== undefined && Object.prototype.hasOwnProperty.call(state, 'started');
    const startedByState = stateKnowsStart ? parseTimestamp(state?.started) : undefined;
    // A state document that explicitly reports "not started" is conclusive.
    if (stateKnowsStart && startedByState === undefined) return null;

    const startMs = startedByState ?? clockMeta.startMs;
    if (startMs === undefined) return null; // contest not scheduled

    let elapsedSec = (serverNow() - startMs) / 1000;
    if (elapsedSec < 0) {
      // Scheduled, but the start is still in the future → no clock yet. Under an
      // authoritative `started` a negative value is just clock jitter → 0.
      if (startedByState === undefined) return null;
      elapsedSec = 0;
    }
    // A contest that has ended stops at its end, even if /state lags.
    const endedMs = parseTimestamp(state?.ended);
    if (endedMs !== undefined && endedMs > startMs) {
      elapsedSec = Math.min(elapsedSec, (endedMs - startMs) / 1000);
    }
    if (clockMeta.durationSec !== undefined) elapsedSec = Math.min(elapsedSec, clockMeta.durationSec);
    return Math.max(0, Math.floor(elapsedSec));
  }

  /** P0-1 (runtime half): see {@link TEAM_FILTER_DIAGNOSIS}. */
  function detectTeamFilteredJudgements(
    submissions: RawCcsSubmission[],
    judgements: RawCcsJudgement[],
    warnings: string[],
  ): void {
    const teamBySubmission = new Map<string, string>();
    const submittingTeams = new Set<string>();
    for (const sub of submissions) {
      const submissionId = String(sub.id ?? sub.submitid ?? '');
      const teamId = String(sub.team_id);
      if (submissionId !== '') teamBySubmission.set(submissionId, teamId);
      submittingTeams.add(teamId);
    }
    if (submittingTeams.size < 2) return; // a single-team feed proves nothing
    // Too little traffic to tell a filtered feed from a contest that started
    // two minutes ago (see TEAM_FILTER_MIN_SUBMISSIONS).
    if (submissions.length < TEAM_FILTER_MIN_SUBMISSIONS) return;

    const judgedTeams = new Set<string>();
    for (const judgement of judgements) {
      const teamId = teamBySubmission.get(String(judgement.submission_id));
      if (teamId !== undefined) judgedTeams.add(teamId);
    }
    if (judgedTeams.size > 1) return; // judgements span teams → not filtered

    warnOnce('team-filtered-judgements', TEAM_FILTER_DIAGNOSIS, warnings);
  }

  async function fetchRuns(cursor: unknown): Promise<ContestApiFetchRunsResult> {
    const warnings: string[] = [];
    const [rawSubmissions, rawJudgements, rawState] = (await Promise.all([
      getJson('/submissions'),
      getJson('/judgements'),
      // Optional: /state must never fail a poll (older CDS builds lack it).
      getJsonOptional('/state'),
    ])) as [RawCcsSubmission[], RawCcsJudgement[], unknown];

    const state =
      rawState != null && typeof rawState === 'object' && !Array.isArray(rawState)
        ? (rawState as RawCcsState)
        : undefined;
    if (state === undefined) {
      warnOnce(
        'state-unavailable',
        `Contest API: GET ${contestBase}/state is unavailable, so the contest clock falls back to ` +
          'start_time plus the local clock and the end of the feed cannot be detected.',
        warnings,
      );
    }

    detectTeamFilteredJudgements(rawSubmissions, rawJudgements, warnings);

    // Join judgements by submission_id. Superseded judgings (valid === false)
    // are ignored outright; among the rest the most recent one decides.
    const judgementBySubmission = new Map<string, RawCcsJudgement>();
    for (const j of rawJudgements) {
      if (j.valid === false) continue;
      const key = String(j.submission_id);
      const prev = judgementBySubmission.get(key);
      if (prev === undefined || compareJudgementRecency(j, prev) > 0) {
        judgementBySubmission.set(key, j);
      }
    }

    const { seenSeq, nextSeq } = parseCursor(cursor);
    let counter = nextSeq;

    const runs: Run[] = [];
    for (const sub of rawSubmissions) {
      // `id` is declared nullable: String(null) would yield the literal "null"
      // for EVERY such submission, colliding them into one run id.
      const rawId = sub.id ?? sub.submitid;
      if (rawId == null || String(rawId) === '') {
        warnOnce(
          'submission-missing-id',
          'Contest API: dropped submission(s) with neither `id` nor `submitid` — they cannot be tracked across polls.',
        );
        continue;
      }
      const submissionId = String(rawId);
      // seq: monotonic counter in first-seen order, stable across polls.
      let seq = seenSeq.get(submissionId);
      if (seq === undefined) {
        seq = counter++;
        seenSeq.set(submissionId, seq);
      }

      const teamId = String(sub.team_id);
      // seq is still assigned above, so dropping never shifts anyone's order.
      if (suppressedTeamIds.has(teamId)) continue; // excluded or jury/test team
      if (contestLoaded && !knownTeamIds.has(teamId)) {
        warnOnce(
          `unknown-team:${teamId}`,
          `Contest API: submissions reference team "${teamId}", which was absent from /teams at load time. ` +
            'Its runs are ignored by the standings; reload the contest if the team is legitimate.',
        );
      }

      const { verdict, penaltyCounts } = normalizeJudgementType(
        resolveFlags(judgementBySubmission.get(submissionId)),
      );

      runs.push({
        id: submissionId,
        teamId,
        problemId: String(sub.problem_id),
        minute: contestTimeToMinute(sub.contest_time),
        verdict,
        penaltyCounts,
        seq,
      });
    }

    const nextCursor: ContestApiCursor = { seenSeq: [...seenSeq.entries()] };

    return {
      runs,
      contestTimeSec: deriveContestTimeSec(state),
      // CCS: "setting end_of_updates to non-null must be the very last change
      // in the contest" — nothing more will arrive, so polling can stop (P0-3).
      noMoreUpdate: state !== undefined && state.end_of_updates != null,
      cursor: nextCursor,
      warnings,
    };
  }

  return { loadContest, fetchRuns };
}
