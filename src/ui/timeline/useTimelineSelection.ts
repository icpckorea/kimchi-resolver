/**
 * Board-row selection for the Timeline view (design 2026-11-15 §6.5):
 * team id → slot color for the row tint, and the click handler. A 7th team
 * leaves the selection unchanged and shows an info message.
 */
import { useCallback, useMemo } from 'react';
import { useStore } from 'zustand';

import { TIMELINE_COLORS } from '@core/timeline';
import { appStore, timelineEnabled, type AppStore } from '@store/appStore';

export const TIMELINE_FULL_MESSAGE = 'The timeline shows up to 6 teams.';

export interface TimelineBoardSelection {
  /** team id → color; null when the Timeline view is off. */
  selection: ReadonlyMap<string, string> | null;
  /** Toggle handler for a board row; undefined when the view is off. */
  onToggle: ((teamId: string) => void) | undefined;
}

export function useTimelineBoardSelection(store: AppStore = appStore): TimelineBoardSelection {
  const enabled = useStore(store, (s) => timelineEnabled(s));
  const teams = useStore(store, (s) => s.timelineTeams);
  const selection = useMemo(
    () => (enabled ? new Map(teams.map((t) => [t.id, TIMELINE_COLORS[t.slot]])) : null),
    [enabled, teams],
  );
  const toggle = useCallback(
    (teamId: string) => {
      if (store.getState().toggleTimelineTeam(teamId) === 'full') {
        store.getState().addSystemMessage('info', TIMELINE_FULL_MESSAGE);
      }
    },
    [store],
  );
  return { selection, onToggle: enabled ? toggle : undefined };
}
