/**
 * Core domain contract. Framework-free: no React/DOM imports anywhere in src/core.
 *
 * This file is the single source of truth for module boundaries. Workflow agents
 * implement against these types; if a contract change seems necessary, report it
 * instead of editing this file.
 *
 * Spec: docs/superpowers/specs/2026-07-30-kimchi-resolver-design.md
 */

// ---------------------------------------------------------------------------
// Contest entities (ids are strings; spotboard numeric ids are stringified)
// ---------------------------------------------------------------------------

export interface Problem {
  id: string;
  /** Single-letter label shown in the grid, e.g. "A". */
  label: string;
  /** Full problem title, e.g. "Adventurer Dabi". */
  title: string;
  /** Any CSS color (named or hex) — drives balloon tinting. */
  color: string;
  /** Display order (array order of the source feed). */
  order: number;
}

export interface Team {
  id: string;
  name: string;
  /** Affiliation (university). */
  group: string;
  /** ISO 3166-1 alpha-2, uppercase, e.g. "KR". Undefined when unknown. */
  countryCode?: string;
  /** True → no domestic (national contest) rank. */
  foreign: boolean;
}

export interface Contest {
  title: string;
  systemName: string;
  systemVersion: string;
  /** Dense, in display order. */
  problems: Problem[];
  /** Keyed by team id. Excluded teams are NOT present here. */
  teams: Map<string, Team>;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type Verdict = 'accepted' | 'pending' | 'failed';

export interface Run {
  id: string;
  teamId: string;
  problemId: string;
  /** Contest minute of submission (floor). */
  minute: number;
  verdict: Verdict;
  /**
   * False for no-penalty rejections (e.g. compile error under Contest API
   * judgement-types with penalty=false). Always true for spotboard "No - *".
   * Meaningless when verdict is 'accepted' or 'pending'.
   */
  penaltyCounts: boolean;
  /**
   * Total order of runs, ascending by submission order. Numeric run id for
   * spotboard; adapter-assigned monotonic counter for Contest API.
   * Net-run truncation and last-solve tie-breaks compare seq.
   */
  seq: number;
}

// ---------------------------------------------------------------------------
// Standings snapshot (pure derivation from applied runs)
// ---------------------------------------------------------------------------

export interface CellState {
  teamId: string;
  problemId: string;
  /** null → never attempted. Otherwise verdict of the last net run. */
  verdict: Verdict | null;
  /** Net runs count (runs up to and including the first accepted). */
  attempts: number;
  /** Net failed runs with penaltyCounts (drives the 20-min penalty). */
  failedAttempts: number;
  /** Contest minute of the accepting run; null unless accepted. */
  solvedMinute: number | null;
  isFirstSolve: boolean;
  /** Latest accepted run of this problem (minute, then seq). */
  isLastSolve: boolean;
  /** Globally earliest accepted run of the contest. */
  isContestFirstSolve: boolean;
  /** Globally latest accepted run of the contest. */
  isContestLastSolve: boolean;
}

/** Auto label kinds (spec §4). Text rendering belongs to the UI layer. */
export type AutoLabel =
  | { kind: 'triedNTimes'; attempts: number }
  | { kind: 'contestFirstYes' }
  | { kind: 'firstToSolve'; problemLabels: string[] }
  | { kind: 'lastToSolve'; problemLabels: string[] }
  | { kind: 'contestLastYes' };

export interface TeamStanding {
  team: Team;
  solved: number;
  penalty: number;
  /** Minute of the team's latest accepted run; 0 when none. */
  lastSolvedMinute: number;
  /** Competition ranking with gaps over ALL teams. */
  icpcRank: number;
  /** Same comparator over non-foreign teams only; null for foreign teams. */
  domesticRank: number | null;
  /** 1-based rank within the team's group, by icpc standing order. */
  schoolRank: number;
  /** Keyed by problem id. Every contest problem has an entry. */
  cells: Map<string, CellState>;
  autoLabels: AutoLabel[];
}

export interface Snapshot {
  /** Sorted by icpc standing order (rank asc, comparator order). */
  standings: TeamStanding[];
  byTeam: Map<string, TeamStanding>;
  /** Problem id → team id of first solver(s). */
  firstSolvers: Map<string, string[]>;
  contestFirstYes: { teamId: string; problemId: string } | null;
  contestLastYes: { teamId: string; problemId: string } | null;
}

/** Pure. Recomputed wholesale; memoize at the call site. */
export type ComputeStandings = (contest: Contest, appliedRuns: readonly Run[]) => Snapshot;

// ---------------------------------------------------------------------------
// Feed pipeline
// ---------------------------------------------------------------------------

export interface FetchRunsResult {
  runs: Run[];
  /** Elapsed contest seconds as reported by the feed. */
  contestTimeSec: number | null;
  /** False when the field is absent (spec: fixes the original parsing bug). */
  noMoreUpdate: boolean;
  /** Opaque cursor echoed back on the next poll. */
  cursor: unknown;
}

export interface FeedSource {
  loadContest(): Promise<Contest>;
  /** Returns ALL runs (or a server-side delta); the feeder diffs. */
  fetchRuns(cursor: unknown): Promise<FetchRunsResult>;
}

/**
 * Holds the applied-run set and the not-yet-displayed queue.
 * Diff rules (spec §5): unknown id → accept; same id → reject when the
 * known run is accepted, else accept iff minute or verdict changed
 * (compare against the queued version when still queued); reject when the
 * (team, problem) cell is already accepted in the applied set.
 */
export interface RunFeeder {
  readonly queueLength: number;
  readonly contestTimeSec: number | null;
  readonly noMoreUpdate: boolean;
  readonly cursor: unknown;
  readonly appliedRuns: readonly Run[];
  /** Diff `incoming` against known runs and enqueue what passes. Returns count queued. */
  ingest(result: FetchRunsResult): number;
  /** Apply up to n queued runs. Returns the runs applied (may be fewer). */
  feed(n: number): Run[];
  /** Apply queued runs while the predicate holds (peeking in queue order). */
  feedWhile(criteria: (run: Run) => boolean): Run[];
  /** Apply everything queued. */
  feedAll(): Run[];
}

// ---------------------------------------------------------------------------
// Award ceremony state machine (pure; DOM-free)
// ---------------------------------------------------------------------------

export type AwardTeamStage = 'hidden' | 'focused' | 'finalized';

export interface AwardRevealEffect {
  /** Gacha shake+sparkle before the last flip (spec §6). */
  gacha: boolean;
  /** Finale: continuous full-cell rainbow overlay + spotlight/zoom. */
  finale: boolean;
}

export type AwardStepResult =
  | { type: 'locked' }
  | { type: 'slide-on' }
  | { type: 'focus'; teamId: string }
  | { type: 'blink'; teamId: string; problemId: string }
  | {
      type: 'reveal';
      teamId: string;
      problemId: string;
      /** Runs to animate, in order; last one carries the cell's final state here. */
      runs: Run[];
      effect: AwardRevealEffect;
    }
  | { type: 'finalize'; teamId: string; showSlide: boolean }
  | { type: 'end' };

export interface AwardConfigInput {
  hideName: boolean;
  rankBegin: number | null;
  revealOrder: string[];
  focusBlinking: { minSolved: number; maxRank: number } | null;
  gachaEffectRequirement: number;
  gachaEffectForNoRatio: number;
}

export interface AwardMachine {
  /** One user keypress → one state transition. */
  advance(): AwardStepResult;
  dismissSlide(): void;
  readonly remainingReveals: number;
  readonly teamStage: ReadonlyMap<string, AwardTeamStage>;
  readonly currentSlideTeamId: string | null;
  /** Snapshot of the currently-visible (partially revealed) standings. */
  readonly snapshot: Snapshot;
  readonly finished: boolean;
}

/** RNG injected for deterministic tests; returns [0, 1). */
export type Rng = () => number;

// ---------------------------------------------------------------------------
// School metadata / APAC
// ---------------------------------------------------------------------------

export interface OrgEntry {
  country?: string;
  logo?: string;
}

/** group name → entry. Loaded from public/orgs/orgs.json. */
export type OrgsIndex = Record<string, OrgEntry>;

export type ApacStar = 'bronze' | 'silver' | 'gold' | null;

// ---------------------------------------------------------------------------
// App modes
// ---------------------------------------------------------------------------

export type AppMode = 'spectator' | 'award' | 'publish';
