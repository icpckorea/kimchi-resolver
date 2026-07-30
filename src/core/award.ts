/**
 * Award ceremony state machine (spec §6). Pure, DOM-free, framework-free.
 *
 * Frozen projection: post-freeze runs ("hiddenRuns") are applied to the
 * visible run set with their verdict masked as 'pending' at construction.
 * Their real results are kept in per-(team, problem) reveal queues and get
 * swapped into the visible set when the corresponding cell is revealed —
 * "two projections of the same run list", replacing the original's
 * strategy monkey-patch.
 *
 * One advance() call = one user keypress = one state transition:
 *   slide-on → (focus | blink | reveal | finalize | end)
 *
 * Deliberately NOT ported from the original (docs/spotboard-analysis.md §2):
 *   - revealOrder falsy-zero bug (problem at index 0 / id "0" works here),
 *   - unreachable 'end' (TypeError on the last keypress in the original),
 *   - foreign teams last (re-planned: unified bottom-up over the ICPC rank).
 */
import type {
  AwardConfigInput,
  AwardMachine,
  AwardStepResult,
  AwardTeamStage,
  ComputeStandings,
  Contest,
  Rng,
  Run,
  Snapshot,
} from './types';

export interface CreateAwardMachineOptions {
  contest: Contest;
  /** Runs up to the freeze cutoff; applied with their real verdicts. */
  revealedRuns: Run[];
  /** Post-freeze runs; applied masked as pending, revealed cell by cell. */
  hiddenRuns: Run[];
  config: AwardConfigInput;
  /** Injected RNG for the gacha "No" probability roll ([0, 1)). */
  rng: Rng;
  computeStandings: ComputeStandings;
}

const CELL_SEP = '\u0000';

function cellKey(teamId: string, problemId: string): string {
  return teamId + CELL_SEP + problemId;
}

export function createAwardMachine(opts: CreateAwardMachineOptions): AwardMachine {
  const { contest, config, rng, computeStandings } = opts;

  // -------------------------------------------------------------------------
  // Reveal-order priority: entries match a problem label OR id; problems not
  // listed follow board order after every listed one. Matching is done with
  // an explicit find (no truthiness on the problem/index), so the problem at
  // board index 0 — or with id "0" — is addressable (original bug not ported).
  // -------------------------------------------------------------------------
  const priority = new Map<string, number>();
  for (const problem of contest.problems) {
    priority.set(problem.id, config.revealOrder.length + problem.order);
  }
  config.revealOrder.forEach((entry, index) => {
    const match = contest.problems.find((p) => p.label === entry || p.id === entry);
    if (match !== undefined && priority.get(match.id)! >= config.revealOrder.length) {
      priority.set(match.id, index);
    }
  });

  // -------------------------------------------------------------------------
  // Frozen projection.
  // -------------------------------------------------------------------------
  const acceptedCells = new Set<string>();
  for (const run of opts.revealedRuns) {
    if (run.verdict === 'accepted') acceptedCells.add(cellKey(run.teamId, run.problemId));
  }

  const visibleRuns: Run[] = opts.revealedRuns.slice();
  /** hidden run id → index of its masked copy inside visibleRuns. */
  const maskedIndexByRunId = new Map<string, number>();
  /** cell key → queued real runs, ascending seq. Deleted when popped. */
  const queues = new Map<string, Run[]>();

  const sortedHidden = [...opts.hiddenRuns].sort((a, b) => a.seq - b.seq);
  for (const run of sortedHidden) {
    const key = cellKey(run.teamId, run.problemId);
    // A cell already accepted before the freeze has nothing to reveal
    // (mirrors the feeder rule "skip runs on an accepted cell").
    if (acceptedCells.has(key)) continue;
    if (!contest.teams.has(run.teamId)) continue; // excluded/unknown team
    maskedIndexByRunId.set(run.id, visibleRuns.length);
    visibleRuns.push({ ...run, verdict: 'pending' });
    const queue = queues.get(key);
    if (queue !== undefined) queue.push(run);
    else queues.set(key, [run]);
  }

  /** remainingReveals = number of CELLS with a queued reveal. */
  let pendingCellCount = queues.size;

  // -------------------------------------------------------------------------
  // Machine state.
  // -------------------------------------------------------------------------
  const teamStage = new Map<string, AwardTeamStage>();
  for (const teamId of contest.teams.keys()) teamStage.set(teamId, 'hidden');

  /** The team currently being processed (null between finalize and next focus). */
  let focusedTeamId: string | null = null;
  /** Team whose award slide is on screen (null when no slide). */
  let slideTeamId: string | null = null;
  /** Cells that already spent their one blink step. */
  const blinkedCells = new Set<string>();

  let cachedSnapshot: Snapshot | null = null;
  function snapshot(): Snapshot {
    if (cachedSnapshot === null) cachedSnapshot = computeStandings(contest, visibleRuns);
    return cachedSnapshot;
  }

  function allFinalized(): boolean {
    for (const stage of teamStage.values()) {
      if (stage !== 'finalized') return false;
    }
    return true;
  }

  /** Index (in current visible standings order) of the bottom-most non-finalized team. */
  function bottomNonFinalizedIndex(): number {
    const standings = snapshot().standings;
    for (let i = standings.length - 1; i >= 0; i--) {
      if (teamStage.get(standings[i].team.id) !== 'finalized') return i;
    }
    return -1;
  }

  /** Team's next pending cell by revealOrder priority; null when none left. */
  function nextPendingProblemId(teamId: string): string | null {
    let bestId: string | null = null;
    let bestPriority = Infinity;
    for (const problem of contest.problems) {
      const queue = queues.get(cellKey(teamId, problem.id));
      if (queue === undefined || queue.length === 0) continue;
      const p = priority.get(problem.id)!;
      if (p < bestPriority) {
        bestPriority = p;
        bestId = problem.id;
      }
    }
    return bestId;
  }

  function advanceInternal(suppressEffects: boolean): AwardStepResult {
    // A visible slide swallows the keypress until dismissed.
    if (slideTeamId !== null) return { type: 'slide-on' };

    const index = bottomNonFinalizedIndex();
    if (index < 0) return { type: 'end' }; // reachable — original bug not ported

    const standing = snapshot().standings[index];
    const teamId = standing.team.id;

    // Re-evaluated every keypress: when a reveal moved the current team up,
    // the (new) bottom-most non-finalized team takes the focus back.
    if (focusedTeamId !== teamId) {
      focusedTeamId = teamId;
      teamStage.set(teamId, 'focused');
      return { type: 'focus', teamId };
    }

    const problemId = nextPendingProblemId(teamId);
    if (problemId === null) {
      teamStage.set(teamId, 'finalized');
      focusedTeamId = null;
      slideTeamId = teamId;
      return { type: 'finalize', teamId, showSlide: true };
    }

    const key = cellKey(teamId, problemId);

    // Dramatic blink: one extra keypress per qualifying cell, judged on the
    // CURRENTLY VISIBLE solved count / icpc rank.
    if (!suppressEffects && config.focusBlinking !== null && !blinkedCells.has(key)) {
      const { minSolved, maxRank } = config.focusBlinking;
      if (standing.solved >= minSolved || standing.icpcRank <= maxRank) {
        blinkedCells.add(key);
        return { type: 'blink', teamId, problemId };
      }
    }

    // Reveal: pop EVERY queued run of the cell in one transition.
    const queued = queues.get(key)!;
    queues.delete(key);
    const remainingBefore = pendingCellCount;
    pendingCellCount -= 1;

    for (const real of queued) {
      const maskedIndex = maskedIndexByRunId.get(real.id);
      if (maskedIndex !== undefined) visibleRuns[maskedIndex] = real;
    }
    cachedSnapshot = null;

    // Animation list = net runs (truncate after the first accepted).
    const runs: Run[] = [];
    for (const real of queued) {
      runs.push(real);
      if (real.verdict === 'accepted') break;
    }
    const finalVerdict = runs[runs.length - 1].verdict;

    const isFinale = remainingBefore === 1;
    let gacha = false;
    if (!suppressEffects && (runs.length >= config.gachaEffectRequirement || isFinale)) {
      // Yes → always; No → probability roll (fake-out), deterministic via injected rng.
      gacha = finalVerdict === 'accepted' ? true : rng() < config.gachaEffectForNoRatio / 100;
    }

    return {
      type: 'reveal',
      teamId,
      problemId,
      runs,
      effect: { gacha, finale: suppressEffects ? false : isFinale },
    };
  }

  /**
   * Pure fast-forward (no DOM replay/setTimeout as in the original): loop
   * advance() with effects suppressed — auto-dismissing slides — until the
   * next team's visible index drops below rankBegin, i.e. the ceremony
   * resumes at the team currently in 1-based position rankBegin.
   */
  function fastForwardToRank(rankBegin: number): void {
    const maxSteps = contest.teams.size * 4 + opts.hiddenRuns.length * 4 + 16;
    for (let step = 0; step <= maxSteps; step++) {
      if (slideTeamId !== null) {
        slideTeamId = null;
        continue;
      }
      const index = bottomNonFinalizedIndex();
      if (index < 0 || index < rankBegin) return;
      advanceInternal(true);
    }
    /* c8 ignore next */
    throw new Error('fastForwardToRank did not terminate');
  }

  const machine: AwardMachine = {
    advance: () => advanceInternal(false),
    dismissSlide: () => {
      slideTeamId = null;
    },
    get remainingReveals() {
      return pendingCellCount;
    },
    get teamStage(): ReadonlyMap<string, AwardTeamStage> {
      return teamStage;
    },
    get currentSlideTeamId() {
      return slideTeamId;
    },
    get snapshot() {
      return snapshot();
    },
    get finished() {
      return allFinalized();
    },
  };

  if (config.rankBegin !== null) fastForwardToRank(config.rankBegin);

  return machine;
}
