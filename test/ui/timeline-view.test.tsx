/**
 * Timeline view (design 2026-11-15 §6.6), jsdom: team picker and rank chart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { createAppStore, type AppStore, type Scheduler } from '@store/appStore';
import { TimelineView } from '@ui/timeline/TimelineView';

afterEach(() => cleanup());

const feedContest = {
  title: 'View Contest',
  systemName: 'test',
  systemVersion: '1',
  problems: [
    { id: 1, name: 'A', title: 'Alpha', color: 'red' },
    { id: 2, name: 'B', title: 'Beta', color: 'blue' },
  ],
  teams: [
    { id: 1, name: 'Early Bird', group: 'KAIST' },
    { id: 2, name: 'Late Comer', group: 'Seoul National University' },
    { id: 3, name: 'Nobody', group: 'POSTECH' },
  ],
};

// At minute 15: Early Bird 1st, Late Comer 2nd. Final: Late Comer 1st.
const feedRuns = {
  time: { contestTime: 18000, noMoreUpdate: true, timestamp: 0 },
  runs: [
    { id: 1, team: 1, problem: 1, result: 'Yes', submissionTime: 10 },
    { id: 2, team: 2, problem: 1, result: 'No - Wrong Answer', submissionTime: 12 },
    { id: 3, team: 2, problem: 1, result: 'Yes', submissionTime: 20 },
    { id: 4, team: 2, problem: 2, result: 'No - Wrong Answer', submissionTime: 25 },
    { id: 5, team: 2, problem: 2, result: 'No - Wrong Answer', submissionTime: 25 },
    { id: 6, team: 2, problem: 2, result: 'Yes', submissionTime: 30 },
    // after Early Bird solved A
    { id: 7, team: 1, problem: 1, result: 'No - Wrong Answer', submissionTime: 40 },
  ],
};

async function bootStore(search: string, timeline: Record<string, unknown> = { enabled: true }): Promise<AppStore> {
  const files: Record<string, unknown> = {
    'config.json': { source: { type: 'spotboard', apiBase: './' }, autoPlay: false, timeTravel: true, timeline },
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

const pickerNames = (container: HTMLElement) =>
  [...container.querySelectorAll('.tl-picker-row .tl-picker-name')].map((el) => el.firstChild?.textContent);

describe('TimelineView picker', () => {
  it('shows the empty state and lists teams by the rank at the current minute', async () => {
    const store = await bootStore('?view=timeline&time=15');
    const { container, getByText } = render(<TimelineView store={store} />);
    expect(getByText('Pick teams on the left.')).toBeTruthy();
    expect(pickerNames(container)).toEqual(['Early Bird', 'Late Comer', 'Nobody']);
  });

  it('search filters by team name and school; chips remove teams', async () => {
    const store = await bootStore('?view=timeline&teams=1,2');
    const { container, getByLabelText, getByRole } = render(<TimelineView store={store} />);
    fireEvent.change(getByLabelText('Search teams or schools'), { target: { value: 'seoul' } });
    expect(pickerNames(container)).toEqual(['Late Comer']);
    fireEvent.change(getByLabelText('Search teams or schools'), { target: { value: 'early' } });
    expect(pickerNames(container)).toEqual(['Early Bird']);
    fireEvent.click(getByRole('button', { name: 'Remove Early Bird' }));
    expect(store.getState().timelineTeams.map((t) => t.id)).toEqual(['2']);
  });

  it('checkbox toggles a team', async () => {
    const store = await bootStore('?view=timeline');
    const { getByRole } = render(<TimelineView store={store} />);
    act(() => {
      fireEvent.click(getByRole('checkbox', { name: /Nobody/ }));
    });
    expect(store.getState().timelineTeams.map((t) => t.id)).toEqual(['3']);
  });
});

describe('TimelineView chart', () => {
  it('one team: vertical submission lines and grouped labels, after-solve runs included', async () => {
    const store = await bootStore('?view=timeline&teams=2');
    const { container, getByText } = render(<TimelineView store={store} />);
    expect(getByText('Late Comer · Rank timeline')).toBeTruthy();
    const lines = container.querySelectorAll('line[data-kind]');
    // A rejected 12, A accepted 20, B rejected ×2 at 25, B accepted 30.
    expect(lines).toHaveLength(4);
    expect([...container.querySelectorAll('text.tl-sub-label')].map((t) => t.textContent)).toContain('B ×2');
    const one = await bootStore('?view=timeline&teams=1');
    cleanup();
    const r = render(<TimelineView store={one} />);
    expect(r.container.querySelectorAll('line[data-kind]')).toHaveLength(2); // incl. the after-solve run
  });

  it('two teams: dots and rings on the lines, no vertical lines, no after-solve marks', async () => {
    const store = await bootStore('?view=timeline&teams=1,2');
    const { container, getByText } = render(<TimelineView store={store} />);
    expect(getByText('Rank timeline')).toBeTruthy();
    expect(container.querySelectorAll('line[data-kind]')).toHaveLength(0);
    expect(container.querySelectorAll('circle[data-kind="accepted"]')).toHaveLength(3);
    // Late Comer: A at 12, B ×2 at 25 (one mark per group); Early Bird's minute-40 run is after its solve.
    expect(container.querySelectorAll('circle[data-kind="rejected"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="end-label-1"]')?.textContent).toBe('2nd Early Bird');
    expect(container.querySelector('[data-testid="end-label-2"]')?.textContent).toBe('1st Late Comer');
  });

  it('does not depend on the current minute (only the Now marker does)', async () => {
    const atEnd = await bootStore('?view=timeline&teams=1,2');
    const a = render(<TimelineView store={atEnd} />);
    const pathEnd = a.container.querySelector('path[data-team="2"]')?.getAttribute('d');
    expect(a.container.querySelector('[data-testid="now-marker"]')).toBeNull();
    cleanup();
    const mid = await bootStore('?view=timeline&teams=1,2&time=15');
    const b = render(<TimelineView store={mid} />);
    expect(b.container.querySelector('path[data-team="2"]')?.getAttribute('d')).toBe(pathEnd);
    expect(b.container.querySelector('[data-testid="now-marker"]')?.textContent).toBe('Now 00:15');
  });

  it('y-axis toggle zooms to the selected teams; freeze band only with freezeMinute', async () => {
    const store = await bootStore('?view=timeline&teams=1,2');
    const { container, getByRole } = render(<TimelineView store={store} />);
    const ticks = () => [...container.querySelectorAll('.tl-y-tick')].map((t) => t.textContent);
    expect(ticks().at(-1)).toBe('3');
    expect(container.querySelector('[data-testid="freeze-band"]')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Selected teams' }));
    expect(getByRole('button', { name: 'Selected teams' }).getAttribute('aria-pressed')).toBe('true');
    cleanup();
    const frozen = await bootStore('?view=timeline&teams=1', { enabled: true, freezeMinute: 210 });
    const f = render(<TimelineView store={frozen} />);
    expect(f.container.querySelector('[data-testid="freeze-band"]')).not.toBeNull();
  });
});
