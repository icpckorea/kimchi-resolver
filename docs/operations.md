# Operator run book — kimchi-resolver on DOMjudge

For the person who runs the scoreboard and the award ceremony on contest day.
Command-first. Do the pre-flight check at least one day before the contest, and
again 60 minutes before the freeze.

Payload shapes below come from the DOMjudge 9.0.0 OpenAPI document and its
controller source, not from a captured response.

Set these once per shell:

```sh
JUDGE=https://judge.example.org
CID=seoul2026          # contest id, as it appears in /api/v4/contests
CRED=kimchi:PASSWORD   # the api_reader account, see "Account setup"
```

---

## 1. Pre-flight check

Run all four. Every one must pass. If check A fails, the board never shows a
verdict, and the award ceremony has nothing to reveal.

### A. Judgements — the one that matters

```sh
curl -u "$CRED" "$JUDGE/api/v4/contests/$CID/judgements" | head -c 500
```

| Result | Meaning |
|---|---|
| A JSON array with many objects, each with `submission_id` and `judgement_type_id` | **PASS** |
| `401` or `403` | **FAIL** — the account is missing, or it does not have `api_reader`. |
| `200` with `[]` while the contest already has judged submissions | **FAIL** — the account is below `api_reader`. |
| `200` but the rows are all from one team | **FAIL** — DOMjudge filters judgements to the caller's own team below `api_reader`. |

Count the rows and compare them against the submission count:

```sh
curl -su "$CRED" "$JUDGE/api/v4/contests/$CID/judgements"  | jq 'length'
curl -su "$CRED" "$JUDGE/api/v4/contests/$CID/submissions" | jq 'length'
```

The judgement count must be of the same order as the submission count. It may
legitimately **exceed** it — a rejudging adds another judging row per
submission. What it must never be is 0, 1, or "the number of my own team's
submissions": that is the team-filtered failure mode.

Confirm the coverage rather than the raw counts:

```sh
diff <(curl -su "$CRED" "$JUDGE/api/v4/contests/$CID/submissions" | jq -r '.[].id' | sort -u) \
     <(curl -su "$CRED" "$JUDGE/api/v4/contests/$CID/judgements"  | jq -r '.[].submission_id' | sort -u)
```

Lines marked `<` are submissions with no judgement. A handful is normal (still
judging). Hundreds, or all of them, means the token is under-privileged.

Why this is fatal: the adapter maps "no judgement for this submission" to the
`pending` verdict. Every cell then stays `?` forever, on the live board and in
the ceremony.

### B. Access — what this token may read

```sh
curl -u "$CRED" "$JUDGE/api/v4/contests/$CID/access"
```

Expect `200` and an object with `capabilities` and `endpoints`. **PASS** when
`endpoints` contains an entry whose `type` is `judgements`. A `404` or `403`
means the token cannot see the contest at all.

```sh
curl -su "$CRED" "$JUDGE/api/v4/contests/$CID/access" | jq '[.endpoints[].type]'
```

The list must contain `contests`, `problems`, `teams`, `organizations`,
`judgement-types`, `submissions`, and `judgements`. The adapter reads all seven.
Boot only *hard-fails* on a missing `submissions` or `judgements` — the other
five produce a normal request error instead, so check the whole list here.

### C. State — is the contest where you think it is

```sh
curl -u "$CRED" "$JUDGE/api/v4/contests/$CID/state"
```

Expect `200` and an object of nullable timestamps: `started`, `ended`, `frozen`,
`thawed`, `finalized`, `end_of_updates`. `started: null` before the start.
`frozen` becomes a timestamp at the freeze. Use it to confirm you are pointed at
the real contest and not last year's copy.

### D. Submissions — the run feed

```sh
curl -u "$CRED" "$JUDGE/api/v4/contests/$CID/submissions" | head -c 500
```

Expect a JSON array, each object with `id`, `team_id`, `problem_id`, and
`contest_time` (`"H:MM:SS.mmm"`). **PASS** on `200` with a non-empty array once
the contest is running.

This endpoint is not role-gated. It answers for anonymous callers on a public
contest. **A passing check D therefore proves nothing about check A** — do not
skip A because D worked.

### Notes that apply to all four

- **No pagination.** None of these endpoints paginate. One request returns the
  full list, and the adapter re-reads the whole list on every poll.
- **Submissions come back ordered by `submitid`.** The adapter's first-seen
  `seq` counter is therefore stable across polls and across page reloads.

### What the app checks by itself

The adapter runs the machine-checkable half of this pre-flight on every boot.
It is a backstop, not a replacement — run the curl checks anyway, because they
tell you *before* the audience is in the room.

| When | What it does |
|---|---|
| Boot | Reads `/access` **first**, before any other endpoint. If `endpoints` lists no `judgements` (or no `submissions`), it refuses to start and shows an error naming `api_reader` and where to set it. |
| Boot | An unreachable `/access` (404/403 — old CDS builds have none) is **not** fatal: it warns and continues. |
| Every poll | Compares the teams that submitted with the teams that have judgements. Submissions from several teams plus judgements from at most one raises the team-filtered warning **once**. This catches a token that passed the boot check but is filtered anyway. It waits for a handful of submissions first, so the opening minutes — where only the earliest run is judged — do not trip it. |
| Every poll | Reads `/state` for the contest clock and for `end_of_updates`. |

Where those warnings go: the boot failure is a red system message on screen, and
so is every poll-time warning — the app wires the adapter's diagnostics into the
on-screen system messages. Each distinct warning is shown once, so a five-hour
run cannot bury the screen. When no page is open (a headless check), the same
text goes to the browser console as `[kimchi-resolver] …`.

### C2. The clock and the end of the feed

Both come from `/state` (check C), not from the run list.

- **Header clock** = now − `started`, clamped to `[0, duration]`. `started: null`
  → the header shows `--:--`, which is correct before the start. A finished
  contest stops at `duration` instead of counting on. If `/state` is
  unreachable, the clock falls back to the contest's `start_time` plus the local
  clock and the poll still succeeds.
- The clock follows the **judge's** `Date` response header, not the operator
  laptop's clock. A machine with a wrong time still shows the right contest time.
- **`end_of_updates`** (non-null = "the very last change in this contest") stops
  polling and switches the header to its final state. DOMjudge sets it after
  finalization. Until then the board keeps polling — `ended` and `finalized`
  alone do **not** stop it, by design: verdicts can still change during
  finalization.

If you need the board to stop at a known moment and the judge will not set
`end_of_updates`, just stop refreshing the page; there is no config flag for it.

---

## 2. Account setup — `api_reader` is mandatory

Create a dedicated account in DOMjudge (Jury → Users → Add user) and give it the
**`api_reader`** role. Do not reuse a team account, and do not rely on anonymous
access.

Reason: the two endpoints the board polls are gated differently.

| Endpoint | Gate |
|---|---|
| `/submissions` | Ungated. Anonymous callers get the full list on a public contest. |
| `/judgements` | Role-gated. Below `api_reader`, DOMjudge filters the rows to the caller's own team. |

So an under-privileged token produces a board that looks alive — teams, problems,
and attempts all appear — while every verdict stays pending. The failure is
silent and it is easy to miss until the ceremony starts.

Give the account read access only. It never needs `jury` or `admin`.

---

## 3. Security warning — the freeze does NOT hide judgements

**DOMjudge does not apply the scoreboard freeze to the `/judgements` endpoint.**
Its `JudgementController` contains no freeze logic at all; the only filtering is
role-based. A caller holding an `api_reader` token reads real verdicts for
frozen submissions, at any time, while the contest is still running.

Two consequences:

1. **Any deployment that holds the `api_reader` credential must not be public
   during the contest.** It is a spoiler feed.
2. **`r=` and `time=` are not a freeze.** In spectator mode the cutoff applies to
   the boot replay only. Polling continues afterwards and applies every later run,
   frozen or not. The cutoff also masks nothing at the network layer: the real
   verdicts are already in the browser, one devtools tab away, even in award mode.

### The safe pattern: two deployments

| | Public board (audience, stream, anyone with the URL) | Operator / award build |
|---|---|---|
| Runs during the contest | yes | no — bring it up after the contest ends |
| `api_reader` credential | **never** | yes |
| Host | public web host | operator's laptop (`npm run preview`, localhost) or an IP-restricted host |
| Purpose | live standings for the audience | freeze reveal, award ceremony, publish board |

During the freeze, point the audience at **DOMjudge's own public scoreboard**.
That one does apply the freeze. kimchi-resolver's job starts when the contest
ends.

If you must serve a kimchi-resolver board publicly mid-contest, serve it without
any credential and accept that all cells read pending — there is no third option
that both shows verdicts and honours the freeze.

### Never ship credentials in `config.json`

`public/config.json` is a static file. It is served to every visitor, so
`source.auth` in it is a world-readable password. Put the credential in the
reverse proxy instead (see §5) and leave `source.auth` as `null`.

---

## 4. `verification_required`

If DOMjudge runs with **`verification_required`** enabled (Jury →
Configuration), a judging is not exposed until a jury member verifies it.
Verdicts then lag behind the judge's actual results by however long the jury
queue takes.

Check it before the contest, and confirm with the head judge that verification
keeps up. Symptom on the board: submissions appear on time, verdicts arrive
minutes late in bursts.

If the ceremony is about to start and unverified judgements remain, the affected
cells reveal as pending. Ask the jury to clear the verification queue before you
open the award build.

---

## 5. Deployment

### CORS / reverse proxy

DOMjudge does not send CORS headers. A browser-direct connection from another
origin fails at the preflight. **Use a same-origin reverse proxy.** It removes
CORS entirely and keeps the credential off the client.

nginx, serving the built `dist/` and the API from one origin:

```nginx
server {
    server_name board.example.org;

    root /srv/kimchi-resolver/dist;
    location / { try_files $uri $uri/ /index.html; }

    location /judge-api/ {
        # Credential lives here, not in config.json.
        # Value: printf 'kimchi:PASSWORD' | base64
        proxy_set_header Authorization "Basic BASE64_OF_USER_COLON_PASSWORD";
        proxy_set_header Host judge.example.org;
        proxy_pass https://judge.example.org/api/v4/;

        limit_except GET { deny all; }   # read-only
        allow 10.0.0.0/8;                # operator network only
        deny  all;
    }
}
```

Then `source.baseUrl` is `"/judge-api"` and `source.auth` is `null`.

Only if a proxy is impossible: enable CORS on the judge's own vhost. The
`Authorization` header makes every request non-simple, so the proxy must answer
the `OPTIONS` preflight itself with `204` — DOMjudge would answer it with `401`.

```nginx
location /api/ {
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin  "https://board.example.org";
        add_header Access-Control-Allow-Headers "Authorization";
        add_header Access-Control-Max-Age       86400;
        return 204;
    }
    add_header Access-Control-Allow-Origin "https://board.example.org" always;
    proxy_pass http://domjudge;
}
```

This variant puts the credential back in `config.json`. Use it for an operator
laptop only, never for a public host.

### `config.json` for a Contest API source

```jsonc
{
  "source": {
    "type": "contest-api",
    "baseUrl": "/judge-api",   // API root; must include /api/v4 when not proxied
    "contestId": "seoul2026",
    "auth": null,              // null when the proxy injects Authorization
    "eventsWs": null
  },
  "fetchTimeout": 5000,
  "autoRefreshInterval": 10000
}
```

`baseUrl` is the API **root**, not the contest path. The adapter appends
`/contests/{contestId}` itself. Direct (unproxied) form:
`"https://judge.example.org/api/v4"`.

Raise `fetchTimeout` to `15000` for a large contest. The adapter re-reads the
full submission and judgement lists on every poll, so `autoRefreshInterval`
below 10 s puts real load on the judge.

Run `npm run check-assets` before the event to catch schools missing from
`public/orgs/orgs.json`.

### DOMjudge → spotboard converter

`npm run convert` replaces `spotboard/domjudge-converter`. It reads the DOMjudge
Contest API with this repo's own adapter and writes the spotboard files
`contest.json` and `runs.json`. A `spotboard` source (or the original
Spotboard) serves that folder as static files, with no credential.

```sh
npm run convert -- --contest seoul2026                      # once, into feed-out/
npm run convert -- --contest seoul2026 --interval 30        # every 30 s until Ctrl-C
npm run convert -- --contest seoul2026 --out /srv/feed      # another folder
```

| Option | Meaning |
|---|---|
| `--contest <id>` | Required. The DOMjudge contest id. |
| `--out <dir>` | Output folder. Default `feed-out/` (git-ignored). |
| `--interval <s>` | Poll every `s` seconds. Minimum 10, maximum 2147483; a value outside this range is refused. Without it the script runs once. |
| `--unfreeze` | Keep the real results of frozen runs. Default off. |
| `--url <api root>` | Judge API root (with `/api/v4`). Default: `KIMCHI_JUDGE_URL`. It must not contain a user name or password. |

The judge URL and the credential come from `KIMCHI_JUDGE_URL` and
`KIMCHI_JUDGE_CRED` (`user:password`, an `api_reader` account, see §2). The
script reads `process.env` first, then the git-ignored `.env.local` in the repo
root:

```sh
# .env.local
KIMCHI_JUDGE_URL=https://judge.example.org/api/v4
KIMCHI_JUDGE_CRED=kimchi:PASSWORD
```

The script never prints the credential and never writes it to a file. Files
are written to a temp file first and then renamed, so a reader never gets half
a file. A failed poll prints one error line and keeps the last good files. The
`seq` of each run stays stable between polls, because the script passes the
adapter cursor from poll to poll. Teams and problems are reloaded every 10
polls.

**Freeze.** Like the original converter, a run at or after the freeze minute
(contest duration minus `scoreboard_freeze_duration`) is written as pending.
The mask ends when DOMjudge thaws or finalizes the contest (`/state` `thawed`
or `finalized`). If the freeze time cannot be read, or `/state` fails, the
script keeps the mask. It never falls back to real results. The script stops by
itself when the judge sets `end_of_updates`, but not while the mask still
holds: then it keeps polling (and writes `noMoreUpdate: false`) until the thaw.
A bad contest reload after the first good poll is logged, and the old contest
and freeze time stay in use.

**Results.** The feed has no judge text, so it carries `Yes`, `No` and
`No (no penalty)` (compile error) only. The spotboard source reads these back
to the same verdict and the same penalty. Country and foreign flags are not in
the feed; the board takes them from `orgs.json`.

**Never use `--unfreeze` for a folder that anyone can read.** The output then
holds the real verdicts of the freeze. The script refuses `--unfreeze` with an
`--out` inside `public/` (the build copies `public/` into `dist/`), `dist/` or
`publish-dist/` (uploaded by hand). Case does not matter. It also marks the
file with `"kimchiUnfrozen": true`. `npm run build` fails when a `runs.json`
with that marker is under `public/`, `dist/` or `publish-dist/`, and
`npm run publish` fails its output scan for it. These checks do not cover
other places: an S3 bucket, a shared folder or a web root outside the repo are
your responsibility.

### Dev server proxy

For local work, the dev server (`npm run dev`) already has two helpers. Both
read the git-ignored `.env.local` and `config.local.json`; neither is ever
built into `dist/`.

- `.env.local` with `KIMCHI_JUDGE_URL` and `KIMCHI_JUDGE_CRED` makes the dev
  server proxy `/judge-api` to the judge, with the credential added on the
  server side. The proxy is read-only (GET and HEAD). Set `source.baseUrl` to
  `"/judge-api"` in your config.
- `config.local.json` in the repo root is served as `/config.json` by the dev
  server when it exists. Your local judge connection stays out of the tracked
  `public/config.json`.

(See `vite.config.ts`.) `npm run convert` reads the same two variables.

---

## 6. Day-of workflow

### Step 1 — pick the freeze cutoff

Get the freeze minute from the judge:

```sh
curl -su "$CRED" "$JUDGE/api/v4/contests/$CID" \
  | jq '{duration, scoreboard_freeze_duration}'
```

`duration: "5:00:00"` with `scoreboard_freeze_duration: "1:00:00"` means the
freeze starts at contest minute **240**.

**With a Contest API source, use `time=`, not `r=`.**

```
index.html?award=true&time=239
```

`time=` is inclusive, so pass `freezeMinute − 1`: `time=239` shows every run up
to 3:59:59 and freezes minute 240 onward.

Why not `r=`: `r=` is compared against the run's `seq`, and for the Contest API
adapter `seq` is an adapter-assigned 1-based ordinal in `/submissions` order —
**not** the DOMjudge submission id. Passing a submission id as `r=` silently
cuts at the wrong place. `r=` matches the run id only for the spotboard JSON
source, where `seq` is the run id.

If you do need `r=` on a Contest API source, compute the ordinal:

```sh
curl -su "$CRED" "$JUDGE/api/v4/contests/$CID/submissions" \
  | jq '[.[] | select(.contest_time < "4:00:00")] | length'
```

Use that count as `r=`.

### Step 2 — verify the cutoff before the audience arrives

Open the award URL and check three things:

1. **No warning** reading "The award ceremony has nothing to reveal". That
   warning means the cutoff is at or after the last submission — the number is
   wrong.
2. Frozen cells show `?` with the full attempt count.
3. Pre-freeze cells show real verdicts. If they are all `?`, go back to §1 check A.

Do this dry run on the real judge data, with the projector, before the ceremony.

### Step 3 — run the ceremony

Full-screen the browser. Drive it with **PageDown only** — a projector remote has
no Escape key, and PageDown alone covers the whole ceremony. While a slide is up,
the next PageDown closes the slide; the one after that advances. That two-step is
deliberate misclick protection.

| Key | Action |
|---|---|
| PageDown / Enter / → / `;` | advance |
| Escape | dismiss slide (optional, keyboard only) |
| PageUp | nothing (deliberate no-op — a stray back-press cannot rewind) |

To restart mid-ceremony without replaying everything, add
`award_rank_begin=<n>`; it fast-forwards to rank *n* with no animation.

Click a finalized team's name to show its award slide again.

### Step 4 — publish board

The publish board is a **static folder** that you upload to S3 yourself. The
public page never calls the judge, and it holds no `config.json`, no
`awards.json` and no credential. Design: `docs/superpowers/specs/2026-10-16-publish-modes-design.md`.

Pick one mode (config `publish.mode`, or URL `publish_mode=`; the URL wins):

| Mode | Use it for | Prepare page | Public page |
|---|---|---|---|
| `off` (default) | final standings only | board and the save button | board only |
| `preliminary` | the preliminary result notice | T, N, K inputs, an "미자격" checkbox on each row, yellow rows for the selected teams | board with yellow rows; the saved selection is shown as is |
| `regional` | the APAC simulation for students | site score inputs, school pickers, cutoff, stars and values | board with stars and values, and a panel where a student can change the inputs (not saved) |

Day-of flow:

1. On the **operator build** (the one with the judge credential — never public),
   open `index.html?publish=true&publish_mode=<mode>`. The board shows at once;
   there is no site score gate.
2. Check and change the inputs. They are kept in this browser's `localStorage`,
   under a key made of the mode, the contest and its title. A stored value wins
   over `config.json` and the URL. The page then says "저장된 값을 사용 중";
   press "config 값으로 되돌리기" to drop it.
3. Press **확정 결과 저장**. Read the confirm dialog (inputs and result), then
   confirm. The browser downloads `publish-state.json`.
4. Run `npm run publish -- <path to publish-state.json>` (optional: `--out <folder>`).
   The command refuses a file with a wrong or old `schemaVersion`, a hand-edited
   file, or a file that does not fit its mode, and prints the path of the bad field
   (for example `publish-state.schemaVersion`).
5. Upload the whole `publish-dist/` folder to S3. Open the S3 URL once and check
   it. (`file://` does not work: browsers block module scripts there.)

Local check before the upload: `npx vite preview --outDir publish-dist`.

`npm run publish` scans every file it wrote. It fails when a file is named
`config.json` or `awards.json`, when a file holds a `source.auth` user name or
password or the `source.baseUrl` from `public/config.json`, or when a script
holds Contest API code. Logos of the schools on the board are copied to
`orgs/logos/` when `showSchoolLogos` is on; a missing logo file is a warning.
Team names and `awards.json` titles that are in the final standings are public.

Regional mode inputs (prepare page; the saved values are the starting values on
the public page):

- **Preliminary school and team counts** (U_p, T_p). The site score is computed:
  `S = 0.56·U_r + 0.24·T_r + 0.14·U_p + 0.06·T_p + 0.30·F_r`. U_r, T_r and F_r are
  counted from the standings (only teams with 1 or more solved problems); you can
  overwrite them. The coefficients are in the "고급" fold. `publish.siteScore` and
  the URL `site_score` are **gone**.
- **WF medal schools** (3 teams per school). Every other school has 2 teams.
- **Other regionals' winner schools** and **schools invited by another path**.
  Their whole school drops out of the scored list. This site's champion is handled
  automatically. `publish.alreadyInvited.teamIds` (config only) names invited teams
  that compete here; the old `alreadyInvited.groups` key is read as `invitedGroups`.
- **Assumed cutoff** (`invited_cutoff` or `publish.invitedScoreCutoff` sets the
  start value). Silver stars with `(R − 1) / S ≤ cutoff` become gold.
- Teams from AU and NZ (super-region) are not in the scored list. They still count in S.

While the winner and invited lists are empty, only the champion's school drops
out, so the stars may be optimistic. The page says so on screen.

Preliminary mode: set T (teams that advance) and K (the least solved problems of a
school's best team); N defaults to 30. Rule: top N teams (any school), then the best
team of each school that has no selected team, if it solved K or more, then the next
teams in standings order up to T. The page warns when the selection is more than T
and when teams tie at the N or T boundary. It never breaks a tie for you. Mark a team
"미자격" to remove it from the selection; it stays on the board at 50% opacity, with
no label, on the public page.

---

## 7. Team, school and country data

Everything here is decided once, at contest load. Check it the day before —
these are the mistakes the audience spots instantly.

### Jury and test teams must not reach the board

The adapter requests `/teams?public=true` ("Only show visible teams, even for
users with more permissions") and additionally drops any team whose `hidden`
flag is `true`. That second filter matters because your token *is* an account
with more permissions: an `api_reader` reading plain `/teams` gets the jury,
test and system teams back, and they land on the scoreboard.

Verify what the board will show:

```sh
# how many teams DOMjudge considers public
curl -s -u "$CRED" "$JUDGE/api/v4/contests/$CID/teams?public=true" \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'

# how many it shows YOUR token — a larger number means hidden teams exist
curl -s -u "$CRED" "$JUDGE/api/v4/contests/$CID/teams" \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'
```

The two numbers should match the registered team count. If they differ, the
extras are jury/test teams and the adapter drops them (with a warning).

Runs of a dropped team are discarded from the feed as well, so a jury test
submission never appears in the dashboard or the ceremony.

### Every team needs a school, or it has none at all

The school (`group`) decides which teams share one school quota in the APAC
scored list, and so which teams get an APAC star. The adapter resolves it in this order:

1. the linked organization's `formal_name`,
2. the linked organization's `name`,
3. the team's own `affiliation` string (DOMjudge keeps this even when
   `organization_id` is null),
4. otherwise the empty string — "no school".

`organization_id` is nullable in DOMjudge, so step 3 is what keeps two
unrelated org-less teams from being ranked *against each other* as if they
attended the same school. The empty string is never a school: a team with no
affiliation gets no school rank and no APAC star.

Find them before the contest — the adapter also warns at load, listing the ids:

```sh
curl -s -u "$CRED" "$JUDGE/api/v4/contests/$CID/teams?public=true" | python3 -c '
import json,sys
teams = json.load(sys.stdin)
bad = [t["id"] for t in teams if not t.get("organization_id") and not (t.get("affiliation") or "").strip()]
print("teams with no organization and no affiliation:", bad or "none")'
```

Fix them in DOMjudge (give the team an affiliation) rather than in the config.

### Country codes must be ISO 3166-1

Flags come from `organization.country` or, failing that, the team's
`nationality` — both **ISO 3166-1 alpha-3** (alpha-2 is accepted too).
`public/orgs/orgs.json` overrides both, keyed by school name.

A code the adapter cannot resolve produces **no flag** and a one-time warning.
It never guesses: the old truncate-to-two-letters shortcut turned `BGD` into
Bulgaria's flag, `BRN` into Brazil's and `MAC` into Morocco's. Three of the
codes an Asia regional actually uses.

The common data-entry traps, all of which the adapter now handles or rejects
loudly rather than mis-flagging:

| In DOMjudge | Meaning | Result |
|---|---|---|
| `BGD` / `BRN` / `MAC` | Bangladesh / Brunei / Macao | 🇧🇩 / 🇧🇳 / 🇲🇴 — correct |
| `TPE`, `INA`, `SIN`, `GER`, … | IOC codes, not ISO | accepted as an alias |
| `BRN` meaning Bahrain | IOC use of an ISO code | resolves as **Brunei** — use `BHR` |
| `ROK`, `UK`, a country name | not a code at all | no flag + warning |

Check the whole contest in one command:

```sh
curl -s -u "$CRED" "$JUDGE/api/v4/contests/$CID/organizations" | python3 -c '
import json,sys
print(sorted({(o.get("country") or "-") for o in json.load(sys.stdin)}))'
```

`foreign` (which suppresses the domestic rank) is derived from the resolved
country being something other than `KR`. A team with no resolvable country
counts as domestic — so an unresolved code silently adds a team to the national
ranking. Fix the warnings before the contest starts.

### Verdicts: unknown types and rejudging

`/judgement-types` is read **once**, at load. If the jury adds a judgement type
mid-contest, the adapter has never seen it. Such a run is scored as a
**penalized rejection** and a warning names the type — it is not left pending,
because a stuck-pending cell looks exactly like a working board and quietly
understates the team's penalty. Reload the page to pick up the real flags.

When a submission has several judgements the adapter ignores every judging
marked `valid: false` (DOMjudge sets that on the judging a rejudging replaces)
and takes the one with the greatest `end_contest_time`, falling back to the
greatest id. Array order is never used — CCS does not guarantee it. A rejudging
that is still running therefore puts the cell back to pending, which is the
truthful display while the jury is re-judging.

---

## 8. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Every cell is `?`, teams and attempts look right | The token lacks `api_reader`; judgements are empty or team-filtered | §1 check A — compare judgement count with submission count; the on-screen system messages also carry the "filtered to a single team" warning |
| Warning: "submissions reference team X, which was absent from /teams" | Expected for jury/test submissions: `?public=true` hides those teams, so their runs arrive with no matching team | Harmless — the run is dropped from the standings. Only investigate when X is a real competing team |
| Boot fails with "Contest API access denied … api_reader" | `/access` does not grant this account `judgements` | §1 check B, then §2 — give the user the `api_reader` role |
| Header clock stuck on `--:--` | `/state` reports `started: null` (contest not started), or the contest has no `start_time` | §1 check C — `curl … /state` |
| Header clock frozen at exactly the contest duration | Correct: the contest is over, the clock stops at `duration` | §1 check C — `ended` is set |
| Board keeps polling after the contest is finalized | `end_of_updates` is still null; `ended`/`finalized` alone do not stop the feed | §1 check C — ask the jury to finalize, or stop refreshing |
| Console warns "GET …/state is unavailable" | CDS/DOMjudge build without `/state` | Harmless: the clock falls back to `start_time`, but the feed never self-terminates |
| Jury or test teams appear on the board | A `hidden` team the server returned anyway | §7 — compare the two team counts |
| Many unrelated teams share one school rank / wrong APAC stars | Teams with no organization **and** no affiliation | §7 — the org-less team query |
| A team shows the wrong flag, or none | Country is not an ISO 3166-1 code | §7 — the organizations country query; check the load warnings |
| A foreign team appears in the domestic ranking | Its country did not resolve, so it counted as domestic | §7 — same check, or set `foreign.ids` in `config.json` |
| A cell shows a red failure the jury never gave | A judgement type added after page load | Reload the page; the warning names the type |
| A solved cell went back to pending | A rejudging is in flight for that submission | Jury → the submission; the cell settles when judging ends |
| Board is empty, "Loading the contest failed" | Wrong `baseUrl` (missing `/api/v4`) or wrong `contestId` | `curl -u "$CRED" "$JUDGE/api/v4/contests/$CID"` |
| Board empty, browser console shows a CORS error | No reverse proxy, and DOMjudge sends no CORS headers | Network tab: the failing request is `OPTIONS` |
| Verdicts arrive minutes late, in bursts | `verification_required` is on and the jury queue is behind | Jury → Configuration; ask the head judge |
| Ceremony warns "nothing to reveal" | Cutoff is at or after the last submission | §6 step 1 — recompute the freeze minute |
| Ceremony reveals far too many teams | `r=` was set to a submission id on a Contest API source | Use `time=<freezeMinute − 1>` instead |
| Frozen cells show real verdicts on the live board | Spectator polling passed the cutoff — `r=`/`time=` bound the boot replay only | §3 — this build must not be public |
| Publish prepare page shows no inputs and no stars | `publish.mode` is `off` (the default) | Add `publish_mode=preliminary` or `publish_mode=regional`, or set `publish.mode` |
| Prepare page shows old numbers after a config change | A stored value wins ("저장된 값을 사용 중") | Press "config 값으로 되돌리기" |
| "확정 결과 저장" is disabled | Preliminary mode with T or K empty | Fill in T and K |
| `npm run publish` prints `publish-state.schemaVersion` or another `publish-state.<field>` | The file is from an older build, was edited, or is from another mode | Save it again from the prepare page; do not edit the file |
| `npm run publish` says the safety scan failed | The output holds a credential, the judge URL, `config.json`, `awards.json` or feed code | Read the file name in the message; do not upload the folder |
| Some schools have no flag or logo | Missing `public/orgs/orgs.json` entry | `npm run check-assets` |
| Poll is slow, judge under load | Full list re-read each poll | Raise `autoRefreshInterval`, raise `fetchTimeout` |
| A keypress does nothing during the ceremony | A reveal animation is running (busy latch) | Wait for the flip to finish, then press again |
