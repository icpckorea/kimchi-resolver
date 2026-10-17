/**
 * Scoreboard UI tests (jsdom): sample-snapshot render, cell color priority,
 * badge texts, search filtering, domestic-rank em-dash, pagination, balloons,
 * followed sticky, spine colors and the cell flip hook.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Contest, OrgsIndex, Run, Snapshot, Team, Verdict } from '@core/types';
import { computeStandings } from '@core/standings';
import { createSpotboardSource } from '@core/ingest/spotboard';
import { createRunFeeder } from '@core/feeder';
import { applyUrlOverrides, defaultConfig, type ResolvedConfig } from '@core/config';

import { appStore } from '@store/appStore';
import { Scoreboard } from '@ui/scoreboard/Scoreboard';
import { ScoreboardView } from '@ui/scoreboard/ScoreboardView';
import { APAC_STAR_TITLES, LIVE_FLIP_MS, type RowDecor } from '@ui/scoreboard/TeamRow';
import { BOARD_MAX_BADGES, Badges, autoLabelText } from '@ui/scoreboard/Badges';
import { ProblemCell, cellAttemptsText } from '@ui/scoreboard/ProblemCell';
import { useCellFlip } from '@ui/scoreboard/useCellFlip';
import { estimateTextEm, solvedSpineColor, hsv2rgb, ordinalSuffix } from '@ui/scoreboard/util';

// ---------------------------------------------------------------------------
// Fixtures
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

const PALETTE = ['red', 'blue', 'green', 'yellow'];

function makeContest(teams: Team[], problemIds: string[]): Contest {
  return {
    title: 'test contest',
    systemName: 'test',
    systemVersion: '0',
    problems: problemIds.map((id, i) => ({
      id,
      label: id,
      title: `Problem ${id}`,
      color: PALETTE[i % PALETTE.length],
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

/** Small contest exercising every cell color (see assertions below). */
function priorityFixture(): { contest: Contest; snapshot: Snapshot } {
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
    r('t1', 'A', 5, 'accepted'), // contest-first + first solve of A
    r('t2', 'A', 8, 'failed'),
    r('t2', 'A', 10, 'accepted'),
    r('t3', 'A', 20, 'accepted'), // last solve of A
    r('t1', 'B', 30, 'accepted'), // contest-last + first of B (sole solver: not last)
    r('t2', 'B', 40, 'failed'),
    r('t3', 'B', 45, 'pending'),
  ];
  return { contest, snapshot: computeStandings(contest, runs) };
}

function renderBoard(
  contest: Contest,
  snapshot: Snapshot,
  config: ResolvedConfig = cfg(),
  extra: Partial<Parameters<typeof Scoreboard>[0]> = {},
) {
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

function cell(container: HTMLElement, teamId: string, problemId: string): HTMLElement {
  const el = container.querySelector(
    `[data-team-id="${teamId}"] [data-problem-id="${problemId}"]`,
  );
  expect(el, `cell ${teamId}/${problemId}`).not.toBeNull();
  return el as HTMLElement;
}

// ---------------------------------------------------------------------------
// 84-team sample snapshot
// ---------------------------------------------------------------------------

describe('Scoreboard with the 2025 sample (84 teams)', () => {
  const ROOT = resolve(__dirname, '../..');
  let contest: Contest;
  let snapshot: Snapshot;
  let orgs: OrgsIndex;

  beforeAll(async () => {
    const contestJson = JSON.parse(
      readFileSync(resolve(ROOT, 'public/sample/contest.json'), 'utf8'),
    );
    const runsJson = JSON.parse(readFileSync(resolve(ROOT, 'public/sample/runs.json'), 'utf8'));
    orgs = JSON.parse(readFileSync(resolve(ROOT, 'public/orgs/orgs.json'), 'utf8'));
    const fetchStub = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('contest.json')
        ? contestJson
        : url.includes('runs.json')
          ? runsJson
          : undefined;
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const source = createSpotboardSource({
      apiBase: './sample/',
      fetchTimeout: 5000,
      excludeTeamIds: [],
      foreign: { ids: [], groups: [] },
      orgs,
      fetchImpl: fetchStub,
    });
    contest = await source.loadContest();
    const feeder = createRunFeeder(contest);
    feeder.ingest(await source.fetchRuns(null));
    feeder.feedAll();
    snapshot = computeStandings(contest, feeder.appliedRuns);
  });

  it('renders all 84 teams in standings order with 13 cells each', () => {
    const { container } = render(
      <Scoreboard snapshot={snapshot} problems={contest.problems} config={cfg()} orgs={orgs} />,
    );
    const rows = container.querySelectorAll('.team-row');
    expect(rows).toHaveLength(84);
    const first = rows[0] as HTMLElement;
    expect(first.querySelector('.team-name')?.textContent).toBe('Just use CRT');
    expect(first.querySelector('.icpc-rank')?.textContent).toBe('1st');
    expect(first.querySelectorAll('.problem-result')).toHaveLength(13);
    expect(first.querySelector('.team-penalty')?.textContent).toBe('1041 min.');
    expect(first.querySelector('.solved-count')?.textContent).toBe('10');
  });
});

// ---------------------------------------------------------------------------
// Cell color priority
// ---------------------------------------------------------------------------

describe('ProblemCell colors and attempts', () => {
  it('applies the color priority: contest-last > last > first > solved', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot);

    const t1A = cell(container, 't1', 'A');
    expect(t1A.classList.contains('solved-first')).toBe(true);
    expect(t1A.classList.contains('contest-first-solve')).toBe(true); // sparkle
    expect(t1A.classList.contains('last-solve')).toBe(false);
    expect(t1A.classList.contains('contest-last-solve')).toBe(false);

    const t2A = cell(container, 't2', 'A');
    expect(t2A.classList.contains('solved')).toBe(true);
    expect(t2A.classList.contains('solved-first')).toBe(false);
    expect(t2A.classList.contains('last-solve')).toBe(false);

    const t3A = cell(container, 't3', 'A');
    expect(t3A.classList.contains('last-solve')).toBe(true);
    expect(t3A.classList.contains('contest-last-solve')).toBe(false);

    // t1 B is first AND last solve of B AND contest-last — purple wins.
    const t1B = cell(container, 't1', 'B');
    expect(t1B.classList.contains('contest-last-solve')).toBe(true);
    expect(t1B.classList.contains('last-solve')).toBe(false);
    expect(t1B.classList.contains('solved-first')).toBe(false);

    expect(cell(container, 't2', 'B').classList.contains('failed')).toBe(true);
    expect(cell(container, 't3', 'B').classList.contains('pending')).toBe(true);
  });

  it('renders +N / −N / ?N attempt texts and the letter as real text', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot);

    const t2A = cell(container, 't2', 'A');
    expect(t2A.querySelector('.problem-label')?.textContent).toBe('A');
    expect(t2A.querySelector('.problem-attempts')?.textContent).toBe('+1');

    expect(cell(container, 't2', 'B').querySelector('.problem-attempts')?.textContent).toBe(
      '−1',
    );
    expect(cell(container, 't3', 'B').querySelector('.problem-attempts')?.textContent).toBe('?1');
    // solved on the first try: letter only, no attempts text
    expect(cell(container, 't1', 'A').querySelector('.problem-attempts')).toBeNull();
  });

  it('drops the first-solve highlight when showFirstSolve is off', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot, cfg({ showFirstSolve: false }));
    const t1A = cell(container, 't1', 'A');
    expect(t1A.classList.contains('solved')).toBe(true);
    expect(t1A.classList.contains('solved-first')).toBe(false);
  });

  it('passes flip props through (.flip-run + phase attribute)', () => {
    const { contest, snapshot } = priorityFixture();
    const standing = snapshot.byTeam.get('t1')!;
    const { container } = render(
      <ProblemCell
        problem={contest.problems[0]}
        cell={standing.cells.get('A')!}
        showFirstSolve
        flip={{
          className: 'flip-run',
          style: {},
          onAnimationEnd: () => undefined,
          'data-flip-phase': 'out',
        }}
      />,
    );
    const el = container.querySelector('.problem-result') as HTMLElement;
    expect(el.classList.contains('flip-run')).toBe(true);
    expect(el.getAttribute('data-flip-phase')).toBe('out');
  });
});

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

describe('Badges', () => {
  it('renders the exact spec texts for all five auto labels', () => {
    expect(autoLabelText({ kind: 'triedNTimes', attempts: 12 })).toBe(
      'tried 12 times to get Yes!',
    );
    expect(autoLabelText({ kind: 'contestFirstYes' })).toBe('got first yes of this contest!');
    expect(autoLabelText({ kind: 'firstToSolve', problemLabels: ['A', 'C', 'D'] })).toBe(
      'A, C, D first to solve!',
    );
    expect(autoLabelText({ kind: 'lastToSolve', problemLabels: ['B', 'E'] })).toBe(
      'B, E last to solve!',
    );
    expect(autoLabelText({ kind: 'contestLastYes' })).toBe('got last yes of this contest!');

    const { container } = render(
      <Badges
        autoLabels={[
          { kind: 'triedNTimes', attempts: 12 },
          { kind: 'firstToSolve', problemLabels: ['A', 'C', 'D'] },
        ]}
        manualLabels={['E를 마지막으로 푼 팀!']}
      />,
    );
    const texts = Array.from(container.querySelectorAll('.team-badge')).map(
      (el) => el.textContent,
    );
    expect(texts).toEqual([
      'tried 12 times to get Yes!',
      'A, C, D first to solve!',
      'E를 마지막으로 푼 팀!',
    ]);
    expect(container.querySelectorAll('.team-badge--manual')).toHaveLength(1);
  });

  it('shows auto badges on team rows and wires manual labels per team', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot, cfg(), {
      manualLabels: new Map([['t2', ['동상 수상자']]]),
    });
    const t1 = container.querySelector('[data-team-id="t1"]') as HTMLElement;
    expect(t1.textContent).toContain('got first yes of this contest!');
    const t2 = container.querySelector('[data-team-id="t2"]') as HTMLElement;
    expect(t2.textContent).toContain('동상 수상자');
  });

  // -- spec §7 badge layout --------------------------------------------------

  it('gives badges their own column so the name block is never covered', () => {
    const { contest, snapshot } = priorityFixture();
    // t1 carries four auto labels (contest-first/last yes + first solve of A
    // and B) — worst case for a name-line layout.
    const { container } = renderBoard(contest, snapshot, cfg(), {
      manualLabels: new Map([['t1', ['금상 수상자', '심사위원 특별상']]]),
    });
    const row = container.querySelector('[data-team-id="t1"]') as HTMLElement;
    const title = row.querySelector('.team-title') as HTMLElement;
    const col = row.querySelector('.team-badge-col') as HTMLElement;

    // Badges live outside the name block entirely — a separate row column.
    expect(col).not.toBeNull();
    expect(title.querySelector('.team-badges')).toBeNull();
    expect(title.contains(col)).toBe(false);
    expect(col.parentElement).toBe(title.parentElement);
    // ...and the name/group are rendered in full, not clipped by a badge.
    expect((title.querySelector('.team-name') as HTMLElement).textContent).toBe('Alpha');
    expect((title.querySelector('.team-group') as HTMLElement).textContent).toBe('KAIST');
  });

  it('hides the badges that do not fit behind a +N chip (spectator/publish)', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot, cfg(), {
      manualLabels: new Map([['t1', ['금상 수상자']]]),
    });
    const col = container.querySelector(
      '[data-team-id="t1"] .team-badge-col',
    ) as HTMLElement;
    const shown = Array.from(col.querySelectorAll('.team-badge:not(.team-badge--overflow)'));
    expect(shown).toHaveLength(BOARD_MAX_BADGES);

    const overflow = col.querySelector('.team-badge--overflow') as HTMLElement;
    expect(overflow).not.toBeNull();
    // t1: 3 auto labels + 1 manual = 4, two of which fit.
    expect(overflow.textContent).toBe(`+${4 - BOARD_MAX_BADGES}`);
    // The hidden texts stay reachable as the chip's tooltip.
    expect(overflow.title).toContain('금상 수상자');
    expect(col.textContent).not.toContain('금상 수상자');
  });

  it('shows every badge (no +N) when they all fit', () => {
    const { container } = render(
      <Badges
        autoLabels={[{ kind: 'contestFirstYes' }]}
        manualLabels={['금상 수상자']}
        maxVisible={BOARD_MAX_BADGES}
      />,
    );
    expect(container.querySelectorAll('.team-badge')).toHaveLength(2);
    expect(container.querySelector('.team-badge--overflow')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Team name overflow (spec §7: "팀명은 항상 완전히 표시")
// ---------------------------------------------------------------------------

describe('team names are never truncated', () => {
  const CSS_PATH = resolve(__dirname, '../../src/ui/scoreboard/scoreboard.css');
  const css = readFileSync(CSS_PATH, 'utf8');

  /** Body of the (first) rule whose selector list is exactly `selector`. */
  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(^|[};/])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    expect(match, `rule ${selector} not found in scoreboard.css`).not.toBeNull();
    return (match as RegExpExecArray)[2];
  }

  /** Number in front of `em` for `prop` inside `body`, or null. */
  function em(body: string, prop: string): number | null {
    const match = new RegExp(`${prop}\\s*:[^;]*?([\\d.]+)em`).exec(body);
    return match === null ? null : Number(match[1]);
  }

  /** Brace-matched body of the `@media` block starting at `head`. */
  function blockAt(head: number): string {
    const open = css.indexOf('{', head);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) return css.slice(open + 1, i);
      }
    }
    throw new Error('unbalanced @media block');
  }

  /**
   * The desktop text-fit block — the `@media (min-width: 769px)` block that
   * sizes `.team-name` (not the board-scale one, nor the narrow-desktop
   * budget override).
   */
  function desktopFitBlock(): string {
    for (let at = css.indexOf('@media (min-width: 769px)'); at !== -1; ) {
      const body = blockAt(at);
      if (body.includes('.team-name')) return body;
      at = css.indexOf('@media (min-width: 769px)', at + 1);
    }
    throw new Error('desktop .team-name fit block not found');
  }

  it('applies no ellipsis or clipping to .team-name in any rule', () => {
    // Every rule that styles a team name — desktop, mobile and detail modal.
    const nameRules = css
      .split('}')
      .filter((chunk) => /(^|[,\s])\.team-(name|detail-name)\b[^{]*\{/.test(chunk))
      .map((chunk) => chunk.slice(chunk.indexOf('{') + 1));
    expect(nameRules.length).toBeGreaterThan(0);
    for (const body of nameRules) {
      expect(body).not.toMatch(/text-overflow/);
      expect(body).not.toMatch(/overflow\s*:\s*hidden/);
    }
  });

  it('reserves an unshrinkable name column and lets the badge column give way', () => {
    const title = ruleBody('.team-title');
    const badge = ruleBody('.team-badge-col');
    // Desktop: `flex: 1 0 calc(--kr-title-budget + 0.4em)` — grow, never shrink.
    const desktopTitle = /\.team-title\s*\{([^}]*)\}/.exec(desktopFitBlock());
    expect(desktopTitle).not.toBeNull();
    expect((desktopTitle as RegExpExecArray)[1]).toMatch(/flex:\s*1\s+0\s+calc\(/);
    // The name scales with the fit estimate instead of being clipped.
    expect(desktopFitBlock()).toMatch(/font-size:\s*clamp\(.*--kr-name-em/);
    expect(title).toMatch(/flex:\s*1/);
    // The badge column is the flexible one (shrink 1) with a floor.
    expect(badge).toMatch(/flex:\s*0\s+1\s+\d/);
    expect(em(badge, 'min-width')).not.toBeNull();
  });

  /** Body of the `@media all and (max-width: 1200px)` narrow-screen block. */
  function narrowBlock(): string {
    const at = css.indexOf('@media all and (max-width: 1200px)');
    expect(at, 'narrow-screen block not found in scoreboard.css').toBeGreaterThan(-1);
    return blockAt(at);
  }

  it('fits the longest sample name at 1024x768 without shrinking below full size', () => {
    const teams: Array<{ name: string }> = JSON.parse(
      readFileSync(resolve(__dirname, '../..', 'public/sample/contest.json'), 'utf8'),
    ).teams;
    const problemCount = 13; // the sample contest

    // --- board scale at 1024x768 (scoreboard.css ~18-rows rule) -------------
    // Both terms of the min(): the viewport height over 18 four-em rows, and
    // the board width over the row's total width (the 1001-1200px tier).
    const base = Math.min((768 - 4.15 * 16) / 72, (1024 - 2.5 * 16) / 102);
    const rowPx = 2 * base; // .team-row font-size
    const rowWidthEm = (1024 - 2 * 12) / rowPx; // minus .app-main side padding

    // Cell width comes from the CSS so widening a cell has to be paid for
    // here rather than silently pushing the row over the edge.
    const cellWidth = em(ruleBody('.problem-result'), 'width') as number;
    expect(cellWidth).toBeGreaterThan(0);

    // --- fixed columns, in row-em (mirrors the rules above) ----------------
    const fixed =
      1.9 + // .solved-count (1.6em + 0.3em margin)
      (2.1 + 0.15 + 2.4 * 0.8) + // .team-ranks (icpc + gap + domestic @0.8em)
      1.2 + // .apac-slot
      1.6 + // .team-flag (1.1em + 0.25em margins)
      // .balloons are display:none at this width (the ≤1200px block)
      problemCount * cellWidth * 0.6 + // .results cells @0.6em
      3.5; // .team-penalty
    const pool = rowWidthEm - fixed; // left for .team-title + .team-badge-col

    const budget = em(desktopFitBlock(), '--kr-title-budget') as number;
    const badgeMin = em(narrowBlock(), 'min-width') as number;
    expect(budget).toBeGreaterThan(0);
    expect(badgeMin).toBeGreaterThan(0);

    // The name column's reserved width plus the badge floor still fit the row.
    expect(pool).toBeGreaterThanOrEqual(budget + 0.4 + badgeMin);

    // ...and every sample name fits that budget at the full 1em name size
    // (the .team-name clamp cap), so nothing is truncated *and* nothing has
    // to shrink.
    const widest = teams.reduce((a, b) => (estimateTextEm(a.name) > estimateTextEm(b.name) ? a : b));
    expect(estimateTextEm(widest.name) * 1).toBeLessThanOrEqual(budget);
  });

  it('keeps the balloon stack out of the row below 1200px', () => {
    const block = narrowBlock();
    expect(/\.balloons\s*\{[^}]*display:\s*none/.test(block)).toBe(true);
    // The cells are NOT shrunk here: a narrower cell brings back the wrapped
    // '?50' that the 2.8em width exists to fix.
    expect(block).not.toMatch(/\.problem-result\s*\{/);
  });

  it('fits a problem letter plus a three-digit attempt count on one line', () => {
    // Worst realistic cell content: a pending cell with a long history, on a
    // wide letter — 'M' + '?50' (the 2025 Seoul data has a 50-attempt cell).
    const body = ruleBody('.problem-result');
    const cellWidth = em(body, 'width') as number;
    const labelSize = em(ruleBody('.problem-label'), 'font-size') as number;
    const attemptsSize = em(ruleBody('.problem-attempts'), 'font-size') as number;
    const gap = em(body, 'gap') as number;

    // In em of the CELL's own font. letter-spacing (-1px per character) and
    // the border (1px a side) are absolute px and net out NEGATIVE, so they
    // give the least room back at the LARGEST board scale — the 16px cap of
    // the .scoreboard clamp is where the line is tightest.
    const cellFontPx = 16 * 2 * 0.6;
    const content =
      estimateTextEm('M') * labelSize +
      gap +
      estimateTextEm('?50') * attemptsSize -
      (4 * 1) / cellFontPx + // letter-spacing: -1px after each of 4 chars
      (2 * 1) / cellFontPx; // 1px border a side (box-sizing: border-box)
    expect(content).toBeLessThanOrEqual(cellWidth);
  });

  it('hands the fit estimate to CSS on every row', () => {
    const contest = makeContest(
      [makeTeam('t1', 'Just Reboot JungSangHwa', 'Pusan National University', false, 'KR')],
      ['A'],
    );
    const snapshot = computeStandings(contest, []);
    const { container } = renderBoard(contest, snapshot, cfg({ showTeamGroup: true }));

    const name = container.querySelector('.team-name') as HTMLElement;
    expect(name.textContent).toBe('Just Reboot JungSangHwa');
    expect(name.style.getPropertyValue('--kr-name-em')).toBe(
      String(estimateTextEm('Just Reboot JungSangHwa')),
    );
    // No inline truncation either.
    expect(name.style.textOverflow).toBe('');
    expect(name.style.overflow).toBe('');

    const group = container.querySelector('.team-group') as HTMLElement;
    expect(group.style.getPropertyValue('--kr-group-em')).toBe(
      String(estimateTextEm('Pusan National University')),
    );
  });

  it('scales an absurdly long name down instead of cutting it', () => {
    // 12em budget / 0.5em floor ⇒ text up to 24em still fits on one line.
    const long = 'A'.repeat(30);
    expect(estimateTextEm(long)).toBeGreaterThan(12 / 0.9); // would overflow at full size
    expect(estimateTextEm(long)).toBeLessThanOrEqual(12 / 0.5); // still fits at the floor
  });

  it('wraps rather than ellipsizes on mobile', () => {
    const mobileName = /\.scoreboard--mobile \.team-name\s*\{([^}]*)\}/.exec(css);
    expect(mobileName).not.toBeNull();
    expect((mobileName as RegExpExecArray)[1]).toMatch(/white-space:\s*normal/);
    expect((mobileName as RegExpExecArray)[1]).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('estimates text width per script: CJK is wider than latin, never zero', () => {
    expect(estimateTextEm('')).toBe(1); // floor — CSS divides by this value
    expect(estimateTextEm('nnnn')).toBeGreaterThan(estimateTextEm('nn'));
    expect(estimateTextEm('한글팀이름')).toBe(5); // square glyphs
    expect(estimateTextEm('iiiii')).toBeLessThan(estimateTextEm('MMMMM'));
  });
});

// ---------------------------------------------------------------------------
// Search / ranks / pagination / follow
// ---------------------------------------------------------------------------

describe('search filtering', () => {
  it('filters by case-insensitive substring over name + group', () => {
    const contest = makeContest(
      [
        makeTeam('1', 'Alpha', 'KAIST'),
        makeTeam('2', 'Beta', 'SNU'),
        makeTeam('3', 'Kappa', 'Kaist Institute'),
      ],
      ['A'],
    );
    const snapshot = computeStandings(contest, []);

    const kai = renderBoard(contest, snapshot, cfg(), { searchQuery: 'kai' });
    const kaiIds = Array.from(kai.container.querySelectorAll('.team-row')).map((el) =>
      el.getAttribute('data-team-id'),
    );
    expect(kaiIds).toEqual(['1', '3']);

    const eta = renderBoard(contest, snapshot, cfg(), { searchQuery: 'ETA' });
    const etaIds = Array.from(eta.container.querySelectorAll('.team-row')).map((el) =>
      el.getAttribute('data-team-id'),
    );
    expect(etaIds).toEqual(['2']);

    const none = renderBoard(contest, snapshot, cfg(), { searchQuery: '' });
    expect(none.container.querySelectorAll('.team-row')).toHaveLength(3);
  });
});

describe('dual ranks', () => {
  it('shows an em-dash for the domestic rank of foreign teams', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot);
    const t3 = container.querySelector('[data-team-id="t3"]') as HTMLElement;
    expect(t3.classList.contains('foreign')).toBe(true);
    expect(t3.querySelector('.domestic-rank')?.textContent).toBe('—');
    expect(t3.querySelector('.icpc-rank')?.textContent).toBe('2nd');
    const t2 = container.querySelector('[data-team-id="t2"]') as HTMLElement;
    expect(t2.querySelector('.icpc-rank')?.textContent).toBe('3rd');
    expect(t2.querySelector('.domestic-rank')?.textContent).toBe('2nd');
  });

  it('ordinalSuffix handles teens', () => {
    expect(ordinalSuffix(1)).toBe('st');
    expect(ordinalSuffix(2)).toBe('nd');
    expect(ordinalSuffix(3)).toBe('rd');
    expect(ordinalSuffix(11)).toBe('th');
    expect(ordinalSuffix(12)).toBe('th');
    expect(ordinalSuffix(13)).toBe('th');
    expect(ordinalSuffix(21)).toBe('st');
    expect(ordinalSuffix(111)).toBe('th');
  });
});

describe('pagination', () => {
  it('slices the page when config.pagination is on', () => {
    const contest = makeContest(
      ['1', '2', '3', '4', '5'].map((id) => makeTeam(id, `Team ${id}`, `Univ ${id}`)),
      ['A'],
    );
    const snapshot = computeStandings(contest, []);
    const { container } = renderBoard(
      contest,
      snapshot,
      cfg({ pagination: true, paginationSize: 2 }),
      { page: 1 },
    );
    const ids = Array.from(container.querySelectorAll('.team-row')).map((el) =>
      el.getAttribute('data-team-id'),
    );
    expect(ids).toEqual(['3', '4']);
    expect(container.querySelector('.scoreboard')?.getAttribute('data-page-count')).toBe('3');
  });
});

describe('followed team', () => {
  it('highlights and sticky-pins the followed team', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot, cfg(), { followTeamId: 't2' });
    const t2 = container.querySelector('[data-team-id="t2"]') as HTMLElement;
    expect(t2.classList.contains('followed')).toBe(true);
    expect(t2.classList.contains('sticky')).toBe(true);
    expect(
      (container.querySelector('[data-team-id="t1"]') as HTMLElement).classList.contains(
        'followed',
      ),
    ).toBe(false);
  });

  it('skips the sticky class when useFollowedTeamSticky is off', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(
      contest,
      snapshot,
      cfg({ useFollowedTeamSticky: false }),
      { followTeamId: 't2' },
    );
    const t2 = container.querySelector('[data-team-id="t2"]') as HTMLElement;
    expect(t2.classList.contains('followed')).toBe(true);
    expect(t2.classList.contains('sticky')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Balloons / APAC star slot / spine colors
// ---------------------------------------------------------------------------

describe('balloons', () => {
  it('shows tinted balloons for solved cells in solve order', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot);
    const t1Balloons = Array.from(
      (container.querySelector('[data-team-id="t1"] .balloons') as HTMLElement).querySelectorAll(
        'svg',
      ),
    );
    expect(t1Balloons).toHaveLength(2);
    // A solved at minute 5 (red) before B at minute 30 (blue)
    expect((t1Balloons[0] as SVGElement).style.getPropertyValue('--balloon-color')).toBe('red');
    expect((t1Balloons[1] as SVGElement).style.getPropertyValue('--balloon-color')).toBe('blue');
    // t3 has one solve, t2 has one solve
    expect(
      container.querySelectorAll('[data-team-id="t3"] .balloons svg'),
    ).toHaveLength(1);
  });

  it('hides balloons when showBalloons is off', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot, cfg({ showBalloons: false }));
    expect(container.querySelector('.balloons')).toBeNull();
  });
});

describe('APAC star slot', () => {
  it('renders the wired star when apac is enabled', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(
      contest,
      snapshot,
      cfg({ apac: { enabled: true } }),
      { apacStars: new Map([['t1', { tier: 'gold' as const, spinning: true }]]) },
    );
    const star = container.querySelector('[data-team-id="t1"] .kr-apac-star');
    expect(star).not.toBeNull();
    expect(star?.classList.contains('kr-apac-star--spin')).toBe(true);
    // slot exists but empty for the others
    expect(container.querySelector('[data-team-id="t2"] .apac-slot')).not.toBeNull();
    expect(container.querySelector('[data-team-id="t2"] .kr-apac-star')).toBeNull();
  });

  it('renders no slot when apac is disabled', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot);
    expect(container.querySelector('.apac-slot')).toBeNull();
  });
});

describe('solved-count spine color', () => {
  it('interpolates from red to green with odd-count desaturation', () => {
    const channels = (hex: string): [number, number, number] => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    const zero = solvedSpineColor(0, 13);
    const full = solvedSpineColor(13, 13);
    expect(zero).toMatch(/^#[0-9a-f]{6}$/);
    const [r0, g0] = channels(zero);
    expect(r0).toBeGreaterThan(g0); // red end
    const [rf, gf] = channels(full);
    expect(gf).toBeGreaterThan(rf); // green end
    // odd counts are desaturated/brightened relative to the pure ramp
    expect(solvedSpineColor(5, 13)).not.toBe(hsv2rgb(-2 / 360 + (107 / 360) * (5 / 13), 0.96, 0.31));
    // exact port check: original endpoints
    expect(zero).toBe(hsv2rgb(-2 / 360, 0.96, 0.31));
  });

  it('marks band-first rows so the count is visible once per band', () => {
    const { contest, snapshot } = priorityFixture();
    const { container } = renderBoard(contest, snapshot);
    const spines = Array.from(container.querySelectorAll('.solved-count'));
    // t1 solved 2 (band of one), t3/t2 solved 1 (band of two)
    expect(spines[0].classList.contains('spine-first')).toBe(true);
    expect(spines[0].classList.contains('spine-last')).toBe(true);
    expect(spines[1].classList.contains('spine-first')).toBe(true);
    expect(spines[1].classList.contains('spine-last')).toBe(false);
    expect(spines[2].classList.contains('spine-first')).toBe(false);
    expect(spines[2].classList.contains('spine-last')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// useCellFlip
// ---------------------------------------------------------------------------

describe('useCellFlip', () => {
  it('swaps at the midpoint between the out and in animations', async () => {
    const { result } = renderHook(() => useCellFlip(150));
    expect(result.current.flipping).toBe(false);
    expect(result.current.props.className).toBe('');

    const midpoint = vi.fn();
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.flip(midpoint);
    });
    expect(result.current.phase).toBe('out');
    expect(result.current.props.className).toBe('flip-run');
    expect(result.current.props['data-flip-phase']).toBe('out');
    expect(midpoint).not.toHaveBeenCalled();

    act(() => {
      result.current.props.onAnimationEnd(); // end of the "out" half
    });
    expect(midpoint).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('in');

    act(() => {
      result.current.props.onAnimationEnd(); // end of the "in" half
    });
    await promise;
    expect(result.current.phase).toBe('idle');
    expect(result.current.flipping).toBe(false);
    expect(midpoint).toHaveBeenCalledTimes(1); // exactly once
  });

  it('falls back to a 2x-duration timer when animation events never fire', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCellFlip(300));
      const midpoint = vi.fn();
      let resolved = false;
      act(() => {
        void result.current.flip(midpoint).then(() => {
          resolved = true;
        });
      });
      expect(result.current.phase).toBe('out');

      act(() => {
        vi.advanceTimersByTime(599);
      });
      expect(midpoint).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(midpoint).toHaveBeenCalledTimes(1);
      expect(result.current.phase).toBe('idle');
      await act(async () => {
        await Promise.resolve();
      });
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles (never hangs) when the component unmounts mid-flip, dropping the midpoint', async () => {
    const { result, unmount } = renderHook(() => useCellFlip(200));
    const midpoint = vi.fn();
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.flip(midpoint);
    });
    unmount();
    await promise; // resolves via the unmount cleanup — no timers needed
    // A torn-down flip must NOT swap the verdict in early (StrictMode dev
    // cleanup cycles re-run playback; the fresh run fires its own midpoints).
    expect(midpoint).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Live-fed cell flip (spec §5: queued runs apply "애니메이션과 함께")
// ---------------------------------------------------------------------------

describe('live-fed cell flip', () => {
  function flipFixture() {
    const contest = makeContest([makeTeam('t1', 'Alpha', 'KAIST')], ['A']);
    const r = runFactory();
    const before = computeStandings(contest, []);
    const after = computeStandings(contest, [r('t1', 'A', 10, 'accepted')]);
    return { contest, before, after };
  }

  /** Drive the board from the store, like the real feed: snapshot and flip
   *  batch land in ONE update (applyRuns runs in a single sync callback). */
  function seed(config: ResolvedConfig, contest: Contest, snapshot: Snapshot) {
    act(() => {
      appStore.setState({ contest, snapshot, config, lastAppliedFlips: null });
    });
  }

  function restore() {
    act(() => {
      appStore.setState({
        contest: null,
        snapshot: null,
        config: baseConfig,
        lastAppliedFlips: null,
      });
    });
  }

  it('flips the just-applied cell and swaps the verdict at the flip midpoint', () => {
    vi.useFakeTimers();
    try {
      const { contest, before, after } = flipFixture();
      seed(cfg(), contest, before);
      const { container } = render(<Scoreboard orgs={{}} />);
      expect(cell(container, 't1', 'A').getAttribute('data-verdict')).toBe('none');

      // One live-applied run.
      act(() => {
        appStore.setState({
          snapshot: after,
          lastAppliedFlips: { cells: [{ teamId: 't1', problemId: 'A' }], flipId: 1 },
        });
      });

      // Flip in progress: the OLD content is still shown behind the flip.
      const flipping = cell(container, 't1', 'A');
      expect(flipping.classList.contains('flip-run')).toBe(true);
      expect(flipping.getAttribute('data-verdict')).toBe('none');

      // jsdom fires no CSS animation events → the fallback timer completes
      // the flip (2× duration) and runs the midpoint verdict swap.
      act(() => {
        vi.advanceTimersByTime(LIVE_FLIP_MS * 2 + 50);
      });
      expect(cell(container, 't1', 'A').getAttribute('data-verdict')).toBe('accepted');
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('swaps instantly with no flip when config.animation is off', () => {
    try {
      const { contest, before, after } = flipFixture();
      seed(cfg({ animation: false }), contest, before);
      const { container } = render(<Scoreboard orgs={{}} />);
      act(() => {
        appStore.setState({
          snapshot: after,
          lastAppliedFlips: { cells: [{ teamId: 't1', problemId: 'A' }], flipId: 1 },
        });
      });
      const el = cell(container, 't1', 'A');
      expect(el.classList.contains('flip-run')).toBe(false);
      expect(el.getAttribute('data-verdict')).toBe('accepted');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Misc rendering
// ---------------------------------------------------------------------------

describe('misc', () => {
  it('renders an empty shell without a snapshot', () => {
    const { container } = render(
      <Scoreboard snapshot={null} problems={[]} config={cfg()} orgs={{}} />,
    );
    expect(container.querySelector('.scoreboard--empty')).not.toBeNull();
    expect(container.querySelectorAll('.team-row')).toHaveLength(0);
  });

  it('hides the group line when showTeamGroup is off', () => {
    const { contest, snapshot } = priorityFixture();
    const on = renderBoard(contest, snapshot);
    expect(on.container.querySelector('.team-group')?.textContent).toBe('KAIST');
    const off = renderBoard(contest, snapshot, cfg({ showTeamGroup: false }));
    expect(off.container.querySelector('.team-group')).toBeNull();
  });

  it('shows the school logo only when enabled and known, hiding on error', () => {
    const { contest, snapshot } = priorityFixture();
    const orgs: OrgsIndex = { KAIST: { country: 'KR', logo: 'kaist.png' } };
    const { container } = renderBoard(
      contest,
      snapshot,
      cfg({ showSchoolLogos: true }),
      { orgs },
    );
    const img = container.querySelector('[data-team-id="t1"] img.team-logo') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('./orgs/logos/kaist.png');
    // no entry for SNU → no logo img
    expect(container.querySelector('[data-team-id="t2"] img.team-logo')).toBeNull();
    // broken asset disappears
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('[data-team-id="t1"] img.team-logo')).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Attempt text and the ceremony's pending cap
// ---------------------------------------------------------------------------

describe('cell attempt text', () => {
  const pending = (attempts: number): Parameters<typeof cellAttemptsText>[0] =>
    ({
      verdict: 'pending',
      attempts,
      failedAttempts: attempts - 1,
      solvedMinute: null,
      isFirstSolve: false,
      isLastSolve: false,
      isContestFirstSolve: false,
      isContestLastSolve: false,
    }) as Parameters<typeof cellAttemptsText>[0];

  it('shows the exact pending count with no cap (the live board)', () => {
    expect(cellAttemptsText(pending(50))).toBe('?50');
    expect(cellAttemptsText(pending(1))).toBe('?1');
  });

  it('caps the pending count at the cap given (the ceremony board)', () => {
    expect(cellAttemptsText(pending(4), 5)).toBe('?4');
    expect(cellAttemptsText(pending(5), 5)).toBe('?5+'); // "5회 이상" — 5 included
    expect(cellAttemptsText(pending(50), 5)).toBe('?5+');
  });

  it('never caps a settled verdict', () => {
    const solved = { ...pending(9), verdict: 'accepted' as const, failedAttempts: 9 };
    const failed = { ...pending(9), verdict: 'failed' as const, failedAttempts: 9 };
    expect(cellAttemptsText(solved, 5)).toBe('+9');
    expect(cellAttemptsText(failed, 5)).toBe('−9');
  });
});

describe('APAC star tooltip', () => {
  it('names the tier in English on the board', () => {
    const contest = makeContest([makeTeam('t1', 'Alpha', 'Univ One')], ['A']);
    const snapshot = computeStandings(contest, []);
    const { container } = renderBoard(contest, snapshot, cfg({ apac: { enabled: true } }), {
      apacStars: new Map([['t1', { tier: 'gold' as const }]]),
    });

    const star = container.querySelector('svg.kr-apac-star');
    expect(star?.querySelector('title')?.textContent).toBe(APAC_STAR_TITLES.gold);
    expect(APAC_STAR_TITLES).toEqual({
      bronze: 'In the APAC Championship list so far',
      silver: 'Likely invited to the APAC Championship',
      gold: 'Invited to the APAC Championship',
    });
  });
});

// ---------------------------------------------------------------------------
// Store-free ScoreboardView and per-row decoration (publish modes, Task 5)
// ---------------------------------------------------------------------------

describe('ScoreboardView and row decoration', () => {
  function viewProps(contest: Contest, snapshot: Snapshot) {
    return { snapshot, problems: contest.problems, config: cfg(), orgs: {} as OrgsIndex };
  }

  function row(container: HTMLElement, teamId: string): HTMLElement {
    const el = container.querySelector(`.team-row[data-team-id="${teamId}"]`);
    expect(el, `row ${teamId}`).not.toBeNull();
    return el as HTMLElement;
  }

  it('ScoreboardView renders without the store', () => {
    const { contest, snapshot } = priorityFixture();
    const getState = vi.spyOn(appStore, 'getState');
    const subscribe = vi.spyOn(appStore, 'subscribe');
    try {
      const { container, unmount } = render(<ScoreboardView {...viewProps(contest, snapshot)} />);
      expect(container.querySelectorAll('.team-row')).toHaveLength(3);
      expect(getState).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      unmount();

      // Control: the store wrapper does read the store, so the spies work.
      render(<Scoreboard {...viewProps(contest, snapshot)} />);
      expect(subscribe).toHaveBeenCalled();
    } finally {
      getState.mockRestore();
      subscribe.mockRestore();
    }
  });

  it('advance adds team-row--advance', () => {
    const { contest, snapshot } = priorityFixture();
    const rowDecor = new Map<string, RowDecor>([['t1', { advance: true }]]);
    const { container } = render(
      <ScoreboardView {...viewProps(contest, snapshot)} rowDecor={rowDecor} />,
    );
    expect(row(container, 't1').classList.contains('team-row--advance')).toBe(true);
    expect(row(container, 't2').classList.contains('team-row--advance')).toBe(false);
    expect(row(container, 't1').classList.contains('team-row--dimmed')).toBe(false);
  });

  it('dimmed adds team-row--dimmed', () => {
    const { contest, snapshot } = priorityFixture();
    const rowDecor = new Map<string, RowDecor>([['t2', { dimmed: true }]]);
    // Through the store wrapper: Scoreboard forwards rowDecor.
    const { container } = renderBoard(contest, snapshot, cfg(), { rowDecor });
    expect(row(container, 't2').classList.contains('team-row--dimmed')).toBe(true);
    expect(row(container, 't1').classList.contains('team-row--dimmed')).toBe(false);
  });

  it('notice badge and leading header render only when given', () => {
    const { contest, snapshot } = priorityFixture();
    const rowDecor = new Map<string, RowDecor>([
      ['t1', { dimmed: true, notice: 'NOTICE', leading: <input type="checkbox" aria-label="x" /> }],
      ['t2', { dimmed: true, leading: <input type="checkbox" aria-label="y" /> }],
    ]);
    const { container } = render(
      <ScoreboardView
        {...viewProps(contest, snapshot)}
        rowDecor={rowDecor}
        leadingHeader={<span>HEAD</span>}
      />,
    );
    expect(row(container, 't1').querySelector('.team-row-notice')?.textContent).toBe('NOTICE');
    expect(row(container, 't1').classList.contains('team-row--excluded')).toBe(true);
    expect(row(container, 't2').querySelector('.team-row-notice')).toBeNull();
    expect(row(container, 't2').classList.contains('team-row--excluded')).toBe(false);
    expect(container.querySelector('.team-row-leading-header')?.textContent).toBe('HEAD');

    // No leading column on the board: no header either.
    const plain = render(
      <ScoreboardView {...viewProps(contest, snapshot)} leadingHeader={<span>HEAD</span>} />,
    );
    expect(plain.container.querySelector('.team-row-leading-header')).toBeNull();
  });

  it('value and stage icon render', () => {
    const { contest, snapshot } = priorityFixture();
    const rowDecor = new Map<string, RowDecor>([
      ['t1', { stageIcon: { stage: 'top', label: 'TOP-LABEL' }, value: '0.1740' }],
      ['t2', { stageIcon: { stage: 'school', label: 'SCHOOL-LABEL' } }],
    ]);
    const { container } = render(
      <ScoreboardView {...viewProps(contest, snapshot)} rowDecor={rowDecor} />,
    );
    const icon = (id: string): Element | null => row(container, id).querySelector('svg[data-stage]');
    expect(icon('t1')?.getAttribute('data-stage')).toBe('top');
    expect(icon('t1')?.getAttribute('aria-label')).toBe('TOP-LABEL');
    expect(icon('t1')?.getAttribute('role')).toBe('img');
    expect(icon('t2')?.getAttribute('data-stage')).toBe('school');
    expect(icon('t2')?.getAttribute('aria-label')).toBe('SCHOOL-LABEL');
    expect(icon('t3')).toBeNull();
    // No text tag any more.
    expect(container.querySelector('.team-row-tag')).toBeNull();
    expect(row(container, 't1').querySelector('.team-row-value')?.textContent).toBe('0.1740');
    // Rows without a value keep an empty slot so the columns stay aligned.
    const empty = row(container, 't3').querySelector('.team-row-value');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe('');

    // No value anywhere → no value column at all.
    const plain = render(<ScoreboardView {...viewProps(contest, snapshot)} />);
    expect(plain.container.querySelector('.team-row-value')).toBeNull();
    expect(plain.container.querySelector('svg[data-stage]')).toBeNull();
  });

  it('leading click does not open the mobile detail modal', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: /max-width:\s*768px/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    try {
      const { contest, snapshot } = priorityFixture();
      const onChange = vi.fn();
      const rowDecor = new Map<string, RowDecor>([
        ['t1', { leading: <input type="checkbox" aria-label="미자격" onChange={onChange} /> }],
      ]);
      const { container } = render(
        <ScoreboardView {...viewProps(contest, snapshot)} rowDecor={rowDecor} />,
      );
      const box = row(container, 't1').querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(box).not.toBeNull();

      fireEvent.click(box);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(box.checked).toBe(true);
      expect(container.querySelector('[role="dialog"]')).toBeNull();

      // Space on the focused checkbox must not reach the row's key handler.
      const keyDown = fireEvent.keyDown(box, { key: ' ' });
      expect(keyDown).toBe(true); // not prevented by the row
      expect(container.querySelector('[role="dialog"]')).toBeNull();

      // Control: a tap on the row itself still opens the modal.
      fireEvent.click(row(container, 't1'));
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps @store out of ScoreboardView, TeamRow and everything they import', () => {
    const SRC = resolve(__dirname, '../../src');
    const DIR = resolve(SRC, 'ui/scoreboard');
    const ALIASES: Record<string, string> = {
      '@core/': resolve(SRC, 'core') + '/',
      '@store/': resolve(SRC, 'store') + '/',
      '@ui/': resolve(SRC, 'ui') + '/',
    };

    function resolveFile(base: string): string | null {
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
      ]) {
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

    const roots = readdirSync(DIR)
      .filter((name) => /\.tsx?$/.test(name))
      .filter((name) => name !== 'Scoreboard.tsx' && name !== 'index.ts')
      .map((name) => resolve(DIR, name));
    expect(roots.map((p) => p.slice(DIR.length + 1))).toEqual(
      expect.arrayContaining(['ScoreboardView.tsx', 'TeamRow.tsx']),
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
        if (spec.startsWith('@store/') || spec === '@store') {
          offenders.push(`${file.slice(SRC.length + 1)} → ${spec}`);
          continue;
        }
        const target = resolveSpec(file, spec);
        if (target !== null && /\.tsx?$/.test(target)) queue.push(target);
      }
    }
    expect(offenders).toEqual([]);
  });
});
