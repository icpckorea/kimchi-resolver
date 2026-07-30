# kimchi-resolver

A modern rewrite of [spotboard](https://github.com/spotboard/spotboard), the ACM-ICPC scoreboard web app. Stack: React + Vite + TypeScript, zustand for state, vitest for tests.

The app has three modes:

- **spectator** — live scoreboard with polling, autoplay run feed, events dashboard, desktop notifications.
- **award** — the award ceremony ("resolver"): frozen runs are revealed one keypress at a time, with slides, gacha effects and a finale spotlight.
- **publish** — static final scoreboard for announcements, with APAC advancement stars and the invited-cutoff input.

Design spec: `docs/superpowers/specs/2026-07-30-kimchi-resolver-design.md`.

## Commands

```sh
npm install
npm run dev          # dev server (Vite)
npm run build        # typecheck + production build into dist/
npm run preview      # serve the built dist/
npm test             # vitest, single run
npm run test:watch   # vitest, watch mode
npm run typecheck    # tsc --noEmit only
npm run check-assets # verify orgs.json / logo coverage for the configured data
```

## Configuration

Runtime configuration lives in `public/config.json` (served as `config.json` next to the app). It is fetched at boot, so you can edit it after deployment without a rebuild. All keys are optional; missing keys use the defaults below. Invalid keys are reported as system messages and replaced by their defaults.

| Key | Default | Meaning |
|---|---|---|
| `source.type` | `"spotboard"` | `"spotboard"` or `"contest-api"` |
| `source.apiBase` | `"./sample/"` | spotboard: directory with `contest.json` + `runs.json` |
| `source.baseUrl` | `""` | contest-api: API root URL |
| `source.contestId` | `""` | contest-api: contest id |
| `source.auth` | `null` | contest-api: `{ "username", "password" }` or null |
| `source.eventsWs` | `null` | WebSocket URL used as a poll trigger ("doorbell") |
| `fetchTimeout` | `5000` | fetch timeout in ms |
| `autoRefreshInterval` | `10000` | poll interval in ms |
| `autoPlay` | `true` | consume the run queue automatically |
| `autoPlayDelay` | `100` | ms between autoplay ticks (one run per tick) |
| `animation` | `true` | row/cell animations |
| `showTeamGroup` | `true` | show the school name under the team name |
| `showFirstSolve` | `true` | first-solve cell highlight |
| `showBalloons` | `true` | balloon row per solved problem |
| `showSchoolLogos` | `false` | school logos from `orgs/logos/` |
| `showEvents` | `false` | events dashboard initial visibility |
| `maxNotifications` | `100` | dashboard event cap |
| `pagination` / `paginationSize` | `false` / `50` | scoreboard pagination |
| `useFollowedTeamSticky` | `true` | pin the followed team row |
| `excludeTeams` | `[]` | team ids removed completely from all rankings |
| `foreign.ids` / `foreign.groups` | `[]` | override the foreign-team detection |
| `apac.enabled` | `false` | APAC advancement stars (award/publish only) |
| `publish.enabled` | `false` | boot into publish mode |
| `publish.siteScore` | `null` | site score (publish gate; required for the board) |
| `publish.invitedScoreCutoff` | `null` | invited score cutoff for the gold-star rule |
| `award.mode` | `false` | boot into award mode |
| `award.hideName` | `true` | mask unrevealed teams as "Team {id}" |
| `award.rankBegin` | `null` | fast-forward the ceremony to this rank |
| `award.awardsUrl` | `"./sample/awards.json"` | awards.json v2 location |
| `award.revealOrder` | `[]` | problem reveal priority (labels or ids) |
| `award.focusBlinking` | `{ "minSolved": 7, "maxRank": 10 }` | blink stage condition, or null |
| `award.gachaEffectRequirement` | `8` | attempts that trigger the gacha effect |
| `award.gachaEffectForNoRatio` | `30` | gacha probability (%) for a final "No" |
| `award.animationSpeeds` | see spec §9 | flip/move speeds per solved count |

### URL parameters

URL parameters override `config.json` (spec §9/§13):

| Parameter | Meaning |
|---|---|
| `r=<run id>` | replay runs up to this run id without animation (award: the freeze cutoff) |
| `time=<minute>` | replay runs up to this contest minute; forces autoplay off |
| `award=true` | award mode |
| `award_rank_begin=<n>` | fast-forward the ceremony to rank n |
| `animation=false` | disable animations |
| `q=<text>` | initial team search (substring match over name + school) |
| `t=<team id>` | follow this team (highlight + sticky row) |
| `publish=true` | publish mode (wins over award) |
| `site_score=<n>` | publish: site score (opens the gate) |
| `invited_cutoff=<x>` | publish: invited score cutoff |

Example: `index.html?award=true&r=1000` starts the ceremony with runs after id 1000 frozen.

## Data sources

**spotboard JSON** (default): put `contest.json` and `runs.json` where `source.apiBase` points. The bundled `public/sample/` contains the 2025 ICPC Asia Seoul Regional sample (84 teams, 13 problems, 1,227 runs) so the app works offline out of the box.

**ICPC Contest API** (DOMjudge/CDS): set `source.type` to `"contest-api"`, plus `baseUrl`, `contestId` and optional `auth`. The adapter reads `/contests/{id}`, `/problems`, `/teams`, `/organizations`, `/judgement-types` once and polls `/submissions` + `/judgements`. Note: when the browser talks to the judge directly, the judge must send CORS headers, or you must put a reverse proxy in front of it.

**School metadata**: `public/orgs/orgs.json` maps each school (`group`) to `{ "country": "KR", "logo": "file.png" }`. Flags come from `country`; logos live in `public/orgs/logos/`. Missing entries produce a system-message warning; run `npm run check-assets` to verify before an event.

**awards.json v2**: an array of `{ "teamId", "rank", "icon", "labels", "others" }` at `award.awardsUrl`. Manual labels show as badges in spectator/publish mode, and during the ceremony after a team is finalized.

## Deploy

`npm run build` produces a fully static `dist/`. Serve it with any HTTP server. `config.json`, `orgs/` and the sample data are plain files inside `dist/` — edit them in place to reconfigure a deployed instance; no rebuild is necessary.
