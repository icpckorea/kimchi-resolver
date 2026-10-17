import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Contest, Problem, Run, Snapshot, Team, Verdict } from '@core/types';
import { computeStandings } from '@core/standings';
import {
  parsePublishState,
  type PublishMode,
  type RegionalSimInputs,
} from '@core/publishState';
import { appStore, type PrelimInputs } from '@store/appStore';
import { PublishView } from '../../src/ui/publish/PublishView';

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

/**
 * Regional inputs whose computed S is exactly `siteScore`: every coefficient
 * is 0 except the preliminary team count's, which is 1 (S = T_p). Without a
 * site score the default coefficients apply to the fixture's own counts.
 */
function regionalInputs(overrides: {
  siteScore?: number;
  invitedCutoff?: number | null;
  alreadyInvited?: { teamIds: string[]; groups: string[] };
}): RegionalSimInputs {
  const base = initialState.regionalInputs;
  return {
    ...base,
    ...(overrides.siteScore !== undefined
      ? {
          prelimTeams: overrides.siteScore,
          coefficients: {
            regionalSchools: 0,
            regionalTeams: 0,
            prelimSchools: 0,
            prelimTeams: 1,
            foreignTeams: 0,
          },
        }
      : {}),
    cutoff: overrides.invitedCutoff ?? null,
    invitedTeamIds: overrides.alreadyInvited?.teamIds ?? [],
    invitedGroups: overrides.alreadyInvited?.groups ?? [],
  };
}

function seedStore(
  overrides: {
    /** Publish mode; most tests here are about the regional stars. */
    mode?: PublishMode;
    /** Site score S, reached through the regional inputs (see regionalInputs). */
    siteScore?: number;
    invitedCutoff?: number | null;
    /** Award-mode switch; the publish mode alone decides the stars (spec §3). */
    apacEnabled?: boolean;
    /** Cross-site invitations (spec §13 rule 3.1). */
    alreadyInvited?: { teamIds: string[]; groups: string[] };
    prelim?: Partial<PrelimInputs>;
    fromStorage?: boolean;
    contest?: Contest;
    snapshot?: Snapshot;
  } = {},
) {
  appStore.setState({
    status: 'ready',
    mode: 'publish',
    contest: overrides.contest ?? contest,
    snapshot: overrides.snapshot ?? snapshot,
    config: {
      ...initialState.config,
      apac: { enabled: overrides.apacEnabled ?? true },
      publish: { ...initialState.config.publish, mode: overrides.mode ?? 'regional' },
    },
    regionalInputs: regionalInputs(overrides),
    prelimInputs: { ...initialState.prelimInputs, ...overrides.prelim },
    publishInputsFromStorage: overrides.fromStorage ?? false,
  });
}

function rowOf(teamId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-team-id="${teamId}"]`);
  expect(row, `row ${teamId}`).not.toBeNull();
  return row!;
}

function starOf(teamId: string): SVGSVGElement | null {
  return rowOf(teamId).querySelector('svg.kr-apac-star');
}

function starFill(teamId: string): string | undefined {
  return starOf(teamId)?.querySelector('polygon')?.getAttribute('fill') ?? undefined;
}

function valueOf(teamId: string): string | undefined {
  return rowOf(teamId).querySelector('.team-row-value')?.textContent ?? undefined;
}

/** Stage icon of a row: its data-stage and accessible name. */
function stageOf(teamId: string): { stage: string | null; name: string | null } | undefined {
  const icon = rowOf(teamId).querySelector('svg[data-stage]');
  if (icon === null) return undefined;
  return { stage: icon.getAttribute('data-stage'), name: icon.getAttribute('aria-label') };
}

function isAdvance(teamId: string): boolean {
  return rowOf(teamId).classList.contains('team-row--advance');
}

function isDimmed(teamId: string): boolean {
  return rowOf(teamId).classList.contains('team-row--dimmed');
}

function field(id: string): HTMLInputElement {
  const input = document.getElementById(id) as HTMLInputElement | null;
  expect(input, `field #${id}`).not.toBeNull();
  return input!;
}

function type(id: string, value: string): void {
  fireEvent.change(field(id), { target: { value } });
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '확정 결과 저장' }) as HTMLButtonElement;
}

const FILL = { bronze: '#c07a3e', silver: '#b8bfc9', gold: '#e6b422' } as const;

beforeEach(() => {
  seq = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  appStore.setState(initialState, false);
});

// ---------------------------------------------------------------------------
// off mode (spec §7)
// ---------------------------------------------------------------------------

describe('PublishView off mode', () => {
  it('off mode shows the board and the save button, no inputs', () => {
    seedStore({ mode: 'off' });
    render(<PublishView />);
    expect(document.querySelector('.publish-board')).not.toBeNull();
    expect(screen.getByText('Team x1')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    expect(document.querySelectorAll('input')).toHaveLength(0);
    // No yellow rows, no stars, no values.
    expect(document.querySelector('.team-row--advance')).toBeNull();
    expect(document.querySelector('svg.kr-apac-star')).toBeNull();
    expect(document.querySelector('.team-row-value')).toBeNull();
  });

  it('renders chrome with title and clock but no header buttons', () => {
    seedStore({ mode: 'off' });
    render(<PublishView />);
    expect(screen.getByText('Publish Fixture Contest')).toBeTruthy();
    const clock = document.querySelector('.publish-clock');
    expect(clock?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(document.querySelector('.publish-header button')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// preliminary mode (spec §5.2)
// ---------------------------------------------------------------------------

describe('PublishView preliminary mode', () => {
  it('shows no selection and an input hint while T or K is empty', () => {
    seedStore({ mode: 'preliminary', prelim: { totalTeams: null, k: null } });
    render(<PublishView />);
    expect(screen.getByText('진출 팀 수와 K를 입력하세요')).toBeTruthy();
    expect(document.querySelector('.team-row--advance')).toBeNull();
    expect(document.querySelector('svg.kr-apac-star')).toBeNull();
  });

  it('preliminary: entering T and K paints selected rows yellow and shows the summary', () => {
    seedStore({ mode: 'preliminary', prelim: { totalTeams: null, topN: 30, k: null } });
    render(<PublishView />);
    type('publish-prelim-total', '4');
    type('publish-prelim-topn', '1');
    type('publish-prelim-k', '1');
    expect(appStore.getState().prelimInputs).toMatchObject({ totalTeams: 4, topN: 1, k: 1 });

    // top: x1; school: Y's best y1, Z's best z1; fill: x2 (standings order).
    expect(isAdvance('x1')).toBe(true);
    expect(isAdvance('y1')).toBe(true);
    expect(isAdvance('z1')).toBe(true);
    expect(isAdvance('x2')).toBe(true);
    expect(isAdvance('y2')).toBe(false);
    expect(stageOf('x1')).toEqual({ stage: 'top', name: '상위 팀 (학교 무관)' });
    expect(stageOf('y1')).toEqual({ stage: 'school', name: '학교 대표 팀' });
    expect(stageOf('x2')).toEqual({ stage: 'fill', name: '남은 자리를 채운 팀' });
    expect(stageOf('y2')).toBeUndefined();
    // The icons replace the words: no text tag on any row.
    expect(document.querySelector('.team-row-tag')).toBeNull();
    // A compact legend next to the summary: icon + Korean meaning, with N, K and counts.
    const legend = document.querySelector('.publish-prelim-legend');
    expect(legend).not.toBeNull();
    expect(
      [...(legend?.querySelectorAll('svg[data-stage]') ?? [])].map((e) => e.getAttribute('data-stage')),
    ).toEqual(['top', 'school', 'fill']);
    const lines = [...(legend?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(lines).toEqual([
      '학교와 상관없이 상위 1팀 (1팀)',
      '1문제 이상 해결한 학교의 1위 팀 (2팀)',
      '남은 자리를 순위대로 채운 팀 (1팀)',
    ]);

    expect(document.querySelector('.publish-prelim-summary')?.textContent).toBe(
      '진출 4팀 = 상위 1 + 학교 대표 2 + 추가 1',
    );
    expect(screen.queryByText('진출 팀 수와 K를 입력하세요')).toBeNull();
  });

  it('lists the selection warnings', () => {
    // top 3 + school 0 … T = 1 → overflow.
    seedStore({ mode: 'preliminary', prelim: { totalTeams: 1, topN: 3, k: 0 } });
    render(<PublishView />);
    const warnings = document.querySelector('.publish-prelim-warnings');
    expect(warnings?.textContent).toContain('넘습니다');
  });

  it('preliminary: checking 미자격 dims the row and moves selection to the next team', () => {
    // K = 5: no school's best team qualifies, so only the top 2 advance.
    seedStore({ mode: 'preliminary', prelim: { totalTeams: 2, topN: 2, k: 5 } });
    render(<PublishView />);
    expect(isAdvance('x1')).toBe(true);
    expect(isAdvance('x2')).toBe(true);
    expect(isAdvance('y1')).toBe(false);

    const box = rowOf('x1').querySelector<HTMLInputElement>('.team-row-leading input');
    expect(box).not.toBeNull();
    expect(box!.getAttribute('aria-label')).toContain('미자격');
    fireEvent.click(box!);

    expect(appStore.getState().prelimInputs.ineligibleTeamIds).toEqual(['x1']);
    expect(isDimmed('x1')).toBe(true);
    expect(isAdvance('x1')).toBe(false);
    expect(isAdvance('x2')).toBe(true);
    expect(isAdvance('y1')).toBe(true);

    // Unchecking restores the selection.
    fireEvent.click(rowOf('x1').querySelector<HTMLInputElement>('.team-row-leading input')!);
    expect(appStore.getState().prelimInputs.ineligibleTeamIds).toEqual([]);
    expect(isDimmed('x1')).toBe(false);
    expect(isAdvance('x1')).toBe(true);
  });

  it('preliminary: save is disabled until T and K are set', () => {
    seedStore({ mode: 'preliminary', prelim: { totalTeams: null, k: null } });
    render(<PublishView />);
    expect(saveButton().disabled).toBe(true);
    type('publish-prelim-total', '3');
    expect(saveButton().disabled).toBe(true);
    type('publish-prelim-k', '1');
    expect(saveButton().disabled).toBe(false);
    type('publish-prelim-total', '');
    expect(saveButton().disabled).toBe(true);
  });

  it('marks a T that is not a positive integer as invalid and shows no selection', () => {
    seedStore({ mode: 'preliminary', prelim: { totalTeams: 3, k: 1 } });
    render(<PublishView />);
    type('publish-prelim-total', '1.5');
    expect(field('publish-prelim-total').getAttribute('aria-invalid')).toBe('true');
    expect(appStore.getState().prelimInputs.totalTeams).toBeNull();
    expect(document.querySelector('.team-row--advance')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// regional mode: site score, values, stars (spec §6)
// ---------------------------------------------------------------------------

describe('PublishView regional mode', () => {
  it('regional: S is computed from auto counts plus prelim inputs and shown', () => {
    // Auto counts: 3 schools, 5 solving teams, 0 foreign.
    // S = 0.56·3 + 0.24·5 = 2.88; with U_p 10, T_p 20: + 1.4 + 1.2 = 5.48.
    seedStore({ mode: 'regional' });
    render(<PublishView />);
    const score = (): string => document.querySelector('.regional-sim-score')?.textContent ?? '';
    expect(score()).toContain('2.88');
    expect(document.getElementById('publish-regional-schools')?.getAttribute('placeholder')).toBe(
      '3',
    );
    expect(document.getElementById('publish-regional-teams')?.getAttribute('placeholder')).toBe('5');

    type('publish-prelim-schools', '10');
    type('publish-prelim-teams', '20');
    expect(score()).toContain('5.48');

    // An override replaces the auto count: U_r 4 → + 0.56.
    type('publish-regional-schools', '4');
    expect(appStore.getState().regionalInputs.regionalOverride.schools).toBe(4);
    expect(score()).toContain('6.04');
  });

  it('shows each list row value with 4 decimals', () => {
    // List (school X is the champion's): y1 R1, y2 R2, z1 R3; S = 2.
    seedStore({ mode: 'regional', siteScore: 2 });
    render(<PublishView />);
    expect(valueOf('y1')).toBe('0.0000');
    expect(valueOf('y2')).toBe('0.5000');
    expect(valueOf('z1')).toBe('1.0000');
    expect(valueOf('x2')).toBe(''); // out of the list: empty slot
  });

  it('S = 0 shows no values, no Infinity, and a hint', () => {
    seedStore({ mode: 'regional', siteScore: 0 });
    render(<PublishView />);
    expect(document.body.textContent).not.toContain('Infinity');
    expect(document.body.textContent).not.toContain('NaN');
    expect(document.querySelector('.team-row-value')?.textContent ?? '').toBe('');
    expect(document.querySelector('.regional-sim-score-hint')).not.toBeNull();
  });

  it('regional: picking a WF medal school keeps its 3rd team in the list', () => {
    const medalContest = makeContest([
      { id: 'a1', group: 'A' },
      { id: 'w1', group: 'W' },
      { id: 'w2', group: 'W' },
      { id: 'w3', group: 'W' },
      { id: 'v1', group: 'V' },
    ]);
    const medalSnapshot = computeStandings(medalContest, [
      run('a1', 'p1', 10),
      run('w1', 'p1', 20),
      run('w2', 'p1', 30),
      run('w3', 'p1', 40),
      run('v1', 'p1', 50),
    ]);
    // Default coefficients: S = 0.56·3 + 0.24·5 = 2.88.
    seedStore({ mode: 'regional', contest: medalContest, snapshot: medalSnapshot });
    render(<PublishView />);
    expect(valueOf('w3')).toBe(''); // Q = 2: w3 is out
    expect(valueOf('v1')).toBe('0.6944'); // R3 → 2/2.88

    fireEvent.click(document.getElementById('publish-wf-medal-groups') as HTMLButtonElement);
    const row = [...document.querySelectorAll('.publish-school')].find(
      (el) => el.textContent === 'W',
    );
    fireEvent.click(row!.querySelector('input') as HTMLInputElement);
    expect(appStore.getState().regionalInputs.wfMedalGroups).toEqual(['W']);

    expect(valueOf('w3')).toBe('0.6944'); // Q = 3: R3
    expect(valueOf('v1')).toBe('1.0417'); // R4 → 3/2.88
  });

  it('regional: cutoff turns qualifying rows gold', () => {
    seedStore({ mode: 'regional', siteScore: 2, invitedCutoff: null });
    render(<PublishView />);
    expect(starFill('y1')).toBe(FILL.silver);
    type('publish-invited-cutoff', '0.5');
    expect(appStore.getState().regionalInputs.cutoff).toBe(0.5);
    expect(starFill('y1')).toBe(FILL.gold);
    expect(starFill('y2')).toBe(FILL.gold);
    expect(starFill('z1')).toBe(FILL.silver);
  });

  it('commits the coefficients from the 고급 section', () => {
    seedStore({ mode: 'regional' });
    render(<PublishView />);
    const advanced = document.querySelector('details.regional-sim-advanced');
    expect(advanced?.querySelector('summary')?.textContent).toBe('고급');
    type('publish-coef-regionalSchools', '1');
    expect(appStore.getState().regionalInputs.coefficients.regionalSchools).toBe(1);
    // An empty coefficient is invalid and keeps the last value.
    type('publish-coef-regionalSchools', '');
    expect(field('publish-coef-regionalSchools').getAttribute('aria-invalid')).toBe('true');
    expect(appStore.getState().regionalInputs.coefficients.regionalSchools).toBe(1);
  });

  it('links the APAC rules', () => {
    seedStore({ mode: 'regional' });
    render(<PublishView />);
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="https://icpc.jp/apac/2026-27/rules/"]',
    );
    expect(link).not.toBeNull();
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
    seedStore({ siteScore: 5, contest: capContest, snapshot: capSnapshot });
    render(<PublishView />);
    expect(starFill('w1')).toBe(FILL.gold); // champion
    expect(starFill('w2')).toBe(FILL.bronze); // champion schoolmate
    expect(starFill('w3')).toBe(FILL.bronze); // champion schoolmate
    expect(starOf('w4')).toBeNull(); // schoolRank 4 → no star at all
    expect(starFill('v1')).toBe(FILL.silver);
  });

  it('the publish mode decides the stars, not config.apac.enabled (spec §3)', () => {
    seedStore({ mode: 'regional', siteScore: 5, apacEnabled: false });
    render(<PublishView />);
    expect(starFill('x1')).toBe(FILL.gold);
    cleanup();

    seedStore({ mode: 'preliminary', siteScore: 5, apacEnabled: true });
    render(<PublishView />);
    expect(screen.getByText('Team x1')).toBeTruthy();
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
    type('publish-invited-cutoff', '0');
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
    type('publish-invited-cutoff', '0.4');
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
    fireEvent.click(document.getElementById('publish-already-invited-groups') as HTMLButtonElement);
    const row = [...document.querySelectorAll('.publish-school')].find(
      (el) => el.textContent === 'Y',
    );
    fireEvent.click(row!.querySelector('input') as HTMLInputElement);
    expect(appStore.getState().regionalInputs.invitedGroups).toEqual(['Y']);
    // School Y leaves the scored list: silver → bronze, spinning.
    expect(starFill('y1')).toBe(FILL.bronze);
    expect(starOf('y1')?.classList.contains('kr-apac-star--spin')).toBe(true);
    // z1 stays silver (still a candidate, just at a better rank) → no spin.
    expect(starFill('z1')).toBe(FILL.silver);
    expect(starOf('z1')?.classList.contains('kr-apac-star--spin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regional inputs: seeding, commit, school pickers
// ---------------------------------------------------------------------------

describe('Regional inputs', () => {
  it('seeds the cutoff from the store (URL/config values) and has no site-score input', () => {
    seedStore({ invitedCutoff: 2.5 });
    render(<PublishView />);
    expect(field('publish-invited-cutoff').value).toBe('2.5');
    expect(document.getElementById('publish-site-score')).toBeNull();
  });

  it('commits a valid cutoff to the store and null for invalid input', () => {
    seedStore({ invitedCutoff: null });
    render(<PublishView />);
    const cutoff = field('publish-invited-cutoff');
    expect(cutoff.getAttribute('aria-invalid')).toBeNull(); // optional: empty is fine

    fireEvent.change(cutoff, { target: { value: '0' } }); // ≥ 0 is fine
    expect(appStore.getState().regionalInputs.cutoff).toBe(0);
    fireEvent.change(cutoff, { target: { value: '-1' } });
    expect(appStore.getState().regionalInputs.cutoff).toBeNull();
    expect(cutoff.getAttribute('aria-invalid')).toBe('true');
  });

  // The picker is a checkbox list over the contest's own schools: an operator
  // cannot look up a team id, and a mistyped name used to fail silently.
  function openPicker(id = 'publish-already-invited-groups'): void {
    const toggle = document.getElementById(id);
    expect(toggle, 'school picker toggle missing').not.toBeNull();
    fireEvent.click(toggle as HTMLButtonElement);
  }

  function schoolRows(): HTMLLabelElement[] {
    return [...document.querySelectorAll('.publish-school')] as HTMLLabelElement[];
  }

  function schoolBox(name: string): HTMLInputElement {
    const row = schoolRows().find((el) => el.textContent === name);
    expect(row, `no checkbox for ${name}`).toBeDefined();
    return row!.querySelector('input') as HTMLInputElement;
  }

  it('has three school pickers: WF medal, other-regional winners, invited by another path', () => {
    seedStore();
    render(<PublishView />);
    expect(document.getElementById('publish-wf-medal-groups')).not.toBeNull();
    expect(document.getElementById('publish-winner-groups')).not.toBeNull();
    expect(document.getElementById('publish-already-invited-groups')).not.toBeNull();

    openPicker('publish-winner-groups');
    fireEvent.click(schoolBox('Z'));
    expect(appStore.getState().regionalInputs.winnerGroups).toEqual(['Z']);
    expect(appStore.getState().regionalInputs.invitedGroups).toEqual([]);
  });

  it('opens a panel listing every school alphabetically, checking the seeded ones', () => {
    seedStore({ alreadyInvited: { teamIds: [], groups: ['Y'] } });
    render(<PublishView />);

    // Closed by default: the toggle summarises the selection instead.
    expect(schoolRows()).toHaveLength(0);
    expect(document.getElementById('publish-already-invited-groups')?.textContent).toContain('Y');

    openPicker();
    expect(schoolRows().map((el) => el.textContent)).toEqual(['X', 'Y', 'Z']);
    expect(schoolBox('Y').checked).toBe(true);
    expect(schoolBox('X').checked).toBe(false);
  });

  it('filters the panel and commits picks in contest order', () => {
    seedStore();
    render(<PublishView />);
    openPicker();

    fireEvent.change(document.querySelector('.publish-schools-filter') as HTMLInputElement, {
      target: { value: 'z' },
    });
    expect(schoolRows().map((el) => el.textContent)).toEqual(['Z']);

    fireEvent.click(schoolBox('Z'));
    expect(appStore.getState().regionalInputs.invitedGroups).toEqual(['Z']);

    // Clear the filter and add an earlier school: order follows the contest.
    fireEvent.change(document.querySelector('.publish-schools-filter') as HTMLInputElement, {
      target: { value: '' },
    });
    fireEvent.click(schoolBox('X'));
    expect(appStore.getState().regionalInputs.invitedGroups).toEqual(['X', 'Z']);

    fireEvent.click(schoolBox('Z'));
    expect(appStore.getState().regionalInputs.invitedGroups).toEqual(['X']);
    // Team ids are untouched: they remain a config.json-only escape hatch.
    expect(appStore.getState().regionalInputs.invitedTeamIds).toEqual([]);
  });

  it('closes the panel on Escape', () => {
    seedStore();
    render(<PublishView />);
    openPicker();
    expect(schoolRows().length).toBeGreaterThan(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(schoolRows()).toHaveLength(0);
  });

  // Extra teams occupying slots can only push everyone below them DOWN, so an
  // empty alreadyInvited list under-reports qualifiers — never over-reports.
  it('warns that ranks are pushed down while no school is picked', () => {
    seedStore();
    render(<PublishView />);
    const hint = document.querySelector('.publish-controls-hint');
    expect(hint?.textContent).toContain('밀리고');
    expect(hint?.textContent).toContain('적게 표시');

    // Picking one invited school removes the warning.
    openPicker();
    fireEvent.click(schoolBox('Y'));
    expect(document.querySelector('.publish-controls-hint')).toBeNull();
  });

  it('"초기값으로 되돌리기" resets the inputs and the field text', () => {
    seedStore({ invitedCutoff: 1.5, fromStorage: true });
    render(<PublishView />);
    expect(field('publish-invited-cutoff').value).toBe('1.5');
    fireEvent.click(screen.getByRole('button', { name: '초기값으로 되돌리기' }));
    expect(appStore.getState().regionalInputs.cutoff).toBeNull();
    expect(field('publish-invited-cutoff').value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Stored inputs notice (spec §4 step 2)
// ---------------------------------------------------------------------------

describe('stored inputs', () => {
  it('shows "저장된 값을 사용 중" and resets to the config values', () => {
    seedStore({ mode: 'preliminary', prelim: { totalTeams: 3, k: 1 }, fromStorage: true });
    render(<PublishView />);
    expect(screen.getByText('저장된 값을 사용 중')).toBeTruthy();
    expect(field('publish-prelim-total').value).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: 'config 값으로 되돌리기' }));
    expect(appStore.getState().publishInputsFromStorage).toBe(false);
    expect(appStore.getState().prelimInputs.totalTeams).toBeNull();
    expect(field('publish-prelim-total').value).toBe('');
    expect(screen.queryByText('저장된 값을 사용 중')).toBeNull();
  });

  it('"config 값으로 되돌리기" clears invalid field text in the regional panel', () => {
    seedStore({ mode: 'regional', invitedCutoff: null, fromStorage: true });
    render(<PublishView />);
    const cutoff = field('publish-invited-cutoff');
    fireEvent.change(cutoff, { target: { value: 'abc' } });
    // Invalid text commits null, so the store value does not change.
    expect(appStore.getState().regionalInputs.cutoff).toBeNull();
    expect(field('publish-invited-cutoff').value).toBe('abc');

    fireEvent.click(screen.getByRole('button', { name: 'config 값으로 되돌리기' }));
    expect(field('publish-invited-cutoff').value).toBe('');
  });

  it('shows no notice when the inputs come from config', () => {
    seedStore({ mode: 'regional' });
    render(<PublishView />);
    expect(screen.queryByText('저장된 값을 사용 중')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// "확정 결과 저장" (spec §4 step 3)
// ---------------------------------------------------------------------------

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Stubs the download path; returns the captured Blob and anchor. */
function captureDownload(): { blob: () => Blob; anchor: () => HTMLAnchorElement } {
  let captured: Blob | null = null;
  let clicked: HTMLAnchorElement | null = null;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      captured = blob;
      return 'blob:publish-state';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked = this;
  });
  return {
    blob: () => {
      expect(captured, 'no Blob was created').not.toBeNull();
      return captured!;
    },
    anchor: () => {
      expect(clicked, 'no download link was clicked').not.toBeNull();
      return clicked!;
    },
  };
}

describe('SaveStateButton', () => {
  it('save dialog lists the inputs and the download contains a parsePublishState-valid file', async () => {
    const download = captureDownload();
    seedStore({ mode: 'preliminary', prelim: { totalTeams: 4, topN: 1, k: 1 } });
    render(<PublishView manualLabels={new Map([['x1', ['Best Team']]])} />);

    fireEvent.click(saveButton());
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('진출 팀 수');
    expect(dialog.textContent).toContain('4');
    expect(dialog.textContent).toContain('진출 4팀 = 상위 1 + 학교 대표 2 + 추가 1');
    // Nothing is downloaded before the operator confirms.
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '다운로드' }));
    expect(download.anchor().getAttribute('download')).toBe('publish-state.json');
    expect(screen.queryByRole('dialog')).toBeNull();

    const parsed = parsePublishState(JSON.parse(await readBlob(download.blob())));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.state.mode !== 'preliminary') throw new Error('not preliminary');
    expect(parsed.state.title).toBe('Publish Fixture Contest');
    expect(parsed.state.manualLabels).toEqual({ x1: ['Best Team'] });
    expect(parsed.state.preliminary).toMatchObject({ totalTeams: 4, topN: 1, k: 1 });
    expect(parsed.state.preliminary.selected).toEqual([
      { teamId: 'x1', stage: 'top' },
      { teamId: 'y1', stage: 'school' },
      { teamId: 'z1', stage: 'school' },
      { teamId: 'x2', stage: 'fill' },
    ]);
  });

  it('keeps the object URL alive after the click, and revokes it later', () => {
    vi.useFakeTimers();
    try {
      captureDownload();
      seedStore({ mode: 'off' });
      render(<PublishView />);
      fireEvent.click(saveButton());
      fireEvent.click(screen.getByRole('button', { name: '다운로드' }));
      // Safari needs the URL after click(); a 0 ms revoke breaks the download.
      vi.advanceTimersByTime(1000);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:publish-state');
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves the regional inputs as they are', async () => {
    const download = captureDownload();
    seedStore({ mode: 'regional', siteScore: 2, invitedCutoff: 0.5 });
    render(<PublishView />);
    fireEvent.click(saveButton());
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('가정 cutoff');
    expect(dialog.textContent).toContain('0.5');
    fireEvent.click(screen.getByRole('button', { name: '다운로드' }));

    const parsed = parsePublishState(JSON.parse(await readBlob(download.blob())));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.state.mode !== 'regional') throw new Error('not regional');
    expect(parsed.state.regional).toEqual(appStore.getState().regionalInputs);
  });

  it('saves an off-mode file', async () => {
    const download = captureDownload();
    seedStore({ mode: 'off' });
    render(<PublishView />);
    fireEvent.click(saveButton());
    fireEvent.click(screen.getByRole('button', { name: '다운로드' }));
    const parsed = parsePublishState(JSON.parse(await readBlob(download.blob())));
    expect(parsed.ok && parsed.state.mode).toBe('off');
  });

  it('cancel closes the dialog without a download', () => {
    captureDownload();
    seedStore({ mode: 'off' });
    render(<PublishView />);
    fireEvent.click(saveButton());
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
