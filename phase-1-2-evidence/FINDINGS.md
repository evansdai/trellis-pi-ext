# Phase 1–2 evidence — `@evansdai/trellis-pi-ext` fork

**Evidence date:** `[AS OF: 2026-08-01]` (session clock); Pi 0.83.0 / Trellis 0.6.11.
**Fork commit:** `da2f5e3` (single squashed commit; working-copy history was
recreated cleanly after an index accident — see note below).
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
discovers the transcript by glob `*_<fleetId>.jsonl` (newest mtime wins) and
falls back to an expected path from its own timestamp when the child has not
flushed yet (v1 requires a non-empty `sessionFile` even for `running`).

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
`trellis` source dir and only flags `running` records older than 60 s
(`RECONCILE_MIN_AGE_MS`), so a concurrently live run (second pi instance) is
never clobbered.

## Gate results (composed-candidate.sh, disposable profiles, offline)

| Gate | Result | Evidence |
|---|---|---|
| A local-path install | PASS | install/list/headless-start (stale-record reconcile marker proves the extension loaded)/remove, exactly one source |
| A loopback immutable Git install | PASS | detached HEAD at fork commit, list, start, remove |
| B composed jiti load (fork + fleet-core + gotgenes 19.2.1) | PASS | exactly one `trellis_subagent`; exactly one `fleet` command (+ pi-subagents' own `subagents:settings`/`subagents:sessions`); no `ctrl+s` (only `alt+o`); `before_agent_start` present; global-only agent resolves from a foreign project; project file overrides |
| C max_turns gate | PASS | old generated ext: 0 `maxTurns` symbols, 0 `--session-id` flags, 0 fleet-record writer (fail-before); fork's focused loop test passes (abort at N+2, unlimited for 0/unset) |
| D fleet producer | PASS | scripted run → v1 record with real `sessionFile`; `view-session.mjs --preview` renders it; `pi-fleet --list` roster shows the run; stale record reconciled at startup |
| E trellis update | PASS | user-modified `.pi/settings.json` classified "Modified by you", preserved byte-identical; non-TTY update aborts at confirm |
| F removal | PASS | uninstalling the fork leaves fleet-core installed + headless start clean |

Unit suite: 25/25 (`npm run check`: typecheck + tests).

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
  via `before_agent_start` presence and the retained source), so the gate is
  the composed smoke + a live pilot, not a re-patch.
- `inherit_context: true` / `prompt_mode: append` full semantics remain
  deferred (fields parsed only), per the approved scope.
