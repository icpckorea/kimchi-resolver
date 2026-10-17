# kimchi-resolver

A modern rewrite of [spotboard](https://github.com/spotboard/spotboard), the ACM-ICPC scoreboard web app. Stack: React + Vite + TypeScript, zustand for state, vitest for tests.

The app has three modes:

- **spectator** — live scoreboard with polling, autoplay run feed, events dashboard, desktop notifications.
- **award** — the award ceremony ("resolver"): frozen runs are revealed one keypress at a time, with slides, gacha effects and a finale spotlight.
- **publish** — final scoreboard for announcements in three modes (`off`, `preliminary`, `regional`). The operator prepares it in the browser, and `npm run publish -- <publish-state.json>` builds a static, credential-free `publish-dist/` folder to upload to S3 (see `docs/operations.md` §6 step 4).

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
| `publish.mode` | `"off"` | `"off"` / `"preliminary"` / `"regional"` (URL `publish_mode=` wins) |
| `publish.preliminary` | `{ totalTeams: null, topN: 30, k: null, ineligibleTeamIds: [] }` | start values of the preliminary selection |
| `publish.regional` | `{ prelimSchools, prelimTeams, coefficients, wfMedalGroups }` | start values of the regional simulation (site score `S` is computed from them) |
| `publish.invitedScoreCutoff` | `null` | invited score cutoff for the gold-star rule |
| `publish.alreadyInvited.teamIds` / `.winnerGroups` / `.invitedGroups` | `[]` | teams/schools already invited at another regional (see APAC stars); the old `.groups` key is read as `invitedGroups` |
| `award.mode` | `false` | boot into award mode |
| `award.hideName` | `true` | mask unrevealed teams as "Team {id}" |
| `award.showBalloons` | `false` | balloons on the ceremony board (the live board uses `showBalloons`) |
| `award.rankBegin` | `null` | fast-forward the ceremony to this rank |
| `award.awardsUrl` | `"./sample/awards.sample.json"` | awards.json v2 location |
| `award.revealOrder` | `[]` | problem reveal priority (labels or ids) |
| `award.focusBlinking` | `{ "minSolved": 7, "maxRank": 10 }` | blink stage condition, or null |
| `award.gachaEffectRequirement` | `8` | attempts that trigger the gacha effect |
| `award.gachaEffectForNoRatio` | `30` | gacha probability (%) for a final "No" |
| `award.finaleFlipSlowdown` | `3` | finale verdict flip = matched `slowFlip` × this |
| `award.finaleIntermediateFlipSlowdown` | `2` | finale intermediate flips = `slowFlip` × this |
| `award.animationSpeeds` | see spec §9 | flip/move speeds per solved count |

### APAC stars

With `apac.enabled` (award mode) or `publish.mode = regional` (publish), the board marks APAC Championship advancement next to the rank (per the ICPC APAC 2026-27 rules: at most 2 teams per school, 3 for a school with a World Finals medal last year, listed in `publish.regional.wfMedalGroups`):

- bronze star — In the APAC Championship list so far (ceremony only)
- silver star — Likely invited to the APAC Championship
- gold star — Invited to the APAC Championship

(the wording of the star tooltips on the board; the publish-mode legend keeps the Korean phrasing)

During the ceremony, an `alreadyInvited.teamIds` team is gold and every team in the **scored list** of the current snapshot wears bronze; every other team has no star. The champion is not known yet, so it is not applied. Once the final standings are known (ceremony fully revealed, or publish mode), the scored list decides the colors. It is built like this (validated against the 58 published rows of 2025-26 Seoul at icpcapac.solved.ac/2026):

1. a school that **already has an invited team drops out entirely** — every one of its teams. The route does not matter: this regional's champion (auto-qualified) counts the same as a team invited at another regional. The invited team itself is still shown, but takes no rank slot;
2. teams with **0 solved problems** are excluded;
3. of what remains, each school keeps its **top 2** (**top 3** for a WF medal school) in ICPC standing order; teams from AU and NZ (super-region) are removed first. `filteredRank` is the 1-based position in that list; foreign teams occupy slots normally, since the per-school cap is per site.

Star colors follow from it:

- every **invited** team is gold — the champion, plus anyone listed in `publish.alreadyInvited`;
- teams in the scored list are silver, and a silver team is promoted to gold when `(filteredRank − 1) / S ≤ cutoff`, where the site score `S = 0.56·U_r + 0.24·T_r + 0.14·U_p + 0.06·T_p + 0.30·F_r` is computed from the standings and the preliminary counts (the coefficients are config values) (publish `regional` mode; the cutoff is an assumed value);
- every other team has no star — the other teams of an already-invited school, 0-solve teams, teams over the school quota, and AU/NZ teams. There is no bronze star after the final standings are known.

"Already invited at another regional" cannot be derived from the contest data, so it comes from `publish.alreadyInvited` (`teamIds` for invited teams competing here, `winnerGroups` and `invitedGroups` for the school names) and is editable in the publish controls. While both lists are empty only the champion's school drops out, so the ranks may be optimistic — the publish controls say so.

### URL parameters

URL parameters override `config.json` (spec §9/§13):

| Parameter | Meaning |
|---|---|
| `r=<run id>` | replay runs up to this run id without animation (award: the freeze cutoff). Compared against the run's `seq`: that is the run id for the spotboard source, but a 1-based ordinal in `/submissions` order for contest-api — on contest-api prefer `time=` |
| `time=<minute>` | replay runs up to this contest minute; forces autoplay off |
| `award=true` | award mode |
| `award_rank_begin=<n>` | fast-forward the ceremony to rank n |
| `animation=false` | disable animations |
| `q=<text>` | initial team search (substring match over name + school) |
| `t=<team id>` | follow this team (highlight + sticky row) |
| `publish=true` | publish mode (wins over award) |
| `publish_mode=<mode>` | publish: `off` / `preliminary` / `regional` |
| `invited_cutoff=<x>` | publish: invited score cutoff |

Example: `index.html?award=true&r=1000` starts the ceremony with runs after id 1000 frozen.

## Data sources

**spotboard JSON** (default): put `contest.json` and `runs.json` where `source.apiBase` points. The bundled `public/sample/` contains the 2025 ICPC Asia Seoul Regional sample (84 teams, 13 problems, 1,227 runs) so the app works offline out of the box.

**ICPC Contest API** (DOMjudge/CDS): set `source.type` to `"contest-api"`, plus `baseUrl` (the API **root**, e.g. `https://judge.example.org/api/v4` — the adapter appends `/contests/{contestId}` itself), `contestId` and optional `auth`. At boot the adapter reads `/contests/{id}/access` first, then `/contests/{id}`, `/problems`, `/teams?public=true`, `/organizations`, `/judgement-types`; each poll reads `/submissions` + `/judgements` + `/state`. None of these endpoints paginate, so each poll re-reads the full list.

Data the adapter derives from that feed, and the rules it follows:

- **Access**: the boot `/access` read decides whether this account may see `judgements` at all. If not, the app refuses to start with an error naming `api_reader` instead of showing a board that can never leave pending. An `/access` endpoint that is missing entirely only warns. At runtime, "submissions from many teams but judgements from at most one" — the shape of a team-filtered token — raises a one-off warning as an on-screen system message.
- **Clock and end of feed** come from `/state`: elapsed time is now − `started` clamped to `[0, duration]` (`--:--` before the start, stopped at the end), corrected by the judge's `Date` header rather than the local clock, and `end_of_updates != null` stops polling and finalizes the header. A judge without `/state` degrades to `start_time` + local clock and never self-terminates; it is never a poll failure.
- **Teams**: `?public=true` plus a `hidden` check keeps jury/test teams — and their submissions — off the board. Your `api_reader` token would otherwise see them.
- **School** (`group`, which drives `schoolRank` and the per-school quota of the APAC scored list): organization `formal_name` → organization `name` → the team's own `affiliation` string. Only a team with none of those gets the empty group, which means "no school" — never a shared bucket.
- **Country**: organization `country` → team `nationality`, both ISO 3166-1 alpha-3 (alpha-2 accepted, common IOC codes aliased); `orgs.json` overrides both. An unresolvable code yields **no flag** and a warning rather than a guessed one.
- **Verdicts**: a judgement type missing from the snapshot taken at load is scored as a penalized rejection with a warning, not left pending forever. Among several judgements the adapter skips `valid: false` (superseded by a rejudging) and takes the greatest `end_contest_time`, then the greatest id — never array order.

Three things will bite you on contest day. **Read [docs/operations.md](docs/operations.md) before running this on a real judge.**

- **An `api_reader` account is mandatory.** `/submissions` is ungated, but `/judgements` is role-gated and filtered to the caller's own team below `api_reader`. An under-privileged token gives a board that looks alive with every verdict stuck on pending.
- **DOMjudge does not apply the scoreboard freeze to `/judgements`** (its `JudgementController` has no freeze logic; filtering is role-based only). Any deployment holding an `api_reader` credential reads real frozen verdicts mid-contest, so it must not be public. `r=`/`time=` bound the boot replay only — they are not a freeze.
- **CORS**: DOMjudge sends no CORS headers. Put a same-origin reverse proxy in front of it; that also keeps the credential out of the world-readable `config.json`.

**School metadata**: `public/orgs/orgs.json` maps each school (`group`) to `{ "country": "KR", "logo": "file.png" }`. Flags come from `country`; logos live in `public/orgs/logos/`. Missing entries produce a system-message warning; run `npm run check-assets` to verify before an event.

**awards.json v2**: an array of `{ "teamId", "rank", "icon", "labels", "others" }` at `award.awardsUrl`. Manual labels show as badges in spectator/publish mode, and during the ceremony after a team is finalized.

## Deploy

`npm run build` produces a fully static `dist/`. Serve it with any HTTP server. `config.json`, `orgs/` and the sample data are plain files inside `dist/` — edit them in place to reconfigure a deployed instance; no rebuild is necessary.

`config.json` is served to every visitor, so never put judge credentials in `source.auth` on a public host — inject the `Authorization` header in the reverse proxy instead.

## Running a real contest

[docs/operations.md](docs/operations.md) is the contest-day run book: the pre-flight `curl` checks against the judge, `api_reader` account setup, the freeze security warning, CORS/reverse-proxy config, the freeze-cutoff choice, the team/school/country data checks, and a troubleshooting table.

## Shoutouts

- Spotboard was truly awesome. We, the ICPC Seoul Regional Tech Committee, used it for more than 13 years. All of us on the committee deeply appreciate the original Spotboard authors and contributors for their every commit and effort.
  - [@wookayin](https://github.com/wookayin)
  - [@beingryu](https://github.com/beingryu)
  - [@myungwoo](https://github.com/myungwoo)
  - And the Algospot community
