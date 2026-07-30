/**
 * Team badge list: snapshot-derived auto labels (spec §4 table, exact English
 * texts) plus manual labels from awards.json v2 (`labels`). Both share the
 * same badge UI. Award-mode spoiler gating (manual labels hidden until
 * finalize) is the caller's responsibility — pass `manualLabels` only when
 * they may be shown.
 */
import type { AutoLabel } from '@core/types';

/** Exact badge text for an auto label (spec §4). */
export function autoLabelText(label: AutoLabel): string {
  switch (label.kind) {
    case 'triedNTimes':
      return `tried ${label.attempts} times to get Yes!`;
    case 'contestFirstYes':
      return 'got first yes of this contest!';
    case 'firstToSolve':
      return `${label.problemLabels.join(', ')} first to solve!`;
    case 'lastToSolve':
      return `${label.problemLabels.join(', ')} last to solve!`;
    case 'contestLastYes':
      return 'got last yes of this contest!';
  }
}

export interface BadgesProps {
  autoLabels: readonly AutoLabel[];
  /** Manual labels (awards.json `labels`), already gated by the caller. */
  manualLabels?: readonly string[];
}

export function Badges({ autoLabels, manualLabels = [] }: BadgesProps) {
  if (autoLabels.length === 0 && manualLabels.length === 0) return null;
  return (
    <span className="team-badges">
      {autoLabels.map((label) => {
        const text = autoLabelText(label);
        return (
          <span key={`auto:${text}`} className="team-badge team-badge--auto">
            {text}
          </span>
        );
      })}
      {manualLabels.map((text) => (
        <span key={`manual:${text}`} className="team-badge team-badge--manual">
          {text}
        </span>
      ))}
    </span>
  );
}
