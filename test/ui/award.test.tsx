/**
 * Award ceremony UI tests (jsdom).
 *
 * Boots a real store (mock fetch, noop scheduler) into award mode with a
 * small fixture contest, renders AwardView, and drives it with window
 * keydown events — exactly the integration surface a presenter uses.
 *
 * Timing model: jsdom fires no CSS animation events, so useCellFlip
 * completes each flip via its fallback timer at 2× the flip duration.
 * All timeline math below uses that worst case.
 */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppStore, type AppStore } from '@store/appStore';
import { AwardView } from '@ui/award/AwardView';
import { humanizeRank, parseAwardsJson, type AwardEntry } from '@ui/award/awardsData';
import {
  BUSY_HARD_TIMEOUT_MS,
  FINALE_FLIP_MIN_MS,
  FINALE_FLIP_MULTIPLIER,
  FINALE_HOLD_MS,
  GACHA_SHAKE_MS,
  accumulateDisplay,
  finaleSlowFlipMs,
  matchAnimationSpeed,
  moveUpDurationSec,
} from '@ui/award/revealDriver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAST = 100;
const SLOW = 400;

/** Worst-case duration of team 3's reveal (7 fast fails + gacha + slow Yes). */
const T3_SEQUENCE_MS = 7 * FAST * 2 + GACHA_SHAKE_MS + SLOW * 2;

const configJson = {
  source: { type: 'spotboard', apiBase: './sample/' },
  award: {
    // Deterministic ceremony for tests: no blink step, gacha at 8 attempts.
    focusBlinking: null,
    gachaEffectRequirement: 8,
    gachaEffectForNoRatio: 30,
    animationSpeeds: [{ minSolved: 0, fastFlip: FAST, slowFlip: SLOW, moveUpMsPerRow: 100 }],
  },
};

const contestJson = {
  title: 'Fixture Contest',
  systemName: 'test',
  systemVersion: '1',
  problems: [
    { id: 0, name: 'A', title: 'Alpha', color: 'red' },
    { id: 1, name: 'B', title: 'Beta', color: 'blue' },
  ],
  teams: [
    { id: 1, name: 'Alpha Team', group: 'Univ One' },
    { id: 2, name: 'Beta Team', group: 'Univ Two' },
    { id: 3, name: 'Gamma Team', group: 'Univ Three' },
  ],
};

// Freeze cutoff r=2: runs 3+ stay hidden (pending) for the ceremony.
// Team 3 has 8 net runs on B (7 fails + Yes) → deterministic gacha trigger
// (gachaEffectRequirement = 8, final Yes → gacha always fires).
// Team 2's single hidden No on B is the LAST reveal → finale.
const runsJson = {
  time: { contestTime: 18000, noMoreUpdate: true, timestamp: 0 },
  runs: [
    { id: 1, team: 1, problem: 0, result: 'Yes', submissionTime: 10 },
    { id: 2, team: 2, problem: 0, result: 'Yes', submissionTime: 20 },
    ...Array.from({ length: 7 }, (_, i) => ({
      id: 3 + i,
      team: 3,
      problem: 1,
      result: 'No - Wrong Answer',
      submissionTime: 40 + i,
    })),
    { id: 10, team: 3, problem: 1, result: 'Yes', submissionTime: 47 },
    { id: 11, team: 2, problem: 1, result: 'No - Wrong Answer', submissionTime: 60 },
  ],
};

const awardsFixture: AwardEntry[] = [
  { teamId: '3', rank: 3, icon: 'medal_bronze', labels: ['Bronze!'], others: [] },
  {
    teamId: '2',
    rank: '대상',
    icon: 'medal_gold',
    labels: ['대상 수상자', 'B fighter'],
    others: ['1'],
  },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes('config.json')) return jsonResponse(configJson);
  if (url.includes('contest.json')) return jsonResponse(contestJson);
  if (url.includes('runs.json')) return jsonResponse(runsJson);
  return new Response('not found', { status: 404, statusText: 'Not Found' });
};

const noopScheduler = { setInterval: () => 0, clearInterval: () => {} };

async function bootAwardStore(
  rng: () => number = () => 0.99,
  search = '?award=true&r=2',
): Promise<AppStore> {
  const store = createAppStore({ fetchImpl, scheduler: noopScheduler, rng });
  await store.getState().boot(search);
  expect(store.getState().status).toBe('ready');
  expect(store.getState().mode).toBe('award');
  return store;
}

function renderAward(store: AppStore) {
  return render(<AwardView store={store} awards={awardsFixture} />);
}

async function pressKey(key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, { key });
  });
}

async function advanceMs(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Run any reveal sequence to completion (covers the longest fixture case). */
async function finishSequence(): Promise<void> {
  await advanceMs(T3_SEQUENCE_MS + 500);
}

function stageOf(store: AppStore, teamId: string): string | undefined {
  return store.getState().awardMachine?.teamStage.get(teamId);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Rank humanization
// ---------------------------------------------------------------------------

describe('humanizeRank', () => {
  it('renders numbers as ordinal places', () => {
    expect(humanizeRank(1)).toBe('1st Place');
    expect(humanizeRank(2)).toBe('2nd Place');
    expect(humanizeRank(3)).toBe('3rd Place');
    expect(humanizeRank(4)).toBe('4th Place');
    expect(humanizeRank(11)).toBe('11th Place');
    expect(humanizeRank(12)).toBe('12th Place');
    expect(humanizeRank(13)).toBe('13th Place');
    expect(humanizeRank(21)).toBe('21st Place');
    expect(humanizeRank(22)).toBe('22nd Place');
    expect(humanizeRank(103)).toBe('103rd Place');
  });

  it('passes strings through verbatim', () => {
    expect(humanizeRank('대상')).toBe('대상');
    expect(humanizeRank('Special Award')).toBe('Special Award');
  });
});

describe('parseAwardsJson', () => {
  it('parses entries and stringifies numeric ids', () => {
    const parsed = parseAwardsJson([
      { teamId: 47, rank: '동상', icon: 'medal_bronze', labels: ['동상 수상자'], others: [] },
    ]);
    expect(parsed.get('47')?.rank).toBe('동상');
    expect(parsed.get('47')?.labels).toEqual(['동상 수상자']);
  });

  it('skips malformed items without throwing', () => {
    const parsed = parseAwardsJson([null, 42, { rank: 1 }, { teamId: '9', rank: 2 }]);
    expect(parsed.size).toBe(1);
    expect(parsed.get('9')?.rank).toBe(2);
  });
});

describe('matchAnimationSpeed', () => {
  it('matches the satisfied entry with the largest minSolved', () => {
    const speeds = [
      { minSolved: 10, fastFlip: 1, slowFlip: 2, moveUpMsPerRow: 3 },
      { minSolved: 0, fastFlip: 4, slowFlip: 5, moveUpMsPerRow: 6 },
    ];
    expect(matchAnimationSpeed(speeds, 12).fastFlip).toBe(1);
    expect(matchAnimationSpeed(speeds, 3).fastFlip).toBe(4);
  });

  it('is order-independent: an ascending config must not shadow higher bands', () => {
    // The original required minSolved-descending order; a config written
    // ascending silently matched the catch-all for every team (spec §6:
    // trap removed).
    const ascending = [
      { minSolved: 0, fastFlip: 4, slowFlip: 5, moveUpMsPerRow: 6 },
      { minSolved: 10, fastFlip: 1, slowFlip: 2, moveUpMsPerRow: 3 },
    ];
    expect(matchAnimationSpeed(ascending, 12).fastFlip).toBe(1);
    expect(matchAnimationSpeed(ascending, 10).fastFlip).toBe(1);
    expect(matchAnimationSpeed(ascending, 9).fastFlip).toBe(4);
  });
});

describe('moveUpDurationSec', () => {
  it('derives the layout-move duration from the band moveUpMsPerRow', () => {
    const speed = { minSolved: 0, fastFlip: 300, slowFlip: 700, moveUpMsPerRow: 200 };
    expect(moveUpDurationSec(3, speed)).toBeCloseTo(0.6);
    expect(moveUpDurationSec(1, { ...speed, moveUpMsPerRow: 100 })).toBeCloseTo(0.1);
    // Clamped to a sane range.
    expect(moveUpDurationSec(100, speed)).toBe(3);
    expect(moveUpDurationSec(1, { ...speed, moveUpMsPerRow: 10 })).toBe(0.05);
    // No move → small default (irrelevant, nothing animates).
    expect(moveUpDurationSec(0, speed)).toBe(0.3);
  });
});

describe('finaleSlowFlipMs', () => {
  it('is 4~5x the matched slowFlip with a 3s floor (spec §7)', () => {
    expect(FINALE_FLIP_MULTIPLIER).toBeGreaterThanOrEqual(4);
    expect(FINALE_FLIP_MULTIPLIER).toBeLessThanOrEqual(5);
    expect(FINALE_FLIP_MIN_MS).toBe(3000);
    // Small slowFlip → the 3s floor wins.
    expect(finaleSlowFlipMs(400)).toBe(3000);
    // Large slowFlip → the multiplier wins.
    expect(finaleSlowFlipMs(1000)).toBe(1000 * FINALE_FLIP_MULTIPLIER);
    expect(finaleSlowFlipMs(1000)).toBeGreaterThanOrEqual(3000);
  });
});

describe('accumulateDisplay (full-cell replay from zero)', () => {
  const RUN = { id: '1', teamId: 't', problemId: 'p', seq: 1 };
  const fail = (minute: number) => ({
    ...RUN,
    minute,
    verdict: 'failed' as const,
    penaltyCounts: true,
  });
  const yes = (minute: number) => ({
    ...RUN,
    minute,
    verdict: 'accepted' as const,
    penaltyCounts: false,
  });

  it('counts the replay from zero: a masked cell restarts at −1, −2, … +N', () => {
    // Spec §6 full-cell masking: the reveal step carries the WHOLE net
    // history (pre-freeze fails included) in `runs`, so there is no offset —
    // a cell frozen at '?3' replays '−1' → '−2' → '+2'.
    const runs = [fail(100), fail(101), yes(102)];
    expect(accumulateDisplay(runs, 0)).toMatchObject({
      verdict: 'failed',
      attempts: 1,
      failedAttempts: 1,
    });
    expect(accumulateDisplay(runs, 1)).toMatchObject({
      verdict: 'failed',
      attempts: 2,
      failedAttempts: 2,
    });
    expect(accumulateDisplay(runs, 2)).toMatchObject({
      verdict: 'accepted',
      attempts: 3,
      failedAttempts: 2,
      solvedMinute: 102,
    });
  });

  it('ignores non-penalized fails in the failed counter', () => {
    const compileError = { ...RUN, minute: 60, verdict: 'failed' as const, penaltyCounts: false };
    expect(accumulateDisplay([compileError, yes(65)], 1)).toMatchObject({
      verdict: 'accepted',
      attempts: 2,
      failedAttempts: 0,
      solvedMinute: 65,
    });
  });
});

// ---------------------------------------------------------------------------
// Keyboard mapping
// ---------------------------------------------------------------------------

describe('AwardView keyboard', () => {
  it('advances on Enter, ArrowRight, ";" and PageDown; PageUp is a no-op', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    // Bottom team is team 3 (rank 3). PageUp must do nothing.
    await pressKey('PageUp');
    expect(stageOf(store, '3')).toBe('hidden');

    await pressKey('Enter');
    expect(stageOf(store, '3')).toBe('focused');

    // ArrowRight → reveal of team 3's pending cell (B).
    await pressKey('ArrowRight');
    expect(store.getState().awardMachine?.remainingReveals).toBe(1);
    await finishSequence();

    // ';' → finalize team 3 (slide shows).
    await pressKey(';');
    expect(stageOf(store, '3')).toBe('finalized');
    expect(store.getState().awardMachine?.currentSlideTeamId).toBe('3');

    // Escape → dismiss the slide.
    await pressKey('Escape');
    expect(store.getState().awardMachine?.currentSlideTeamId).toBeNull();

    // PageDown → focus the next bottom team (team 2).
    await pressKey('PageDown');
    expect(stageOf(store, '2')).toBe('focused');
  });
});

// ---------------------------------------------------------------------------
// Busy latch
// ---------------------------------------------------------------------------

describe('AwardView busy latch', () => {
  it('ignores advance keys while a reveal sequence is playing', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal team 3 cell B — sequence starts
    expect(store.getState().awardMachine?.remainingReveals).toBe(1);

    // Mid-sequence keypresses must be swallowed (no finalize).
    await advanceMs(FAST); // somewhere inside the sequence
    await pressKey('Enter');
    await pressKey('PageDown');
    expect(stageOf(store, '3')).toBe('focused'); // still not finalized

    // The latch releases once the sequence completes.
    await finishSequence();
    await pressKey('Enter');
    expect(stageOf(store, '3')).toBe('finalized');
  });

  it('can never stick: the hard deadline unblocks even when timers are lost', async () => {
    const store = await bootAwardStore();
    renderAward(store);
    await pressKey('Enter'); // focus
    await pressKey('Enter'); // reveal — latch on

    // Simulate a stuck sequence: wall clock passes the hard deadline while
    // the timeline timers never fire.
    const frozenNow = Date.now();
    const spy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(frozenNow + T3_SEQUENCE_MS + BUSY_HARD_TIMEOUT_MS + 1000);
    await pressKey('Enter');
    expect(stageOf(store, '3')).toBe('finalized');
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// hideName masking
// ---------------------------------------------------------------------------

describe('AwardView hideName', () => {
  it('masks hidden teams as "Team {id}" / "Unknown" and unmasks on focus', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    expect(screen.getByText('Team 3')).toBeTruthy();
    expect(screen.queryByText('Gamma Team')).toBeNull();
    expect(screen.getAllByText('Unknown').length).toBe(3);

    await pressKey('Enter'); // focus team 3 → identity revealed
    expect(screen.queryByText('Team 3')).toBeNull();
    expect(screen.getByText('Gamma Team')).toBeTruthy();
    expect(screen.getByText('Univ Three')).toBeTruthy();
    // Others stay masked.
    expect(screen.getByText('Team 1')).toBeTruthy();
    expect(screen.getByText('Team 2')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Award slide
// ---------------------------------------------------------------------------

describe('AwardSlide', () => {
  it('shows the slide on finalize with humanized numeric rank and labels', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    await pressKey('Enter'); // focus 3
    await pressKey('Enter'); // reveal
    await finishSequence();
    await pressKey('Enter'); // finalize 3 → slide

    const slide = screen.getByTestId('award-slide');
    expect(screen.getByTestId('award-slide-rank').textContent).toBe('3rd Place');
    expect(screen.getByTestId('award-slide-team').textContent).toBe('Gamma Team');
    // The label badge shows in the slide AND on the finalized team's row.
    expect(within(slide).getByText('Bronze!')).toBeTruthy();
    expect(screen.getAllByText('Bronze!').length).toBe(2);

    await pressKey('Escape');
    expect(screen.queryByTestId('award-slide')).toBeNull();
  });

  it('re-shows a finalized medalist slide when its name is clicked', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    await pressKey('Enter');
    await pressKey('Enter');
    await finishSequence();
    await pressKey('Enter'); // finalize team 3
    await pressKey('Escape'); // dismiss slide
    expect(screen.queryByTestId('award-slide')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText('Gamma Team'));
    });
    expect(screen.getByTestId('award-slide')).toBeTruthy();
    expect(screen.getByTestId('award-slide-rank').textContent).toBe('3rd Place');

    await pressKey('Escape');
    expect(screen.queryByTestId('award-slide')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Finale effect
// ---------------------------------------------------------------------------

describe('finale effect', () => {
  /** Finale final flip in the fixture band (spec §7: ≥ 3s). */
  const FINALE_FLIP = finaleSlowFlipMs(SLOW); // = 3000 (floor wins over 4.5×400)
  /** jsdom completes flips via the 2× fallback timer. */
  const FINALE_FLIP_2X = FINALE_FLIP * 2;

  function finaleFlipEl(): HTMLElement {
    const el = screen
      .getByTestId('award-cell-2-1')
      .querySelector<HTMLElement>('.problem-result');
    expect(el).not.toBeNull();
    return el!;
  }

  async function driveToLastReveal(store: AppStore): Promise<void> {
    // Team 3: focus, reveal, finalize, dismiss slide.
    await pressKey('Enter');
    await pressKey('Enter');
    await finishSequence();
    await pressKey('Enter');
    await pressKey('Escape');
    // Team 2: focus, then the LAST reveal of the ceremony (finale).
    await pressKey('Enter');
    expect(stageOf(store, '2')).toBe('focused');
    expect(store.getState().awardMachine?.remainingReveals).toBe(1);
    await pressKey('Enter'); // finale reveal starts
  }

  it('applies dim/zoom/slow-flip during the last reveal and restores 5s after it', async () => {
    const store = await bootAwardStore(() => 0.99); // rng > ratio → no gacha fake-out
    renderAward(store);
    await driveToLastReveal(store);

    // Full-screen dim overlay + zoomed cell are on during the sequence; the
    // row hosting the cell is lifted above the dim veil. The rainbow is the
    // finale VARIANT of the gacha effect (spec §7): the gacha roll missed
    // (gacha:false), so no rainbow may play.
    expect(screen.getByTestId('finale-dim')).toBeTruthy();
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();
    expect(screen.getByTestId('award-cell-2-1').className).toContain('award-cell-finale');
    expect(screen.getByTestId('award-row-2').className).toContain('award-row-finale');

    // The final flip runs at the VERY slow finale duration (4~5× slowFlip,
    // ≥ 3s), not the plain slowFlip: the half-turn CSS variable carries it…
    const flipEl = finaleFlipEl();
    expect(flipEl.className).toContain('flip-run');
    expect(flipEl.style.getPropertyValue('--flip-half')).toBe(`${FINALE_FLIP / 2}ms`);

    // …and well past the NORMAL slowFlip fallback (2×SLOW) it is still
    // mid-flip, with the dim/zoom still up.
    await advanceMs(SLOW * 2 + 50);
    expect(finaleFlipEl().getAttribute('data-flip-phase')).toBe('out');
    expect(screen.getByTestId('finale-dim')).toBeTruthy();
    expect(screen.getByTestId('award-cell-2-1').className).toContain('award-cell-finale');

    // Complete the finale flip (jsdom fallback at 2× the finale duration):
    // the reveal is over, the spotlight/zoom holds for FINALE_HOLD_MS.
    await advanceMs(FINALE_FLIP_2X - SLOW * 2 - 50 + 100);
    expect(finaleFlipEl().className).not.toContain('flip-run');
    expect(screen.getByTestId('finale-dim')).toBeTruthy();
    expect(screen.getByTestId('award-cell-2-1').className).toContain('award-cell-finale');

    // 5s after the reveal completed everything restores.
    await advanceMs(FINALE_HOLD_MS + 100);
    expect(screen.queryByTestId('finale-dim')).toBeNull();
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();
    expect(screen.getByTestId('award-cell-2-1').className).not.toContain('award-cell-finale');
    expect(screen.getByTestId('award-row-2').className).not.toContain('award-row-finale');
  });

  it('keeps the gacha shake and rainbow running DURING the slow flip', async () => {
    const store = await bootAwardStore(() => 0.0); // rng < ratio → gacha fake-out on No
    renderAward(store);
    await driveToLastReveal(store);

    // Gacha shake phase precedes the final flip; the finale cell gets the
    // full-cell rainbow INSTEAD of the thin sparkle overlay (spec §7).
    await advanceMs(GACHA_SHAKE_MS / 2);
    const cell = screen.getByTestId('award-cell-2-1');
    expect(cell.className).toContain('award-cell-gacha');
    expect(cell.className).toContain('award-cell-finale');
    expect(screen.getByTestId('finale-rainbow')).toBeTruthy();
    expect(screen.queryByTestId('gacha-sparkle')).toBeNull();

    // Mid-FLIP the shake wrapper is NOT cancelled (spec §7: "flip이 도는
    // 동안에도 진동이 계속"): the flip nests inside the shaking wrapper so
    // both transforms compose, and the rainbow keeps flowing.
    await advanceMs(GACHA_SHAKE_MS / 2 + 500); // 500ms into the finale flip
    const midFlip = finaleFlipEl();
    expect(midFlip.className).toContain('flip-run');
    expect(midFlip.getAttribute('data-flip-phase')).toBe('out');
    expect(midFlip.style.getPropertyValue('--flip-half')).toBe(`${FINALE_FLIP / 2}ms`);
    const midCell = screen.getByTestId('award-cell-2-1');
    expect(midCell.className).toContain('award-cell-gacha'); // shake persists
    expect(midCell.className).toContain('award-cell-finale');
    expect(midCell.contains(midFlip)).toBe(true); // flip nested in the wrapper
    expect(screen.getByTestId('finale-rainbow')).toBeTruthy();

    // After the flip the shake stops (cell back at rest) and the rainbow
    // stops flowing with it ("진동이 멈출 때까지"); the spotlight/zoom holds.
    await advanceMs(FINALE_FLIP_2X - 500 + 100);
    expect(screen.getByTestId('award-cell-2-1').className).not.toContain('award-cell-gacha');
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();
    expect(screen.getByTestId('finale-dim')).toBeTruthy();
    expect(screen.getByTestId('award-cell-2-1').className).toContain('award-cell-finale');

    // …and 5s later the finale restores completely.
    await advanceMs(FINALE_HOLD_MS + 100);
    expect(screen.queryByTestId('finale-dim')).toBeNull();
    expect(screen.getByTestId('award-cell-2-1').className).not.toContain('award-cell-finale');
  });
});

// ---------------------------------------------------------------------------
// Entry-less finalize: no invisible slide latch (spec §6)
// ---------------------------------------------------------------------------

describe('finalize without an awards.json entry', () => {
  it('auto-dismisses the machine slide so the next advance key works', async () => {
    const store = await bootAwardStore();
    // Only team 2 has an award entry; team 3 (finalized first) has none.
    render(<AwardView store={store} awards={[awardsFixture[1]]} />);

    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal team 3 B
    await finishSequence();
    await pressKey('Enter'); // finalize team 3 — no entry → NO slide
    expect(stageOf(store, '3')).toBe('finalized');
    expect(screen.queryByTestId('award-slide')).toBeNull();
    // The machine slide was auto-dismissed, not left latched invisibly.
    expect(store.getState().awardMachine?.currentSlideTeamId).toBeNull();

    // The very next advance key (presenter remote: no Escape!) must work.
    await pressKey('PageDown');
    expect(stageOf(store, '2')).toBe('focused');
  });
});

// ---------------------------------------------------------------------------
// Reveal spoiler prevention (deferred snapshot commit)
// ---------------------------------------------------------------------------

describe('reveal spoiler prevention', () => {
  it('keeps the pre-reveal standings on screen until the sequence completes', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal team 3 B (hidden Yes) — sequence starts

    // The machine already swapped the real runs in…
    expect(store.getState().awardMachine?.snapshot.byTeam.get('3')?.solved).toBe(1);
    // …but the RENDERED standings must not spoil the verdict: solved spine
    // and penalty stay at their pre-reveal values while the cell flips.
    const row = screen.getByTestId('award-row-3');
    expect(row.getAttribute('data-solved')).toBe('0');
    expect(row.querySelector('.team-penalty')?.textContent).toContain('0');

    await finishSequence();
    // Sequence over → the post-reveal snapshot is committed.
    expect(screen.getByTestId('award-row-3').getAttribute('data-solved')).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Full-cell reveal replay (spec §6): a cell with hidden runs is masked
// ENTIRELY — its pre-freeze fails replay too, counting from zero.
// ---------------------------------------------------------------------------

describe('full-cell replay with pre-freeze attempts (r=5: 3 revealed fails on team 3 B)', () => {
  function verdictOf(testId: string): string | null | undefined {
    return screen.getByTestId(testId).querySelector('.problem-result')?.getAttribute('data-verdict');
  }
  function attemptsOf(testId: string): string {
    return screen.getByTestId(testId).querySelector('.problem-attempts')?.textContent ?? '';
  }

  it('replays the whole net history from ?8 through −1…−7 to +7', async () => {
    // r=5: runs 3..5 (3 fails on team 3 B) land pre-freeze, runs 6..10
    // (4 fails + Yes) post-freeze. The cell is masked ENTIRELY: it shows the
    // FULL attempt count '?8', and one advance replays all 8 net runs —
    // 7 fast fail flips, then the gacha shake (8 ≥ requirement 8, final Yes
    // → always), then the slow Yes flip.
    const store = await bootAwardStore(() => 0.99, '?award=true&r=5');
    renderAward(store);

    await pressKey('Enter'); // focus team 3
    // Masked cell shows pending with the full net attempt count.
    expect(verdictOf('award-cell-3-1')).toBe('pending');
    expect(attemptsOf('award-cell-3-1')).toBe('?8');

    await pressKey('Enter'); // reveal
    // Until the first flip midpoint the frozen display persists.
    expect(verdictOf('award-cell-3-1')).toBe('pending');
    expect(attemptsOf('award-cell-3-1')).toBe('?8');

    // First fast flip (fallback at 2×FAST): the replay starts from zero —
    // '−1', the first pre-freeze fail, NOT a continuation at '−4'.
    await advanceMs(FAST * 2 + 50);
    expect(verdictOf('award-cell-3-1')).toBe('failed');
    expect(attemptsOf('award-cell-3-1')).toBe('−1');

    // Second fast flip → '−2'.
    await advanceMs(FAST * 2);
    expect(attemptsOf('award-cell-3-1')).toBe('−2');

    // After all 7 fast fail flips (pre-freeze AND hidden fails alike) the
    // gacha shake fires before the final Yes.
    await advanceMs(5 * FAST * 2 + GACHA_SHAKE_MS / 2);
    expect(attemptsOf('award-cell-3-1')).toBe('−7');
    expect(screen.getByTestId('award-cell-3-1').className).toContain('award-cell-gacha');

    // Final slow flip: '+7' (7 penalized fails before the Yes).
    await advanceMs(GACHA_SHAKE_MS / 2 + SLOW * 2 + 200);
    expect(verdictOf('award-cell-3-1')).toBe('accepted');
    expect(attemptsOf('award-cell-3-1')).toBe('+7');
  });
});

// ---------------------------------------------------------------------------
// Static last-solve flags (spec §4): fixed on the FINAL data, shown per cell
// only once revealed + accepted, never moving during the ceremony.
// ---------------------------------------------------------------------------

describe('static last-solve / contest-last flags during the ceremony', () => {
  function resultClassOf(testId: string): string {
    return screen.getByTestId(testId).querySelector('.problem-result')?.className ?? '';
  }

  it('keeps blue/purple fixed on the true cells and reveals them with the flip', async () => {
    // Final truth of the fixture: contest-last yes = team 3 B (Yes @47);
    // A's last solve = team 2 A (@20 > @10). The VISIBLE projection at boot
    // would call team 2 A the contest-last yes — it must NOT be purple.
    const store = await bootAwardStore();
    renderAward(store);

    expect(resultClassOf('award-cell-2-0')).toContain('last-solve'); // blue (A's true last)
    expect(resultClassOf('award-cell-2-0')).not.toContain('contest-last-solve');
    expect(resultClassOf('award-cell-1-0')).toContain('contest-first-solve'); // true first yes
    // The masked true contest-last cell shows nothing yet.
    expect(resultClassOf('award-cell-3-1')).toContain('pending');
    // Auto labels derived from the fixed flags: absent while hidden.
    expect(screen.queryByText('got last yes of this contest!')).toBeNull();
    expect(within(screen.getByTestId('award-row-2')).getByText('A last to solve!')).toBeTruthy();

    // Reveal team 3 B (7 fails + Yes): when the sequence completes, the
    // purple contest-last cell appears exactly there — and team 2 A stays blue.
    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal
    expect(resultClassOf('award-cell-3-1')).not.toContain('contest-last-solve'); // no early leak
    await finishSequence();

    expect(resultClassOf('award-cell-3-1')).toContain('contest-last-solve');
    expect(resultClassOf('award-cell-2-0')).not.toContain('contest-last-solve');
    const row3 = screen.getByTestId('award-row-3');
    expect(within(row3).getByText('got last yes of this contest!')).toBeTruthy();
    expect(within(row3).getByText('B last to solve!')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// StrictMode dev double-mount: no early verdict leak
// ---------------------------------------------------------------------------

describe('StrictMode reveal playback', () => {
  it('keeps the cell pending at flip start despite the double-invoked effect', async () => {
    const store = await bootAwardStore();
    render(
      <StrictMode>
        <AwardView store={store} awards={awardsFixture} />
      </StrictMode>,
    );

    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal — playback effect runs, cleans up, reruns

    // Without the cancelled-midpoint guard the superseded first run's pending
    // midpoint fires at the restart, showing run 1's verdict instantly.
    const verdict = screen
      .getByTestId('award-cell-3-1')
      .querySelector('.problem-result')
      ?.getAttribute('data-verdict');
    expect(verdict).toBe('pending');

    await finishSequence();
    expect(
      screen
        .getByTestId('award-cell-3-1')
        .querySelector('.problem-result')
        ?.getAttribute('data-verdict'),
    ).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// Gacha effect (non-finale: 8 net attempts on team 3's cell B)
// ---------------------------------------------------------------------------

describe('gacha effect', () => {
  it('shakes with sparkles before the final flip and returns exactly to rest', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal team 3 cell B — 8 net runs → gacha (final Yes)

    // Intermediate fast flips play first (7 fails), THEN the gacha shake.
    await advanceMs(7 * FAST * 2 + GACHA_SHAKE_MS / 2);
    const cell = screen.getByTestId('award-cell-3-1');
    expect(cell.className).toContain('award-cell-gacha');
    expect(cell.className).not.toContain('award-cell-finale'); // not the finale
    expect(screen.getByTestId('gacha-sparkle')).toBeTruthy();
    expect(screen.queryByTestId('finale-dim')).toBeNull();

    // After the final slow flip the shake and sparkles stop.
    await advanceMs(GACHA_SHAKE_MS / 2 + SLOW * 2 + 100);
    expect(screen.getByTestId('award-cell-3-1').className).not.toContain('award-cell-gacha');
    expect(screen.queryByTestId('gacha-sparkle')).toBeNull();
  });
});
