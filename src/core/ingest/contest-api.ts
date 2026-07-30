/**
 * ICPC Contest API (CCS) adapter (spec §5) — DOMjudge / CDS direct connection.
 *
 * loadContest():  GET {baseUrl}/contests/{id}, /problems, /teams,
 *                 /organizations, /judgement-types (judgement-type flags cached)
 * fetchRuns():    GET /submissions + /judgements, joined by submission_id.
 *
 * Normalization notes:
 * - ids are strings already (CCS spec), but stringified defensively.
 * - contest_time "H:MM:SS.mmm" (or "HH:MM:SS") → floor minutes, negative → 0.
 * - seq is an adapter-assigned monotonic counter in first-seen order, persisted
 *   across polls through the opaque cursor object (JSON-serializable).
 * - noMoreUpdate is always false — the Contest API has no such flag.
 */

import type { Contest, FeedSource, FetchRunsResult, OrgsIndex, Problem, Run, Team } from '../types';
import { normalizeJudgementType, type JudgementTypeFlags } from '../verdict';

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
}

/** Serializable cursor persisted across polls: submission id → assigned seq. */
export interface ContestApiCursor {
  seenSeq: Array<[string, number]>;
}

// --- Raw CCS shapes (only the fields we consume) ---------------------------

interface RawCcsContest {
  formal_name?: string;
  name?: string;
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
  name?: string;
  display_name?: string;
  organization_id?: string | number | null;
}

interface RawCcsOrganization {
  id: string | number;
  name?: string;
  formal_name?: string;
  country?: string;
}

interface RawCcsJudgementType {
  id: string;
  solved?: boolean;
  penalty?: boolean;
}

interface RawCcsSubmission {
  id: string | number;
  team_id: string | number;
  problem_id: string | number;
  contest_time?: string;
}

interface RawCcsJudgement {
  id?: string | number;
  submission_id: string | number;
  judgement_type_id?: string | null;
}

// --- Helpers ---------------------------------------------------------------

/** ISO 3166-1 alpha-3 → alpha-2 for common ICPC countries; fallback: first two letters. */
const ISO3_TO_ALPHA2: Record<string, string> = {
  KOR: 'KR',
  JPN: 'JP',
  TWN: 'TW',
  CHN: 'CN',
  USA: 'US',
};

export function iso3ToAlpha2(iso3: string | undefined): string | undefined {
  if (!iso3) return undefined;
  const upper = iso3.toUpperCase();
  if (upper.length === 2) return upper; // already alpha-2
  return ISO3_TO_ALPHA2[upper] ?? upper.slice(0, 2);
}

/** "H:MM:SS.mmm" or "HH:MM:SS" (optionally negative) → floor contest minute, clamped to 0. */
export function contestTimeToMinute(contestTime: string | undefined): number {
  if (!contestTime) return 0;
  const m = /^(-)?(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(contestTime.trim());
  if (!m) return 0;
  if (m[1] === '-') return 0; // negative contest time (pre-start) clamps to 0
  const totalSec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return Math.floor(totalSec / 60);
}

function toBase64(text: string): string {
  if (typeof btoa === 'function') return btoa(text);
  // Node fallback without importing node:buffer types.
  const buf = (globalThis as { Buffer?: { from(s: string): { toString(enc: string): string } } }).Buffer;
  if (buf) return buf.from(text).toString('base64');
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

// --- Adapter ---------------------------------------------------------------

export function createContestApiSource(opts: ContestApiSourceOptions): FeedSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const excluded = new Set(opts.excludeTeamIds.map((id) => String(id)));
  const foreignIds = new Set(opts.foreign.ids.map((id) => String(id)));
  const foreignGroups = new Set(opts.foreign.groups);
  const contestBase = `${opts.baseUrl.replace(/\/$/, '')}/contests/${encodeURIComponent(opts.contestId)}`;

  /** judgement-type id → flags, cached by loadContest for fetchRuns. */
  const judgementTypes = new Map<string, JudgementTypeFlags>();

  async function getJson(path: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (opts.auth) {
      headers['Authorization'] = `Basic ${toBase64(`${opts.auth.username}:${opts.auth.password}`)}`;
    }
    const res = await fetchImpl(`${contestBase}${path}`, {
      headers,
      signal: AbortSignal.timeout(opts.fetchTimeout),
    });
    if (!res.ok) {
      throw new Error(`Contest API request failed: ${res.status} ${res.statusText} (${contestBase}${path})`);
    }
    return res.json();
  }

  async function loadContest(): Promise<Contest> {
    const [rawContest, rawProblems, rawTeams, rawOrgs, rawJudgementTypes] = (await Promise.all([
      getJson(''),
      getJson('/problems'),
      getJson('/teams'),
      getJson('/organizations'),
      getJson('/judgement-types'),
    ])) as [RawCcsContest, RawCcsProblem[], RawCcsTeam[], RawCcsOrganization[], RawCcsJudgementType[]];

    judgementTypes.clear();
    for (const jt of rawJudgementTypes) {
      judgementTypes.set(String(jt.id), { solved: jt.solved === true, penalty: jt.penalty === true });
    }

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

    const teams = new Map<string, Team>();
    for (const rawTeam of rawTeams) {
      const id = String(rawTeam.id);
      if (excluded.has(id)) continue;
      const org = rawTeam.organization_id != null ? orgsById.get(String(rawTeam.organization_id)) : undefined;
      const group = org?.formal_name ?? org?.name ?? '';
      // orgs.json wins over /organizations country (spec §8).
      const orgsEntry = opts.orgs[group];
      const countryCode = orgsEntry?.country
        ? orgsEntry.country.toUpperCase()
        : iso3ToAlpha2(org?.country);
      // Precedence: config override (forces foreign) > country != 'KR'.
      const foreign =
        foreignIds.has(id) ||
        foreignGroups.has(group) ||
        (countryCode !== undefined && countryCode !== 'KR');
      const team: Team = {
        id,
        name: rawTeam.display_name ?? rawTeam.name ?? '',
        group,
        foreign,
      };
      if (countryCode !== undefined) team.countryCode = countryCode;
      teams.set(id, team);
    }

    return {
      title: rawContest.formal_name ?? rawContest.name ?? '',
      systemName: 'Contest API',
      systemVersion: '',
      problems,
      teams,
    };
  }

  async function fetchRuns(cursor: unknown): Promise<FetchRunsResult> {
    const [rawSubmissions, rawJudgements] = (await Promise.all([
      getJson('/submissions'),
      getJson('/judgements'),
    ])) as [RawCcsSubmission[], RawCcsJudgement[]];

    // Join judgements by submission_id — the latest valid one wins. "Valid"
    // means it carries a judgement_type_id (in-progress judgements have null).
    const judgementBySubmission = new Map<string, string>();
    for (const j of rawJudgements) {
      if (j.judgement_type_id == null) continue;
      judgementBySubmission.set(String(j.submission_id), String(j.judgement_type_id));
    }

    const { seenSeq, nextSeq } = parseCursor(cursor);
    let counter = nextSeq;

    const runs: Run[] = [];
    for (const sub of rawSubmissions) {
      const submissionId = String(sub.id);
      // seq: monotonic counter in first-seen order, stable across polls.
      let seq = seenSeq.get(submissionId);
      if (seq === undefined) {
        seq = counter++;
        seenSeq.set(submissionId, seq);
      }

      const teamId = String(sub.team_id);
      if (excluded.has(teamId)) continue; // seq still assigned above, order preserved

      const typeId = judgementBySubmission.get(submissionId);
      const flags = typeId !== undefined ? (judgementTypes.get(typeId) ?? null) : null;
      const { verdict, penaltyCounts } = normalizeJudgementType(flags);

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
      contestTimeSec: null,
      noMoreUpdate: false, // the Contest API has no end-of-feed flag
      cursor: nextCursor,
    };
  }

  return { loadContest, fetchRuns };
}
