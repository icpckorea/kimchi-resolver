/**
 * Fixed top header (spec §7, original look §1.3): contest title (with a
 * distinct "no more update" state), HH:MM clock, action buttons with SVG
 * icons + tooltips, team search (100 ms debounce), pagination nav.
 *
 * Mode rules: hidden entirely in award mode; in publish mode only the title
 * and the clock are shown.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useStore } from 'zustand';

import { appStore, type AppStore } from '@store/appStore';
import { filterStandings } from '@ui/scoreboard';
import {
  Activity,
  Bell,
  ChevronLeft,
  ChevronRight,
  Clock,
  FastForward,
  Pause,
  Play,
  RefreshCw,
  Search,
  StepForward,
} from '@ui/icons';
import { useChromeUi, useDashboardVisibility } from './chromeUiState';
import { useDesktopNotifications, type NotifyPermission } from './useDesktopNotifications';
import './chrome.css';

/** Contest clock, HH:MM from elapsed contest seconds; '--:--' when unknown. */
export function formatClock(contestTimeSec: number | null): string {
  if (contestTimeSec === null) return '--:--';
  const total = Math.max(0, Math.floor(contestTimeSec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}`;
}

function notifyTooltip(permission: NotifyPermission, enabled: boolean): string {
  if (permission === 'unsupported') return 'Desktop notifications are not supported';
  if (permission === 'denied') return 'Desktop notifications are blocked by the browser';
  if (enabled) return 'Disable desktop notifications';
  if (permission === 'granted') return 'Enable desktop notifications';
  return 'Enable desktop notifications (asks for permission first)';
}

export interface HeaderProps {
  store?: AppStore;
}

export function Header({ store = appStore }: HeaderProps) {
  const mode = useStore(store, (state) => state.mode);
  const title = useStore(store, (state) => state.contest?.title ?? '');
  const contestTimeSec = useStore(store, (state) => state.contestTimeSec);
  const noMoreUpdate = useStore(store, (state) => state.noMoreUpdate);
  const pendingCount = useStore(store, (state) => state.pendingCount);
  const playing = useStore(store, (state) => state.playing);
  const pagination = useStore(store, (state) => state.config.pagination);
  const paginationSize = useStore(store, (state) => state.config.paginationSize);
  const standings = useStore(store, (state) => state.snapshot?.standings ?? null);
  const storedQuery = useStore(store, (state) => state.config.searchQuery);

  // Pagination must agree with the board: both paginate the SAME filtered
  // list (Scoreboard applies filterStandings with the committed query).
  const filteredTeamCount = useMemo(
    () => (standings === null ? 0 : filterStandings(standings, storedQuery).length),
    [standings, storedQuery],
  );

  const notifications = useDesktopNotifications(store);
  const [dashboardVisible, toggleDashboard] = useDashboardVisibility(store);
  const page = useChromeUi((state) => state.page);
  const setPage = useChromeUi((state) => state.setPage);

  const [fetching, setFetching] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const debounceTimer = useRef<number | null>(null);

  // Commit the search text into the store after a 100 ms debounce (spec §7).
  const onSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setDraft(value);
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      debounceTimer.current = window.setTimeout(() => {
        debounceTimer.current = null;
        store.setState((state) => ({
          config: { ...state.config, searchQuery: value.trim() === '' ? null : value },
        }));
        // A changed query changes the filtered page count — jump back to
        // page 0 so the label and the rendered board stay in sync.
        useChromeUi.getState().setPage(0);
      }, 100);
    },
    [store],
  );
  useEffect(
    () => () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    },
    [],
  );

  const onUpdateNow = useCallback(() => {
    setFetching(true);
    void store
      .getState()
      .pollNow()
      .finally(() => setFetching(false));
  }, [store]);

  if (mode === 'award') return null; // header disabled during the ceremony

  const clock = (
    <span className="kr-header__clock" title="Elapsed contest time">
      <Clock size="1.1em" />
      <time className="kr-header__clock-text">{formatClock(contestTimeSec)}</time>
    </span>
  );

  const titleEl = (
    <h1
      className={
        noMoreUpdate ? 'kr-header__title kr-header__title--final' : 'kr-header__title'
      }
      data-no-more-update={noMoreUpdate ? 'true' : undefined}
      title={noMoreUpdate ? 'No more updates — the standings are final' : undefined}
    >
      {title}
      {noMoreUpdate ? <span className="kr-header__final-chip">final</span> : null}
    </h1>
  );

  if (mode === 'publish') {
    return (
      <header className="kr-header kr-header--publish">
        {titleEl}
        <div className="kr-header__spacer" />
        {clock}
      </header>
    );
  }

  const pageCount = Math.max(1, Math.ceil(filteredTeamCount / paginationSize));
  const currentPage = Math.min(page, pageCount - 1);

  return (
    <header className="kr-header">
      {titleEl}

      <div className="kr-header__actions">
        <button
          type="button"
          className={notifications.enabled ? 'kr-hbtn kr-hbtn--on' : 'kr-hbtn'}
          title={notifyTooltip(notifications.permission, notifications.enabled)}
          aria-label="Desktop notifications"
          aria-pressed={notifications.enabled}
          onClick={notifications.toggle}
        >
          <Bell size="1.25em" />
        </button>

        <button
          type="button"
          className="kr-hbtn"
          title="Fetch updates now"
          aria-label="Update now"
          onClick={onUpdateNow}
        >
          <RefreshCw size="1.25em" className={fetching ? 'kr-spin' : undefined} />
          {pendingCount > 0 ? (
            <span className="kr-hbtn__badge" aria-label={`${pendingCount} runs pending`}>
              {pendingCount}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          className={playing ? 'kr-hbtn kr-hbtn--on' : 'kr-hbtn'}
          title={playing ? 'Pause auto-play' : 'Resume auto-play'}
          aria-label="Auto-play"
          aria-pressed={playing}
          onClick={() => store.getState().togglePlaying()}
        >
          {playing ? <Pause size="1.25em" /> : <Play size="1.25em" />}
        </button>

        <button
          type="button"
          className="kr-hbtn"
          title="Feed one queued run"
          aria-label="Feed one run"
          onClick={() => store.getState().feedOne()}
        >
          <StepForward size="1.25em" />
        </button>

        <button
          type="button"
          className="kr-hbtn"
          title="Feed all queued runs"
          aria-label="Feed all runs"
          onClick={() => store.getState().feedAllQueued()}
        >
          <FastForward size="1.25em" />
        </button>

        <button
          type="button"
          className={dashboardVisible ? 'kr-hbtn kr-hbtn--on' : 'kr-hbtn'}
          title={dashboardVisible ? 'Hide the events dashboard' : 'Show the events dashboard'}
          aria-label="Events dashboard"
          aria-pressed={dashboardVisible}
          onClick={toggleDashboard}
        >
          <Activity size="1.25em" />
        </button>
      </div>

      <div className="kr-header__spacer" />

      <label className="kr-header__search" title="Search teams by name or affiliation">
        <Search size="1em" />
        <input
          type="search"
          placeholder="search teams"
          aria-label="Search teams"
          value={draft ?? storedQuery ?? ''}
          onChange={onSearchChange}
        />
      </label>

      {pagination ? (
        <nav className="kr-header__pages" aria-label="Scoreboard pages">
          <button
            type="button"
            className="kr-hbtn"
            title="Previous page"
            aria-label="Previous page"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size="1.1em" />
          </button>
          <span className="kr-header__page-label">
            {`page ${currentPage + 1}/${pageCount}`}
          </span>
          <button
            type="button"
            className="kr-hbtn"
            title="Next page"
            aria-label="Next page"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size="1.1em" />
          </button>
        </nav>
      ) : null}

      {clock}
    </header>
  );
}
