/**
 * Timeline view (design 2026-11-15 §6.6): team picker + rank chart. The
 * chart covers the whole contest from the raw run list; only the "Now"
 * marker and the picker order follow the current board minute.
 */
import { useCallback, useMemo } from 'react';
import { useStore } from 'zustand';

import { computeRankTimeline, timelineEndMinute } from '@core/timeline';
import { appStore, type AppStore } from '@store/appStore';
import { currentSliderMinute } from '@ui/chrome/TimeSlider';
import { useTimelineBoardSelection } from './useTimelineSelection';
import { RankChart, type ChartTeam } from './RankChart';
import { TeamPicker } from './TeamPicker';
import './timeline.css';

export function TimelineView({ store = appStore }: { store?: AppStore }) {
  const contest = useStore(store, (s) => s.contest);
  const runs = useStore(store, (s) => s.timelineRuns);
  const contestTimeSec = useStore(store, (s) => s.contestTimeSec);
  const pendingCount = useStore(store, (s) => s.pendingCount);
  const replayTimeMinutes = useStore(store, (s) => s.config.replayTimeMinutes);
  const lastAppliedMinute = useStore(store, (s) => s.lastAppliedMinute);
  const freezeMinute = useStore(store, (s) => s.config.timeline.freezeMinute);
  const selected = useStore(store, (s) => s.timelineTeams);
  const { onToggle } = useTimelineBoardSelection(store);

  const endMinute = timelineEndMinute(contestTimeSec, runs);
  const timeline = useMemo(
    () => (contest === null ? null : computeRankTimeline(contest, runs, endMinute)),
    [contest, runs, endMinute],
  );
  const current = Math.min(
    currentSliderMinute({ contestTimeSec, pendingCount, replayTimeMinutes, lastAppliedMinute }),
    endMinute,
  );
  const teams = useMemo(() => (contest === null ? [] : [...contest.teams.values()]), [contest]);
  const rankOf = useCallback(
    (id: string) => timeline?.ranks.get(id)?.[current] ?? teams.length,
    [timeline, current, teams.length],
  );
  const chartTeams: ChartTeam[] = useMemo(
    () =>
      selected
        .filter((t) => contest?.teams.has(t.id))
        .map((t) => ({ id: t.id, slot: t.slot, name: contest!.teams.get(t.id)!.name })),
    [selected, contest],
  );

  if (contest === null || timeline === null) return null;
  return (
    <div className="tl-view">
      <TeamPicker
        teams={teams}
        rankOf={rankOf}
        selected={selected}
        onToggle={(id) => onToggle?.(id)}
        onRemove={(id) => store.getState().removeTimelineTeam(id)}
      />
      <RankChart
        timeline={timeline}
        problems={contest.problems}
        teams={chartTeams}
        currentMinute={current}
        freezeMinute={freezeMinute}
      />
    </div>
  );
}
