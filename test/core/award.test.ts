import { describe, expect, it, vi } from 'vitest';
import { createAwardMachine } from '@core/award';
import type {
  AwardConfigInput,
  AwardMachine,
  AwardStepResult,
  CellState,
  ComputeStandings,
  Contest,
  Run,
  Snapshot,
  Team,
  TeamStanding,
  Verdict,
} from '@core/types';

// ---------------------------------------------------------------------------
// Self-contained computeStandings (frozen ComputeStandings contract).
// The award machine takes it as an injected dependency, so the tests supply
// their own implementation instead of depending on another agent's module.
// ---------------------------------------------------------------------------

const computeStandingsForTest: ComputeStandings = (contest, appliedRuns): Snapshot => {
  const runsByCell = new Map<string, Run[]>();
  for (const run of appliedRuns) {
    const key = `${run.teamId}|${run.problemId}`;
    const list = runsByCell.get(key);
    if (list !== undefined) list.push(run);
    else runsByCell.set(key, [run]);
  }

  const standings: TeamStanding[] = [];
  for (const team of contest.teams.values()) {
    let solved = 0;
    let penalty = 0;
    let lastSolvedMinute = 0;
    const cells = new Map<string, CellState>();
    for (const problem of contest.problems) {
      const all = (runsByCell.get(`${team.id}|${problem.id}`) ?? [])
        .slice()
        .sort((a, b) => a.seq - b.seq);
      const net: Run[] = [];
      for (const run of all) {
        net.push(run);
        if (run.verdict === 'accepted') break;
      }
      const last = net.length > 0 ? net[net.length - 1] : null;
      const failedAttempts = net.filter((r) => r.verdict === 'failed' && r.penaltyCounts).length;
      const solvedMinute = last !== null && last.verdict === 'accepted' ? last.minute : null;
      cells.set(problem.id, {
        teamId: team.id,
        problemId: problem.id,
        verdict: last === null ? null : last.verdict,
        attempts: net.length,
        failedAttempts,
        solvedMinute,
        isFirstSolve: false,
        isLastSolve: false,
        isContestFirstSolve: false,
        isContestLastSolve: false,
      });
      if (solvedMinute !== null) {
        solved += 1;
        penalty += 20 * failedAttempts + solvedMinute;
        lastSolvedMinute = Math.max(lastSolvedMinute, solvedMinute);
      }
    }
    standings.push({
      team,
      solved,
      penalty,
      lastSolvedMinute,
      icpcRank: 0,
      domesticRank: null,
      schoolRank: 0,
      cells,
      autoLabels: [],
    });
  }

  standings.sort(
    (a, b) =>
      b.solved - a.solved ||
      a.penalty - b.penalty ||
      a.lastSolvedMinute - b.lastSolvedMinute ||
      a.team.id.localeCompare(b.team.id, undefined, { numeric: true }),
  );

  const tied = (a: TeamStanding, b: TeamStanding): boolean =>
    a.solved === b.solved && a.penalty === b.penalty && a.lastSolvedMinute === b.lastSolvedMinute;
  standings.forEach((s, i) => {
    s.icpcRank = i > 0 && tied(s, standings[i - 1]) ? standings[i - 1].icpcRank : i + 1;
  });
  let domesticIndex = 0;
  let prevDomestic: TeamStanding | null = null;
  const schoolCounters = new Map<string, number>();
  for (const s of standings) {
    if (!s.team.foreign) {
      domesticIndex += 1;
      s.domesticRank =
        prevDomestic !== null && tied(s, prevDomestic) ? prevDomestic.domesticRank : domesticIndex;
      prevDomestic = s;
    }
    const n = (schoolCounters.get(s.team.group) ?? 0) + 1;
    schoolCounters.set(s.team.group, n);
    s.schoolRank = n;
  }

  return {
    standings,
    byTeam: new Map(standings.map((s) => [s.team.id, s])),
    firstSolvers: new Map(),
    contestFirstYes: null,
    contestLastYes: null,
  };
};

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

/** Problem ids are '0','1','2' on purpose: the original had a falsy-zero bug. */
function makeContest(teamIds: string[]): Contest {
  const problems = [
    { id: '0', label: 'A', title: 'Alpha', color: 'red', order: 0 },
    { id: '1', label: 'B', title: 'Beta', color: 'blue', order: 1 },
    { id: '2', label: 'C', title: 'Gamma', color: 'green', order: 2 },
  ];
  const teams = new Map<string, Team>();
  for (const id of teamIds) {
    teams.set(id, { id, name: `Team ${id}`, group: `G-${id}`, foreign: false });
  }
  return { title: 'Test Contest', systemName: 'test', systemVersion: '1', problems, teams };
}

function run(id: number, teamId: string, problemId: string, minute: number, verdict: Verdict): Run {
  return {
    id: String(id),
    teamId,
    problemId,
    minute,
    verdict,
    penaltyCounts: verdict === 'failed',
    seq: id,
  };
}

function cfg(overrides: Partial<AwardConfigInput> = {}): AwardConfigInput {
  return {
    hideName: true,
    rankBegin: null,
    revealOrder: [],
    focusBlinking: null,
    gachaEffectRequirement: 8,
    gachaEffectForNoRatio: 30,
    ...overrides,
  };
}

interface MachineOptions {
  contest: Contest;
  revealed?: Run[];
  hidden?: Run[];
  config?: Partial<AwardConfigInput>;
  rng?: () => number;
}

function makeMachine(options: MachineOptions): AwardMachine {
  return createAwardMachine({
    contest: options.contest,
    revealedRuns: options.revealed ?? [],
    hiddenRuns: options.hidden ?? [],
    config: cfg(options.config),
    rng: options.rng ?? (() => 0.99),
    computeStandings: computeStandingsForTest,
  });
}

/** Drive to the end, auto-dismissing slides. Returns every step result. */
function collectToEnd(machine: AwardMachine, max = 300): AwardStepResult[] {
  const results: AwardStepResult[] = [];
  while (results.length < max) {
    const result = machine.advance();
    results.push(result);
    if (result.type === 'finalize') machine.dismissSlide();
    if (result.type === 'end') return results;
  }
  throw new Error('ceremony did not end');
}

function revealsOf(results: AwardStepResult[]): Extract<AwardStepResult, { type: 'reveal' }>[] {
  return results.filter((r) => r.type === 'reveal');
}

/**
 * Shared 4-team fixture:
 *   revealed → t1: A@10 Y, B@20 Y (2 solved, 30)
 *              t2: A@30 Y        (1 solved, 30)
 *              t4: A@40 Y        (1 solved, 40)
 *              t3: —             (0 solved)
 *   hidden   → t3: B@35 Y  (reveal moves t3 above the not-yet-final t4)
 *              t1: C@50 Y  (the contest's very last reveal → finale)
 * Initial visible order: t1, t2, t4, t3.
 */
function rankShiftFixture(config: Partial<AwardConfigInput> = {}, rng?: () => number) {
  const contest = makeContest(['t1', 't2', 't3', 't4']);
  return makeMachine({
    contest,
    revealed: [
      run(1, 't1', '0', 10, 'accepted'),
      run(2, 't1', '1', 20, 'accepted'),
      run(3, 't2', '0', 30, 'accepted'),
      run(4, 't4', '0', 40, 'accepted'),
    ],
    hidden: [run(10, 't3', '1', 35, 'accepted'), run(11, 't1', '2', 50, 'accepted')],
    config,
    rng,
  });
}

// ---------------------------------------------------------------------------
// Construction: frozen projection.
// ---------------------------------------------------------------------------

describe('construction (frozen projection)', () => {
  it('masks hidden runs as pending and counts remainingReveals per cell', () => {
    const contest = makeContest(['t1', 't2']);
    const machine = makeMachine({
      contest,
      revealed: [run(1, 't1', '0', 10, 'accepted')],
      hidden: [
        run(10, 't2', '0', 120, 'accepted'),
        run(11, 't2', '1', 130, 'failed'),
        run(12, 't2', '1', 140, 'accepted'),
      ],
    });

    // 3 hidden runs but only 2 distinct cells.
    expect(machine.remainingReveals).toBe(2);

    const t2 = machine.snapshot.byTeam.get('t2')!;
    expect(t2.solved).toBe(0);
    expect(t2.penalty).toBe(0);
    expect(t2.cells.get('0')!.verdict).toBe('pending');
    expect(t2.cells.get('1')!.verdict).toBe('pending');

    // Pre-freeze results stay fully visible.
    const t1 = machine.snapshot.byTeam.get('t1')!;
    expect(t1.solved).toBe(1);
    expect(machine.snapshot.standings[0].team.id).toBe('t1');
  });

  it('does not queue hidden runs for a cell already accepted pre-freeze', () => {
    const contest = makeContest(['t1', 't2']);
    const machine = makeMachine({
      contest,
      revealed: [run(1, 't1', '0', 10, 'accepted')],
      hidden: [run(10, 't1', '0', 200, 'failed')],
    });
    expect(machine.remainingReveals).toBe(0);
    expect(machine.snapshot.byTeam.get('t1')!.cells.get('0')!.verdict).toBe('accepted');
  });

  it('memoizes the snapshot until a reveal changes the visible runs', () => {
    const machine = rankShiftFixture();
    const before = machine.snapshot;
    expect(machine.snapshot).toBe(before); // same reference, no recompute

    machine.advance(); // focus t3 — no run change
    expect(machine.snapshot).toBe(before);

    machine.advance(); // reveal t3 B
    expect(machine.snapshot).not.toBe(before);
  });

  it('starts every team at stage "hidden" with no slide', () => {
    const machine = rankShiftFixture();
    expect([...machine.teamStage.values()]).toEqual(['hidden', 'hidden', 'hidden', 'hidden']);
    expect(machine.currentSlideTeamId).toBeNull();
    expect(machine.finished).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bottom-up progression, rank shifts, slides, end.
// ---------------------------------------------------------------------------

describe('advance(): bottom-up order with rank shifts', () => {
  it('walks the full ceremony, refocusing the new bottom team after a rank shift', () => {
    const machine = rankShiftFixture();

    // 1. bottom-most team in the visible order is t3 (0 solved).
    expect(machine.currentFocusedTeamId).toBeNull();
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't3' });
    expect(machine.teamStage.get('t3')).toBe('focused');
    expect(machine.currentFocusedTeamId).toBe('t3');

    // 2. reveal t3's only pending cell (B). t3 moves above the unfinalized t4.
    const reveal = machine.advance();
    expect(reveal).toMatchObject({ type: 'reveal', teamId: 't3', problemId: '1' });
    if (reveal.type !== 'reveal') throw new Error('expected reveal');
    expect(reveal.runs.map((r) => r.id)).toEqual(['10']);
    expect(reveal.effect).toEqual({ gacha: false, finale: false });
    expect(machine.remainingReveals).toBe(1);
    expect(machine.snapshot.standings.map((s) => s.team.id)).toEqual(['t1', 't2', 't3', 't4']);

    // 3. focus jumps BACK down to t4, now the bottom-most non-finalized team.
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't4' });
    // t3 keeps stage 'focused' (identity stays revealed), but the machine's
    // single focus getter points at t4 only — the UI highlight/scroll source.
    expect(machine.teamStage.get('t3')).toBe('focused');
    expect(machine.teamStage.get('t4')).toBe('focused');
    expect(machine.currentFocusedTeamId).toBe('t4');

    // 4. t4 has no pending cells → finalize with slide.
    expect(machine.advance()).toEqual({ type: 'finalize', teamId: 't4', showSlide: true });
    expect(machine.teamStage.get('t4')).toBe('finalized');
    expect(machine.currentFocusedTeamId).toBeNull(); // focus released on finalize
    expect(machine.currentSlideTeamId).toBe('t4');

    // 5. while the slide is showing, the advance key is CONSUMED as its
    //    dismissal (spec §6: presenter remotes have no Escape) — one press
    //    closes the slide, the next one advances.
    expect(machine.advance()).toEqual({ type: 'slide-on' });
    expect(machine.currentSlideTeamId).toBeNull();
    machine.dismissSlide(); // idempotent no-op after the consumed advance
    expect(machine.currentSlideTeamId).toBeNull();

    // 6. back to t3 (focus is re-announced after the detour).
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't3' });
    expect(machine.advance()).toEqual({ type: 'finalize', teamId: 't3', showSlide: true });
    machine.dismissSlide();

    // 7. t2 next.
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't2' });
    expect(machine.advance()).toEqual({ type: 'finalize', teamId: 't2', showSlide: true });
    machine.dismissSlide();

    // 8. t1 last: its C cell is the contest's final reveal → finale (+ gacha for Yes).
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't1' });
    const finale = machine.advance();
    expect(finale).toMatchObject({
      type: 'reveal',
      teamId: 't1',
      problemId: '2',
      effect: { gacha: true, finale: true },
    });
    expect(machine.remainingReveals).toBe(0);

    expect(machine.finished).toBe(false);
    expect(machine.advance()).toEqual({ type: 'finalize', teamId: 't1', showSlide: true });
    expect(machine.finished).toBe(true);
    machine.dismissSlide();

    // 9. 'end' is reachable (original bug not ported) and stable.
    expect(machine.advance()).toEqual({ type: 'end' });
    expect(machine.advance()).toEqual({ type: 'end' });
    expect([...machine.teamStage.values()].every((s) => s === 'finalized')).toBe(true);
  });

  it('finalizes teams strictly bottom-up when nothing shifts', () => {
    const contest = makeContest(['t1', 't2', 't3']);
    const machine = makeMachine({
      contest,
      revealed: [
        run(1, 't1', '0', 10, 'accepted'),
        run(2, 't2', '0', 20, 'accepted'),
      ],
    });
    const finalizeOrder = collectToEnd(machine)
      .filter((r) => r.type === 'finalize')
      .map((r) => (r.type === 'finalize' ? r.teamId : ''));
    expect(finalizeOrder).toEqual(['t3', 't2', 't1']);
  });
});

// ---------------------------------------------------------------------------
// revealOrder.
// ---------------------------------------------------------------------------

describe('revealOrder', () => {
  const hiddenAllThree = [
    run(10, 't1', '0', 100, 'accepted'),
    run(11, 't1', '1', 101, 'accepted'),
    run(12, 't1', '2', 102, 'accepted'),
  ];

  function revealOrderOf(revealOrder: string[]): string[] {
    const machine = makeMachine({
      contest: makeContest(['t1', 't2']),
      hidden: hiddenAllThree,
      config: { revealOrder },
    });
    return revealsOf(collectToEnd(machine)).map((r) => r.problemId);
  }

  it('follows board order when revealOrder is empty', () => {
    expect(revealOrderOf([])).toEqual(['0', '1', '2']);
  });

  it('honors labels, including the problem at board index 0 (falsy-zero bug not ported)', () => {
    // If matching problem A (index 0, id '0') failed, A would fall back to the
    // unlisted bucket and the order would degrade to C, B, A.
    expect(revealOrderOf(['C', 'A', 'B'])).toEqual(['2', '0', '1']);
  });

  it('honors problem ids, including id "0"', () => {
    expect(revealOrderOf(['2', '0', '1'])).toEqual(['2', '0', '1']);
  });

  it('mixes labels and ids', () => {
    expect(revealOrderOf(['C', '0'])).toEqual(['2', '0', '1']);
  });

  it('puts unlisted problems after listed ones, in board order', () => {
    expect(revealOrderOf(['B'])).toEqual(['1', '0', '2']);
  });

  it('ignores entries that match no problem', () => {
    expect(revealOrderOf(['ZZZ', 'C'])).toEqual(['2', '0', '1']);
  });
});

// ---------------------------------------------------------------------------
// focusBlinking.
// ---------------------------------------------------------------------------

describe('focusBlinking', () => {
  it('inserts exactly one blink step per qualifying cell (minSolved branch)', () => {
    const contest = makeContest(['t1', 't2']);
    const machine = makeMachine({
      contest,
      revealed: [run(1, 't1', '0', 10, 'accepted')], // t1 visible solved = 1
      hidden: [run(10, 't1', '1', 100, 'accepted'), run(11, 't1', '2', 110, 'accepted')],
      config: { focusBlinking: { minSolved: 1, maxRank: 0 } },
    });

    // t2 first (0 solved, does not qualify, nothing pending anyway).
    expect(machine.advance().type).toBe('focus'); // t2
    expect(machine.advance().type).toBe('finalize'); // t2
    machine.dismissSlide();

    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't1' });
    // Cell B: blink consumes one advance, then the reveal comes.
    expect(machine.advance()).toEqual({ type: 'blink', teamId: 't1', problemId: '1' });
    expect(machine.advance()).toMatchObject({ type: 'reveal', teamId: 't1', problemId: '1' });
    // Cell C blinks again — once per cell.
    expect(machine.advance()).toEqual({ type: 'blink', teamId: 't1', problemId: '2' });
    expect(machine.advance()).toMatchObject({ type: 'reveal', teamId: 't1', problemId: '2' });
    expect(machine.advance().type).toBe('finalize');
  });

  it('qualifies via visible icpcRank (maxRank branch)', () => {
    const contest = makeContest(['t1', 't2']);
    const machine = makeMachine({
      contest,
      revealed: [run(1, 't1', '0', 10, 'accepted')], // t1 rank 1
      hidden: [run(10, 't1', '1', 100, 'accepted'), run(11, 't2', '0', 120, 'accepted')],
      config: { focusBlinking: { minSolved: 99, maxRank: 1 } },
    });

    // t2: rank 2 > maxRank, solved 0 < 99 → reveal without blink.
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't2' });
    expect(machine.advance().type).toBe('reveal');
    // t2 now above... no: t2 solved 1 pen 120 vs t1 solved 1 pen 10 → t2 still bottom.
    expect(machine.advance().type).toBe('finalize');
    machine.dismissSlide();

    // t1: rank 1 ≤ maxRank → blink before its reveal.
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't1' });
    expect(machine.advance()).toEqual({ type: 'blink', teamId: 't1', problemId: '1' });
    expect(machine.advance().type).toBe('reveal');
  });

  it('never blinks when focusBlinking is null', () => {
    const machine = rankShiftFixture();
    expect(collectToEnd(machine).some((r) => r.type === 'blink')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multi-run cells.
// ---------------------------------------------------------------------------

describe('multi-fail cell', () => {
  it('reveals every queued run of the cell in one advance, fails then final', () => {
    const contest = makeContest(['t1', 't2']);
    const machine = makeMachine({
      contest,
      hidden: [
        run(12, 't1', '1', 110, 'accepted'), // out of seq order on purpose
        run(10, 't1', '1', 100, 'failed'),
        run(11, 't1', '1', 105, 'failed'),
        run(13, 't2', '0', 90, 'accepted'), // second cell so the reveal is not the finale
      ],
    });
    expect(machine.remainingReveals).toBe(2);

    // Bottom team is t2 first.
    expect(machine.advance().type).toBe('focus'); // t2
    expect(machine.advance().type).toBe('reveal'); // t2 A
    expect(machine.advance().type).toBe('focus'); // t1 (t2 moved above)

    const reveal = machine.advance();
    if (reveal.type !== 'reveal') throw new Error('expected reveal');
    expect(reveal.teamId).toBe('t1');
    expect(reveal.problemId).toBe('1');
    expect(reveal.runs.map((r) => r.verdict)).toEqual(['failed', 'failed', 'accepted']);
    expect(reveal.runs.map((r) => r.id)).toEqual(['10', '11', '12']); // seq order

    const t1 = machine.snapshot.byTeam.get('t1')!;
    expect(t1.solved).toBe(1);
    expect(t1.penalty).toBe(20 * 2 + 110);
    expect(machine.remainingReveals).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full-cell reveal replay (spec §6): a cell with ANY hidden run is masked
// entirely — pre-freeze net runs included — and one advance replays the whole
// net history from zero.
// ---------------------------------------------------------------------------

describe('full-cell reveal replay', () => {
  /** t1 A: 5 pre-freeze fails + hidden [F, F, A] → the spec's 8-flip example. */
  function fullCellFixture() {
    const revealed: Run[] = [];
    for (let i = 0; i < 5; i++) revealed.push(run(1 + i, 't1', '0', 10 + i, 'failed'));
    revealed.push(run(6, 't2', '0', 20, 'accepted'));
    return makeMachine({
      contest: makeContest(['t1', 't2']),
      revealed,
      hidden: [
        run(10, 't1', '0', 100, 'failed'),
        run(11, 't1', '0', 103, 'failed'),
        run(12, 't1', '0', 105, 'accepted'),
      ],
    });
  }

  it('masks the whole cell as pending with the FULL net attempt count', () => {
    const machine = fullCellFixture();
    expect(machine.remainingReveals).toBe(1);
    const t1 = machine.snapshot.byTeam.get('t1')!;
    const cell = t1.cells.get('0')!;
    // The 5 pre-freeze fails are masked too: pending, 8 total attempts,
    // zero penalty contribution.
    expect(cell.verdict).toBe('pending');
    expect(cell.attempts).toBe(8);
    expect(cell.failedAttempts).toBe(0);
    expect(t1.solved).toBe(0);
    expect(t1.penalty).toBe(0);
    // The unmasked t2 cell stays revealed as-is.
    expect(machine.snapshot.byTeam.get('t2')!.cells.get('0')!.verdict).toBe('accepted');
  });

  it('replays the whole net history in order in ONE advance (5 fails + 3 hidden = 8 flips)', () => {
    const machine = fullCellFixture();
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't1' }); // bottom team
    const reveal = machine.advance();
    if (reveal.type !== 'reveal') throw new Error('expected reveal');
    expect(reveal.runs.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5', '10', '11', '12']);
    // Pre-freeze runs carry their REAL verdicts in the replay.
    expect(reveal.runs.map((r) => r.verdict)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'accepted',
    ]);
    // The replay starts from zero attempts — no display offset left.
    expect(reveal.preFreeze).toEqual({ attempts: 0, failedAttempts: 0 });
    // Gacha counting = full net attempts = runs.length (8 ≥ default 8).
    expect(reveal.effect.gacha).toBe(true);

    // After the reveal the cell holds its final truth incl. pre-freeze fails.
    const t1 = machine.snapshot.byTeam.get('t1')!;
    const cell = t1.cells.get('0')!;
    expect(cell.verdict).toBe('accepted');
    expect(cell.attempts).toBe(8);
    expect(cell.failedAttempts).toBe(7);
    expect(t1.penalty).toBe(20 * 7 + 105);
    expect(machine.remainingReveals).toBe(0);
  });

  it('drops hidden runs past the first hidden accepted (not net, not displayed)', () => {
    const machine = makeMachine({
      contest: makeContest(['t1', 't2']),
      revealed: [run(1, 't1', '0', 10, 'failed'), run(2, 't2', '1', 5, 'accepted')],
      hidden: [
        run(10, 't1', '0', 100, 'failed'),
        run(11, 't1', '0', 105, 'accepted'),
        run(12, 't1', '0', 110, 'failed'), // past the first accepted → dropped
      ],
    });
    // Masked pending count = net attempts only (3, not 4).
    expect(machine.snapshot.byTeam.get('t1')!.cells.get('0')!.attempts).toBe(3);

    machine.advance(); // focus t1
    const reveal = machine.advance();
    if (reveal.type !== 'reveal') throw new Error('expected reveal');
    expect(reveal.runs.map((r) => r.id)).toEqual(['1', '10', '11']);
    const cell = machine.snapshot.byTeam.get('t1')!.cells.get('0')!;
    expect(cell.verdict).toBe('accepted');
    expect(cell.attempts).toBe(3);
    expect(cell.failedAttempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Static last-solve flags in award mode (spec §4): computed once from the
// FINAL full run set; displayed per cell only once revealed + accepted; never
// moving during the ceremony.
// ---------------------------------------------------------------------------

describe('static last-solve / contest first-last flags', () => {
  /**
   * Final truth of the fixture:
   *   A: t1@10 Y (contest FIRST yes), t2@20 Y, hidden t3@100 Y (A's LAST solve)
   *   B: hidden t1@110 Y (B's last solve AND the contest LAST yes)
   * Visible order at boot: t1 (1 solved, 10), t2 (1 solved, 20), t3 (0).
   */
  function staticFlagsFixture() {
    return makeMachine({
      contest: makeContest(['t1', 't2', 't3']),
      revealed: [run(1, 't1', '0', 10, 'accepted'), run(2, 't2', '0', 20, 'accepted')],
      hidden: [run(10, 't3', '0', 100, 'accepted'), run(11, 't1', '1', 110, 'accepted')],
    });
  }

  function cellOf(machine: AwardMachine, teamId: string, problemId: string) {
    return machine.snapshot.byTeam.get(teamId)!.cells.get(problemId)!;
  }
  function labelsOf(machine: AwardMachine, teamId: string) {
    return machine.snapshot.byTeam.get(teamId)!.autoLabels;
  }

  it('never marks the visible-projection last solve when the final truth differs', () => {
    const machine = staticFlagsFixture();
    // Projection-wise t2 A is the latest visible accepted run of A (and the
    // visible contest-last yes) — but the FINAL truth puts A's last solve on
    // the hidden t3 A and the contest-last yes on the hidden t1 B.
    expect(cellOf(machine, 't2', '0').isLastSolve).toBe(false);
    expect(cellOf(machine, 't2', '0').isContestLastSolve).toBe(false);
    expect(labelsOf(machine, 't2')).toEqual([]);
    // The true contest-first yes is visible from the start.
    expect(cellOf(machine, 't1', '0').isContestFirstSolve).toBe(true);
    expect(labelsOf(machine, 't1')).toEqual([{ kind: 'contestFirstYes' }]);
    expect(machine.snapshot.contestFirstYes).toEqual({ teamId: 't1', problemId: '0' });
    // Hidden cells show nothing until revealed.
    expect(cellOf(machine, 't3', '0').isLastSolve).toBe(false);
    expect(machine.snapshot.contestLastYes).toBeNull();
  });

  it('shows each flag exactly when its true cell is revealed, and it never moves', () => {
    const machine = staticFlagsFixture();

    // t3 (bottom): reveal its hidden A solve → A's last-solve flag appears
    // there immediately, and ONLY there.
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't3' });
    expect(machine.advance()).toMatchObject({ type: 'reveal', teamId: 't3', problemId: '0' });
    expect(cellOf(machine, 't3', '0').isLastSolve).toBe(true);
    expect(cellOf(machine, 't3', '0').isContestLastSolve).toBe(false); // true last is t1 B
    expect(cellOf(machine, 't2', '0').isLastSolve).toBe(false); // still not moving
    expect(labelsOf(machine, 't3')).toEqual([{ kind: 'lastToSolve', problemLabels: ['A'] }]);
    expect(machine.snapshot.contestLastYes).toBeNull(); // t1 B still hidden

    // t3 stays bottom (penalty 100 > 20) → finalize; then t2 finalizes.
    expect(machine.advance()).toMatchObject({ type: 'finalize', teamId: 't3' });
    machine.dismissSlide();
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't2' });
    expect(machine.advance()).toMatchObject({ type: 'finalize', teamId: 't2' });
    machine.dismissSlide();

    // No cell anywhere carries the contest-last flag before the true cell flips.
    for (const standing of machine.snapshot.standings) {
      for (const cell of standing.cells.values()) {
        expect(cell.isContestLastSolve).toBe(false);
      }
    }

    // t1's hidden B solve is the ceremony finale AND the true contest-last
    // yes: the purple flag appears exactly on it when it flips.
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't1' });
    const finale = machine.advance();
    expect(finale).toMatchObject({
      type: 'reveal',
      teamId: 't1',
      problemId: '1',
      effect: { gacha: true, finale: true },
    });
    expect(cellOf(machine, 't1', '1').isLastSolve).toBe(true);
    expect(cellOf(machine, 't1', '1').isContestLastSolve).toBe(true);
    expect(machine.snapshot.contestLastYes).toEqual({ teamId: 't1', problemId: '1' });
    expect(labelsOf(machine, 't1')).toEqual([
      { kind: 'contestFirstYes' },
      { kind: 'lastToSolve', problemLabels: ['B'] },
      { kind: 'contestLastYes' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Gacha effect.
// ---------------------------------------------------------------------------

describe('gacha effect', () => {
  /**
   * t1's B cell has `attempts` queued runs; t2 has two 1-run cells (A, C) so
   * the interesting reveal is neither first nor last. Order of events:
   *   focus t2 → reveal t2 A (below requirement) → focus t1 → reveal t1 B.
   */
  function gachaFixture(finalVerdict: Verdict, attempts: number, rng: () => number) {
    const hidden: Run[] = [];
    for (let i = 0; i < attempts - 1; i++) {
      hidden.push(run(10 + i, 't1', '1', 100 + i, 'failed'));
    }
    hidden.push(run(10 + attempts - 1, 't1', '1', 100 + attempts, finalVerdict));
    hidden.push(run(50, 't2', '0', 50, 'accepted'));
    hidden.push(run(51, 't2', '2', 60, 'accepted'));
    return makeMachine({
      contest: makeContest(['t1', 't2']),
      hidden,
      config: { gachaEffectRequirement: 3, gachaEffectForNoRatio: 30 },
      rng,
    });
  }

  function advanceUntilRevealOf(machine: AwardMachine, teamId: string) {
    for (let i = 0; i < 50; i++) {
      const result = machine.advance();
      if (result.type === 'finalize') machine.dismissSlide();
      if (result.type === 'reveal' && result.teamId === teamId) return result;
    }
    throw new Error(`no reveal for ${teamId}`);
  }

  it('attempts >= requirement with final Yes → always gacha, rng untouched', () => {
    const rng = vi.fn(() => 0.0);
    const machine = gachaFixture('accepted', 3, rng);
    const reveal = advanceUntilRevealOf(machine, 't1');
    expect(reveal.effect).toEqual({ gacha: true, finale: false });
    expect(rng).not.toHaveBeenCalled();
  });

  it('attempts >= requirement with final No → gacha iff rng() < ratio/100', () => {
    const below = gachaFixture('failed', 3, () => 0.299);
    expect(advanceUntilRevealOf(below, 't1').effect).toEqual({ gacha: true, finale: false });

    const atThreshold = gachaFixture('failed', 3, () => 0.3); // strict <
    expect(advanceUntilRevealOf(atThreshold, 't1').effect).toEqual({
      gacha: false,
      finale: false,
    });
  });

  it('rolls the rng exactly once per qualifying No reveal', () => {
    const rng = vi.fn(() => 0.5);
    const machine = gachaFixture('failed', 4, rng);
    advanceUntilRevealOf(machine, 't1');
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it('attempts below requirement (and not finale) → no gacha, rng untouched', () => {
    const rng = vi.fn(() => 0.0);
    const machine = gachaFixture('accepted', 2, rng); // 2 < requirement 3
    const t2Reveal = advanceUntilRevealOf(machine, 't2'); // 1 queued run
    expect(t2Reveal.effect).toEqual({ gacha: false, finale: false });
    const t1Reveal = advanceUntilRevealOf(machine, 't1');
    expect(t1Reveal.effect).toEqual({ gacha: false, finale: false });
    expect(rng).not.toHaveBeenCalled();
  });

  /**
   * Spec §6: the requirement counts the cell's FULL net attempts. With
   * full-cell masking the pre-freeze runs are part of the replay itself, so
   * the count is simply runs.length.
   */
  function preFreezeGachaFixture(preFreezeFails: number) {
    const revealed: Run[] = [];
    for (let i = 0; i < preFreezeFails; i++) {
      revealed.push(run(1 + i, 't1', '1', 10 + i, 'failed'));
    }
    const hidden = [
      run(20, 't1', '1', 100, 'failed'),
      run(21, 't1', '1', 105, 'accepted'),
      run(50, 't2', '0', 50, 'accepted'),
      run(51, 't2', '2', 60, 'accepted'), // t1's reveal is not the finale
    ];
    return makeMachine({
      contest: makeContest(['t1', 't2']),
      revealed,
      hidden,
      config: { gachaEffectRequirement: 8 },
      rng: () => 0.99,
    });
  }

  it('counts pre-freeze net attempts toward the requirement (6 + 2 = 8 → gacha)', () => {
    const machine = preFreezeGachaFixture(6);
    const reveal = advanceUntilRevealOf(machine, 't1');
    // The animation list IS the full net history (6 pre-freeze + 2 hidden).
    expect(reveal.runs).toHaveLength(8);
    expect(reveal.preFreeze).toEqual({ attempts: 0, failedAttempts: 0 });
    expect(reveal.effect).toEqual({ gacha: true, finale: false });
  });

  it('one attempt short across the freeze boundary (5 + 2 = 7) → no gacha', () => {
    const machine = preFreezeGachaFixture(5);
    const reveal = advanceUntilRevealOf(machine, 't1');
    expect(reveal.runs).toHaveLength(7);
    expect(reveal.preFreeze).toEqual({ attempts: 0, failedAttempts: 0 });
    expect(reveal.effect).toEqual({ gacha: false, finale: false });
  });

  it('does not bleed another cell’s pre-freeze attempts into the count', () => {
    // t1 B has 1 pre-freeze fail while t1 A holds 7 pre-freeze runs with no
    // hidden run — A stays revealed as-is and its attempts never join B's
    // replay (1 + 2 < 8 → no gacha).
    const revealed: Run[] = [];
    for (let i = 0; i < 7; i++) revealed.push(run(1 + i, 't1', '0', 10 + i, 'failed'));
    revealed.push(run(8, 't1', '1', 20, 'failed'));
    const machine = makeMachine({
      contest: makeContest(['t1', 't2']),
      revealed,
      hidden: [
        run(20, 't1', '1', 100, 'failed'),
        run(21, 't1', '1', 105, 'accepted'),
        run(50, 't2', '0', 50, 'accepted'),
        run(51, 't2', '2', 60, 'accepted'),
      ],
      config: { gachaEffectRequirement: 8 },
      rng: () => 0.99,
    });
    // Cell A has no hidden run → NOT masked, its 7 fails stay on the board.
    const cellA = machine.snapshot.byTeam.get('t1')!.cells.get('0')!;
    expect(cellA.verdict).toBe('failed');
    expect(cellA.attempts).toBe(7);
    const reveal = advanceUntilRevealOf(machine, 't1');
    expect(reveal.problemId).toBe('1');
    expect(reveal.runs).toHaveLength(3); // 1 pre-freeze fail + 2 hidden
    expect(reveal.effect).toEqual({ gacha: false, finale: false });
  });

  it('remainingReveals === 1 fires the gacha unconditionally, even for one attempt', () => {
    const contest = makeContest(['t1', 't2']);
    const yes = makeMachine({
      contest,
      hidden: [run(10, 't1', '1', 100, 'accepted')],
      config: { gachaEffectRequirement: 8 },
    });
    expect(advanceUntilRevealOf(yes, 't1').effect).toEqual({ gacha: true, finale: true });

    // Spec §6: the finale cell fires 100% REGARDLESS of the verdict — the No
    // probability roll never runs (rng untouched).
    const rng = vi.fn(() => 0.99); // would miss the 30% roll if it ran
    const noFinale = makeMachine({
      contest,
      hidden: [run(10, 't1', '1', 100, 'failed')],
      config: { gachaEffectRequirement: 8, gachaEffectForNoRatio: 30 },
      rng,
    });
    expect(advanceUntilRevealOf(noFinale, 't1').effect).toEqual({ gacha: true, finale: true });
    expect(rng).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Finale flag.
// ---------------------------------------------------------------------------

describe('finale (remainingReveals === 1 before the reveal)', () => {
  it('marks only the very last reveal of the whole ceremony', () => {
    const machine = rankShiftFixture();
    const reveals = revealsOf(collectToEnd(machine));
    expect(reveals).toHaveLength(2);
    expect(reveals[0].effect.finale).toBe(false);
    expect(reveals[1].effect.finale).toBe(true);
    expect(reveals[1].teamId).toBe('t1');
  });
});

// ---------------------------------------------------------------------------
// rankBegin fast-forward.
// ---------------------------------------------------------------------------

describe('rankBegin fast-forward', () => {
  it('finalizes everything below rankBegin at construction, effects suppressed', () => {
    const machine = rankShiftFixture({ rankBegin: 2 });

    // Teams at visible index >= 2 (t3, t4 — including the mid-ff rank shift)
    // are finalized; the top 2 are untouched.
    expect(machine.teamStage.get('t4')).toBe('finalized');
    expect(machine.teamStage.get('t3')).toBe('finalized');
    expect(machine.teamStage.get('t2')).toBe('hidden');
    expect(machine.teamStage.get('t1')).toBe('hidden');

    // t3's hidden solve was really applied during the fast-forward.
    const t3 = machine.snapshot.byTeam.get('t3')!;
    expect(t3.solved).toBe(1);
    expect(t3.penalty).toBe(35);
    expect(machine.snapshot.standings.map((s) => s.team.id)).toEqual(['t1', 't2', 't3', 't4']);

    // Slides opened during fast-forward were auto-dismissed.
    expect(machine.currentSlideTeamId).toBeNull();
    expect(machine.finished).toBe(false);

    // The ceremony resumes at the team in (1-based) position rankBegin.
    expect(machine.remainingReveals).toBe(1); // t1 C still queued
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't2' });
  });

  it('keeps live effects intact after the fast-forward', () => {
    const machine = rankShiftFixture({ rankBegin: 2 });
    const reveals = revealsOf(collectToEnd(machine));
    expect(reveals).toHaveLength(1); // only t1 C is left to reveal live
    expect(reveals[0].effect).toEqual({ gacha: true, finale: true });
  });

  it('rankBegin beyond the field is a no-op', () => {
    const machine = rankShiftFixture({ rankBegin: 99 });
    expect([...machine.teamStage.values()]).toEqual(['hidden', 'hidden', 'hidden', 'hidden']);
    expect(machine.remainingReveals).toBe(2);
  });

  it('rankBegin 0 fast-forwards the entire ceremony to the end state', () => {
    const machine = rankShiftFixture({ rankBegin: 0 });
    expect(machine.finished).toBe(true);
    expect(machine.remainingReveals).toBe(0);
    expect([...machine.teamStage.values()].every((s) => s === 'finalized')).toBe(true);
    expect(machine.advance()).toEqual({ type: 'end' });
  });
});

// ---------------------------------------------------------------------------
// Finalize → slide → dismiss cycle; end reachability.
// ---------------------------------------------------------------------------

describe('finalize/slide/dismiss cycle and end', () => {
  it('every team gets finalize + slide; end arrives after the last dismissal', () => {
    const machine = rankShiftFixture();
    const results = collectToEnd(machine);

    const finalizes = results.filter((r) => r.type === 'finalize');
    expect(finalizes).toHaveLength(4);
    expect(finalizes.every((r) => r.type === 'finalize' && r.showSlide)).toBe(true);
    expect(results[results.length - 1]).toEqual({ type: 'end' });
    expect(machine.finished).toBe(true);
  });

  it('an advance during a visible slide is consumed as its dismissal (spec §6)', () => {
    const contest = makeContest(['t1']);
    const machine = makeMachine({ contest });

    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't1' });
    expect(machine.advance()).toEqual({ type: 'finalize', teamId: 't1', showSlide: true });
    expect(machine.currentSlideTeamId).toBe('t1');
    expect(machine.finished).toBe(true);

    // The advance key closes the slide (presenter remotes have no Escape);
    // the ceremony can be driven end-to-end with PageDown alone.
    expect(machine.advance()).toEqual({ type: 'slide-on' });
    expect(machine.currentSlideTeamId).toBeNull();
    machine.dismissSlide(); // idempotent no-op after the consumed advance
    expect(machine.currentSlideTeamId).toBeNull();
    expect(machine.advance()).toEqual({ type: 'end' });
  });
});
