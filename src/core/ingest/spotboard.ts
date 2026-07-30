/**
 * Spotboard JSON feed adapter (spec §5).
 *
 * Consumes the classic spotboard static-file protocol:
 *   GET {apiBase}/contest.json
 *   GET {apiBase}/runs.json?from={timestamp}
 *
 * All normalization happens here so downstream code never sees raw spotboard
 * shapes: numeric ids are stringified, verdicts normalized via verdict.ts,
 * excluded teams (and their runs) removed entirely, foreign flags resolved
 * from config overrides + orgs.json.
 */

import type { Contest, FeedSource, FetchRunsResult, OrgsIndex, Problem, Run, Team } from '../types';
import { normalizeSpotboardResult } from '../verdict';

export interface SpotboardSourceOptions {
  /** Base URL of the feed directory, e.g. "./sample/". */
  apiBase: string;
  /** Milliseconds before an in-flight request is aborted. */
  fetchTimeout: number;
  /** Team ids to drop completely (teams AND their runs). */
  excludeTeamIds: string[];
  /** Declarative foreign overrides (config.foreign). */
  foreign: { ids: string[]; groups: string[] };
  /** School metadata: group name → { country, logo }. */
  orgs: OrgsIndex;
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/** Raw spotboard shapes (analysis doc §1.2). Fields may be number or string. */
interface RawSpotboardProblem {
  id: number | string;
  name?: string;
  title?: string;
  color?: string;
}

interface RawSpotboardTeam {
  id: number | string;
  name?: string;
  group?: string;
}

interface RawSpotboardContest {
  title?: string;
  systemName?: string;
  systemVersion?: string;
  problems?: RawSpotboardProblem[];
  teams?: RawSpotboardTeam[];
}

interface RawSpotboardRun {
  id: number | string;
  team: number | string;
  problem: number | string;
  result?: string;
  submissionTime: number | string;
}

interface RawSpotboardRuns {
  time?: {
    contestTime?: unknown;
    noMoreUpdate?: unknown;
    timestamp?: unknown;
  };
  runs?: RawSpotboardRun[];
}

/** "Name (Group)" → { name, group }. Used only when the group field is absent. */
const NAME_GROUP_RE = /^(.*?)\s*\(([^()]*)\)\s*$/;

function joinUrl(base: string, path: string): string {
  return base.endsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

export function createSpotboardSource(opts: SpotboardSourceOptions): FeedSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const excluded = new Set(opts.excludeTeamIds.map((id) => String(id)));
  const foreignIds = new Set(opts.foreign.ids.map((id) => String(id)));
  const foreignGroups = new Set(opts.foreign.groups);

  async function getJson(url: string): Promise<unknown> {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.fetchTimeout) });
    if (!res.ok) {
      throw new Error(`Spotboard feed request failed: ${res.status} ${res.statusText} (${url})`);
    }
    return res.json();
  }

  function toTeam(raw: RawSpotboardTeam): Team {
    const id = String(raw.id);
    let name = raw.name ?? '';
    let group = raw.group ?? '';
    if (raw.group === undefined) {
      // Parse "Name (Group)" only when the group field is absent.
      const m = NAME_GROUP_RE.exec(name);
      if (m) {
        name = m[1];
        group = m[2];
      }
    }
    const org = opts.orgs[group];
    const countryCode = org?.country ? org.country.toUpperCase() : undefined;
    // Precedence: config override (forces foreign) > orgs country != 'KR'.
    const foreign =
      foreignIds.has(id) ||
      foreignGroups.has(group) ||
      (countryCode !== undefined && countryCode !== 'KR');
    const team: Team = { id, name, group, foreign };
    if (countryCode !== undefined) team.countryCode = countryCode;
    return team;
  }

  async function loadContest(): Promise<Contest> {
    const raw = (await getJson(joinUrl(opts.apiBase, 'contest.json'))) as RawSpotboardContest;
    const problems: Problem[] = (raw.problems ?? []).map((p, index) => ({
      id: String(p.id),
      // Label from "name", falling back to the first character of the title.
      label: p.name ?? (p.title ?? '').charAt(0),
      title: p.title ?? '',
      color: p.color ?? '',
      order: index,
    }));
    const teams = new Map<string, Team>();
    for (const rawTeam of raw.teams ?? []) {
      if (excluded.has(String(rawTeam.id))) continue;
      const team = toTeam(rawTeam);
      teams.set(team.id, team);
    }
    return {
      title: raw.title ?? '',
      systemName: raw.systemName ?? '',
      systemVersion: raw.systemVersion ?? '',
      problems,
      teams,
    };
  }

  async function fetchRuns(cursor: unknown): Promise<FetchRunsResult> {
    const from = cursor ?? 0;
    const url = `${joinUrl(opts.apiBase, 'runs.json')}?from=${encodeURIComponent(String(from))}`;
    const raw = (await getJson(url)) as RawSpotboardRuns;

    const runs: Run[] = [];
    for (const r of raw.runs ?? []) {
      const teamId = String(r.team);
      if (excluded.has(teamId)) continue; // drop excluded-team runs before diff
      const { verdict, penaltyCounts } = normalizeSpotboardResult(r.result ?? '');
      // String-safe minute parsing (changed_runs.json may send strings).
      const minute = parseInt(String(r.submissionTime), 10);
      runs.push({
        id: String(r.id),
        teamId,
        problemId: String(r.problem),
        minute: Number.isNaN(minute) ? 0 : minute,
        verdict,
        penaltyCounts,
        seq: Number(r.id),
      });
    }

    // NaN-safe contestTime (seconds) → null when absent or unparsable.
    const rawContestTime = raw.time?.contestTime;
    const contestTimeNum = rawContestTime === undefined || rawContestTime === null ? NaN : Number(rawContestTime);
    const contestTimeSec = Number.isFinite(contestTimeNum) ? contestTimeNum : null;

    return {
      runs,
      contestTimeSec,
      // Absent field → false (fixes the original CoffeeScript existential bug).
      noMoreUpdate: raw.time?.noMoreUpdate === true,
      // Opaque passthrough — echoed back as ?from= on the next poll.
      cursor: raw.time?.timestamp ?? from,
    };
  }

  return { loadContest, fetchRuns };
}
