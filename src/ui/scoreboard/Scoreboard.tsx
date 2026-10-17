/**
 * The app scoreboard: a store wrapper around the store-free `ScoreboardView`
 * (spec §7). It fills the props the caller leaves out from the app store
 * (snapshot, contest problems, config, orgs, `q=` / `t=` URL params) and adds
 * the live-feed cell flips.
 *
 * Every prop is optional. Tests and the award/publish screens can drive it
 * fully via props.
 */
import { useMemo, type ReactNode } from 'react';

import type { OrgsIndex, Problem, Snapshot } from '@core/types';
import type { ResolvedConfig } from '@core/config';
import { useAppStore } from '@store/appStore';

import type { ApacStarInfo, RowDecor } from './TeamRow';
import { ScoreboardView } from './ScoreboardView';
import { cls } from './util';
import './scoreboard.css';

export { filterStandings } from './ScoreboardView';

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
  /** team id → row decoration (publish prepare page). */
  rowDecor?: ReadonlyMap<string, RowDecor> | null;
  /** Header above the leading column of the rows (see ScoreboardView). */
  leadingHeader?: ReactNode;
  /** Badge carousel (see TeamRow); defaults to on for the live board only. */
  badgeCarousel?: boolean;
  className?: string;
}

export function Scoreboard(props: ScoreboardProps) {
  const storeSnapshot = useAppStore((state) => state.snapshot);
  const storeConfig = useAppStore((state) => state.config);
  const storeProblems = useAppStore((state) => state.contest?.problems);
  const storeOrgs = useAppStore((state) => state.orgs);
  const lastAppliedFlips = useAppStore((state) => state.lastAppliedFlips);
  const mode = useAppStore((state) => state.mode);

  const snapshot = props.snapshot !== undefined ? props.snapshot : storeSnapshot;
  const config = props.config ?? storeConfig;
  const problems = props.problems ?? storeProblems ?? [];
  const orgs = props.orgs ?? storeOrgs;
  const searchQuery = props.searchQuery !== undefined ? props.searchQuery : config.searchQuery;
  const followTeamId =
    props.followTeamId !== undefined ? props.followTeamId : config.followTeamId;

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

  if (snapshot === null || snapshot === undefined) {
    return <div className={cls('scoreboard', 'scoreboard--empty', props.className)} />;
  }

  return (
    <ScoreboardView
      snapshot={snapshot}
      problems={problems}
      config={config}
      orgs={orgs}
      apacStars={props.apacStars}
      manualLabels={props.manualLabels}
      rowDecor={props.rowDecor}
      leadingHeader={props.leadingHeader}
      flipCells={flipCells}
      searchQuery={searchQuery}
      page={props.page}
      followTeamId={followTeamId}
      badgeCarousel={props.badgeCarousel ?? mode === 'spectator'}
      className={props.className}
    />
  );
}
