import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Contest, Problem, Run, Team, Verdict } from '@core/types';
import { computeStandings } from '@core/standings';
import { appStore } from '@store/appStore';
import { PublishView } from '../../src/ui/publish/PublishView';
import { PublishControls } from '../../src/ui/publish/PublishControls';

// ---------------------------------------------------------------------------
// Fixture: three schools, ranks fixed by solve minute of p1.
//   rank 1 x1(X)  rank 2 x2(X)  rank 3 y1(Y)  rank 4 y2(Y)  rank 5 z1(Z)
// ---------------------------------------------------------------------------

function makeProblems(count: number): Problem[] {
  const labels = 'ABC';
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`,
    label: labels[i],
    title: `Problem ${labels[i]}`,
    color: 'red',
    order: i,
  }));
}

function makeContest(specs: { id: string; group: string }[]): Contest {
  const teams = new Map<string, Team>();
  for (const spec of specs) {
    teams.set(spec.id, {
      id: spec.id,
      name: `Team ${spec.id}`,
      group: spec.group,
      countryCode: 'KR',
      foreign: false,
    });
  }
  return {
    title: 'Publish Fixture Contest',
    systemName: 'fixture',
    systemVersion: '0',
    problems: makeProblems(2),
    teams,
  };
}

let seq = 0;
function run(teamId: string, problemId: string, minute: number, verdict: Verdict = 'accepted'): Run {
  seq += 1;
  return {
    id: String(seq),
    teamId,
    problemId,
    minute,
    verdict,
    penaltyCounts: verdict === 'failed',
    seq,
  };
}

const contest = makeContest([
  { id: 'x1', group: 'X' },
  { id: 'x2', group: 'X' },
  { id: 'y1', group: 'Y' },
  { id: 'y2', group: 'Y' },
  { id: 'z1', group: 'Z' },
]);
const snapshot = computeStandings(contest, [
  run('x1', 'p1', 10),
  run('x2', 'p1', 20),
  run('y1', 'p1', 30),
  run('y2', 'p1', 40),
  run('z1', 'p1', 50),
]);

const initialState = appStore.getState();

function seedStore(
  overrides: {
    siteScore?: number | null;
    invitedCutoff?: number | null;
    /** Stars are gated by config.apac.enabled (spec §13); most tests want them on. */
    apacEnabled?: boolean;
  } = {},
) {
  appStore.setState({
    status: 'ready',
    mode: 'publish',
    contest,
    snapshot,
    config: { ...initialState.config, apac: { enabled: overrides.apacEnabled ?? true } },
    siteScore: overrides.siteScore ?? null,
    invitedCutoff: overrides.invitedCutoff ?? null,
  });
}

function starOf(teamId: string): SVGSVGElement | null {
  const row = document.querySelector(`[data-team-id="${teamId}"]`);
  expect(row).not.toBeNull();
  return row!.querySelector('svg.kr-apac-star');
}

function starFill(teamId: string): string | undefined {
  return starOf(teamId)?.querySelector('polygon')?.getAttribute('fill') ?? undefined;
}

const FILL = { bronze: '#c07a3e', silver: '#b8bfc9', gold: '#e6b422' } as const;

beforeEach(() => {
  seq = 0;
});

afterEach(() => {
  cleanup();
  appStore.setState(initialState, false);
});

// ---------------------------------------------------------------------------
// Gate on missing site score
// ---------------------------------------------------------------------------

describe('PublishView gate', () => {
  it('shows the instruction panel instead of the board when siteScore is null', () => {
    seedStore({ siteScore: null });
    render(<PublishView />);
    expect(screen.getByText('site score를 입력하세요')).toBeTruthy();
    expect(document.querySelector('.publish-board')).toBeNull();
    // The input form is still there so the value can be typed in.
    expect(document.getElementById('publish-site-score')).not.toBeNull();
  });

  it('shows the board once a valid site score is typed', () => {
    seedStore({ siteScore: null });
    render(<PublishView />);
    const input = document.getElementById('publish-site-score') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    expect(appStore.getState().siteScore).toBe(5);
    expect(screen.queryByText('site score를 입력하세요')).toBeNull();
    expect(document.querySelector('.publish-board')).not.toBeNull();
    expect(screen.getByText('Team x1')).toBeTruthy();
  });

  it('re-closes the gate when the site score becomes invalid again', () => {
    seedStore({ siteScore: 5 });
    render(<PublishView />);
    expect(document.querySelector('.publish-board')).not.toBeNull();
    const input = document.getElementById('publish-site-score') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(appStore.getState().siteScore).toBeNull();
    expect(screen.getByText('site score를 입력하세요')).toBeTruthy();
    expect(document.querySelector('.publish-board')).toBeNull();
  });

  it('renders chrome with title and clock but no header buttons', () => {
    seedStore({ siteScore: 5 });
    render(<PublishView />);
    expect(screen.getByText('Publish Fixture Contest')).toBeTruthy();
    const clock = document.querySelector('.publish-clock');
    expect(clock?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(document.querySelector('.publish-header button')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Star tiers on the board (final phase; champion from standings[0])
// ---------------------------------------------------------------------------

describe('PublishView APAC stars', () => {
  it("renders a gold champion, bronze champion schoolmates and silver for every other school", () => {
    seedStore({ siteScore: 5 });
    render(<PublishView />);
    expect(starFill('x1')).toBe(FILL.gold); // champion — World Finals direct entry
    // x2 shares school X with the champion. WF takes one team per school, so
    // x2 is not an invitation candidate → stays bronze (spec §13 rule 2).
    expect(starFill('x2')).toBe(FILL.bronze);
    expect(starFill('y1')).toBe(FILL.silver);
    expect(starFill('y2')).toBe(FILL.silver);
    expect(starFill('z1')).toBe(FILL.silver);
  });

  it('promotes silver teams within the invited cutoff to gold (boundary ≤)', () => {
    // filteredRank: x1 1, x2 2, y1 3, y2 4, z1 5 — champion and his schoolmate
    // occupy slots 1 and 2 even though they are not promotion candidates.
    // cutoff 1, siteScore 2 → invited iff (filteredRank − 1)/2 ≤ 1 ⇔ fr ≤ 3.
    seedStore({ siteScore: 2, invitedCutoff: 1 });
    render(<PublishView />);
    expect(starFill('y1')).toBe(FILL.gold); // fr 3 → (3−1)/2 = 1 ≤ 1
    expect(starFill('y2')).toBe(FILL.silver); // fr 4 → 1.5 > 1
    expect(starFill('z1')).toBe(FILL.silver); // fr 5 → 2 > 1
    // Bronze is never promoted, even though x2 sits at fr 2.
    expect(starFill('x2')).toBe(FILL.bronze);
    expect(starFill('x1')).toBe(FILL.gold);
  });

  it('does not promote when the cutoff box is empty', () => {
    seedStore({ siteScore: 2, invitedCutoff: null });
    render(<PublishView />);
    expect(starFill('y1')).toBe(FILL.silver);
    expect(starFill('y2')).toBe(FILL.silver);
    expect(starFill('x2')).toBe(FILL.bronze);
  });

  it('gives no star to schoolRank ≥ 4 teams (per-school cap)', () => {
    // Local fixture: school W fields four teams, all ahead of everyone else.
    const capContest = makeContest([
      { id: 'w1', group: 'W' },
      { id: 'w2', group: 'W' },
      { id: 'w3', group: 'W' },
      { id: 'w4', group: 'W' },
      { id: 'v1', group: 'V' },
    ]);
    const capSnapshot = computeStandings(capContest, [
      run('w1', 'p1', 10),
      run('w2', 'p1', 20),
      run('w3', 'p1', 30),
      run('w4', 'p1', 40),
      run('v1', 'p1', 50),
    ]);
    seedStore({ siteScore: 5 });
    appStore.setState({ contest: capContest, snapshot: capSnapshot });
    render(<PublishView />);
    expect(starFill('w1')).toBe(FILL.gold); // champion
    expect(starFill('w2')).toBe(FILL.bronze); // champion schoolmate
    expect(starFill('w3')).toBe(FILL.bronze); // champion schoolmate
    expect(starOf('w4')).toBeNull(); // schoolRank 4 → no star at all
    expect(starFill('v1')).toBe(FILL.silver);
  });

  it('shows no stars and no star slot when config.apac.enabled is false (spec §13)', () => {
    seedStore({ siteScore: 5, apacEnabled: false });
    render(<PublishView />);
    // The board itself still renders (the site-score gate is independent)…
    expect(document.querySelector('.publish-board')).not.toBeNull();
    expect(screen.getByText('Team x1')).toBeTruthy();
    // …but the APAC star column is absent entirely.
    expect(document.querySelector('.apac-slot')).toBeNull();
    expect(document.querySelector('svg.kr-apac-star')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Spin flag on tier change
// ---------------------------------------------------------------------------

describe('PublishView star spin', () => {
  it('spins all stars on first appearance (star granted)', () => {
    seedStore({ siteScore: 5 });
    render(<PublishView />);
    for (const teamId of ['x1', 'x2', 'y1']) {
      expect(starOf(teamId)?.classList.contains('kr-apac-star--spin')).toBe(true);
    }
  });

  it('spins only the stars whose tier changed when the cutoff changes', () => {
    seedStore({ siteScore: 2, invitedCutoff: null });
    render(<PublishView />);
    // Settle: stars rendered once, previous tiers recorded.
    act(() => {
      appStore.setState({}); // no-op notify; effects already flushed by render
    });
    const cutoff = document.getElementById('publish-invited-cutoff') as HTMLInputElement;
    fireEvent.change(cutoff, { target: { value: '1' } });
    // y1 (filteredRank 3): silver → gold — must spin with the new tier.
    const y1 = starOf('y1');
    expect(y1?.querySelector('polygon')?.getAttribute('fill')).toBe(FILL.gold);
    expect(y1?.classList.contains('kr-apac-star--spin')).toBe(true);
    // Unchanged tiers must not spin — including the champion's bronze
    // schoolmate x2, which sits at filteredRank 2 but is never promoted.
    expect(starFill('x2')).toBe(FILL.bronze);
    expect(starOf('x2')?.classList.contains('kr-apac-star--spin')).toBe(false);
    expect(starOf('y2')?.classList.contains('kr-apac-star--spin')).toBe(false);
    expect(starOf('x1')?.classList.contains('kr-apac-star--spin')).toBe(false);
  });

  it('spins again when the cutoff change demotes the star back to silver', () => {
    seedStore({ siteScore: 2, invitedCutoff: 1 });
    render(<PublishView />);
    const cutoff = document.getElementById('publish-invited-cutoff') as HTMLInputElement;
    fireEvent.change(cutoff, { target: { value: '0' } });
    const y1 = starOf('y1');
    expect(y1?.querySelector('polygon')?.getAttribute('fill')).toBe(FILL.silver);
    expect(y1?.classList.contains('kr-apac-star--spin')).toBe(true);
    expect(starOf('y2')?.classList.contains('kr-apac-star--spin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PublishControls seeding + commit behavior
// ---------------------------------------------------------------------------

describe('PublishControls', () => {
  it('seeds both inputs from the store (URL/config values)', () => {
    seedStore({ siteScore: 84, invitedCutoff: 2.5 });
    render(<PublishControls />);
    expect((document.getElementById('publish-site-score') as HTMLInputElement).value).toBe('84');
    expect((document.getElementById('publish-invited-cutoff') as HTMLInputElement).value).toBe(
      '2.5',
    );
  });

  it('commits valid numbers to the store and null for invalid input', () => {
    seedStore({ siteScore: null, invitedCutoff: null });
    render(<PublishControls />);
    const site = document.getElementById('publish-site-score') as HTMLInputElement;
    const cutoff = document.getElementById('publish-invited-cutoff') as HTMLInputElement;

    fireEvent.change(site, { target: { value: '12' } });
    expect(appStore.getState().siteScore).toBe(12);
    fireEvent.change(site, { target: { value: '-3' } }); // must be > 0
    expect(appStore.getState().siteScore).toBeNull();
    expect(site.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(cutoff, { target: { value: '0' } }); // ≥ 0 is fine
    expect(appStore.getState().invitedCutoff).toBe(0);
    fireEvent.change(cutoff, { target: { value: '-1' } });
    expect(appStore.getState().invitedCutoff).toBeNull();
  });

  it('marks the required site score as invalid when empty, but cutoff not', () => {
    seedStore({ siteScore: null, invitedCutoff: null });
    render(<PublishControls />);
    const site = document.getElementById('publish-site-score') as HTMLInputElement;
    const cutoff = document.getElementById('publish-invited-cutoff') as HTMLInputElement;
    expect(site.getAttribute('aria-invalid')).toBe('true');
    expect(site.getAttribute('aria-required')).toBe('true');
    expect(cutoff.getAttribute('aria-invalid')).toBeNull();
  });
});
