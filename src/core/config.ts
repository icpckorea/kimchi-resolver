/**
 * Config loader: zod schema for public/config.json (spec §9) + URL parameter
 * overrides (spec §9/§13) + app mode selection.
 *
 * Framework-free (no React/DOM). `URLSearchParams` is available in both
 * browsers and Node.
 */
import { z } from 'zod';
import type { AppMode } from './types';

// ---------------------------------------------------------------------------
// Schema (every key optional, spec defaults — partial config allowed)
// ---------------------------------------------------------------------------

/** Team/problem ids are strings internally; numeric ids in JSON are stringified. */
const idSchema = z.union([z.string(), z.number().int()]).transform((v) => String(v));

const sourceSchema = z
  .object({
    type: z.enum(['spotboard', 'contest-api']).default('spotboard'),
    /** spotboard: base path/URL holding contest.json + runs.json. */
    apiBase: z.string().default('./sample/'),
    /** contest-api: API root, e.g. "https://judge/api". */
    baseUrl: z.string().default(''),
    /** contest-api: contest id path segment. */
    contestId: z.string().default(''),
    /** contest-api: HTTP basic auth, or null. */
    auth: z
      .object({ username: z.string(), password: z.string() })
      .nullable()
      .default(null),
    /** Poll-trigger ("doorbell") WebSocket URL, or null. */
    eventsWs: z.string().nullable().default(null),
  })
  .default({});

const focusBlinkingSchema = z
  .object({
    minSolved: z.number().int().nonnegative().default(7),
    maxRank: z.number().int().positive().default(10),
  })
  .nullable()
  .default({});

const animationSpeedSchema = z.object({
  minSolved: z.number().int().nonnegative(),
  fastFlip: z.number().positive(),
  slowFlip: z.number().positive(),
  moveUpMsPerRow: z.number().nonnegative(),
});

export const DEFAULT_ANIMATION_SPEEDS: z.output<typeof animationSpeedSchema>[] = [
  { minSolved: 10, fastFlip: 200, slowFlip: 800, moveUpMsPerRow: 200 },
  { minSolved: 0, fastFlip: 300, slowFlip: 700, moveUpMsPerRow: 100 },
];

const awardSchema = z
  .object({
    mode: z.boolean().default(false),
    hideName: z.boolean().default(true),
    rankBegin: z.number().int().positive().nullable().default(null),
    awardsUrl: z.string().default('./sample/awards.json'),
    /** Problem labels or ids, highest priority first. */
    revealOrder: z.array(idSchema).default([]),
    focusBlinking: focusBlinkingSchema,
    gachaEffectRequirement: z.number().int().positive().default(8),
    /** Percent [0, 100]. */
    gachaEffectForNoRatio: z.number().min(0).max(100).default(30),
    /**
     * Normalized to minSolved-descending so matching is order-independent
     * (spec §6: the original's "must be sorted descending" trap is removed).
     */
    animationSpeeds: z
      .array(animationSpeedSchema)
      .default(DEFAULT_ANIMATION_SPEEDS)
      .transform((speeds) => [...speeds].sort((a, b) => b.minSolved - a.minSolved)),
  })
  .default({});

const configSchema = z.object({
  source: sourceSchema,
  fetchTimeout: z.number().positive().default(5000),
  autoRefreshInterval: z.number().positive().default(10000),
  autoPlay: z.boolean().default(true),
  autoPlayDelay: z.number().nonnegative().default(100),
  animation: z.boolean().default(true),
  showTeamGroup: z.boolean().default(true),
  showFirstSolve: z.boolean().default(true),
  showBalloons: z.boolean().default(true),
  showSchoolLogos: z.boolean().default(false),
  showEvents: z.boolean().default(false),
  maxNotifications: z.number().int().nonnegative().default(100),
  pagination: z.boolean().default(false),
  paginationSize: z.number().int().positive().default(50),
  useFollowedTeamSticky: z.boolean().default(true),
  excludeTeams: z.array(idSchema).default([]),
  foreign: z
    .object({
      ids: z.array(idSchema).default([]),
      groups: z.array(z.string()).default([]),
    })
    .default({}),
  apac: z.object({ enabled: z.boolean().default(false) }).default({}),
  publish: z
    .object({
      enabled: z.boolean().default(false),
      siteScore: z.number().positive().nullable().default(null),
      invitedScoreCutoff: z.number().nonnegative().nullable().default(null),
    })
    .default({}),
  award: awardSchema,
});

export type AppConfig = z.output<typeof configSchema>;
export type AwardConfig = AppConfig['award'];
export type SourceConfig = AppConfig['source'];
export type AnimationSpeed = z.output<typeof animationSpeedSchema>;

/**
 * AppConfig plus URL-only parameters resolved by {@link applyUrlOverrides}.
 * These have no config.json counterpart (spec §9: `r`, `time`, `q`, `t`).
 */
export interface ResolvedConfig extends AppConfig {
  /** `r=`: replay runs up to and including this run id, without animation. */
  replayRunId: number | null;
  /** `time=`: replay runs up to this contest minute; forces autoPlay off. */
  replayTimeMinutes: number | null;
  /** `q=`: initial search query (substring match). */
  searchQuery: string | null;
  /** `t=`: id of the team to follow (sticky row). */
  followTeamId: string | null;
}

// ---------------------------------------------------------------------------
// parseConfig
// ---------------------------------------------------------------------------

export interface ParseConfigResult {
  config: AppConfig;
  /** Human-readable descriptions of every rejected key. Empty when clean. */
  errors: string[];
}

/** Spec-default config (what an empty/absent config.json yields). */
export function defaultConfig(): AppConfig {
  return configSchema.parse({});
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `type "${typeof v}"`;
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `config.${path}: ${issue.message}`;
}

/** Deep-clones plain JSON-ish data; non-plain values pass through by reference. */
function deepClonePlain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepClonePlain);
  if (v !== null && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = deepClonePlain(val);
      return out;
    }
  }
  return v;
}

/**
 * Removes the offending value so its default applies on re-parse. Issues
 * inside arrays prune the whole array (a sparse array would be worse).
 */
function pruneAtPath(root: unknown, path: readonly (string | number)[]): unknown {
  if (path.length === 0) return {};
  const firstNumeric = path.findIndex((seg) => typeof seg === 'number');
  const effective = firstNumeric === -1 ? path : path.slice(0, firstNumeric);
  if (effective.length === 0) return {};
  let parent: unknown = root;
  for (let i = 0; i < effective.length - 1; i++) {
    if (parent === null || typeof parent !== 'object') return root;
    parent = (parent as Record<string, unknown>)[effective[i] as string];
  }
  if (parent !== null && typeof parent === 'object' && !Array.isArray(parent)) {
    delete (parent as Record<string, unknown>)[effective[effective.length - 1] as string];
  }
  return root;
}

/**
 * Validates a parsed config.json value. Never throws: invalid keys are
 * reported in `errors` (for SystemMessage display) and replaced by their
 * spec defaults; valid keys are kept.
 */
export function parseConfig(json: unknown): ParseConfigResult {
  const errors: string[] = [];
  let candidate: unknown;
  if (json === undefined || json === null) {
    candidate = {};
  } else if (typeof json !== 'object' || Array.isArray(json)) {
    errors.push(`config: expected an object, received ${describeValue(json)}`);
    candidate = {};
  } else {
    candidate = deepClonePlain(json);
  }

  // Parse; on failure, record the issues, prune the offending keys back to
  // their defaults, and retry. Bounded because each round removes keys.
  for (let round = 0; round < 10; round++) {
    const result = configSchema.safeParse(candidate);
    if (result.success) {
      return { config: result.data, errors: [...new Set(errors)] };
    }
    for (const issue of result.error.issues) {
      errors.push(formatIssue(issue));
      candidate = pruneAtPath(candidate, issue.path);
    }
  }
  // Unreachable in practice; last-resort fallback.
  return { config: defaultConfig(), errors: [...new Set(errors)] };
}

// ---------------------------------------------------------------------------
// applyUrlOverrides
// ---------------------------------------------------------------------------

export interface UrlOverridesResult {
  config: ResolvedConfig;
  /** One entry per ignored/invalid URL parameter value. */
  warnings: string[];
}

/** '', 'true', '1', 'yes', 'on' → true; 'false', '0', 'no', 'off' → false. */
function parseBoolParam(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (s === '' || s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return null;
}

function parseNumberParam(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Applies URL parameter overrides (spec §9/§13) on top of a parsed config.
 * URL wins over config.json. Params: `r`, `time` (forces autoPlay=false),
 * `award`, `award_rank_begin`, `animation`, `q`, `t`, `publish`,
 * `site_score`, `invited_cutoff`. Invalid values are ignored and reported
 * in `warnings`. The input config is not mutated.
 */
export function applyUrlOverrides(config: AppConfig, search: string): UrlOverridesResult {
  // The clone keeps any already-resolved URL fields when re-applied.
  const base = deepClonePlain(config) as AppConfig;
  const out: ResolvedConfig = {
    replayRunId: null,
    replayTimeMinutes: null,
    searchQuery: null,
    followTeamId: null,
    ...base,
  };
  const warnings: string[] = [];
  const params = new URLSearchParams(search);

  const warn = (name: string, raw: string): void => {
    warnings.push(`URL parameter "${name}": invalid value "${raw}" (ignored)`);
  };

  const boolParam = (name: string, apply: (v: boolean) => void): void => {
    const raw = params.get(name);
    if (raw === null) return;
    const v = parseBoolParam(raw);
    if (v === null) warn(name, raw);
    else apply(v);
  };

  const numberParam = (
    name: string,
    check: (n: number) => boolean,
    apply: (n: number) => void,
  ): void => {
    const raw = params.get(name);
    if (raw === null) return;
    const n = parseNumberParam(raw);
    if (n === null || !check(n)) warn(name, raw);
    else apply(n);
  };

  // r=<run id>: replay cutoff.
  numberParam(
    'r',
    (n) => Number.isInteger(n) && n >= 0,
    (n) => {
      out.replayRunId = n;
    },
  );

  // time=<minute>: replay cutoff by contest minute; forces autoPlay off.
  numberParam(
    'time',
    (n) => Number.isInteger(n) && n >= 0,
    (n) => {
      out.replayTimeMinutes = n;
      out.autoPlay = false;
    },
  );

  boolParam('award', (v) => {
    out.award.mode = v;
  });

  numberParam(
    'award_rank_begin',
    (n) => Number.isInteger(n) && n >= 1,
    (n) => {
      out.award.rankBegin = n;
    },
  );

  boolParam('animation', (v) => {
    out.animation = v;
  });

  const q = params.get('q');
  if (q !== null && q !== '') out.searchQuery = q;

  const t = params.get('t');
  if (t !== null && t !== '') out.followTeamId = t;

  boolParam('publish', (v) => {
    out.publish.enabled = v;
  });

  numberParam(
    'site_score',
    (n) => n > 0,
    (n) => {
      out.publish.siteScore = n;
    },
  );

  numberParam(
    'invited_cutoff',
    (n) => n >= 0,
    (n) => {
      out.publish.invitedScoreCutoff = n;
    },
  );

  return { config: out, warnings };
}

// ---------------------------------------------------------------------------
// selectMode
// ---------------------------------------------------------------------------

/**
 * App mode from a (resolved) config. publish takes precedence over award
 * (spec §13). publish only requires `publish.enabled`; `siteScore` may still
 * be null — the UI gates the actual scoreboard on it.
 */
export function selectMode(config: AppConfig): AppMode {
  if (config.publish.enabled) return 'publish';
  if (config.award.mode) return 'award';
  return 'spectator';
}
