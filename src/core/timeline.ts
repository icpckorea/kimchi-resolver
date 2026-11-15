/**
 * Rank timeline (time-machine "Timeline" view, design 2026-11-15).
 *
 * Pure derivation from the RAW run list of the feed — not the feeder's
 * applied/queued lists, which drop runs after a cell's accepted run and
 * depend on `time=`:
 *
 * - `ranks.get(team)[t]` is the board's `icpcRank` after every run with
 *   `minute ≤ t` (the `time=` replay rule). It reuses `computeStandings` per
 *   minute, so ties, no-penalty rejections and pending runs follow the board
 *   exactly.
 * - `events.get(team)` lists the team's submissions in seq order. Runs after
 *   the cell's first accepted run are kept and flagged `afterSolve`; runs in a
 *   row with the same minute, problem, kind and flag are grouped (`count`).
 */
import { computeStandings } from './standings';
import type { Contest, Run } from './types';

/** At most this many teams on one chart. */
export const TIMELINE_MAX_TEAMS = 6;

/** Categorical colors by slot (dataviz reference palette, light mode). */
export const TIMELINE_COLORS: readonly string[] = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#6250d6',
];

export type TimelineEventKind = 'accepted' | 'rejected' | 'noPenalty' | 'pending';

export interface TimelineEvent {
  minute: number;
  problemId: string;
  kind: TimelineEventKind;
  /** The cell was already solved by an earlier run (seq order). */
  afterSolve: boolean;
  /** Runs grouped into this event (same minute, problem, kind, afterSolve). */
  count: number;
  /** seq of the first grouped run. */
  firstSeq: number;
}

export interface RankTimeline {
  endMinute: number;
  /** Teams ranked (`contest.teams.size`): the bottom of the rank axis. */
  teamCount: number;
  /** team id → rank for minutes 0..endMinute. */
  ranks: ReadonlyMap<string, readonly number[]>;
  /** team id → submissions in seq order (teams with none: empty list). */
  events: ReadonlyMap<string, readonly TimelineEvent[]>;
}

/** A new map with `incoming` merged by run id (a later copy replaces). */
export function mergeRuns(known: ReadonlyMap<string, Run>, incoming: readonly Run[]): Map<string, Run> {
  const out = new Map(known);
  for (const run of incoming) out.set(run.id, run);
  return out;
}

/**
 * Last minute of the chart: the time slider's maximum
 * (`ceil(contestTimeSec / 60)`), at least the last run minute.
 */
export function timelineEndMinute(contestTimeSec: number | null, runs: readonly Run[]): number {
  let end = contestTimeSec === null || !Number.isFinite(contestTimeSec) ? 0 : Math.ceil(contestTimeSec / 60);
  for (const run of runs) if (run.minute > end) end = run.minute;
  return Math.max(0, end);
}

function kindOf(run: Run): TimelineEventKind {
  if (run.verdict === 'accepted') return 'accepted';
  if (run.verdict === 'pending') return 'pending';
  return run.penaltyCounts ? 'rejected' : 'noPenalty';
}

export function computeRankTimeline(contest: Contest, runs: readonly Run[], endMinute: number): RankTimeline {
  const known = runs.filter((r) => contest.teams.has(r.teamId));
  const byTime = [...known].sort((a, b) => a.minute - b.minute || a.seq - b.seq);

  const ranks = new Map<string, number[]>();
  for (const id of contest.teams.keys()) ranks.set(id, new Array<number>(endMinute + 1));
  let cursor = 0;
  let previous: Map<string, number> | null = null;
  for (let t = 0; t <= endMinute; t++) {
    let changed = previous === null;
    while (cursor < byTime.length && byTime[cursor].minute <= t) {
      cursor += 1;
      changed = true;
    }
    if (changed) {
      const snapshot = computeStandings(contest, byTime.slice(0, cursor));
      previous = new Map(snapshot.standings.map((s) => [s.team.id, s.icpcRank]));
    }
    for (const [id, list] of ranks) list[t] = previous!.get(id) ?? contest.teams.size;
  }

  const events = new Map<string, TimelineEvent[]>();
  for (const id of contest.teams.keys()) events.set(id, []);
  const solvedAt = new Map<string, number>(); // "team problem" → seq of the first accepted run
  for (const run of [...known].sort((a, b) => a.seq - b.seq)) {
    const key = `${run.teamId} ${run.problemId}`;
    const first = solvedAt.get(key);
    const afterSolve = first !== undefined && run.seq > first;
    if (run.verdict === 'accepted' && first === undefined) solvedAt.set(key, run.seq);
    const kind = kindOf(run);
    const list = events.get(run.teamId)!;
    const last = list[list.length - 1];
    if (
      last !== undefined &&
      last.minute === run.minute &&
      last.problemId === run.problemId &&
      last.kind === kind &&
      last.afterSolve === afterSolve
    ) {
      last.count += 1;
    } else {
      list.push({ minute: run.minute, problemId: run.problemId, kind, afterSolve, count: 1, firstSeq: run.seq });
    }
  }

  return { endMinute, teamCount: contest.teams.size, ranks, events };
}
