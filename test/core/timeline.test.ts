import { describe, expect, it } from 'vitest';
import type { Contest, Problem, Run, Team, Verdict } from '@core/types';
import { computeStandings } from '@core/standings';
import {
  computeRankTimeline,
  mergeRuns,
  TIMELINE_COLORS,
  TIMELINE_MAX_TEAMS,
  timelineEndMinute,
} from '@core/timeline';

const LABELS = 'ABC';

function makeContest(ids: string[]): Contest {
  const problems: Problem[] = [0, 1, 2].map((i) => ({
    id: `p${i + 1}`,
    label: LABELS[i],
    title: `Problem ${LABELS[i]}`,
    color: 'red',
    order: i,
  }));
  const teams = new Map<string, Team>();
  for (const id of ids) teams.set(id, { id, name: `Team ${id}`, group: `G${id}`, foreign: false });
  return { title: 'T', systemName: 'x', systemVersion: '0', problems, teams };
}

let seq = 0;
function run(
  teamId: string,
  problemId: string,
  minute: number,
  verdict: Verdict,
  opts: { penaltyCounts?: boolean; id?: string } = {},
): Run {
  seq += 1;
  return {
    id: opts.id ?? String(seq),
    teamId,
    problemId,
    minute,
    verdict,
    penaltyCounts: opts.penaltyCounts ?? verdict === 'failed',
    seq,
  };
}

const contest = makeContest(['1', '2', '3', '4']);
// 1 and 2 tie at minute 20 (both solve p1 at minute 20, no failures).
// 3 gets a no-penalty compile error, then solves p1 at 30.
// 4 has a pending run at 25.
// 1 resubmits p1 after its solve (minute 40, rejected).
const RUNS: Run[] = [
  run('1', 'p1', 20, 'accepted'),
  run('2', 'p1', 20, 'accepted'),
  run('3', 'p1', 10, 'failed', { penaltyCounts: false }),
  run('4', 'p2', 25, 'pending'),
  run('3', 'p1', 30, 'accepted'),
  run('2', 'p2', 35, 'failed'),
  run('1', 'p1', 40, 'failed'),
  run('2', 'p2', 50, 'accepted'),
  run('4', 'p3', 59, 'failed'),
  run('4', 'p3', 59, 'failed'),
];

describe('computeRankTimeline', () => {
  const timeline = computeRankTimeline(contest, RUNS, 60);

  it('matches computeStandings at every minute (ties, compile errors, pending)', () => {
    expect(timeline.endMinute).toBe(60);
    expect(timeline.teamCount).toBe(4);
    for (let t = 0; t <= 60; t++) {
      const snap = computeStandings(contest, RUNS.filter((r) => r.minute <= t));
      for (const id of ['1', '2', '3', '4']) {
        expect(timeline.ranks.get(id)![t], `team ${id} minute ${t}`).toBe(snap.byTeam.get(id)!.icpcRank);
      }
    }
    expect(timeline.ranks.get('1')![20]).toBe(1);
    expect(timeline.ranks.get('2')![20]).toBe(1);
  });

  it('afterSolve runs are kept and change nothing', () => {
    const late = timeline.events.get('1')!.find((e) => e.minute === 40)!;
    expect(late).toMatchObject({ problemId: 'p1', kind: 'rejected', afterSolve: true, count: 1 });
    const without = computeRankTimeline(contest, RUNS.filter((r) => !(r.teamId === '1' && r.minute === 40)), 60);
    for (const id of ['1', '2', '3', '4']) expect(timeline.ranks.get(id)).toEqual(without.ranks.get(id));
  });

  it('groups same-minute runs of one problem and kind', () => {
    const events = timeline.events.get('4')!;
    expect(events.filter((e) => e.problemId === 'p3')).toEqual([
      expect.objectContaining({ minute: 59, kind: 'rejected', count: 2, afterSolve: false }),
    ]);
  });

  it('classifies no-penalty and pending runs', () => {
    expect(timeline.events.get('3')![0]).toMatchObject({ minute: 10, kind: 'noPenalty' });
    expect(timeline.events.get('4')![0]).toMatchObject({ minute: 25, kind: 'pending' });
    expect(timeline.events.get('1')![0]).toMatchObject({ minute: 20, kind: 'accepted', afterSolve: false });
  });
});

describe('timelineEndMinute', () => {
  it('uses the slider maximum, at least the last run minute', () => {
    expect(timelineEndMinute(18000, RUNS)).toBe(300);
    expect(timelineEndMinute(17950, [])).toBe(300);
    expect(timelineEndMinute(null, [run('1', 'p1', 12, 'failed')])).toBe(12);
    expect(timelineEndMinute(600, [run('1', 'p1', 12, 'failed')])).toBe(12);
    expect(timelineEndMinute(null, [])).toBe(0);
  });
});

describe('mergeRuns', () => {
  it('replaces by id and keeps the others', () => {
    const a = run('1', 'p1', 5, 'pending', { id: 'a' });
    const b = run('2', 'p1', 6, 'failed', { id: 'b' });
    const first = mergeRuns(new Map(), [a, b]);
    const judged = { ...a, verdict: 'accepted' as const };
    const second = mergeRuns(first, [judged]);
    expect(first.get('a')!.verdict).toBe('pending');
    expect(second.get('a')!.verdict).toBe('accepted');
    expect(second.get('b')).toBe(b);
    expect(second.size).toBe(2);
  });
});

describe('constants', () => {
  it('six colors in the fixed slot order', () => {
    expect(TIMELINE_MAX_TEAMS).toBe(6);
    expect(TIMELINE_COLORS).toEqual(['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6']);
  });
});
