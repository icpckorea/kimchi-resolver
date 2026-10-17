/**
 * App store (zustand) — the bridge between the framework-free core and React
 * (spec §5, §6, §13).
 *
 * Responsibilities:
 * - boot(): config.json → parseConfig → URL overrides → orgs.json → mode
 *   selection → FeedSource construction → contest load → asset check →
 *   initial fetch/ingest → replay (r= / time=) → (award mode) awards.json →
 *   award machine construction.
 * - Spectator loop: poll timer (autoRefreshInterval), autoplay tick
 *   (autoPlayDelay, one run per tick), manual pollNow() with timer reset,
 *   WebSocket poll-nudge ("doorbell", no reconnect).
 * - Publish mode: everything applied at boot, no timers. Prepare-page
 *   inputs (preliminary + regional, publish-modes spec §4/§5/§6) are seeded
 *   from config/URL, then from this browser's localStorage under a key per
 *   mode and contest; edits are saved back under the same key.
 * - Derived state: memoized Snapshot (recomputed only when applied runs
 *   change), pendingCount, contestTimeSec, noMoreUpdate, system messages,
 *   recent judge events (dashboard, capped at maxNotifications) plus a
 *   teamUpdated-style listener stream for desktop notifications.
 *
 * Headless-testable: fetch, timers (scheduler), RNG and the WebSocket
 * factory are all injectable via {@link createAppStore}.
 */

import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';

import type {
  AppMode,
  AwardMachine,
  AwardStepResult,
  Contest,
  OrgsIndex,
  Rng,
  Run,
  RunFeeder,
  FeedSource,
  Snapshot,
} from '@core/types';
import {
  applyUrlOverrides,
  parseConfig,
  selectMode,
  defaultConfig,
  type AppConfig,
  type ResolvedConfig,
} from '@core/config';
import { createRunFeeder } from '@core/feeder';
import { computeStandings, withoutLastSolve } from '@core/standings';
import { createAwardMachine } from '@core/award';
import { parseAwardsJson, type AwardEntry } from '@core/awards';
import { createSpotboardSource } from '@core/ingest/spotboard';
import { createContestApiSource } from '@core/ingest/contest-api';
import type { RegionalSimInputs } from '@core/publishState';
import {
  clearPublishInputs,
  loadPublishInputs,
  parseStoredPrelimInputs,
  parseStoredRegionalInputs,
  publishStorageKey,
  savePublishInputs,
  type PrelimInputs,
  type StorageLike,
} from '@ui/publish/persist';

export type { PrelimInputs } from '@ui/publish/persist';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SystemMessageLevel = 'info' | 'warning' | 'error';

export interface SystemMessage {
  id: number;
  level: SystemMessageLevel;
  text: string;
  /** Times this identical message recurred; absent or 1 means "once". */
  repeats?: number;
}

/**
 * Hard cap on the message list. An unattended contest can generate hundreds of
 * distinct failures; the oldest are dropped rather than growing without bound.
 */
const MAX_SYSTEM_MESSAGES = 20;

/** One applied (displayed) run — the dashboard feed unit. Newest first. */
export interface JudgeEvent {
  /** Monotonic id; stable React key even when a run id is re-fed. */
  eventId: number;
  run: Run;
}

export type TeamUpdatedListener = (event: JudgeEvent) => void;

/**
 * The batch of cells whose runs were just applied LIVE (autoplay tick,
 * feed-one, feed-all) — drives the spectator cell-flip animation (spec §5:
 * queued runs are applied "애니메이션과 함께"). Replay/boot application never
 * sets this. flipId is monotonic so consumers can detect a new batch.
 */
export interface LiveFlipBatch {
  cells: { teamId: string; problemId: string }[];
  flipId: number;
}

/** Injectable timer pair; defaults to the global setInterval/clearInterval. */
export interface Scheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Minimal WebSocket surface the store needs (doorbell only). */
export interface WebSocketLike {
  onmessage: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface StoreDeps {
  fetchImpl?: typeof fetch;
  scheduler?: Scheduler;
  rng?: Rng;
  createWebSocket?: WebSocketFactory;
  /**
   * Storage for the prepare-page inputs. Omitted → the browser's
   * localStorage; null → nothing is persisted.
   */
  storage?: StorageLike | null;
}

export type BootStatus = 'idle' | 'booting' | 'ready' | 'error';

export interface AppState {
  status: BootStatus;
  mode: AppMode;
  config: ResolvedConfig;
  orgs: OrgsIndex;
  contest: Contest | null;
  /** Memoized standings; award mode mirrors awardMachine.snapshot. */
  snapshot: Snapshot | null;
  systemMessages: SystemMessage[];
  /** Feeder queue length (update-button badge). */
  pendingCount: number;
  /** Applied-run count (mostly for tests/diagnostics). */
  appliedRunCount: number;
  contestTimeSec: number | null;
  noMoreUpdate: boolean;
  /** Autoplay on/off (spectator). */
  playing: boolean;
  awardMachine: AwardMachine | null;
  /**
   * awards.json entries by team id (spec §6). Loaded during boot in AWARD
   * mode only — the machine needs the entry ids before its first keypress to
   * decide which finalize raises a slide, so the fetch cannot live in the
   * view. Empty map when the file is missing/unreadable; the other modes read
   * their own copy in App (labels only, no ceremony coupling).
   */
  awards: ReadonlyMap<string, AwardEntry>;
  /** Bumped after every advance/dismiss so React re-renders machine reads. */
  awardTick: number;
  /** Recent applied runs, newest first, capped at config.maxNotifications. */
  recentEvents: JudgeEvent[];
  /** Most recent live-applied batch (spectator cell flip); null before any. */
  lastAppliedFlips: LiveFlipBatch | null;
  /**
   * Preliminary prepare-page inputs (publish-modes spec §5.2). Seeded from
   * `config.publish.preliminary`, then from localStorage in preliminary mode.
   */
  prelimInputs: PrelimInputs;
  /**
   * Regional simulation inputs (publish-modes spec §6.4). Seeded from
   * `config.publish.regional`, `alreadyInvited` and the `invitedScoreCutoff`
   * (URL `invited_cutoff` included), then from localStorage in regional mode.
   */
  regionalInputs: RegionalSimInputs;
  /**
   * True when the inputs of the current publish mode come from this
   * browser's storage (loaded at boot, or saved by an edit): the prepare page
   * shows "저장된 값을 사용 중" with a reset button.
   */
  publishInputsFromStorage: boolean;

  // -- actions --------------------------------------------------------------
  /** Full boot sequence. `search` is window.location.search (injected for tests). */
  boot(search: string): Promise<void>;
  /** Manual/doorbell poll: fetchRuns+ingest now and reset the poll timer. */
  pollNow(): Promise<void>;
  /** Apply exactly one queued run (feed-one button). */
  feedOne(): void;
  /** Apply everything queued (feed-all button). */
  feedAllQueued(): void;
  setPlaying(playing: boolean): void;
  togglePlaying(): void;
  /** Award keypress. Returns null outside award mode. */
  awardAdvance(): AwardStepResult | null;
  awardDismiss(): void;
  /**
   * Commit the (possibly post-reveal) machine snapshot into the store.
   * awardAdvance defers the commit for 'reveal' steps so standings, ranks
   * and row positions do not spoil the verdict before the flip shows it;
   * the award UI calls this when the reveal animation completes.
   */
  awardCommitSnapshot(): void;
  addSystemMessage(level: SystemMessageLevel, text: string): void;
  dismissSystemMessage(id: number): void;
  /** Merge a patch into prelimInputs; saved in preliminary publish mode. */
  setPrelimInputs(patch: Partial<PrelimInputs>): void;
  /** Merge a patch into regionalInputs; saved in regional publish mode. */
  setRegionalInputs(patch: Partial<RegionalSimInputs>): void;
  /** Back to the config/URL values; removes the stored inputs of this mode. */
  resetPublishInputs(): void;
  /** Desktop-notification stream; returns the unsubscribe function. */
  subscribeTeamUpdated(listener: TeamUpdatedListener): () => void;
  /** Stop timers, close the WebSocket. Safe to call repeatedly. */
  dispose(): void;
}

export type AppStore = StoreApi<AppState>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const defaultScheduler: Scheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
};

const defaultWebSocketFactory: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

function initialResolvedConfig(): ResolvedConfig {
  return {
    ...defaultConfig(),
    replayRunId: null,
    replayTimeMinutes: null,
    searchQuery: null,
    followTeamId: null,
  };
}

/** Prepare-page preliminary inputs as config.json (and the URL) define them. */
function prelimInputsFromConfig(config: AppConfig): PrelimInputs {
  const prelim = config.publish.preliminary;
  return {
    totalTeams: prelim.totalTeams,
    topN: prelim.topN,
    k: prelim.k,
    ineligibleTeamIds: [...prelim.ineligibleTeamIds],
  };
}

/** Prepare-page regional inputs as config.json (and the URL) define them. */
function regionalInputsFromConfig(config: AppConfig): RegionalSimInputs {
  const { regional, alreadyInvited, invitedScoreCutoff } = config.publish;
  return {
    prelimSchools: regional.prelimSchools,
    prelimTeams: regional.prelimTeams,
    coefficients: { ...regional.coefficients },
    regionalOverride: { schools: null, teams: null, foreign: null },
    wfMedalGroups: [...regional.wfMedalGroups],
    winnerGroups: [...alreadyInvited.winnerGroups],
    invitedGroups: [...alreadyInvited.invitedGroups],
    invitedTeamIds: [...alreadyInvited.teamIds],
    cutoff: invitedScoreCutoff,
  };
}

function copyPrelimInputs(value: PrelimInputs): PrelimInputs {
  return { ...value, ineligibleTeamIds: [...value.ineligibleTeamIds] };
}

function copyRegionalInputs(value: RegionalSimInputs): RegionalSimInputs {
  return {
    ...value,
    coefficients: { ...value.coefficients },
    regionalOverride: { ...value.regionalOverride },
    wfMedalGroups: [...value.wfMedalGroups],
    winnerGroups: [...value.winnerGroups],
    invitedGroups: [...value.invitedGroups],
    invitedTeamIds: [...value.invitedTeamIds],
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createAppStore(deps: StoreDeps = {}): AppStore {
  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((...args) => fetch(...args));
  const scheduler = deps.scheduler ?? defaultScheduler;
  const rng: Rng = deps.rng ?? Math.random;
  const wsFactory = deps.createWebSocket ?? defaultWebSocketFactory;
  const storage = deps.storage;

  // Non-reactive internals (never rendered directly).
  let source: FeedSource | null = null;
  let feeder: RunFeeder | null = null;
  let pollTimer: unknown = null;
  let autoplayTimer: unknown = null;
  let ws: WebSocketLike | null = null;
  let wsErrorReported = false;
  let pollErrorReported = false;
  let pollPromise: Promise<void> | null = null;
  let nextMessageId = 1;
  let nextEventId = 1;
  let nextFlipId = 1;
  /**
   * localStorage key of the current publish mode's inputs; null outside
   * publish mode, in mode 'off', and before the contest title is known.
   */
  let publishKey: string | null = null;
  const teamUpdatedListeners = new Set<TeamUpdatedListener>();

  return createStore<AppState>()((set, get) => {
    // -- system messages ------------------------------------------------------
    /**
     * Append a system message, collapsing repeats and capping the list.
     *
     * A 5-hour unattended run on flapping venue wifi alternates success and
     * failure, which defeats any consecutive-failure guard: measured at ~900
     * identical "Fetching runs failed" toasts over one contest, stacked over
     * the board and never released. Identical text bumps a repeat counter
     * instead of adding a row, and the list is hard-capped.
     */
    function addMessage(level: SystemMessageLevel, text: string): void {
      set((state) => {
        const existing = state.systemMessages.find(
          (m) => m.level === level && m.text === text,
        );
        if (existing !== undefined) {
          return {
            systemMessages: state.systemMessages.map((m) =>
              m === existing ? { ...m, repeats: (m.repeats ?? 1) + 1 } : m,
            ),
          };
        }
        const message: SystemMessage = { id: nextMessageId++, level, text };
        const next = [...state.systemMessages, message];
        return {
          systemMessages:
            next.length > MAX_SYSTEM_MESSAGES ? next.slice(-MAX_SYSTEM_MESSAGES) : next,
        };
      });
    }

    // -- feeder-derived state -------------------------------------------------
    /** Mirrors cheap feeder metadata (no standings recompute). */
    function syncFeederMeta(): void {
      if (feeder === null) return;
      set({
        pendingCount: feeder.queueLength,
        appliedRunCount: feeder.appliedRuns.length,
        contestTimeSec: feeder.contestTimeSec,
        noMoreUpdate: feeder.noMoreUpdate,
      });
      if (feeder.noMoreUpdate) stopLiveFeeds();
    }

    /** Recompute the snapshot — call ONLY after the applied-run set changed. */
    function recomputeSnapshot(): void {
      const contest = get().contest;
      if (contest === null || feeder === null) return;
      const snapshot = computeStandings(contest, feeder.appliedRuns);
      // Live board: "last solve" is only "latest so far" and moves with every
      // solve, so it is not shown. Publish (final results) keeps it.
      set({ snapshot: get().mode === 'spectator' ? withoutLastSolve(snapshot) : snapshot });
    }

    /** Record applied runs for the dashboard and notify listeners. */
    function recordApplied(runs: Run[], emit: boolean): void {
      if (runs.length === 0) return;
      const cap = get().config.maxNotifications;
      const events = runs.map((run): JudgeEvent => ({ eventId: nextEventId++, run }));
      set((state) => ({
        // Newest first.
        recentEvents: [...events].reverse().concat(state.recentEvents).slice(0, cap),
      }));
      if (emit && get().mode !== 'award') {
        for (const event of events) {
          for (const listener of teamUpdatedListeners) listener(event);
        }
      }
    }

    function applyRuns(runs: Run[], emit: boolean): void {
      if (runs.length > 0) {
        recordApplied(runs, emit);
        // Live application (emit) flips the affected cells (spec §5/§7);
        // replay/boot application swaps them in without animation.
        if (emit) {
          set({
            lastAppliedFlips: {
              cells: runs.map((run) => ({ teamId: run.teamId, problemId: run.problemId })),
              flipId: nextFlipId++,
            },
          });
        }
        recomputeSnapshot();
      }
      syncFeederMeta();
    }

    // -- timers ---------------------------------------------------------------
    function stopPollTimer(): void {
      if (pollTimer !== null) {
        scheduler.clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function startPollTimer(): void {
      stopPollTimer();
      if (get().noMoreUpdate) return;
      pollTimer = scheduler.setInterval(() => {
        void pollOnce();
      }, get().config.autoRefreshInterval);
    }

    function stopAutoplayTimer(): void {
      if (autoplayTimer !== null) {
        scheduler.clearInterval(autoplayTimer);
        autoplayTimer = null;
      }
    }

    function closeWs(): void {
      if (ws !== null) {
        const socket = ws;
        ws = null;
        try {
          socket.close();
        } catch {
          // A socket that failed to open may throw on close; nothing to do.
        }
      }
    }

    /** The feed is over (noMoreUpdate): polling and the doorbell are pointless. */
    function stopLiveFeeds(): void {
      stopPollTimer();
      closeWs();
    }

    // -- polling --------------------------------------------------------------
    /** One poll at a time; concurrent callers join the in-flight promise. */
    function pollOnce(): Promise<void> {
      if (pollPromise !== null) return pollPromise;
      if (source === null || feeder === null) return Promise.resolve();
      const activeSource = source;
      const activeFeeder = feeder;
      pollPromise = (async () => {
        try {
          const result = await activeSource.fetchRuns(activeFeeder.cursor);
          activeFeeder.ingest(result);
          pollErrorReported = false;
          syncFeederMeta();
        } catch (err) {
          // One message per failure streak, not one per failed poll.
          if (!pollErrorReported) {
            pollErrorReported = true;
            addMessage('warning', `Fetching runs failed: ${errorText(err)}`);
          }
        } finally {
          pollPromise = null;
        }
      })();
      return pollPromise;
    }

    // -- WebSocket doorbell ---------------------------------------------------
    function reportWsError(): void {
      if (wsErrorReported) return;
      wsErrorReported = true;
      addMessage(
        'warning',
        'WebSocket connection failed — falling back to polling only (no reconnect).',
      );
    }

    function connectWs(url: string): void {
      let socket: WebSocketLike;
      try {
        socket = wsFactory(url);
      } catch {
        reportWsError();
        return;
      }
      socket.onmessage = () => {
        void get().pollNow();
      };
      socket.onerror = () => reportWsError();
      socket.onclose = null;
      ws = socket;
    }

    // -- boot helpers ---------------------------------------------------------
    async function fetchJson(url: string): Promise<unknown> {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res.json();
    }

    async function loadConfigJson(): Promise<AppConfig> {
      let raw: unknown;
      try {
        raw = await fetchJson('./config.json');
      } catch (err) {
        addMessage(
          'info',
          `config.json could not be loaded (${errorText(err)}); using default configuration.`,
        );
        return defaultConfig();
      }
      const { config, errors } = parseConfig(raw);
      for (const error of errors) addMessage('warning', error);
      return config;
    }

    async function loadOrgsJson(): Promise<OrgsIndex> {
      try {
        const raw = await fetchJson('./orgs/orgs.json');
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          return raw as OrgsIndex;
        }
        addMessage('warning', 'orgs/orgs.json: expected an object; school metadata disabled.');
        return {};
      } catch (err) {
        addMessage(
          'warning',
          `orgs/orgs.json could not be loaded (${errorText(err)}); school metadata disabled.`,
        );
        return {};
      }
    }

    /**
     * awards.json for AWARD mode (spec §6). Awaited during boot because the
     * state machine takes the entry ids at construction: it raises a slide
     * only for a team that has one. A missing file downgrades to a slide-less
     * ceremony with a warning — never to invisible slides. An empty URL means
     * "no awards.json": nothing is fetched and there is no warning.
     */
    async function loadAwardsJson(url: string): Promise<Map<string, AwardEntry>> {
      if (url.trim() === '') return new Map<string, AwardEntry>();
      try {
        return parseAwardsJson(await fetchJson(url));
      } catch (err) {
        addMessage(
          'warning',
          `awards.json could not be loaded (${errorText(err)}); award slides and medals will be skipped.`,
        );
        return new Map<string, AwardEntry>();
      }
    }

    /** Spec §8: warn about groups missing from orgs.json / missing logos. */
    function checkAssets(contest: Contest, orgs: OrgsIndex, config: ResolvedConfig): void {
      const missingOrg: string[] = [];
      const missingLogo: string[] = [];
      const seen = new Set<string>();
      for (const team of contest.teams.values()) {
        if (seen.has(team.group)) continue;
        seen.add(team.group);
        const org = orgs[team.group] as OrgsIndex[string] | undefined;
        if (org === undefined) missingOrg.push(team.group);
        else if (config.showSchoolLogos && !org.logo) missingLogo.push(team.group);
      }
      if (missingOrg.length > 0) {
        addMessage('warning', `orgs.json has no entry for: ${missingOrg.join(', ')}`);
        console.warn('[kimchi-resolver] groups missing from orgs.json:', missingOrg);
      }
      if (missingLogo.length > 0) {
        addMessage('warning', `School logo missing for: ${missingLogo.join(', ')}`);
        console.warn('[kimchi-resolver] groups without a logo file:', missingLogo);
      }
    }

    /**
     * config.json is a static asset: every visitor can read it. Credentials in
     * `source.auth` are therefore public, and with a DOMjudge api_reader
     * account that is enough to query unfrozen judgements straight from the
     * judge during the freeze (DOMjudge filters judgements by role, not by
     * freeze). Say so loudly rather than letting it pass silently.
     */
    function warnAboutClientSideCredentials(config: ResolvedConfig): void {
      if (config.source.auth === null) return;
      addMessage(
        'error',
        'Credentials are set in config.json, which every visitor of this page can read. ' +
          'Anyone can then query the judge directly — including unfrozen verdicts during the ' +
          'freeze. Put the credentials behind a reverse proxy or an exporter instead.',
      );
      const protocol = globalThis.location?.protocol;
      if (protocol !== undefined && protocol !== 'https:' && protocol !== 'file:') {
        addMessage(
          'error',
          `Credentials are also sent in cleartext: this page is served over ${protocol}, ` +
            'and every poll carries an Authorization header. Use HTTPS.',
        );
      }
    }

    function createSource(config: ResolvedConfig, orgs: OrgsIndex): FeedSource {
      const common = {
        fetchTimeout: config.fetchTimeout,
        excludeTeamIds: config.excludeTeams,
        foreign: config.foreign,
        orgs,
        fetchImpl,
      };
      if (config.source.type === 'contest-api') {
        return createContestApiSource({
          baseUrl: config.source.baseUrl,
          contestId: config.source.contestId,
          auth: config.source.auth,
          // Adapter diagnoses (unknown judgement type, unmapped country code,
          // org-less teams) must reach the operator, not just the console.
          onWarning: (text) => addMessage('warning', text),
          ...common,
        });
      }
      return createSpotboardSource({ apiBase: config.source.apiBase, ...common });
    }

    // -- publish inputs -------------------------------------------------------
    /**
     * Publish mode (not 'off'): the stored inputs of this mode and contest win
     * over the config seed. A stored value of the wrong shape is dropped.
     */
    function loadStoredPublishInputs(config: ResolvedConfig, contest: Contest): void {
      const publishMode = config.publish.mode;
      if (publishMode === 'off') return;
      publishKey = publishStorageKey(config, contest.title, publishMode);
      const raw = loadPublishInputs<unknown>(publishKey, storage);
      if (raw === null) return;
      if (publishMode === 'preliminary') {
        const stored = parseStoredPrelimInputs(raw);
        if (stored !== null) {
          set({ prelimInputs: stored, publishInputsFromStorage: true });
          return;
        }
      } else {
        const stored = parseStoredRegionalInputs(raw);
        if (stored !== null) {
          set({ regionalInputs: stored, publishInputsFromStorage: true });
          return;
        }
      }
      addMessage(
        'warning',
        'Saved publish inputs in this browser have an unexpected shape; using config values.',
      );
    }

    /** Save the current mode's inputs (publish mode only). */
    function saveCurrentPublishInputs(): void {
      if (publishKey === null) return;
      const state = get();
      const value =
        state.config.publish.mode === 'preliminary' ? state.prelimInputs : state.regionalInputs;
      savePublishInputs(publishKey, value, storage);
      set({ publishInputsFromStorage: true });
    }

    // -- the store ------------------------------------------------------------
    return {
      status: 'idle',
      mode: 'spectator',
      config: initialResolvedConfig(),
      orgs: {},
      contest: null,
      snapshot: null,
      systemMessages: [],
      pendingCount: 0,
      appliedRunCount: 0,
      contestTimeSec: null,
      noMoreUpdate: false,
      playing: false,
      awardMachine: null,
      awards: new Map<string, AwardEntry>(),
      awardTick: 0,
      recentEvents: [],
      lastAppliedFlips: null,
      prelimInputs: prelimInputsFromConfig(defaultConfig()),
      regionalInputs: regionalInputsFromConfig(defaultConfig()),
      publishInputsFromStorage: false,

      async boot(search: string): Promise<void> {
        if (get().status !== 'idle') return;
        set({ status: 'booting' });

        // 1. config.json → parse → URL overrides.
        const baseConfig = await loadConfigJson();
        const { config, warnings } = applyUrlOverrides(baseConfig, search);
        for (const warning of warnings) addMessage('warning', warning);

        // 2. orgs.json.
        const orgs = await loadOrgsJson();

        // 3. Mode + feed source.
        const mode = selectMode(config);
        warnAboutClientSideCredentials(config);
        source = createSource(config, orgs);
        set({
          config,
          orgs,
          mode,
          prelimInputs: prelimInputsFromConfig(config),
          regionalInputs: regionalInputsFromConfig(config),
          publishInputsFromStorage: false,
        });

        // 4. Contest (fatal on failure).
        let contest: Contest;
        try {
          contest = await source.loadContest();
        } catch (err) {
          addMessage('error', `Loading the contest failed: ${errorText(err)}`);
          set({ status: 'error' });
          return;
        }
        set({ contest });
        checkAssets(contest, orgs, config);
        // The storage key needs the contest title, so stored inputs load here.
        if (mode === 'publish') loadStoredPublishInputs(config, contest);

        // 5. Initial fetch + ingest (non-fatal; spectator retries by polling).
        feeder = createRunFeeder(contest);
        try {
          feeder.ingest(await source.fetchRuns(feeder.cursor));
        } catch (err) {
          addMessage('warning', `Initial run fetch failed: ${errorText(err)}`);
        }

        // 6. Replay up to r= / time=, then mode-specific consumption.
        const { replayRunId, replayTimeMinutes } = config;
        const bounded = replayRunId !== null || replayTimeMinutes !== null;
        const withinReplayBound = (run: Run): boolean =>
          (replayRunId === null || run.seq <= replayRunId) &&
          (replayTimeMinutes === null || run.minute <= replayTimeMinutes);

        if (mode === 'award') {
          // Revealed = applied up to the cutoff; hidden = the rest with their
          // REAL verdicts (the machine masks them itself).
          if (bounded) feeder.feedWhile(withinReplayBound);
          else feeder.feedAll();
          const revealedRuns = feeder.appliedRuns.slice();
          const hiddenRuns = feeder.feedAll();
          const award = config.award;
          // Awaited BEFORE the machine exists: the entry ids decide which
          // finalize raises a slide (spec §6), and that must hold from the
          // very first keypress — including the rankBegin fast-forward that
          // runs inside the constructor.
          const awards = await loadAwardsJson(award.awardsUrl);
          const machine = createAwardMachine({
            contest,
            revealedRuns,
            hiddenRuns,
            awardedTeamIds: new Set(awards.keys()),
            config: {
              hideName: award.hideName,
              rankBegin: award.rankBegin,
              revealOrder: award.revealOrder,
              focusBlinking: award.focusBlinking,
              gachaEffectRequirement: award.gachaEffectRequirement,
              gachaEffectForNoRatio: award.gachaEffectForNoRatio,
            },
            rng,
            computeStandings,
          });
          set({ awardMachine: machine, awards, awardTick: 0, snapshot: machine.snapshot });
          // 빈 시상식 경고 (spec §6): a cutoff at or after the last submission
          // masks nothing, so the whole ceremony would be focus/finalize
          // keypresses with no reveal. Warn at boot — the operator still has
          // time to fix r= / time=.
          if (machine.remainingReveals === 0) {
            addMessage(
              'warning',
              'The award ceremony has nothing to reveal: no submission falls after the freeze cutoff. Check the r= / time= replay cutoff before starting.',
            );
          }
          syncFeederMeta();
        } else {
          const replayed = bounded ? feeder.feedWhile(withinReplayBound) : feeder.feedAll();
          applyRuns(replayed, false);
          if (get().snapshot === null) recomputeSnapshot(); // empty feed still renders
        }

        // 7. Spectator live loop (polling + autoplay + doorbell).
        if (mode === 'spectator') {
          set({ playing: config.autoPlay });
          startPollTimer();
          stopAutoplayTimer();
          autoplayTimer = scheduler.setInterval(() => {
            if (!get().playing || feeder === null) return;
            applyRuns(feeder.feed(1), true);
          }, config.autoPlayDelay);
          if (config.source.eventsWs !== null && !get().noMoreUpdate) {
            connectWs(config.source.eventsWs);
          }
        }

        set({ status: 'ready' });
      },

      async pollNow(): Promise<void> {
        if (get().mode !== 'spectator' || get().status !== 'ready') return;
        // Manual refresh resets the timer (spec §5) — the doorbell shares this.
        if (pollTimer !== null) startPollTimer();
        await pollOnce();
      },

      feedOne(): void {
        if (feeder === null || get().mode === 'award') return;
        applyRuns(feeder.feed(1), true);
      },

      feedAllQueued(): void {
        if (feeder === null || get().mode === 'award') return;
        applyRuns(feeder.feedAll(), true);
      },

      setPlaying(playing: boolean): void {
        set({ playing });
      },

      togglePlaying(): void {
        set((state) => ({ playing: !state.playing }));
      },

      awardAdvance(): AwardStepResult | null {
        const machine = get().awardMachine;
        if (machine === null) return null;
        const result = machine.advance();
        // A 'reveal' changes the standings — keep the PRE-reveal snapshot on
        // screen until the flip animation shows the verdict (spoiler
        // prevention); the award UI commits via awardCommitSnapshot() when
        // the sequence ends. Other steps do not change standings and commit
        // immediately (this also backstops a lost commit).
        if (result.type === 'reveal') {
          set((state) => ({ awardTick: state.awardTick + 1 }));
        } else {
          set((state) => ({ awardTick: state.awardTick + 1, snapshot: machine.snapshot }));
        }
        return result;
      },

      awardDismiss(): void {
        const machine = get().awardMachine;
        if (machine === null) return;
        machine.dismissSlide();
        // Dismissing a slide never changes standings — do NOT pull in a
        // possibly still-animating reveal's snapshot here.
        set((state) => ({ awardTick: state.awardTick + 1 }));
      },

      awardCommitSnapshot(): void {
        const machine = get().awardMachine;
        if (machine === null) return;
        set((state) => ({ awardTick: state.awardTick + 1, snapshot: machine.snapshot }));
      },

      addSystemMessage(level: SystemMessageLevel, text: string): void {
        addMessage(level, text);
      },

      dismissSystemMessage(id: number): void {
        set((state) => ({
          systemMessages: state.systemMessages.filter((message) => message.id !== id),
        }));
      },

      setPrelimInputs(patch: Partial<PrelimInputs>): void {
        set((state) => ({
          prelimInputs: copyPrelimInputs({ ...state.prelimInputs, ...patch }),
        }));
        if (get().config.publish.mode === 'preliminary') saveCurrentPublishInputs();
      },

      setRegionalInputs(patch: Partial<RegionalSimInputs>): void {
        set((state) => ({
          regionalInputs: copyRegionalInputs({ ...state.regionalInputs, ...patch }),
        }));
        if (get().config.publish.mode === 'regional') saveCurrentPublishInputs();
      },

      resetPublishInputs(): void {
        const config = get().config;
        if (publishKey !== null) clearPublishInputs(publishKey, storage);
        set({
          prelimInputs: prelimInputsFromConfig(config),
          regionalInputs: regionalInputsFromConfig(config),
          publishInputsFromStorage: false,
        });
      },

      subscribeTeamUpdated(listener: TeamUpdatedListener): () => void {
        teamUpdatedListeners.add(listener);
        return () => {
          teamUpdatedListeners.delete(listener);
        };
      },

      dispose(): void {
        stopPollTimer();
        stopAutoplayTimer();
        closeWs();
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Singleton for the React app
// ---------------------------------------------------------------------------

export const appStore: AppStore = createAppStore();

/** React hook over the singleton store. */
export function useAppStore<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}
