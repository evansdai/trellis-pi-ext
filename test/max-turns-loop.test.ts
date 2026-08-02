import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newRun, resolveRunCfg, runPi } from "../index.ts";

const work = mkdtempSync(join(tmpdir(), "trellis-ext-maxturns-"));
const root = join(work, "root");
mkdirSync(root, { recursive: true });
const fakeChild = resolve(
  fileURLToPath(new URL("./fake-pi-child.mjs", import.meta.url)),
);

// Scripted child: the runPi test seam (TRELLIS_PI_CLI_JS) resolves the child
// CLI. Fleet records are written next to the run, so isolate PI_FLEET_RUNS_DIR.
process.env.TRELLIS_PI_CLI_JS = fakeChild;
process.env.PI_FLEET_RUNS_DIR = join(work, "fleet");

after(() => rmSync(work, { recursive: true, force: true }));

const run = async (
  prompt: string,
  maxTurns: number | undefined,
  fakeTurns: number,
  exitAfter: boolean,
  extraEnv: Record<string, string> = {},
) => {
  process.env.FAKE_PI_TURNS = String(fakeTurns);
  if (exitAfter) process.env.FAKE_PI_EXIT_AFTER = "1";
  else delete process.env.FAKE_PI_EXIT_AFTER;
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  return runPi(
    root,
    prompt,
    resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [], maxTurns }),
    newRun("test-run-0", "trellis-implement", prompt),
    () => {},
  );
};

// Slow turn cadence (set via FAKE_PI_TURN_DELAY_MS) makes the parent's hard
// abort land while the child sleeps: SIGTERM (handled by the fake child)
// terminates it before the next turn, so the counted turns are exactly the
// abort threshold, not a racy +1.

test("max_turns bounds the run: hard abort exactly at N + GRACE_TURNS", async () => {
  // Child emits 6 turns and stays alive; the loop must kill it at 2 + 2 = 4.
  process.env.FAKE_PI_TURNS = "6";
  delete process.env.FAKE_PI_EXIT_AFTER;
  process.env.FAKE_PI_TURN_DELAY_MS = "100";
  const state = newRun("test-run-1", "trellis-implement", "do the thing");
  const result = await runPi(
    root,
    "do the thing",
    resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [], maxTurns: 2 }),
    state,
    () => {},
  );
  assert.equal(result.failed, true);
  assert.equal(state.status, "cancelled");
  assert.equal(state.usage.turns, 4, `expected exactly 4 counted turns, got ${state.usage.turns}`);
});

test("max_turns exceeded records a diagnostic (v1 cancelled needs non-empty error)", async () => {
  process.env.FAKE_PI_TURNS = "6";
  delete process.env.FAKE_PI_EXIT_AFTER;
  process.env.FAKE_PI_TURN_DELAY_MS = "100";
  const state = newRun("test-run-2", "trellis-implement", "do the thing");
  const result = await runPi(
    root,
    "do the thing",
    resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [], maxTurns: 2 }),
    state,
    () => {},
  );
  assert.equal(result.failed, true);
  assert.equal(state.status, "cancelled");
  assert.match(state.errorMessage ?? "", /max_turns exceeded \(2 \+ 2 grace\)/);
  assert.equal(state.usage.turns, 4);
});

test("max_turns 0 and unset are unlimited: run completes", async () => {
  for (const maxTurns of [undefined, 0]) {
    const result = await run("do the thing", maxTurns, 3, true);
    assert.equal(result.failed, false, `maxTurns=${maxTurns} should not bound the run`);
    assert.match(result.output, /fake answer 3/);
  }
});

test("the turn-budget directive is embedded in the child prompt when max_turns is set", async () => {
  const promptFile = join(work, "prompt.txt");
  process.env.FAKE_PI_PROMPT_FILE = promptFile;
  try {
    await run("do the thing", 4, 3, true);
    const prompt = readFileSync(promptFile, "utf-8");
    assert.match(prompt, /## Turn budget \(enforced\)/);
    assert.match(prompt, /at most 4 assistant turns/);
    assert.match(prompt, /wrap up now/);

    process.env.FAKE_PI_PROMPT_FILE = promptFile;
    await run("do the thing", 0, 3, true);
    const promptUnlimited = readFileSync(promptFile, "utf-8");
    assert.doesNotMatch(promptUnlimited, /## Turn budget \(enforced\)/);
  } finally {
    delete process.env.FAKE_PI_PROMPT_FILE;
  }
});

test("a delayed steering write after stdin end must not fail the run (TPE-012)", async () => {
  // maxTurns=1: the steering write fires after the child (and its stdin) is
  // gone — ERR_STREAM_WRITE_AFTER_END/EPIPE must be ignored, not fail the run.
  const result = await run("do the thing", 1, 1, true, { FAKE_PI_TURN_DELAY_MS: "1" });
  assert.equal(result.failed, false);
  assert.equal(result.output, "fake answer 1");
});

test("an AbortSignal cancellation stays authoritative and is not masked by max_turns (TPE-012)", async () => {
  process.env.FAKE_PI_TURNS = "6";
  delete process.env.FAKE_PI_EXIT_AFTER;
  process.env.FAKE_PI_TURN_DELAY_MS = "100";
  const ac = new AbortController();
  const state = newRun("test-run-cancel", "trellis-implement", "do the thing");
  const pending = runPi(
    root,
    "do the thing",
    resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [], maxTurns: 99 }),
    state,
    () => {},
    null,
    ac.signal,
  );
  setTimeout(() => ac.abort(), 150); // mid-run, well before any limit
  const result = await pending;
  assert.equal(result.failed, true);
  assert.equal(state.status, "cancelled");
  assert.equal(state.errorMessage, "cancelled");
});

test("JSON-mode stopReason=error fails the run even when the child exits 0 (TPE-003)", async () => {
  process.env.FAKE_PI_SESSION = "1";
  process.env.FAKE_PI_TURNS = "3";
  process.env.FAKE_PI_EXIT_AFTER = "1";
  process.env.FAKE_PI_STOP_REASON = "error";
  process.env.FAKE_PI_ERROR_MESSAGE = "model exploded";
  try {
    const state = newRun("test-run-jsonerr", "trellis-implement", "do the thing");
    const result = await runPi(
      root,
      "do the thing",
      resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [] }),
      state,
      () => {},
      undefined,
      undefined,
      "test-parent-session",
    );
    assert.equal(result.failed, true, "exit 0 must not mask a JSON-mode error");
    assert.equal(state.status, "failed");
    assert.equal(state.errorMessage, "model exploded");
    // the terminal record must be v2 (failed needs a non-empty error)
    const record = latestRecordFor("test-run-jsonerr");
    assert.ok(record, "a terminal fleet record must be written");
    assert.equal(record.version, 2);
    assert.equal(record.parentSessionId, "test-parent-session");
    assert.equal(record.status, "failed");
    assert.equal(record.error, "model exploded");
  } finally {
    delete process.env.FAKE_PI_SESSION;
    delete process.env.FAKE_PI_STOP_REASON;
    delete process.env.FAKE_PI_ERROR_MESSAGE;
  }
});

test("JSON-mode stopReason=aborted cancels the run even when the child exits 0 (TPE-003)", async () => {
  process.env.FAKE_PI_SESSION = "1";
  process.env.FAKE_PI_TURNS = "3";
  process.env.FAKE_PI_EXIT_AFTER = "1";
  process.env.FAKE_PI_STOP_REASON = "aborted";
  process.env.FAKE_PI_ERROR_MESSAGE = "user interrupted";
  try {
    const state = newRun("test-run-jsonabort", "trellis-implement", "do the thing");
    const result = await runPi(
      root,
      "do the thing",
      resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [] }),
      state,
      () => {},
      undefined,
      undefined,
      "test-parent-session",
    );
    assert.equal(result.failed, true);
    assert.equal(state.status, "cancelled");
    assert.equal(state.errorMessage, "user interrupted");
    const record = latestRecordFor("test-run-jsonabort");
    assert.ok(record);
    assert.equal(record.version, 2);
    assert.equal(record.parentSessionId, "test-parent-session");
    assert.equal(record.status, "cancelled");
    assert.equal(record.error, "user interrupted");
  } finally {
    delete process.env.FAKE_PI_SESSION;
    delete process.env.FAKE_PI_STOP_REASON;
    delete process.env.FAKE_PI_ERROR_MESSAGE;
  }
});

function latestRecordFor(prefix: string): Record<string, unknown> | null {
  const dir = join(process.env.PI_FLEET_RUNS_DIR!, "trellis");
  const matches = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json") && !f.startsWith("."))
    .sort();
  if (!matches.length) return null;
  return JSON.parse(readFileSync(join(dir, matches[matches.length - 1]!), "utf-8"));
}
