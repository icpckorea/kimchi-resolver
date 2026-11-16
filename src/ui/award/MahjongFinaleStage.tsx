import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { CellState } from '@core/types';
import { ProblemCell } from '@ui/scoreboard/ProblemCell';
import {
  mahjongFinaleLayout, type FinaleCardSnapshot, type FinaleOriginRect, type MahjongFinaleModel, type MahjongFinalePhase,
} from './mahjongFinale';
import './mahjongFinale.css';

interface MahjongFinaleStageProps {
  model: MahjongFinaleModel;
  phase: MahjongFinalePhase;
  showFirstSolve: boolean;
  showTeamGroup?: boolean;
  originRect: FinaleOriginRect;
  /** Only the already displayed history, never the unrevealed final verdict. */
  flightCell: CellState;
  flightAppearance?: FinaleCardSnapshot;
}

function CapturedCard({ snapshot, width, height }: { snapshot: FinaleCardSnapshot; width: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    host?.replaceChildren(snapshot.element.cloneNode(true));
    return () => { host?.replaceChildren(); };
  }, [snapshot]);
  return <div ref={ref} style={{ width: snapshot.width, height: snapshot.height, transformOrigin: '0 0',
    transform: `scale(${width / snapshot.width}, ${height / snapshot.height})` }} />;
}

export function MahjongFinaleStage({ model, phase, showFirstSolve, showTeamGroup = true, originRect, flightCell, flightAppearance }: MahjongFinaleStageProps) {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const layout = mahjongFinaleLayout(viewport.width, viewport.height, model.slots.length, model.finalIndex);
  const revealed = phase === 'impact' || phase === 'settled';
  const finalProblem = model.slots[model.finalIndex].problem;
  const origin = originRect.width > 0 ? originRect : {
    left: viewport.width / 2 - 80, top: viewport.height / 2 - 50, width: 160, height: 100,
  };
  const style = {
    '--mahjong-row-left': `${layout.rowLeft}px`, '--mahjong-row-top': `${layout.rowTop}px`,
    '--mahjong-row-width': `${layout.rowWidth}px`, '--mahjong-gap': `${layout.gap}px`,
    '--mahjong-cell-width': `${layout.cellWidth}px`, '--mahjong-cell-height': `${layout.cellHeight}px`,
    '--mahjong-count': model.slots.length,
    '--mahjong-target-x': `${layout.targetX}px`, '--mahjong-target-y': `${layout.targetY}px`,
    '--mahjong-origin-x': `${origin.left}px`, '--mahjong-origin-y': `${origin.top}px`,
    '--mahjong-origin-width': `${origin.width}px`, '--mahjong-origin-height': `${origin.height}px`,
    '--mahjong-launch-y': `${-origin.top - origin.height - 32}px`,
    '--mahjong-strike-y': `${layout.targetY + layout.cellHeight / 2}px`,
    '--mahjong-type-size': `${Math.min(26, layout.cellWidth / 2.8)}px`,
    '--mahjong-spot-width': `${layout.rowWidth * .62}px`,
  } as CSSProperties;
  return createPortal(
    <div className={`scoreboard mahjong-stage mahjong-stage--${phase}`} style={style}
      data-testid="mahjong-finale" data-phase={phase}>
      <div className="mahjong-blackout" />
      <div className="mahjong-scene">
        <div className="mahjong-team">{model.teamName}{showTeamGroup ? <span>{model.teamGroup}</span> : null}</div>
        <div className="mahjong-row" data-testid="mahjong-finale-row">
          {model.slots.map(({ problem, cell }, index) => (
            <div key={problem.id} className={`mahjong-slot${index === model.finalIndex ? ' mahjong-slot--final' : ''}`}
              aria-label={index === model.finalIndex && !revealed ? `${problem.label}: awaiting result` : undefined}>
              {index === model.finalIndex && !revealed ? null : (
                <ProblemCell problem={problem} cell={index === model.finalIndex ? model.finalCell : cell} showFirstSolve={showFirstSolve} />
              )}
            </div>
          ))}
        </div>
        {phase === 'impact' ? <div className="mahjong-ring" aria-hidden="true" /> : null}
        {phase === 'impact' && model.finalCell.verdict === 'accepted' ? (
          <div className="mahjong-particles" data-testid="mahjong-finale-particles" aria-hidden="true">
            {Array.from({ length: 22 }, (_, i) => <i key={i} style={{
              '--dx': `${Math.cos(i * Math.PI * 2 / 22) * (80 + i % 4 * 20)}px`,
              '--dy': `${Math.sin(i * Math.PI * 2 / 22) * (60 + i % 4 * 15)}px`,
              '--turn': `${i * 37}deg`,
            } as CSSProperties} />)}
          </div>
        ) : null}
      </div>
      {phase === 'launch' || phase === 'strike' ? (
        <div key={phase} className={`mahjong-flight mahjong-flight--${phase}`} aria-hidden="true">
          {flightAppearance ? <CapturedCard snapshot={flightAppearance}
            width={phase === 'launch' ? origin.width : layout.cellWidth}
            height={phase === 'launch' ? origin.height : layout.cellHeight} /> :
            <ProblemCell problem={finalProblem} cell={flightCell} showFirstSolve={false} pendingCap={5} />}
        </div>
      ) : null}
      {phase === 'impact' ? <div className="mahjong-flash" aria-hidden="true" /> : null}
    </div>, document.body,
  );
}
