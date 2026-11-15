/**
 * Header switch `[Board | Timeline (n)]` (design 2026-11-15 §6.4). Shown in
 * spectator mode with `timeline.enabled`, desktop widths only.
 */
import { useStore } from 'zustand';

import { appStore, timelineEnabled, type AppStore } from '@store/appStore';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '@ui/scoreboard/useMediaQuery';

export function ViewSwitch({ store = appStore }: { store?: AppStore }) {
  const enabled = useStore(store, (s) => timelineEnabled(s));
  const view = useStore(store, (s) => s.view);
  const count = useStore(store, (s) => s.timelineTeams.length);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  if (!enabled || isMobile) return null;
  const timelineLabel = count > 0 ? `Timeline (${count})` : 'Timeline';
  return (
    <div className="kr-viewswitch" role="group" aria-label="View">
      <button
        type="button"
        className={view === 'board' ? 'kr-viewswitch__btn kr-viewswitch__btn--on' : 'kr-viewswitch__btn'}
        aria-pressed={view === 'board'}
        onClick={() => store.getState().setView('board')}
      >
        Board
      </button>
      <button
        type="button"
        className={view === 'timeline' ? 'kr-viewswitch__btn kr-viewswitch__btn--on' : 'kr-viewswitch__btn'}
        aria-pressed={view === 'timeline'}
        onClick={() => store.getState().setView('timeline')}
      >
        {timelineLabel}
      </button>
    </div>
  );
}
