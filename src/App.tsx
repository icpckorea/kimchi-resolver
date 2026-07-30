/**
 * App shell — boots the store and composes the three app modes (spec §7/§13):
 *
 * - spectator: fixed Header + Scoreboard + Dashboard + SystemMessages.
 * - award:     AwardView (full-board ceremony skin) + SystemMessages.
 * - publish:   PublishView (static final board + site-score gate).
 *
 * Cross-cutting wiring that belongs to no single view lives here:
 * - APAC stars (spec §13): none in spectator; award mode derives them via
 *   computeApacStars — phase 'ceremony' while the ceremony runs and 'final'
 *   once awardMachine.finished (champion = standings[0]); publish derives its
 *   own 'final' stars from siteScore/invitedCutoff inside PublishView.
 * - awards.json (spec §6): fetched from config.award.awardsUrl after boot.
 *   Spectator shows manual labels immediately (a missing file is silent);
 *   publish shows them on the final board (missing → warning); award mode
 *   lets AwardView own the fetch — it gates labels/slides to finalized teams
 *   and reports its own load warning.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { computeApacStars, type ApacStarTier } from '@core/apac';
import { appStore, useAppStore } from '@store/appStore';
import { Dashboard, Header, SystemMessages, useChromeUi, useDashboardVisibility } from '@ui/chrome';
import { Scoreboard, type ApacStarInfo } from '@ui/scoreboard';
import { AwardView } from '@ui/award/AwardView';
import { PublishView } from '@ui/publish/PublishView';
import { parseAwardsJson, type AwardEntry } from '@ui/award/awardsData';

// ---------------------------------------------------------------------------
// awards.json (spectator + publish; award mode self-fetches in AwardView)
// ---------------------------------------------------------------------------

function useAwardsData(): Map<string, AwardEntry> | null {
  const status = useAppStore((s) => s.status);
  const mode = useAppStore((s) => s.mode);
  const awardsUrl = useAppStore((s) => s.config.award.awardsUrl);
  const [awards, setAwards] = useState<Map<string, AwardEntry> | null>(null);

  useEffect(() => {
    if (status !== 'ready' || mode === 'award') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(awardsUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseAwardsJson(await res.json());
        if (!cancelled) setAwards(parsed);
      } catch (err) {
        // Missing awards.json is expected in spectator mode → stay silent.
        if (!cancelled && mode === 'publish') {
          appStore
            .getState()
            .addSystemMessage(
              'warning',
              `awards.json could not be loaded (${
                err instanceof Error ? err.message : String(err)
              }); manual labels will be omitted.`,
            );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, mode, awardsUrl]);

  return awards;
}

/** team id → manual label badges, for the boards that show them unconditionally. */
function toManualLabels(
  awards: Map<string, AwardEntry> | null,
): ReadonlyMap<string, readonly string[]> | null {
  if (awards === null) return null;
  const out = new Map<string, readonly string[]>();
  for (const [teamId, entry] of awards) {
    if (entry.labels.length > 0) out.set(teamId, entry.labels);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Award-mode APAC stars (spec §13 rules 1–2; rule 3 is publish-only)
// ---------------------------------------------------------------------------

function useAwardApacStars(): ReadonlyMap<string, ApacStarInfo> | null {
  const mode = useAppStore((s) => s.mode);
  const enabled = useAppStore((s) => s.config.apac.enabled);
  const snapshot = useAppStore((s) => s.snapshot);
  const machine = useAppStore((s) => s.awardMachine);
  // The machine mutates in place; awardTick invalidates the memo below.
  const tick = useAppStore((s) => s.awardTick);
  const finished = machine?.finished ?? false;

  const tiers = useMemo(() => {
    void tick;
    if (mode !== 'award' || !enabled || snapshot === null) return null;
    return computeApacStars(snapshot, {
      phase: finished ? 'final' : 'ceremony',
      championTeamId: finished ? (snapshot.standings[0]?.team.id ?? null) : null,
      siteScore: null, // invited-cutoff promotion is publish-only (spec §13.3)
      invitedScoreCutoff: null,
    });
  }, [mode, enabled, snapshot, finished, tick]);

  // A star spins once when granted or when its tier changes (previous tiers
  // tracked across renders; the star remounts via key={tier} down the tree).
  const prevTiersRef = useRef<Map<string, ApacStarTier> | null>(null);
  const stars = useMemo(() => {
    if (tiers === null) return null;
    const prev = prevTiersRef.current;
    const out = new Map<string, ApacStarInfo>();
    for (const [teamId, tier] of tiers) {
      out.set(teamId, { tier, spinning: prev === null || prev.get(teamId) !== tier });
    }
    return out;
  }, [tiers]);
  useEffect(() => {
    prevTiersRef.current = tiers;
  }, [tiers]);

  return stars;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const status = useAppStore((s) => s.status);
  const mode = useAppStore((s) => s.mode);
  const page = useChromeUi((s) => s.page);
  const [dashboardVisible] = useDashboardVisibility();

  // Boot once on mount. boot() ignores repeat calls (status guard), so the
  // StrictMode double-invoke is harmless; dispose stops timers on unmount.
  useEffect(() => {
    void appStore.getState().boot(window.location.search);
    return () => {
      appStore.getState().dispose();
    };
  }, []);

  const awards = useAwardsData();
  const manualLabels = useMemo(() => toManualLabels(awards), [awards]);
  const awardStars = useAwardApacStars();

  if (status === 'idle' || status === 'booting') {
    return (
      <div className="app-shell">
        <SystemMessages />
        <div className="boot-panel" role="status">
          loading scoreboard…
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="app-shell">
        <SystemMessages />
        <div className="boot-panel boot-panel--error" role="alert">
          The contest could not be loaded. Check config.json and the data source, then reload.
        </div>
      </div>
    );
  }

  if (mode === 'publish') {
    return (
      <div className="app-shell">
        <PublishView manualLabels={manualLabels} />
        <SystemMessages />
      </div>
    );
  }

  if (mode === 'award') {
    return (
      <div className="app-shell">
        <main className="app-main app-main--award">
          <div className="board-wrap">
            <AwardView apacStars={awardStars} />
          </div>
        </main>
        <SystemMessages />
      </div>
    );
  }

  // spectator
  return (
    <div className="app-shell">
      <Header />
      <main
        className={
          dashboardVisible ? 'app-main app-main--with-dashboard' : 'app-main'
        }
      >
        <div className="board-wrap">
          {/* Spectator never shows APAC stars (spec §13: contest not over). */}
          <Scoreboard page={page} apacStars={null} manualLabels={manualLabels} />
        </div>
      </main>
      <Dashboard />
      <SystemMessages />
    </div>
  );
}
