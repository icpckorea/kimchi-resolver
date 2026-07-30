/**
 * Reveal sequence controller (spec §6/§7).
 *
 * One {type:'reveal'} step from the award machine carries every net run of a
 * cell. The controller owns WHICH cell is animating and the busy latch; the
 * actual playback (fast flips for intermediate fails → optional gacha shake
 * → slow final flip; the finale's 6 steps for the last cell) is performed by
 * RevealingCell in AwardView using the scoreboard's useCellFlip hook, which
 * calls handleSequenceEnd() when done.
 *
 * Pacing (spec §6): the intermediate flips of one cell are NOT played at a
 * constant speed — revealFlipDurations() spreads them along an ease-in-out
 * curve (see EASE_* below) so a 50-attempt history builds up instead of
 * stalling. The verdict flip keeps the plain slowFlip rule.
 *
 * Busy latch (the original withDeferredLock equivalent): isBusy() is true
 * from play() until handleSequenceEnd(), with a hard wall-clock deadline so
 * a lost animation can never wedge the ceremony keyboard.
 *
 * Finale (spec §7, fixed 6-step order — see FinalePhase): the overlay/zoom
 * is restored FINALE_HOLD_MS after the reveal completes; `active` stays
 * non-null during the hold so the overlay classes persist, but the latch is
 * already released.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { AwardStepResult, Run, Verdict } from '@core/types';
import { DEFAULT_ANIMATION_SPEEDS, type AnimationSpeed } from '@core/config';

export type RevealStep = Extract<AwardStepResult, { type: 'reveal' }>;

/** Gacha shake duration before the final flip (non-finale cells). */
export const GACHA_SHAKE_MS = 1500;
/** Finale step 1: pre-heat blink/sparkle before the zoom (spec §7). */
export const FINALE_PREHEAT_MS = 1200;
/** Finale step 2: zoom/spotlight/rainbow/shake settle time before the flips. */
export const FINALE_ZOOM_MS = 1000;
/** Finale step 6: overlay/zoom restore delay after the reveal completes. */
export const FINALE_HOLD_MS = 5000;

/**
 * The finale sequence's ordered phases (spec §7):
 *  1 `preheat`   — the cell blinks/sparkles, board still normal;
 *  2 `spotlight` — zoom + dim + spotlight, rainbow flowing, shake started;
 *  3/4 `flip`    — slow intermediate flips, then the slower verdict flip;
 *  5 `settled`   — shake/rainbow stopped, confetti on a Yes;
 *  6 (phase ends when the driver clears `active` FINALE_HOLD_MS later).
 */
export type FinalePhase = 'preheat' | 'spotlight' | 'flip' | 'settled';

/** Finale flip slowdown factors (config: award.finale*Slowdown, spec §7). */
export interface FinaleSlowdowns {
  /** Final verdict flip: slowFlip × this. */
  flip: number;
  /** Intermediate finale flips: slowFlip × this. */
  intermediateFlip: number;
}

/** Schema defaults, so callers without config still play a proper finale. */
export const DEFAULT_FINALE_SLOWDOWNS: FinaleSlowdowns = { flip: 3, intermediateFlip: 2 };

/** A finale flip duration: the matched band's slowFlip × the config factor. */
export function finaleFlipMs(slowFlipMs: number, slowdown: number): number {
  return Math.max(1, Math.round(slowFlipMs * slowdown));
}

// --- ease-in-out pacing of long cell histories (spec §6) --------------------
//
// A masked cell replays its WHOLE net history on one keypress, and the worst
// real cell of the 2025 Seoul data (CAPS / problem G) has 50 attempts. At a
// constant fastFlip that is ~15s of unskippable flipping. Instead the
// intermediate flips are distributed along an ease-in-out curve: the first
// few run at the band duration, the middle accelerates hard, the last few
// decelerate back to the band duration, and the verdict flip then lands at
// slowFlip. The curve's DEPTH also grows with the history length, so the
// total grows sub-linearly (~7.0s for 50 attempts, ~2.3s for 8, and 2-3
// attempt cells are left exactly as they were).

/** Below this many intermediate flips the pacing is untouched (short cells feel identical). */
export const EASE_MIN_FLIPS = 3;
/** Flips spent easing in at the start and easing out at the end ("the first/last few"). */
export const EASE_RAMP_FLIPS = 4;
/** Asymptotic speed-up at the curve's centre, as a fraction of the band duration. */
export const EASE_MAX_SPEEDUP = 0.65;
/** Flips past EASE_MIN_FLIPS at which half of EASE_MAX_SPEEDUP is reached. */
export const EASE_DEPTH_HALF_FLIPS = 1;
/** Floor so a very fast speed band can never produce an imperceptible flip. */
export const EASE_MIN_FLIP_MS = 40;

/** Classic smoothstep — the ease-in-out shape of both ramps. */
function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

/**
 * Per-flip durations for the `count` intermediate flips of one cell, from
 * `baseMs` (the matched band's intermediate duration). Symmetric: index 0 and
 * index count-1 stay at baseMs, the middle is the fastest.
 */
export function easedFlipSchedule(count: number, baseMs: number): number[] {
  if (count <= 0) return [];
  if (count < EASE_MIN_FLIPS) return Array.from({ length: count }, () => Math.max(1, baseMs));
  const over = count - EASE_MIN_FLIPS + 1;
  const depth = EASE_MAX_SPEEDUP * (over / (over + EASE_DEPTH_HALF_FLIPS));
  // Short cells cannot afford the full ramp on both sides — shrink it to fit.
  const ramp = Math.min(EASE_RAMP_FLIPS, (count - 1) / 2);
  const floor = Math.min(EASE_MIN_FLIP_MS, baseMs);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const fromEnd = Math.min(i, count - 1 - i);
    const progress = ramp <= 0 ? 0 : Math.min(1, fromEnd / ramp);
    out.push(Math.max(floor, Math.round(baseMs * (1 - depth * smoothstep(progress)))));
  }
  return out;
}

/** Flip durations for one reveal: `fast` for intermediates, `slow` for the verdict. */
export interface FlipDurations {
  /** The band's intermediate duration, un-eased (curve baseline + fallback bound). */
  fast: number;
  /** The verdict flip — always the plain slowFlip rule (finale factor included). */
  slow: number;
  /** Eased duration of each intermediate flip, index 0 first. Length = runs − 1. */
  intermediates: readonly number[];
}

/**
 * Per-reveal flip durations (spec §6 pacing + §7 finale). A normal reveal
 * uses the matched band; the finale cell replaces BOTH with slowed-down
 * variants of slowFlip — intermediate flips included, so nothing about the
 * last cell of the ceremony goes by quickly. The intermediate flips are then
 * spread along the ease-in-out curve in either case; the verdict flip is
 * never touched by it.
 */
export function revealFlipDurations(
  step: RevealStep,
  speed: AnimationSpeed,
  slowdowns: FinaleSlowdowns,
): FlipDurations {
  const fast = step.effect.finale
    ? finaleFlipMs(speed.slowFlip, slowdowns.intermediateFlip)
    : speed.fastFlip;
  const slow = step.effect.finale
    ? finaleFlipMs(speed.slowFlip, slowdowns.flip)
    : speed.slowFlip;
  return { fast, slow, intermediates: easedFlipSchedule(step.runs.length - 1, fast) };
}

/**
 * Duration of flip `index` of a reveal replaying `totalRuns` runs: the eased
 * schedule for the intermediates, the untouched slow flip for the verdict.
 */
export function flipMsAt(durations: FlipDurations, index: number, totalRuns: number): number {
  if (index >= totalRuns - 1) return durations.slow;
  return durations.intermediates[index] ?? durations.fast;
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
  /** Flip durations for this reveal (finale slowdowns already applied). */
  flip: FlipDurations;
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

/**
 * Worst-case playback length: lead-in + flips at the 2× fallback duration.
 * Deliberately computed from the UN-eased band duration — useCellFlip's
 * fallback timer is still bound to it, so this stays an upper bound however
 * much the ease-in-out curve (spec §6) shortens the real playback.
 */
function estimateDurationMs(step: RevealStep, flip: FlipDurations): number {
  // Finale: pre-heat + zoom settle (spec §7 steps 1-2). Otherwise the gacha
  // shake, when it fires.
  const leadIn = step.effect.finale
    ? FINALE_PREHEAT_MS + FINALE_ZOOM_MS
    : step.effect.gacha
      ? GACHA_SHAKE_MS
      : 0;
  const flips = (step.runs.length - 1) * flip.fast + flip.slow;
  return leadIn + flips * 2;
}

export function useRevealDriver(
  animationSpeeds: readonly AnimationSpeed[],
  slowdowns: FinaleSlowdowns = DEFAULT_FINALE_SLOWDOWNS,
): RevealDriver {
  // Destructured to primitives so a fresh config object per render does not
  // rebuild the api (and with it every keyboard callback).
  const { flip: finaleFlipSlowdown, intermediateFlip: finaleIntermediateFlipSlowdown } = slowdowns;
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
      const flip = revealFlipDurations(step, speed, {
        flip: finaleFlipSlowdown,
        intermediateFlip: finaleIntermediateFlipSlowdown,
      });
      seqRef.current += 1;
      playingRef.current = true;
      busyDeadlineRef.current = Date.now() + estimateDurationMs(step, flip) + BUSY_HARD_TIMEOUT_MS;
      setActiveBoth({ step, speed, flip, seq: seqRef.current });
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
  }, [animationSpeeds, finaleFlipSlowdown, finaleIntermediateFlipSlowdown]);

  return { active, isBusy: api.isBusy, play: api.play, handleSequenceEnd: api.handleSequenceEnd };
}
