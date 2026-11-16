import type { CellState, Problem, TeamStanding } from '@core/types';
import type { AwardConfig } from '@core/config';

export type FinaleType = AwardConfig['finaleType'];
export type MahjongFinalePhase = 'launch' | 'lineup' | 'anticipation' | 'strike' | 'impact' | 'settled';
export type FinaleOriginRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
export const MAHJONG_WINDUP_MS = 350;

export interface FinaleCardSnapshot {
  element: HTMLElement;
  width: number;
  height: number;
}

/** Freeze resolved styles before leaving the board's font/scale context. */
export function captureFinaleCard(source: HTMLElement): FinaleCardSnapshot {
  const element = source.cloneNode(true) as HTMLElement;
  const copyStyles = (from: HTMLElement, to: HTMLElement) => {
    const computed = getComputedStyle(from);
    for (let i = 0; i < computed.length; i++) {
      const property = computed.item(i);
      to.style.setProperty(property, computed.getPropertyValue(property));
    }
    to.style.animation = 'none';
    to.style.transition = 'none';
    Array.from(from.children).forEach((child, i) => {
      if (child instanceof HTMLElement) copyStyles(child, to.children[i] as HTMLElement);
    });
  };
  copyStyles(source, element);
  const computed = getComputedStyle(source);
  return {
    element,
    width: parseFloat(computed.width) || source.offsetWidth || 1,
    height: parseFloat(computed.height) || source.offsetHeight || 1,
  };
}

/** One clock in RevealingCell owns these phases; CSS only interpolates them. */
export const MAHJONG_FINALE_STEPS = [
  ['launch', 450], ['lineup', 500], ['anticipation', 180], ['strike', 120], ['impact', 420],
] as const;
export const MAHJONG_FINALE_MS = MAHJONG_WINDUP_MS + MAHJONG_FINALE_STEPS.reduce((sum, [, ms]) => sum + ms, 0);

export interface MahjongFinaleModel {
  teamName: string;
  teamGroup: string;
  slots: { problem: Problem; cell: CellState }[];
  finalIndex: number;
  finalCell: CellState;
}

export function buildMahjongFinaleModel(
  problems: readonly Problem[], before: TeamStanding, after: TeamStanding, problemId: string,
): MahjongFinaleModel {
  const finalIndex = problems.findIndex((p) => p.id === problemId);
  const finalCell = after.cells.get(problemId);
  if (finalIndex < 0 || !finalCell) throw new Error('Finale problem is missing from the team row');
  return {
    teamName: before.team.name, teamGroup: before.team.group,
    slots: problems.map((problem) => ({ problem: { ...problem }, cell: { ...before.cells.get(problem.id)! } })),
    finalIndex, finalCell: { ...finalCell },
  };
}

/** All positions are viewport pixels, independent of board/magnify transforms. */
export function mahjongFinaleLayout(width: number, height: number, count: number, finalIndex: number) {
  const gap = width <= 480 ? 2 : 4;
  const rowWidth = Math.min(1120, Math.max(1, width - (width <= 480 ? 20 : 40)));
  const cellWidth = Math.max(1, (rowWidth - gap * (count - 1)) / count);
  // Both the letter and the attempts must fit without grid min-content
  // expanding the actual cell beyond the calculated landing geometry.
  const cellHeight = Math.max(44, Math.min(120, cellWidth * 1.13));
  const rowLeft = (width - rowWidth) / 2;
  return {
    gap, rowWidth, rowLeft, cellWidth, cellHeight, rowTop: height / 2 - cellHeight / 2,
    targetX: rowLeft + finalIndex * (cellWidth + gap) + cellWidth / 2, targetY: height / 2,
  };
}
