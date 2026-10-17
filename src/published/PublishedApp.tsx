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
 * Header: the contest title and the 한/영 switch (a static result has no clock,
 * no mode tag). Every text comes from `MESSAGES[lang]` (./i18n).
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
import { countSchools, type PrelimStage } from '@core/preliminary';
import { StageIcon } from '@ui/icons';
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
import { LangToggle, MESSAGES, useLang, type PublishedMessages } from './i18n';
import './published.css';

/** The Korean banner text (the English one is in MESSAGES.en). */
export const SIMULATION_BANNER = MESSAGES.ko.banner;

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
  const [lang, setLang] = useLang();
  const m = MESSAGES[lang];
  return (
    <div className="published-error-page">
      <div className="published-error-bar">
        <LangToggle lang={lang} onChange={setLang} />
      </div>
      <div className="published-error" role="alert">
        <h1 className="published-error-title">{m.errorTitle}</h1>
        <p>{m.errorBody}</p>
        <ul className="published-error-list">
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      </div>
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

interface PageProps {
  m: PublishedMessages;
}

function PreliminaryPage(
  props: BoardProps & PageProps & { state: PublishState & { mode: 'preliminary' } },
) {
  const { state, snapshot, m } = props;
  // The saved list is the result: it is never recomputed from T, N or K.
  const rowDecor = useMemo(() => {
    const stageOf = new Map(state.preliminary.selected.map((s) => [s.teamId, s.stage]));
    const ineligible = new Set(state.preliminary.ineligibleTeamIds);
    const map = new Map<string, RowDecor>();
    for (const { team } of snapshot.standings) {
      const stage = stageOf.get(team.id);
      const dimmed = ineligible.has(team.id);
      if (stage !== undefined || dimmed) {
        map.set(team.id, {
          advance: stage !== undefined,
          dimmed,
          stageIcon: stage !== undefined ? { stage, label: m.stageLabels[stage] } : undefined,
        });
      }
    }
    return map;
  }, [state.preliminary, snapshot, m]);

  const stageCounts = useMemo(() => {
    const counts: Record<PrelimStage, number> = { top: 0, school: 0, fill: 0 };
    for (const { stage } of state.preliminary.selected) counts[stage] += 1;
    return counts;
  }, [state.preliminary]);
  const stages: PrelimStage[] = ['top', 'school', 'fill'];
  const schoolCount = useMemo(
    () => countSchools(snapshot, state.preliminary.selected.map((s) => s.teamId)),
    [state.preliminary, snapshot],
  );

  return (
    <>
      <p className="published-legend">
        <span className="published-legend-swatch" aria-hidden="true" />
        {m.advanceLegend}
      </p>
      <p className="published-legend published-advance-summary">
        {m.advanceSummary(state.preliminary.selected.length, schoolCount)}
      </p>
      <ul className="published-legend published-stage-legend">
        {stages.map((stage) => (
          <li key={stage}>
            <StageIcon stage={stage} className="published-stage-icon" />
            {m.stageLegend(stage, state.preliminary.topN, state.preliminary.k)} ({m.teamCount(stageCounts[stage])})
          </li>
        ))}
      </ul>
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

function RegionalPage(props: BoardProps & PageProps & { state: PublishState & { mode: 'regional' } }) {
  const { state, snapshot, m } = props;
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
        {m.banner}
      </p>
      <RegionalSimPanel
        value={inputs}
        onChange={setInputs}
        schools={schools}
        autoCounts={simulation.autoCounts}
        siteScore={simulation.siteScore}
        onReset={() => setInputs(seed)}
        collapsedByDefault={isMobile}
        messages={m.regional}
      />
      <p className="published-legend published-legend--stars">
        {m.starLegend}{' '}
        <a href={APAC_RULES_URL} target="_blank" rel="noreferrer noopener">
          {m.regional.rulesLink}
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

  const [lang, setLang] = useLang();
  const m = MESSAGES[lang];

  const board = { snapshot, config, manualLabels };
  return (
    <div className="published-view">
      <header className="published-header">
        <h1 className="published-title">{state.title}</h1>
        <LangToggle lang={lang} onChange={setLang} />
      </header>
      {state.mode === 'preliminary' ? (
        <PreliminaryPage {...board} m={m} state={state} />
      ) : state.mode === 'regional' ? (
        <RegionalPage {...board} m={m} state={state} />
      ) : (
        <Board {...board} state={state} />
      )}
    </div>
  );
}
