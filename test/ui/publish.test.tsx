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
    /** Cross-site invitations (spec §13 rule 3.1). */
    alreadyInvited?: { teamIds: string[]; groups: string[] };
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
    alreadyInvited: overrides.alreadyInvited ?? { teamIds: [], groups: [] },
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
    // x2 shares school X with the champion, whose school leaves the scored
    // list entirely (spec §13 rule 3.1) → bronze, and never promoted.
    expect(starFill('x2')).toBe(FILL.bronze);
    expect(starFill('y1')).toBe(FILL.silver);
    expect(starFill('y2')).toBe(FILL.silver);
    expect(starFill('z1')).toBe(FILL.silver);
  });

  it('promotes silver teams within the invited cutoff to gold (boundary ≤)', () => {
    // School X (the champion's) is out of the scored list, so the filtered
    // ranks are y1 1, y2 2, z1 3. siteScore 2, cutoff 0.5 → invited iff
    // (filteredRank − 1)/2 ≤ 0.5 ⇔ fr ≤ 2.
    seedStore({ siteScore: 2, invitedCutoff: 0.5 });
    render(<PublishView />);
    expect(starFill('y1')).toBe(FILL.gold); // fr 1 → 0 ≤ 0.5
    expect(starFill('y2')).toBe(FILL.gold); // fr 2 → 0.5 — exactly the cutoff
    expect(starFill('z1')).toBe(FILL.silver); // fr 3 → 1 > 0.5
    // Bronze is never promoted, and the champion is gold either way.
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

  it('removes an already-invited school entirely and lifts everyone below it', () => {
    // School Y is invited elsewhere → the scored list is just z1 (fr 1).
    seedStore({
      siteScore: 2,
      invitedCutoff: 0,
      alreadyInvited: { teamIds: [], groups: ['Y'] },
    });
    render(<PublishView />);
    expect(starFill('y1')).toBe(FILL.bronze); // out of the running…
    expect(starFill('y2')).toBe(FILL.bronze); // …both of them
    expect(starFill('z1')).toBe(FILL.gold); // fr 1 → 0 ≤ 0
    expect(starFill('x1')).toBe(FILL.gold); // champion
  });

  it('shows an already-invited team itself as gold and its schoolmates as bronze', () => {
    seedStore({ siteScore: 2, invitedCutoff: null, alreadyInvited: { teamIds: ['y1'], groups: [] } });
    render(<PublishView />);
    expect(starFill('y1')).toBe(FILL.gold); // invited at another regional
    expect(starFill('y2')).toBe(FILL.bronze); // schoolmate — out of the running
    expect(starFill('z1')).toBe(FILL.silver); // now the only candidate
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
    fireEvent.change(cutoff, { target: { value: '0' } });
    // y1 (filteredRank 1, score 0): silver → gold — must spin with the tier.
    const y1 = starOf('y1');
    expect(y1?.querySelector('polygon')?.getAttribute('fill')).toBe(FILL.gold);
    expect(y1?.classList.contains('kr-apac-star--spin')).toBe(true);
    // Unchanged tiers must not spin — including the champion's bronze
    // schoolmate x2, which is out of the scored list and never promoted.
    expect(starFill('x2')).toBe(FILL.bronze);
    expect(starOf('x2')?.classList.contains('kr-apac-star--spin')).toBe(false);
    expect(starOf('y2')?.classList.contains('kr-apac-star--spin')).toBe(false);
    expect(starOf('x1')?.classList.contains('kr-apac-star--spin')).toBe(false);
  });

  it('spins again when the cutoff change demotes the star back to silver', () => {
    // y2 is filteredRank 2 → score 0.5: gold at cutoff 0.5, silver at 0.4.
    seedStore({ siteScore: 2, invitedCutoff: 0.5 });
    render(<PublishView />);
    const cutoff = document.getElementById('publish-invited-cutoff') as HTMLInputElement;
    fireEvent.change(cutoff, { target: { value: '0.4' } });
    const y2 = starOf('y2');
    expect(y2?.querySelector('polygon')?.getAttribute('fill')).toBe(FILL.silver);
    expect(y2?.classList.contains('kr-apac-star--spin')).toBe(true);
    // y1 (score 0) is gold under both cutoffs → no spin.
    expect(starFill('y1')).toBe(FILL.gold);
    expect(starOf('y1')?.classList.contains('kr-apac-star--spin')).toBe(false);
  });

  it('spins the stars a cross-site invitation edit changes', () => {
    seedStore({ siteScore: 2, invitedCutoff: null });
    render(<PublishView />);
    act(() => {
      appStore.setState({}); // settle: previous tiers recorded
    });
    const groups = document.getElementById('publish-already-invited-groups') as HTMLInputElement;
    fireEvent.change(groups, { target: { value: 'Y' } });
    expect(appStore.getState().alreadyInvited.groups).toEqual(['Y']);
    // School Y leaves the scored list: silver → bronze, spinning.
    expect(starFill('y1')).toBe(FILL.bronze);
    expect(starOf('y1')?.classList.contains('kr-apac-star--spin')).toBe(true);
    // z1 stays silver (still a candidate, just at a better rank) → no spin.
    expect(starFill('z1')).toBe(FILL.silver);
    expect(starOf('z1')?.classList.contains('kr-apac-star--spin')).toBe(false);
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

  it('seeds the already-invited fields from the store as comma-separated text', () => {
    seedStore({ alreadyInvited: { teamIds: ['t1', 't2'], groups: ['National Taiwan University'] } });
    render(<PublishControls />);
    expect(
      (document.getElementById('publish-already-invited-teams') as HTMLInputElement).value,
    ).toBe('t1, t2');
    expect(
      (document.getElementById('publish-already-invited-groups') as HTMLInputElement).value,
    ).toBe('National Taiwan University');
  });

  it('commits the already-invited lists, trimming blanks', () => {
    seedStore();
    render(<PublishControls />);
    const teams = document.getElementById('publish-already-invited-teams') as HTMLInputElement;
    const groups = document.getElementById('publish-already-invited-groups') as HTMLInputElement;

    fireEvent.change(teams, { target: { value: ' t1 ,, t2 ,' } });
    expect(appStore.getState().alreadyInvited.teamIds).toEqual(['t1', 't2']);
    fireEvent.change(groups, { target: { value: 'Kyoto U, NTU' } });
    expect(appStore.getState().alreadyInvited).toEqual({
      teamIds: ['t1', 't2'],
      groups: ['Kyoto U', 'NTU'],
    });

    fireEvent.change(teams, { target: { value: '' } });
    expect(appStore.getState().alreadyInvited.teamIds).toEqual([]);
  });

  it('warns that ranks may be optimistic while both already-invited lists are empty', () => {
    seedStore();
    render(<PublishControls />);
    const hint = document.querySelector('.publish-controls-hint');
    expect(hint?.textContent).toContain('낙관적');

    // Naming one invited school removes the warning.
    const groups = document.getElementById('publish-already-invited-groups') as HTMLInputElement;
    fireEvent.change(groups, { target: { value: 'NTU' } });
    expect(document.querySelector('.publish-controls-hint')).toBeNull();
  });
});
