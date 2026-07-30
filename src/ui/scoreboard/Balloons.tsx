/**
 * Balloon row for one team (spec §7): one SVG balloon per solved problem,
 * tinted with the problem's CSS color, queued in solve order (earliest solve
 * first). Rendered only when config.showBalloons.
 */
import type { CellState, Problem, TeamStanding } from '@core/types';
import { Balloon } from '@ui/icons';

export interface SolvedBalloon {
  problem: Problem;
  cell: CellState;
}

/** Solved cells of a standing in solve order (minute asc, problem order asc). */
export function solvedCellsInOrder(standing: TeamStanding, problems: Problem[]): SolvedBalloon[] {
  const solved: SolvedBalloon[] = [];
  for (const problem of problems) {
    const cell = standing.cells.get(problem.id);
    if (cell !== undefined && cell.verdict === 'accepted') solved.push({ problem, cell });
  }
  solved.sort(
    (a, b) =>
      (a.cell.solvedMinute ?? 0) - (b.cell.solvedMinute ?? 0) ||
      a.problem.order - b.problem.order,
  );
  return solved;
}

export interface BalloonsProps {
  standing: TeamStanding;
  problems: Problem[];
}

export function Balloons({ standing, problems }: BalloonsProps) {
  const solved = solvedCellsInOrder(standing, problems);
  if (solved.length === 0) return <div className="balloons" />;
  return (
    <div className="balloons">
      {solved.map(({ problem }) => (
        <Balloon
          key={problem.id}
          color={problem.color}
          size={20}
          className="balloon-item"
          title={`${problem.label} (${problem.color})`}
        />
      ))}
    </div>
  );
}
