/**
 * Events dashboard (spec §7, original §1.3): fixed right panel with the most
 * recent judge events, newest first.
 *
 * - Only rendered in spectator mode and only on viewports ≥ 1300 px
 *   (the media query in chrome.css hides it below that).
 * - Capped at exactly config.maxNotifications entries — the original's
 *   "max+1 plus duplicated sentinel" bug is NOT ported.
 * - A run that was shown as pending and later judged UPDATES IN PLACE:
 *   entries are keyed by run id and deduped so the newest verdict renders in
 *   the slot where the run first appeared (no remount → no re-animation).
 * - Visibility is persisted in localStorage ('kimchi.dashboard'), seeded
 *   from config.showEvents (see chromeUiState).
 */
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';

import type { Problem, Run, Team, Verdict } from '@core/types';
import { appStore, type AppStore, type JudgeEvent } from '@store/appStore';
import { Balloon } from '@ui/icons';
import { useDashboardVisibility } from './chromeUiState';
import './chrome.css';

/**
 * Newest-first dedupe by run id: content comes from the newest event of the
 * run, position from its oldest event (in-place pending→judged update).
 */
export function dedupeEvents(events: readonly JudgeEvent[]): JudgeEvent[] {
  const newestByRun = new Map<string, JudgeEvent>();
  const slotByRun = new Map<string, number>();
  for (const event of events) {
    // `events` is newest first → the first hit per run id is its newest event…
    if (!newestByRun.has(event.run.id)) newestByRun.set(event.run.id, event);
    // …and the last write per run id is its oldest occurrence (the slot).
    slotByRun.set(event.run.id, event.eventId);
  }
  return [...newestByRun.values()].sort(
    (a, b) => (slotByRun.get(b.run.id) ?? 0) - (slotByRun.get(a.run.id) ?? 0),
  );
}

function eventText(run: Run, team: Team | undefined, problem: Problem | undefined): string {
  const teamName = team?.name ?? `Team ${run.teamId}`;
  const label = problem?.label ?? run.problemId;
  const minute = `(${run.minute} min.)`;
  switch (run.verdict) {
    case 'accepted':
      return `${teamName} got YES on ${label}! ${minute}`;
    case 'failed':
      return `${teamName} got NO on ${label} ${minute}`;
    case 'pending':
      return `${teamName} is judging on ${label} ${minute}`;
  }
}

const VERDICT_CLASS: Record<Verdict, string> = {
  accepted: 'kr-dash-item kr-dash-item--accepted',
  pending: 'kr-dash-item kr-dash-item--pending',
  failed: 'kr-dash-item kr-dash-item--failed',
};

export interface DashboardProps {
  store?: AppStore;
}

export function Dashboard({ store = appStore }: DashboardProps) {
  const mode = useStore(store, (state) => state.mode);
  const contest = useStore(store, (state) => state.contest);
  const events = useStore(store, (state) => state.recentEvents);
  const cap = useStore(store, (state) => state.config.maxNotifications);
  const [visible] = useDashboardVisibility(store);
  const [acceptedOnly, setAcceptedOnly] = useState(false);

  const problemsById = useMemo(() => {
    const map = new Map<string, Problem>();
    for (const problem of contest?.problems ?? []) map.set(problem.id, problem);
    return map;
  }, [contest]);

  const items = useMemo(() => {
    const deduped = dedupeEvents(events);
    const filtered = acceptedOnly
      ? deduped.filter((event) => event.run.verdict === 'accepted')
      : deduped;
    return filtered.slice(0, cap); // exactly maxNotifications, never more
  }, [events, acceptedOnly, cap]);

  if (mode !== 'spectator' || !visible) return null;

  return (
    <aside className="kr-dashboard" aria-label="Recent judge events">
      <div className="kr-dashboard__head">
        <h2 className="kr-dashboard__title">Events</h2>
        <button
          type="button"
          className={
            acceptedOnly ? 'kr-dashboard__filter kr-dashboard__filter--on' : 'kr-dashboard__filter'
          }
          title={acceptedOnly ? 'Show all judge events' : 'Show accepted runs only'}
          aria-label="Accepted only"
          aria-pressed={acceptedOnly}
          onClick={() => setAcceptedOnly((value) => !value)}
        >
          {acceptedOnly ? 'YES only' : 'all'}
        </button>
      </div>
      <ul className="kr-dashboard__list">
        {items.map(({ run }) => (
          <li key={run.id} className={VERDICT_CLASS[run.verdict]} data-run-id={run.id}>
            <Balloon
              color={problemsById.get(run.problemId)?.color ?? '#9aa0a6'}
              size="1.5em"
              className="kr-dash-item__balloon"
            />
            <span className="kr-dash-item__text">
              {eventText(run, contest?.teams.get(run.teamId), problemsById.get(run.problemId))}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
