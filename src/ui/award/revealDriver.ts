/**
 * Reveal sequence controller (spec §6/§7).
 *
 * One {type:'reveal'} step from the award machine carries every net run of a
 * cell. The controller owns WHICH cell is animating and the busy latch; the
 * actual playback (fast flips for intermediate fails → optional gacha shake
 * → slow final flip) is performed by RevealingCell in AwardView using the
 * scoreboard's useCellFlip hook, which calls handleSequenceEnd() when done.
 *
 * Busy latch (the original withDeferredLock equivalent): isBusy() is true
 * from play() until handleSequenceEnd(), with a hard wall-clock deadline so
 * a lost animation can never wedge the ceremony keyboard.
 *
 * Finale: the overlay/zoom is restored FINALE_HOLD_MS after the reveal
 * completes; `active` stays non-null during the hold so the overlay classes
 * persist, but the latch is already released.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { AwardStepResult, Run, Verdict } from '@core/types';
import { DEFAULT_ANIMATION_SPEEDS, type AnimationSpeed } from '@core/config';

export type RevealStep = Extract<AwardStepResult, { type: 'reveal' }>;

/** Gacha shake duration before the final flip. */
export const GACHA_SHAKE_MS = 1500;
/** Finale overlay/zoom restore delay after the reveal completes (spec §7). */
export const FINALE_HOLD_MS = 5000;
/** Finale final-flip slowdown vs the matched slowFlip (spec §7: 4~5×). */
export const FINALE_FLIP_MULTIPLIER = 4.5;
/** Finale final-flip floor (spec §7: 약 3초 이상). */
export const FINALE_FLIP_MIN_MS = 3000;

/**
 * The VERY slow finale flip duration (spec §7): 4~5× the matched slowFlip,
 * never under 3s — the last cell of the whole ceremony deserves the drama.
 */
export function finaleSlowFlipMs(slowFlipMs: number): number {
  return Math.max(FINALE_FLIP_MIN_MS, Math.round(slowFlipMs * FINALE_FLIP_MULTIPLIER));
}
/** Safety margin added to the expected duration for the hard busy deadline. */
export const BUSY_HARD_TIMEOUT_MS = 4000;

/**
 * The satisfied entry with the LARGEST minSolved, regardless of configured
 * order (spec §6 — the original's "must be sorted descending" trap is
 * removed; the config schema additionally normalizes to descending order).
 * Falls back to the spec default table's catch-all row.
 */
export function matchAnimationSpeed(
  speeds: readonly AnimationSpeed[],
  solved: number,
): AnimationSpeed {
  let best: AnimationSpeed | null = null;
  for (const speed of speeds) {
    if (solved >= speed.minSolved && (best === null || speed.minSolved > best.minSolved)) {
      best = speed;
    }
  }
  return best ?? DEFAULT_ANIMATION_SPEEDS[DEFAULT_ANIMATION_SPEEDS.length - 1];
}

/**
 * Row layout-move duration derived from the matched speed band's
 * moveUpMsPerRow (spec §6/§7: per-row rank-move speed), clamped to a sane
 * range. rowsMoved <= 0 returns a small default (no layout move plays).
 */
export function moveUpDurationSec(rowsMoved: number, speed: AnimationSpeed): number {
  if (rowsMoved <= 0) return 0.3;
  return Math.min(3, Math.max(0.05, (rowsMoved * speed.moveUpMsPerRow) / 1000));
}

/** Display override while a cell is mid-sequence. */
export interface RevealDisplay {
  verdict: Verdict;
  attempts: number;
  failedAttempts: number;
  solvedMinute: number | null;
}

/**
 * Cumulative display state after runs[0..upto] have been shown.
 *
 * Full-cell reveal replay (spec §6): a masked cell's reveal step carries its
 * ENTIRE net history (pre-freeze fails included) in `runs`, so the counters
 * replay from zero — a cell frozen at '?8' counts '−1', '−2', … '+7'. The
 * `preFreeze` offset parameter remains for the frozen step contract, but the
 * machine now always emits zero offsets (the old partial-replay mechanism).
 */
export function accumulateDisplay(
  runs: readonly Run[],
  upto: number,
  preFreeze: { attempts: number; failedAttempts: number } = { attempts: 0, failedAttempts: 0 },
): RevealDisplay {
  let failed = preFreeze.failedAttempts;
  let solvedMinute: number | null = null;
  for (let i = 0; i <= upto; i++) {
    const run = runs[i];
    if (run.verdict === 'failed' && run.penaltyCounts) failed += 1;
    if (run.verdict === 'accepted') solvedMinute = run.minute;
  }
  return {
    verdict: runs[upto].verdict,
    attempts: preFreeze.attempts + upto + 1,
    failedAttempts: failed,
    solvedMinute,
  };
}

export interface ActiveReveal {
  step: RevealStep;
  speed: AnimationSpeed;
  /** Monotonic sequence number — remount key for RevealingCell. */
  seq: number;
}

export interface RevealDriver {
  /** Non-null while a sequence is playing or the finale hold is running. */
  active: ActiveReveal | null;
  /** True while a reveal sequence is playing (keyboard must be ignored). */
  isBusy(): boolean;
  /** Start a sequence for a reveal step. `solved` picks the speed row. */
  play(step: RevealStep, solved: number): void;
  /** Called by RevealingCell when its playback finished. */
  handleSequenceEnd(): void;
}

/** Worst-case playback length: gacha + flips at the 2× fallback duration. */
function estimateDurationMs(step: RevealStep, speed: AnimationSpeed): number {
  const finalFlip = step.effect.finale ? finaleSlowFlipMs(speed.slowFlip) : speed.slowFlip;
  const flips = (step.runs.length - 1) * speed.fastFlip + finalFlip;
  return (step.effect.gacha ? GACHA_SHAKE_MS : 0) + flips * 2;
}

export function useRevealDriver(animationSpeeds: readonly AnimationSpeed[]): RevealDriver {
  const [active, setActive] = useState<ActiveReveal | null>(null);
  const activeRef = useRef<ActiveReveal | null>(null);
  const playingRef = useRef(false);
  const busyDeadlineRef = useRef(0);
  const seqRef = useRef(0);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      playingRef.current = false;
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    },
    [],
  );

  const api = useMemo(() => {
    function clearHoldTimer(): void {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    }

    function setActiveBoth(next: ActiveReveal | null): void {
      activeRef.current = next;
      setActive(next);
    }

    function play(step: RevealStep, solved: number): void {
      if (step.runs.length === 0) return; // defensive; the machine never emits this
      clearHoldTimer();
      const speed = matchAnimationSpeed(animationSpeeds, solved);
      seqRef.current += 1;
      playingRef.current = true;
      busyDeadlineRef.current =
        Date.now() + estimateDurationMs(step, speed) + BUSY_HARD_TIMEOUT_MS;
      setActiveBoth({ step, speed, seq: seqRef.current });
    }

    function handleSequenceEnd(): void {
      playingRef.current = false;
      const current = activeRef.current;
      if (current === null) return;
      if (current.step.effect.finale) {
        // Keep the spotlight/zoom/rainbow for the hold, then restore.
        clearHoldTimer();
        const mySeq = current.seq;
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          if (activeRef.current !== null && activeRef.current.seq === mySeq) {
            setActiveBoth(null);
          }
        }, FINALE_HOLD_MS);
      } else {
        setActiveBoth(null);
      }
    }

    function isBusy(): boolean {
      return playingRef.current && Date.now() < busyDeadlineRef.current;
    }

    return { play, handleSequenceEnd, isBusy };
  }, [animationSpeeds]);

  return { active, isBusy: api.isBusy, play: api.play, handleSequenceEnd: api.handleSequenceEnd };
}
