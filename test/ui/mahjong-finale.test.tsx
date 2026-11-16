import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CellState, Problem, TeamStanding } from '@core/types';
import { buildMahjongFinaleModel, mahjongFinaleLayout } from '@ui/award/mahjongFinale';
import { MahjongFinaleStage } from '@ui/award/MahjongFinaleStage';

afterEach(cleanup);

function fixture(labels = 'ABCDEFGHIJKLM', finalLabel = 'H', accepted = true) {
  const problems: Problem[] = [...labels].map((label, order) => ({
    id: `p-${label}`, label, order, title: `Problem ${label}`, color: '#58a',
  }));
  const cells = new Map<string, CellState>(problems.map((p) => [p.id, {
    teamId: 'team', problemId: p.id, verdict: p.label === finalLabel ? 'pending' : 'accepted',
    attempts: 4, failedAttempts: 0, solvedMinute: p.label === finalLabel ? null : 10,
    isFirstSolve: false, isLastSolve: false, isContestFirstSolve: false, isContestLastSolve: false,
  }]));
  const before: TeamStanding = {
    team: { id: 'team', name: 'Team Kimchi', group: 'Sample University', foreign: false },
    cells, solved: labels.length - 1, penalty: 0, lastSolvedMinute: 10,
    icpcRank: 1, domesticRank: 1, schoolRank: 1, autoLabels: [],
  };
  const finalId = `p-${finalLabel}`;
  const after = { ...before, cells: new Map(cells) };
  after.cells.set(finalId, {
    ...cells.get(finalId)!, verdict: accepted ? 'accepted' : 'failed', failedAttempts: accepted ? 3 : 4,
    solvedMinute: accepted ? 299 : null, isContestLastSolve: accepted,
  });
  return { problems, before, after, finalId };
}

describe('mahjong finale presentation', () => {
  it('copies the whole row in contest order without mutating either snapshot', () => {
    const f = fixture();
    const model = buildMahjongFinaleModel(f.problems, f.before, f.after, f.finalId);
    expect(model.slots.map((s) => s.problem.label).join('')).toBe('ABCDEFGHIJKLM');
    expect(model.finalIndex).toBe(7);
    expect(model.slots[7].cell.verdict).toBe('pending');
    expect(model.finalCell.verdict).toBe('accepted');
    model.slots[0].cell.attempts = 99;
    model.finalCell.attempts = 99;
    expect(f.before.cells.get('p-A')!.attempts).toBe(4);
    expect(f.after.cells.get('p-H')!.attempts).toBe(4);
  });

  it.each(['A', 'H', 'M'])('reserves exactly the final %s slot until impact', (label) => {
    const f = fixture('ABCDEFGHIJKLM', label);
    const model = buildMahjongFinaleModel(f.problems, f.before, f.after, f.finalId);
    render(<MahjongFinaleStage model={model} phase="anticipation" showFirstSolve
      originRect={{ left: 400, top: 300, width: 160, height: 100 }} flightCell={model.slots[model.finalIndex].cell} />);
    const row = screen.getByTestId('mahjong-finale-row');
    expect(row.children).toHaveLength(13);
    const slot = row.children[model.finalIndex] as HTMLElement;
    expect(slot.querySelector('.problem-result')).toBeNull();
    expect(slot.getAttribute('aria-label')).toContain(label);
    expect(row.textContent).not.toContain('+3');
    expect(document.querySelector('[title*="299"]')).toBeNull();
    expect(document.querySelector('.contest-last-solve')).toBeNull();
  });

  it.each([true, false])('reveals real verdict and color only on impact (accepted=%s)', (accepted) => {
    const f = fixture('ABC', 'B', accepted);
    const model = buildMahjongFinaleModel(f.problems, f.before, f.after, f.finalId);
    const props = { model, showFirstSolve: true, originRect: { left: 300, top: 200, width: 160, height: 100 }, flightCell: model.slots[1].cell };
    const view = render(<MahjongFinaleStage {...props} phase="strike" />);
    expect(document.querySelector('.contest-last-solve')).toBeNull();
    view.rerender(<MahjongFinaleStage {...props} phase="impact" />);
    const row = screen.getByTestId('mahjong-finale-row');
    expect(row.children).toHaveLength(3);
    expect(within(row).getByText(accepted ? '+3' : '−4')).toBeTruthy();
    expect(row.children[1].querySelector('.problem-result')!.getAttribute('data-verdict')).toBe(accepted ? 'accepted' : 'failed');
    expect(row.children[1].querySelector('.contest-last-solve') !== null).toBe(accepted);
    expect(screen.queryByTestId('mahjong-finale-particles') !== null).toBe(accepted);
  });

  it.each([320, 1280, 1920, 3840])('centers a bounded row and targets its first/last slot at width %s', (width) => {
    const first = mahjongFinaleLayout(width, 1080, 13, 0);
    const last = mahjongFinaleLayout(width, 1080, 13, 12);
    expect(first.rowLeft + first.rowWidth / 2).toBeCloseTo(width / 2);
    expect(first.targetY).toBe(540);
    expect(first.rowWidth).toBeLessThanOrEqual(1120);
    expect(first.rowLeft).toBeGreaterThanOrEqual(10);
    expect(first.targetX).toBeCloseTo(first.rowLeft + first.cellWidth / 2);
    expect(last.targetX).toBeCloseTo(width - first.rowLeft - first.cellWidth / 2);
    expect(first.cellWidth).toBeGreaterThan(0);
    expect(first.cellHeight).toBeGreaterThanOrEqual(44);
  });

  it('recomputes viewport positions on resize while preserving the empty last slot', () => {
    const f = fixture();
    const model = buildMahjongFinaleModel(f.problems, f.before, f.after, f.finalId);
    const originalWidth = window.innerWidth;
    render(<MahjongFinaleStage model={model} phase="anticipation" showFirstSolve
      originRect={{ left: 400, top: 300, width: 160, height: 100 }} flightCell={model.slots[7].cell} />);
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
      fireEvent(window, new Event('resize'));
      const stage = screen.getByTestId('mahjong-finale');
      expect(stage.style.getPropertyValue('--mahjong-row-left')).toBe('10px');
      expect(stage.style.getPropertyValue('--mahjong-row-width')).toBe('300px');
      expect(screen.getByTestId('mahjong-finale-row').children[7].querySelector('.problem-result')).toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('respects the group visibility setting in the portal', () => {
    const f = fixture();
    const model = buildMahjongFinaleModel(f.problems, f.before, f.after, f.finalId);
    render(<MahjongFinaleStage model={model} phase="settled" showFirstSolve showTeamGroup={false}
      originRect={{ left: 400, top: 300, width: 160, height: 100 }} flightCell={model.slots[7].cell} />);
    expect(screen.getByText('Team Kimchi')).toBeTruthy();
    expect(screen.queryByText('Sample University')).toBeNull();
  });
});
