/**
 * Team badge list: snapshot-derived auto labels (spec §4 table, exact English
 * texts) plus manual labels from awards.json v2 (`labels`). Both share the
 * same badge UI. Award-mode spoiler gating (manual labels hidden until
 * finalize) is the caller's responsibility — pass `manualLabels` only when
 * they may be shown.
 *
 * Layout (spec §7 "칭호 배지 레이아웃"): badges never touch the team name.
 * The row gives them a dedicated fixed-width column (`.team-badge-col`), so
 * this component only has to decide what fits inside that column:
 *
 * - spectator / publish: at most `maxVisible` badges, the rest collapse into
 *   a `+N` chip (`.team-badge--overflow`).
 * - award mode (`carousel`): 2+ labels cycle bottom→top, one visible at a
 *   time, ~2.5s each, driven purely by CSS. `prefers-reduced-motion: reduce`
 *   falls back to the first badge, static.
 * - detail modal / anywhere else: no cap, badges wrap (modal CSS).
 */
import type { CSSProperties } from 'react';

import type { AutoLabel } from '@core/types';

import { useMediaQuery } from './useMediaQuery';

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

/**
 * Badges that fit the board's fixed badge column (`--kr-badge-col`) on one
 * line. Anything past this collapses into `+N` — the column width and this
 * cap are tuned together in scoreboard.css.
 */
export const BOARD_MAX_BADGES = 2;

/** Seconds one badge stays on screen in the award carousel (spec §7). */
export const CAROUSEL_STEP_SECONDS = 2.5;

/** Media query for the reduced-motion carousel fallback. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

interface BadgeItem {
  text: string;
  manual: boolean;
}

export interface BadgesProps {
  autoLabels: readonly AutoLabel[];
  /** Manual labels (awards.json `labels`), already gated by the caller. */
  manualLabels?: readonly string[];
  /**
   * Cap for the board's fixed-width slot; extras become a `+N` chip.
   * Omitted (default) shows every badge — the detail modal wraps them.
   */
  maxVisible?: number;
  /** Award mode: 2+ badges cycle in a vertical carousel instead of a row. */
  carousel?: boolean;
}

function badgeClass(item: BadgeItem): string {
  return `team-badge ${item.manual ? 'team-badge--manual' : 'team-badge--auto'}`;
}

function Badge({ item }: { item: BadgeItem }) {
  return (
    <span className={badgeClass(item)} title={item.text}>
      {item.text}
    </span>
  );
}

export function Badges({
  autoLabels,
  manualLabels = [],
  maxVisible,
  carousel = false,
}: BadgesProps) {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);

  const items: BadgeItem[] = [
    ...autoLabels.map((label) => ({ text: autoLabelText(label), manual: false })),
    ...manualLabels.map((text) => ({ text, manual: true })),
  ];
  if (items.length === 0) return null;

  // ---- award mode: vertical carousel, one badge visible at a time ----------
  if (carousel && items.length >= 2 && !reducedMotion) {
    const cycle = items.length * CAROUSEL_STEP_SECONDS;
    // The step count / cycle length depend on the badge count, so they are
    // handed to the pure-CSS animation as custom properties.
    const vars = {
      '--kr-badge-count': String(items.length),
      '--kr-badge-cycle': `${cycle}s`,
      '--kr-badge-steps': `steps(${items.length}, end)`,
    } as CSSProperties;
    return (
      <span
        className="team-badges team-badges--carousel"
        style={vars}
        data-carousel-count={items.length}
      >
        {/* Rise wrapper slides the window bottom→top once per step; the track
         * below jumps one badge per step. Together: a rolling carousel. */}
        <span className="team-badges__rise">
          <span className="team-badges__track">
            {items.map((item) => (
              <Badge key={`${item.manual ? 'm' : 'a'}:${item.text}`} item={item} />
            ))}
          </span>
        </span>
      </span>
    );
  }

  // Reduced motion (or a single label): the first badge, static.
  const shown = carousel ? items.slice(0, 1) : items.slice(0, maxVisible ?? items.length);
  const hidden = carousel ? 0 : items.length - shown.length;

  return (
    <span className="team-badges">
      {shown.map((item) => (
        <Badge key={`${item.manual ? 'm' : 'a'}:${item.text}`} item={item} />
      ))}
      {hidden > 0 ? (
        <span
          className="team-badge team-badge--overflow"
          title={items.slice(shown.length).map((item) => item.text).join('\n')}
        >
          {`+${hidden}`}
        </span>
      ) : null}
    </span>
  );
}
