/**
 * Static public page (publish-modes spec §5.3, §6.4, §7, §8). Renders one
 * PublishState; there is no store, feed or ingest code behind it.
 *
 * - off:         the final board only.
 * - preliminary: the saved selection as is (yellow rows, dimmed ineligible
 *   rows). Nothing is recomputed and there are no inputs.
 * - regional:    a simulation notice, the shared RegionalSimPanel on a local
 *   copy of the saved inputs (never saved; a reload restores the seed) and
 *   the board with APAC stars and values.
 *
 * Header: the contest title only (a static result has no clock, no mode tag).
 * This folder must not import `@store` or `@core/ingest` (tests/guard), and it
 * imports the scoreboard files directly, not the `@ui/scoreboard` barrel,
 * which re-exports the store wrapper.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '@core/types';
import type { ApacStarTier } from '@core/apac';
import { applyUrlOverrides, defaultConfig, type ResolvedConfig } from '@core/config';
import {
  parsePublishState,
  restoreSnapshot,
  type PublishState,
  type RegionalSimInputs,
} from '@core/publishState';
import { ScoreboardView } from '@ui/scoreboard/ScoreboardView';
import type { ApacStarInfo, RowDecor } from '@ui/scoreboard/TeamRow';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '@ui/scoreboard/useMediaQuery';
import {
  APAC_RULES_URL,
  formatApacValue,
  RegionalSimPanel,
  schoolsOf,
  useRegionalSimulation,
} from '@ui/publish/RegionalSimPanel';
import './published.css';

export const SIMULATION_BANNER =
  '이 페이지는 시뮬레이션입니다. 공식 결과가 아닙니다. 최종 초청은 모든 리저널이 끝난 다음 APAC에서 정합니다.';

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type ReadPublishDataResult =
  | { ok: true; state: PublishState }
  | { ok: false; errors: string[] };

/** Parses the text of the embedded `publish-data` script. */
export function readPublishData(text: string | null): ReadPublishDataResult {
  if (text === null || text.trim() === '') {
    return { ok: false, errors: ['publish-data: no data found in the page'] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`publish-data: not valid JSON (${reason})`] };
  }
  return parsePublishState(json);
}

export function PublishedError({ errors }: { errors: readonly string[] }) {
  return (
    <div className="published-error" role="alert">
      <h1 className="published-error-title">순위표를 표시할 수 없습니다</h1>
      <p>공개 데이터를 읽지 못했습니다. 운영자에게 알려 주세요.</p>
      <ul className="published-error-list">
        {errors.map((error, index) => (
          <li key={index}>{error}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/** The fixed board config: saved display flags, no animation, no pagination. */
function boardConfig(state: PublishState): ResolvedConfig {
  const { config } = applyUrlOverrides(defaultConfig(), '');
  return {
    ...config,
    ...state.display,
    animation: false,
    pagination: false,
    apac: { enabled: state.mode === 'regional' },
  };
}

interface BoardProps {
  state: PublishState;
  snapshot: Snapshot;
  config: ResolvedConfig;
  manualLabels: ReadonlyMap<string, readonly string[]>;
  rowDecor?: ReadonlyMap<string, RowDecor> | null;
  apacStars?: ReadonlyMap<string, ApacStarInfo> | null;
}

function Board({ state, snapshot, config, manualLabels, rowDecor = null, apacStars = null }: BoardProps) {
  return (
    <ScoreboardView
      className="published-board"
      snapshot={snapshot}
      problems={state.problems}
      config={config}
      orgs={state.orgs}
      apacStars={apacStars}
      manualLabels={manualLabels}
      rowDecor={rowDecor}
    />
  );
}

// ---------------------------------------------------------------------------
// preliminary
// ---------------------------------------------------------------------------

function PreliminaryPage(props: BoardProps & { state: PublishState & { mode: 'preliminary' } }) {
  const { state, snapshot } = props;
  // The saved list is the result: it is never recomputed from T, N or K.
  const rowDecor = useMemo(() => {
    const selected = new Set(state.preliminary.selected.map((s) => s.teamId));
    const ineligible = new Set(state.preliminary.ineligibleTeamIds);
    const map = new Map<string, RowDecor>();
    for (const { team } of snapshot.standings) {
      const advance = selected.has(team.id);
      const dimmed = ineligible.has(team.id);
      if (advance || dimmed) map.set(team.id, { advance, dimmed });
    }
    return map;
  }, [state.preliminary, snapshot]);

  return (
    <>
      <p className="published-legend">
        <span className="published-legend-swatch" aria-hidden="true" />
        노란색 = 본선 진출
      </p>
      <Board {...props} rowDecor={rowDecor} />
    </>
  );
}

// ---------------------------------------------------------------------------
// regional
// ---------------------------------------------------------------------------

/** Per-team star info; a star spins once when its tier changes after the first render. */
function useStarInfo(stars: Map<string, ApacStarTier>): Map<string, ApacStarInfo> {
  const prevRef = useRef(stars);
  const info = useMemo(() => {
    const prev = prevRef.current;
    const map = new Map<string, ApacStarInfo>();
    for (const [teamId, tier] of stars) {
      map.set(teamId, { tier, spinning: prev.get(teamId) !== tier });
    }
    return map;
  }, [stars]);
  useEffect(() => {
    prevRef.current = stars;
  }, [stars]);
  return info;
}

function RegionalPage(props: BoardProps & { state: PublishState & { mode: 'regional' } }) {
  const { state, snapshot } = props;
  const seed = state.regional;
  // Local copy: edits are never saved, a reload restores the seed.
  const [inputs, setInputs] = useState<RegionalSimInputs>(seed);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const schools = useMemo(() => schoolsOf(snapshot), [snapshot]);

  const simulation = useRegionalSimulation(snapshot, inputs);
  const apacStars = useStarInfo(simulation.stars);
  const rowDecor = useMemo(() => {
    const map = new Map<string, RowDecor>();
    for (const [teamId, value] of simulation.values) {
      map.set(teamId, { value: formatApacValue(value) });
    }
    return map;
  }, [simulation.values]);

  return (
    <>
      <p className="published-banner" role="note">
        {SIMULATION_BANNER}
      </p>
      <RegionalSimPanel
        value={inputs}
        onChange={setInputs}
        schools={schools}
        autoCounts={simulation.autoCounts}
        siteScore={simulation.siteScore}
        onReset={() => setInputs(seed)}
        collapsedByDefault={isMobile}
      />
      <p className="published-legend published-legend--stars">
        별의 의미: 동색 = 학내 3등 이내, 은색 = APAC championship 초대 가능, 금색 = APAC
        championship 진출.{' '}
        <a href={APAC_RULES_URL} target="_blank" rel="noreferrer noopener">
          ICPC Asia Pacific 2026-27 규정
        </a>
      </p>
      <Board {...props} rowDecor={rowDecor} apacStars={apacStars} />
    </>
  );
}

// ---------------------------------------------------------------------------
// PublishedApp
// ---------------------------------------------------------------------------

export function PublishedApp({ state }: { state: PublishState }) {
  const snapshot = useMemo(() => restoreSnapshot(state), [state]);
  const config = useMemo(() => boardConfig(state), [state]);
  const manualLabels = useMemo(
    () => new Map(Object.entries(state.manualLabels)),
    [state.manualLabels],
  );
  useEffect(() => {
    document.title = state.title;
  }, [state.title]);

  const board = { snapshot, config, manualLabels };
  return (
    <div className="published-view">
      <header className="published-header">
        <h1 className="published-title">{state.title}</h1>
      </header>
      {state.mode === 'preliminary' ? (
        <PreliminaryPage {...board} state={state} />
      ) : state.mode === 'regional' ? (
        <RegionalPage {...board} state={state} />
      ) : (
        <Board {...board} state={state} />
      )}
    </div>
  );
}
