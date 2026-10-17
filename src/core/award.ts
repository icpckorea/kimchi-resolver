/**
 * Award ceremony state machine (spec §6). Pure, DOM-free, framework-free.
 *
 * Frozen projection (full-cell masking): a cell with ANY post-freeze
 * ("hidden") run is masked ENTIRELY — its pre-freeze net runs are masked as
 * 'pending' too, so the visible board shows the cell as pending with the
 * FULL net attempt count. The cell's whole net history (pre-freeze runs
 * first, then the hidden ones, truncated after the first accepted) sits in a
 * per-(team, problem) reveal queue; one advance() swaps every real verdict
 * back into the visible set and hands the caller the complete run list to
 * replay from zero (e.g. 5 pre-freeze fails + 3 hidden = 8 flips). Cells
 * without hidden runs stay revealed as-is. "Two projections of the same run
 * list", replacing the original's strategy monkey-patch.
 *
 * Static last-solve (spec §4): isLastSolve / isContestLastSolve /
 * isContestFirstSolve — and the auto labels derived from them — are computed
 * ONCE at construction from the FINAL full run set (revealed + hidden real
 * verdicts). The visible snapshot is post-processed against that truth:
 * a cell shows a flag only when it is revealed AND accepted, and the flags
 * never migrate between cells while the ceremony progresses. The finale
 * purple cell therefore appears exactly on the true contest-last-yes cell
 * the moment it flips.
 *
 * One advance() call = one user keypress = one state transition:
 *   slide-on → (focus | blink | reveal | finalize | end)
 *
 * Slides are raised ONLY for teams in `awardedTeamIds` (spec §6: "awards.json
 * 항목이 없는 팀은 슬라이드를 아예 띄우지 않는다"). Everyone else finalizes with
 * showSlide: false and costs exactly one keypress. The machine — not the view —
 * owns this, because the alternative (raise a slide, let an effect close it)
 * leaves an invisible slide latched for one render: any keypress arriving in
 * that window is consumed as a dismissal and nothing visible happens. With 84
 * teams and 3 award entries that race sits at 81 of 84 finalize boundaries,
 * exactly where a held or double-tapped presenter remote fires.
 *
 * Slide dismissal (spec §6): a visible slide CONSUMES the next advance() —
 * the machine closes the slide and returns { type: 'slide-on' } without
 * touching the ceremony, so a projector remote with no Escape key drives the
 * whole thing with PageDown alone. The press after that advances normally,
 * keeping the two-step "close, then advance" guard against stray presses.
 * dismissSlide() (Escape) remains the explicit, idempotent close.
 *
 * Deliberately NOT ported from the original (docs/spotboard-analysis.md §2):
 *   - revealOrder falsy-zero bug (problem at index 0 / id "0" works here),
 *   - unreachable 'end' (TypeError on the last keypress in the original),
 *   - foreign teams last (re-planned: unified bottom-up over the ICPC rank).
 */
import type {
  AutoLabel,
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
  /** Runs up to the freeze cutoff; visible unless their cell is masked. */
  revealedRuns: Run[];
  /** Post-freeze runs; they mask their whole cell as pending until revealed. */
  hiddenRuns: Run[];
  config: AwardConfigInput;
  /**
   * Team ids that have an awards.json entry (spec §6). ONLY these teams raise
   * a slide on finalize; every other team finalizes with `showSlide: false`
   * and consumes exactly one keypress.
   *
   * Ordering contract: the ids must be known BEFORE the first advance(), so
   * the loader (store.boot) awaits awards.json and passes them here. Omitting
   * the option means "no team has an entry" — a machine built without it runs
   * a slide-less ceremony rather than one with invisible slides.
   */
  awardedTeamIds?: ReadonlySet<string>;
  /** Injected RNG for the gacha "No" probability roll ([0, 1)). */
  rng: Rng;
  computeStandings: ComputeStandings;
}

const CELL_SEP = '\u0000';

function cellKey(teamId: string, problemId: string): string {
  return teamId + CELL_SEP + problemId;
}

interface FinalCellRef {
  teamId: string;
  problemId: string;
}

export function createAwardMachine(opts: CreateAwardMachineOptions): AwardMachine {
  const { contest, config, rng, computeStandings } = opts;
  const awardedTeamIds: ReadonlySet<string> = opts.awardedTeamIds ?? new Set<string>();

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
  // Frozen projection — pass 1: pre-freeze net runs per cell.
  // Net = seq order, truncated after the first accepted run. A cell accepted
  // pre-freeze is never masked (mirrors the feeder rule "skip runs on an
  // accepted cell"); a masked cell therefore has ONLY net pre-freeze runs.
  // -------------------------------------------------------------------------
  const acceptedCells = new Set<string>();
  const preFreezeNetRuns = new Map<string, Run[]>();
  for (const run of [...opts.revealedRuns].sort((a, b) => a.seq - b.seq)) {
    const key = cellKey(run.teamId, run.problemId);
    if (acceptedCells.has(key)) continue; // past the first accepted → not a net run
    let list = preFreezeNetRuns.get(key);
    if (list === undefined) {
      list = [];
      preFreezeNetRuns.set(key, list);
    }
    list.push(run);
    if (run.verdict === 'accepted') acceptedCells.add(key);
  }

  // -------------------------------------------------------------------------
  // Pass 2: hidden runs per cell (skipping cells accepted pre-freeze and
  // excluded/unknown teams). Every cell present here is a MASKED cell.
  // -------------------------------------------------------------------------
  const hiddenByCell = new Map<string, Run[]>();
  for (const run of [...opts.hiddenRuns].sort((a, b) => a.seq - b.seq)) {
    const key = cellKey(run.teamId, run.problemId);
    if (acceptedCells.has(key)) continue;
    if (!contest.teams.has(run.teamId)) continue; // excluded/unknown team
    const list = hiddenByCell.get(key);
    if (list !== undefined) list.push(run);
    else hiddenByCell.set(key, [run]);
  }

  // -------------------------------------------------------------------------
  // Pass 3: reveal queues = each masked cell's FULL net history — pre-freeze
  // net runs followed by the hidden runs, truncated after the first accepted
  // (only the hidden part can contain one). Hidden runs past that truncation
  // are dropped entirely: they are not net, not displayed, not replayed.
  // The queue is also the reveal's animation list, so the gacha requirement
  // "full net attempts" is simply queue.length.
  // -------------------------------------------------------------------------
  const queues = new Map<string, Run[]>();
  for (const [key, hidden] of hiddenByCell) {
    const history: Run[] = [];
    for (const run of [...(preFreezeNetRuns.get(key) ?? []), ...hidden]) {
      history.push(run);
      if (run.verdict === 'accepted') break;
    }
    queues.set(key, history);
  }

  // -------------------------------------------------------------------------
  // Pass 4: visible projection. Revealed runs keep their real verdicts unless
  // their cell is masked; every queued run (pre-freeze AND hidden) gets a
  // masked 'pending' copy so the board shows the cell as pending with the
  // full net attempt count. Reveal swaps the real runs back in by index.
  // -------------------------------------------------------------------------
  const maskedRunIds = new Set<string>();
  const queuedHiddenRuns: Run[] = [];
  for (const queue of queues.values()) {
    for (const run of queue) maskedRunIds.add(run.id);
  }
  const hiddenIds = new Set(opts.hiddenRuns.map((run) => run.id));
  for (const queue of queues.values()) {
    for (const run of queue) {
      if (hiddenIds.has(run.id)) queuedHiddenRuns.push(run);
    }
  }

  const visibleRuns: Run[] = [];
  /** masked run id → index of its 'pending' copy inside visibleRuns. */
  const maskedIndexByRunId = new Map<string, number>();
  for (const run of opts.revealedRuns) {
    if (maskedRunIds.has(run.id)) {
      maskedIndexByRunId.set(run.id, visibleRuns.length);
      visibleRuns.push({ ...run, verdict: 'pending' });
    } else {
      visibleRuns.push(run);
    }
  }
  for (const run of queuedHiddenRuns) {
    maskedIndexByRunId.set(run.id, visibleRuns.length);
    visibleRuns.push({ ...run, verdict: 'pending' });
  }

  /** remainingReveals = number of CELLS with a queued reveal. */
  let pendingCellCount = queues.size;

  // -------------------------------------------------------------------------
  // Final-truth flags (spec §4, award mode): last solve per problem, contest
  // first/last yes — computed ONCE from the full real run set (revealed +
  // hidden), independent of the injected computeStandings. Per cell the
  // accepting run is the first accepted in seq order (net truncation); per
  // problem the last solve is the max (minute, then seq) accepting run;
  // contest first/last are the global min/max.
  // -------------------------------------------------------------------------
  const finalLastSolveCells = new Set<string>();
  let finalContestFirst: FinalCellRef | null = null;
  let finalContestLast: FinalCellRef | null = null;
  {
    const allRunsByCell = new Map<string, Run[]>();
    for (const run of [...opts.revealedRuns, ...opts.hiddenRuns]) {
      if (!contest.teams.has(run.teamId)) continue;
      if (!priority.has(run.problemId)) continue; // unknown problem
      const key = cellKey(run.teamId, run.problemId);
      const list = allRunsByCell.get(key);
      if (list !== undefined) list.push(run);
      else allRunsByCell.set(key, [run]);
    }
    interface Accepting extends FinalCellRef {
      minute: number;
      seq: number;
    }
    const lastPerProblem = new Map<string, Accepting>();
    const firstMinutePerProblem = new Map<string, number>();
    let first: Accepting | null = null;
    let last: Accepting | null = null;
    for (const [, runs] of allRunsByCell) {
      runs.sort((a, b) => a.seq - b.seq);
      const acc = runs.find((r) => r.verdict === 'accepted');
      if (acc === undefined) continue;
      const cur: Accepting = {
        teamId: acc.teamId,
        problemId: acc.problemId,
        minute: acc.minute,
        seq: acc.seq,
      };
      const firstMinute = firstMinutePerProblem.get(cur.problemId);
      if (firstMinute === undefined || cur.minute < firstMinute) {
        firstMinutePerProblem.set(cur.problemId, cur.minute);
      }
      const problemLast = lastPerProblem.get(cur.problemId);
      if (
        problemLast === undefined ||
        cur.minute > problemLast.minute ||
        (cur.minute === problemLast.minute && cur.seq > problemLast.seq)
      ) {
        lastPerProblem.set(cur.problemId, cur);
      }
      if (first === null || cur.minute < first.minute || (cur.minute === first.minute && cur.seq < first.seq)) {
        first = cur;
      }
      if (last === null || cur.minute > last.minute || (cur.minute === last.minute && cur.seq > last.seq)) {
        last = cur;
      }
    }
    for (const acc of lastPerProblem.values()) {
      // A last solve that is also a first solve (sole solver, or all tied at
      // the first minute) is not marked: first to solve wins.
      if (acc.minute === firstMinutePerProblem.get(acc.problemId)) continue;
      finalLastSolveCells.add(cellKey(acc.teamId, acc.problemId));
    }
    if (first !== null) finalContestFirst = { teamId: first.teamId, problemId: first.problemId };
    if (last !== null) finalContestLast = { teamId: last.teamId, problemId: last.problemId };
  }
  const finalContestFirstKey =
    finalContestFirst !== null ? cellKey(finalContestFirst.teamId, finalContestFirst.problemId) : null;
  const finalContestLastKey =
    finalContestLast !== null ? cellKey(finalContestLast.teamId, finalContestLast.problemId) : null;

  /**
   * Overwrite the visible snapshot's last-solve family of flags (and the
   * labels derived from them) with the construction-time final truth, gated
   * per cell on "revealed AND accepted". The projection-derived values would
   * migrate between cells as reveals land; the fixed ones never move.
   */
  function applyFinalTruth(snap: Snapshot): Snapshot {
    for (const standing of snap.standings) {
      const teamId = standing.team.id;
      let hasContestFirst = false;
      let hasContestLast = false;
      const lastSolveLabels: string[] = [];
      for (const problem of contest.problems) {
        const cell = standing.cells.get(problem.id);
        if (cell === undefined) continue;
        const key = cellKey(teamId, problem.id);
        const accepted = cell.verdict === 'accepted';
        cell.isLastSolve = accepted && finalLastSolveCells.has(key);
        cell.isContestFirstSolve = accepted && key === finalContestFirstKey;
        cell.isContestLastSolve = accepted && key === finalContestLastKey;
        if (cell.isLastSolve) lastSolveLabels.push(problem.label);
        if (cell.isContestFirstSolve) hasContestFirst = true;
        if (cell.isContestLastSolve) hasContestLast = true;
      }
      // Rebuild the affected auto labels, preserving the spec §4 table order:
      // triedNTimes, contestFirstYes, firstToSolve, lastToSolve, contestLastYes.
      const rebuilt: AutoLabel[] = [];
      const tried = standing.autoLabels.find((l) => l.kind === 'triedNTimes');
      if (tried !== undefined) rebuilt.push(tried);
      if (hasContestFirst) rebuilt.push({ kind: 'contestFirstYes' });
      const firstToSolve = standing.autoLabels.find((l) => l.kind === 'firstToSolve');
      if (firstToSolve !== undefined) rebuilt.push(firstToSolve);
      if (lastSolveLabels.length > 0) {
        rebuilt.push({ kind: 'lastToSolve', problemLabels: lastSolveLabels });
      }
      if (hasContestLast) rebuilt.push({ kind: 'contestLastYes' });
      standing.autoLabels = rebuilt;
    }
    const firstStanding =
      finalContestFirst !== null ? snap.byTeam.get(finalContestFirst.teamId) : undefined;
    snap.contestFirstYes =
      finalContestFirst !== null &&
      firstStanding?.cells.get(finalContestFirst.problemId)?.verdict === 'accepted'
        ? { ...finalContestFirst }
        : null;
    const lastStanding =
      finalContestLast !== null ? snap.byTeam.get(finalContestLast.teamId) : undefined;
    snap.contestLastYes =
      finalContestLast !== null &&
      lastStanding?.cells.get(finalContestLast.problemId)?.verdict === 'accepted'
        ? { ...finalContestLast }
        : null;
    return snap;
  }

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
    if (cachedSnapshot === null) {
      cachedSnapshot = applyFinalTruth(computeStandings(contest, visibleRuns));
    }
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
    // A visible slide CONSUMES the keypress as its dismissal (spec §6: a
    // presenter remote has no Escape, so the advance key must close the
    // slide; the NEXT press advances — the two-step structure stays).
    if (slideTeamId !== null) {
      slideTeamId = null;
      return { type: 'slide-on' };
    }

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
      // Only an awards.json entry earns a slide (spec §6). Without an entry
      // there is nothing to show, so no slide is raised and the next keypress
      // moves the ceremony on — no invisible latch to swallow it.
      const showSlide = awardedTeamIds.has(teamId);
      if (showSlide) slideTeamId = teamId;
      return { type: 'finalize', teamId, showSlide };
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

    // Reveal: swap the cell's ENTIRE net history back to real verdicts in one
    // transition. The queue already IS the net-truncated full history —
    // pre-freeze fails first, then the hidden runs — so the caller replays
    // the whole cell from zero attempts.
    const queued = queues.get(key)!;
    queues.delete(key);
    const remainingBefore = pendingCellCount;
    pendingCellCount -= 1;

    for (const real of queued) {
      const maskedIndex = maskedIndexByRunId.get(real.id);
      if (maskedIndex !== undefined) visibleRuns[maskedIndex] = real;
    }
    cachedSnapshot = null;

    const runs = queued;
    const finalVerdict = runs[runs.length - 1].verdict;

    const isFinale = remainingBefore === 1;
    let gacha = false;
    if (suppressEffects) {
      gacha = false; // rankBegin fast-forward plays nothing
    } else if (isFinale) {
      // Spec §6/§7: the ceremony's final reveal ALWAYS runs the gacha effect
      // (it is step 2 of the fixed finale sequence) — regardless of the
      // verdict, regardless of the attempt count, and without an rng roll.
      gacha = true;
    } else if (runs.length >= config.gachaEffectRequirement) {
      // The gacha requirement counts the cell's FULL net attempts (spec §6),
      // which with full-cell masking is simply the replay length. Yes →
      // always; No → probability roll (fake-out), deterministic via the
      // injected rng (never called when the outcome is already certain).
      gacha = finalVerdict === 'accepted' || rng() < config.gachaEffectForNoRatio / 100;
    }

    return {
      type: 'reveal',
      teamId,
      problemId,
      runs,
      // Frozen contract field: the replay now always starts from zero — the
      // full history is inside `runs`, so there is no display offset left.
      preFreeze: { attempts: 0, failedAttempts: 0 },
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
    get currentFocusedTeamId() {
      return focusedTeamId;
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
