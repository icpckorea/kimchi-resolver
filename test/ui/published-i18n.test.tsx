/**
 * Korean / English switch of the static public page (PublishedApp,
 * PublishedError) and the language rules around it: `?lang=` beats the saved
 * choice (localStorage `kimchi.lang`), which beats the Korean default; every
 * storage access is allowed to throw; `<html lang>` follows the language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Contest, Problem, Run, Team } from '@core/types';
import { computeStandings } from '@core/standings';
import { DEFAULT_SITE_SCORE_COEFFICIENTS } from '@core/apac';
import {
  buildPublishState,
  type PreliminaryResultState,
  type PublishState,
  type RegionalSimInputs,
} from '@core/publishState';
import { PublishedApp, PublishedError } from '../../src/published/PublishedApp';
import { MESSAGES } from '../../src/published/i18n';
import { RegionalSimPanel } from '../../src/ui/publish/RegionalSimPanel';

// ---------------------------------------------------------------------------
// Fixture: no Hangul in any name, so the English check can be strict.
//   rank 1 x1(X)  rank 2 x2(X)  rank 3 y1(Y)  rank 4 y2(Y)  rank 5 z1(Z)
// ---------------------------------------------------------------------------

const problems: Problem[] = [
  { id: 'p1', label: 'A', title: 'Problem A', color: 'red', order: 0 },
  { id: 'p2', label: 'B', title: 'Problem B', color: 'blue', order: 1 },
];

const contest: Contest = {
  title: 'I18n Fixture Contest',
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
function run(teamId: string, minute: number): Run {
  seq += 1;
  return {
    id: String(seq),
    teamId,
    problemId: 'p1',
    minute,
    verdict: 'accepted',
    penaltyCounts: false,
    seq,
  };
}

const snapshot = computeStandings(contest, [
  run('x1', 10),
  run('x2', 20),
  run('y1', 30),
  run('y2', 40),
  run('z1', 50),
]);

const REGIONAL: RegionalSimInputs = {
  prelimSchools: null,
  prelimTeams: 2,
  coefficients: {
    ...DEFAULT_SITE_SCORE_COEFFICIENTS,
    regionalSchools: 0,
    regionalTeams: 0,
    prelimSchools: 0,
    prelimTeams: 1,
    foreignTeams: 0,
  },
  regionalOverride: { schools: null, teams: null, foreign: null },
  wfMedalGroups: [],
  winnerGroups: [],
  invitedGroups: [],
  invitedTeamIds: [],
  cutoff: null,
};

const PRELIMINARY: PreliminaryResultState = {
  totalTeams: 3,
  topN: 1,
  k: 1,
  ineligibleTeamIds: ['x2'],
  selected: [
    { teamId: 'x1', stage: 'top' },
    { teamId: 'y1', stage: 'school' },
    { teamId: 'z1', stage: 'fill' },
  ],
};

type Mode = 'off' | 'preliminary' | 'regional';

function buildState(mode: Mode, regional: RegionalSimInputs = REGIONAL): PublishState {
  return buildPublishState({
    mode,
    title: contest.title,
    display: { showTeamGroup: true, showFirstSolve: true, showBalloons: false, showSchoolLogos: false },
    problems,
    orgs: {},
    snapshot,
    manualLabels: null,
    ...(mode === 'preliminary' ? { preliminary: PRELIMINARY } : {}),
    ...(mode === 'regional' ? { regional } : {}),
  });
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const KEY = 'kimchi.lang';

const toggle = (): HTMLButtonElement => {
  const button = document.querySelector<HTMLButtonElement>('.published-lang-toggle');
  expect(button, 'language toggle').not.toBeNull();
  return button!;
};

/** The markup of the page without the toggle (its label is the other language's own name). */
function markupWithoutToggle(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelector('.published-lang-toggle')?.remove();
  return copy.innerHTML;
}

const KO = {
  banner: MESSAGES.ko.banner,
  legend: '노란색 = 본선 진출',
  stars: /동색 = 학내 3등 이내/,
  reset: '초기값으로 되돌리기',
  errorTitle: '순위표를 표시할 수 없습니다',
};
const EN = {
  banner:
    'This page is a simulation, not an official result. ICPC Asia Pacific decides the final invitations after all regionals end.',
  legend: 'Yellow = advances to the regional',
  stars: /bronze = Top 3 in their school/i,
  reset: /^Reset/,
  errorTitle: /Cannot show the standings/,
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  document.documentElement.lang = 'ko';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  document.documentElement.lang = 'ko';
  seq = 0;
});

// ---------------------------------------------------------------------------

describe('message table', () => {
  it('keeps the Korean texts that other tests and the prepare page rely on', () => {
    expect(MESSAGES.ko.banner).toBe(
      '이 페이지는 시뮬레이션입니다. 공식 결과가 아닙니다. 최종 초청은 모든 리저널이 끝난 다음 APAC에서 정합니다.',
    );
    expect(MESSAGES.ko.advanceLegend).toBe('노란색 = 본선 진출');
    expect(MESSAGES.ko.stageLabels).toEqual({
      top: '상위 팀 (학교 무관)',
      school: '학교 대표 팀',
      fill: '남은 자리를 채운 팀',
    });
    expect(MESSAGES.ko.stageLegend('top', 1, 2)).toBe('학교와 상관없이 상위 1팀');
    expect(MESSAGES.ko.stageLegend('school', 1, 2)).toBe('2문제 이상 해결한 학교의 1위 팀');
    expect(MESSAGES.ko.stageLegend('fill', 1, 2)).toBe('남은 자리를 순위대로 채운 팀');
  });

  it('has the same keys in both languages and no Hangul in English', () => {
    const shape = (value: unknown): unknown =>
      typeof value === 'object' && value !== null
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
        : typeof value;
    expect(shape(MESSAGES.en)).toEqual(shape(MESSAGES.ko));

    const texts: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') texts.push(value);
      else if (typeof value === 'function') {
        texts.push(String((value as (...a: number[]) => unknown)(1, 2, 3)));
      } else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
    };
    // The toggle names the other language in its own script, so it is the one exception.
    const { langToggle: _langToggle, ...rest } = MESSAGES.en;
    walk(rest);
    expect(texts.length).toBeGreaterThan(30);
    expect(texts.filter((t) => HANGUL.test(t))).toEqual([]);
  });
});

describe('language toggle', () => {
  it('off: Korean by default, switches both ways', () => {
    const { container } = render(<PublishedApp state={buildState('off')} />);
    expect(toggle().textContent).toBe('English');
    expect(toggle().getAttribute('aria-label')).toBeTruthy();
    expect(document.documentElement.lang).toBe('ko');

    fireEvent.click(toggle());
    expect(toggle().textContent).toBe('한국어');
    expect(document.documentElement.lang).toBe('en');
    expect(HANGUL.test(markupWithoutToggle(container))).toBe(false);

    fireEvent.click(toggle());
    expect(toggle().textContent).toBe('English');
    expect(document.documentElement.lang).toBe('ko');
  });

  it('preliminary: row icons, legend and counts switch both ways', () => {
    const { container } = render(<PublishedApp state={buildState('preliminary')} />);
    const icons = (): ([string, string] | null)[] =>
      ['x1', 'x2', 'y1', 'y2', 'z1'].map((id) => {
        const icon = container.querySelector(`[data-team-id="${id}"] svg[data-stage]`);
        return icon === null ? null : [icon.getAttribute('data-stage') ?? '', icon.getAttribute('aria-label') ?? ''];
      });
    const legend = (): string[] =>
      [...container.querySelectorAll('.published-stage-legend li')].map((li) => li.textContent ?? '');
    const legendStages = (): (string | null | undefined)[] =>
      [...container.querySelectorAll('.published-stage-legend li')].map((li) =>
        li.querySelector('svg[data-stage]')?.getAttribute('data-stage'),
      );

    expect(screen.getByText(KO.legend)).toBeTruthy();
    expect(icons()).toEqual([
      ['top', '상위 팀 (학교 무관)'],
      null,
      ['school', '학교 대표 팀'],
      null,
      ['fill', '남은 자리를 채운 팀'],
    ]);
    expect(container.querySelector('.team-row-tag')).toBeNull();
    expect(legendStages()).toEqual(['top', 'school', 'fill']);
    expect(legend()[0]).toBe('학교와 상관없이 상위 1팀 (1팀)');

    fireEvent.click(toggle());
    expect(screen.getByText(EN.legend)).toBeTruthy();
    expect(screen.queryByText(KO.legend)).toBeNull();
    expect(icons()).toEqual([
      ['top', 'Top-ranked team (any school)'],
      null,
      ['school', 'Top team of a school'],
      null,
      ['fill', 'Team filling a remaining spot'],
    ]);
    expect(legendStages()).toEqual(['top', 'school', 'fill']);
    expect(legend()).toEqual([
      'Best 1 team regardless of school (1 team)',
      'Top team of each school that solved 1 or more problems (1 team)',
      'Next teams by rank to fill the remaining spots (1 team)',
    ]);

    fireEvent.click(toggle());
    expect(screen.getByText(KO.legend)).toBeTruthy();
    expect(icons()[0]).toEqual(['top', '상위 팀 (학교 무관)']);
  });

  it('regional: banner, star legend and panel switch both ways', () => {
    render(<PublishedApp state={buildState('regional')} />);
    expect(screen.getByText(KO.banner)).toBeTruthy();
    expect(screen.getByText(KO.stars)).toBeTruthy();
    expect(screen.getByRole('button', { name: KO.reset })).toBeTruthy();
    expect(screen.getByText('APAC 진출 시뮬레이션 입력')).toBeTruthy();

    fireEvent.click(toggle());
    expect(screen.getByText(EN.banner)).toBeTruthy();
    expect(screen.queryByText(KO.banner)).toBeNull();
    expect(screen.getByText(EN.stars)).toBeTruthy();
    expect(screen.getByRole('button', { name: EN.reset })).toBeTruthy();
    expect(screen.getByText('APAC qualification simulation inputs')).toBeTruthy();

    fireEvent.click(toggle());
    expect(screen.getByText(KO.banner)).toBeTruthy();
    expect(screen.getByRole('button', { name: KO.reset })).toBeTruthy();
  });

  it('keeps the edited inputs of the simulation when the language changes', () => {
    render(<PublishedApp state={buildState('regional')} />);
    const cutoff = (): HTMLInputElement =>
      document.getElementById('publish-invited-cutoff') as HTMLInputElement;
    fireEvent.change(cutoff(), { target: { value: '0.6' } });
    fireEvent.click(toggle());
    expect(cutoff().value).toBe('0.6');
  });

  it('error panel: translated, with its own toggle', () => {
    render(<PublishedError errors={['publish-state.mode: bad']} />);
    expect(screen.getByRole('alert').textContent).toContain(KO.errorTitle);
    expect(screen.getByRole('alert').textContent).toContain('publish-state.mode: bad');

    fireEvent.click(toggle());
    expect(screen.getByRole('alert').textContent).toMatch(EN.errorTitle);
    expect(screen.getByRole('alert').textContent).toContain('publish-state.mode: bad');
    expect(HANGUL.test(markupWithoutToggle(document.body))).toBe(false);
  });
});

describe('language choice', () => {
  it('?lang=en starts in English and beats the saved choice', () => {
    window.history.replaceState(null, '', '/?lang=en');
    localStorage.setItem(KEY, 'ko');
    render(<PublishedApp state={buildState('preliminary')} />);
    expect(screen.getByText(EN.legend)).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('?lang=ko beats a saved English choice', () => {
    window.history.replaceState(null, '', '/?lang=ko');
    localStorage.setItem(KEY, 'en');
    render(<PublishedApp state={buildState('preliminary')} />);
    expect(screen.getByText(KO.legend)).toBeTruthy();
    expect(document.documentElement.lang).toBe('ko');
  });

  it('does not save a language that came from the URL', () => {
    window.history.replaceState(null, '', '/?lang=en');
    render(<PublishedApp state={buildState('off')} />);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('ignores an unknown ?lang= value', () => {
    window.history.replaceState(null, '', '/?lang=fr');
    localStorage.setItem(KEY, 'en');
    render(<PublishedApp state={buildState('preliminary')} />);
    expect(screen.getByText(EN.legend)).toBeTruthy();
  });

  it('uses the saved choice when the URL has none, and ignores a bad saved value', () => {
    localStorage.setItem(KEY, 'en');
    render(<PublishedApp state={buildState('preliminary')} />);
    expect(screen.getByText(EN.legend)).toBeTruthy();
    cleanup();

    localStorage.setItem(KEY, 'klingon');
    render(<PublishedApp state={buildState('preliminary')} />);
    expect(screen.getByText(KO.legend)).toBeTruthy();
  });

  it('saves the choice made with the toggle', () => {
    render(<PublishedApp state={buildState('off')} />);
    fireEvent.click(toggle());
    expect(localStorage.getItem(KEY)).toBe('en');
    fireEvent.click(toggle());
    expect(localStorage.getItem(KEY)).toBe('ko');
  });

  it('keeps a ?lang= in the address in step with the toggle, so a reload shows the same language', () => {
    window.history.replaceState(null, '', '/?lang=en');
    render(<PublishedApp state={buildState('off')} />);
    fireEvent.click(toggle());
    expect(new URLSearchParams(window.location.search).get('lang')).toBe('ko');
    expect(document.documentElement.lang).toBe('ko');
  });

  it('still renders and switches when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<PublishedApp state={buildState('preliminary')} />);
    expect(screen.getByText(KO.legend)).toBeTruthy();
    fireEvent.click(toggle());
    expect(screen.getByText(EN.legend)).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('English mode shows no Korean', () => {
  const cases: [string, () => PublishState][] = [
    ['off', () => buildState('off')],
    ['preliminary', () => buildState('preliminary')],
    ['regional', () => buildState('regional')],
    [
      'regional with S <= 0',
      () => buildState('regional', { ...REGIONAL, prelimTeams: 0, prelimSchools: 0 }),
    ],
  ];
  for (const [name, make] of cases) {
    it(name, () => {
      window.history.replaceState(null, '', '/?lang=en');
      const { container } = render(<PublishedApp state={make()} />);
      // Open the school pickers too: their panel is rendered only when open.
      for (const button of container.querySelectorAll<HTMLButtonElement>('.publish-schools-toggle')) {
        fireEvent.click(button);
      }
      expect(markupWithoutToggle(container)).not.toMatch(HANGUL);
    });
  }

  it('the school picker texts are English too', () => {
    window.history.replaceState(null, '', '/?lang=en');
    render(<PublishedApp state={buildState('regional')} />);
    const picker = document.getElementById('publish-wf-medal-groups') as HTMLButtonElement;
    expect(picker.textContent).toBe('None selected');
    fireEvent.click(picker);
    const filter = document.querySelector<HTMLInputElement>('.publish-schools-filter')!;
    expect(filter.placeholder).toBe('Search schools');
    fireEvent.change(filter, { target: { value: 'nothing like this' } });
    expect(screen.getByText('No school matches.')).toBeTruthy();
    fireEvent.change(filter, { target: { value: '' } });
    for (const name of ['X', 'Y', 'Z']) {
      fireEvent.click(screen.getAllByLabelText(name, { selector: 'input[type="checkbox"]' })[0]);
    }
    expect(picker.textContent).toBe('X and 2 more');
  });
});

describe('RegionalSimPanel on the prepare page', () => {
  const props = {
    value: REGIONAL,
    onChange: () => {},
    schools: ['X', 'Y'],
    autoCounts: { schools: 3, teams: 5, foreign: 0 },
    siteScore: 2,
    onReset: () => {},
  };

  it('stays Korean without a messages prop', () => {
    render(<RegionalSimPanel {...props} />);
    expect(screen.getByText('APAC 진출 시뮬레이션 입력')).toBeTruthy();
    expect(screen.getByRole('button', { name: '초기값으로 되돌리기' })).toBeTruthy();
    expect(screen.getByText('고급')).toBeTruthy();
    expect(screen.getByText('예선 학교 수 U_p')).toBeTruthy();
    expect(document.getElementById('publish-wf-medal-groups')?.textContent).toBe('선택 안 함');
  });

  it('takes the English messages from the prop', () => {
    render(<RegionalSimPanel {...props} messages={MESSAGES.en.regional} />);
    expect(screen.getByRole('button', { name: /^Reset/ })).toBeTruthy();
    expect(screen.queryByText('고급')).toBeNull();
  });
});
