/**
 * Publish prepare page (publish-modes spec §4, §5.2, §6, §7). Operator
 * build only: it shows the final board for the mode in `config.publish.mode`
 * and lets the operator download `publish-state.json`.
 *
 * - off:         the board and the save button. No inputs.
 * - preliminary: T, N, K inputs, the selection (yellow rows, stage tags,
 *   ineligible checkbox per row) and its summary and warnings.
 * - regional:    RegionalSimPanel plus the board with APAC stars and values.
 *   Edits re-evaluate live. A star whose tier changed spins once (previous
 *   tiers are tracked in a ref; the star remounts via key={tier}).
 *
 * No gate: the final board shows at once. Chrome: contest title + clock only.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Snapshot } from '@core/types';
import type { ApacStarTier } from '@core/apac';
import { selectPreliminary, type PrelimResult, type PrelimStage } from '@core/preliminary';
import { buildPublishState, type PublishDisplay, type PublishMode } from '@core/publishState';
import { useAppStore } from '@store/appStore';
import { Scoreboard, type ApacStarInfo, type RowDecor } from '@ui/scoreboard';
import { PrelimControls, prelimSummaryText } from './PrelimControls';
import { StoredInputsNotice } from './PublishControls';
import {
  formatApacValue,
  formatSiteScore,
  RegionalSimPanel,
  schoolsOf,
  useRegionalSimulation,
} from './RegionalSimPanel';
import { SaveStateButton, type SaveDetail } from './SaveStateButton';
import './publish.css';

// ---------------------------------------------------------------------------
// Clock (HH:MM)
// ---------------------------------------------------------------------------

function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);
  return formatClock(now);
}

// ---------------------------------------------------------------------------
// APAC stars + spin tracking
// ---------------------------------------------------------------------------

export interface ApacStarState {
  stars: Map<string, ApacStarTier>;
  /** Team ids whose star was granted or changed tier since the last stars. */
  spinning: Set<string>;
}

function useStarSpin(stars: Map<string, ApacStarTier>): ApacStarState {
  // Previous tiers live in a ref: comparing against them marks changed stars
  // as spinning, and the ref is advanced after commit.
  const prevTiersRef = useRef<Map<string, ApacStarTier> | null>(null);
  const spinning = useMemo(() => {
    const prev = prevTiersRef.current;
    const changed = new Set<string>();
    for (const [teamId, tier] of stars) {
      if (prev === null || prev.get(teamId) !== tier) changed.add(teamId);
    }
    return changed;
  }, [stars]);
  useEffect(() => {
    prevTiersRef.current = stars;
  }, [stars]);
  return { stars, spinning };
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const STAGE_TAGS: Record<PrelimStage, string> = { top: '상위', school: '학교', fill: '추가' };

const listText = (items: readonly string[]): string => (items.length > 0 ? items.join(', ') : '없음');
const numberText = (value: number | null): string => (value === null ? '비어 있음' : String(value));

function usePublishData() {
  const contest = useAppStore((s) => s.contest);
  const snapshot = useAppStore((s) => s.snapshot);
  const config = useAppStore((s) => s.config);
  const orgs = useAppStore((s) => s.orgs);
  const display: PublishDisplay = useMemo(
    () => ({
      showTeamGroup: config.showTeamGroup,
      showFirstSolve: config.showFirstSolve,
      showBalloons: config.showBalloons,
      showSchoolLogos: config.showSchoolLogos,
    }),
    [config.showTeamGroup, config.showFirstSolve, config.showBalloons, config.showSchoolLogos],
  );
  return { contest, snapshot, config, orgs, display };
}

interface BoardProps {
  rowDecor?: ReadonlyMap<string, RowDecor> | null;
  apacStars?: ReadonlyMap<string, ApacStarInfo> | null;
  manualLabels: ReadonlyMap<string, readonly string[]> | null;
}

/** The static board (spec §13): no row animation, no pagination slices. */
function PublishBoard({ rowDecor = null, apacStars = null, manualLabels }: BoardProps) {
  const contest = useAppStore((s) => s.contest);
  const snapshot = useAppStore((s) => s.snapshot);
  const config = useAppStore((s) => s.config);
  // The publish mode decides the star slot, not config.apac.enabled (that
  // switch is for award mode; publish-modes spec §3).
  const showStars = apacStars !== null;
  const publishConfig = useMemo(
    () => ({ ...config, animation: false, pagination: false, apac: { enabled: showStars } }),
    [config, showStars],
  );
  if (snapshot === null || contest === null) return null;
  return (
    <Scoreboard
      className="publish-board"
      snapshot={snapshot}
      problems={contest.problems}
      config={publishConfig}
      searchQuery={null}
      followTeamId={null}
      apacStars={apacStars}
      manualLabels={manualLabels}
      rowDecor={rowDecor}
    />
  );
}

// ---------------------------------------------------------------------------
// off
// ---------------------------------------------------------------------------

function OffPublish({
  snapshot,
  manualLabels,
}: {
  snapshot: Snapshot;
  manualLabels: ReadonlyMap<string, readonly string[]> | null;
}) {
  const { contest, orgs, display } = usePublishData();
  return (
    <>
      <div className="publish-actions">
        <SaveStateButton
          build={() =>
            buildPublishState({
              mode: 'off',
              title: contest?.title ?? '',
              display,
              problems: contest?.problems ?? [],
              orgs,
              snapshot,
              manualLabels,
            })
          }
          inputs={[{ label: '모드', value: 'off (최종 순위표만)' }]}
          results={[`순위표 ${snapshot.standings.length}팀`]}
        />
      </div>
      <PublishBoard manualLabels={manualLabels} />
    </>
  );
}

// ---------------------------------------------------------------------------
// preliminary
// ---------------------------------------------------------------------------

function PrelimPublish({
  snapshot,
  manualLabels,
}: {
  snapshot: Snapshot;
  manualLabels: ReadonlyMap<string, readonly string[]> | null;
}) {
  const { contest, orgs, display } = usePublishData();
  const inputs = useAppStore((s) => s.prelimInputs);
  const setPrelimInputs = useAppStore((s) => s.setPrelimInputs);
  const [resetGen, setResetGen] = useState(0);

  const { totalTeams, topN, k, ineligibleTeamIds } = inputs;
  // No selection while T or K is empty (spec §5.1).
  const result: PrelimResult | null = useMemo(() => {
    if (totalTeams === null || k === null) return null;
    return selectPreliminary(snapshot, {
      totalTeams,
      topN,
      k,
      ineligibleTeamIds: new Set(ineligibleTeamIds),
    });
  }, [snapshot, totalTeams, topN, k, ineligibleTeamIds]);

  const rowDecor = useMemo(() => {
    const ineligible = new Set(ineligibleTeamIds);
    const map = new Map<string, RowDecor>();
    for (const { team } of snapshot.standings) {
      const stage = result?.selected.get(team.id);
      const isIneligible = ineligible.has(team.id);
      map.set(team.id, {
        advance: stage !== undefined,
        dimmed: isIneligible,
        tag: stage !== undefined ? STAGE_TAGS[stage] : undefined,
        leading: (
          <input
            type="checkbox"
            className="publish-ineligible"
            aria-label={`${team.name} 미자격`}
            title="미자격"
            checked={isIneligible}
            onChange={() =>
              setPrelimInputs({
                ineligibleTeamIds: isIneligible
                  ? ineligibleTeamIds.filter((id) => id !== team.id)
                  : [...ineligibleTeamIds, team.id],
              })
            }
          />
        ),
      });
    }
    return map;
  }, [snapshot, result, ineligibleTeamIds, setPrelimInputs]);

  const ready = totalTeams !== null && k !== null && result !== null;
  const names = ineligibleTeamIds.map((id) => snapshot.byTeam.get(id)?.team.name ?? id);
  const saveInputs: SaveDetail[] = [
    { label: '모드', value: 'preliminary (예선)' },
    { label: '진출 팀 수 T', value: numberText(totalTeams) },
    { label: '상위 N', value: String(topN) },
    { label: 'K', value: numberText(k) },
    { label: '미자격 팀', value: listText(names) },
  ];
  const saveResults = result === null ? [] : [prelimSummaryText(result), ...result.warnings];

  return (
    <>
      <StoredInputsNotice onReset={() => setResetGen((n) => n + 1)} />
      <PrelimControls
        key={resetGen}
        value={inputs}
        onChange={setPrelimInputs}
        result={result}
      />
      <div className="publish-actions">
        <SaveStateButton
          disabled={!ready}
          disabledHint="T와 K를 입력하면 저장할 수 있습니다"
          build={() => {
            if (totalTeams === null || k === null || result === null) {
              throw new Error('진출 팀 수와 K를 입력하세요');
            }
            return buildPublishState({
              mode: 'preliminary',
              title: contest?.title ?? '',
              display,
              problems: contest?.problems ?? [],
              orgs,
              snapshot,
              manualLabels,
              preliminary: {
                totalTeams,
                topN,
                k,
                ineligibleTeamIds: [...ineligibleTeamIds],
                selected: [...result.selected].map(([teamId, stage]) => ({ teamId, stage })),
              },
            });
          }}
          inputs={saveInputs}
          results={saveResults}
        />
      </div>
      <PublishBoard rowDecor={rowDecor} manualLabels={manualLabels} />
    </>
  );
}

// ---------------------------------------------------------------------------
// regional
// ---------------------------------------------------------------------------

function RegionalPublish({
  snapshot,
  manualLabels,
}: {
  snapshot: Snapshot;
  manualLabels: ReadonlyMap<string, readonly string[]> | null;
}) {
  const { contest, orgs, display } = usePublishData();
  const inputs = useAppStore((s) => s.regionalInputs);
  const setRegionalInputs = useAppStore((s) => s.setRegionalInputs);
  const resetPublishInputs = useAppStore((s) => s.resetPublishInputs);
  const [resetGen, setResetGen] = useState(0);
  const schools = useMemo(() => schoolsOf(snapshot), [snapshot]);

  const simulation = useRegionalSimulation(snapshot, inputs);
  const starState = useStarSpin(simulation.stars);

  // ApacStarState → per-team {tier, spinning} for the shared board rows.
  const apacStars = useMemo(() => {
    const map = new Map<string, ApacStarInfo>();
    for (const [teamId, tier] of starState.stars) {
      map.set(teamId, { tier, spinning: starState.spinning.has(teamId) });
    }
    return map;
  }, [starState]);

  const rowDecor = useMemo(() => {
    const map = new Map<string, RowDecor>();
    for (const [teamId, value] of simulation.values) {
      map.set(teamId, { value: formatApacValue(value) });
    }
    return map;
  }, [simulation.values]);

  const { autoCounts } = simulation;
  const override = inputs.regionalOverride;
  const c = inputs.coefficients;
  const counted = (value: number | null, auto: number): string =>
    value !== null ? String(value) : `${auto} (순위표에서 센 값)`;
  const tierCount = (tier: ApacStarTier): number =>
    [...simulation.stars.values()].filter((t) => t === tier).length;

  const saveInputs: SaveDetail[] = [
    { label: '모드', value: 'regional (본선)' },
    { label: '예선 학교 수 U_p', value: numberText(inputs.prelimSchools) },
    { label: '예선 팀 수 T_p', value: numberText(inputs.prelimTeams) },
    { label: '본선 학교 수 U_r', value: counted(override.schools, autoCounts.schools) },
    { label: '본선 팀 수 T_r', value: counted(override.teams, autoCounts.teams) },
    { label: '본선 외국 팀 수 F_r', value: counted(override.foreign, autoCounts.foreign) },
    {
      label: 'S 계수',
      value: `${c.regionalSchools} / ${c.regionalTeams} / ${c.prelimSchools} / ${c.prelimTeams} / ${c.foreignTeams}`,
    },
    { label: '작년 WF 메달 학교', value: listText(inputs.wfMedalGroups) },
    { label: '다른 리저널 winner 학교', value: listText(inputs.winnerGroups) },
    { label: '다른 경로로 이미 초청된 학교', value: listText(inputs.invitedGroups) },
    { label: '이미 초청된 팀 (config)', value: listText(inputs.invitedTeamIds) },
    { label: '가정 cutoff', value: numberText(inputs.cutoff) },
  ];
  const saveResults = [
    `site score S = ${formatSiteScore(simulation.siteScore)}`,
    `계산 리스트 ${simulation.values.size}팀`,
    `별: 금색 ${tierCount('gold')}, 은색 ${tierCount('silver')}, 동색 ${tierCount('bronze')}`,
  ];

  return (
    <>
      <StoredInputsNotice onReset={() => setResetGen((n) => n + 1)} />
      <RegionalSimPanel
        key={resetGen}
        value={inputs}
        onChange={(next) => setRegionalInputs(next)}
        schools={schools}
        autoCounts={autoCounts}
        siteScore={simulation.siteScore}
        onReset={resetPublishInputs}
      />
      <div className="publish-actions">
        <SaveStateButton
          build={() =>
            buildPublishState({
              mode: 'regional',
              title: contest?.title ?? '',
              display,
              problems: contest?.problems ?? [],
              orgs,
              snapshot,
              manualLabels,
              regional: inputs,
            })
          }
          inputs={saveInputs}
          results={saveResults}
        />
      </div>
      <PublishBoard rowDecor={rowDecor} apacStars={apacStars} manualLabels={manualLabels} />
    </>
  );
}

// ---------------------------------------------------------------------------
// PublishView
// ---------------------------------------------------------------------------

export interface PublishViewProps {
  /** team id → manual awards.json labels (App wires the fetch; spec §13). */
  manualLabels?: ReadonlyMap<string, readonly string[]> | null;
}

export function PublishView({ manualLabels = null }: PublishViewProps) {
  const contest = useAppStore((s) => s.contest);
  const snapshot = useAppStore((s) => s.snapshot);
  const mode: PublishMode = useAppStore((s) => s.config.publish.mode);
  const clock = useClock();

  let body: ReactNode;
  if (snapshot === null || contest === null) {
    body = (
      <section className="publish-gate" aria-label="loading">
        <p className="publish-gate-hint">최종 순위표를 준비하는 중입니다.</p>
      </section>
    );
  } else if (mode === 'preliminary') {
    body = <PrelimPublish snapshot={snapshot} manualLabels={manualLabels} />;
  } else if (mode === 'regional') {
    body = <RegionalPublish snapshot={snapshot} manualLabels={manualLabels} />;
  } else {
    body = <OffPublish snapshot={snapshot} manualLabels={manualLabels} />;
  }

  return (
    <div className="publish-view">
      <header className="publish-header">
        <h1 className="publish-title">{contest?.title ?? 'kimchi-resolver'}</h1>
        <span className="publish-mode-tag">publish</span>
        <span className="publish-clock" aria-label="clock">
          {clock}
        </span>
      </header>
      {body}
    </div>
  );
}
