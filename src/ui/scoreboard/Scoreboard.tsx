/**
 * The scoreboard (spec §7): renders snapshot.standings in ICPC order with
 * framer-motion layout reordering, search filtering (case-insensitive
 * substring over team name + group), pagination slices and the followed-team
 * highlight + sticky pinning.
 *
 * Every prop is optional: anything omitted falls back to the app store
 * (snapshot, contest problems, config, orgs, `q=` / `t=` URL params). Tests
 * and the award/publish screens can drive it fully via props.
 */
import { useEffect, useMemo, useState } from 'react';

import type { OrgsIndex, Problem, Snapshot, TeamStanding } from '@core/types';
import type { ResolvedConfig } from '@core/config';
import { useAppStore } from '@store/appStore';

import { TeamRow, type ApacStarInfo } from './TeamRow';
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

export interface ScoreboardProps {
  /** Standings to render; defaults to the store snapshot. */
  snapshot?: Snapshot | null;
  /** Contest problems in display order; defaults to the store contest. */
  problems?: Problem[];
  config?: ResolvedConfig;
  orgs?: OrgsIndex;
  /** Live search text; defaults to the `q=` URL param in the store config. */
  searchQuery?: string | null;
  /** 0-based page (only used when config.pagination). Clamped. */
  page?: number;
  /** Followed team id; defaults to the `t=` URL param in the store config. */
  followTeamId?: string | null;
  /** team id → APAC star (App wires the core derivation; spec §13). */
  apacStars?: ReadonlyMap<string, ApacStarInfo> | null;
  /** team id → manual awards.json labels, already spoiler-gated. */
  manualLabels?: ReadonlyMap<string, readonly string[]> | null;
  className?: string;
}

export function Scoreboard(props: ScoreboardProps) {
  const storeSnapshot = useAppStore((state) => state.snapshot);
  const storeConfig = useAppStore((state) => state.config);
  const storeProblems = useAppStore((state) => state.contest?.problems);
  const storeOrgs = useAppStore((state) => state.orgs);
  const lastAppliedFlips = useAppStore((state) => state.lastAppliedFlips);

  const snapshot = props.snapshot !== undefined ? props.snapshot : storeSnapshot;
  const config = props.config ?? storeConfig;
  const problems = props.problems ?? storeProblems ?? [];
  const orgs = props.orgs ?? storeOrgs;
  const searchQuery = props.searchQuery !== undefined ? props.searchQuery : config.searchQuery;
  const followTeamId =
    props.followTeamId !== undefined ? props.followTeamId : config.followTeamId;
  const page = props.page ?? 0;

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

  const standings = snapshot?.standings;
  const filtered = useMemo(
    () => (standings === undefined ? [] : filterStandings(standings, searchQuery)),
    [standings, searchQuery],
  );

  // Live-fed runs flip their cells (spec §5 "애니메이션과 함께", §7 cell flip);
  // config.animation=false falls back to the instant swap.
  const flipCells = useMemo(() => {
    if (!config.animation || lastAppliedFlips === null) return null;
    const map = new Map<string, number>();
    for (const cell of lastAppliedFlips.cells) {
      map.set(`${cell.teamId} ${cell.problemId}`, lastAppliedFlips.flipId);
    }
    return map;
  }, [config.animation, lastAppliedFlips]);

  // Pagination is hidden on mobile (spec §14): the compact board lists all
  // filtered teams in one scroll.
  const paginate = config.pagination && !isMobile;
  const pageSize = paginate ? config.paginationSize : Number.POSITIVE_INFINITY;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize) || 1);
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = paginate
    ? filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    : filtered;

  if (snapshot === null || snapshot === undefined) {
    return <div className={cls('scoreboard', 'scoreboard--empty', props.className)} />;
  }

  const detailStanding =
    isMobile && detailTeamId !== null ? (snapshot.byTeam.get(detailTeamId) ?? null) : null;

  return (
    <div
      className={cls('scoreboard', isMobile && 'scoreboard--mobile', props.className)}
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
          apacStar={props.apacStars?.get(standing.team.id) ?? null}
          manualLabels={props.manualLabels?.get(standing.team.id) ?? []}
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
          manualLabels={props.manualLabels?.get(detailStanding.team.id) ?? []}
          onClose={() => setDetailTeamId(null)}
        />
      ) : null}
    </div>
  );
}
