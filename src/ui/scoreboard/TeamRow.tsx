/**
 * One scoreboard row (spec §7):
 * [leading control][solved-count color spine][ICPC rank][domestic rank]
 * [APAC star slot][flag][school logo][team name + tag / group][badge column]
 * [balloons][cells][penalty][value]
 *
 * The leading control, the stage icon, the value and the advance/dimmed row states
 * come from an optional `RowDecor` (publish modes); without one the row is
 * the plain spectator row.
 *
 * Row reordering animates via framer-motion layout (FLIP) with a spring that
 * mimics the original move-up feel; config.animation=false renders with
 * layout={false} (no animation).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, type Transition } from 'framer-motion';

import type { CellState, OrgsIndex, Problem, TeamStanding } from '@core/types';
import type { ResolvedConfig } from '@core/config';
import type { PrelimStage } from '@core/preliminary';
import { ApacStar, FlagIcon, StageIcon, type ApacStarTier } from '@ui/icons';

import { BOARD_MAX_BADGES, Badges } from './Badges';
import { Balloons } from './Balloons';
import { ProblemCell } from './ProblemCell';
import { useCellFlip } from './useCellFlip';
import { cls, groupFitStyle, nameFitStyle, ordinalSuffix, solvedSpineColor } from './util';

/** Derivation comes from the APAC rules (core); the row just renders it. */
export interface ApacStarInfo {
  tier: ApacStarTier;
  /** Play the one-turn rotation (tier granted/changed). */
  spinning?: boolean;
}

/** Per-row decoration for the publish prepare page and the public page. */
export interface RowDecor {
  /** Selected for the regional: yellow background (`team-row--advance`). */
  advance?: boolean;
  /** Ineligible: row at opacity 0.5 (`team-row--dimmed`). */
  dimmed?: boolean;
  /**
   * Preliminary: why the team advances, as a small icon after the name.
   * `label` is its tooltip and accessible name (the caller translates it).
   */
  stageIcon?: { stage: PrelimStage; label: string };
  /**
   * Prepare page only: a visible badge after the name, e.g. '미자격' for a team
   * that is excluded. It also grays and strikes through the ranks
   * (`team-row--excluded`). The public page never sets it.
   */
  notice?: string;
  /** Right-aligned note, e.g. the APAC value '0.1740'. */
  value?: string;
  /**
   * Control before the solved spine (the ineligible checkbox). Its clicks
   * and key presses never reach the row, so it does not open the mobile
   * detail modal.
   */
  leading?: ReactNode;
}

/** APAC star semantics per tier (spec §13) — tooltip text, shared with the
 * award board (AwardView imports it). */
export const APAC_STAR_TITLES: Record<ApacStarTier, string> = {
  bronze: 'In the APAC Championship list so far',
  silver: 'Likely invited to the APAC Championship',
  gold: 'Invited to the APAC Championship',
};

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
  /**
   * Mobile compact row (spec §14): hides balloons, cells and badges (they
   * move into the detail modal) and appends a solved/penalty summary.
   */
  mobile?: boolean;
  /** Tap handler for the compact row — opens the team detail modal. */
  onOpenDetail?: (teamId: string) => void;
  /** Publish-mode decoration for this row. */
  decor?: RowDecor;
  /**
   * Reserve the value column even when this row has no value, so every row
   * of a board that shows values keeps the same columns (ScoreboardView
   * sets it when any row has one).
   */
  valueSlot?: boolean;
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
  mobile = false,
  onOpenDetail,
  decor,
  valueSlot = false,
}: TeamRowProps) {
  const { team } = standing;
  const org = orgs[team.group];
  const logo = config.showSchoolLogos ? org?.logo : undefined;
  const animate = config.animation;
  const tappable = mobile && onOpenDetail !== undefined;
  const leading = decor?.leading;
  const stageIcon = decor?.stageIcon;
  const notice = decor?.notice;
  const value = decor?.value;

  return (
    <motion.div
      layout={animate ? true : false}
      transition={animate ? ROW_SPRING : undefined}
      className={cls(
        'team-row',
        mobile && 'team-row--compact',
        team.foreign && 'foreign',
        followed && 'followed',
        followed && config.useFollowedTeamSticky && 'sticky',
        decor?.advance === true && 'team-row--advance',
        decor?.dimmed === true && 'team-row--dimmed',
        notice !== undefined && notice !== '' && 'team-row--excluded',
      )}
      data-team-id={team.id}
      data-solved={standing.solved}
      role={tappable ? 'button' : undefined}
      tabIndex={tappable ? 0 : undefined}
      aria-haspopup={tappable ? 'dialog' : undefined}
      onClick={tappable ? () => onOpenDetail(team.id) : undefined}
      onKeyDown={
        tappable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpenDetail(team.id);
              }
            }
          : undefined
      }
    >
      {leading !== undefined && leading !== null ? (
        // Keep the control's own clicks and keys away from the row's
        // open-detail handlers (and the row's preventDefault on Space).
        <div
          className="team-row-leading"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {leading}
        </div>
      ) : null}

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
              title={APAC_STAR_TITLES[apacStar.tier]}
            />
          ) : null}
        </div>
      ) : null}

      <FlagIcon country={team.countryCode} size={22} className="team-flag" />
      {/* The §14 compact row has no logo slot (rank|star|flag|name|score). */}
      {!mobile && logo !== undefined && logo !== '' ? (
        <SchoolLogo key={logo} logo={logo} group={team.group} />
      ) : null}

      {/* The name is never truncated (spec §7): the column reserves its width
       * and these fit hints let the text scale down instead (util.ts). */}
      <div className="team-title">
        <div className="team-name-line">
          <span className="team-name" style={nameFitStyle(team.name)}>
            {team.name}
          </span>
          {notice !== undefined && notice !== '' ? (
            <span className="team-row-notice">{notice}</span>
          ) : null}
          {stageIcon !== undefined ? (
            <StageIcon
              stage={stageIcon.stage}
              title={stageIcon.label}
              className="team-row-stage"
            />
          ) : null}
        </div>
        {config.showTeamGroup ? (
          <div className="team-group" style={groupFitStyle(team.group)}>
            {team.group}
          </div>
        ) : null}
      </div>

      {/* Badges live in their own fixed-width column so they can never cover
       * or shrink the name block (spec §7). Mobile moves them into the detail
       * modal instead. */}
      {!mobile ? (
        <div className="team-badge-col">
          <Badges
            autoLabels={standing.autoLabels}
            manualLabels={manualLabels}
            maxVisible={BOARD_MAX_BADGES}
          />
        </div>
      ) : null}

      {/* Balloons are fully hidden on mobile (spec §14). */}
      {!mobile && config.showBalloons ? (
        <Balloons standing={standing} problems={problems} />
      ) : null}

      {!mobile ? (
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
      ) : null}

      {mobile ? (
        <div className="team-score-compact" aria-label="solved / penalty">
          <span className="compact-solved">{standing.solved}</span>
          <span className="compact-separator">/</span>
          <span className="compact-penalty">{standing.penalty}</span>
        </div>
      ) : (
        <div className="team-penalty">
          {standing.penalty}
          <span className="penalty-unit"> min.</span>
        </div>
      )}

      {/* Mobile has no room for a 4-decimal column next to the name (spec
       * §14); the compact row drops it and the detail modal shows it. */}
      {!mobile && (valueSlot || value !== undefined) ? (
        <div className="team-row-value">{value ?? ''}</div>
      ) : null}
    </motion.div>
  );
}
