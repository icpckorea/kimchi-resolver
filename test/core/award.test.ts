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
    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't3' });
    expect(machine.teamStage.get('t3')).toBe('focused');

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

    // 4. t4 has no pending cells → finalize with slide.
    expect(machine.advance()).toEqual({ type: 'finalize', teamId: 't4', showSlide: true });
    expect(machine.teamStage.get('t4')).toBe('finalized');
    expect(machine.currentSlideTeamId).toBe('t4');

    // 5. while the slide is showing, advance() is a no-op slide-on.
    expect(machine.advance()).toEqual({ type: 'slide-on' });
    expect(machine.advance()).toEqual({ type: 'slide-on' });
    machine.dismissSlide();
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

  it('remainingReveals === 1 forces the gacha condition even for one attempt', () => {
    const contest = makeContest(['t1', 't2']);
    const yes = makeMachine({
      contest,
      hidden: [run(10, 't1', '1', 100, 'accepted')],
      config: { gachaEffectRequirement: 8 },
    });
    expect(advanceUntilRevealOf(yes, 't1').effect).toEqual({ gacha: true, finale: true });

    const noHit = makeMachine({
      contest,
      hidden: [run(10, 't1', '1', 100, 'failed')],
      config: { gachaEffectRequirement: 8, gachaEffectForNoRatio: 30 },
      rng: () => 0.0,
    });
    expect(advanceUntilRevealOf(noHit, 't1').effect).toEqual({ gacha: true, finale: true });

    // The fake-out can also NOT fire — finale stays on regardless.
    const noMiss = makeMachine({
      contest,
      hidden: [run(10, 't1', '1', 100, 'failed')],
      config: { gachaEffectRequirement: 8, gachaEffectForNoRatio: 30 },
      rng: () => 0.99,
    });
    expect(advanceUntilRevealOf(noMiss, 't1').effect).toEqual({ gacha: false, finale: true });
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

  it('an undismissed slide swallows advances until dismissSlide()', () => {
    const contest = makeContest(['t1']);
    const machine = makeMachine({ contest });

    expect(machine.advance()).toEqual({ type: 'focus', teamId: 't1' });
    expect(machine.advance()).toEqual({ type: 'finalize', teamId: 't1', showSlide: true });
    expect(machine.currentSlideTeamId).toBe('t1');
    expect(machine.finished).toBe(true);

    expect(machine.advance()).toEqual({ type: 'slide-on' });
    expect(machine.advance()).toEqual({ type: 'slide-on' });
    machine.dismissSlide();
    machine.dismissSlide(); // idempotent
    expect(machine.currentSlideTeamId).toBeNull();
    expect(machine.advance()).toEqual({ type: 'end' });
  });
});
