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
import { useMemo } from 'react';

import type { OrgsIndex, Problem, Snapshot, TeamStanding } from '@core/types';
import type { ResolvedConfig } from '@core/config';
import { useAppStore } from '@store/appStore';

import { TeamRow, type ApacStarInfo } from './TeamRow';
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

  const snapshot = props.snapshot !== undefined ? props.snapshot : storeSnapshot;
  const config = props.config ?? storeConfig;
  const problems = props.problems ?? storeProblems ?? [];
  const orgs = props.orgs ?? storeOrgs;
  const searchQuery = props.searchQuery !== undefined ? props.searchQuery : config.searchQuery;
  const followTeamId =
    props.followTeamId !== undefined ? props.followTeamId : config.followTeamId;
  const page = props.page ?? 0;

  const standings = snapshot?.standings;
  const filtered = useMemo(
    () => (standings === undefined ? [] : filterStandings(standings, searchQuery)),
    [standings, searchQuery],
  );

  const pageSize = config.pagination ? config.paginationSize : Number.POSITIVE_INFINITY;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize) || 1);
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = config.pagination
    ? filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    : filtered;

  if (snapshot === null || snapshot === undefined) {
    return <div className={cls('scoreboard', 'scoreboard--empty', props.className)} />;
  }

  return (
    <div
      className={cls('scoreboard', props.className)}
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
          spineFirst={index === 0 || visible[index - 1].solved !== standing.solved}
          spineLast={
            index === visible.length - 1 || visible[index + 1].solved !== standing.solved
          }
        />
      ))}
    </div>
  );
}
