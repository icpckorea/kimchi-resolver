/**
 * Cell flip animation helper (spec §7).
 *
 * The flip is two standard-syntax CSS animations (`.flip-run` +
 * `data-flip-phase="out" | "in"`, see scoreboard.css): the cell rotates to
 * rotateX(90deg), the content is swapped at the midpoint (the `onMidpoint`
 * callback), then it rotates back in. Phase changes are driven by
 * `onAnimationEnd`, with a setTimeout fallback at 2× the flip duration so a
 * vanished element can never hang the sequence (the original spotboard kept a
 * jQuery Deferred pending forever and froze the whole board — that bug is
 * deliberately not ported).
 *
 * The award UI reuses this hook for reveal flips.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

export type CellFlipPhase = 'idle' | 'out' | 'in';

/** Props to spread on the animated element (ProblemCell accepts them as `flip`). */
export interface CellFlipProps {
  className: string;
  style: CSSProperties;
  onAnimationEnd: () => void;
  'data-flip-phase'?: 'out' | 'in';
}

export interface CellFlip {
  /** True while a flip is in progress. */
  flipping: boolean;
  phase: CellFlipPhase;
  props: CellFlipProps;
  /**
   * Start a flip. `onMidpoint` fires exactly once when the cell is edge-on
   * (swap the verdict there). Resolves when the flip completed — by animation
   * events, by the fallback timer, or by unmount. Never rejects, never hangs.
   */
  flip(onMidpoint?: () => void): Promise<void>;
  /** Settle any in-flight flip immediately (midpoint + resolve). */
  cancel(): void;
}

export function useCellFlip(flipSpeedMs: number): CellFlip {
  const [phase, setPhase] = useState<CellFlipPhase>('idle');
  const phaseRef = useRef<CellFlipPhase>('idle');
  const midpointRef = useRef<(() => void) | null>(null);
  const resolveRef = useRef<(() => void) | null>(null);
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPhaseBoth = useCallback((next: CellFlipPhase): void => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  /** Run the midpoint swap exactly once per flip. */
  const runMidpoint = useCallback((): void => {
    const callback = midpointRef.current;
    midpointRef.current = null;
    if (callback !== null) callback();
  }, []);

  /** Force-complete the current flip: midpoint (if pending) + resolve. */
  const finish = useCallback((): void => {
    if (fallbackRef.current !== null) {
      clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    }
    runMidpoint();
    const resolve = resolveRef.current;
    resolveRef.current = null;
    if (phaseRef.current !== 'idle') setPhaseBoth('idle');
    if (resolve !== null) resolve();
  }, [runMidpoint, setPhaseBoth]);

  const flip = useCallback(
    (onMidpoint?: () => void): Promise<void> => {
      finish(); // settle any in-flight flip before starting a new one
      return new Promise<void>((resolve) => {
        midpointRef.current = onMidpoint ?? null;
        resolveRef.current = resolve;
        setPhaseBoth('out');
        // Fallback: if the element vanished mid-animation no animationend
        // will ever arrive — force completion at 2× the duration.
        fallbackRef.current = setTimeout(finish, Math.max(1, flipSpeedMs) * 2);
      });
    },
    [finish, flipSpeedMs, setPhaseBoth],
  );

  const onAnimationEnd = useCallback((): void => {
    if (phaseRef.current === 'out') {
      runMidpoint();
      setPhaseBoth('in');
    } else if (phaseRef.current === 'in') {
      finish();
    }
  }, [finish, runMidpoint, setPhaseBoth]);

  // Unmount during a flip must not hang the award sequence: settle the
  // promise, but DROP the pending midpoint instead of firing it — a flip
  // torn down by unmount (or a StrictMode dev cleanup cycle) must not swap
  // the verdict in early. The restarted/next flip re-runs its own midpoints.
  useEffect(
    () => () => {
      if (fallbackRef.current !== null) {
        clearTimeout(fallbackRef.current);
        fallbackRef.current = null;
      }
      midpointRef.current = null;
      const resolve = resolveRef.current;
      resolveRef.current = null;
      if (phaseRef.current !== 'idle') setPhaseBoth('idle');
      if (resolve !== null) resolve();
    },
    [setPhaseBoth],
  );

  const props: CellFlipProps =
    phase === 'idle'
      ? { className: '', style: {}, onAnimationEnd }
      : {
          className: 'flip-run',
          style: { '--flip-half': `${flipSpeedMs / 2}ms` } as CSSProperties,
          onAnimationEnd,
          'data-flip-phase': phase,
        };

  return { flipping: phase !== 'idle', phase, props, flip, cancel: finish };
}
