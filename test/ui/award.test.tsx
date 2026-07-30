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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppStore, type AppStore } from '@store/appStore';
import { AwardView } from '@ui/award/AwardView';
import { Badges } from '@ui/scoreboard/Badges';
import { humanizeRank, parseAwardsJson, type AwardEntry } from '@ui/award/awardsData';
import {
  BUSY_HARD_TIMEOUT_MS,
  FINALE_HOLD_MS,
  FINALE_PREHEAT_MS,
  FINALE_ZOOM_MS,
  EASE_MIN_FLIP_MS,
  GACHA_SHAKE_MS,
  accumulateDisplay,
  easedFlipSchedule,
  finaleFlipMs,
  flipMsAt,
  matchAnimationSpeed,
  moveUpDurationSec,
  revealFlipDurations,
  type RevealStep,
} from '@ui/award/revealDriver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAST = 100;
const SLOW = 400;
/** Finale slowdown factors used by the fixture config (spec §7 defaults). */
const FINALE_SLOWDOWN = 3;
const FINALE_MID_SLOWDOWN = 2;

/** Worst-case duration of team 3's reveal (7 fast fails + gacha + slow Yes). */
const T3_SEQUENCE_MS = 7 * FAST * 2 + GACHA_SHAKE_MS + SLOW * 2;

const configJson = {
  source: { type: 'spotboard', apiBase: './sample/' },
  award: {
    // Deterministic ceremony for tests: no blink step, gacha at 8 attempts.
    focusBlinking: null,
    gachaEffectRequirement: 8,
    gachaEffectForNoRatio: 30,
    finaleFlipSlowdown: FINALE_SLOWDOWN,
    finaleIntermediateFlipSlowdown: FINALE_MID_SLOWDOWN,
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
// Team 2's two hidden runs on B are the LAST reveal → finale (2 runs, so the
// finale plays one INTERMEDIATE flip before the verdict flip).
function makeRunsJson(team2FinalVerdict: 'Yes' | 'No - Wrong Answer') {
  return {
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
      { id: 12, team: 2, problem: 1, result: team2FinalVerdict, submissionTime: 61 },
    ],
  };
}

const runsJson = makeRunsJson('No - Wrong Answer');

/** Per-test runs payload (the confetti case needs a Yes finale verdict). */
let runsOverride: ReturnType<typeof makeRunsJson> | null = null;

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

/**
 * Per-test awards.json payload. The STORE loads it during boot (the machine
 * takes the entry ids at construction, spec §6), so a test that needs a
 * different set of medalists sets this BEFORE bootAwardStore(). null → the
 * default two-entry fixture; [] → nobody has an entry.
 */
let awardsOverride: AwardEntry[] | null = null;

const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes('config.json')) return jsonResponse(configJson);
  if (url.includes('contest.json')) return jsonResponse(contestJson);
  if (url.includes('runs.json')) return jsonResponse(runsOverride ?? runsJson);
  if (url.includes('awards')) return jsonResponse(awardsOverride ?? awardsFixture);
  return new Response('not found', { status: 404, statusText: 'Not Found' });
};

const noopScheduler = { setInterval: () => 0, clearInterval: () => {} };

async function bootAwardStore(
  rng: () => number = () => 0.99,
  search = '?award=true&r=2',
  fetcher: typeof fetch = fetchImpl,
): Promise<AppStore> {
  const store = createAppStore({ fetchImpl: fetcher, scheduler: noopScheduler, rng });
  await store.getState().boot(search);
  expect(store.getState().status).toBe('ready');
  expect(store.getState().mode).toBe('award');
  return store;
}

function renderAward(store: AppStore) {
  return render(<AwardView store={store} />);
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
  runsOverride = null;
  awardsOverride = null;
  vi.unstubAllGlobals();
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

describe('finale flip durations (config-driven, spec §7)', () => {
  const speed = { minSolved: 0, fastFlip: 300, slowFlip: 700, moveUpMsPerRow: 100 };
  const slowdowns = { flip: 3, intermediateFlip: 2 };
  const stepOf = (finale: boolean, runs = 2) =>
    ({ effect: { gacha: true, finale }, runs: new Array(runs).fill(null) }) as unknown as RevealStep;

  it('scales the matched slowFlip by the configured factors', () => {
    expect(finaleFlipMs(700, 3)).toBe(2100);
    expect(finaleFlipMs(800, 2)).toBe(1600);
    // Fractional factors round to whole milliseconds; never zero.
    expect(finaleFlipMs(700, 1.5)).toBe(1050);
    expect(finaleFlipMs(1, 0.1)).toBe(1);
  });

  it('applies the slowdowns ONLY to the finale reveal', () => {
    // Normal reveal: the matched band verbatim.
    expect(revealFlipDurations(stepOf(false), speed, slowdowns)).toEqual({
      fast: 300,
      slow: 700,
      intermediates: [300],
    });
    // Finale: intermediate flips are slowFlip × 2, the verdict flip × 3 —
    // both derived from slowFlip, so fastFlip never leaks into the finale.
    expect(revealFlipDurations(stepOf(true), speed, slowdowns)).toEqual({
      fast: 1400,
      slow: 2100,
      intermediates: [1400],
    });
  });

  it('honours custom config factors', () => {
    expect(revealFlipDurations(stepOf(true), speed, { flip: 5, intermediateFlip: 1 })).toEqual({
      fast: 700,
      slow: 3500,
      intermediates: [700],
    });
  });

  it('paces a long FINALE history on the curve too, off the finale base', () => {
    // 10 runs → 9 intermediate flips, all derived from slowFlip × 2 = 1400.
    const durations = revealFlipDurations(stepOf(true, 10), speed, slowdowns);
    const eased = durations.intermediates;
    expect(eased).toHaveLength(9);
    expect(eased[0]).toBe(1400);
    expect(eased[8]).toBe(1400);
    expect(Math.min(...eased)).toBeLessThan(1400 * 0.6);
    // The verdict flip is never eased.
    expect(durations.slow).toBe(2100);
  });
});

describe('reveal pacing curve (spec §6, ease-in-out over a long history)', () => {
  const BASE = 300;
  const SLOW = 700;
  const total = (runs: number): number =>
    easedFlipSchedule(runs - 1, BASE).reduce((sum, ms) => sum + ms, 0) + SLOW;
  const constantTotal = (runs: number): number => (runs - 1) * BASE + SLOW;

  it('leaves short cells (1-3 runs) exactly as they were', () => {
    expect(easedFlipSchedule(0, BASE)).toEqual([]);
    expect(easedFlipSchedule(1, BASE)).toEqual([BASE]);
    expect(easedFlipSchedule(2, BASE)).toEqual([BASE, BASE]);
    for (const runs of [1, 2, 3]) expect(total(runs)).toBe(constantTotal(runs));
  });

  it('accelerates then decelerates (monotone down, then monotone up)', () => {
    const eased = easedFlipSchedule(49, BASE);
    expect(eased).toHaveLength(49);
    const fastest = Math.min(...eased);
    const trough = eased.indexOf(fastest);
    // Down to the trough…
    for (let i = 1; i <= trough; i++) expect(eased[i]).toBeLessThanOrEqual(eased[i - 1]);
    // …then back up, never dipping again.
    for (let i = eased.lastIndexOf(fastest) + 1; i < eased.length; i++) {
      expect(eased[i]).toBeGreaterThanOrEqual(eased[i - 1]);
    }
    // The ramps are real: the first/last few start and end at the band speed,
    // the middle runs far faster.
    expect(eased[0]).toBe(BASE);
    expect(eased[eased.length - 1]).toBe(BASE);
    expect(eased[1]).toBeLessThan(BASE);
    expect(fastest).toBeLessThan(BASE / 2);
    // Symmetric curve.
    expect(eased).toEqual([...eased].reverse());
  });

  it('keeps the worst real cell (CAPS/G, 50 attempts) in the 6-8s band', () => {
    expect(constantTotal(50)).toBe(15_400); // the unskippable 15.4s being fixed
    expect(total(50)).toBeGreaterThanOrEqual(6000);
    expect(total(50)).toBeLessThanOrEqual(8000);
    // …and 8 attempts stay around 2s.
    expect(total(8)).toBeGreaterThan(1800);
    expect(total(8)).toBeLessThan(2600);
  });

  it('grows with the attempt count, but sub-linearly and always under constant speed', () => {
    const counts = [4, 6, 8, 12, 20, 30, 50];
    for (const runs of counts) expect(total(runs)).toBeLessThan(constantTotal(runs));
    for (let i = 1; i < counts.length; i++) {
      expect(total(counts[i])).toBeGreaterThan(total(counts[i - 1]));
    }
    // Sub-linear: 50 attempts cost well under 6× the 8-attempt playback…
    expect(total(50)).toBeLessThan(total(8) * 4);
    // …while constant speed would cost more than 5×.
    expect(constantTotal(50)).toBeGreaterThan(constantTotal(8) * 5);
  });

  it('never produces an imperceptible flip on a very fast speed band', () => {
    const eased = easedFlipSchedule(49, 60);
    expect(Math.min(...eased)).toBeGreaterThanOrEqual(Math.min(EASE_MIN_FLIP_MS, 60));
    // A band already below the floor is left alone rather than stretched.
    expect(Math.max(...easedFlipSchedule(49, 20))).toBeLessThanOrEqual(20);
  });

  it('flipMsAt returns the eased duration per flip and slowFlip for the verdict', () => {
    const durations = {
      fast: BASE,
      slow: SLOW,
      intermediates: easedFlipSchedule(7, BASE),
    };
    for (let i = 0; i < 7; i++) expect(flipMsAt(durations, i, 8)).toBe(durations.intermediates[i]);
    expect(flipMsAt(durations, 7, 8)).toBe(SLOW);
    // Single-run cell: the one flip is the verdict flip.
    expect(flipMsAt({ ...durations, intermediates: [] }, 0, 1)).toBe(SLOW);
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

  it('lets an advance key close a visible slide, consuming that press', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    await pressKey('PageDown'); // focus team 3
    await pressKey('PageDown'); // reveal team 3 cell B
    await finishSequence();
    await pressKey('PageDown'); // finalize team 3 → slide
    expect(screen.getByTestId('award-slide')).toBeTruthy();

    // Projector remotes have no Escape (spec §6): the advance key closes the
    // slide and is CONSUMED — team 2 must not be focused by this press.
    await pressKey('PageDown');
    expect(screen.queryByTestId('award-slide')).toBeNull();
    expect(store.getState().awardMachine?.currentSlideTeamId).toBeNull();
    expect(stageOf(store, '2')).toBe('hidden'); // two-step guard: no skipped reveal

    // The NEXT press proceeds normally.
    await pressKey('PageDown');
    expect(stageOf(store, '2')).toBe('focused');
  });

  it('closes a re-shown medalist slide with an advance key without advancing', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    await pressKey('PageDown'); // focus team 3
    await pressKey('PageDown'); // reveal
    await finishSequence();
    await pressKey('PageDown'); // finalize team 3 → slide
    await pressKey('PageDown'); // close it
    await act(async () => {
      fireEvent.click(screen.getByText('Gamma Team')); // re-show the slide
    });
    expect(screen.getByTestId('award-slide')).toBeTruthy();

    // The re-shown slide lives only in the UI, but the rule is the same.
    await pressKey('Enter');
    expect(screen.queryByTestId('award-slide')).toBeNull();
    expect(stageOf(store, '2')).toBe('hidden');

    await pressKey('Enter');
    expect(stageOf(store, '2')).toBe('focused');
  });

  it('drives the whole ceremony with PageDown alone (no Escape needed)', async () => {
    const store = await bootAwardStore();
    renderAward(store);

    // Bounded loop: every press either steps the machine or closes a slide.
    for (let i = 0; i < 40 && store.getState().awardMachine?.finished !== true; i++) {
      await pressKey('PageDown');
      await finishSequence();
      // The finale runs its longer 6-step sequence and keeps the spotlight for
      // FINALE_HOLD_MS; drain generously so the board is at rest between
      // presses regardless of the finale timing constants.
      await advanceMs(FINALE_HOLD_MS * 3);
    }

    expect(store.getState().awardMachine?.finished).toBe(true);
    expect(stageOf(store, '1')).toBe('finalized');
    expect(stageOf(store, '2')).toBe('finalized');
    expect(stageOf(store, '3')).toBe('finalized');

    // Team 1 has no awards.json entry → its slide auto-dismisses; two more
    // presses (dismiss team 2's slide is already done above) reach 'end'.
    await pressKey('PageDown');
    await pressKey('PageDown');
    expect(store.getState().awardMachine?.currentSlideTeamId).toBeNull();
    expect(screen.queryByTestId('award-slide')).toBeNull();
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
// Badge column / award carousel (spec §7)
// ---------------------------------------------------------------------------

describe('award badge carousel', () => {
  const scoreboardCss = readFileSync(
    resolve(__dirname, '../../src/ui/scoreboard/scoreboard.css'),
    'utf8',
  );

  /** Finalize team 3 (bronze, 'Bronze!' label) and dismiss its slide. */
  async function finalizeTeam3(): Promise<HTMLElement> {
    await pressKey('Enter'); // focus 3
    await pressKey('Enter'); // reveal
    await finishSequence();
    await pressKey('Enter'); // finalize → slide
    await pressKey('Escape');
    return screen.getByTestId('award-row-3');
  }

  it('cycles 2+ labels one at a time in a vertical carousel', async () => {
    const store = await bootAwardStore();
    renderAward(store);
    const row = await finalizeTeam3();

    // Badges sit in their own column, never inside the name block.
    const col = row.querySelector('.team-badge-col') as HTMLElement;
    expect(col).not.toBeNull();
    expect((row.querySelector('.team-title') as HTMLElement).querySelector('.team-badges'))
      .toBeNull();

    const carousel = col.querySelector('.team-badges--carousel') as HTMLElement;
    expect(carousel).not.toBeNull();

    const badges = Array.from(carousel.querySelectorAll('.team-badge'));
    const count = badges.length;
    expect(count).toBeGreaterThanOrEqual(2);
    // Auto labels plus the manual one revealed at finalize.
    expect(badges.map((el) => el.textContent)).toContain('Bronze!');

    // One track holding every badge, stepped one badge per ~2.5s by CSS.
    const track = carousel.querySelector('.team-badges__track') as HTMLElement;
    expect(track).not.toBeNull();
    expect(track.children).toHaveLength(count);
    expect(carousel.dataset.carouselCount).toBe(String(count));
    expect(carousel.style.getPropertyValue('--kr-badge-count')).toBe(String(count));
    expect(carousel.style.getPropertyValue('--kr-badge-cycle')).toBe(`${count * 2.5}s`);
    expect(carousel.style.getPropertyValue('--kr-badge-steps')).toBe(`steps(${count}, end)`);

    // "One at a time" is enforced by the CSS window: the viewport is exactly
    // one badge line tall and clips the rest (jsdom runs no animations).
    expect(scoreboardCss).toMatch(
      /\.team-badges--carousel\s*\{[^}]*height:\s*var\(--kr-badge-line[^}]*overflow:\s*hidden/,
    );
    expect(scoreboardCss).toContain('@keyframes kr-badge-cycle');
  });

  it('keeps a single label static — no carousel', () => {
    const { container } = render(
      <Badges autoLabels={[{ kind: 'contestFirstYes' }]} carousel />,
    );
    expect(container.querySelector('.team-badges--carousel')).toBeNull();
    expect(container.querySelectorAll('.team-badge')).toHaveLength(1);
  });

  it('falls back to the first badge when the viewer prefers reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: /prefers-reduced-motion/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));

    const store = await bootAwardStore();
    renderAward(store);
    const row = await finalizeTeam3();
    const col = row.querySelector('.team-badge-col') as HTMLElement;

    expect(col.querySelector('.team-badges--carousel')).toBeNull();
    expect(col.querySelectorAll('.team-badge')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Reveal pacing in the real playback
// ---------------------------------------------------------------------------

describe('eased reveal pacing during playback (spec §6)', () => {
  /** Team 3's B cell replays 8 runs → 7 intermediate flips on the curve. */
  const EASED = easedFlipSchedule(7, FAST);

  function flipEl(): HTMLElement {
    const el = screen.getByTestId('award-cell-3-1').querySelector<HTMLElement>('.problem-result');
    expect(el).not.toBeNull();
    return el!;
  }

  /** The flip duration the cell is actually animating with, in ms. */
  function flipMsOf(el: HTMLElement): number {
    const half = el.style.getPropertyValue('--flip-half');
    expect(half).toMatch(/ms$/);
    return Number(half.slice(0, -2)) * 2;
  }

  it('gives every intermediate flip its own duration, verdict flip untouched', async () => {
    const store = await bootAwardStore();
    renderAward(store);
    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal team 3's B cell (8 runs)

    const played: number[] = [];
    for (let i = 0; i < 7; i++) {
      const el = flipEl();
      expect(el.className).toContain('flip-run');
      played.push(flipMsOf(el));
      // jsdom fires no animation events: each flip ends on the 2× fallback,
      // which stays bound to the band duration (never the shorter eased one).
      await advanceMs(FAST * 2);
    }
    expect(played).toEqual([...EASED]);
    // Slow start, hard acceleration, slow finish.
    expect(played[0]).toBe(FAST);
    expect(played[6]).toBe(FAST);
    expect(Math.min(...played)).toBeLessThan(FAST / 2);

    // Gacha shake (8 attempts ≥ requirement, final Yes), then the verdict
    // flip at the plain slowFlip — the curve never touches it.
    await advanceMs(GACHA_SHAKE_MS);
    expect(flipMsOf(flipEl())).toBe(SLOW);
  });
});

// ---------------------------------------------------------------------------
// Finale effect
// ---------------------------------------------------------------------------

describe('finale 6-step sequence (spec §7)', () => {
  /** Verdict flip: slowFlip × finaleFlipSlowdown (400 × 3 = 1200). */
  const FINALE_FLIP = finaleFlipMs(SLOW, FINALE_SLOWDOWN);
  /** Intermediate flips: slowFlip × finaleIntermediateFlipSlowdown (800). */
  const FINALE_MID_FLIP = finaleFlipMs(SLOW, FINALE_MID_SLOWDOWN);
  /** jsdom completes flips via the 2× fallback timer. */
  const FINALE_FLIP_2X = FINALE_FLIP * 2;
  const FINALE_MID_FLIP_2X = FINALE_MID_FLIP * 2;

  function cellEl(): HTMLElement {
    return screen.getByTestId('award-cell-2-1');
  }

  function attemptsOfCell(): string {
    return cellEl().querySelector('.problem-attempts')?.textContent ?? '';
  }

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

  it('plays steps 1-6 in the fixed order and restores ~5s after the flip', async () => {
    // rng > ratio: the No roll would MISS, but the finale cell fires the
    // gacha 100% regardless of the verdict (spec §6), so the rainbow plays.
    const store = await bootAwardStore(() => 0.99);
    renderAward(store);
    await driveToLastReveal(store);

    // ---- Step 1: the cell blinks/sparkles. The board is still NORMAL — no
    // zoom, no dim, no shake, no flip yet.
    expect(cellEl().className).toContain('award-cell-preheat');
    expect(screen.getByTestId('gacha-sparkle')).toBeTruthy();
    expect(cellEl().className).not.toContain('award-cell-finale');
    expect(cellEl().className).not.toContain('award-cell-gacha');
    expect(screen.queryByTestId('finale-dim')).toBeNull();
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();
    expect(screen.getByTestId('award-row-2').className).not.toContain('award-row-finale');
    expect(finaleFlipEl().className).not.toContain('flip-run');

    // ---- Step 2: zoom toward the cell + spotlight/dim, rainbow flowing and
    // the shake started — all BEFORE the first flip.
    await advanceMs(FINALE_PREHEAT_MS + 50);
    expect(cellEl().className).toContain('award-cell-finale'); // zoom
    expect(cellEl().className).toContain('award-cell-gacha'); // shake
    expect(cellEl().className).not.toContain('award-cell-preheat');
    expect(screen.getByTestId('finale-dim')).toBeTruthy();
    expect(screen.getByTestId('finale-rainbow')).toBeTruthy();
    expect(screen.queryByTestId('gacha-sparkle')).toBeNull(); // rainbow instead
    expect(screen.getByTestId('award-row-2').className).toContain('award-row-finale');
    expect(finaleFlipEl().className).not.toContain('flip-run'); // still no flip

    // ---- Step 3: the INTERMEDIATE flip runs slowly (slowFlip ×
    // finaleIntermediateFlipSlowdown) while the cell keeps shaking.
    await advanceMs(FINALE_ZOOM_MS);
    const midFlip = finaleFlipEl();
    expect(midFlip.className).toContain('flip-run');
    expect(midFlip.style.getPropertyValue('--flip-half')).toBe(`${FINALE_MID_FLIP / 2}ms`);
    expect(cellEl().className).toContain('award-cell-gacha'); // shake persists
    expect(cellEl().contains(midFlip)).toBe(true); // flip nested in the wrapper
    expect(screen.getByTestId('finale-rainbow')).toBeTruthy();

    // ---- Step 4: the verdict flip is slower still (slowFlip ×
    // finaleFlipSlowdown), and the shake/rainbow keep going through it.
    await advanceMs(FINALE_MID_FLIP_2X + 50);
    expect(attemptsOfCell()).toBe('−1'); // the intermediate No is on screen
    const verdictFlip = finaleFlipEl();
    expect(verdictFlip.className).toContain('flip-run');
    expect(verdictFlip.style.getPropertyValue('--flip-half')).toBe(`${FINALE_FLIP / 2}ms`);
    expect(FINALE_FLIP).toBeGreaterThan(FINALE_MID_FLIP);

    // Well past the NORMAL slowFlip fallback (2×SLOW) it is still mid-flip,
    // shaking, with the dim/zoom up.
    await advanceMs(SLOW * 2 + 50);
    expect(finaleFlipEl().getAttribute('data-flip-phase')).toBe('out');
    expect(cellEl().className).toContain('award-cell-gacha');
    expect(screen.getByTestId('finale-dim')).toBeTruthy();

    // ---- Step 5: the flip completes → the shake stops and the cell returns
    // exactly to rest; the rainbow stops with it. The verdict is a No here,
    // so NO confetti. Zoom/spotlight hold on.
    await advanceMs(FINALE_FLIP_2X);
    expect(finaleFlipEl().className).not.toContain('flip-run');
    expect(cellEl().className).not.toContain('award-cell-gacha');
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();
    expect(screen.queryByTestId('finale-confetti')).toBeNull();
    expect(screen.getByTestId('finale-dim')).toBeTruthy();
    expect(cellEl().className).toContain('award-cell-finale');

    // ---- Step 6: ~5s later the zoom/spotlight/overlay end and everything
    // restores.
    await advanceMs(FINALE_HOLD_MS + 100);
    expect(screen.queryByTestId('finale-dim')).toBeNull();
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();
    expect(cellEl().className).not.toContain('award-cell-finale');
    expect(cellEl().className).not.toContain('award-cell-preheat');
    expect(screen.getByTestId('award-row-2').className).not.toContain('award-row-finale');
  });

  it('fires the confetti burst on a Yes verdict, and clears it on restore', async () => {
    runsOverride = makeRunsJson('Yes'); // team 2's finale cell ends in a Yes
    const store = await bootAwardStore(() => 0.99);
    renderAward(store);
    await driveToLastReveal(store);

    // Nothing yet: confetti belongs to step 5, after the verdict flip.
    await advanceMs(FINALE_PREHEAT_MS + FINALE_ZOOM_MS + FINALE_MID_FLIP_2X + 50);
    expect(screen.queryByTestId('finale-confetti')).toBeNull();
    await advanceMs(FINALE_FLIP); // still mid verdict flip
    expect(screen.queryByTestId('finale-confetti')).toBeNull();

    // Flip done → burst. Hand-rolled DOM particles, no new dependency.
    await advanceMs(FINALE_FLIP + 100);
    const confetti = screen.getByTestId('finale-confetti');
    expect(confetti.querySelectorAll('.award-confetti-piece').length).toBeGreaterThan(20);
    expect(cellEl().className).not.toContain('award-cell-gacha'); // shake stopped
    expect(screen.getByTestId('finale-dim')).toBeTruthy(); // spotlight holds

    // Step 6 clears the confetti with the rest of the finale.
    await advanceMs(FINALE_HOLD_MS + 100);
    expect(screen.queryByTestId('finale-confetti')).toBeNull();
    expect(screen.queryByTestId('finale-dim')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Entry-less finalize: no invisible slide latch (spec §6)
// ---------------------------------------------------------------------------

describe('finalize without an awards.json entry', () => {
  it('never raises a slide, so the next advance key works immediately', async () => {
    // Only team 2 has an award entry; team 3 (finalized first) has none.
    awardsOverride = [awardsFixture[1]];
    const store = await bootAwardStore();
    renderAward(store);

    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal team 3 B
    await finishSequence();
    await pressKey('Enter'); // finalize team 3 — no entry → NO slide
    expect(stageOf(store, '3')).toBe('finalized');
    expect(screen.queryByTestId('award-slide')).toBeNull();
    // No slide was ever raised — nothing to auto-dismiss, nothing latched.
    expect(store.getState().awardMachine?.currentSlideTeamId).toBeNull();

    // The very next advance key (presenter remote: no Escape!) must work.
    await pressKey('PageDown');
    expect(stageOf(store, '2')).toBe('focused');
  });

  it('loses no keypress when a remote repeats the key at the finalize boundary', async () => {
    // The regression this replaced: the machine raised a slide for every
    // team and an effect closed it a render later, so a second press landing
    // inside that window was consumed as a dismissal and did nothing.
    awardsOverride = [awardsFixture[1]];
    const store = await bootAwardStore();
    renderAward(store);

    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal team 3 B
    await finishSequence();

    // Key repeat: two presses back to back, no time for any effect between.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'PageDown' }); // finalize team 3
      fireEvent.keyDown(window, { key: 'PageDown' }); // focus team 2
    });
    expect(stageOf(store, '3')).toBe('finalized');
    expect(stageOf(store, '2')).toBe('focused'); // the repeat was NOT swallowed
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
        <AwardView store={store} />
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
// solved spine bands (spec §7): the colour band is CONTINUOUS across a
// same-solved group and only its first row shows the number — award mode too.
// ---------------------------------------------------------------------------

describe('solved spine bands in award mode', () => {
  // 5 teams: t1/t2/t3 solve A (1 solved, penalties 10/20/30) → a three-row
  // band; t4/t5 solve nothing → a two-row band. t5's B run stays hidden so
  // the ceremony still has something to reveal.
  const spineContest = {
    ...contestJson,
    teams: [1, 2, 3, 4, 5].map((id) => ({ id, name: `Team ${id}`, group: 'Univ One' })),
  };
  const spineRuns = {
    time: { contestTime: 18000, noMoreUpdate: true, timestamp: 0 },
    runs: [
      { id: 1, team: 1, problem: 0, result: 'Yes', submissionTime: 10 },
      { id: 2, team: 2, problem: 0, result: 'Yes', submissionTime: 20 },
      { id: 3, team: 3, problem: 0, result: 'Yes', submissionTime: 30 },
      { id: 4, team: 5, problem: 1, result: 'No - Wrong Answer', submissionTime: 40 },
    ],
  };
  const spineFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('config.json')) return jsonResponse(configJson);
    if (url.includes('contest.json')) return jsonResponse(spineContest);
    if (url.includes('runs.json')) return jsonResponse(spineRuns);
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  };

  function spineClassOf(teamId: string): string {
    return screen.getByTestId(`award-row-${teamId}`).querySelector('.solved-count')!.className;
  }

  it('marks only the band edges: a middle row has neither spine class', async () => {
    const store = await bootAwardStore(() => 0.99, '?award=true&r=3', spineFetch);
    renderAward(store);

    expect(store.getState().snapshot?.standings.map((s) => s.team.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);

    // Band of 1-solved teams: first row opens it, last row closes it, and the
    // MIDDLE row carries neither class (band continues, number hidden).
    expect(spineClassOf('1')).toContain('spine-first');
    expect(spineClassOf('1')).not.toContain('spine-last');
    expect(spineClassOf('2')).not.toContain('spine-first');
    expect(spineClassOf('2')).not.toContain('spine-last');
    expect(spineClassOf('3')).not.toContain('spine-first');
    expect(spineClassOf('3')).toContain('spine-last');

    // Next band (0 solved) starts its own group.
    expect(spineClassOf('4')).toContain('spine-first');
    expect(spineClassOf('4')).not.toContain('spine-last');
    expect(spineClassOf('5')).not.toContain('spine-first');
    expect(spineClassOf('5')).toContain('spine-last');
  });

  it('re-bands after a reveal moves a team into another group', async () => {
    // r=3 hides t5's B fail only, so nothing changes solved counts; use the
    // main fixture instead: revealing team 3's hidden Yes moves it from the
    // 0-solved band into the 1-solved band.
    const store = await bootAwardStore();
    renderAward(store);

    // Before: [t1(1), t2(1)] band + [t3(0)] alone (first AND last).
    expect(spineClassOf('3')).toContain('spine-first');
    expect(spineClassOf('3')).toContain('spine-last');
    expect(spineClassOf('2')).not.toContain('spine-first');
    expect(spineClassOf('2')).toContain('spine-last');

    await pressKey('Enter'); // focus team 3
    await pressKey('Enter'); // reveal its hidden Yes on B
    await finishSequence();

    // After: all three teams have 1 solved → one continuous band, t2 is the
    // middle row (team 3 sorts last on penalty).
    expect(spineClassOf('1')).toContain('spine-first');
    expect(spineClassOf('1')).not.toContain('spine-last');
    expect(spineClassOf('2')).not.toContain('spine-first');
    expect(spineClassOf('2')).not.toContain('spine-last');
    expect(spineClassOf('3')).not.toContain('spine-first');
    expect(spineClassOf('3')).toContain('spine-last');
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
