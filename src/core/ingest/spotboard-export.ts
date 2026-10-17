/**
 * Spotboard export: the inverse of the spotboard adapter (spotboard.ts).
 *
 * Takes the normalized Contest and Run[] (from any adapter, in practice the
 * Contest API one) and builds the two static files of the classic spotboard
 * protocol, contest.json and runs.json. The 'spotboard' source or the original
 * Spotboard can serve them from a plain folder with no credential.
 *
 * Pure: no I/O, no clock unless the caller omits `timestamp`.
 */

import type { Contest, Run } from '../types';
import { toSpotboardResult } from '../verdict';

export interface SpotboardContestFile {
  title: string;
  systemName: string;
  systemVersion: string;
  problems: Array<{ id: string; name: string; title: string; color: string }>;
  teams: Array<{ id: string; name: string; group: string }>;
}

export interface SpotboardRunsFile {
  /**
   * Present (true) only on unfrozen output. `scripts/check-config-security.mjs`
   * fails the build when a public/ folder holds such a file. The spotboard
   * adapter ignores keys it does not know.
   */
  kimchiUnfrozen?: true;
  time: { contestTime: number | null; noMoreUpdate: boolean; timestamp: number };
  runs: Array<{ id: number; team: string; problem: string; result: string; submissionTime: number }>;
}

export interface SpotboardRunsOptions {
  /** Elapsed contest seconds; null before the start. */
  contestTimeSeconds: number | null;
  noMoreUpdate: boolean;
  /**
   * First contest minute that is frozen. A run with `minute >= freezeMinute`
   * is written as pending. null/undefined: the contest has no freeze, nothing
   * is masked.
   */
  freezeMinute?: number | null;
  /** Keep the real results of frozen runs and mark the file `kimchiUnfrozen`. */
  unfreeze: boolean;
  /** Epoch seconds. Default: now. */
  timestamp?: number;
}

/** contest.json. Team order and problem order are kept. */
export function toSpotboardContest(contest: Contest): SpotboardContestFile {
  return {
    title: contest.title,
    systemName: contest.systemName,
    systemVersion: contest.systemVersion,
    // `name` is the grid label ("A"); the adapter reads it back as Problem.label.
    problems: contest.problems.map((p) => ({ id: p.id, name: p.label, title: p.title, color: p.color })),
    // `group` is always written, even when empty: without the field the adapter
    // would try to split "Name (Group)" out of the name.
    teams: [...contest.teams.values()].map((t) => ({ id: t.id, name: t.name, group: t.group })),
  };
}

/**
 * runs.json. `id` is the run's seq, a number, because the spotboard adapter
 * orders runs by `Number(id)`; this keeps the order of the source stable.
 * Runs are sorted by seq.
 */
export function toSpotboardRuns(runs: readonly Run[], opts: SpotboardRunsOptions): SpotboardRunsFile {
  const freezeMinute = opts.freezeMinute ?? null;
  const out = [...runs]
    .sort((a, b) => a.seq - b.seq)
    .map((run) => {
      const frozen = !opts.unfreeze && freezeMinute !== null && run.minute >= freezeMinute;
      return {
        id: run.seq,
        team: run.teamId,
        problem: run.problemId,
        result: frozen ? '' : toSpotboardResult(run.verdict, run.penaltyCounts),
        submissionTime: run.minute,
      };
    });
  const file: SpotboardRunsFile = {
    time: {
      contestTime: opts.contestTimeSeconds,
      noMoreUpdate: opts.noMoreUpdate,
      timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    },
    runs: out,
  };
  if (opts.unfreeze) file.kimchiUnfrozen = true;
  return file;
}
