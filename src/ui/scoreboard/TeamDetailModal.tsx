/**
 * Mobile team detail modal (spec §14). Opened by tapping a compact row on
 * viewports ≤ 768px; shows what the compact row hides:
 *
 * - the full problem cell grid (same color rules as the desktop board,
 *   including purple/blue/first-solve/sparkle — ProblemCell is reused as-is),
 * - every label badge (auto + manual),
 * - the per-problem penalty breakdown ("20 + 20 × 2 = 60") and the total.
 *
 * No balloons anywhere in the modal (spec §14). Accessible dialog: role,
 * aria-modal, Escape / backdrop tap / X button close, focus moves to the
 * close button on open, returns to the opener on close, and Tab cycles
 * inside the dialog.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { CellState, Problem, TeamStanding } from '@core/types';
import type { ResolvedConfig } from '@core/config';
import { PENALTY_PER_FAILURE } from '@core/standings';
import { FlagIcon } from '@ui/icons';

import { Badges } from './Badges';
import { ProblemCell } from './ProblemCell';
import { ordinalSuffix } from './util';

/** U+00D7 multiplication sign, U+2013 dash-free formula per the spec text. */
const TIMES = '×';

/** "20 + 20 × 2 = 60"-style formula for one solved cell (spec §14). */
export function penaltyFormula(cell: CellState): string {
  const minute = cell.solvedMinute ?? 0;
  if (cell.failedAttempts === 0) return `${minute}`;
  const total = minute + PENALTY_PER_FAILURE * cell.failedAttempts;
  return `${minute} + ${PENALTY_PER_FAILURE} ${TIMES} ${cell.failedAttempts} = ${total}`;
}

export interface TeamDetailModalProps {
  standing: TeamStanding;
  /** Contest problems in display order. */
  problems: Problem[];
  config: ResolvedConfig;
  /** Manual awards.json labels, already spoiler-gated by the caller. */
  manualLabels?: readonly string[];
  onClose: () => void;
}

export function TeamDetailModal({
  standing,
  problems,
  config,
  manualLabels = [],
  onClose,
}: TeamDetailModalProps) {
  const { team } = standing;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes (document-level: the dialog itself may not hold focus).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Move focus into the dialog on open and give it back to the opener (the
  // tapped row) on close — the dialog contract, and the compact rows are
  // keyboard-operable (role=button), so focus must not drop to <body>.
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Minimal focus trap: Tab wraps within the dialog's focusable elements.
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables === undefined || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const solvedCells = problems.flatMap((problem) => {
    const cell = standing.cells.get(problem.id);
    return cell !== undefined && cell.verdict === 'accepted' && cell.solvedMinute !== null
      ? [{ problem, cell }]
      : [];
  });

  return (
    <div className="team-detail-backdrop" data-testid="team-detail-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="team-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${team.name} — details`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        data-team-id={team.id}
      >
        <header className="team-detail-header">
          <span className="team-detail-rank">
            {standing.icpcRank}
            <span className="rank-suffix">{ordinalSuffix(standing.icpcRank)}</span>
          </span>
          {standing.domesticRank !== null ? (
            <span className="team-detail-rank team-detail-rank--domestic">
              {standing.domesticRank}
              <span className="rank-suffix">{ordinalSuffix(standing.domesticRank)}</span>
            </span>
          ) : null}
          <FlagIcon country={team.countryCode} size={20} className="team-detail-flag" />
          <div className="team-detail-names">
            <span className="team-detail-name">{team.name}</span>
            {config.showTeamGroup ? (
              <span className="team-detail-group">{team.group}</span>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="team-detail-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <Badges autoLabels={standing.autoLabels} manualLabels={manualLabels} />

        <div className="team-detail-grid">
          {problems.map((problem) => {
            const cell = standing.cells.get(problem.id);
            return cell !== undefined ? (
              <ProblemCell
                key={problem.id}
                problem={problem}
                cell={cell}
                showFirstSolve={config.showFirstSolve}
              />
            ) : null;
          })}
        </div>

        <section className="team-detail-penalty" aria-label="penalty detail">
          {solvedCells.map(({ problem, cell }) => (
            <div key={problem.id} className="penalty-line">
              <span className="penalty-problem">{problem.label}</span>
              <span className="penalty-formula">{penaltyFormula(cell)}</span>
            </div>
          ))}
          <div className="penalty-line penalty-line--total">
            <span className="penalty-problem">total</span>
            <span className="penalty-formula">{standing.penalty} min.</span>
          </div>
        </section>
      </div>
    </div>
  );
}
