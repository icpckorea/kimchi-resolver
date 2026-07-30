/**
 * One (team × problem) cell (spec §7).
 *
 * Color priority for accepted cells:
 *   contest-last-solve (purple) > last-solve (blue) >
 *   solved-first (light green, only when showFirstSolve) > solved (green).
 * The contest-first-solve cell additionally carries a subtle looping sparkle
 * shimmer overlay (CSS).
 *
 * The problem letter and the attempt counts are real DOM text (accessibility
 * and copy — the original used CSS `content`, deliberately not ported).
 * Attempts text: `+N` solved after N penalized failures, `−N` failed N times,
 * `?N` pending with N net runs.
 */
import type { CellState, Problem } from '@core/types';
import type { CellFlipProps } from './useCellFlip';
import { cls } from './util';

/** U+2212 minus sign — real text, matches the spec's `−N`. */
const MINUS = '−';

/**
 * State classes for a cell, highest-priority color only (plus the sparkle
 * overlay class, which stacks on top of any color).
 */
export function cellStateClass(cell: CellState, showFirstSolve: boolean): string {
  if (cell.verdict === null) return 'untouched';
  if (cell.verdict === 'pending') return 'pending';
  if (cell.verdict === 'failed') return 'failed';
  // accepted
  const sparkle = cell.isContestFirstSolve ? ' contest-first-solve' : '';
  if (cell.isContestLastSolve) return `solved contest-last-solve${sparkle}`;
  if (cell.isLastSolve) return `solved last-solve${sparkle}`;
  if (showFirstSolve && cell.isFirstSolve) return `solved solved-first${sparkle}`;
  return `solved${sparkle}`;
}

/** `+N` / `−N` / `?N` attempt text, or null when there is nothing to show. */
export function cellAttemptsText(cell: CellState): string | null {
  switch (cell.verdict) {
    case 'accepted':
      return cell.failedAttempts > 0 ? `+${cell.failedAttempts}` : null;
    case 'failed':
      return cell.failedAttempts > 0 ? `${MINUS}${cell.failedAttempts}` : null;
    case 'pending':
      return `?${cell.attempts}`;
    default:
      return null;
  }
}

export interface ProblemCellProps {
  problem: Problem;
  cell: CellState;
  showFirstSolve: boolean;
  /** Spread of useCellFlip(...).props — wires the flip animation. */
  flip?: CellFlipProps;
}

export function ProblemCell({ problem, cell, showFirstSolve, flip }: ProblemCellProps) {
  const attempts = cellAttemptsText(cell);
  const title =
    cell.verdict === 'accepted' && cell.solvedMinute !== null
      ? `${problem.title} — solved at ${cell.solvedMinute} min.${
          cell.isFirstSolve ? ' (First Solve)' : ''
        }`
      : problem.title;
  return (
    <div
      className={cls('problem-result', cellStateClass(cell, showFirstSolve), flip?.className)}
      style={flip?.style}
      onAnimationEnd={flip?.onAnimationEnd}
      data-flip-phase={flip?.['data-flip-phase']}
      data-problem-id={problem.id}
      data-verdict={cell.verdict ?? 'none'}
      title={title}
    >
      <span className="problem-label">{problem.label}</span>
      {attempts !== null ? <span className="problem-attempts">{attempts}</span> : null}
    </div>
  );
}
