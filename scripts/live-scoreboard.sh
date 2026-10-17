#!/usr/bin/env bash
# Ad-hoc live scoreboard on S3: DOMjudge → spotboard feed (frozen) → static board.
#
#   scripts/live-scoreboard.sh deploy   # build the board once and upload it
#   scripts/live-scoreboard.sh feed     # loop: convert, check the freeze, upload the feed
#   scripts/live-scoreboard.sh once     # one feed cycle (convert, check, upload)
#   scripts/live-scoreboard.sh check    # convert and check only, no upload
#
# Credentials come from .env.local (KIMCHI_JUDGE_URL, KIMCHI_JUDGE_CRED), the
# same file the dev proxy uses. AWS uses the default profile.
#
# The freeze is never lifted here: the converter runs WITHOUT --unfreeze, and
# every feed is checked against DOMjudge's PUBLIC scoreboard (read without the
# credential) before upload. A feed that shows anything the public scoreboard
# does not stops the script with no upload. The freeze time may change: it is
# read again every cycle, and the public cross-check does not depend on it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTEST="${CONTEST:-first}"
DEST="${DEST:-s3://static.icpckorea.net/2026/preliminary/scoreboard}"
INTERVAL="${INTERVAL:-30}"
WORK="${WORK:-$ROOT/feed-out/live-$CONTEST}"

cd "$ROOT"
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
: "${KIMCHI_JUDGE_URL:?KIMCHI_JUDGE_URL is not set (.env.local)}"
: "${KIMCHI_JUDGE_CRED:?KIMCHI_JUDGE_CRED is not set (.env.local)}"
if [ "$INTERVAL" -lt 30 ]; then echo "INTERVAL must be ≥ 30 s (live judge)" >&2; exit 1; fi

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

# Freeze start in contest minutes = duration − scoreboard_freeze_duration,
# or "none" when the contest has no freeze configured (yet).
freeze_minute() {
  curl -fsS -m 15 -u "$KIMCHI_JUDGE_CRED" "$KIMCHI_JUDGE_URL/contests/$CONTEST" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = JSON.parse(s);
      const min = (t) => { const [h, m] = String(t).split(":"); return Number(h) * 60 + Number(m); };
      if (!c.scoreboard_freeze_duration) { console.log("none"); return; }
      const f = min(c.duration) - min(c.scoreboard_freeze_duration);
      if (!(f >= 0)) { console.error("bad freeze minute " + f); process.exit(1); }
      console.log(f);
    });'
}

# The public scoreboard, read WITHOUT the credential: what DOMjudge itself
# shows to everyone, with whatever freeze the jury has set.
public_scoreboard() {
  curl -fsS -m 30 "$KIMCHI_JUDGE_URL/contests/$CONTEST/scoreboard" -o "$1"
}

# Refuse the feed when it shows anything the public scoreboard does not:
#  - the converter marked it unfrozen;
#  - a run at or after the freeze minute has a result (when a freeze is set);
#  - an accepted cell that the public scoreboard does not show as solved;
#  - a cell with more judged runs than the public scoreboard counts.
# The feed is fetched BEFORE the public scoreboard, so a judgement that lands
# between the two can only make the public side larger, never the feed.
check_feed() {
  local dir="$1" public="$2" freeze="$3"
  node -e '
    const fs = require("fs");
    const [dir, publicFile, freezeArg] = process.argv.slice(1);
    const fail = (m) => { console.error("FREEZE CHECK: " + m); process.exit(2); };
    const contest = JSON.parse(fs.readFileSync(dir + "/contest.json", "utf8"));
    const feed = JSON.parse(fs.readFileSync(dir + "/runs.json", "utf8"));
    const pub = JSON.parse(fs.readFileSync(publicFile, "utf8"));
    if (feed.kimchiUnfrozen) fail("feed is marked unfrozen");
    const runs = feed.runs || [];
    const freeze = freezeArg === "none" ? null : Number(freezeArg);
    if (freeze !== null) {
      const leaks = runs.filter((r) => Number(r.submissionTime) >= freeze && r.result !== "");
      if (leaks.length > 0) fail(`${leaks.length} run(s) at minute >= ${freeze} have a result`);
    }
    const label = new Map(contest.problems.map((p) => [String(p.id), p.name]));
    const cells = new Map();
    for (const row of pub.rows || []) {
      for (const c of row.problems || []) cells.set(`${row.team_id}|${c.label}`, c);
    }
    const judged = new Map();
    const solved = new Set();
    for (const r of [...runs].sort((a, b) => a.id - b.id)) {
      // Pending, and compile errors that cost nothing (DOMjudge does not count them).
      if (r.result === "" || r.result === "No (no penalty)") continue;
      const key = `${r.team}|${label.get(String(r.problem))}`;
      if (solved.has(key)) continue; // runs after the first Yes do not count
      judged.set(key, (judged.get(key) || 0) + 1);
      if (r.result === "Yes") solved.add(key);
    }
    for (const key of solved) {
      const c = cells.get(key);
      if (!c || !c.solved) fail(`${key} is solved in the feed but not on the public scoreboard`);
    }
    for (const [key, n] of judged) {
      const c = cells.get(key);
      if (!c || n > c.num_judged) fail(`${key} has ${n} judged run(s) in the feed, public shows ${c ? c.num_judged : 0}`);
    }
    const pending = runs.filter((r) => r.result === "").length;
    console.log(`${runs.length} runs, ${pending} pending, ${solved.size} solved cells, all on the public scoreboard`);
  ' "$dir" "$public" "$freeze"
}

# Returns 0 on upload, 1 on a transient failure (nothing uploaded), 2 when the
# freeze check fails (nothing uploaded; the caller must stop). Every step is
# checked explicitly: `set -e` does not apply inside `feed_once || ...`.
# Convert and check into $WORK. Same return codes as feed_once.
build_feed() {
  local freeze
  freeze="$(freeze_minute)" || { log "could not read the freeze minute"; return 1; }
  mkdir -p "$WORK" || return 1
  rm -f "$WORK/runs.json" "$WORK/contest.json" "$WORK/public-scoreboard.json"
  npm run --silent convert -- --contest "$CONTEST" --out "$WORK" >/dev/null \
    || { log "convert failed"; return 1; }
  public_scoreboard "$WORK/public-scoreboard.json" || { log "public scoreboard fetch failed"; return 1; }
  SUMMARY="$(check_feed "$WORK" "$WORK/public-scoreboard.json" "$freeze")" || return 2
  SUMMARY="$SUMMARY (freeze minute $freeze)"
}

feed_once() {
  build_feed || return $?
  aws s3 cp --only-show-errors "$WORK/contest.json" "$DEST/contest/contest.json" \
    --content-type application/json --cache-control 'no-cache, max-age=0' || return 1
  aws s3 cp --only-show-errors "$WORK/runs.json" "$DEST/contest/runs.json" \
    --content-type application/json --cache-control 'no-cache, max-age=0' || return 1
  log "uploaded feed: $SUMMARY"
}

deploy() {
  local stage
  stage="$(mktemp -d)"
  npm run build
  cp -R dist/. "$stage/"
  rm -rf "$stage/sample"
  if find "$stage" -iname '*award*' | grep -q .; then echo "award files in the upload" >&2; exit 1; fi
  # Public board config: static spotboard feed next to the page, no credential.
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync("public/config.json", "utf8"));
    c.source = { type: "spotboard", apiBase: "./contest/" };
    c.autoRefreshInterval = 30000;
    c.showSchoolLogos = true;
    c.apac = { enabled: false };
    c.publish = { ...c.publish, enabled: false, mode: "off" };
    c.award = { ...c.award, mode: false };
    c.lockMode = true; // ?award= / ?publish= cannot switch the public page
    fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2) + "\n");
  ' "$stage/config.json"
  if grep -q '"auth"' "$stage/config.json"; then echo "config.json has auth" >&2; exit 1; fi
  aws s3 sync --only-show-errors "$stage/" "$DEST/" --exclude 'contest/*' \
    --exclude 'index.html' --exclude 'config.json' --cache-control 'max-age=300'
  for f in index.html config.json; do
    aws s3 cp --only-show-errors "$stage/$f" "$DEST/$f" --cache-control 'no-cache, max-age=0'
  done
  rm -rf "$stage"
  log "board uploaded to $DEST/"
}

run_cycle() {
  local rc=0
  feed_once || rc=$?
  if [ "$rc" -eq 2 ]; then log "FREEZE CHECK FAILED — stopped, nothing uploaded"; exit 2; fi
  return "$rc"
}

case "${1:-}" in
  deploy) deploy ;;
  once) run_cycle ;;
  check)
    rc=0; build_feed || rc=$?
    if [ "$rc" -eq 0 ]; then log "check passed: $SUMMARY (nothing uploaded)"; else log "check FAILED ($rc)"; fi
    exit "$rc"
    ;;
  feed)
    trap 'log "stopped"; exit 0' INT TERM
    while true; do
      run_cycle || log "feed cycle failed; keeping the last upload"
      sleep "$INTERVAL"
    done
    ;;
  *) echo "usage: $0 deploy | once | feed | check" >&2; exit 1 ;;
esac
