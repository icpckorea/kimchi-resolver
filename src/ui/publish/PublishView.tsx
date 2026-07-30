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
import type { Snapshot } from '@core/types';
import { computeApacStars, type ApacStarTier } from '@core/apac';
import { useAppStore } from '@store/appStore';
import { Scoreboard, type ApacStarInfo } from '@ui/scoreboard';
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
  const config = useAppStore((s) => s.config);
  const clock = useClock();

  const gateOpen = siteScore !== null && siteScore > 0;
  // APAC stars are gated by config.apac.enabled in publish mode too
  // (spec §13: "config.apac.enabled로 on/off").
  const apacEnabled = config.apac.enabled;
  const starState = useApacStars(gateOpen && apacEnabled ? snapshot : null, siteScore, invitedCutoff);

  // Static board (spec §13): no row animation, no pagination slices; the
  // APAC star slot follows config.apac.enabled.
  const publishConfig = useMemo(
    () => ({
      ...config,
      animation: false,
      pagination: false,
    }),
    [config],
  );

  // ApacStarState → per-team {tier, spinning} for the shared Scoreboard rows.
  const apacStars = useMemo(() => {
    const map = new Map<string, ApacStarInfo>();
    for (const [teamId, tier] of starState.stars) {
      map.set(teamId, { tier, spinning: starState.spinning.has(teamId) });
    }
    return map;
  }, [starState]);

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
            순위표와 APAC 별 판정이 표시됩니다. 별의 의미: 동색 = 학내 3등 이내, 은색 = APAC
            championship 초대 가능, 금색 = APAC championship 진출. invited score cutoff 값을
            입력하면 진출이 확정된 팀의 별이 금색으로 바뀝니다.
          </p>
        </section>
      ) : snapshot === null || contest === null ? (
        <section className="publish-gate" aria-label="loading">
          <p className="publish-gate-hint">최종 순위표를 준비하는 중입니다.</p>
        </section>
      ) : (
        <Scoreboard
          className="publish-board"
          snapshot={snapshot}
          problems={contest.problems}
          config={publishConfig}
          searchQuery={null}
          followTeamId={null}
          apacStars={apacEnabled ? apacStars : null}
          manualLabels={manualLabels}
        />
      )}
    </div>
  );
}
