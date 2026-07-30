/**
 * Publish mode (spec §13) — static final scoreboard for announcements.
 *
 * - Chrome: contest title + clock only. No header buttons, no polling,
 *   no autoplay, no animation loops.
 * - Gate: until a valid site score exists the board is replaced by an
 *   instruction panel ("site score를 입력하세요") plus the input form.
 * - APAC stars: computeApacStars in the 'final' phase with the champion
 *   taken from standings[0]; siteScore / invitedCutoff edits re-evaluate
 *   live. A star whose tier changed spins once (previous tiers are tracked
 *   in a ref; the star remounts via key={tier} so the animation replays).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CellState, Snapshot, TeamStanding } from '@core/types';
import { computeApacStars, type ApacStarTier } from '@core/apac';
import { useAppStore } from '@store/appStore';
import { ApacStar, FlagIcon } from '@ui/icons';
import { Badges } from '@ui/scoreboard/Badges';
import { PublishControls } from './PublishControls';
import './publish.css';

// ---------------------------------------------------------------------------
// Clock (HH:MM)
// ---------------------------------------------------------------------------

function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);
  return formatClock(now);
}

// ---------------------------------------------------------------------------
// APAC stars + spin tracking
// ---------------------------------------------------------------------------

export interface ApacStarState {
  stars: Map<string, ApacStarTier>;
  /** Team ids whose star was granted or changed tier since the last stars. */
  spinning: Set<string>;
}

function useApacStars(
  snapshot: Snapshot | null,
  siteScore: number | null,
  invitedCutoff: number | null,
): ApacStarState {
  const stars = useMemo(() => {
    if (snapshot === null) return new Map<string, ApacStarTier>();
    return computeApacStars(snapshot, {
      phase: 'final',
      championTeamId: snapshot.standings[0]?.team.id ?? null,
      siteScore,
      invitedScoreCutoff: invitedCutoff,
    });
  }, [snapshot, siteScore, invitedCutoff]);

  // Previous tiers live in a ref: comparing against them marks changed stars
  // as spinning, and the ref is advanced after commit.
  const prevTiersRef = useRef<Map<string, ApacStarTier> | null>(null);
  const spinning = useMemo(() => {
    const prev = prevTiersRef.current;
    const changed = new Set<string>();
    for (const [teamId, tier] of stars) {
      if (prev === null || prev.get(teamId) !== tier) changed.add(teamId);
    }
    return changed;
  }, [stars]);
  useEffect(() => {
    prevTiersRef.current = stars;
  }, [stars]);

  return { stars, spinning };
}

// ---------------------------------------------------------------------------
// Static board
// ---------------------------------------------------------------------------
// TODO(scoreboard): swap the row/cell markup below for the shared
// src/ui/scoreboard components once they land — publish keeps ownership of
// the chrome/gate/star wiring only. The markup is kept in this single
// section (PublishBoard/BoardRow/BoardCell) so the swap is local.

type CellTone = 'none' | 'solved' | 'first' | 'last' | 'contest-last' | 'pending' | 'failed';

function cellTone(cell: CellState): CellTone {
  if (cell.verdict === null) return 'none';
  if (cell.verdict === 'accepted') {
    // Priority: purple > blue > light-green > green (spec §7).
    if (cell.isContestLastSolve) return 'contest-last';
    if (cell.isLastSolve) return 'last';
    if (cell.isFirstSolve) return 'first';
    return 'solved';
  }
  return cell.verdict === 'pending' ? 'pending' : 'failed';
}

/** Solved-count color spine: HSV red → green, odd/even saturation step. */
function spineColor(solved: number, maxSolved: number, oddRow: boolean): string {
  const ratio = maxSolved > 0 ? solved / maxSolved : 0;
  const hue = Math.round(120 * ratio);
  const saturation = oddRow ? 52 : 62;
  return `hsl(${hue}, ${saturation}%, 40%)`;
}

interface BoardRowProps {
  standing: TeamStanding;
  problemIds: string[];
  maxSolved: number;
  oddRow: boolean;
  tier: ApacStarTier | null;
  spinning: boolean;
  showTeamGroup: boolean;
  manualLabels: readonly string[];
}

function BoardRow({
  standing,
  problemIds,
  maxSolved,
  oddRow,
  tier,
  spinning,
  showTeamGroup,
  manualLabels,
}: BoardRowProps) {
  const { team } = standing;
  return (
    <div className="publish-row" data-team-id={team.id}>
      <span
        className="publish-rank publish-rank-icpc"
        style={{ backgroundColor: spineColor(standing.solved, maxSolved, oddRow) }}
      >
        {standing.icpcRank}
      </span>
      <span className="publish-rank publish-rank-domestic">
        {standing.domesticRank ?? ''}
      </span>
      <span className="publish-star-slot">
        {tier !== null ? (
          <ApacStar
            key={tier}
            tier={tier}
            spinning={spinning}
            size={20}
            title={`APAC ${tier} star`}
          />
        ) : null}
      </span>
      <span className="publish-flag-slot">
        <FlagIcon country={team.countryCode} size={21} />
      </span>
      <span className="publish-team-name">
        {team.name}
        <Badges autoLabels={standing.autoLabels} manualLabels={manualLabels} />
      </span>
      {showTeamGroup ? <span className="publish-team-group">{team.group}</span> : null}
      <span className="publish-solved">{standing.solved}</span>
      <span className="publish-penalty">{standing.penalty}</span>
      <span className="publish-cells">
        {problemIds.map((problemId) => {
          const cell = standing.cells.get(problemId)!;
          const tone = cellTone(cell);
          return (
            <span key={problemId} className={`publish-cell publish-cell--${tone}`}>
              {cell.verdict === 'accepted' ? (
                <>
                  <span className="publish-cell-minute">{cell.solvedMinute}</span>
                  <span className="publish-cell-attempts">{cell.attempts}</span>
                </>
              ) : cell.verdict !== null ? (
                <span className="publish-cell-attempts">{cell.attempts}</span>
              ) : null}
            </span>
          );
        })}
      </span>
    </div>
  );
}

interface PublishBoardProps {
  snapshot: Snapshot;
  starState: ApacStarState;
  showTeamGroup: boolean;
  problemLabels: { id: string; label: string }[];
  manualLabels: ReadonlyMap<string, readonly string[]> | null;
}

function PublishBoard({
  snapshot,
  starState,
  showTeamGroup,
  problemLabels,
  manualLabels,
}: PublishBoardProps) {
  const problemIds = problemLabels.map((p) => p.id);
  const maxSolved = snapshot.standings.reduce((max, s) => Math.max(max, s.solved), 0);
  return (
    <div className="publish-board" role="table" aria-label="final standings">
      <div className="publish-row publish-row--head" role="row">
        <span className="publish-rank">#</span>
        <span className="publish-rank">국내</span>
        <span className="publish-star-slot" />
        <span className="publish-flag-slot" />
        <span className="publish-team-name">Team</span>
        {showTeamGroup ? <span className="publish-team-group">School</span> : null}
        <span className="publish-solved">Solved</span>
        <span className="publish-penalty">Penalty</span>
        <span className="publish-cells">
          {problemLabels.map((p) => (
            <span key={p.id} className="publish-cell publish-cell--head">
              {p.label}
            </span>
          ))}
        </span>
      </div>
      {snapshot.standings.map((standing, index) => (
        <BoardRow
          key={standing.team.id}
          standing={standing}
          problemIds={problemIds}
          maxSolved={maxSolved}
          oddRow={index % 2 === 1}
          tier={starState.stars.get(standing.team.id) ?? null}
          spinning={starState.spinning.has(standing.team.id)}
          showTeamGroup={showTeamGroup}
          manualLabels={manualLabels?.get(standing.team.id) ?? []}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PublishView
// ---------------------------------------------------------------------------

export interface PublishViewProps {
  /** team id → manual awards.json labels (App wires the fetch; spec §13). */
  manualLabels?: ReadonlyMap<string, readonly string[]> | null;
}

export function PublishView({ manualLabels = null }: PublishViewProps) {
  const contest = useAppStore((s) => s.contest);
  const snapshot = useAppStore((s) => s.snapshot);
  const siteScore = useAppStore((s) => s.siteScore);
  const invitedCutoff = useAppStore((s) => s.invitedCutoff);
  const showTeamGroup = useAppStore((s) => s.config.showTeamGroup);
  const clock = useClock();

  const gateOpen = siteScore !== null && siteScore > 0;
  const starState = useApacStars(gateOpen ? snapshot : null, siteScore, invitedCutoff);

  return (
    <div className="publish-view">
      <header className="publish-header">
        <h1 className="publish-title">{contest?.title ?? 'kimchi-resolver'}</h1>
        <span className="publish-mode-tag">publish</span>
        <span className="publish-clock" aria-label="clock">
          {clock}
        </span>
      </header>

      <PublishControls />

      {!gateOpen ? (
        <section className="publish-gate" aria-label="site score required">
          <h2 className="publish-gate-title">site score를 입력하세요</h2>
          <p className="publish-gate-hint">
            publish 모드는 site score 값이 필요합니다. 위 입력란에 site score를 입력하면 최종
            순위표와 APAC 별 판정이 표시됩니다. invited score cutoff 값을 입력하면 초청권 팀의
            별이 금색으로 표시됩니다.
          </p>
        </section>
      ) : snapshot === null || contest === null ? (
        <section className="publish-gate" aria-label="loading">
          <p className="publish-gate-hint">최종 순위표를 준비하는 중입니다.</p>
        </section>
      ) : (
        <PublishBoard
          snapshot={snapshot}
          starState={starState}
          showTeamGroup={showTeamGroup}
          problemLabels={contest.problems.map((p) => ({ id: p.id, label: p.label }))}
          manualLabels={manualLabels}
        />
      )}
    </div>
  );
}
