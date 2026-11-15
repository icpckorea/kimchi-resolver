/**
 * Timeline URL state (design 2026-11-15 §6.2): `view=timeline` and
 * `teams=<id,…>` (selection order). Changes are mirrored with
 * `history.replaceState` (no reload); the time slider's reload keeps them
 * because it only touches `time=` and `q=`.
 */
import { useEffect } from 'react';

import { timelineEnabled, useAppStore, type TimelineTeam, type TimelineViewMode } from '@store/appStore';

/**
 * `href` with `view` and `teams` set, or removed for the board / no teams.
 * A team whose color slot differs from its position is written `id:slot`,
 * so a reload (the time slider) keeps every color.
 */
export function timelineHref(href: string, view: TimelineViewMode, teams: readonly TimelineTeam[]): string {
  const url = new URL(href);
  if (view === 'timeline') url.searchParams.set('view', 'timeline');
  else url.searchParams.delete('view');
  if (teams.length > 0) {
    url.searchParams.set('teams', teams.map((t, i) => (t.slot === i ? t.id : `${t.id}:${t.slot}`)).join(','));
  } else {
    url.searchParams.delete('teams');
  }
  return url.toString();
}

/** Keeps the address bar in step with the view and the selected teams. */
export function useTimelineUrlSync(): void {
  const enabled = useAppStore((s) => s.status === 'ready' && timelineEnabled(s));
  const view = useAppStore((s) => s.view);
  const teams = useAppStore((s) => s.timelineTeams);
  useEffect(() => {
    if (!enabled) return;
    const next = timelineHref(window.location.href, view, teams);
    if (next !== window.location.href) window.history.replaceState(window.history.state, '', next);
  }, [enabled, view, teams]);
}
