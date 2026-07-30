/**
 * Award ceremony view (spec §6/§7).
 *
 * Renders the scoreboard from awardMachine.snapshot with the award skin:
 * - hideName masking ("Team {id}" / "Unknown") for not-yet-revealed teams,
 * - focused team highlight + smooth auto-scroll to center,
 * - finalized teams styled distinctly with their awards.json medal icon,
 * - keyboard driving (Enter / ArrowRight / ';' / PageDown advance, Escape
 *   dismiss, PageUp explicit no-op) with a busy latch during reveal
 *   sequences (hard-timeout so it can never stick). While a slide is up an
 *   advance key is consumed as its dismissal, so PageDown alone drives the
 *   whole ceremony (projector remotes have no Escape; spec §6),
 * - reveal playback via the scoreboard's useCellFlip (intermediate fails on
 *   the ease-in-out pacing curve of revealFlipDurations — slow start, fast
 *   middle, slow finish — then the slow verdict flip per animationSpeeds),
 * - gacha shake+sparkle, the 6-step finale sequence (pre-heat blink → zoom +
 *   spotlight + rainbow + shake → slow flips → slower verdict flip → shake
 *   stops, confetti on Yes → ~5s restore), full-screen AwardSlide on
 *   finalize; clicking a finalized medalist's name re-shows its slide.
 *
 * awards.json comes from the store (loaded during boot), NOT from a fetch
 * here: the machine takes the entry ids at construction and raises a slide
 * only for a team that has one (spec §6). The view therefore never has to
 * close a slide the ceremony should not have opened.
 *
 * Board rows are composed from the shared scoreboard building blocks
 * (ProblemCell, useCellFlip, Badges, Balloons, util) — the award skin needs
 * per-cell overrides and masking that the plain spectator row does not.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
import {
  cls,
  groupFitStyle,
  nameFitStyle,
  ordinalSuffix,
  solvedSpineColor,
} from '@ui/scoreboard/util';
import '@ui/scoreboard/scoreboard.css';

import { AwardSlide, type AwardSlideOther } from './AwardSlide';
import type { AwardEntry } from './awardsData';
import {
  FINALE_PREHEAT_MS,
  FINALE_ZOOM_MS,
  GACHA_SHAKE_MS,
  accumulateDisplay,
  flipMsAt,
  matchAnimationSpeed,
  moveUpDurationSec,
  useRevealDriver,
  type ActiveReveal,
  type FinalePhase,
  type RevealDisplay,
} from './revealDriver';
import { ConfettiBurst, FinaleDim, RainbowOverlay, SparkleOverlay } from './effects';
import './award.css';

const ADVANCE_KEYS = new Set(['Enter', 'ArrowRight', ';', 'PageDown']);

export interface AwardViewProps {
  /** Store override for tests; the app uses the singleton. */
  store?: AppStore;
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

export function AwardView({ store = appStore, apacStars = null }: AwardViewProps) {
  const machine = useStore(store, (s) => s.awardMachine);
  // awardTick subscribes this component to machine mutations.
  useStore(store, (s) => s.awardTick);
  const snapshot = useStore(store, (s) => s.snapshot);
  const config = useStore(store, (s) => s.config);
  const contest = useStore(store, (s) => s.contest);
  // awards.json is loaded by the store during boot — the machine takes the
  // entry ids at construction (spec §6), so the view must read the SAME map
  // it was built from. A second fetch here could disagree with the machine.
  const awardsByTeam = useStore(store, (s) => s.awards);

  const driver = useRevealDriver(config.award.animationSpeeds, {
    flip: config.award.finaleFlipSlowdown,
    intermediateFlip: config.award.finaleIntermediateFlipSlowdown,
  });

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
    // A re-shown slide (clicking a finalized medalist) lives only in the UI —
    // the machine knows nothing about it, so the advance key is consumed here
    // (spec §6: an advance key closes a visible slide, the NEXT press
    // advances). Machine-raised slides are consumed inside advance() itself,
    // which returns 'slide-on' without touching the ceremony.
    if (reshownTeamId !== null) {
      setReshownTeamId(null);
      return;
    }
    handleStep(store.getState().awardAdvance());
  }, [driver, handleStep, reshownTeamId, store]);

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
        // Also the slide-dismiss key: `advance` consumes the press whenever a
        // slide is on screen (spec §6 — the ceremony must run on PageDown
        // alone), and the two-step "close, then advance" guard is preserved.
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

  // -- finale sequence phase (spec §7, 6 fixed steps) -----------------------
  // RevealingCell drives its own playback, so it reports the phase upward:
  // the dim/spotlight (step 2) must NOT be on during the pre-heat (step 1),
  // and the confetti (step 5) is a full-screen layer that cannot live inside
  // the zoomed (transformed) cell.
  const [finalePhase, setFinalePhase] = useState<FinalePhase | null>(null);

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

  const finaleStep = driver.active !== null && driver.active.step.effect.finale
    ? driver.active.step
    : null;
  // Step 2 onward: zoom + spotlight + dim (the pre-heat keeps the board plain).
  const finaleZoomed = finaleStep !== null && finalePhase !== null && finalePhase !== 'preheat';
  // Step 5: confetti burst, Yes verdict only.
  const finaleConfetti =
    finaleStep !== null &&
    finalePhase === 'settled' &&
    finaleStep.runs[finaleStep.runs.length - 1].verdict === 'accepted';

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
            // solved 스파인 밴드 (spec §7): the colour band runs CONTINUOUSLY
            // through a same-solved group and only the group's first row shows
            // the number — award mode included.
            spineFirst={
              index === 0 || snapshot.standings[index - 1].solved !== standing.solved
            }
            spineLast={
              index === snapshot.standings.length - 1 ||
              snapshot.standings[index + 1].solved !== standing.solved
            }
            hideName={config.award.hideName}
            showFirstSolve={config.showFirstSolve}
            showBalloons={config.showBalloons}
            showTeamGroup={config.showTeamGroup}
            problemCount={contest.problems.length}
            apacEnabled={apacStars !== null}
            apacStar={apacStars?.get(standing.team.id) ?? null}
            blinkCell={blinkCell}
            active={driver.active}
            finaleZoomed={finaleZoomed}
            onSequenceEnd={handleSequenceEnd}
            onFinalePhase={setFinalePhase}
            entry={awardsByTeam.get(standing.team.id)}
            finaleCellRef={finaleCellRef}
            setRowRef={(teamId, el) => {
              if (el === null) rowRefs.current.delete(teamId);
              else rowRefs.current.set(teamId, el);
            }}
            onMedalistClick={(teamId) => {
              // A machine slide already owns the screen; queueing a re-show
              // behind it would pop up an unexpected second slide after its
              // dismissal (and swallow another keypress).
              if (machine.currentSlideTeamId !== null) return;
              if (awardsByTeam.has(teamId)) setReshownTeamId(teamId);
            }}
          />
        ))}
      </div>
      {finaleZoomed ? <FinaleDim x={finalePos?.x ?? null} y={finalePos?.y ?? null} /> : null}
      {finaleConfetti ? (
        <ConfettiBurst x={finalePos?.x ?? null} y={finalePos?.y ?? null} />
      ) : null}
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
  /** First/last row of a same-solved band (rounded corner + visible count). */
  spineFirst: boolean;
  spineLast: boolean;
  hideName: boolean;
  showFirstSolve: boolean;
  showBalloons: boolean;
  showTeamGroup: boolean;
  problemCount: number;
  apacEnabled: boolean;
  apacStar: ApacStarInfo | null;
  blinkCell: { teamId: string; problemId: string } | null;
  active: ActiveReveal | null;
  /** Finale reached step 2+ (zoom/spotlight up) — lifts the hosting row. */
  finaleZoomed: boolean;
  onSequenceEnd: () => void;
  onFinalePhase: (phase: FinalePhase | null) => void;
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
  spineFirst,
  spineLast,
  hideName,
  showFirstSolve,
  showBalloons,
  showTeamGroup,
  problemCount,
  apacEnabled,
  apacStar,
  blinkCell,
  active,
  finaleZoomed,
  onSequenceEnd,
  onFinalePhase,
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
  // z-index alone could never escape it). Lifted from step 2 (the pre-heat
  // has no veil) and stays lifted through the 5s hold, because `active`
  // persists until the driver restores.
  const finaleRow = finaleZoomed && active !== null && active.step.teamId === team.id;
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
        className={cls('solved-count', spineFirst && 'spine-first', spineLast && 'spine-last')}
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
            style={nameFitStyle(identity.name)}
            onClick={medalist ? () => onMedalistClick(team.id) : undefined}
          >
            {identity.name}
          </span>
        </div>
        {showTeamGroup ? (
          <div className="team-group" style={groupFitStyle(identity.group)}>
            {identity.group}
          </div>
        ) : null}
      </div>

      {/* Dedicated badge column (spec §7): never covers the name. In award
       * mode 2+ labels cycle bottom→top, one at a time. */}
      <div className="team-badge-col">
        <Badges
          autoLabels={standing.autoLabels}
          // Manual labels are spoilers until finalize (spec §6).
          manualLabels={finalized && entry !== undefined ? entry.labels : []}
          carousel
        />
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
                onFinalePhase={onFinalePhase}
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
  /** Reports the finale phase upward (null for a normal reveal / teardown). */
  onFinalePhase: (phase: FinalePhase | null) => void;
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
  onFinalePhase,
  finaleCellRef,
  testId,
}: RevealingCellProps) {
  const { step, flip } = active;
  const finale = step.effect.finale;
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
  /** Duration of the flip in flight — the eased pacing varies per flip (spec §6). */
  const [flipMs, setFlipMs] = useState(flip.fast);
  /** Null for a normal reveal; the finale walks preheat → … → settled. */
  const [phase, setPhase] = useState<FinalePhase | null>(finale ? 'preheat' : null);

  // Flip durations come from the driver: a normal reveal uses the matched
  // band, the finale uses the slowed-down variants (spec §7 steps 3 and 4).
  const fastCtl = useCellFlip(flip.fast);
  const slowCtl = useCellFlip(flip.slow);
  const fastRef = useRef(fastCtl);
  fastRef.current = fastCtl;
  const slowRef = useRef(slowCtl);
  slowRef.current = slowCtl;
  const endRef = useRef(onSequenceEnd);
  endRef.current = onSequenceEnd;
  const phaseRef = useRef(onFinalePhase);
  phaseRef.current = onFinalePhase;

  // The playback sequence — mount-only; the component is keyed per reveal.
  useEffect(() => {
    let cancelled = false;
    /** Set locally AND report upward (dim/confetti live outside the cell). */
    const goto = (next: FinalePhase): void => {
      setPhase(next);
      phaseRef.current(next);
    };
    void (async () => {
      // ---- Finale steps 1-2 (spec §7): pre-heat, then zoom + spotlight +
      // rainbow + shake, both BEFORE any flip starts.
      if (finale) {
        goto('preheat');
        await delay(FINALE_PREHEAT_MS);
        if (cancelled) return;
        goto('spotlight');
        setShaking(true);
        await delay(FINALE_ZOOM_MS);
        if (cancelled) return;
        goto('flip');
      }

      const runs = step.runs;
      const lastIndex = runs.length - 1;
      for (let i = 0; i <= lastIndex; i++) {
        if (cancelled) return;
        const isFinal = i === lastIndex;
        // Non-finale gacha: the shake leads into the last flip. The finale is
        // already shaking since step 2 — flips run WHILE it shakes (step 3).
        if (isFinal && step.effect.gacha && !finale) {
          setShaking(true);
          await delay(GACHA_SHAKE_MS);
          if (cancelled) return;
        }
        setActiveFlip(isFinal ? 'slow' : 'fast');
        // Ease-in-out pacing (spec §6): every intermediate flip has its own
        // duration; the verdict flip keeps the plain slow one.
        setFlipMs(flipMsAt(flip, i, runs.length));
        const ctl = isFinal ? slowRef.current : fastRef.current;
        // Verdict swap at the flip midpoint (original spotboard behavior).
        // The cancelled guard keeps a superseded playback run (StrictMode
        // dev double-mount) from firing its pending midpoint early.
        await ctl.flip(() => {
          if (!cancelled) setDisplay(accumulateDisplay(runs, i, step.preFreeze));
        });
      }
      if (cancelled) return;
      // ---- Step 5: the shake stops, the cell returns exactly to rest, and a
      // Yes verdict fires the confetti (AwardView renders it full-screen).
      setShaking(false);
      setActiveFlip(null);
      setDone(true);
      if (finale) goto('settled');
      // ---- Step 6: the driver holds the zoom/spotlight/overlay for ~5s.
      endRef.current();
    })();
    return () => {
      cancelled = true;
      phaseRef.current(null);
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

  // The hooks are created with the band durations, but the eased pacing gives
  // each intermediate flip its own length — override the CSS half-duration for
  // the flip in flight. useCellFlip's own 2× fallback timer stays bound to the
  // (never shorter) band value, so a lost animationend still cannot wedge the
  // sequence, and the driver's busy deadline stays an upper bound.
  const activeCtl = activeFlip === 'fast' ? fastCtl : activeFlip === 'slow' ? slowCtl : null;
  const flipProps =
    activeCtl === null
      ? undefined
      : {
          ...activeCtl.props,
          style: { ...activeCtl.props.style, '--flip-half': `${flipMs / 2}ms` } as CSSProperties,
        };

  const preheating = phase === 'preheat';

  return (
    <span
      className={cls(
        'award-cell-fx',
        shaking && 'award-cell-gacha',
        // Step 1 blinks in place; the zoom only arrives with step 2.
        preheating && 'award-cell-preheat',
        finale && !preheating && 'award-cell-finale',
      )}
      data-testid={testId}
      ref={finale ? finaleCellRef : undefined}
    >
      <ProblemCell
        problem={problem}
        cell={cellToRender}
        showFirstSolve={showFirstSolve}
        flip={flipProps}
      />
      {/* Sparkles: the finale's step-1 pre-heat, and the plain gacha shake. */}
      {preheating || (shaking && !finale) ? <SparkleOverlay /> : null}
      {/* The rainbow is the finale VARIANT of the gacha effect (spec §7):
          it flows from step 2 until the shake stops after the verdict flip
          ("진동이 멈출 때까지"), overlaid on the spotlight. */}
      {shaking && finale ? <RainbowOverlay /> : null}
    </span>
  );
}
