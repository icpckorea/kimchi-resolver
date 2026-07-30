/**
 * Chrome tests (jsdom): header clock + mode gating, search debounce,
 * pagination nav, dashboard cap/filter/in-place updates + persisted
 * visibility, desktop notification gating (mocked Notification), and
 * dismissible system messages.
 *
 * Uses the same injectable harness pattern as test/store/appStore.test.ts:
 * fetch serves in-memory fixtures, timers go through a manual scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook } from '@testing-library/react';

import { createAppStore, type AppStore, type Scheduler } from '@store/appStore';
import { Header, formatClock } from '@ui/chrome/Header';
import { Dashboard } from '@ui/chrome/Dashboard';
import { SystemMessages } from '@ui/chrome/SystemMessages';
import { useDesktopNotifications } from '@ui/chrome/useDesktopNotifications';
import { DASHBOARD_STORAGE_KEY, resetChromeUi } from '@ui/chrome/chromeUiState';

// ---------------------------------------------------------------------------
// Fixtures + harness
// ---------------------------------------------------------------------------

const smallContest = {
  title: 'Chrome Test Contest',
  systemName: 'test',
  systemVersion: '1',
  problems: [
    { id: 1, name: 'A', title: 'Alpha', color: 'red' },
    { id: 2, name: 'B', title: 'Beta', color: 'blue' },
  ],
  teams: [
    { id: 1, name: 'One', group: 'KAIST' },
    { id: 2, name: 'Two', group: 'SNU' },
    { id: 3, name: 'Three', group: 'POSTECH' },
  ],
};

const smallOrgs = {
  KAIST: { country: 'KR' },
  SNU: { country: 'KR' },
  POSTECH: { country: 'KR' },
};

/** 6 runs, ids 1..6 ascending. Runs 1 and 4 are rejections. */
function smallRuns(noMoreUpdate = false) {
  return {
    time: { contestTime: 18000, noMoreUpdate, timestamp: 0 },
    runs: [
      { id: 1, team: 1, problem: 1, result: 'No - Wrong Answer', submissionTime: 5 },
      { id: 2, team: 1, problem: 1, result: 'Yes', submissionTime: 10 },
      { id: 3, team: 2, problem: 1, result: 'Yes', submissionTime: 20 },
      { id: 4, team: 2, problem: 2, result: 'No - Wrong Answer', submissionTime: 30 },
      { id: 5, team: 3, problem: 2, result: 'Yes', submissionTime: 40 },
      { id: 6, team: 1, problem: 2, result: 'Yes', submissionTime: 50 },
    ],
  };
}

type StubValue = unknown | (() => unknown);

function makeFetch(files: Record<string, StubValue>) {
  const impl = (async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0];
    for (const [suffix, value] of Object.entries(files)) {
      if (path.endsWith(suffix)) {
        const body = typeof value === 'function' ? (value as () => unknown)() : value;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;
  return impl;
}

/** Manual scheduler: nothing fires unless a test asks for it. */
function makeScheduler(): Scheduler {
  return { setInterval: () => 0, clearInterval: () => undefined };
}

function makeStore(files: Record<string, StubValue>): AppStore {
  return createAppStore({
    fetchImpl: makeFetch(files),
    scheduler: makeScheduler(),
    createWebSocket: () => {
      throw new Error('no ws in tests');
    },
    rng: () => 0.99,
  });
}

const smallFiles = (): Record<string, StubValue> => ({
  'contest.json': smallContest,
  'runs.json': smallRuns(),
  'orgs/orgs.json': smallOrgs,
});

async function bootStore(files: Record<string, StubValue>, search = ''): Promise<AppStore> {
  const store = makeStore(files);
  await store.getState().boot(search);
  expect(store.getState().status).toBe('ready');
  return store;
}

function dashboardRunIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.kr-dash-item')).map(
    (li) => li.getAttribute('data-run-id') ?? '',
  );
}

beforeEach(() => {
  localStorage.clear();
  resetChromeUi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Clock formatting
// ---------------------------------------------------------------------------

describe('formatClock', () => {
  it('formats elapsed contest seconds as HH:MM', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(59)).toBe('00:00');
    expect(formatClock(60)).toBe('00:01');
    expect(formatClock(3661)).toBe('01:01');
    expect(formatClock(18000)).toBe('05:00');
  });

  it('renders --:-- when the contest time is unknown', () => {
    expect(formatClock(null)).toBe('--:--');
  });
});

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe('Header', () => {
  it('shows the contest title, the clock and all six action buttons', async () => {
    const store = await bootStore(smallFiles());
    const { container, getByText, getByLabelText } = render(<Header store={store} />);

    expect(getByText('Chrome Test Contest')).toBeTruthy();
    expect(container.querySelector('.kr-header__clock-text')?.textContent).toBe('05:00');
    for (const label of [
      'Desktop notifications',
      'Update now',
      'Auto-play',
      'Feed one run',
      'Feed all runs',
      'Events dashboard',
    ]) {
      expect(getByLabelText(label)).toBeTruthy();
    }
    // Tooltips via title attributes.
    expect(getByLabelText('Feed all runs').getAttribute('title')).toBe('Feed all queued runs');
    // Everything applied at boot → no pending badge.
    expect(container.querySelector('.kr-hbtn__badge')).toBeNull();
  });

  it('shows --:-- before any feed data arrives', () => {
    const store = makeStore({}); // never booted: contestTimeSec is null
    const { container } = render(<Header store={store} />);
    expect(container.querySelector('.kr-header__clock-text')?.textContent).toBe('--:--');
  });

  it('is hidden entirely in award mode', async () => {
    const store = await bootStore(smallFiles(), '?award=true&r=3');
    const { container } = render(<Header store={store} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows only the title and the clock in publish mode', async () => {
    const store = await bootStore(smallFiles(), '?publish=true&site_score=3');
    const { container, getByText } = render(<Header store={store} />);
    expect(getByText('Chrome Test Contest')).toBeTruthy();
    expect(container.querySelector('.kr-header__clock-text')?.textContent).toBe('05:00');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('input')).toBeNull();
  });

  it('marks the title when the feed reports no more updates', async () => {
    const store = await bootStore({ ...smallFiles(), 'runs.json': smallRuns(true) });
    const { container } = render(<Header store={store} />);
    expect(container.querySelector('.kr-header__title--final')).not.toBeNull();
    expect(container.querySelector('.kr-header__final-chip')).not.toBeNull();
  });

  it('badges the update button with the pending count and feeds runs', async () => {
    const store = await bootStore(smallFiles(), '?r=3');
    const { container, getByLabelText } = render(<Header store={store} />);
    expect(container.querySelector('.kr-hbtn__badge')?.textContent).toBe('3');

    fireEvent.click(getByLabelText('Feed one run'));
    expect(store.getState().pendingCount).toBe(2);
    expect(container.querySelector('.kr-hbtn__badge')?.textContent).toBe('2');

    fireEvent.click(getByLabelText('Feed all runs'));
    expect(store.getState().pendingCount).toBe(0);
    expect(container.querySelector('.kr-hbtn__badge')).toBeNull();
  });

  it('toggles autoplay through the play/pause button', async () => {
    const store = await bootStore(smallFiles());
    const { getByLabelText } = render(<Header store={store} />);
    const button = getByLabelText('Auto-play');
    expect(store.getState().playing).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(store.getState().playing).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('debounces the search input into the store by 100 ms', async () => {
    const store = await bootStore(smallFiles());
    const { getByLabelText } = render(<Header store={store} />);
    const input = getByLabelText('Search teams');

    fireEvent.change(input, { target: { value: 'kaist' } });
    expect(store.getState().config.searchQuery).toBeNull(); // not yet committed
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(store.getState().config.searchQuery).toBe('kaist');

    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(store.getState().config.searchQuery).toBeNull(); // empty clears
  });

  it('shows the page navigation only when pagination is on', async () => {
    const plain = await bootStore(smallFiles());
    const { container: withoutNav } = render(<Header store={plain} />);
    expect(withoutNav.querySelector('.kr-header__pages')).toBeNull();

    const store = await bootStore({
      ...smallFiles(),
      'config.json': { pagination: true, paginationSize: 2 },
    });
    const { getByText, getByLabelText } = render(<Header store={store} />);
    expect(getByText('page 1/2')).toBeTruthy(); // 3 teams / 2 per page
    expect((getByLabelText('Previous page') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(getByLabelText('Next page'));
    expect(getByText('page 2/2')).toBeTruthy();
    expect((getByLabelText('Next page') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByLabelText('Previous page'));
    expect(getByText('page 1/2')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

describe('Dashboard', () => {
  it('is seeded from config.showEvents and toggled + persisted via the header button', async () => {
    const store = await bootStore(smallFiles()); // showEvents defaults to false
    const { container, getByLabelText } = render(
      <>
        <Header store={store} />
        <Dashboard store={store} />
      </>,
    );
    expect(container.querySelector('.kr-dashboard')).toBeNull();

    fireEvent.click(getByLabelText('Events dashboard'));
    expect(container.querySelector('.kr-dashboard')).not.toBeNull();
    expect(localStorage.getItem(DASHBOARD_STORAGE_KEY)).toBe('1');

    fireEvent.click(getByLabelText('Events dashboard'));
    expect(container.querySelector('.kr-dashboard')).toBeNull();
    expect(localStorage.getItem(DASHBOARD_STORAGE_KEY)).toBe('0');
  });

  it('a stored user choice wins over config.showEvents', async () => {
    localStorage.setItem(DASHBOARD_STORAGE_KEY, '0');
    resetChromeUi();
    const store = await bootStore({ ...smallFiles(), 'config.json': { showEvents: true } });
    const { container } = render(<Dashboard store={store} />);
    expect(container.querySelector('.kr-dashboard')).toBeNull();
  });

  it('lists judge events newest first with balloon icons and minute text', async () => {
    const store = await bootStore({ ...smallFiles(), 'config.json': { showEvents: true } });
    const { container, getByText } = render(<Dashboard store={store} />);

    expect(dashboardRunIds(container)).toEqual(['6', '5', '4', '3', '2', '1']);
    expect(getByText('One got YES on B! (50 min.)')).toBeTruthy();
    expect(getByText('Two got NO on B (30 min.)')).toBeTruthy();
    // Each entry carries a tinted balloon.
    expect(container.querySelectorAll('.kr-dash-item__balloon')).toHaveLength(6);
    const failed = container.querySelector('[data-run-id="4"]');
    expect(failed?.className).toContain('kr-dash-item--failed');
  });

  it('caps the list at exactly maxNotifications', async () => {
    const store = await bootStore(
      { ...smallFiles(), 'config.json': { showEvents: true, maxNotifications: 3 } },
      '?r=0',
    );
    const { container } = render(<Dashboard store={store} />);
    expect(dashboardRunIds(container)).toEqual([]);

    act(() => {
      store.getState().feedAllQueued();
    });
    expect(dashboardRunIds(container)).toEqual(['6', '5', '4']); // exactly 3, no sentinel
  });

  it('filters to accepted runs only', async () => {
    const store = await bootStore({ ...smallFiles(), 'config.json': { showEvents: true } });
    const { container, getByLabelText } = render(<Dashboard store={store} />);
    expect(dashboardRunIds(container)).toHaveLength(6);

    fireEvent.click(getByLabelText('Accepted only'));
    expect(dashboardRunIds(container)).toEqual(['6', '5', '3', '2']);
    for (const li of container.querySelectorAll('.kr-dash-item')) {
      expect(li.className).toContain('kr-dash-item--accepted');
    }

    fireEvent.click(getByLabelText('Accepted only'));
    expect(dashboardRunIds(container)).toHaveLength(6);
  });

  it('updates a replaced pending run in place (same slot, new verdict)', async () => {
    const pendingFeed = smallRuns();
    pendingFeed.runs[3] = { ...pendingFeed.runs[3], result: '' }; // run 4 pending
    let served: unknown = pendingFeed;
    const store = await bootStore({
      'contest.json': smallContest,
      'orgs/orgs.json': smallOrgs,
      'config.json': { showEvents: true },
      'runs.json': () => served,
    });
    const { container } = render(<Dashboard store={store} />);

    expect(dashboardRunIds(container)).toEqual(['6', '5', '4', '3', '2', '1']);
    expect(container.querySelector('[data-run-id="4"]')?.className).toContain(
      'kr-dash-item--pending',
    );

    // The re-poll judges run 4 as accepted.
    const judged = smallRuns();
    judged.runs[3] = { ...judged.runs[3], result: 'Yes' };
    served = judged;
    await act(async () => {
      await store.getState().pollNow();
    });
    act(() => {
      store.getState().feedAllQueued();
    });

    // Same slot (no new entry, no reorder), verdict updated in place.
    expect(dashboardRunIds(container)).toEqual(['6', '5', '4', '3', '2', '1']);
    expect(container.querySelector('[data-run-id="4"]')?.className).toContain(
      'kr-dash-item--accepted',
    );
    expect(container.querySelector('[data-run-id="4"]')?.textContent).toContain(
      'Two got YES on B!',
    );
  });

  it('is not rendered in award mode', async () => {
    const store = await bootStore(
      { ...smallFiles(), 'config.json': { showEvents: true } },
      '?award=true&r=3',
    );
    const { container } = render(<Dashboard store={store} />);
    expect(container.querySelector('.kr-dashboard')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Desktop notifications
// ---------------------------------------------------------------------------

interface FakeNotificationInstance {
  title: string;
  body: string | undefined;
  closed: boolean;
}

function makeFakeNotification(initialPermission: NotificationPermission) {
  const created: FakeNotificationInstance[] = [];
  class FakeNotification {
    static permission: NotificationPermission = initialPermission;
    static requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
      FakeNotification.permission = 'granted';
      return 'granted';
    });
    title: string;
    body: string | undefined;
    closed = false;
    constructor(title: string, options?: { body?: string }) {
      this.title = title;
      this.body = options?.body;
      created.push(this);
    }
    close(): void {
      this.closed = true;
    }
  }
  return { FakeNotification, created };
}

describe('useDesktopNotifications', () => {
  it('uses the two-step permission flow: first toggle asks, second enables', async () => {
    const { FakeNotification } = makeFakeNotification('default');
    vi.stubGlobal('Notification', FakeNotification);
    const store = await bootStore(smallFiles(), '?r=3');
    const { result } = renderHook(() => useDesktopNotifications(store));

    expect(result.current.supported).toBe(true);
    expect(result.current.permission).toBe('default');

    act(() => {
      result.current.toggle();
    });
    await act(async () => {}); // flush the requestPermission promise
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(result.current.enabled).toBe(false); // first press only requests
    expect(result.current.permission).toBe('granted');

    act(() => {
      result.current.toggle();
    });
    expect(result.current.enabled).toBe(true); // second press enables
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('notifies accepted runs only, with team/problem/rank details, and auto-closes', async () => {
    const { FakeNotification, created } = makeFakeNotification('granted');
    vi.stubGlobal('Notification', FakeNotification);
    const store = await bootStore(smallFiles(), '?r=3');
    const { result } = renderHook(() => useDesktopNotifications(store, { autoCloseMs: 15 }));

    act(() => {
      result.current.toggle(); // permission already granted → enables directly
    });
    expect(result.current.enabled).toBe(true);

    // Run 4 is a rejection → no notification.
    await act(async () => {
      store.getState().feedOne();
      await Promise.resolve();
    });
    expect(created).toHaveLength(0);

    // Run 5: team Three solves B at minute 40 → notification with the NEW rank.
    await act(async () => {
      store.getState().feedOne();
      await Promise.resolve();
    });
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Three has solved B!');
    expect(created[0].body).toContain('Run 5 at 40 min.');
    expect(created[0].body).toContain('attempt 1');
    expect(created[0].body).toContain('now ranked #3');

    // Standard close() after the auto-close delay (no cancel() bug).
    expect(created[0].closed).toBe(false);
    await vi.waitFor(() => {
      expect(created[0].closed).toBe(true);
    });
  });

  it('stays silent while disabled even with permission granted', async () => {
    const { FakeNotification, created } = makeFakeNotification('granted');
    vi.stubGlobal('Notification', FakeNotification);
    const store = await bootStore(smallFiles(), '?r=3');
    renderHook(() => useDesktopNotifications(store));

    await act(async () => {
      store.getState().feedAllQueued(); // includes accepted runs 5 and 6
      await Promise.resolve();
    });
    expect(created).toHaveLength(0);
  });

  it('reports unsupported browsers through a system message', async () => {
    // No Notification global at all (jsdom default).
    const store = await bootStore(smallFiles());
    const { result } = renderHook(() => useDesktopNotifications(store));
    expect(result.current.supported).toBe(false);
    expect(result.current.permission).toBe('unsupported');

    act(() => {
      result.current.toggle();
    });
    expect(result.current.enabled).toBe(false);
    expect(
      store.getState().systemMessages.some((m) => m.text.includes('not supported')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// System messages
// ---------------------------------------------------------------------------

describe('SystemMessages', () => {
  it('renders nothing when there are no messages', () => {
    const store = makeStore({});
    const { container } = render(<SystemMessages store={store} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows leveled messages and dismisses them individually', () => {
    const store = makeStore({});
    act(() => {
      store.getState().addSystemMessage('error', 'Loading the contest failed');
      store.getState().addSystemMessage('warning', 'School logo missing for: SNU');
    });
    const { container, getByText, getAllByLabelText } = render(<SystemMessages store={store} />);

    expect(getByText('Loading the contest failed').closest('.kr-sysmsg')?.className).toContain(
      'kr-sysmsg--error',
    );
    expect(
      getByText('School logo missing for: SNU').closest('.kr-sysmsg')?.className,
    ).toContain('kr-sysmsg--warning');

    fireEvent.click(getAllByLabelText('Dismiss message')[0]);
    expect(store.getState().systemMessages).toHaveLength(1);
    expect(container.querySelectorAll('.kr-sysmsg')).toHaveLength(1);
    expect(getByText('School logo missing for: SNU')).toBeTruthy();
  });

  it('surfaces boot-time config errors from the store', async () => {
    const store = await bootStore({
      ...smallFiles(),
      'config.json': { maxNotifications: 'lots' },
    });
    const { container } = render(<SystemMessages store={store} />);
    const texts = Array.from(container.querySelectorAll('.kr-sysmsg__text')).map(
      (el) => el.textContent ?? '',
    );
    expect(texts.some((text) => text.includes('maxNotifications'))).toBe(true);
  });
});
