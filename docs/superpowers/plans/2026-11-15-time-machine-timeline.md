# Time-machine Rank Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Timeline" view on the time-machine board: per-minute rank lines and submissions for 1–6 selected teams, switched from the header.

**Architecture:** A pure core module computes rank series and submission events from the raw run list (reusing `computeStandings` per minute). The store keeps the raw runs (merged by id from every fetch) and the selection/view state, seeded from new URL params and mirrored back with `history.replaceState`. The UI adds a header switch, clickable/tinted board rows, and a `TimelineView` (picker + SVG chart).

**Tech Stack:** React 18, TypeScript, zustand, zod, vitest + Testing Library. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-time-machine-timeline-design.md`

## Global Constraints

- All user-facing text is English (spec §5.5). Exact strings: `Board`, `Timeline`, `Timeline (n)`, `Teams`, `Compare up to 6 teams. You can also click a team on the board.`, `The timeline shows up to 6 teams.`, `Rank timeline`, `<team> · Rank timeline`, `All ranks 1–N`, `Selected teams`, `Pick teams on the left.`, `Now HH:MM`, `Frozen`.
- Max 6 teams. Colors, slot order: `#2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #6250d6`; a team keeps its slot; a new team takes the lowest free slot.
- Single-team chart: rank line `#0b0b0b` 2 px; accepted line `#1f9d3a`, rejected `#d63a36`, 55 % opacity.
- Selected board row: team color at 22 % alpha, also on hover; wins over `followed`.
- Only spectator mode with `config.timeline.enabled`; desktop (≥ 769 px) only.
- No commits without the operator's explicit approval (the working tree already holds other uncommitted work). Replace each "Commit" step with "stage nothing; note the files".

## Review Focus

1. A feed where a team submits after solving a cell (e.g. resubmits A after AC): the timeline still draws the run (single mode) and the rank does not change. → Task 2 test `afterSolve runs are kept and change nothing`.
2. `time=` set and the board still feeding (pendingCount > 0): the chart shows the whole contest, only the "Now" marker moves. → Task 2 uses the raw list; Task 5 test `chart does not depend on the current minute`.
3. `teams=` with duplicates, unknown ids, more than 6, or a team excluded by `excludeTeams`: deduplicated, dropped silently, capped at 6. → Task 3 test.
4. Two teams tied (same solved/penalty/last) at a minute: same rank, as on the board. → Task 2 parity test with a tie fixture.
5. A link with `view=timeline` on a board where `timeline.enabled` is false: plain board, no warning. → Task 3 test.

---

### Task 1: Config `timeline` and URL params `view` / `teams`

**Files:**
- Modify: `src/core/config.ts` (schema next to `timeTravel`; `ResolvedConfig`; `applyUrlOverrides`)
- Modify: `README.md` (config table + URL table)
- Test: `test/core/config.test.ts`

**Interfaces:**
- Produces: `AppConfig.timeline: { enabled: boolean; freezeMinute: number | null }` (default `{ enabled: false, freezeMinute: null }`, `freezeMinute` int ≥ 0); `ResolvedConfig.timelineView: boolean` (default false), `ResolvedConfig.timelineTeams: string[]` (default `[]`, raw ids in URL order, deduplicated, not yet validated against the contest).

- [ ] Step 1: tests — defaults; `{enabled: true, freezeMinute: 210}` accepted; `freezeMinute: -1` → error, default kept; `?view=timeline` → `timelineView === true`; `?view=foo` → one warning, false; `?teams=3,1,3,,x` → `['3','1','x']`; no params → `[]`, false.
- [ ] Step 2: run `npx vitest run test/core/config.test.ts` → FAIL.
- [ ] Step 3: implement. URL parsing only fills the fields; gating by `timeline.enabled`/mode happens in the store (Task 3).
- [ ] Step 4: run the same command → PASS; update the two "default objects" in the config tests that list every key.
- [ ] Step 5: README rows: `timeline.enabled`, `timeline.freezeMinute`, URL `view=timeline`, `teams=<id,…>`.

### Task 2: Core `src/core/timeline.ts`

**Files:**
- Create: `src/core/timeline.ts`
- Test: `test/core/timeline.test.ts`

**Interfaces:**
- Consumes: `computeStandings(contest, runs)` from `@core/standings`; `Run`, `Contest` from `@core/types`.
- Produces:
  - `mergeRuns(known: ReadonlyMap<string, Run>, incoming: readonly Run[]): Map<string, Run>` — new map, a later copy of an id replaces the earlier one.
  - `timelineEndMinute(contestTimeSec: number | null, runs: readonly Run[]): number` — `max(ceil(contestTimeSec/60), max run minute, 0)`.
  - `type TimelineEventKind = 'accepted' | 'rejected' | 'noPenalty' | 'pending'`
  - `interface TimelineEvent { minute: number; problemId: string; kind: TimelineEventKind; afterSolve: boolean; count: number; firstSeq: number }` — consecutive runs (seq order) of one team with equal minute, problem, kind and afterSolve are grouped (`count`).
  - `interface RankTimeline { endMinute: number; teamCount: number; ranks: ReadonlyMap<string, readonly number[]>; events: ReadonlyMap<string, readonly TimelineEvent[]> }` — `ranks.get(id)[t]` = `icpcRank` after all runs with `minute ≤ t`, for `t = 0..endMinute`.
  - `computeRankTimeline(contest: Contest, runs: readonly Run[], endMinute: number): RankTimeline`
  - `TIMELINE_MAX_TEAMS = 6`, `TIMELINE_COLORS: readonly string[]` (the six hex values).

- [ ] Step 1: tests —
  - parity: fixture with 4 teams, 3 problems, a tie at some minute, a CE (`penaltyCounts: false`), a pending run, and a post-solve resubmission: for every t, `ranks.get(id)[t] === computeStandings(contest, runs.filter(r => r.minute <= t)).byTeam.get(id).icpcRank`.
  - `afterSolve runs are kept and change nothing`: the resubmission appears in `events` with `afterSolve: true`; ranks equal the run set without it.
  - grouping: two rejected runs of problem M at minute 290 → one event `count: 2`.
  - kinds: `noPenalty` for `failed` + `penaltyCounts: false`; `pending` for `verdict: 'pending'`.
  - `timelineEndMinute(18000, runs) === 300`; `timelineEndMinute(null, [run at 12]) === 12`.
  - `mergeRuns` replaces by id and keeps others.
- [ ] Step 2: run `npx vitest run test/core/timeline.test.ts` → FAIL.
- [ ] Step 3: implement. Ranks: sort runs by (minute, seq) once, then call `computeStandings` on each prefix (`minute ≤ t`), skipping the call when no run has that minute (copy the previous column). `afterSolve`: per (team, problem), runs with seq greater than the first accepted run's seq.
- [ ] Step 4: run → PASS. Also a quick timing check in the test file: the 2026 Regional size (81 teams, 1052 runs, 300 min) is not needed as a fixture; keep the fixture small.

### Task 3: Store state — raw runs, view, selection, URL mirror

**Files:**
- Modify: `src/store/appStore.ts`
- Create: `src/ui/timeline/timelineUrl.ts`
- Test: `test/store/timeline-store.test.ts` (follow the existing store test setup with a fake source), `test/ui/timeline-url.test.ts`

**Interfaces:**
- Consumes: Task 1 fields, Task 2 `mergeRuns`, `TIMELINE_MAX_TEAMS`.
- Produces (AppState):
  - `timelineRuns: readonly Run[]` — raw runs, merged on the boot fetch and every poll.
  - `view: 'board' | 'timeline'`
  - `timelineTeams: readonly { id: string; slot: number }[]`
  - actions: `setView(view)`, `toggleTimelineTeam(id): 'added' | 'removed' | 'full'`, `removeTimelineTeam(id)`.
  - `timelineEnabled(state): boolean` selector = `mode === 'spectator' && config.timeline.enabled`.
- `timelineUrl.ts`: `timelineHref(href: string, view: 'board' | 'timeline', teamIds: readonly string[]): string` (sets/removes `view` and `teams`, keeps other params); `syncTimelineUrl(state)` calls `history.replaceState` with it.

- [ ] Step 1: tests — boot with `timeline.enabled` + `?view=timeline&teams=2,99,2,1` → `view === 'timeline'`, teams `[{id:'2',slot:0},{id:'1',slot:1}]` (99 unknown, duplicate dropped), no system message; same URL with `enabled: false` → `view === 'board'`, teams `[]`, no message; toggle 7th → `'full'`; remove slot 0 then add → new team gets slot 0, others keep slots; `timelineRuns` contains a post-solve run that the feeder dropped; `timelineHref` keeps `time` and `q`, removes `view`/`teams` when board/empty.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement; seed after the contest is loaded (ids validated against `contest.teams`); mirror to the URL in `setView`/`toggleTimelineTeam`/`removeTimelineTeam` (no reload).
- [ ] Step 4: run → PASS; run the whole suite `npx vitest run` → all pass.

### Task 4: Header switch and board row selection

**Files:**
- Modify: `src/ui/chrome/Header.tsx`, `src/ui/chrome/chrome.css`
- Modify: `src/ui/scoreboard/TeamRow.tsx`, `src/ui/scoreboard/ScoreboardView.tsx`, `src/ui/scoreboard/Scoreboard.tsx`, `src/ui/scoreboard/scoreboard.css`
- Modify: `src/App.tsx`
- Test: `test/ui/timeline-switch.test.tsx`

**Interfaces:**
- Consumes: Task 3 state/actions, `TIMELINE_COLORS`.
- Produces: `TeamRow` props `selectColor?: string | null` (tint) and `onToggleSelect?: (teamId: string) => void` (desktop only; makes the row `role="button"`, `tabIndex=0`, `aria-pressed`, Enter/Space). `Scoreboard` prop `timelineSelection?: ReadonlyMap<string, string> | null` (id → color) and `onToggleTimelineTeam?`. App renders `<TimelineView />` instead of the board when `view === 'timeline'`.

- [ ] Step 1: tests — no switch when disabled; switch `Board | Timeline` when enabled; label `Timeline (2)` with 2 teams; clicking a row adds the team and sets `--kr-select-color` / class `team-row--selected`; Enter on a focused row toggles; 7th click → system message `The timeline shows up to 6 teams.` (level `info`); mobile (≤ 768 px, see `test/ui/mobile.test.tsx` for the media setup) → no switch, row click still opens the detail modal.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement. Row CSS: `.team-row--selected, .team-row--selected:hover { background-color: color-mix(in srgb, var(--kr-select-color) 22%, #fff) }` placed after the `followed` rules. Switch styles follow `.kr-hbtn`; active segment `#f5c400` background, `#1f2430` text.
- [ ] Step 4: run → PASS.

### Task 5: `TimelineView` — picker and chart

**Files:**
- Create: `src/ui/timeline/TimelineView.tsx`, `src/ui/timeline/TeamPicker.tsx`, `src/ui/timeline/RankChart.tsx`, `src/ui/timeline/timeline.css`
- Test: `test/ui/timeline-view.test.tsx`

**Interfaces:**
- Consumes: Task 2 `computeRankTimeline`, `timelineEndMinute`; Task 3 state; the slider's current-minute rule (extract `currentSliderMinute(state): number` from `TimeSlider.tsx` into `src/ui/chrome/TimeSlider.tsx` as an export and use it in both).
- Produces: `TimelineView` (no props, reads the store).

Layout and drawing follow spec §6.6 and the prototype (`docs/superpowers/specs/assets/2026-11-15-timeline-prototype.html`): picker 300 px; chart SVG with x ticks every 30 min (`HH:MM`), y nice steps (10/5/2/1), freeze band when `config.timeline.freezeMinute` is set, single-team vertical lines with rotated stacked labels (`*`, ` ×N`), multi-team dots/rings without `afterSolve`, end labels `<ordinal> <name>` nudged ≥ 15 px, dashed `Now HH:MM` marker at the bottom when current < end, crosshair tooltip (`HH:MM (minute t)`, ranks, `F accepted · 3 → 1`, `M rejected ×2`, `E compile error (no penalty)`).

- [ ] Step 1: tests — empty state text; picker lists teams sorted by rank at the current minute (fixture where final and current orders differ); search filters by name and school; chips × removes; single team → vertical submission lines (`data-kind` attributes) and label `M ×2`; two teams → no vertical lines, dots for accepted, rings for rejected, no `afterSolve` marks; `chart does not depend on the current minute` (same path `d` for current 100 and 300); y toggle `Selected teams` changes the first y tick; freeze band only with `freezeMinute`.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement; memoize `computeRankTimeline` on (`contest`, `timelineRuns`, end minute).
- [ ] Step 4: run → PASS; `npx tsc --noEmit` clean; `npx vitest run` all pass.

### Task 6: Build, docs, local check

**Files:**
- Modify: `docs/operations.md` (time-machine section: `timeline` config), `feed-out/regional-board/config.json` (local only; git-ignored)

- [ ] Step 1: `npm run build`; copy `dist/` assets and `index.html` into `feed-out/regional-board/`; set `"timeline": {"enabled": true, "freezeMinute": 210}` in its `config.json`.
- [ ] Step 2: serve it on 8091 (no-cache server) and screenshot: board with 3 selected teams, timeline with 1 team (compare with the reference picture: floorsum line), timeline with 3 teams at `time=200`.
- [ ] Step 3: report to the operator; upload only after an explicit yes.
