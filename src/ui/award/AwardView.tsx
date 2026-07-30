/**
 * Award ceremony view (spec §6/§7).
 *
 * Renders the scoreboard from awardMachine.snapshot with the award skin:
 * - hideName masking ("Team {id}" / "Unknown") for not-yet-revealed teams,
 * - focused team highlight + smooth auto-scroll to center,
 * - finalized teams styled distinctly with their awards.json medal icon,
 * - keyboard driving (Enter / ArrowRight / ';' / PageDown advance, Escape
 *   dismiss, PageUp explicit no-op) with a busy latch during reveal
 *   sequences (hard-timeout so it can never stick),
 * - reveal playback via the scoreboard's useCellFlip (fast flips for
 *   intermediate fails, slow for the final result per animationSpeeds),
 * - gacha shake+sparkle, finale spotlight/zoom + flowing rainbow (5s
 *   restore), full-screen AwardSlide on finalize; clicking a finalized
 *   medalist's name re-shows its slide.
 *
 * Board rows are composed from the shared scoreboard building blocks
 * (ProblemCell, useCellFlip, Badges, Balloons, util) — the award skin needs
 * per-cell overrides and masking that the plain spectator row does not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from 'zustand';

import type { AwardStepResult, CellState, Problem, Team, TeamStanding } from '@core/types';
import { appStore, type AppStore } from '@store/appStore';
import { ApacStar, AwardMedal, FlagIcon, iconRegistry } from '@ui/icons';
import type { ApacStarInfo } from '@ui/scoreboard/TeamRow';
import { ProblemCell } from '@ui/scoreboard/ProblemCell';
import { useCellFlip } from '@ui/scoreboard/useCellFlip';
import { Badges } from '@ui/scoreboard/Badges';
import { Balloons } from '@ui/scoreboard/Balloons';
import { cls, ordinalSuffix, solvedSpineColor } from '@ui/scoreboard/util';
import '@ui/scoreboard/scoreboard.css';

import { AwardSlide, type AwardSlideOther } from './AwardSlide';
import { parseAwardsJson, type AwardEntry } from './awardsData';
import {
  GACHA_SHAKE_MS,
  accumulateDisplay,
  finaleSlowFlipMs,
  matchAnimationSpeed,
  moveUpDurationSec,
  useRevealDriver,
  type ActiveReveal,
  type RevealDisplay,
} from './revealDriver';
import { FinaleDim, RainbowOverlay, SparkleOverlay } from './effects';
import './award.css';

const ADVANCE_KEYS = new Set(['Enter', 'ArrowRight', ';', 'PageDown']);

export interface AwardViewProps {
  /** Store override for tests; the app uses the singleton. */
  store?: AppStore;
  /** awards.json override for tests; by default fetched from awardsUrl. */
  awards?: AwardEntry[];
  /**
   * team id → APAC star (App wires computeApacStars per spec §13: ceremony
   * phase during the reveal, final once the machine is finished). null/absent
   * hides the star slot entirely (config.apac.enabled off).
   */
  apacStars?: ReadonlyMap<string, ApacStarInfo> | null;
}

export interface MaskedIdentity {
  name: string;
  group: string;
  masked: boolean;
}

/** hideName masking (spec §6): unrevealed teams show "Team {id}" / "Unknown". */
export function maskIdentity(
  team: Team,
  stage: string | undefined,
  hideName: boolean,
): MaskedIdentity {
  const revealed = stage === 'focused' || stage === 'finalized';
  if (!hideName || revealed) return { name: team.name, group: team.group, masked: false };
  return { name: `Team ${team.id}`, group: 'Unknown', masked: true };
}

export function AwardView({ store = appStore, awards, apacStars = null }: AwardViewProps) {
  const machine = useStore(store, (s) => s.awardMachine);
  // awardTick subscribes this component to machine mutations.
  useStore(store, (s) => s.awardTick);
  const snapshot = useStore(store, (s) => s.snapshot);
  const config = useStore(store, (s) => s.config);
  const contest = useStore(store, (s) => s.contest);

  const driver = useRevealDriver(config.award.animationSpeeds);

  // -- awards.json ----------------------------------------------------------
  const [awardsByTeam, setAwardsByTeam] = useState<Map<string, AwardEntry>>(
    () => new Map(awards?.map((entry) => [entry.teamId, entry]) ?? []),
  );
  useEffect(() => {
    if (awards !== undefined) return; // test-injected
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(config.award.awardsUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseAwardsJson(await res.json());
        if (!cancelled) setAwardsByTeam(parsed);
      } catch (err) {
        store
          .getState()
          .addSystemMessage(
            'warning',
            `awards.json could not be loaded (${
              err instanceof Error ? err.message : String(err)
            }); award slides and medals will be skipped.`,
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [awards, config.award.awardsUrl, store]);

  // -- entry-less slide auto-dismiss (spec §6) ------------------------------
  // The machine raises a slide on every finalize, but the full-screen slide
  // exists only "awards.json 데이터가 있으면". Without this dismissal an
  // invisible slide would latch and swallow every advance key (a presenter
  // remote has no Escape). An effect (not a handleStep check) also covers
  // the async awards fetch and rankBegin fast-forward edge cases.
  const machineSlideTeamId = machine?.currentSlideTeamId ?? null;
  useEffect(() => {
    if (machineSlideTeamId === null) return;
    if (!awardsByTeam.has(machineSlideTeamId)) store.getState().awardDismiss();
  }, [machineSlideTeamId, awardsByTeam, store]);

  // -- ceremony step handling ----------------------------------------------
  /** Cell in its one-keypress blink stage (cleared on the next transition). */
  const [blinkCell, setBlinkCell] = useState<{ teamId: string; problemId: string } | null>(null);
  /** Slide re-shown by clicking a finalized medalist (machine slide wins). */
  const [reshownTeamId, setReshownTeamId] = useState<string | null>(null);

  // Reveal completed → commit the deferred (post-reveal) standings into the
  // store. Until this moment the board renders the PRE-reveal snapshot so
  // solved counts, penalty, ranks and row positions cannot spoil the flip.
  const handleSequenceEnd = useCallback(() => {
    store.getState().awardCommitSnapshot();
    driver.handleSequenceEnd();
  }, [driver, store]);

  const handleStep = useCallback(
    (step: AwardStepResult | null) => {
      setBlinkCell(null);
      if (step === null) return;
      if (step.type === 'blink') {
        setBlinkCell({ teamId: step.teamId, problemId: step.problemId });
      } else if (step.type === 'reveal') {
        const solved =
          store.getState().awardMachine?.snapshot.byTeam.get(step.teamId)?.solved ?? 0;
        driver.play(step, solved);
      }
    },
    [driver, store],
  );

  const advance = useCallback(() => {
    // Busy latch: ignore keys while a reveal sequence is playing. The
    // driver's hard wall-clock deadline guarantees it can never stick.
    if (driver.isBusy()) return;
    setReshownTeamId(null);
    handleStep(store.getState().awardAdvance());
  }, [driver, handleStep, store]);

  const dismissSlide = useCallback(() => {
    setReshownTeamId(null);
    store.getState().awardDismiss();
  }, [store]);

  // -- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'PageUp') {
        event.preventDefault(); // explicit no-op (spec §6)
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissSlide();
        return;
      }
      if (ADVANCE_KEYS.has(event.key)) {
        event.preventDefault();
        advance();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [advance, dismissSlide]);

  // -- focused-team auto-scroll ---------------------------------------------
  // The machine's currentFocusedTeamId is the single source of truth: a team
  // whose reveal moved it up keeps stage 'focused' (identity stays revealed),
  // so scanning teamStage would highlight/scroll stale rows.
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const focusedTeamId = machine?.currentFocusedTeamId ?? null;
  useEffect(() => {
    if (focusedTeamId === null) return;
    const el = rowRefs.current.get(focusedTeamId);
    // scrollIntoView is missing in jsdom — optional call.
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [focusedTeamId]);

  // -- previous row order (rank-move duration, spec §6 moveUpMsPerRow) ------
  const prevIndexRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (snapshot === null) return;
    const order = new Map<string, number>();
    snapshot.standings.forEach((standing, index) => order.set(standing.team.id, index));
    prevIndexRef.current = order;
  }, [snapshot]);

  // -- finale spotlight position --------------------------------------------
  const [finalePos, setFinalePos] = useState<{ x: number; y: number } | null>(null);
  const finaleCellRef = useCallback((el: HTMLElement | null) => {
    if (el === null) {
      setFinalePos(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) setFinalePos(null); // jsdom
    else setFinalePos({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, []);

  if (machine === null || snapshot === null || contest === null) return null;

  // -- slide ----------------------------------------------------------------
  const slideTeamId = machine.currentSlideTeamId ?? reshownTeamId;
  const slideEntry = slideTeamId !== null ? awardsByTeam.get(slideTeamId) : undefined;
  const slideTeam = slideTeamId !== null ? contest.teams.get(slideTeamId) : undefined;
  const slideOthers: AwardSlideOther[] =
    slideEntry?.others.map((other): AwardSlideOther => {
      const team = contest.teams.get(other);
      return team !== undefined ? { name: team.name, group: team.group } : { name: other };
    }) ?? [];

  const finaleActive = driver.active !== null && driver.active.step.effect.finale;

  return (
    <div className="scoreboard award-view" data-testid="award-view">
      <div className="award-board">
        {snapshot.standings.map((standing, index) => (
          <AwardRow
            key={standing.team.id}
            standing={standing}
            problems={contest.problems}
            stage={machine.teamStage.get(standing.team.id)}
            focused={focusedTeamId === standing.team.id}
            moveDurationSec={moveUpDurationSec(
              Math.abs((prevIndexRef.current.get(standing.team.id) ?? index) - index),
              matchAnimationSpeed(config.award.animationSpeeds, standing.solved),
            )}
            hideName={config.award.hideName}
            showFirstSolve={config.showFirstSolve}
            showBalloons={config.showBalloons}
            showTeamGroup={config.showTeamGroup}
            problemCount={contest.problems.length}
            apacEnabled={apacStars !== null}
            apacStar={apacStars?.get(standing.team.id) ?? null}
            blinkCell={blinkCell}
            active={driver.active}
            onSequenceEnd={handleSequenceEnd}
            entry={awardsByTeam.get(standing.team.id)}
            finaleCellRef={finaleCellRef}
            setRowRef={(teamId, el) => {
              if (el === null) rowRefs.current.delete(teamId);
              else rowRefs.current.set(teamId, el);
            }}
            onMedalistClick={(teamId) => {
              if (awardsByTeam.has(teamId)) setReshownTeamId(teamId);
            }}
          />
        ))}
      </div>
      {finaleActive ? <FinaleDim x={finalePos?.x ?? null} y={finalePos?.y ?? null} /> : null}
      {slideTeamId !== null && slideEntry !== undefined && slideTeam !== undefined ? (
        <AwardSlide
          entry={slideEntry}
          teamName={slideTeam.name}
          teamGroup={slideTeam.group}
          others={slideOthers}
          onClose={dismissSlide}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board row (award skin over the scoreboard building blocks)
// ---------------------------------------------------------------------------

interface AwardRowProps {
  standing: TeamStanding;
  problems: Problem[];
  stage: string | undefined;
  /** True only for the machine's current focus (single team at a time). */
  focused: boolean;
  /** Layout-move duration from the team's animation speed band (spec §6). */
  moveDurationSec: number;
  hideName: boolean;
  showFirstSolve: boolean;
  showBalloons: boolean;
  showTeamGroup: boolean;
  problemCount: number;
  apacEnabled: boolean;
  apacStar: ApacStarInfo | null;
  blinkCell: { teamId: string; problemId: string } | null;
  active: ActiveReveal | null;
  onSequenceEnd: () => void;
  entry: AwardEntry | undefined;
  finaleCellRef: (el: HTMLElement | null) => void;
  setRowRef: (teamId: string, el: HTMLElement | null) => void;
  onMedalistClick: (teamId: string) => void;
}

function AwardRow({
  standing,
  problems,
  stage,
  focused,
  moveDurationSec,
  hideName,
  showFirstSolve,
  showBalloons,
  showTeamGroup,
  problemCount,
  apacEnabled,
  apacStar,
  blinkCell,
  active,
  onSequenceEnd,
  entry,
  finaleCellRef,
  setRowRef,
  onMedalistClick,
}: AwardRowProps) {
  const team = standing.team;
  const identity = maskIdentity(team, stage, hideName);
  const finalized = stage === 'finalized';
  // Finale row: lifted ABOVE the full-screen dim veil (the row is a stacking
  // context — focused z-index + framer-motion transforms — so the cell's own
  // z-index alone could never escape it). Stays lifted through the 5s hold
  // because `active` persists until the driver restores.
  const finaleRow =
    active !== null && active.step.effect.finale && active.step.teamId === team.id;
  const medalist = finalized && entry !== undefined;
  const MedalIcon =
    entry !== undefined
      ? ((entry.icon !== undefined ? iconRegistry[entry.icon] : undefined) ?? AwardMedal)
      : null;

  return (
    <motion.div
      layout="position"
      transition={{ type: 'tween', duration: moveDurationSec, ease: 'easeInOut' }}
      className={cls(
        'team-row',
        'award-row',
        identity.masked && 'award-team-hidden',
        focused && 'award-row-focused',
        finalized && 'award-row-finalized',
        finaleRow && 'award-row-finale',
      )}
      data-testid={`award-row-${team.id}`}
      data-team-id={team.id}
      data-solved={standing.solved}
      ref={(el: HTMLElement | null) => setRowRef(team.id, el)}
    >
      <div
        className="solved-count spine-first spine-last"
        style={{ backgroundColor: solvedSpineColor(standing.solved, problemCount) }}
      >
        {standing.solved}
      </div>

      <div className="team-ranks">
        <span className="team-rank icpc-rank">
          {standing.icpcRank}
          <span className="rank-suffix">{ordinalSuffix(standing.icpcRank)}</span>
        </span>
        {standing.domesticRank !== null ? (
          <span className="team-rank domestic-rank">
            {standing.domesticRank}
            <span className="rank-suffix">{ordinalSuffix(standing.domesticRank)}</span>
          </span>
        ) : (
          <span className="team-rank domestic-rank rank-none">{'—'}</span>
        )}
      </div>

      {apacEnabled ? (
        <div className="apac-slot">
          {apacStar !== null ? (
            <ApacStar
              key={apacStar.tier}
              tier={apacStar.tier}
              spinning={apacStar.spinning}
              size={20}
              className="team-apac-star"
              title={`APAC ${apacStar.tier} star`}
            />
          ) : null}
        </div>
      ) : null}

      {/* Masked teams keep their flag hidden too (a flag leaks the school). */}
      <FlagIcon country={identity.masked ? undefined : team.countryCode} size={22} className="team-flag" />

      <div className="team-title">
        <div className="team-name-line">
          {medalist && MedalIcon !== null ? (
            <span className="award-medal-slot" data-testid={`award-medal-${team.id}`}>
              <MedalIcon
                size="1.2em"
                title={typeof entry.rank === 'string' ? entry.rank : undefined}
              />
            </span>
          ) : null}
          <span
            className={cls('team-name', medalist && 'award-medalist-name')}
            onClick={medalist ? () => onMedalistClick(team.id) : undefined}
          >
            {identity.name}
          </span>
          <Badges
            autoLabels={standing.autoLabels}
            // Manual labels are spoilers until finalize (spec §6).
            manualLabels={finalized && entry !== undefined ? entry.labels : []}
          />
        </div>
        {showTeamGroup ? <div className="team-group">{identity.group}</div> : null}
      </div>

      {showBalloons ? <Balloons standing={standing} problems={problems} /> : null}

      <div className="results">
        {problems.map((problem) => {
          const cell = standing.cells.get(problem.id)!;
          const revealing =
            active !== null &&
            active.step.teamId === team.id &&
            active.step.problemId === problem.id;
          if (revealing) {
            return (
              <RevealingCell
                key={`${problem.id}:${active.seq}`}
                problem={problem}
                baseCell={cell}
                showFirstSolve={showFirstSolve}
                active={active}
                onSequenceEnd={onSequenceEnd}
                finaleCellRef={finaleCellRef}
                testId={`award-cell-${team.id}-${problem.id}`}
              />
            );
          }
          const blinking =
            blinkCell !== null &&
            blinkCell.teamId === team.id &&
            blinkCell.problemId === problem.id;
          return (
            <span
              key={problem.id}
              className={cls('award-cell-fx', blinking && 'award-cell-blink')}
              data-testid={`award-cell-${team.id}-${problem.id}`}
            >
              <ProblemCell problem={problem} cell={cell} showFirstSolve={showFirstSolve} />
            </span>
          );
        })}
      </div>

      <div className="team-penalty">
        {standing.penalty}
        <span className="penalty-unit"> min.</span>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Revealing cell: plays one reveal sequence with the scoreboard flip hook
// ---------------------------------------------------------------------------

interface RevealingCellProps {
  problem: Problem;
  /** Snapshot cell — already carries the FINAL revealed state. */
  baseCell: CellState;
  showFirstSolve: boolean;
  active: ActiveReveal;
  onSequenceEnd: () => void;
  finaleCellRef: (el: HTMLElement | null) => void;
  testId: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function RevealingCell({
  problem,
  baseCell,
  showFirstSolve,
  active,
  onSequenceEnd,
  finaleCellRef,
  testId,
}: RevealingCellProps) {
  const { step, speed } = active;
  const [display, setDisplay] = useState<RevealDisplay>(() => ({
    // Until the first flip midpoint the cell still shows its frozen pending
    // state — exactly what the board displayed before the keypress ('?N'
    // with N = pre-freeze + masked attempts). baseCell is the PRE-reveal
    // cell (the store snapshot commits only after the sequence ends).
    verdict: 'pending',
    attempts: baseCell.attempts,
    failedAttempts: step.preFreeze.failedAttempts,
    solvedMinute: null,
  }));
  const [shaking, setShaking] = useState(false);
  const [done, setDone] = useState(false);
  const [activeFlip, setActiveFlip] = useState<'fast' | 'slow' | null>(null);

  const fastCtl = useCellFlip(speed.fastFlip);
  // Finale: the final flip runs VERY slowly (spec §7 — 4~5× slowFlip, >= 3s).
  const slowCtl = useCellFlip(
    step.effect.finale ? finaleSlowFlipMs(speed.slowFlip) : speed.slowFlip,
  );
  const fastRef = useRef(fastCtl);
  fastRef.current = fastCtl;
  const slowRef = useRef(slowCtl);
  slowRef.current = slowCtl;
  const endRef = useRef(onSequenceEnd);
  endRef.current = onSequenceEnd;

  // The playback sequence — mount-only; the component is keyed per reveal.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const runs = step.runs;
      const lastIndex = runs.length - 1;
      for (let i = 0; i <= lastIndex; i++) {
        if (cancelled) return;
        const isFinal = i === lastIndex;
        if (isFinal && step.effect.gacha) {
          setShaking(true);
          await delay(GACHA_SHAKE_MS);
          if (cancelled) return;
        }
        setActiveFlip(isFinal ? 'slow' : 'fast');
        const ctl = isFinal ? slowRef.current : fastRef.current;
        // Verdict swap at the flip midpoint (original spotboard behavior).
        // The cancelled guard keeps a superseded playback run (StrictMode
        // dev double-mount) from firing its pending midpoint early.
        await ctl.flip(() => {
          if (!cancelled) setDisplay(accumulateDisplay(runs, i, step.preFreeze));
        });
      }
      if (cancelled) return;
      // Shake stops and the cell returns exactly to rest after the flip.
      setShaking(false);
      setActiveFlip(null);
      setDone(true);
      endRef.current();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While animating, derived color flags must not leak the final state.
  const cellToRender: CellState = done
    ? baseCell
    : {
        ...baseCell,
        verdict: display.verdict,
        attempts: display.attempts,
        failedAttempts: display.failedAttempts,
        solvedMinute: display.solvedMinute,
        isFirstSolve: false,
        isLastSolve: false,
        isContestFirstSolve: false,
        isContestLastSolve: false,
      };

  const flipProps =
    activeFlip === 'fast' ? fastCtl.props : activeFlip === 'slow' ? slowCtl.props : undefined;

  return (
    <span
      className={cls(
        'award-cell-fx',
        shaking && 'award-cell-gacha',
        step.effect.finale && 'award-cell-finale',
      )}
      data-testid={testId}
      ref={step.effect.finale ? finaleCellRef : undefined}
    >
      <ProblemCell
        problem={problem}
        cell={cellToRender}
        showFirstSolve={showFirstSolve}
        flip={flipProps}
      />
      {shaking && !step.effect.finale ? <SparkleOverlay /> : null}
      {/* The rainbow is the finale VARIANT of the gacha effect (spec §7):
          it plays only while the gacha shake runs ("진동이 멈출 때까지") —
          never when the gacha roll missed. Spotlight/zoom stays finale-only. */}
      {shaking && step.effect.finale ? <RainbowOverlay /> : null}
    </span>
  );
}
