/**
 * Store-free scoreboard (spec §7): renders snapshot.standings in ICPC order
 * with framer-motion layout reordering, search filtering (case-insensitive
 * substring over team name + group), pagination slices, the followed-team
 * highlight + sticky pinning, and per-row decoration (publish modes).
 *
 * Every input comes from props — this file (and everything it imports) must
 * never import `@store`, so the static public page can render it without the
 * app store, feed or ingest code. `Scoreboard` is the store wrapper.
 */
import { useEffect, useMemo, useState } from 'react';

import type { OrgsIndex, Problem, Snapshot, TeamStanding } from '@core/types';
import type { ResolvedConfig } from '@core/config';

import { TeamRow, type ApacStarInfo, type RowDecor } from './TeamRow';
import { TeamDetailModal } from './TeamDetailModal';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from './useMediaQuery';
import { cls } from './util';
import './scoreboard.css';

/** Case-insensitive substring filter over team name + group. */
export function filterStandings(
  standings: readonly TeamStanding[],
  query: string | null | undefined,
): TeamStanding[] {
  const needle = (query ?? '').trim().toLowerCase();
  if (needle === '') return [...standings];
  return standings.filter((standing) =>
    `${standing.team.name} ${standing.team.group}`.toLowerCase().includes(needle),
  );
}

export interface ScoreboardViewProps {
  snapshot: Snapshot;
  /** Contest problems in display order. */
  problems: Problem[];
  config: ResolvedConfig;
  orgs: OrgsIndex;
  /** team id → APAC star (spec §13). */
  apacStars?: ReadonlyMap<string, ApacStarInfo> | null;
  /** team id → manual awards.json labels, already spoiler-gated. */
  manualLabels?: ReadonlyMap<string, readonly string[]> | null;
  /** team id → row decoration (publish prepare / public page). */
  rowDecor?: ReadonlyMap<string, RowDecor> | null;
  /** "teamId problemId" → flip batch id for just-applied live runs. */
  flipCells?: ReadonlyMap<string, number> | null;
  /** Search text; null/omitted shows every team. */
  searchQuery?: string | null;
  /** 0-based page (only used when config.pagination). Clamped. */
  page?: number;
  followTeamId?: string | null;
  className?: string;
}

export function ScoreboardView({
  snapshot,
  problems,
  config,
  orgs,
  apacStars = null,
  manualLabels = null,
  rowDecor = null,
  flipCells = null,
  searchQuery = null,
  page = 0,
  followTeamId = null,
  className,
}: ScoreboardViewProps) {
  // Mobile compact layout (spec §14). Only spectator/publish render this
  // component — award mode draws its own rows and never goes compact.
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [detailTeamId, setDetailTeamId] = useState<string | null>(null);

  // Leaving the mobile breakpoint closes the modal for real (not just hides
  // it) — otherwise a stale detailTeamId would silently re-open the modal the
  // next time the viewport crosses back under 768px (e.g. tablet rotation).
  useEffect(() => {
    if (!isMobile) setDetailTeamId(null);
  }, [isMobile]);

  const standings = snapshot.standings;
  const filtered = useMemo(
    () => filterStandings(standings, searchQuery),
    [standings, searchQuery],
  );

  // One value on any row reserves the value column on every row, so the
  // columns stay aligned. Both flags also widen the board's width guard
  // (scoreboard.css) by the optional column.
  const { valueSlot, hasLeading } = useMemo(() => {
    let value = false;
    let leading = false;
    for (const decor of rowDecor?.values() ?? []) {
      if (decor.value !== undefined) value = true;
      if (decor.leading !== undefined && decor.leading !== null) leading = true;
    }
    return { valueSlot: value, hasLeading: leading };
  }, [rowDecor]);

  // Pagination is hidden on mobile (spec §14): the compact board lists all
  // filtered teams in one scroll.
  const paginate = config.pagination && !isMobile;
  const pageSize = paginate ? config.paginationSize : Number.POSITIVE_INFINITY;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize) || 1);
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = paginate
    ? filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    : filtered;

  const detailStanding =
    isMobile && detailTeamId !== null ? (snapshot.byTeam.get(detailTeamId) ?? null) : null;

  return (
    <div
      className={cls(
        'scoreboard',
        isMobile && 'scoreboard--mobile',
        valueSlot && 'scoreboard--has-value',
        hasLeading && 'scoreboard--has-leading',
        className,
      )}
      data-page={currentPage}
      data-page-count={pageCount}
    >
      {visible.map((standing, index) => (
        <TeamRow
          key={standing.team.id}
          standing={standing}
          problems={problems}
          config={config}
          orgs={orgs}
          followed={followTeamId !== null && standing.team.id === followTeamId}
          apacStar={apacStars?.get(standing.team.id) ?? null}
          manualLabels={manualLabels?.get(standing.team.id) ?? []}
          decor={rowDecor?.get(standing.team.id)}
          valueSlot={valueSlot}
          flipCells={flipCells}
          spineFirst={index === 0 || visible[index - 1].solved !== standing.solved}
          spineLast={
            index === visible.length - 1 || visible[index + 1].solved !== standing.solved
          }
          mobile={isMobile}
          onOpenDetail={isMobile ? setDetailTeamId : undefined}
        />
      ))}

      {detailStanding !== null ? (
        <TeamDetailModal
          standing={detailStanding}
          problems={problems}
          config={config}
          manualLabels={manualLabels?.get(detailStanding.team.id) ?? []}
          onClose={() => setDetailTeamId(null)}
        />
      ) : null}
    </div>
  );
}
