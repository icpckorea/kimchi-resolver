/**
 * Timeline switch (header) and board-row selection (design 2026-11-15
 * §6.4–6.5), jsdom.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';

import type { Contest, OrgsIndex, Problem, Run, Team } from '@core/types';
import { computeStandings } from '@core/standings';
import { defaultConfig, type ResolvedConfig } from '@core/config';
import { createAppStore, type AppStore, type Scheduler } from '@store/appStore';
import { Header } from '@ui/chrome/Header';
import { ScoreboardView } from '@ui/scoreboard/ScoreboardView';
import { useTimelineBoardSelection } from '@ui/timeline/useTimelineSelection';

function stubViewport(mobile: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /max-width:\s*768px/.test(query) ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --- store harness --------------------------------------------------------

const feedContest = {
  title: 'Switch Contest',
  systemName: 'test',
  systemVersion: '1',
  problems: [{ id: 1, name: 'A', title: 'Alpha', color: 'red' }],
  teams: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `T${i + 1}`, group: `G${i + 1}` })),
};
const feedRuns = {
  time: { contestTime: 18000, noMoreUpdate: true, timestamp: 0 },
  runs: [{ id: 1, team: 1, problem: 1, result: 'Yes', submissionTime: 10 }],
};

async function bootStore(timeline: boolean, search = ''): Promise<AppStore> {
  const files: Record<string, unknown> = {
    'config.json': { source: { type: 'spotboard', apiBase: './' }, autoPlay: false, timeTravel: true, timeline: { enabled: timeline } },
    'contest.json': feedContest,
    'runs.json': feedRuns,
    'orgs/orgs.json': {},
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0];
    for (const [suffix, body] of Object.entries(files)) {
      if (path.endsWith(suffix)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const scheduler: Scheduler = { setInterval: () => 0, clearInterval: () => {} };
  const store = createAppStore({
    fetchImpl,
    scheduler,
    storage: null,
    createWebSocket: () => ({ onmessage: null, onerror: null, onclose: null, close() {} }),
  });
  await store.getState().boot(search);
  return store;
}

describe('header switch', () => {
  it('is absent when the timeline is disabled', async () => {
    stubViewport(false);
    const store = await bootStore(false);
    const { queryByRole } = render(<Header store={store} navigate={() => {}} />);
    expect(queryByRole('button', { name: 'Timeline' })).toBeNull();
  });

  it('switches views and counts the selected teams', async () => {
    stubViewport(false);
    const store = await bootStore(true);
    const { getByRole } = render(<Header store={store} navigate={() => {}} />);
    expect(getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe('true');
    act(() => {
      store.getState().toggleTimelineTeam('1');
      store.getState().toggleTimelineTeam('2');
    });
    fireEvent.click(getByRole('button', { name: 'Timeline (2)' }));
    expect(store.getState().view).toBe('timeline');
    expect(getByRole('button', { name: 'Timeline (2)' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('is hidden on mobile', async () => {
    stubViewport(true);
    const store = await bootStore(true);
    const { queryByRole } = render(<Header store={store} navigate={() => {}} />);
    expect(queryByRole('button', { name: 'Timeline' })).toBeNull();
  });
});

describe('board selection hook', () => {
  it('maps teams to their slot colors and reports a full selection', async () => {
    const store = await bootStore(true, '?teams=1,2,3,4,5,6');
    const { result } = renderHook(() => useTimelineBoardSelection(store));
    expect(result.current.selection?.get('1')).toBe('#2a78d6');
    expect(result.current.selection?.get('6')).toBe('#6250d6');
    act(() => result.current.onToggle?.('7'));
    expect(store.getState().timelineTeams).toHaveLength(6);
    expect(store.getState().systemMessages.map((m) => m.text)).toContain('The timeline shows up to 6 teams.');
    act(() => result.current.onToggle?.('1'));
    expect(store.getState().timelineTeams.map((t) => t.id)).not.toContain('1');
  });

  it('is inactive when the timeline is disabled', async () => {
    const store = await bootStore(false);
    const { result } = renderHook(() => useTimelineBoardSelection(store));
    expect(result.current.selection).toBeNull();
    expect(result.current.onToggle).toBeUndefined();
  });
});

// --- rows ------------------------------------------------------------------

function fixture(): { contest: Contest; runs: Run[] } {
  const problems: Problem[] = [{ id: 'p1', label: 'A', title: 'A', color: 'red', order: 0 }];
  const teams = new Map<string, Team>();
  for (const id of ['1', '2']) teams.set(id, { id, name: `Team ${id}`, group: `G${id}`, foreign: false });
  const runs: Run[] = [
    { id: '1', teamId: '1', problemId: 'p1', minute: 5, verdict: 'accepted', penaltyCounts: false, seq: 1 },
  ];
  return { contest: { title: 'x', systemName: 'x', systemVersion: '0', problems, teams }, runs };
}

function cfg(): ResolvedConfig {
  return {
    ...defaultConfig(),
    animation: false,
    replayRunId: null,
    replayTimeMinutes: null,
    searchQuery: null,
    followTeamId: '1',
    timelineView: false,
    timelineTeams: [],
  };
}

describe('board rows', () => {
  it('tints selected rows and toggles on click and Enter (desktop)', () => {
    stubViewport(false);
    const { contest, runs } = fixture();
    const onToggle = vi.fn();
    const { container } = render(
      <ScoreboardView
        snapshot={computeStandings(contest, runs)}
        problems={contest.problems}
        config={cfg()}
        orgs={{} as OrgsIndex}
        timelineSelection={new Map([['1', '#2a78d6']])}
        onToggleTimelineTeam={onToggle}
      />,
    );
    const row1 = container.querySelector('.team-row[data-team-id="1"]') as HTMLElement;
    const row2 = container.querySelector('.team-row[data-team-id="2"]') as HTMLElement;
    expect(row1.classList.contains('team-row--selected')).toBe(true);
    expect(row1.style.getPropertyValue('--kr-select-color')).toBe('#2a78d6');
    expect(row1.getAttribute('aria-pressed')).toBe('true');
    expect(row2.classList.contains('team-row--selected')).toBe(false);
    expect(row2.getAttribute('role')).toBe('button');
    expect(row2.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(row2);
    fireEvent.keyDown(row1, { key: 'Enter' });
    expect(onToggle.mock.calls).toEqual([['2'], ['1']]);
  });

  it('keeps the mobile detail tap and no selection on mobile', () => {
    stubViewport(true);
    const { contest, runs } = fixture();
    const onToggle = vi.fn();
    const { container } = render(
      <ScoreboardView
        snapshot={computeStandings(contest, runs)}
        problems={contest.problems}
        config={cfg()}
        orgs={{} as OrgsIndex}
        timelineSelection={new Map([['1', '#2a78d6']])}
        onToggleTimelineTeam={onToggle}
      />,
    );
    const row1 = container.querySelector('.team-row[data-team-id="1"]') as HTMLElement;
    expect(row1.classList.contains('team-row--selected')).toBe(false);
    fireEvent.click(row1);
    expect(onToggle).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
