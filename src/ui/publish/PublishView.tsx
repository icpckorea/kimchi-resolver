/**
 * Publish mode (spec §13) — static final scoreboard for announcements.
 *
 * - Chrome: contest title + clock only. No header buttons, no polling,
 *   no autoplay, no animation loops.
 * - No gate: the final board shows at once (publish-modes spec §7). The site
 *   score S is computed from the standings and the regional inputs
 *   (spec §6.1); there is no direct site-score input any more.
 * - APAC stars: simulateRegional ('final' phase, champion = standings[0],
 *   2026-27 per-school quota); edits of the regional inputs re-evaluate live.
 *   A star whose tier changed spins once (previous tiers are tracked in a
 *   ref; the star remounts via key={tier} so the animation replays).
 *
 * Task 6 of the publish-modes plan rebuilds this screen per mode.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '@core/types';
import {
  computeSiteScore,
  countSiteInputs,
  DEFAULT_SCHOOL_QUOTA,
  simulateRegional,
  type ApacStarTier,
} from '@core/apac';
import type { RegionalSimInputs } from '@core/publishState';
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

/**
 * S from the standings counts (operator overrides win when set) and the
 * preliminary counts (empty → 0).
 */
function siteScoreOf(snapshot: Snapshot, inputs: RegionalSimInputs): number {
  const auto = countSiteInputs(snapshot);
  const override = inputs.regionalOverride;
  return computeSiteScore({
    regional: {
      schools: override.schools ?? auto.schools,
      teams: override.teams ?? auto.teams,
      foreign: override.foreign ?? auto.foreign,
    },
    prelimSchools: inputs.prelimSchools ?? 0,
    prelimTeams: inputs.prelimTeams ?? 0,
    coefficients: inputs.coefficients,
  });
}

function useApacStars(snapshot: Snapshot | null, inputs: RegionalSimInputs): ApacStarState {
  const stars = useMemo(() => {
    if (snapshot === null) return new Map<string, ApacStarTier>();
    return simulateRegional(snapshot, {
      siteScore: siteScoreOf(snapshot, inputs),
      cutoff: inputs.cutoff,
      quota: { base: DEFAULT_SCHOOL_QUOTA, wfMedalGroups: inputs.wfMedalGroups },
      alreadyInvited: {
        teamIds: inputs.invitedTeamIds,
        groups: [...inputs.winnerGroups, ...inputs.invitedGroups],
      },
    }).stars;
  }, [snapshot, inputs]);

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
  const regionalInputs = useAppStore((s) => s.regionalInputs);
  const config = useAppStore((s) => s.config);
  const clock = useClock();

  // APAC stars are gated by config.apac.enabled in publish mode too
  // (spec §13: "config.apac.enabled로 on/off").
  const apacEnabled = config.apac.enabled;
  const starState = useApacStars(apacEnabled ? snapshot : null, regionalInputs);

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

      {snapshot === null || contest === null ? (
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
