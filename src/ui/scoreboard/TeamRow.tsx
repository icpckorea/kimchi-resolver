/**
 * One scoreboard row (spec §7):
 * [solved-count color spine][ICPC rank][domestic rank][APAC star slot]
 * [flag][school logo][team name + badges / group][balloons][cells][penalty]
 *
 * Row reordering animates via framer-motion layout (FLIP) with a spring that
 * mimics the original move-up feel; config.animation=false renders with
 * layout={false} (no animation).
 */
import { useEffect, useRef, useState } from 'react';
import { motion, type Transition } from 'framer-motion';

import type { CellState, OrgsIndex, Problem, TeamStanding } from '@core/types';
import type { ResolvedConfig } from '@core/config';
import { ApacStar, FlagIcon, type ApacStarTier } from '@ui/icons';

import { Badges } from './Badges';
import { Balloons } from './Balloons';
import { ProblemCell } from './ProblemCell';
import { useCellFlip } from './useCellFlip';
import { cls, ordinalSuffix, solvedSpineColor } from './util';

/** Derivation comes from the APAC rules (core); the row just renders it. */
export interface ApacStarInfo {
  tier: ApacStarTier;
  /** Play the one-turn rotation (tier granted/changed). */
  spinning?: boolean;
}

/** Spring tuned to the original rank move-up feel (~100-200ms per row). */
const ROW_SPRING: Transition = { type: 'spring', stiffness: 420, damping: 40, mass: 0.9 };

/** Flip duration for live-fed runs on the spectator board (spec §5/§7). */
export const LIVE_FLIP_MS = 600;

/** Content equality of the fields ProblemCell renders. */
function sameCellDisplay(a: CellState, b: CellState): boolean {
  return (
    a.verdict === b.verdict &&
    a.attempts === b.attempts &&
    a.failedAttempts === b.failedAttempts &&
    a.solvedMinute === b.solvedMinute &&
    a.isFirstSolve === b.isFirstSolve &&
    a.isLastSolve === b.isLastSolve &&
    a.isContestFirstSolve === b.isContestFirstSolve &&
    a.isContestLastSolve === b.isContestLastSolve
  );
}

interface LiveCellProps {
  problem: Problem;
  cell: CellState;
  showFirstSolve: boolean;
  /** config.animation — false swaps instantly (replay-style). */
  animate: boolean;
  /** Flip batch id when this cell's run was just applied live; else null. */
  flipId: number | null;
}

/**
 * ProblemCell wrapper that plays the 3D cell flip when the cell's run was
 * just applied by the live feed (autoplay tick / feed buttons), swapping the
 * verdict at the flip midpoint (spec §7, original behavior). Any other
 * content change (initial replay, derived last-solve flags moving to another
 * cell) is applied instantly.
 */
function LiveCell({ problem, cell, showFirstSolve, animate, flipId }: LiveCellProps) {
  const ctl = useCellFlip(LIVE_FLIP_MS);
  const [displayed, setDisplayed] = useState(cell);
  /** The cell content we last committed to (instantly or via a midpoint). */
  const targetRef = useRef(cell);
  /** Last flip batch handled; seeded so a mount inside an old batch is quiet. */
  const handledFlipRef = useRef(flipId);
  const flip = ctl.flip;

  useEffect(() => {
    if (animate && flipId !== null && flipId !== handledFlipRef.current) {
      handledFlipRef.current = flipId;
      targetRef.current = cell;
      void flip(() => setDisplayed(cell));
    } else if (!sameCellDisplay(targetRef.current, cell)) {
      handledFlipRef.current = flipId;
      targetRef.current = cell;
      setDisplayed(cell);
    }
  }, [animate, cell, flip, flipId]);

  return (
    <ProblemCell
      problem={problem}
      cell={displayed}
      showFirstSolve={showFirstSolve}
      flip={ctl.flipping ? ctl.props : undefined}
    />
  );
}

function Rank({ value, className }: { value: number; className: string }) {
  return (
    <span className={cls('team-rank', className)}>
      {value}
      <span className="rank-suffix">{ordinalSuffix(value)}</span>
    </span>
  );
}

function SchoolLogo({ logo, group }: { logo: string; group: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className="team-logo"
      src={`./orgs/logos/${logo}`}
      alt={group}
      onError={() => setFailed(true)}
    />
  );
}

export interface TeamRowProps {
  standing: TeamStanding;
  /** Contest problems in display order. */
  problems: Problem[];
  config: ResolvedConfig;
  orgs: OrgsIndex;
  followed?: boolean;
  /** APAC star for this team (App wires it from the core derivation). */
  apacStar?: ApacStarInfo | null;
  /** Manual awards.json labels, already spoiler-gated by the caller. */
  manualLabels?: readonly string[];
  /** First/last row of a same-solved-count band (rounded corner + visible count). */
  spineFirst?: boolean;
  spineLast?: boolean;
  /** "teamId problemId" → flip batch id for just-applied live runs. */
  flipCells?: ReadonlyMap<string, number> | null;
}

export function TeamRow({
  standing,
  problems,
  config,
  orgs,
  followed = false,
  apacStar = null,
  manualLabels = [],
  spineFirst = false,
  spineLast = false,
  flipCells = null,
}: TeamRowProps) {
  const { team } = standing;
  const org = orgs[team.group];
  const logo = config.showSchoolLogos ? org?.logo : undefined;
  const animate = config.animation;

  return (
    <motion.div
      layout={animate ? true : false}
      transition={animate ? ROW_SPRING : undefined}
      className={cls(
        'team-row',
        team.foreign && 'foreign',
        followed && 'followed',
        followed && config.useFollowedTeamSticky && 'sticky',
      )}
      data-team-id={team.id}
      data-solved={standing.solved}
    >
      <div
        className={cls('solved-count', spineFirst && 'spine-first', spineLast && 'spine-last')}
        style={{ backgroundColor: solvedSpineColor(standing.solved, problems.length) }}
      >
        {standing.solved}
      </div>

      <div className="team-ranks">
        <Rank value={standing.icpcRank} className="icpc-rank" />
        {standing.domesticRank !== null ? (
          <Rank value={standing.domesticRank} className="domestic-rank" />
        ) : (
          <span className="team-rank domestic-rank rank-none">{'—'}</span>
        )}
      </div>

      {config.apac.enabled ? (
        <div className="apac-slot">
          {apacStar !== null ? (
            <ApacStar
              key={apacStar.tier}
              tier={apacStar.tier}
              spinning={apacStar.spinning}
              size={20}
              className="team-apac-star"
              title={`APAC ${apacStar.tier} star`}
            />
          ) : null}
        </div>
      ) : null}

      <FlagIcon country={team.countryCode} size={22} className="team-flag" />
      {logo !== undefined && logo !== '' ? (
        <SchoolLogo key={logo} logo={logo} group={team.group} />
      ) : null}

      <div className="team-title">
        <div className="team-name-line">
          <span className="team-name">{team.name}</span>
          <Badges autoLabels={standing.autoLabels} manualLabels={manualLabels} />
        </div>
        {config.showTeamGroup ? <div className="team-group">{team.group}</div> : null}
      </div>

      {config.showBalloons ? <Balloons standing={standing} problems={problems} /> : null}

      <div className="results">
        {problems.map((problem) => {
          const cell = standing.cells.get(problem.id);
          return cell !== undefined ? (
            <LiveCell
              key={problem.id}
              problem={problem}
              cell={cell}
              showFirstSolve={config.showFirstSolve}
              animate={animate}
              flipId={flipCells?.get(`${team.id} ${problem.id}`) ?? null}
            />
          ) : null;
        })}
      </div>

      <div className="team-penalty">
        {standing.penalty}
        <span className="penalty-unit"> min.</span>
      </div>
    </motion.div>
  );
}
