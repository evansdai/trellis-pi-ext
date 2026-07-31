# Phase 1–2 evidence — `@evansdai/trellis-pi-ext` fork

**Evidence date:** `[AS OF: 2026-08-01]` (session clock); Pi 0.83.0 / Trellis 0.6.11.
**Fork commit:** `179dfb3` (follow-up-2 code+gate HEAD: NEW-001..004
resolutions; the TPE-001..012 era gated code HEAD was `36524bb`, final docs
HEAD `ac7d871`; history: `da2f5e3` → `bdf4628` → `ba0a6fe` → `a5c6076` →
`36524bb` → `ac7d871` → `b5b5f7e` → `179dfb3`; the docs commit carrying
this table is the repository HEAD at the time of reading (`git log`); the
working-copy history was recreated cleanly after an index accident — see note
below).
**Logs:** `phase-1-2-evidence/logs/` (gitignored; retained on this machine).

## Verified facts

### pi JSON-mode event shape for turn counting

Verified against `dist/core/agent-session.js` (`_emitExtensionEvent`, lines ~420-479)
and the fork's end-to-end scripted run:

- JSON-mode stdout is one JSON object per line: `agent_start`, `turn_start`
  (with `turnIndex`), `message_update`, `message_end` (with `message`),
  `turn_end`, `agent_end`, plus `tool_execution_start/end`.
- An assistant turn completes at `message_end` with `message.role === "assistant"`.
  The stock template already counts these into `RunState.usage.turns`
  (`applyEvent`), so turn counting needs no new event matching.
- `pi -p` (print mode) reads **all of stdin to EOF before starting**
  (`main.js` `readPipedStdin`; `print-mode.js` `runPrintMode` runs the prompt
  single-shot). Consequence: a mid-run `cli.stdin.write` steering message is
  impossible for `-p` children — see Deviation below.

### pi session-file naming

Verified against `dist/core/session-manager.js:667` and real records on disk
(`~/.pi/fleet/runs/trellis/2026-07-31T17-59-08-227Z_<id>.jsonl`, old z-fleet
era) and the Gate D producer run:

```text
<ISO-8601 with ":" and "." replaced by "-">_<sessionId>.jsonl
e.g. 2026-07-31T22-01-08-053Z_producer-gate-1-ms9hli9t-1065f1.jsonl
```

The timestamp is computed by the **child** at session init, so the fork
discovers the transcript by glob `*_<fleetId>.jsonl` (newest mtime wins). The
start record is **delayed** until discovery finds an existing file; a path is
never fabricated (TPE-004 — the prior expected-path fallback was removed).

### Global agent-dir env resolution

Pi's `getAgentDir()` (`dist/config.js`, `ENV_AGENT_DIR =
PI_CODING_AGENT_DIR`; default `~/.pi/agent`). `@gotgenes/pi-subagents`
`loadCustomAgents` uses the same SDK function. The fork mirrors it locally
(`globalAgentsDir()`, no SDK import at runtime — zero runtime deps). Project
`<root>/.pi/agents/` wins over the global dir; default agent name remains
`trellis-implement`.

### `trellis update` and the generated extension

`dist/commands/update.js` `analyzeChanges` hash-tracks managed files. A
user-modified `.pi/settings.json` (extensions entry removed) is classified
**"Modified by you (need your decision)"** with an interactive default of
**skip** (`promptConflictResolution`, `default: "skip"`); `--force` is
required to overwrite. In a non-TTY (CI/scripted) run, the update **aborts at
the "Proceed? (Y/n)" confirmation** (inquirer `ERR_USE_AFTER_CLOSE` on EOF)
without writing. Gate E: mimic project, byte-identical settings.json before
and after `trellis update`; the generated ext is never silently re-enabled.

## Deviation from design.md (one, material)

**Design §4: "write a steering message to `cli.stdin` at the turn limit."**
Not possible for `pi -p` children — stdin is consumed to EOF before the run
starts (verified above). Implemented instead:

1. When `max_turns` is set, the child prompt carries a **turn-budget
   directive** ("wrap up now — provide your final answer … further turns are
   force-terminated") — this is the effective soft steer.
2. At `turns >= maxTurns` the fork still attempts a best-effort
   `cli.stdin.write` of the steering message (once, guarded so
   `ERR_STREAM_WRITE_AFTER_END`/`EPIPE` cannot fail the run) — a no-op for
   `-p` children, future-proof if a streaming stdin mode appears.
3. At `turns >= maxTurns + GRACE_TURNS` (2) the child is hard-aborted via the
   existing authoritative `abort()` path; the run record gets status
   `cancelled` with `error: "max_turns exceeded (N + 2 grace)"` (v1-valid:
   cancelled records need a non-empty diagnostic).

`max_turns: 0`/unset = unlimited; invalid values are dropped (gotgenes
semantics). Everything else in design.md was implemented as specified.

Also note: the retired frankenstein `reconcileFleetRuns` reconciled **all**
sources unconditionally at startup; the fork scopes reconciliation to the
`trellis` source dir and, since the oracle follow-up, only flags `running`
records older than 60 s **when the owner is provably dead** (transcript
missing, owner-pid marker dead, or the pid reused by a different process per
its birth identity) — a concurrently live run (second pi instance) is never
clobbered (TPE-005, NEW-003).

## Gate results (composed-candidate.sh, disposable profiles, offline)

| Gate | Result | Evidence |
|---|---|---|
| A local-path install | PASS | install/list/headless-start (stale-record reconcile marker proves the extension loaded)/remove, exactly one source |
| A loopback immutable Git install | PASS | detached HEAD at fork commit, list, start, remove |
| B composed jiti load (fork + fleet-core + gotgenes 19.2.1) | PASS | exactly one `trellis_subagent`; exactly one `fleet` command (+ pi-subagents' own `subagents:settings`/`subagents:sessions`); no `ctrl+s` (only `alt+o`); `before_agent_start` present; global-only agent resolves from a foreign project; project file overrides |
| C max_turns gate | PASS | old generated ext: 0 `maxTurns` symbols, 0 `--session-id` flags, 0 fleet-record writer (fail-before); fork's focused loop test passes (abort at N+2, unlimited for 0/unset) |
| D fleet producer | PASS | scripted run → v1 record with real `sessionFile`; `view-session.mjs --preview` renders it; `pi-fleet --list` roster shows the run; stale record reconciled at startup |
| E trellis update | PASS | user-modified `.pi/settings.json` classified "Modified by you", preserved byte-identical; update ran to completion with exit 0 (`--skip-all` fallback; see TPE-009 note — the sandbox denies PTY allocation, so the interactive PTY driver could not run here) |
| F removal | PASS | uninstalling the fork leaves fleet-core installed + headless start clean |

Unit suite: 53/53 (`npm run check`: typecheck + tests; 25/25 pre-follow-up).
Every new regression fails on the pre-fix code path where feasible (verified
by running the new suites against `bdf4628:index.ts`: TPE-001 write-path,
TPE-003 stopReason, TPE-004 no-fabrication, and TPE-005 reconcile regressions
all fail on the old code; agent-discovery file fails to load because the old
code lacks `agentNameError`/`sanitizeFleetId`).

## Oracle follow-up (TPE-001…TPE-012) — resolutions

All findings from the independent oracle review of `bdf4628` were accepted.
Resolution table (finding → fix → verification):

| # | Finding | Fix | Verification |
|---|---|---|---|
| TPE-001 | agent-name path traversal (read + fleet-record paths) | `AGENT_NAME_RE` `^trellis-[A-Za-z0-9][A-Za-z0-9._-]*$`; `agentNameError()` tool error; `agentFilePath()` containment assert; `sanitizeFleetId()` for fleet/session ids | `agentNameError` rejection table; escaped-file read regression; `writeTrellisFleetRecord` traversal-id rejection; sanitize tests; Gate B name checks |
| TPE-002 | project agents not trust-gated | `PiExtensionContext.isProjectTrusted`; project tier only when trusted; untrusted falls back to global tier | trusted/untrusted resolution tests; `buildPrompt` trust flag; Gate B trust assertions |
| TPE-003 | JSON-mode failures misreported as success | `applyEvent` maps `stopReason` error→failed / aborted→cancelled; `agent_end` cannot overwrite terminal state; exit-0 close derives `failed` from final state | exit-0 `stopReason=error/aborted` tests; terminal records validated against the fleet-core v1 validator |
| TPE-004 | fabricated sessionFile | `resolveSessionFile` returns null unless a real transcript exists; start record delayed until discovery succeeds; terminal/reconcile re-resolve; unopenable records dropped | null-fallback test; skip-write test; missing-transcript drop test; Gate D real `sessionFile` |
| TPE-005 | reconcile cancels other processes' live runs | owner marker `<fleetId>.pid` (pid + process-birth identity); reconcile only cancels when the transcript is missing, the owner pid is dead, or the pid was reused by a different process (identity mismatch); uncertain stays `running` | two-process regression (live pid survives 120s-old record); no-marker stays running; dead-pid cancels; pid-reuse cancels (NEW-003); Gate A/D stale markers now carry a real transcript + dead pid |
| TPE-006 | frontmatter YAML values ignored | `cleanYamlScalar` (quote-aware `#` comments + unquoting) applied to all fields; case-insensitive booleans; documented scalar subset | inline-comment, `TRUE`/`FALSE`, quoted `"7"`→7, flow/block list comment regressions; README documents the subset (no YAML-parity claim) |
| TPE-007 | primary-prompt lifecycle tests missing | `test/lifecycle.test.ts`: inject, suppress, other-primary, dispose→re-inject, receiver-binding (class method reading `this`), fresh jiti module instance via `Symbol.for` | 6 lifecycle tests pass; fresh instance loaded from a temp copy of `index.ts` via jiti |
| TPE-008 | owner-specific test paths | `test/fleet-validator.mjs` resolves `FLEET_CORE_DIR` or the vendored SHA-pinned fixture `test/fixtures/fleet-record-v1.mjs` (fleet-core `2698d3a`); drift-guard test when `FLEET_CORE_DIR` is set; Gate D validator via `$FLEET_DIR/fleet-record-v1.mjs`; gate preflights all prerequisites | `npm run check` passes from the clean tree with no env vars; 13/13 with `FLEET_CORE_DIR` set |
| TPE-009 | Gate E proved only an aborted update | PTY driver (proceed=y, conflict=Enter/skip, exit 0 required) with an honest fallback to `trellis update --skip-all` (official batch flag, same decisions) when the sandbox denies PTY allocation | Gate E passes with exit 0, byte-identical settings.json, `✅ Update complete!`; `E1-pty-attempt.log` records `PTY_UNAVAILABLE: out of pty devices`; `E2-findings.txt` records `gate_e_mode=skip-all` |
| TPE-010 | AGPL §5(a) notice lacked a date | LICENSE + README: "Modified from the Trellis 0.6.11 Pi extension template by Evans Dai on 2026-08-01" | committed text |
| TPE-011 | FINDINGS provenance stale | this table + HEAD `36524bb` + full history | — |
| TPE-012 | max_turns regression too loose | exact `=== N+2` assertion (slow turn cadence + SIGTERM-handled fake child); AbortSignal cancellation case; delayed stdin-error case | 3 tests pass; fail-before verified for the stopReason pair |
| NEW-001 | auto-retry leaves a stale error → invalid v1 record | final assistant outcome is authoritative: a successful `message_end` clears `errorMessage` and recovers `failed`/`cancelled` → `running`; `agent_start`/`turn_start` only promote `pending` → `running` and never erase a terminal failure; the max_turns diagnostic is re-asserted in the close handler if a late success cleared it | retry-stream probe via `FAKE_PI_RETRY=recover/fail` in `test/retry-recovery.test.ts` (2 tests): recover → `failed:false`/`succeeded`/`error:null` + v1-valid record; fail → stays `failed`; both fail on the pre-fix path (stale `errorMessage='first attempt failed'`, `failed:false` on the fail probe) |
| NEW-002 | "fresh module instance" lifecycle test didn't test a fresh module | `recordingPi(extension = trellisExtension)` parameterized; the fresh test registers `freshMod.default` (actual jiti reload), not the static import | fresh-instance suppression + primary-injectable assertions pass through the reloaded module |
| NEW-003 | heartbeat is not a lease (ts never evaluated; PID-reuse keeps orphaned records running forever) | marker now carries `{pid, starttime}` (Linux `/proc/<pid>/stat` field 22 birth identity); reconcile cancels when the pid is alive but its identity differs ("owner pid reused by a different process"); no `/proc` → pid-liveness-only fallback with the leakage documented as a known limitation; `ts`/"30s heartbeat" claims removed from code/README/FINDINGS | `processStarttime` exported; new pid-reuse regression cancels a live-pid/different-identity marker and passes the v1 validator (skips on non-Linux); dead-pid + live-pid tests unchanged |
| NEW-004 | PTY evidence logging defect in Gate E | the PTY driver streams captured child output into the active update log (`E1-trellis-update.log`, same file the fallback writes) and appends `prompts_answered=N`; stale `E1-*` logs are cleared before the gate; metrics derive from the mode-appropriate log (`prompts_answered=na (skip-all…)` in fallback mode) | `bash -n` clean; gate re-run records `gate_e_mode` + metrics from the mode's own log |

**Gate E evidence note (TPE-009):** the interactive PTY path is implemented in
`test/composed-candidate.sh` but this sandbox cannot allocate PTYs
(`openpty`: out of pty devices; `script`: Permission denied — all 10 `/dev/pts`
slots belong to the sandbox). The recorded evidence here therefore uses the
fallback `--skip-all` mode — trellis's official non-interactive batch flag that
makes exactly the same decisions (proceed=yes, every conflict=skip) — and the
update ran to completion (`✅ Update complete! (unknown → 0.6.11)`), exit 0,
with `.pi/settings.json` byte-identical and classified "Modified by you". On a
PTY-capable machine the gate runs the interactive driver instead and records
`gate_e_mode=pty`.

## Repo hygiene note

During Phase 2 the evidence-log ignore pattern was clobbered (a `printf >`
overwrite mistake compounded by the sandbox denying whole commands), which
briefly tracked `node_modules/` and the evidence logs. The unpublished repo
was recreated from the (byte-identical) working tree into the single clean
commit `da2f5e3`; `git ls-files` = 16 files, no `node_modules/`.


## Open items for Phase 3+

- Publication to `github.com/evansdai/trellis-pi-ext` (user approval gate) and
  re-proving install from the real `git:github.com/…@<sha>` URL in a
  disposable profile (loopback dumb-HTTP was proven; the public transport is
  the remaining delta).
- Live promotion (Phase 4): pin in `agent/settings.json`, remove the
  generated-ext entry from `.pi/settings.json`, move trellis agent files to
  global `~/.pi/agent/agents/`, pilot a session.
- Patch retirement (Phase 5): `trellis-0.6.11-primary-prompt.patch` after the
  unpatched-behavior gate — the fork carries the behavior (verified in Gate B
  via `before_agent_start` presence and in `test/lifecycle.test.ts`: child
  suppression, receiver binding, Symbol.for shared state across module
  instances), so the gate is the composed smoke + a live pilot, not a re-patch.
- `inherit_context: true` / `prompt_mode: append` full semantics remain
  deferred (fields parsed only), per the approved scope.
