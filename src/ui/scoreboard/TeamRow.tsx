/**
 * One scoreboard row (spec §7):
 * [solved-count color spine][ICPC rank][domestic rank][APAC star slot]
 * [flag][school logo][team name + badges / group][balloons][cells][penalty]
 *
 * Row reordering animates via framer-motion layout (FLIP) with a spring that
 * mimics the original move-up feel; config.animation=false renders with
 * layout={false} (no animation).
 */
import { useState } from 'react';
import { motion, type Transition } from 'framer-motion';

import type { OrgsIndex, Problem, TeamStanding } from '@core/types';
import type { ResolvedConfig } from '@core/config';
import { ApacStar, FlagIcon, type ApacStarTier } from '@ui/icons';

import { Badges } from './Badges';
import { Balloons } from './Balloons';
import { ProblemCell } from './ProblemCell';
import { cls, ordinalSuffix, solvedSpineColor } from './util';

/** Derivation comes from the APAC rules (core); the row just renders it. */
export interface ApacStarInfo {
  tier: ApacStarTier;
  /** Play the one-turn rotation (tier granted/changed). */
  spinning?: boolean;
}

/** Spring tuned to the original rank move-up feel (~100-200ms per row). */
const ROW_SPRING: Transition = { type: 'spring', stiffness: 420, damping: 40, mass: 0.9 };

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
            <ProblemCell
              key={problem.id}
              problem={problem}
              cell={cell}
              showFirstSolve={config.showFirstSolve}
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
