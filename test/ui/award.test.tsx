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
  FINALE_HOLD_MS,
  GACHA_SHAKE_MS,
  accumulateDisplay,
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

describe('accumulateDisplay with pre-freeze offsets', () => {
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

  it('continues the true cumulative counters over pre-freeze attempts', () => {
    // Cell with 2 pre-freeze penalized fails + hidden [F, F, A]:
    // the frozen '?5' must continue '−3' → '−4' → '+4' with no jump.
    const runs = [fail(100), fail(101), yes(102)];
    const preFreeze = { attempts: 2, failedAttempts: 2 };
    expect(accumulateDisplay(runs, 0, preFreeze)).toMatchObject({
      verdict: 'failed',
      attempts: 3,
      failedAttempts: 3,
    });
    expect(accumulateDisplay(runs, 1, preFreeze)).toMatchObject({
      verdict: 'failed',
      attempts: 4,
      failedAttempts: 4,
    });
    expect(accumulateDisplay(runs, 2, preFreeze)).toMatchObject({
      verdict: 'accepted',
      attempts: 5,
      failedAttempts: 4,
      solvedMinute: 102,
    });
  });

  it('defaults to zero offsets', () => {
    expect(accumulateDisplay([yes(50)], 0)).toMatchObject({
      verdict: 'accepted',
      attempts: 1,
      failedAttempts: 0,
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

  it('applies finale classes during the last reveal and restores 5s after it', async () => {
    const store = await bootAwardStore(() => 0.99); // rng > ratio → no gacha fake-out
    renderAward(store);
    await driveToLastReveal(store);

    // Finale overlay + zoomed cell are on during the sequence, but the
    // rainbow is the finale VARIANT of the gacha effect (spec §7): the gacha
    // roll missed (gacha:false), so no rainbow may play.
    expect(screen.getByTestId('finale-dim')).toBeTruthy();
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();
    expect(screen.getByTestId('award-cell-2-1').className).toContain('award-cell-finale');

    // Single failed run → one slow flip (2× fallback in jsdom); the
    // spotlight/zoom then holds for FINALE_HOLD_MS before restoring.
    await advanceMs(SLOW * 2 + 50);
    expect(screen.getByTestId('finale-dim')).toBeTruthy();
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();

    await advanceMs(FINALE_HOLD_MS + 100);
    expect(screen.queryByTestId('finale-dim')).toBeNull();
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();
    expect(screen.getByTestId('award-cell-2-1').className).not.toContain('award-cell-finale');
  });

  it('combines gacha shake with the rainbow (no thin sparkle) on the finale cell', async () => {
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

    // After shake + final flip the shake stops (cell back at rest) and the
    // rainbow stops flowing with it ("진동이 멈출 때까지"); the spotlight/zoom
    // keeps holding.
    await advanceMs(GACHA_SHAKE_MS / 2 + SLOW * 2 + 100);
    expect(screen.getByTestId('award-cell-2-1').className).not.toContain('award-cell-gacha');
    expect(screen.queryByTestId('finale-rainbow')).toBeNull();
    expect(screen.getByTestId('finale-dim')).toBeTruthy();
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
// Pre-freeze attempts: reveal counters + gacha trigger (spec §6 net runs)
// ---------------------------------------------------------------------------

describe('reveal with pre-freeze attempts (r=5: 3 revealed fails on team 3 B)', () => {
  function verdictOf(testId: string): string | null | undefined {
    return screen.getByTestId(testId).querySelector('.problem-result')?.getAttribute('data-verdict');
  }
  function attemptsOf(testId: string): string {
    return screen.getByTestId(testId).querySelector('.problem-attempts')?.textContent ?? '';
  }

  it('continues the frozen counters and counts pre-freeze runs toward gacha', async () => {
    // r=5: runs 3..5 (3 fails on team 3 B) are revealed pre-freeze; runs
    // 6..10 (4 fails + Yes) stay hidden. Net attempts = 3 + 5 = 8 → the
    // gacha requirement (8) is met even though only 5 runs are queued.
    const store = await bootAwardStore(() => 0.99, '?award=true&r=5');
    renderAward(store);

    await pressKey('Enter'); // focus team 3
    // Frozen cell shows '?8' (3 pre-freeze + 5 masked).
    expect(attemptsOf('award-cell-3-1')).toBe('?8');

    await pressKey('Enter'); // reveal
    // Until the first flip midpoint the frozen display persists — no jump
    // down to the hidden-only count ('?5').
    expect(verdictOf('award-cell-3-1')).toBe('pending');
    expect(attemptsOf('award-cell-3-1')).toBe('?8');

    // First fast flip (fallback at 2×FAST): true cumulative '−4', not '−1'.
    await advanceMs(FAST * 2 + 50);
    expect(verdictOf('award-cell-3-1')).toBe('failed');
    expect(attemptsOf('award-cell-3-1')).toBe('−4');

    // Second fast flip → '−5'.
    await advanceMs(FAST * 2);
    expect(attemptsOf('award-cell-3-1')).toBe('−5');

    // After all 4 fast flips the gacha shake fires (8 net attempts ≥ 8,
    // final Yes → always) even though only 5 runs were queued post-freeze.
    await advanceMs(2 * FAST * 2 + GACHA_SHAKE_MS / 2);
    expect(attemptsOf('award-cell-3-1')).toBe('−7');
    expect(screen.getByTestId('award-cell-3-1').className).toContain('award-cell-gacha');

    // Final slow flip: '+7' (7 penalized fails before the Yes), no jump.
    await advanceMs(GACHA_SHAKE_MS / 2 + SLOW * 2 + 200);
    expect(verdictOf('award-cell-3-1')).toBe('accepted');
    expect(attemptsOf('award-cell-3-1')).toBe('+7');
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
