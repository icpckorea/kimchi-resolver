/**
 * Static public page (publish-modes spec §5.3, §6.4, §7, §8): PublishedApp
 * renders a PublishState with no store, feed or ingest code. Preliminary
 * shows the saved selection as is; regional keeps a local copy of the inputs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Contest, Problem, Run, Team, Verdict } from '@core/types';
import { computeStandings } from '@core/standings';
import { DEFAULT_SITE_SCORE_COEFFICIENTS } from '@core/apac';
import {
  buildPublishState,
  parsePublishState,
  type PreliminaryResultState,
  type PublishState,
  type RegionalSimInputs,
} from '@core/publishState';
import { PublishedApp, PublishedError, readPublishData } from '../../src/published/PublishedApp';

// ---------------------------------------------------------------------------
// Fixture: three schools, ranks fixed by solve minute of p1.
//   rank 1 x1(X)  rank 2 x2(X)  rank 3 y1(Y)  rank 4 y2(Y)  rank 5 z1(Z)
// ---------------------------------------------------------------------------

const problems: Problem[] = [
  { id: 'p1', label: 'A', title: 'Problem A', color: 'red', order: 0 },
  { id: 'p2', label: 'B', title: 'Problem B', color: 'blue', order: 1 },
];

const contest: Contest = {
  title: 'Published Fixture Contest',
  systemName: 'fixture',
  systemVersion: '0',
  problems,
  teams: new Map<string, Team>(
    [
      ['x1', 'X'],
      ['x2', 'X'],
      ['y1', 'Y'],
      ['y2', 'Y'],
      ['z1', 'Z'],
    ].map(([id, group]) => [
      id,
      { id, name: `Team ${id}`, group, countryCode: 'KR', foreign: false },
    ]),
  ),
};

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

const snapshot = computeStandings(contest, [
  run('x1', 'p1', 10),
  run('x2', 'p1', 20),
  run('y1', 'p1', 30),
  run('y2', 'p1', 40),
  run('z1', 'p1', 50),
]);

const DISPLAY: PublishState['display'] = {
  showTeamGroup: true,
  showFirstSolve: true,
  showBalloons: false,
  showSchoolLogos: false,
};

const BANNER =
  '이 페이지는 시뮬레이션입니다. 공식 결과가 아닙니다. 최종 초청은 모든 리저널이 끝난 다음 APAC에서 정합니다.';

/** S = T_p exactly: every coefficient is 0 except the preliminary team count's. */
const REGIONAL: RegionalSimInputs = {
  prelimSchools: null,
  prelimTeams: 2,
  coefficients: { ...DEFAULT_SITE_SCORE_COEFFICIENTS, regionalSchools: 0, regionalTeams: 0, prelimSchools: 0, prelimTeams: 1, foreignTeams: 0 },
  regionalOverride: { schools: null, teams: null, foreign: null },
  wfMedalGroups: [],
  winnerGroups: [],
  invitedGroups: [],
  invitedTeamIds: [],
  cutoff: null,
};

function buildState(
  mode: 'off' | 'preliminary' | 'regional',
  extra: { preliminary?: PreliminaryResultState; regional?: RegionalSimInputs } = {},
): PublishState {
  return buildPublishState({
    mode,
    title: contest.title,
    display: DISPLAY,
    problems,
    orgs: {},
    snapshot,
    manualLabels: null,
    ...extra,
  });
}

function rowOf(teamId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-team-id="${teamId}"]`);
  expect(row, `row ${teamId}`).not.toBeNull();
  return row!;
}

const starFill = (teamId: string): string | undefined =>
  rowOf(teamId).querySelector('svg.kr-apac-star polygon')?.getAttribute('fill') ?? undefined;
const valueOf = (teamId: string): string | undefined =>
  rowOf(teamId).querySelector('.team-row-value')?.textContent ?? undefined;
const isAdvance = (teamId: string): boolean =>
  rowOf(teamId).classList.contains('team-row--advance');
const isDimmed = (teamId: string): boolean =>
  rowOf(teamId).classList.contains('team-row--dimmed');

const FILL = { silver: '#b8bfc9', gold: '#e6b422' } as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  seq = 0;
});

// ---------------------------------------------------------------------------

describe('PublishedApp', () => {
  it('off renders the board without inputs', () => {
    const { container } = render(<PublishedApp state={buildState('off')} />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(contest.title);
    expect(container.querySelectorAll('.team-row')).toHaveLength(5);
    expect(container.querySelectorAll('input, button, select, textarea')).toHaveLength(0);
    expect(container.querySelector('.team-row--advance')).toBeNull();
    expect(container.querySelector('svg.kr-apac-star')).toBeNull();
    expect(container.querySelector('.team-row-value')).toBeNull();
    // Header: title only (no clock, no mode tag).
    expect(container.querySelector('.publish-clock, .publish-mode-tag')).toBeNull();
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it('preliminary paints saved selections and dims ineligible, and has no input element', () => {
    const state = buildState('preliminary', {
      preliminary: {
        totalTeams: 3,
        topN: 1,
        k: 1,
        ineligibleTeamIds: ['x2'],
        selected: [
          { teamId: 'x1', stage: 'top' },
          { teamId: 'y1', stage: 'school' },
          { teamId: 'z1', stage: 'school' },
        ],
      },
    });
    const { container } = render(<PublishedApp state={state} />);

    expect(['x1', 'x2', 'y1', 'y2', 'z1'].filter(isAdvance)).toEqual(['x1', 'y1', 'z1']);
    expect(['x1', 'x2', 'y1', 'y2', 'z1'].filter(isDimmed)).toEqual(['x2']);
    expect(screen.getByText('노란색 = 본선 진출')).toBeTruthy();
    expect(container.querySelectorAll('input, button, select, textarea')).toHaveLength(0);
    // Each selected row says why it advanced; the legend explains the tags
    // with the saved N and K and the per-stage counts.
    const tagOf = (id: string): string | null =>
      container.querySelector(`[data-team-id="${id}"] .team-row-tag`)?.textContent ?? null;
    expect(['x1', 'x2', 'y1', 'y2', 'z1'].map(tagOf)).toEqual(['상위', null, '학교', null, '학교']);
    const legend = container.querySelector('.published-stage-legend')?.textContent ?? '';
    expect(legend).toContain('상위: 학교와 상관없이 상위 1팀 (1팀)');
    expect(legend).toContain('학교: 1문제 이상 해결한 학교의 1위 팀 (2팀)');
    expect(legend).toContain('추가: 남은 자리를 순위대로 채운 팀 (0팀)');
    // No "미자격" text, no stars, rank numbers stay as standings.
    expect(container.textContent).not.toContain('미자격');
    expect(container.querySelector('svg.kr-apac-star')).toBeNull();
    expect(container.querySelector('.team-row-value')).toBeNull();
  });

  it('preliminary does not recompute: a saved list that disagrees with K is shown as saved', () => {
    // topN 3 and K 1 would select x1, x2, y1 (and a fill); the file says only z1.
    const state = buildState('preliminary', {
      preliminary: {
        totalTeams: 5,
        topN: 3,
        k: 1,
        ineligibleTeamIds: [],
        selected: [{ teamId: 'z1', stage: 'fill' }],
      },
    });
    render(<PublishedApp state={state} />);

    expect(['x1', 'x2', 'y1', 'y2', 'z1'].filter(isAdvance)).toEqual(['z1']);
  });

  it('regional shows the banner, editing the cutoff changes stars, reset restores the seed', () => {
    const { container } = render(<PublishedApp state={buildState('regional', { regional: REGIONAL })} />);

    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href') === 'https://icpc.jp/apac/2026-27/rules/'),
    ).toBe(true);
    expect(screen.getByText(/동색 = 학내 3등 이내/)).toBeTruthy();
    expect(container.querySelector('.regional-sim-score')?.textContent).toContain('S = 2');

    // Seed: the winner x1 is gold; school X leaves the list; no cutoff.
    // Values (R - 1) / S with S = 2: y1 0, y2 0.5, z1 1.
    expect(starFill('x1')).toBe(FILL.gold);
    expect(valueOf('y1')).toBe('0.0000');
    expect(valueOf('y2')).toBe('0.5000');
    expect(valueOf('z1')).toBe('1.0000');
    expect(starFill('y1')).toBe(FILL.silver);
    expect(starFill('y2')).toBe(FILL.silver);
    expect(starFill('z1')).toBe(FILL.silver);

    const cutoff = document.getElementById('publish-invited-cutoff') as HTMLInputElement;
    fireEvent.change(cutoff, { target: { value: '0.6' } });
    expect(starFill('y1')).toBe(FILL.gold);
    expect(starFill('y2')).toBe(FILL.gold);
    expect(starFill('z1')).toBe(FILL.silver);

    fireEvent.click(screen.getByRole('button', { name: '초기값으로 되돌리기' }));
    expect((document.getElementById('publish-invited-cutoff') as HTMLInputElement).value).toBe('');
    expect(starFill('y1')).toBe(FILL.silver);
    expect(starFill('y2')).toBe(FILL.silver);
  });

  it('regional starts with the inputs folded on a phone and open on a desktop', () => {
    const state = buildState('regional', { regional: REGIONAL });

    const desktop = render(<PublishedApp state={state} />);
    expect(desktop.container.querySelector<HTMLDetailsElement>('details.regional-sim')?.open).toBe(true);
    cleanup();

    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 768px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
    const phone = render(<PublishedApp state={state} />);
    expect(phone.container.querySelector<HTMLDetailsElement>('details.regional-sim')?.open).toBe(false);
  });
});

describe('readPublishData / PublishedError', () => {
  it('reads a state that round-trips through JSON', () => {
    const state = buildState('regional', { regional: REGIONAL });
    const result = readPublishData(JSON.stringify(state));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.mode).toBe('regional');
  });

  it('refuses missing data, bad JSON and an invalid file, with the zod path', () => {
    const missing = readPublishData(null);
    expect(missing.ok).toBe(false);

    const badJson = readPublishData('{not json');
    expect(badJson.ok).toBe(false);

    const state = JSON.parse(JSON.stringify(buildState('off')));
    state.mode = 'sideways';
    const invalid = readPublishData(JSON.stringify(state));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.some((e) => e.startsWith('publish-state.mode'))).toBe(true);
      render(<PublishedError errors={invalid.errors} />);
      expect(screen.getByRole('alert').textContent).toContain('publish-state.mode');
      expect(screen.getByRole('alert').textContent).toContain('순위표를 표시할 수 없습니다');
    }
  });

  it('accepts a state whose parse result matches the builder', () => {
    expect(parsePublishState(JSON.parse(JSON.stringify(buildState('off')))).ok).toBe(true);
  });
});

describe('import guard', () => {
  it('keeps @store and @core/ingest out of src/published and everything it imports', () => {
    const SRC = resolve(__dirname, '../../src');
    const ALIASES: Record<string, string> = {
      '@core/': resolve(SRC, 'core') + '/',
      '@store/': resolve(SRC, 'store') + '/',
      '@ui/': resolve(SRC, 'ui') + '/',
    };

    function resolveFile(base: string): string | null {
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
      return null;
    }
    function resolveSpec(from: string, spec: string): string | null {
      if (spec.startsWith('.')) return resolveFile(resolve(dirname(from), spec));
      for (const [prefix, dir] of Object.entries(ALIASES)) {
        if (spec.startsWith(prefix)) return resolveFile(dir + spec.slice(prefix.length));
      }
      return null; // a package
    }

    const DIR = resolve(SRC, 'published');
    const roots = readdirSync(DIR)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => resolve(DIR, name));
    expect(roots.map((p) => p.slice(DIR.length + 1))).toEqual(
      expect.arrayContaining(['main.tsx', 'PublishedApp.tsx']),
    );

    const offenders: string[] = [];
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1];
        const target = resolveSpec(file, spec);
        const bad =
          spec === '@store' ||
          spec.startsWith('@store/') ||
          (target !== null && /[\\/]src[\\/](store|core[\\/]ingest)[\\/]/.test(target));
        if (bad) {
          offenders.push(`${file.slice(SRC.length + 1)} → ${spec}`);
          continue;
        }
        if (target !== null && /\.tsx?$/.test(target)) queue.push(target);
      }
    }
    expect(offenders).toEqual([]);
  });
});
