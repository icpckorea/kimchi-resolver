# Time-machine rank timeline — design

Date: 2026-11-15. Status: draft for approval.
Prototype (throwaway, not app code): `docs/superpowers/specs/assets/2026-11-15-timeline-prototype.html`,
confirmed by the operator on 2026-11-15. It reads `feed/contest.json` and
`feed/runs.json` next to it and embeds a board build from `board/`; serve a
folder with those to open it. Follow this document where the two differ.

## 1. Intent

After a contest, the time-machine board (`<contest>/scoreboard/time-machine/`,
config `timeTravel: true`, full unfrozen feed) lets anyone replay the contest
minute by minute. People also want to see **how a team's rank moved over the
whole contest** and **compare a few teams** — the picture the operator used to
make by hand (rank step line + one vertical line per submission, green for
accepted, red for rejected).

This feature adds a second view to the time-machine page: a rank timeline built
from the runs feed, for one or more selected teams.

## 2. Goals, non-goals, anti-goals

Goals
- A "Timeline" view next to the existing board, switched from the header.
- Select 1–6 teams; one chart; the whole contest (0 → end) is always shown.
- Data comes only from the runs feed the board already loads.
- The state (view, selected teams) lives in the URL, so a slider reload keeps it
  and a copied link opens the same view.

Non-goals (v1)
- Live (frozen) boards, award mode, publish mode, the published static page.
- Mobile (≤ 768 px) layout. (Builder call, see §9.)
- Image export, a data table view, animation of the chart.

Anti-goals (a failure even if it works)
- Ranks that differ from the board. The timeline rank at minute *t* must equal
  the board's `icpcRank` with `time=t`, including ties and no-penalty compile
  errors.
- Changing what the board looks like when the timeline is off.
- Enabling the timeline on a frozen live board by default.

## 3. Constraints (from the code)

- The time slider reloads the page with `time=` and `q=` only
  (`src/ui/chrome/TimeSlider.tsx` `timeTravelHref`); other query params survive.
- With `time=` set, later runs stay in the feeder queue (`QueuedRunFeeder`:
  `applied` + `queue`), and the feeder drops runs after a cell's accepted run.
  So neither list is the whole feed: the timeline keeps its own raw run list
  (§6.3).
- The spotboard feed has the contest clock (`time.contestTime`, seconds;
  18000 for 2026 Regional) but **no freeze minute**.
- Ranking rules (`src/core/standings.ts`): solved desc → penalty asc →
  last-solve minute asc, competition ranking (1,2,2,4); net runs truncate after
  the first accepted run per cell; 20 min per failed run with `penaltyCounts`.
- Spotboard `"No (no penalty)"` maps to a rejection with `penaltyCounts: false`
  (`src/core/verdict.ts`).
- Desktop board rows carry `data-team-id`; on desktop they have no click
  action today (mobile rows open `TeamDetailModal`).

## 4. Approaches

| | How | Trade-off |
|---|---|---|
| **A (chosen)** | Header switch `[Board \| Timeline (n)]`; the main area shows the board or the timeline; state in the URL | Large chart, board size unchanged, fits the reload-based slider |
| B | Board on top, chart in a drawer below | Both visible, but the board loses its ~18-rows-per-screen size |
| C | Modal chart over the board | Simplest, but comparing teams means close → pick → reopen |

The operator picked **A** on 2026-11-15.

## 5. Decided by the operator

1. View switch: approach A, a segmented control in the header.
2. The timeline always shows the **whole contest**, whatever `time=` is.
   The current slider minute is only a dashed marker with "Now HH:MM".
3. Multi-team chart: submissions are **dots on the team's own line**
   (filled = accepted, with the problem letter; hollow = rejected).
4. Board selection: a selected row gets a **hover-like background tint** in the
   team's color (no outline), also while hovered.
5. All user-facing text is **English**, like the rest of the board chrome.
6. No preset buttons. Teams are picked from the timeline list, by clicking board
   rows, or by the URL.

## 6. Design

### 6.1 Enable

New config key `timeline` (object): `{ enabled: false, freezeMinute: null }`.
- `enabled` shows the header switch (spectator mode only). The time-machine
  deployment sets it to `true` (with `timeTravel: true`).
- `freezeMinute` (int ≥ 0 or null): when set, the chart shades
  `[freezeMinute, end]` light gray with the label "Frozen". Null: no band.
  (The feed has no freeze minute; 2026 Regional = 210.)
- README config table rows for both keys.

### 6.2 URL state

- `view=timeline` → timeline view; absent → board.
- `teams=<id>,<id>,…` → selected team ids **in selection order**. A team whose
  color slot differs from its position is written `id:slot` (`teams=48,40:2`
  after the 2nd of 3 teams was removed), so a reload keeps every color. Unknown
  or repeated ids are dropped; at most 6 are kept; a bad or taken slot gets the
  lowest free one. (Added after the final review.)
- Selecting/deselecting and switching views update the URL with
  `history.replaceState` (no reload). The slider reload keeps both params.
- Parsed with the other URL overrides in `src/core/config.ts`. Unknown team
  ids are dropped silently (a link may outlive a team list). Without
  `timeline.enabled`, or outside spectator mode, both params are ignored
  silently. A malformed value (`view=foo`) gets the usual system-message
  warning. (Designer's call.)
- `timeline` is a config.json key only (no URL override), validated like the
  other nested keys: an invalid value is a warning and falls back to the
  default.

### 6.3 Data

- Input: the **raw run list of the feed**, independent of `time=`: every run of
  the latest `fetchRuns` results, merged by run id (a later copy replaces an
  earlier one, so each run is in its final state). Do **not** read the feeder's
  applied + queued lists: the feeder drops runs after a cell's accepted run
  (`isClosedCell`), and what it holds depends on `time=`. The store keeps this
  list next to the feeder; the feeder itself is unchanged. (Designer's call.)
- `Run.minute` is already the floored contest minute. "Runs up to minute t"
  means `minute ≤ t`, the same rule as the `time=` replay.
- End minute `E`: the time slider's maximum (`ceil(contestTimeSec / 60)`), at
  least the last run minute. (Designer's call: chart end = slider end.)
- Teams: exactly `contest.teams` (the teams `computeStandings` ranks; excluded
  teams are not there). Foreign teams are included and selectable; ranks are
  `icpcRank`; `N` = the number of those teams.
- Rank series per team for every minute `0..E`: the rank after all runs with
  `minute ≤ t`. It **must** use the same rules as `computeStandings`
  (reuse it per minute, or an incremental equivalent with a parity test).
- Events per team: the team's runs in seq order, kind = accepted / rejected /
  no-penalty rejected / pending; runs after the cell's first accepted run are
  flagged `afterSolve`.
- Pending runs (only possible on a frozen feed) never change a rank; drawn as a
  gray marker "?" in single mode and skipped in multi mode.
- Memoized: recompute only when the run set changes.

### 6.4 Header

When `timeline.enabled` and mode is spectator: a segmented control
`[Board | Timeline]` placed left of the time slider. With `n ≥ 1` selected teams
the second label is `Timeline (n)`. The active segment uses the header accent
(yellow, as in the prototype).

### 6.5 Board view

- Desktop rows become clickable when `timeline.enabled`: a click toggles the
  team. A 7th team shows a short toast "The timeline shows up to 6 teams."
  Keyboard: the row is `role="button"`, `tabIndex=0`, Enter/Space toggles,
  `aria-pressed` = selected. Use a new handler, not the mobile
  `tappable`/`onOpenDetail` path; controls inside the row keep stopping
  propagation as today. (Designer's call.)
- Selected row: `background-color` = team color at 22 % alpha, also on `:hover`.
  The selection tint wins over the `followed` row style. (Designer's call.)
- Mobile rows keep opening the team detail modal (no selection).

### 6.6 Timeline view

Layout (desktop): two cards under the header.
- **Left, 300 px — team picker**: title "Teams", hint "Compare up to 6 teams.
  You can also click a team on the board.", search box (team name or
  school, case-insensitive), selected-team chips (color dot, name, ×), then the
  team list sorted by the **rank at the current board minute** (not the final
  rank: no spoiler in the list), each row = checkbox, rank, name, school.
  Rows beyond 6 are disabled.
- **Right — chart card**: title (`<team> · Rank timeline` for one team, else
  `Rank timeline`), y-axis toggle `[All ranks 1–N | Selected teams]` (default
  all; selected = min..max rank of the selected teams ± 2, at least 6 ranks), legend,
  chart (fills the rest of the height), footnote
  "* no penalty (compile error) · ×N: N submissions in the same minute ·
  gray area: frozen (from minute N)" (freeze part only when `freezeMinute` is
  set). Empty state: "Pick teams on the left."

Chart (SVG, one y-axis = rank, 1 at the top):
- x axis 0..E, ticks every 30 min as HH:MM; y grid at nice steps (10/5/2/1).
- **One team** (as the reference picture): black 2 px step line; every
  submission a full-height vertical line (accepted `#1f9d3a`, rejected
  `#d63a36`, 55 % opacity); rotated labels at the top, stacked into rows when
  closer than 13 px; label = problem letter + `*` for no-penalty + ` ×N` when N
  runs of the same problem and kind fall in the same minute. Runs after the
  cell's solve are drawn too.
- **2–6 teams**: one 2.25 px step line per team in its slot color; accepted =
  filled 5 px dot (2 px surface ring) with the problem letter above in text ink;
  rejected = hollow 3.2 px ring; `afterSolve` runs skipped. Direct labels at the
  right end "<ordinal> <name>" (final rank, e.g. `1st floorsum`), nudged
  ≥ 15 px apart.
- Current-minute marker when the current minute < E: dashed vertical line,
  "Now HH:MM" at the bottom. The current minute is the minute the time slider
  shows (it follows playback: `lastAppliedMinute` while runs are fed, `time=`
  after a reload, E at the end). The picker list sorts by the rank at this
  minute. The chart data does not change with it. (Designer's call.)
- Hover: crosshair + tooltip: `HH:MM (minute t)`, each team's rank at t, and that
  minute's submissions in seq order (`F accepted · 3 → 1`, `M rejected ×2`,
  `E compile error (no penalty)`). The rank change is rank at t−1 → rank at t.
  Rank numbers use ordinals like the board where they stand alone
  (`1st`), and plain numbers in arrows.

Colors: 6 categorical slots from the dataviz reference palette, light mode:
`#2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #6250d6`. A team keeps its slot
while selected; removing a team never repaints the others; a new team takes the
lowest free slot.

## 7. Testing

- Core: rank series parity — for the 2026 Regional feed (or a fixture), the
  series at every minute equals `computeStandings` of the runs up to that
  minute; ties share a rank; no-penalty runs add no penalty; runs after a solve
  change nothing; pending runs change nothing.
- URL: parse/serialize `view`, `teams` (order, unknown ids, > 6, junk).
- UI: switch shows only with `timeline.enabled` in spectator; row click toggles
  and tints; 7th team → toast; chips × removes; colors stable on removal;
  single vs multi rendering (vertical lines vs dots); empty state.
- Config: `timeline` defaults and validation.

## 8. Rollout

Rebuild the time-machine folder with `timeline: { enabled: true,
freezeMinute: 210 }` and check it locally. Upload to
`2026/regional/scoreboard/time-machine/` only after an explicit yes.

## 9. Left to the builder (marked as the designer's calls)

- Mobile: the switch is hidden below 769 px in v1.
- How the store exposes applied + queued runs, and per-minute vs incremental
  ranking (parity test required either way).
- Component/file split (suggested: `src/core/timeline.ts` for the data,
  `src/ui/timeline/` for the view).
- Exact spacing and fonts, following the existing header and board styles.
