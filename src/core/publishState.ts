/**
 * publish-state.json contract (publish-modes spec §4). Framework-free.
 *
 * The prepare page writes this file ("확정 결과 저장"), `npm run publish`
 * validates and embeds it, and the static public page reads it. It holds the
 * final standings (no run list), the problems, the orgs of the schools that
 * took part, the award titles, and the per-mode values (spec §5.3, §6.4).
 *
 * Unlike config.json, the schema is strict: an unknown key, a missing key or
 * a wrong `schemaVersion` is an error, never a default. Every error names its
 * zod path as "publish-state.<path>: <message>".
 */

import { z } from 'zod';
import type { PrelimStage } from './preliminary';
import type { SiteScoreCoefficients } from './apac';
import type {
  AutoLabel,
  CellState,
  OrgEntry,
  OrgsIndex,
  Problem,
  Snapshot,
  Team,
  TeamStanding,
  Verdict,
} from './types';

export const PUBLISH_STATE_VERSION = 1;

export type PublishMode = 'off' | 'preliminary' | 'regional';

/** Regional simulation inputs (spec §6.4): initial values of the public page. */
export interface RegionalSimInputs {
  /** U_p: schools in the preliminary. */
  prelimSchools: number | null;
  /** T_p: teams in the preliminary. */
  prelimTeams: number | null;
  coefficients: SiteScoreCoefficients;
  /** U_r, T_r, F_r typed by the operator; null → counted from the standings. */
  regionalOverride: { schools: number | null; teams: number | null; foreign: number | null };
  /** Previous-year WF medal schools (Q = 3). */
  wfMedalGroups: string[];
  /** Winner schools of other regionals (removed from the list). */
  winnerGroups: string[];
  /** Schools already invited by another path (removed from the list). */
  invitedGroups: string[];
  /** Teams already invited (config only; gold star). */
  invitedTeamIds: string[];
  /** Assumed invitation cutoff on the value; null → gold for the winner only. */
  cutoff: number | null;
}

/** Preliminary result (spec §5.3): the inputs and the computed selection. */
export interface PreliminaryResultState {
  totalTeams: number;
  topN: number;
  k: number;
  ineligibleTeamIds: string[];
  /** Selection order. The public page shows this list as is. */
  selected: { teamId: string; stage: PrelimStage }[];
}

/** CellState without the owning team id (the standing holds it). */
export type SerializedCell = Omit<CellState, 'teamId'>;

/** TeamStanding with `cells` as an array in problem (Map) order. */
export type SerializedStanding = Omit<TeamStanding, 'cells'> & { cells: SerializedCell[] };

/** Plain-JSON mirror of Snapshot: Maps become arrays, `byTeam` is rebuilt. */
export interface SerializedSnapshot {
  standings: SerializedStanding[];
  /** Map order of Snapshot.firstSolvers. */
  firstSolvers: { problemId: string; teamIds: string[] }[];
  contestFirstYes: { teamId: string; problemId: string } | null;
  contestLastYes: { teamId: string; problemId: string } | null;
}

export interface PublishDisplay {
  showTeamGroup: boolean;
  showFirstSolve: boolean;
  showBalloons: boolean;
  showSchoolLogos: boolean;
}

interface PublishStateBase {
  schemaVersion: 1;
  generatedAt: string;
  title: string;
  display: PublishDisplay;
  problems: Problem[];
  /** Only the groups of the teams in the snapshot. */
  orgs: OrgsIndex;
  snapshot: SerializedSnapshot;
  /** Team id → award titles (awards.json strings only). */
  manualLabels: Record<string, string[]>;
}

export type PublishState = PublishStateBase &
  (
    | { mode: 'off' }
    | { mode: 'preliminary'; preliminary: PreliminaryResultState }
    | { mode: 'regional'; regional: RegionalSimInputs }
  );

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const count = z.number().int().nonnegative();
const nullableCount = count.nullable();
const verdictSchema = z.enum(['accepted', 'pending', 'failed']) satisfies z.ZodType<Verdict>;
const teamRefSchema = z.object({ teamId: z.string(), problemId: z.string() }).strict();

const problemSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    title: z.string(),
    color: z.string(),
    order: z.number().int(),
  })
  .strict() satisfies z.ZodType<Problem>;

const orgEntrySchema = z
  .object({ country: z.string().optional(), logo: z.string().optional() })
  .strict() satisfies z.ZodType<OrgEntry>;

const teamSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    group: z.string(),
    countryCode: z.string().optional(),
    foreign: z.boolean(),
  })
  .strict() satisfies z.ZodType<Team>;

const autoLabelSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('triedNTimes'), attempts: count }).strict(),
  z.object({ kind: z.literal('contestFirstYes') }).strict(),
  z.object({ kind: z.literal('firstToSolve'), problemLabels: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal('lastToSolve'), problemLabels: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal('contestLastYes') }).strict(),
]) satisfies z.ZodType<AutoLabel>;

const cellSchema = z
  .object({
    problemId: z.string(),
    verdict: verdictSchema.nullable(),
    attempts: count,
    failedAttempts: count,
    solvedMinute: count.nullable(),
    isFirstSolve: z.boolean(),
    isLastSolve: z.boolean(),
    isContestFirstSolve: z.boolean(),
    isContestLastSolve: z.boolean(),
  })
  .strict() satisfies z.ZodType<SerializedCell>;

const standingSchema = z
  .object({
    team: teamSchema,
    solved: count,
    penalty: count,
    lastSolvedMinute: count,
    icpcRank: z.number().int().positive(),
    domesticRank: z.number().int().positive().nullable(),
    schoolRank: z.number().int().positive(),
    cells: z.array(cellSchema),
    autoLabels: z.array(autoLabelSchema),
  })
  .strict() satisfies z.ZodType<SerializedStanding>;

const snapshotSchema = z
  .object({
    standings: z.array(standingSchema),
    firstSolvers: z.array(
      z.object({ problemId: z.string(), teamIds: z.array(z.string()) }).strict(),
    ),
    contestFirstYes: teamRefSchema.nullable(),
    contestLastYes: teamRefSchema.nullable(),
  })
  .strict() satisfies z.ZodType<SerializedSnapshot>;

const displaySchema = z
  .object({
    showTeamGroup: z.boolean(),
    showFirstSolve: z.boolean(),
    showBalloons: z.boolean(),
    showSchoolLogos: z.boolean(),
  })
  .strict() satisfies z.ZodType<PublishDisplay>;

const preliminarySchema = z
  .object({
    totalTeams: z.number().int().positive(),
    topN: count,
    k: count,
    ineligibleTeamIds: z.array(z.string()),
    selected: z.array(
      z
        .object({ teamId: z.string(), stage: z.enum(['top', 'school', 'fill']) })
        .strict(),
    ),
  })
  .strict() satisfies z.ZodType<PreliminaryResultState>;

const coefficientsSchema = z
  .object({
    regionalSchools: z.number().finite(),
    regionalTeams: z.number().finite(),
    prelimSchools: z.number().finite(),
    prelimTeams: z.number().finite(),
    foreignTeams: z.number().finite(),
  })
  .strict() satisfies z.ZodType<SiteScoreCoefficients>;

const regionalSchema = z
  .object({
    prelimSchools: nullableCount,
    prelimTeams: nullableCount,
    coefficients: coefficientsSchema,
    regionalOverride: z
      .object({ schools: nullableCount, teams: nullableCount, foreign: nullableCount })
      .strict(),
    wfMedalGroups: z.array(z.string()),
    winnerGroups: z.array(z.string()),
    invitedGroups: z.array(z.string()),
    invitedTeamIds: z.array(z.string()),
    cutoff: z.number().finite().nonnegative().nullable(),
  })
  .strict() satisfies z.ZodType<RegionalSimInputs>;

/**
 * Strict schema of {@link RegionalSimInputs}. The prepare page also uses it to
 * check inputs it reads back from localStorage.
 */
export const regionalSimInputsSchema = regionalSchema;

const baseShape = {
  schemaVersion: z.literal(PUBLISH_STATE_VERSION),
  generatedAt: z.string().datetime(),
  title: z.string(),
  display: displaySchema,
  problems: z.array(problemSchema),
  orgs: z.record(z.string(), orgEntrySchema),
  snapshot: snapshotSchema,
  manualLabels: z.record(z.string(), z.array(z.string())),
};

const publishStateSchema = z
  .discriminatedUnion('mode', [
    z.object({ ...baseShape, mode: z.literal('off') }).strict(),
    z
      .object({ ...baseShape, mode: z.literal('preliminary'), preliminary: preliminarySchema })
      .strict(),
    z.object({ ...baseShape, mode: z.literal('regional'), regional: regionalSchema }).strict(),
  ])
  .superRefine(checkReferences) satisfies z.ZodType<PublishState>;

/**
 * Cross-field checks a hand-edited file can break: team ids are unique, each
 * standing has exactly one cell per problem, and the preliminary selection
 * names teams of the snapshot.
 */
function checkReferences(state: PublishState, ctx: z.RefinementCtx): void {
  const problemIds = new Set<string>();
  state.problems.forEach((p, i) => {
    if (problemIds.has(p.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['problems', i, 'id'],
        message: `duplicate problem id "${p.id}"`,
      });
    }
    problemIds.add(p.id);
  });

  const teamIds = new Set<string>();
  state.snapshot.standings.forEach((s, i) => {
    if (teamIds.has(s.team.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['snapshot', 'standings', i, 'team', 'id'],
        message: `duplicate team id "${s.team.id}"`,
      });
    }
    teamIds.add(s.team.id);

    const seen = new Set<string>();
    for (const cell of s.cells) seen.add(cell.problemId);
    const complete =
      seen.size === s.cells.length &&
      seen.size === problemIds.size &&
      [...seen].every((id) => problemIds.has(id));
    if (!complete) {
      ctx.addIssue({
        code: 'custom',
        path: ['snapshot', 'standings', i, 'cells'],
        message: 'expected exactly one cell per problem',
      });
    }
  });

  if (state.mode === 'preliminary') {
    const selected = new Set<string>();
    state.preliminary.selected.forEach((entry, i) => {
      const path = ['preliminary', 'selected', i, 'teamId'];
      if (!teamIds.has(entry.teamId)) {
        ctx.addIssue({ code: 'custom', path, message: `unknown team id "${entry.teamId}"` });
      } else if (selected.has(entry.teamId)) {
        ctx.addIssue({ code: 'custom', path, message: `duplicate team id "${entry.teamId}"` });
      }
      selected.add(entry.teamId);
    });
  }
}

function formatIssue(issue: z.ZodIssue): string {
  return issue.path.length > 0
    ? `publish-state.${issue.path.join('.')}: ${issue.message}`
    : `publish-state: ${issue.message}`;
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `type "${typeof v}"`;
}

// ---------------------------------------------------------------------------
// Build / parse / restore
// ---------------------------------------------------------------------------

function serializeStanding(s: TeamStanding): SerializedStanding {
  const { team } = s;
  return {
    team: {
      id: team.id,
      name: team.name,
      group: team.group,
      ...(team.countryCode !== undefined ? { countryCode: team.countryCode } : {}),
      foreign: team.foreign,
    },
    solved: s.solved,
    penalty: s.penalty,
    lastSolvedMinute: s.lastSolvedMinute,
    icpcRank: s.icpcRank,
    domesticRank: s.domesticRank,
    schoolRank: s.schoolRank,
    cells: [...s.cells.values()].map(({ teamId: _teamId, ...cell }) => cell),
    autoLabels: s.autoLabels.map((label) =>
      label.kind === 'firstToSolve' || label.kind === 'lastToSolve'
        ? { ...label, problemLabels: [...label.problemLabels] }
        : { ...label },
    ),
  };
}

function serializeSnapshot(snapshot: Snapshot): SerializedSnapshot {
  return {
    standings: snapshot.standings.map(serializeStanding),
    firstSolvers: [...snapshot.firstSolvers].map(([problemId, teamIds]) => ({
      problemId,
      teamIds: [...teamIds],
    })),
    contestFirstYes: snapshot.contestFirstYes && { ...snapshot.contestFirstYes },
    contestLastYes: snapshot.contestLastYes && { ...snapshot.contestLastYes },
  };
}

/**
 * Builds the file content from the prepare page's state. Only the orgs of the
 * schools in the snapshot and the labels of its teams are kept. Throws when
 * the result breaks the schema (e.g. the mode's payload is missing, a NaN
 * input): the prepare page must never download a file the script refuses.
 */
export function buildPublishState(input: {
  mode: PublishMode;
  title: string;
  display: PublishDisplay;
  problems: Problem[];
  orgs: OrgsIndex;
  snapshot: Snapshot;
  manualLabels: ReadonlyMap<string, readonly string[]> | null;
  preliminary?: PreliminaryResultState;
  regional?: RegionalSimInputs;
  now?: Date;
}): PublishState {
  const { snapshot } = input;

  const orgs: OrgsIndex = {};
  for (const { team } of snapshot.standings) {
    const entry = Object.hasOwn(input.orgs, team.group) ? input.orgs[team.group] : undefined;
    if (entry === undefined || Object.hasOwn(orgs, team.group)) continue;
    orgs[team.group] = {
      ...(entry.country !== undefined ? { country: entry.country } : {}),
      ...(entry.logo !== undefined ? { logo: entry.logo } : {}),
    };
  }

  const manualLabels: Record<string, string[]> = {};
  for (const [teamId, labels] of input.manualLabels ?? []) {
    if (snapshot.byTeam.has(teamId)) manualLabels[teamId] = [...labels];
  }

  const base: PublishStateBase = {
    schemaVersion: PUBLISH_STATE_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    title: input.title,
    display: { ...input.display },
    problems: input.problems.map((p) => ({
      id: p.id,
      label: p.label,
      title: p.title,
      color: p.color,
      order: p.order,
    })),
    orgs,
    snapshot: serializeSnapshot(snapshot),
    manualLabels,
  };

  let state: PublishState;
  switch (input.mode) {
    case 'off':
      state = { ...base, mode: 'off' };
      break;
    case 'preliminary':
      if (input.preliminary === undefined) {
        throw new Error('buildPublishState: mode "preliminary" needs a preliminary payload');
      }
      state = { ...base, mode: 'preliminary', preliminary: structuredClone(input.preliminary) };
      break;
    case 'regional':
      if (input.regional === undefined) {
        throw new Error('buildPublishState: mode "regional" needs a regional payload');
      }
      state = { ...base, mode: 'regional', regional: structuredClone(input.regional) };
      break;
  }

  const result = publishStateSchema.safeParse(state);
  if (!result.success) {
    throw new Error(
      `buildPublishState: invalid state\n${result.error.issues.map(formatIssue).join('\n')}`,
    );
  }
  return state;
}

/**
 * Validates a parsed publish-state.json. The version is checked first, so an
 * older file gets one clear message instead of every shape difference.
 */
export function parsePublishState(
  json: unknown,
): { ok: true; state: PublishState } | { ok: false; errors: string[] } {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return {
      ok: false,
      errors: [`publish-state: expected an object, received ${describeValue(json)}`],
    };
  }
  const version = (json as Record<string, unknown>).schemaVersion;
  if (version !== PUBLISH_STATE_VERSION) {
    const got = version === undefined ? 'missing' : JSON.stringify(version);
    return {
      ok: false,
      errors: [
        `publish-state.schemaVersion: unsupported version ${got} (expected ${PUBLISH_STATE_VERSION})`,
      ],
    };
  }
  const result = publishStateSchema.safeParse(json);
  if (!result.success) return { ok: false, errors: result.error.issues.map(formatIssue) };
  return { ok: true, state: result.data };
}

/** Rebuilds the Snapshot (Maps, `byTeam` sharing the standing objects). */
export function restoreSnapshot(state: PublishState): Snapshot {
  const src = state.snapshot;
  const standings: TeamStanding[] = src.standings.map((s) => {
    const team: Team = {
      id: s.team.id,
      name: s.team.name,
      group: s.team.group,
      ...(s.team.countryCode !== undefined ? { countryCode: s.team.countryCode } : {}),
      foreign: s.team.foreign,
    };
    const cells = new Map<string, CellState>();
    for (const cell of s.cells) cells.set(cell.problemId, { teamId: team.id, ...cell });
    return {
      team,
      solved: s.solved,
      penalty: s.penalty,
      lastSolvedMinute: s.lastSolvedMinute,
      icpcRank: s.icpcRank,
      domesticRank: s.domesticRank,
      schoolRank: s.schoolRank,
      cells,
      autoLabels: s.autoLabels.map((label) => ({ ...label })),
    };
  });
  return {
    standings,
    byTeam: new Map(standings.map((s) => [s.team.id, s])),
    firstSolvers: new Map(src.firstSolvers.map((f) => [f.problemId, [...f.teamIds]])),
    contestFirstYes: src.contestFirstYes && { ...src.contestFirstYes },
    contestLastYes: src.contestLastYes && { ...src.contestLastYes },
  };
}
