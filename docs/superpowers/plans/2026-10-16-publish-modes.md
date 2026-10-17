# Publish Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split publish into three modes (`off`, `preliminary`, `regional`): an interactive prepare page in the operator build, and `npm run publish` that turns a downloaded `publish-state.json` into a static, credential-free `publish-dist/` folder.

**Architecture:** Pure core functions do the selection (`core/preliminary.ts`) and the APAC 2026-27 simulation (`core/apac.ts`). A versioned zod schema (`core/publishState.ts`) is the contract between the prepare page (writes it), the build script (validates and embeds it), and the static page (reads it). The static page is a second Vite entry (`publish.html` → `src/published/`) that never imports the app store, so feed/ingest code and `config.json` stay out of the public bundle.

**Tech Stack:** TypeScript, React 18, zod, zustand (prepare page only), Vite 6 (second config), vite-node (already installed via vitest) for the script, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-16-publish-modes-design.md` (parent: `docs/superpowers/specs/2026-07-30-kimchi-resolver-design.md` §13).

## Global Constraints

- `publish.mode` default is `"off"`. Values: `"off" | "preliminary" | "regional"`. URL `publish_mode=` overrides config.
- `publish.enabled` / `?publish=true` still enters the prepare page. Mode only selects features.
- Preliminary defaults: `topN` 30, `totalTeams` null, `k` null, `ineligibleTeamIds` [].
- Site score coefficients default: universities in regional 0.56, teams in regional 0.24, universities in preliminaries 0.14, teams in preliminaries 0.06, foreign teams in regional 0.30.
- School quota Q: 3 for a previous-year WF medal school, 2 for every other school.
- Super-region countries removed from the scored list: `AU`, `NZ` (alpha-2; they still count in S).
- Remove `publish.siteScore` and URL `site_score`. Keep `invited_cutoff`.
- Public output never contains `config.json`, `awards.json`, `sample/`, a credential, or the judge URL.
- Yellow row = selected for the regional (preliminary). Ineligible row = `opacity: 0.5`, no "미자격" text on the public page.
- Value shown with 4 decimals. Public regional page banner (exact copy): "이 페이지는 시뮬레이션입니다. 공식 결과가 아닙니다. 최종 초청은 모든 리저널이 끝난 다음 APAC에서 정합니다."
- UI copy is Korean; code comments English, matching the existing files.

## Review Focus

1. A `publish-state.json` from an older schema, a hand-edited one, or one from another mode — the script must refuse with the zod path in the message, not build a broken page. (Task 3, Task 8.)
2. A team whose name contains `</script>` — the embedded JSON must not break out of its `<script>` tag. (Task 8.)
3. Preliminary inputs where `topN ≥ totalTeams`, or where fewer eligible teams exist than `totalTeams` — no crash, overflow warning, every eligible team selected. (Task 1.)
4. Stale `localStorage` from another contest or the other mode leaking into the saved result. (Task 4.)
5. Regional S = 0 (all inputs empty, no solving teams) — no division by zero, no `Infinity` shown. (Task 2.)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/preliminary.ts` (new) | Preliminary selection algorithm (spec §5.1). |
| `src/core/apac.ts` (modify) | Per-school quota, super-region removal, site score formula, regional simulation. |
| `src/core/publishState.ts` (new) | `publish-state.json` zod schema, build from snapshot, parse, rebuild a `Snapshot`. |
| `src/core/config.ts` (modify) | `publish.mode`, `publish.preliminary`, `publish.regional`, split `alreadyInvited`. |
| `src/store/appStore.ts` (modify) | Prepare-page inputs (prelim + regional), drop `siteScore`. |
| `src/ui/publish/persist.ts` (new) | localStorage load/save of prepare inputs. |
| `src/ui/scoreboard/Scoreboard.tsx`, `TeamRow.tsx` (modify) | Store-free `ScoreboardView`; per-row decoration. |
| `src/ui/publish/PublishView.tsx`, `PublishControls.tsx` (modify), `PrelimControls.tsx`, `RegionalSimPanel.tsx`, `SaveStateButton.tsx` (new) | Prepare page per mode. |
| `publish.html`, `src/published/main.tsx`, `src/published/PublishedApp.tsx` (new) | Static public page. |
| `vite.publish.config.ts`, `scripts/publish.ts` (new) | `npm run publish`. |

---

### Task 1: Preliminary selection core

**Files:**
- Create: `src/core/preliminary.ts`
- Test: `test/core/preliminary.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PrelimStage = 'top' | 'school' | 'fill';
  export interface PrelimOptions {
    totalTeams: number;          // T ≥ 1
    topN: number;                // N ≥ 0
    k: number;                   // K ≥ 0
    ineligibleTeamIds: ReadonlySet<string>;
  }
  export interface PrelimResult {
    selected: Map<string, PrelimStage>;   // insertion order = selection order
    counts: { top: number; school: number; fill: number };
    overflow: boolean;                    // top + school > totalTeams
    /** Human-readable Korean warnings: boundary ties, overflow. */
    warnings: string[];
  }
  export function selectPreliminary(snapshot: Snapshot, opts: PrelimOptions): PrelimResult;
  ```

Algorithm (not determined by the signature):

```
eligible = standings (ICPC order) minus ineligible
step 2: first min(topN, eligible.length) of eligible → 'top'
covered = schools of 'top' teams ('' never counts as a school: an org-less team is its own school, key by team id)
step 3: for each school not in covered, in standings order, its FIRST eligible team;
        if team.solved ≥ k → 'school'   (do not look at the school's next team)
step 4: if selected.size < totalTeams: walk eligible, add unselected as 'fill' until size == totalTeams
overflow = top + school > totalTeams  → warning "선발 팀 수가 진출 팀 수를 넘습니다 (X팀)"
tie warning: at the step-2 boundary and at the step-4 boundary, when the last taken team and the
next eligible not-taken team share icpcRank → warning naming both team names
```

- [ ] **Step 1: Write the failing tests** — build snapshots with `computeStandings` like `test/ui/publish.test.ts` fixtures. Tests:
  - `selects the top N regardless of school` — N=3, 3 teams of school A on top → all 3 `'top'`.
  - `school step skips schools already in the top N (해석 1)` — A1,A2 in top N, A3 not → A3 not `'school'`.
  - `school step takes only the school's best team and drops the school below K` — school B best team solved K−1, B's second team solved... (lower, so also < K) → B absent; school C best solved = K → `'school'`.
  - `ineligible teams are skipped in every step` — ineligible rank-1 team never selected, rank N+1 enters top.
  - `fill tops up to totalTeams in standings order` → `counts.fill === T − top − school`.
  - `overflow keeps every school pick, adds no fill, warns` → `overflow === true`, `counts.fill === 0`, a warning contains `'넘습니다'`.
  - `fewer eligible teams than totalTeams selects all of them without error`.
  - `topN ≥ totalTeams` → overflow true when `topN > totalTeams`.
  - `org-less teams are separate schools in the school step`.
  - `warns on a tie at the top-N boundary` — teams N and N+1 share icpcRank → one warning.
- [ ] **Step 2: Run** `npx vitest run test/core/preliminary.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `selectPreliminary` in `src/core/preliminary.ts`.** Framework-free; header comment quotes spec §5.1 and names interpretation 1.
- [ ] **Step 4: Run** the test file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): preliminary advancement selection`.

---

### Task 2: APAC 2026-27 core (quota, super-region, site score, simulation)

**Files:**
- Modify: `src/core/apac.ts`
- Modify: `test/core/apac.test.ts`, `test/core/apac-published.test.ts`
- Test: `test/core/apac-2026.test.ts` (new)

**Interfaces:**
- Produces (additions to `apac.ts`):
  ```ts
  export const WF_MEDAL_QUOTA = 3;
  export const DEFAULT_SCHOOL_QUOTA = 2;
  export const SUPER_REGION_COUNTRIES: readonly string[] = ['AU', 'NZ'];
  export interface SchoolQuota { base: number; wfMedalGroups: readonly string[] } // medal → WF_MEDAL_QUOTA
  // ApacFilterOptions gains: quota?: SchoolQuota  (default { base: 2, wfMedalGroups: [] })
  //                          superRegionCountries?: readonly string[] (default SUPER_REGION_COUNTRIES)
  export interface SiteScoreCoefficients {
    regionalSchools: number; regionalTeams: number;
    prelimSchools: number; prelimTeams: number; foreignTeams: number;
  }
  export const DEFAULT_SITE_SCORE_COEFFICIENTS: SiteScoreCoefficients; // 0.56 0.24 0.14 0.06 0.30
  export interface SiteCounts { schools: number; teams: number; foreign: number }
  /** Solving teams only; foreign = countryCode defined and !== 'KR'; super-region teams included. */
  export function countSiteInputs(snapshot: Snapshot): SiteCounts;
  export interface SiteScoreInputs {
    regional: SiteCounts;
    prelimSchools: number; prelimTeams: number;
    coefficients: SiteScoreCoefficients;
  }
  export function computeSiteScore(inputs: SiteScoreInputs): number;
  export interface RegionalSimulation {
    siteScore: number;
    stars: Map<string, ApacStarTier>;
    /** team id → (R−1)/S for every team in the scored list; empty when siteScore ≤ 0. */
    values: Map<string, number>;
  }
  export function simulateRegional(
    snapshot: Snapshot,
    opts: { siteScore: number; cutoff: number | null; quota: SchoolQuota; alreadyInvited: AlreadyInvited | null },
  ): RegionalSimulation;   // champion = standings[0]
  ```
- `APAC_SCHOOL_RANK_CAP` stays (bronze rule = 학내 3등 이내). The scored-list cap now comes from `quota`. (Superseded 2026-10-17: the cap was removed, and bronze is now the ceremony-only scored-list star.)

- [ ] **Step 1: Update existing tests to the new default.** In `apac.test.ts` "caps each school at 3" and `apac-published.test.ts`, pass `quota: { base: 3, wfMedalGroups: [] }` (the 2025-26 rule) and the site score 68.98 directly. Keep every assertion value as it is.
- [ ] **Step 2: Write failing tests in `test/core/apac-2026.test.ts`:**
  - `default quota keeps 2 teams per school` — school with 3 solving teams → third absent from `computeApacFilteredRanks`.
  - `a WF medal school keeps 3`.
  - `super-region teams are removed from the list but counted in S` — an `AU` team: absent from ranks; `countSiteInputs` counts it (teams and foreign).
  - `countSiteInputs counts solving teams only, schools with ≥1 solving team, foreign = non-KR with a country code` — a team with no `countryCode` is domestic.
  - `computeSiteScore applies the formula` — regional {schools 40, teams 80, foreign 5}, prelim 60/150 → `0.56*40+0.24*80+0.14*60+0.06*150+0.30*5` = 60.5 (toBeCloseTo).
  - `simulateRegional values are (R−1)/S and stars follow the cutoff` — value of filteredRank 3 with S=10 is 0.2; cutoff 0.2 → gold, next → silver.
  - `simulateRegional with siteScore 0 returns no values and promotes nobody` (Review Focus 5).
- [ ] **Step 3: Run** `npx vitest run test/core` — Expected: the new file FAILS; updated old files FAIL only where `quota` is unknown.
- [ ] **Step 4: Implement** the additions in `apac.ts`. Update the header comment: 2026-27 D3 steps, decision "B" (schools invited by any route still drop out, spec §6.2). `simulateRegional` calls `computeApacStars` (phase `'final'`) and `computeApacFilteredRanks` with the same options.
- [ ] **Step 5: Run** `npx vitest run test/core && npx tsc --noEmit` — Expected: PASS. (Award/publish callers compile unchanged: new options are optional.)
- [ ] **Step 6: Commit** `feat(core): APAC 2026-27 school quota, super-region, site score formula`.

---

### Task 3: Publish state contract

**Files:**
- Create: `src/core/publishState.ts`
- Test: `test/core/publishState.test.ts`

**Interfaces:**
- Consumes: `PrelimStage` (Task 1), `SiteScoreCoefficients`, `SchoolQuota` (Task 2).
- Produces:
  ```ts
  export const PUBLISH_STATE_VERSION = 1;
  export type PublishMode = 'off' | 'preliminary' | 'regional';
  export interface RegionalSimInputs {
    prelimSchools: number | null; prelimTeams: number | null;
    coefficients: SiteScoreCoefficients;
    regionalOverride: { schools: number | null; teams: number | null; foreign: number | null };
    wfMedalGroups: string[]; winnerGroups: string[]; invitedGroups: string[]; invitedTeamIds: string[];
    cutoff: number | null;
  }
  export interface PreliminaryResultState {
    totalTeams: number; topN: number; k: number;
    ineligibleTeamIds: string[];
    selected: { teamId: string; stage: PrelimStage }[];
  }
  export type PublishState = {
    schemaVersion: 1; generatedAt: string; title: string;
    display: { showTeamGroup: boolean; showFirstSolve: boolean; showBalloons: boolean; showSchoolLogos: boolean };
    problems: Problem[];
    orgs: OrgsIndex;            // only groups present in teams
    snapshot: SerializedSnapshot;  // plain-JSON mirror of Snapshot (Maps → arrays/records)
    manualLabels: Record<string, string[]>;
  } & (
    | { mode: 'off' }
    | { mode: 'preliminary'; preliminary: PreliminaryResultState }
    | { mode: 'regional'; regional: RegionalSimInputs }
  );
  export function buildPublishState(input: {
    mode: PublishMode; title: string; display: PublishState['display'];
    problems: Problem[]; orgs: OrgsIndex; snapshot: Snapshot;
    manualLabels: ReadonlyMap<string, readonly string[]> | null;
    preliminary?: PreliminaryResultState; regional?: RegionalSimInputs;
    now?: Date;
  }): PublishState;
  export function parsePublishState(json: unknown):
    | { ok: true; state: PublishState }
    | { ok: false; errors: string[] };   // each "publish-state.<path>: <message>"
  export function restoreSnapshot(state: PublishState): Snapshot;
  ```
- The schema is strict (`.strict()` on objects): unknown keys are errors, unlike `config.json`. Run lists are never stored.

- [ ] **Step 1: Write failing tests:**
  - `round-trips the sample contest` — load `public/sample` through spotboard → feeder → `computeStandings` (copy the loader from `apac-published.test.ts`), `buildPublishState` → `JSON.parse(JSON.stringify(...))` → `parsePublishState` ok → `restoreSnapshot` deep-equals the original `Snapshot` (standings order, cells, autoLabels, byTeam, firstSolvers).
  - `rejects a wrong schemaVersion with the path` → errors contain `publish-state.schemaVersion`.
  - `rejects mode/payload mismatch` — `mode: 'preliminary'` without `preliminary`.
  - `rejects unknown keys`.
  - `keeps only orgs of participating groups`.
- [ ] **Step 2: Run** `npx vitest run test/core/publishState.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `publishState.ts` (zod discriminated union on `mode`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): publish-state.json contract`.

---

### Task 4: Config, store, persistence, award wiring

**Files:**
- Modify: `src/core/config.ts`, `src/store/appStore.ts`, `src/App.tsx` (`useAwardApacStars`), `src/ui/publish/PublishControls.tsx`, `src/ui/publish/PublishView.tsx` (remove the site-score gate only)
- Create: `src/ui/publish/persist.ts`
- Test: `test/core/config.test.ts`, `test/store/appStore.test.ts`, `test/ui/publish-persist.test.ts` (new); update `test/ui/publish.test.tsx` for the removed gate

**Interfaces:**
- Consumes: `RegionalSimInputs`, `PublishMode` (Task 3); `SchoolQuota` (Task 2).
- Produces:
  - Config (`AppConfig['publish']`):
    ```jsonc
    { "enabled": false, "mode": "off",
      "invitedScoreCutoff": null,
      "alreadyInvited": { "teamIds": [], "winnerGroups": [], "invitedGroups": [] },  // legacy "groups" → invitedGroups (z.preprocess)
      "preliminary": { "totalTeams": null, "topN": 30, "k": null, "ineligibleTeamIds": [] },
      "regional": { "prelimSchools": null, "prelimTeams": null,
                    "coefficients": { /* defaults */ }, "wfMedalGroups": [] } }
    ```
  - URL: `publish_mode` (invalid → warning); `site_score` removed.
  - Store state: remove `siteScore`; replace `alreadyInvited` with
    `prelimInputs: { totalTeams: number|null; topN: number; k: number|null; ineligibleTeamIds: string[] }` and
    `regionalInputs: RegionalSimInputs`; actions `setPrelimInputs(patch)`, `setRegionalInputs(patch)`, `resetPublishInputs()` (back to config values).
    Seeded at boot from config (`regionalInputs.cutoff` ← `invitedScoreCutoff` and URL `invited_cutoff`;
    `winnerGroups`/`invitedGroups`/`invitedTeamIds` ← `alreadyInvited`), then from `loadPublishInputs` when present.
  - `persist.ts`:
    ```ts
    export function publishStorageKey(config: AppConfig, contestTitle: string, mode: PublishMode): string;
    // 'kimchi.publish:' + mode + ':' + (source.contestId || source.apiBase) + ':' + contestTitle
    export function loadPublishInputs<T>(key: string): T | null;   // try/catch, null on any error
    export function savePublishInputs(key: string, value: unknown): void;
    ```
  - Store flag `publishInputsFromStorage: boolean` (the prepare page shows "저장된 값을 사용 중").
  - Award mode: `useAwardApacStars` passes `quota: { base: DEFAULT_SCHOOL_QUOTA, wfMedalGroups: config.publish.regional.wfMedalGroups }` and the union of `alreadyInvited` groups.

- [ ] **Step 1: Write failing tests:**
  - config: `publish.mode defaults to off`; `publish_mode=regional overrides config`; `invalid publish_mode warns`; `legacy alreadyInvited.groups reads as invitedGroups`; `siteScore and site_score are gone` (key ignored, URL param not applied — no warning needed for an unknown param).
  - store: `boot seeds prelimInputs/regionalInputs from config`; `stored inputs win and set publishInputsFromStorage`; `resetPublishInputs restores config values and clears storage`.
  - persist: `keys differ by mode and by contest` (Review Focus 4); `corrupt JSON returns null`; `storage access that throws returns null`.
- [ ] **Step 2: Run** `npx vitest run test/core/config.test.ts test/store test/ui/publish-persist.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** config, store, persist, award wiring. Remove the site-score field and gate from `PublishControls`/`PublishView` (Task 6 rebuilds those screens; here they must only compile and render the board).
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS (update `test/ui/publish.test.tsx` gate tests: delete them; keep board/picker tests).
- [ ] **Step 5: Commit** `feat: publish.mode config, prepare-page inputs with per-contest persistence`.

---

### Task 5: Store-free scoreboard and row decoration

**Files:**
- Modify: `src/ui/scoreboard/Scoreboard.tsx`, `src/ui/scoreboard/TeamRow.tsx`, `src/ui/scoreboard/scoreboard.css`, `src/ui/scoreboard/index.ts`
- Test: `test/ui/scoreboard.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface RowDecor {
    advance?: boolean;        // yellow background (class 'team-row--advance')
    dimmed?: boolean;         // opacity 0.5 (class 'team-row--dimmed')
    tag?: string;             // small tag after the name (prepare page: '상위' | '학교' | '추가')
    value?: string;           // right-aligned note, e.g. APAC value '0.1740'
    leading?: ReactNode;      // control before the solved spine (ineligible checkbox); clicks do not open the mobile modal
  }
  // ScoreboardProps / TeamRowProps gain: rowDecor?: ReadonlyMap<string, RowDecor> | null  /  decor?: RowDecor
  export interface ScoreboardViewProps {      // required, no store fallback
    snapshot: Snapshot; problems: Problem[]; config: ResolvedConfig; orgs: OrgsIndex;
    apacStars?: ReadonlyMap<string, ApacStarInfo> | null;
    manualLabels?: ReadonlyMap<string, readonly string[]> | null;
    rowDecor?: ReadonlyMap<string, RowDecor> | null;
    flipCells?: ReadonlyMap<string, number> | null;
    searchQuery?: string | null; page?: number; followTeamId?: string | null; className?: string;
  }
  export function ScoreboardView(props: ScoreboardViewProps): JSX.Element;  // file: ScoreboardView.tsx, no '@store' import
  // Scoreboard keeps its current props and becomes a store wrapper around ScoreboardView.
  ```
- The yellow must keep text readable on the existing dark board: define `--row-advance-bg` in `scoreboard.css`; pick the value in the browser.

- [ ] **Step 1: Write failing tests:** `ScoreboardView renders without the store` (render with props only, store untouched); `advance adds team-row--advance`; `dimmed adds team-row--dimmed`; `value and tag render`; `leading click does not open the mobile detail modal`.
- [ ] **Step 2: Run** `npx vitest run test/ui/scoreboard.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.** Move the body of `Scoreboard` to `ScoreboardView.tsx`; `Scoreboard` reads the store and passes everything down. Add a test-time guard: `ScoreboardView.tsx`, `TeamRow.tsx`, and their imports must not import `@store` (assert with a small `readFileSync` grep test over `src/ui/scoreboard/*.tsx` except `Scoreboard.tsx`).
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `refactor(ui): store-free ScoreboardView with per-row decoration`.

---

### Task 6: Prepare page per mode

**Files:**
- Modify: `src/ui/publish/PublishView.tsx`, `src/ui/publish/PublishControls.tsx`, `src/ui/publish/publish.css`
- Create: `src/ui/publish/PrelimControls.tsx`, `src/ui/publish/RegionalSimPanel.tsx`, `src/ui/publish/SaveStateButton.tsx`
- Test: `test/ui/publish.test.tsx`

**Interfaces:**
- Consumes: `selectPreliminary` (T1); `countSiteInputs`, `computeSiteScore`, `simulateRegional` (T2); `buildPublishState` (T3); store inputs (T4); `ScoreboardView`, `RowDecor` (T5).
- Produces:
  ```ts
  // Controlled and store-free: Task 7 reuses it on the public page.
  export interface RegionalSimPanelProps {
    value: RegionalSimInputs; onChange: (next: RegionalSimInputs) => void;
    schools: readonly string[];          // contest schools, alphabetical
    autoCounts: SiteCounts; siteScore: number;
    onReset?: () => void;                // shown as "초기값으로 되돌리기" when given
    collapsedByDefault?: boolean;        // mobile public page
  }
  export function RegionalSimPanel(props: RegionalSimPanelProps): JSX.Element;
  export function useRegionalSimulation(snapshot: Snapshot, inputs: RegionalSimInputs): RegionalSimulation & { autoCounts: SiteCounts };
  // RegionalSimPanel.tsx; regionalOverride fields replace autoCounts when not null; null prelim counts → 0 with a hint
  ```
  The existing `InvitedSchoolPicker` moves into `RegionalSimPanel.tsx` (exported) and is used three times: WF 메달 학교, 다른 리저널 winner 학교, 다른 경로로 이미 초청된 학교. The coefficients sit in a `<details>` "고급".
- Screens:
  - `off`: board only + `SaveStateButton`.
  - `preliminary`: `PrelimControls` (T, N, K numeric fields; summary "진출 X팀 = 상위 a + 학교 대표 b + 추가 c"; warnings list), board with `rowDecor` (advance, tag, dimmed for ineligible, `leading` checkbox "미자격"). No selection shown while T or K is empty; show "진출 팀 수와 K를 입력하세요".
  - `regional`: `RegionalSimPanel` (with `onReset` = `resetPublishInputs`) + board with stars and `value` decor (4 decimals).
  - All modes: "저장된 값을 사용 중" + "config 값으로 되돌리기" when `publishInputsFromStorage`.
- `SaveStateButton`: opens a confirm dialog listing every input and the result summary; on confirm downloads `publish-state.json` (Blob + object URL). Disabled for `preliminary` while T or K is empty.

- [ ] **Step 1: Write failing tests** (rewrite `test/ui/publish.test.tsx`; reuse its fixture builder):
  - `off mode shows the board and the save button, no inputs`.
  - `preliminary: entering T and K paints selected rows yellow and shows the summary`.
  - `preliminary: checking 미자격 dims the row and moves selection to the next team`.
  - `preliminary: save is disabled until T and K are set`.
  - `regional: S is computed from auto counts plus prelim inputs and shown`.
  - `regional: picking a WF medal school keeps its 3rd team in the list` (value appears on that row).
  - `regional: cutoff turns qualifying rows gold`.
  - `save dialog lists the inputs and the download contains a parsePublishState-valid file` — stub `URL.createObjectURL`, capture the Blob, `parsePublishState(JSON.parse(await blob.text())).ok === true`.
- [ ] **Step 2: Run** `npx vitest run test/ui/publish.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** the three screens and the components.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Check in the browser:** `npm run dev`, open `/?publish=true&publish_mode=preliminary` and `…regional` on the sample data. Confirm yellow rows are readable, checkbox works, dialog downloads a file.
- [ ] **Step 6: Commit** `feat(publish): prepare page for off / preliminary / regional`.

---

### Task 7: Static public page

**Files:**
- Create: `publish.html`, `src/published/main.tsx`, `src/published/PublishedApp.tsx`, `src/published/published.css`
- Test: `test/ui/published.test.tsx`

**Interfaces:**
- Consumes: `parsePublishState`, `restoreSnapshot` (T3); `ScoreboardView`, `RowDecor` (T5); `RegionalSimPanel`, `useRegionalSimulation` (T6).
- Produces:
  ```ts
  export function PublishedApp({ state }: { state: PublishState }): JSX.Element;
  // main.tsx: reads JSON from <script type="application/json" id="publish-data">, parsePublishState,
  // renders PublishedApp or a Korean error panel. publish.html holds the placeholder comment
  // <!--PUBLISH_DATA--> inside <body>, before the module script.
  ```
- Config for `ScoreboardView`: `defaultConfig()` + `applyUrlOverrides(..., '')` with `state.display` merged, `animation: false`, `pagination: false`, `apac.enabled = state.mode === 'regional'`.
- Header: title only. No clock, no mode tag.
- `preliminary`: rows from `state.preliminary.selected` → `advance`; `ineligibleTeamIds` → `dimmed`. No tag, no inputs, no recompute. Legend "노란색 = 본선 진출".
- `regional`: banner (exact copy in Global Constraints), `RegionalSimPanel` with local `useState` seeded from `state.regional`, `onReset` restores it, `collapsedByDefault` on mobile (`useMediaQuery(MOBILE_MEDIA_QUERY)`), a link to `https://icpc.jp/apac/2026-27/rules/`, star legend (동색/은색/금색 copy from `PublishView` today; superseded 2026-10-17: the legend no longer mentions 동색).
- `src/published/**` must not import `@store` or `@core/ingest` (same grep test as Task 5, extended to this folder).

- [ ] **Step 1: Write failing tests:** `off renders the board without inputs`; `preliminary paints saved selections and dims ineligible, and has no input element`; `preliminary does not recompute — a state whose selected list disagrees with K still shows the saved list`; `regional shows the banner, editing the cutoff changes stars, reset restores the seed`; `no @store/@core/ingest import under src/published`.
- [ ] **Step 2: Run** `npx vitest run test/ui/published.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(published): static public page for the three modes`.

---

### Task 8: `npm run publish` and docs

**Files:**
- Create: `vite.publish.config.ts`, `scripts/publish.ts`
- Modify: `package.json` (`"publish": "vite-node scripts/publish.ts --"`), `.gitignore` (`publish-dist/`), `docs/operations.md` §6 Step 4 and §8 rows for the publish board, `docs/superpowers/specs/2026-07-30-kimchi-resolver-design.md` §13 (link to the new spec; mark `siteScore`/`site_score` removed), `README.md` if it mentions `site_score`
- Test: `test/scripts/publish.test.ts`

**Interfaces:**
- Consumes: `parsePublishState` (T3); `publish.html` (T7).
- Produces:
  ```ts
  export interface PublishRunResult { outDir: string; warnings: string[] }
  export async function runPublish(opts: { statePath: string; outDir?: string /* default 'publish-dist' */ }): Promise<PublishRunResult>;
  // throws PublishError(message) on invalid state or a failed scan; CLI wrapper prints it and exits 1
  ```
- Steps inside `runPublish`:
  1. Read + `parsePublishState`; on failure throw with every error line.
  2. Empty `outDir`, then `vite.build({ configFile: 'vite.publish.config.ts' })` — config: `base: './'`, `publicDir: false`, input `publish.html`, `outDir`, same aliases as `vite.config.ts`.
  3. Rename `publish.html` → `index.html`; replace `<!--PUBLISH_DATA-->` with `<script type="application/json" id="publish-data">` + JSON with every `<` written as `<` + `</script>`.
  4. If `state.display.showSchoolLogos`: copy `public/orgs/logos/<logo>` for each `state.orgs` entry with a logo into `outDir/orgs/logos/`; missing file → warning, not error.
  5. Scan every output file: fail when it contains `source.auth.username`/`password` or a non-empty `source.baseUrl` from `public/config.json` (when that file exists), when any file is named `config.json` or `awards.json`, or when a JS file contains `judgement-types` (marker of the Contest API adapter — proves feed code leaked in).
  6. Print the output path and "S3에 이 폴더를 올리세요".

- [ ] **Step 1: Write failing tests** (`// @vitest-environment node`, timeout 60 s): build a state from the sample (helper from Task 3 test, move it to `test/helpers/sampleState.ts`), write it to a temp dir, then:
  - `builds index.html with embedded, parseable data` — extract the JSON from the script tag, `parsePublishState(...).ok`.
  - `escapes </script> in team names` (Review Focus 2) — rename one team to `x</script><b>` before writing; the HTML has exactly one `</script>` after `id="publish-data"`'s opening tag, and parsing restores the name.
  - `refuses an invalid state with the zod path` (Review Focus 1) — `schemaVersion: 2` → rejects with `publish-state.schemaVersion`.
  - `output has no config.json, no awards.json, and no judgement-types`.
- [ ] **Step 2: Run** `npx vitest run test/scripts/publish.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `vite.publish.config.ts`, `scripts/publish.ts`, the package script, `.gitignore`.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build` — Expected: PASS; `dist/` has no `publish.html` (main build input stays `index.html`).
- [ ] **Step 5: End-to-end check:** in the browser, save a `preliminary` and a `regional` state from the sample (Task 6 Step 5), run `npm run publish -- ~/Downloads/publish-state.json`, open `publish-dist/index.html` through `npx vite preview --outDir publish-dist`. It must render. (`file://` is not a target: browsers block module scripts there, and S3 serves over HTTP.)
- [ ] **Step 6: Update the docs** listed under Files: new day-of flow (prepare → 확정 결과 저장 → `npm run publish -- <file>` → upload `publish-dist/`), the `publish_mode` param, removal of `site_score`.
- [ ] **Step 7: Commit** `feat: npm run publish builds a static, credential-free board`.
