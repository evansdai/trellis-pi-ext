#!/usr/bin/env bash
#
# composed-candidate.sh — Phase 2 proof for @evansdai/trellis-pi-ext.
#
# Runs the disposable composed-candidate gates in separate PI_CODING_AGENT_DIR
# profiles (offline, no live mutation):
#   A. fork package install from absolute local path + immutable loopback HTTP
#      Git source: install/list/headless-start (reconcile marker proves the
#      extension loaded)/remove, exactly one source listed.
#   B. composed jiti load (fork + fleet-core + @gotgenes/pi-subagents) with a
#      recording fake pi: exactly one trellis_subagent, one fleet command, no
#      ctrl+s, before_agent_start present; two-tier agent resolution from a
#      mimic project.
#   C. max_turns gate: the old generated ext lacks maxTurns/session-id routing
#      (fail-before evidence); the fork's focused test passes.
#   D. fleet producer gate: scripted run writes a v1 record with a real
#      sessionFile; view-session.mjs renders it; the pi-fleet roster lists it;
#      reconcile flags a stale running record.
#   E. trellis update gate: a user-modified .pi/settings.json in a mimic
#      project is preserved (never silently re-enabled).
#   F. removal gate: uninstalling the fork leaves fleet-core functional.
#
# The loopback HTTP server only serves git's prepared dumb-HTTP files. No live
# profile, no external network.
#
# Usage: bash test/composed-candidate.sh
# Requires: the fork repo clean worktree (Git HEAD proof), pi, git, python3.

set -uo pipefail

FORK_DIR="$(realpath -- "$(dirname -- "$0")/..")"
FLEET_DIR="${PI_FLEET_PACKAGE_DIR:-$HOME/.pi/.fleet-core}"
OLD_EXT="${TRELLIS_OLD_EXT:-$HOME/.pi/.pi/extensions/trellis/index.ts}"
GOTGENES="${GOTGENES_SUBAGENTS_DIR:-$HOME/.pi/agent/npm/node_modules/@gotgenes/pi-subagents}"
TRELLIS_CLI="${TRELLIS_CLI_BIN:-$HOME/.pi/agent/npm/node_modules/.bin/trellis}"
TSX="$FORK_DIR/node_modules/.bin/tsx"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/trellis-pi-ext-composed.XXXXXX")"
EVIDENCE_DIR="$FORK_DIR/phase-1-2-evidence/logs"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }
run() {
  local log="$1"
  shift
  printf '$' > "$log"
  printf ' %q' "$@" >> "$log"
  printf '\n' >> "$log"
  "$@" >> "$log" 2>&1 || { cat "$log" >&2; fail "command failed; see $log"; }
}
assert_file() {
  local needle="$1" file="$2"
  grep -Fq -- "$needle" "$file" || fail "expected '$needle' in $file"
}

for command in git node pi python3; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is not on PATH"
done
[ -f "$FORK_DIR/package.json" ] || fail "fork package not found at $FORK_DIR"
[ -f "$FLEET_DIR/package.json" ] || fail "fleet-core package not found at $FLEET_DIR (set PI_FLEET_PACKAGE_DIR)"
[ -f "$FLEET_DIR/fleet-record-v1.mjs" ] || fail "fleet-core validator not found at $FLEET_DIR/fleet-record-v1.mjs"
[ -f "$OLD_EXT" ] || fail "old generated trellis ext not found at $OLD_EXT (set TRELLIS_OLD_EXT)"
[ -d "$GOTGENES/src" ] || fail "gotgenes pi-subagents source not found at $GOTGENES (set GOTGENES_SUBAGENTS_DIR)"
[ -x "$TRELLIS_CLI" ] || fail "trellis CLI not found at $TRELLIS_CLI (set TRELLIS_CLI_BIN)"
[ -x "$TSX" ] || fail "tsx not installed in the fork repo (npm install first)"
[ -n "$(git -C "$FORK_DIR" status --porcelain 2>/dev/null)" ] && fail "fork worktree is dirty; commit or stash before proving"
[ -n "$(git -C "$FLEET_DIR" status --porcelain 2>/dev/null)" ] && fail "fleet-core worktree is dirty; commit or stash before proving"
mkdir -p "$EVIDENCE_DIR"

export PI_OFFLINE=1 GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1
export NO_PROXY no_proxy="127.0.0.1,localhost"
export npm_config_offline=true npm_config_audit=false npm_config_fund=false
# This proof may itself run inside a trellis child session (TRELLIS_SUBAGENT_CHILD=1
# in the ambient env); the fork's entry early-returns on that flag, so unset it
# for every spawned pi under test.
unset TRELLIS_SUBAGENT_CHILD

FORK_COMMIT="$(git -C "$FORK_DIR" rev-parse HEAD)"
FLEET_COMMIT="$(git -C "$FLEET_DIR" rev-parse HEAD)"
PI_DIR="$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")"
export PI_DIR
[[ "$FORK_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "bad fork HEAD"
[[ "$FLEET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "bad fleet-core HEAD"

# Plant a stale "running" record that reconcile MUST cancel: a real transcript
# (so the record is openable) plus an owner marker whose pid is guaranteed dead.
# A headless start must reconcile it — the marker that the fork extension
# actually loaded in a real pi process. (TPE-004/005: reconcile only cancels
# when the owner is provably dead; a live owner would be left running.)
plant_stale() { # $1 = runs dir
  local dir="$1/trellis"
  mkdir -p "$dir"
  local ts
  ts=$(( $(date +%s) * 1000 - 120000 ))
  local dead_pid
  dead_pid="$(node -e 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","process.exit(0)"]);c.on("exit",()=>console.log(c.pid))')"
  : > "$dir/2026-08-01T00-00-00-000Z_stale-proof.jsonl"
  printf '{"pid":%s,"ts":%s}\n' "$dead_pid" "$ts" > "$dir/stale-proof.pid"
  cat > "$dir/stale-proof.json" <<JSON
{"version":1,"source":"trellis","id":"stale-proof","agent":"trellis-implement","status":"running","startedAt":$ts,"finishedAt":null,"prompt":"stale","sessionFile":"$dir/2026-08-01T00-00-00-000Z_stale-proof.jsonl","error":null}
JSON
}
assert_reconciled() { # $1 = runs dir
  node -e '
    const fs = require("node:fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1] + "/trellis/stale-proof.json", "utf8"));
    if (r.status !== "cancelled" || !/reconciled at startup/.test(r.error)) process.exit(1);
  ' "$1" || fail "stale record was not reconciled (extension did not run its startup logic)"
}

# ── Gate A: install from absolute local path ────────────────────────────
LOCAL_PROFILE="$WORK/local-profile"
LOCAL_RUNS="$WORK/local-runs"
mkdir -p "$LOCAL_PROFILE"
plant_stale "$LOCAL_RUNS"
run "$EVIDENCE_DIR/A1-local-install.log" env PI_CODING_AGENT_DIR="$LOCAL_PROFILE" PI_OFFLINE=1 pi install "$FORK_DIR" --no-approve
run "$EVIDENCE_DIR/A2-local-list.log" env PI_CODING_AGENT_DIR="$LOCAL_PROFILE" PI_OFFLINE=1 pi list --no-approve
assert_file "$FORK_DIR" "$EVIDENCE_DIR/A2-local-list.log"
run "$EVIDENCE_DIR/A3-local-start.log" env PI_CODING_AGENT_DIR="$LOCAL_PROFILE" PI_OFFLINE=1 PI_FLEET_RUNS_DIR="$LOCAL_RUNS" pi --no-session --no-approve -p ''
assert_reconciled "$LOCAL_RUNS"
grep -Fq "Failed to load extension" "$EVIDENCE_DIR/A3-local-start.log" && fail "extension failed to load on headless start"
run "$EVIDENCE_DIR/A4-local-remove.log" env PI_CODING_AGENT_DIR="$LOCAL_PROFILE" PI_OFFLINE=1 pi remove "$FORK_DIR" --no-approve
pass "Gate A (local path): install/list/headless-start-with-reconcile-marker/remove"

# ── Gate A: install from immutable loopback HTTP Git source ─────────────
mkdir -p "$WORK/git-profile" "$WORK/git-runs" "$WORK/www/user"
plant_stale "$WORK/git-runs"
git clone -q --bare "$FORK_DIR" "$WORK/www/user/trellis-pi-ext.git"
git -C "$WORK/www/user/trellis-pi-ext.git" update-server-info
python3 - "$WORK/www" "$WORK/port" "$EVIDENCE_DIR/A5-http-server.log" <<'PY' &
import http.server
import pathlib
import socketserver
import sys

root, port_file, log_file = map(pathlib.Path, sys.argv[1:])
with log_file.open("w") as log:
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=root, **kwargs)

        def log_message(self, message, *args):
            log.write((message % args) + "\n")
            log.flush()

    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
        pathlib.Path(port_file).write_text(str(server.server_address[1]))
        server.serve_forever()
PY
SERVER_PID="$!"
for _ in $(seq 1 100); do
  [ -s "$WORK/port" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$EVIDENCE_DIR/A5-http-server.log" >&2; fail "loopback HTTP server exited"; }
  sleep 0.05
done
[ -s "$WORK/port" ] || fail "loopback HTTP server did not publish its port"
PORT="$(cat "$WORK/port")"
GIT_SOURCE="http://127.0.0.1:$PORT/user/trellis-pi-ext.git@$FORK_COMMIT"
CHECKOUT="$WORK/git-profile/git/127.0.0.1/user/trellis-pi-ext"
run "$EVIDENCE_DIR/A6-git-install.log" env PI_CODING_AGENT_DIR="$WORK/git-profile" PI_OFFLINE=1 GIT_TERMINAL_PROMPT=0 pi install "$GIT_SOURCE" --no-approve
run "$EVIDENCE_DIR/A7-git-list.log" env PI_CODING_AGENT_DIR="$WORK/git-profile" PI_OFFLINE=1 pi list --no-approve
assert_file "$GIT_SOURCE" "$EVIDENCE_DIR/A7-git-list.log"
[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$FORK_COMMIT" ] || fail "managed checkout HEAD does not match immutable commit"
if git -C "$CHECKOUT" symbolic-ref -q HEAD > "$EVIDENCE_DIR/A7-symbolic-head.txt" 2>&1; then
  fail "managed checkout HEAD is attached"
fi
run "$EVIDENCE_DIR/A8-git-start.log" env PI_CODING_AGENT_DIR="$WORK/git-profile" PI_OFFLINE=1 PI_FLEET_RUNS_DIR="$WORK/git-runs" pi --no-session --no-approve -p ''
assert_reconciled "$WORK/git-runs"
grep -Fq "Failed to load extension" "$EVIDENCE_DIR/A8-git-start.log" && fail "extension failed to load from git install"
run "$EVIDENCE_DIR/A9-git-remove.log" env PI_CODING_AGENT_DIR="$WORK/git-profile" PI_OFFLINE=1 pi remove "$GIT_SOURCE" --no-approve
pass "Gate A (loopback git): immutable install/list/detached-HEAD/headless-start/remove"

# ── Gate C: max_turns fail-before evidence on the old generated ext ─────
{
  printf 'old_ext=%s\n' "$OLD_EXT"
  printf 'fork_commit=%s\n' "$FORK_COMMIT"
  printf 'maxTurns_symbols_in_old_ext=%s\n' "$(grep -c "maxTurns" "$OLD_EXT" || true)"
  printf 'session_id_flags_in_old_ext=%s\n' "$(grep -c -- "--session-id" "$OLD_EXT" || true)"
  printf 'fleet_record_writer_in_old_ext=%s\n' "$(grep -c "writeTrellisFleetRecord" "$OLD_EXT" || true)"
} > "$EVIDENCE_DIR/C1-old-ext-gate.txt"
grep -q "maxTurns_symbols_in_old_ext=0" "$EVIDENCE_DIR/C1-old-ext-gate.txt" || fail "old ext unexpectedly contains maxTurns handling"
grep -q "session_id_flags_in_old_ext=0" "$EVIDENCE_DIR/C1-old-ext-gate.txt" || fail "old ext unexpectedly contains session-id routing"
run "$EVIDENCE_DIR/C2-fork-max-turns-test.log" env -C "$FORK_DIR" "$TSX" --test test/max-turns-loop.test.ts
grep -Fq "pass " "$EVIDENCE_DIR/C2-fork-max-turns-test.log" || fail "fork max_turns test did not pass"
pass "Gate C: old ext lacks max_turns/session-id (fail-before); fork focused test passes"

# ── Gate B: composed jiti load (fork + fleet-core + pi-subagents) ───────
GLOBAL_AGENTS="$WORK/global-agents"
MIMIC_PROJECT="$WORK/mimic-project"
mkdir -p "$GLOBAL_AGENTS" "$MIMIC_PROJECT"
run "$EVIDENCE_DIR/B1-composed-load.log" env PI_FLEET_RUNS_DIR="$WORK/gateB-runs" \
  node "$FORK_DIR/test/composed-load.mjs" "$FORK_DIR" "$FLEET_DIR" "$GOTGENES" "$GLOBAL_AGENTS" "$MIMIC_PROJECT"
assert_file "composed-load: all assertions passed" "$EVIDENCE_DIR/B1-composed-load.log"
pass "Gate B: composed jiti load — one trellis_subagent, one fleet, no ctrl+s, two-tier agents"

# ── Gate D: fleet producer end-to-end (scripted child through real fork) ─
FLEET_RUNS="$WORK/fleet-runs"
node --input-type=module - "$FORK_DIR" "$WORK" "$FLEET_RUNS" "$GOTGENES" "$EVIDENCE_DIR" <<'NODE' > "$EVIDENCE_DIR/D1-producer-run.log" 2>&1
const { createJiti } = await import(`${process.env.PI_DIR}/node_modules/jiti/lib/jiti-static.mjs`);
const [forkDir, work, fleetRuns] = process.argv.slice(2);
process.env.PI_FLEET_RUNS_DIR = fleetRuns;
process.env.TRELLIS_PI_CLI_JS = `${forkDir}/test/fake-pi-child.mjs`;
process.env.FAKE_PI_TURNS = "2";
process.env.FAKE_PI_SESSION = "1";
process.env.FAKE_PI_EXIT_AFTER = "1";
const jiti = createJiti(import.meta.url, {
  interopDefault: true, tryNative: false,
  alias: { "@earendil-works/pi-coding-agent": `${process.env.PI_DIR}/dist/index.js` },
});
const mod = await jiti.import(`${forkDir}/index.ts`);
const state = mod.newRun("producer-gate-1", "trellis-implement", "prove the fleet producer");
const result = await mod.runPi(
  work,
  "prove the fleet producer",
  mod.resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [], maxTurns: 2 }),
  state,
  () => {},
);
console.log(JSON.stringify({ failed: result.failed, status: state.status, turns: state.usage.turns }));
NODE
grep -Fq '"failed":false' "$EVIDENCE_DIR/D1-producer-run.log" || fail "scripted producer run did not succeed"
RECORD="$(ls "$FLEET_RUNS"/trellis/producer-gate-1-*.json 2>/dev/null | head -1)"
[ -n "$RECORD" ] || fail "no fleet record written"
SESSION_FILE="$(node -e 'const r=require(process.argv[1]); console.log(r.sessionFile)' "$RECORD")"
[ -n "$SESSION_FILE" ] && [ -f "$SESSION_FILE" ] || fail "sessionFile does not exist: $SESSION_FILE"
node -e '
  const { validateFleetRunRecordV1 } = await import(process.argv[1]);
  const fs = await import("node:fs");
  const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const errs = validateFleetRunRecordV1(r);
  if (errs.length) { console.error(errs); process.exit(1); }
' "$FLEET_DIR/fleet-record-v1.mjs" "$RECORD" \
  || fail "record fails FleetRunRecord v1 validation"
run "$EVIDENCE_DIR/D2-view-session.log" node "$FLEET_DIR/bin/view-session.mjs" --preview "$SESSION_FILE"
assert_file "fake answer" "$EVIDENCE_DIR/D2-view-session.log"
run "$EVIDENCE_DIR/D3-roster.log" env PI_FLEET_RUNS_DIR="$FLEET_RUNS" bash "$FLEET_DIR/bin/pi-fleet" --list
assert_file "producer-gate-1" "$EVIDENCE_DIR/D3-roster.log"
plant_stale "$FLEET_RUNS"
node --input-type=module - "$FORK_DIR" "$FLEET_RUNS" <<'NODE' > "$EVIDENCE_DIR/D4-reconcile.log" 2>&1
const { createJiti } = await import(`${process.env.PI_DIR}/node_modules/jiti/lib/jiti-static.mjs`);
const [forkDir, fleetRuns] = process.argv.slice(2);
process.env.PI_FLEET_RUNS_DIR = fleetRuns;
const jiti = createJiti(import.meta.url, { interopDefault: true, tryNative: false });
const mod = await jiti.import(`${forkDir}/index.ts`);
mod.reconcileFleetRuns();
NODE
assert_reconciled "$FLEET_RUNS"
pass "Gate D: v1 record with real sessionFile, view-session renders it, roster lists it, reconcile flags stale"

# ── Gate E: trellis update preserves a user-modified .pi/settings.json ──
MIMIC="$WORK/trellis-mimic"
mkdir -p "$MIMIC/.trellis" "$MIMIC/.pi"
cp "$HOME/.pi/.trellis/config.yaml" "$MIMIC/.trellis/config.yaml"
cp "$HOME/.pi/.trellis/workflow.md" "$MIMIC/.trellis/workflow.md"
cp "$HOME/.pi/.trellis/.template-hashes.json" "$MIMIC/.trellis/.template-hashes.json"
cat > "$MIMIC/.pi/settings.json" <<'JSON'
{
  "enableSkillCommands": true,
  "extensions": [],
  "prompts": ["./prompts"]
}
JSON
BEFORE="$(sha256sum "$MIMIC/.pi/settings.json" | cut -d' ' -f1)"
# TPE-009: run the update in a real PTY and actually answer the prompts —
# "y" to Proceed?, then Enter (default = skip) at the per-file conflict — and
# require exit 0. A non-TTY run aborts at the confirmation prompt, which proves
# nothing about preservation.
python3 - "$MIMIC" "$TRELLIS_CLI" <<'PY' > "$EVIDENCE_DIR/E1-trellis-update.log" 2>&1
import os
import pty
import re
import select
import sys
import time

mimic, cli = sys.argv[1:3]
cmd = ["bash", "-c", f"cd {mimic} && exec '{cli}' update"]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd[1:])

output = b""
answers = 0

def send(s):
    os.write(fd, s.encode())

status = None
deadline = time.time() + 180
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.25)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        text = output.decode(errors="replace")
        if answers == 0 and re.search(r"Proceed\?", text):
            send("y\n")
            answers = 1
        elif answers == 1 and re.search(r"has changes\.", text):
            send("\n")  # list prompt: Enter selects the default = skip
            answers = 2
    wpid, st = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        status = os.waitstatus_to_exitcode(st)
        break

if status is None:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    print(f"PTY driver timed out; prompts answered: {answers}")
    sys.exit(3)
print(f"prompts_answered={answers}")
sys.exit(status)
PY
PTY_RC=$?
[ "$PTY_RC" -eq 0 ] || { cat "$EVIDENCE_DIR/E1-trellis-update.log" >&2; fail "trellis update (PTY, proceed+skip) exited $PTY_RC"; }
AFTER="$(sha256sum "$MIMIC/.pi/settings.json" | cut -d' ' -f1)"
[ "$BEFORE" = "$AFTER" ] || fail "trellis update rewrote the user-modified .pi/settings.json"
grep -Fq '"extensions": []' "$MIMIC/.pi/settings.json" || fail "settings.json content changed"
{
  printf 'settings_json_preserved=yes\n'
  printf 'update_exit_code=%s\n' "$PTY_RC"
  printf 'prompts_answered=%s\n' "$(grep -c "prompts_answered=2" "$EVIDENCE_DIR/E1-trellis-update.log" || true)"
  printf 'update_output_mentions_modified=%s\n' "$(grep -c "Modified by you" "$EVIDENCE_DIR/E1-trellis-update.log" || true)"
  printf 'update_output_mentions_skip=%s\n' "$(grep -c "Skip" "$EVIDENCE_DIR/E1-trellis-update.log" || true)"
} > "$EVIDENCE_DIR/E2-findings.txt"
pass "Gate E: trellis update (PTY, proceed+skip, exit 0) preserved the user-modified settings.json"

# ── Gate F: removal leaves fleet-core functional ────────────────────────
git clone -q --bare "$FLEET_DIR" "$WORK/www/user/pi-fleet.git"
git -C "$WORK/www/user/pi-fleet.git" update-server-info
FLEET_SOURCE="http://127.0.0.1:$PORT/user/pi-fleet.git@$FLEET_COMMIT"
REMOVE_PROFILE="$WORK/remove-profile"
run "$EVIDENCE_DIR/F1-install-fleet.log" env PI_CODING_AGENT_DIR="$REMOVE_PROFILE" PI_OFFLINE=1 GIT_TERMINAL_PROMPT=0 pi install "$FLEET_SOURCE" --no-approve
run "$EVIDENCE_DIR/F2-install-fork.log" env PI_CODING_AGENT_DIR="$REMOVE_PROFILE" PI_OFFLINE=1 GIT_TERMINAL_PROMPT=0 pi install "$GIT_SOURCE" --no-approve
run "$EVIDENCE_DIR/F3-start-composed.log" env PI_CODING_AGENT_DIR="$REMOVE_PROFILE" PI_OFFLINE=1 PI_FLEET_RUNS_DIR="$WORK/git-runs" pi --no-session --no-approve -p ''
grep -Fq "Failed to load extension" "$EVIDENCE_DIR/F3-start-composed.log" && fail "composed start failed"
run "$EVIDENCE_DIR/F4-remove-fork.log" env PI_CODING_AGENT_DIR="$REMOVE_PROFILE" PI_OFFLINE=1 pi remove "$GIT_SOURCE" --no-approve
run "$EVIDENCE_DIR/F5-start-after-fork-remove.log" env PI_CODING_AGENT_DIR="$REMOVE_PROFILE" PI_OFFLINE=1 PI_FLEET_RUNS_DIR="$WORK/git-runs" pi --no-session --no-approve -p ''
grep -Fq "Failed to load extension" "$EVIDENCE_DIR/F5-start-after-fork-remove.log" && fail "fleet-core broke after fork removal"
run "$EVIDENCE_DIR/F6-list-after.log" env PI_CODING_AGENT_DIR="$REMOVE_PROFILE" PI_OFFLINE=1 pi list --no-approve
assert_file "$FLEET_SOURCE" "$EVIDENCE_DIR/F6-list-after.log"
grep -Fq "$FORK_DIR" "$EVIDENCE_DIR/F6-list-after.log" && fail "fork still listed after removal"
pass "Gate F: removing the fork leaves fleet-core installed and functional"

{
  printf 'observedAt=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf 'pi=%s\n' "$(pi --version)"
  printf 'fork_commit=%s\n' "$FORK_COMMIT"
  printf 'fleet_commit=%s\n' "$FLEET_COMMIT"
  printf 'old_ext=%s\n' "$OLD_EXT"
  printf 'gotgenes=%s\n' "$(node -e 'console.log(require(process.argv[1]+"/package.json").version)' "$GOTGENES")"
  printf 'evidence=%s\n' "$EVIDENCE_DIR"
} > "$EVIDENCE_DIR/result.txt"
pass "all gates passed; evidence retained at $EVIDENCE_DIR"
cat "$EVIDENCE_DIR/result.txt"
