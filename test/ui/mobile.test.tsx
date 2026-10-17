/**
 * Mobile layout tests (spec §14, jsdom with a matchMedia stub).
 *
 * - ≤768px: compact rows (ranks | APAC star | flag | name + group |
 *   solved/penalty), balloons fully hidden, spine kept, no cell grid.
 * - Tap a row → detail modal with the full cell grid (same color rules),
 *   every badge (auto + manual) and the penalty breakdown; no balloons.
 *   Closes via the X button, the backdrop and Escape.
 * - Desktop (query does not match) renders exactly the old layout.
 * - Award mode keeps the desktop layout regardless of viewport.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Contest, Run, Snapshot, Team, Verdict } from '@core/types';
import { computeStandings } from '@core/standings';
import { applyUrlOverrides, defaultConfig, type ResolvedConfig } from '@core/config';
import { createAppStore } from '@store/appStore';
import { Scoreboard } from '@ui/scoreboard/Scoreboard';
import { penaltyFormula } from '@ui/scoreboard/TeamDetailModal';
import { AwardView } from '@ui/award/AwardView';

// ---------------------------------------------------------------------------
// matchMedia stub
// ---------------------------------------------------------------------------

/** Stub window.matchMedia: the 768px query answers `mobile`, others false. */
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

// ---------------------------------------------------------------------------
// Fixtures (same shape as scoreboard.test.tsx)
// ---------------------------------------------------------------------------

const baseConfig: ResolvedConfig = applyUrlOverrides(defaultConfig(), '').config;

function cfg(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...baseConfig, ...over };
}

function makeTeam(
  id: string,
  name: string,
  group: string,
  foreign = false,
  countryCode?: string,
): Team {
  return { id, name, group, foreign, countryCode };
}

function makeContest(teams: Team[], problemIds: string[]): Contest {
  return {
    title: 'test contest',
    systemName: 'test',
    systemVersion: '0',
    problems: problemIds.map((id, i) => ({
      id,
      label: id,
      title: `Problem ${id}`,
      color: 'red',
      order: i,
    })),
    teams: new Map(teams.map((t) => [t.id, t])),
  };
}

function runFactory() {
  let seq = 0;
  return (teamId: string, problemId: string, minute: number, verdict: Verdict): Run => {
    seq += 1;
    return { id: String(seq), teamId, problemId, minute, verdict, penaltyCounts: true, seq };
  };
}

/** t1: A@5 (contest first), B@30 (contest last). t2: A@10 (+1 fail), B failed. */
function fixture(): { contest: Contest; snapshot: Snapshot } {
  const contest = makeContest(
    [
      makeTeam('t1', 'Alpha', 'KAIST', false, 'KR'),
      makeTeam('t2', 'Beta', 'SNU', false, 'KR'),
      makeTeam('t3', 'Gamma', 'Fuzhou University', true, 'CN'),
    ],
    ['A', 'B'],
  );
  const r = runFactory();
  const runs: Run[] = [
    r('t1', 'A', 5, 'accepted'),
    r('t2', 'A', 8, 'failed'),
    r('t2', 'A', 10, 'accepted'),
    r('t3', 'A', 20, 'accepted'),
    r('t1', 'B', 30, 'accepted'),
    r('t2', 'B', 40, 'failed'),
    r('t3', 'B', 45, 'pending'),
  ];
  return { contest, snapshot: computeStandings(contest, runs) };
}

function renderBoard(
  config: ResolvedConfig = cfg(),
  extra: Partial<Parameters<typeof Scoreboard>[0]> = {},
) {
  const { contest, snapshot } = fixture();
  return render(
    <Scoreboard
      snapshot={snapshot}
      problems={contest.problems}
      config={config}
      orgs={{}}
      {...extra}
    />,
  );
}

function row(container: HTMLElement, teamId: string): HTMLElement {
  const el = container.querySelector(`.team-row[data-team-id="${teamId}"]`);
  expect(el, `row ${teamId}`).not.toBeNull();
  return el as HTMLElement;
}

// ---------------------------------------------------------------------------
// Compact row (≤768px)
// ---------------------------------------------------------------------------

describe('mobile compact rows', () => {
  it('renders ranks, star slot, flag, name + group and solved/penalty only', () => {
    stubViewport(true);
    const { container } = renderBoard(cfg({ apac: { enabled: true } }), {
      apacStars: new Map([['t1', { tier: 'gold' as const }]]),
    });

    expect(container.querySelector('.scoreboard--mobile')).not.toBeNull();

    const t1 = row(container, 't1');
    expect(t1.classList.contains('team-row--compact')).toBe(true);
    // kept: spine, ranks, APAC star, flag, name + group
    expect(t1.querySelector('.solved-count')?.textContent).toBe('2');
    expect(t1.querySelector('.icpc-rank')?.textContent).toBe('1st');
    expect(t1.querySelector('.domestic-rank')?.textContent).toBe('1st');
    expect(t1.querySelector('.kr-apac-star')).not.toBeNull();
    expect(t1.querySelector('.team-flag')).not.toBeNull();
    expect(t1.querySelector('.team-name')?.textContent).toBe('Alpha');
    expect(t1.querySelector('.team-group')?.textContent).toBe('KAIST');
    // summary: solved / penalty (t1: 2 solved, 5 + 30 = 35)
    expect(t1.querySelector('.compact-solved')?.textContent).toBe('2');
    expect(t1.querySelector('.compact-penalty')?.textContent).toBe('35');
    // hidden: cell grid, balloons, badges, desktop penalty memo
    expect(t1.querySelector('.results')).toBeNull();
    expect(t1.querySelector('.problem-result')).toBeNull();
    expect(t1.querySelector('.balloons')).toBeNull();
    expect(t1.querySelector('.team-badges')).toBeNull();
    expect(t1.querySelector('.team-penalty')).toBeNull();
  });

  it('hides balloons even when showBalloons is on', () => {
    stubViewport(true);
    const { container } = renderBoard(cfg({ showBalloons: true }));
    expect(container.querySelector('.balloons')).toBeNull();
  });

  it('lists every filtered team (pagination is hidden on mobile)', () => {
    stubViewport(true);
    const { container } = renderBoard(cfg({ pagination: true, paginationSize: 1 }), {
      page: 0,
    });
    expect(container.querySelectorAll('.team-row')).toHaveLength(3);
    expect(container.querySelector('.scoreboard')?.getAttribute('data-page-count')).toBe('1');
  });
});

describe('mobile row value (publish regional)', () => {
  const rowDecor = new Map([
    ['t1', { value: '0.1740' }],
    ['t2', {}],
  ]);

  it('drops the value column from the compact row (the name keeps the room)', () => {
    stubViewport(true);
    const { container } = renderBoard(cfg(), { rowDecor });
    expect(container.querySelector('.team-row-value')).toBeNull();
    expect(container.querySelector('.scoreboard--has-value')).toBeNull();
  });

  it('shows the value in the detail modal instead', () => {
    stubViewport(true);
    const { container } = renderBoard(cfg(), { rowDecor });
    fireEvent.click(row(container, 't1'));
    expect(screen.getByRole('dialog').querySelector('.team-detail-value')?.textContent).toContain(
      '0.1740',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(row(container, 't2'));
    expect(screen.getByRole('dialog').querySelector('.team-detail-value')).toBeNull();
  });

  it('keeps the value column on desktop', () => {
    stubViewport(false);
    const { container } = renderBoard(cfg(), { rowDecor });
    expect(row(container, 't1').querySelector('.team-row-value')?.textContent).toBe('0.1740');
    expect(container.querySelector('.scoreboard--has-value')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------

describe('mobile team detail modal', () => {
  it('opens on tap with the full cell grid, all badges and the penalty detail', () => {
    stubViewport(true);
    const { container } = renderBoard(cfg(), {
      manualLabels: new Map([['t1', ['금상 수상자']]]),
    });

    fireEvent.click(row(container, 't1'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    // Full cell grid with the same color rules as the desktop board.
    const cellA = dialog.querySelector('[data-problem-id="A"]') as HTMLElement;
    const cellB = dialog.querySelector('[data-problem-id="B"]') as HTMLElement;
    expect(cellA.classList.contains('solved-first')).toBe(true);
    expect(cellA.classList.contains('contest-first-solve')).toBe(true); // sparkle
    expect(cellB.classList.contains('contest-last-solve')).toBe(true); // purple

    // ALL badges: auto + manual.
    const badges = Array.from(dialog.querySelectorAll('.team-badge')).map(
      (el) => el.textContent,
    );
    expect(badges).toContain('got first yes of this contest!');
    expect(badges).toContain('got last yes of this contest!');
    expect(badges).toContain('금상 수상자');

    // Penalty detail lines + total; no balloons anywhere in the modal.
    const penalty = dialog.querySelector('.team-detail-penalty') as HTMLElement;
    expect(penalty.textContent).toContain('35 min.');
    expect(dialog.querySelector('.balloons')).toBeNull();
    expect(dialog.querySelector('.kr-balloon')).toBeNull();
  });

  it('shows the per-problem contribution formula ("10 + 20 × 1 = 30")', () => {
    stubViewport(true);
    const { container } = renderBoard();

    fireEvent.click(row(container, 't2')); // A solved at 10 after 1 fail

    const dialog = screen.getByRole('dialog');
    const lines = Array.from(dialog.querySelectorAll('.penalty-line')).map(
      (el) => el.textContent,
    );
    expect(lines[0]).toBe('A10 + 20 × 1 = 30');
    expect(lines[lines.length - 1]).toBe('total30 min.');
    // failed B contributes no line: only solved problems + total
    expect(lines).toHaveLength(2);
  });

  it('closes via the X button, the backdrop and Escape', () => {
    stubViewport(true);
    const { container } = renderBoard();

    // X button
    fireEvent.click(row(container, 't1'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // backdrop tap
    fireEvent.click(row(container, 't1'));
    fireEvent.click(screen.getByTestId('team-detail-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Escape
    fireEvent.click(row(container, 't1'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('focuses the close button when opened', () => {
    stubViewport(true);
    const { container } = renderBoard();
    fireEvent.click(row(container, 't1'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('returns focus to the opening row when closed', () => {
    stubViewport(true);
    const { container } = renderBoard();

    const t1 = row(container, 't1');
    t1.focus();
    fireEvent.keyDown(t1, { key: 'Enter' }); // keyboard-open (role=button)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(t1);
  });

  it('does not survive a mobile → desktop → mobile viewport round-trip', () => {
    stubViewport(true);
    const { contest, snapshot } = fixture();
    // A fresh element per render — reusing one element object would let React
    // bail out of the re-render and never re-read the media query.
    const board = () => (
      <Scoreboard snapshot={snapshot} problems={contest.problems} config={cfg()} orgs={{}} />
    );
    const { container, rerender } = render(board());

    fireEvent.click(row(container, 't1'));
    expect(screen.queryByRole('dialog')).not.toBeNull();

    // Viewport grows past 768px (e.g. tablet rotation): the modal closes…
    stubViewport(false);
    rerender(board());
    expect(screen.queryByRole('dialog')).toBeNull();

    // …and stays closed when the viewport shrinks back under 768px.
    stubViewport(true);
    rerender(board());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('penaltyFormula renders minute-only and full forms', () => {
    const base = {
      teamId: 't',
      problemId: 'A',
      verdict: 'accepted' as const,
      attempts: 1,
      isFirstSolve: false,
      isLastSolve: false,
      isContestFirstSolve: false,
      isContestLastSolve: false,
    };
    expect(penaltyFormula({ ...base, failedAttempts: 0, solvedMinute: 42 })).toBe('42');
    expect(penaltyFormula({ ...base, failedAttempts: 2, solvedMinute: 20, attempts: 3 })).toBe(
      '20 + 20 × 2 = 60',
    );
  });
});

// ---------------------------------------------------------------------------
// Desktop stays untouched
// ---------------------------------------------------------------------------

describe('desktop layout (query does not match)', () => {
  it('keeps the full row and never opens a modal on click', () => {
    stubViewport(false);
    const { container } = renderBoard();

    expect(container.querySelector('.scoreboard--mobile')).toBeNull();
    const t1 = row(container, 't1');
    expect(t1.classList.contains('team-row--compact')).toBe(false);
    expect(t1.querySelectorAll('.problem-result')).toHaveLength(2);
    expect(t1.querySelector('.balloons')).not.toBeNull();
    expect(t1.querySelector('.team-badges')).not.toBeNull();
    expect(t1.querySelector('.team-penalty')?.textContent).toBe('35 min.');
    expect(t1.querySelector('.team-score-compact')).toBeNull();

    fireEvent.click(t1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('works without any matchMedia (defaults to desktop)', () => {
    // jsdom has no matchMedia by default and none is stubbed here.
    const { container } = renderBoard();
    expect(container.querySelector('.scoreboard--mobile')).toBeNull();
    expect(row(container, 't1').querySelectorAll('.problem-result')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Award mode is exempt (spec §14: projector-only, keeps the desktop layout)
// ---------------------------------------------------------------------------

describe('award mode on a mobile viewport', () => {
  const configJson = { source: { type: 'spotboard', apiBase: './sample/' } };
  const contestJson = {
    title: 'Fixture Contest',
    systemName: 'test',
    systemVersion: '1',
    problems: [
      { id: 0, name: 'A', title: 'Alpha', color: 'red' },
      { id: 1, name: 'B', title: 'Beta', color: 'blue' },
    ],
    teams: [
      { id: 1, name: 'Alpha Team', group: 'Univ One' },
      { id: 2, name: 'Beta Team', group: 'Univ Two' },
    ],
  };
  const runsJson = {
    time: { contestTime: 18000, noMoreUpdate: true, timestamp: 0 },
    runs: [
      { id: 1, team: 1, problem: 0, result: 'Yes', submissionTime: 10 },
      { id: 2, team: 2, problem: 0, result: 'Yes', submissionTime: 20 },
      { id: 3, team: 2, problem: 1, result: 'No - Wrong Answer', submissionTime: 60 },
    ],
  };
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('config.json')) return jsonResponse(configJson);
    if (url.includes('contest.json')) return jsonResponse(contestJson);
    if (url.includes('runs.json')) return jsonResponse(runsJson);
    return new Response('not found', { status: 404 });
  };
  const noopScheduler = { setInterval: () => 0, clearInterval: () => {} };

  it('keeps the full desktop rows: cells present, no compact UI, no modal', async () => {
    stubViewport(true); // mobile viewport — award mode must ignore it
    const store = createAppStore({ fetchImpl, scheduler: noopScheduler });
    await act(async () => {
      await store.getState().boot('?award=true&r=2');
    });
    expect(store.getState().mode).toBe('award');

    // awards.json is served by the store (404 here → no medalists, spec §6).
    const { container } = render(<AwardView store={store} />);

    const rows = container.querySelectorAll('.team-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.problem-result').length).toBeGreaterThan(0);
    expect(container.querySelector('.team-row--compact')).toBeNull();
    expect(container.querySelector('.team-score-compact')).toBeNull();

    fireEvent.click(rows[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
