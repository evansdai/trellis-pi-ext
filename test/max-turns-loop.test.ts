import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newRun, resolveRunCfg, runPi } from "../index.ts";

const work = mkdtempSync(join(tmpdir(), "trellis-ext-maxturns-"));
const root = join(work, "root");
const { mkdirSync } = await import("node:fs");
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
) => {
  process.env.FAKE_PI_TURNS = String(fakeTurns);
  if (exitAfter) process.env.FAKE_PI_EXIT_AFTER = "1";
  else delete process.env.FAKE_PI_EXIT_AFTER;
  return runPi(
    root,
    prompt,
    resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [], maxTurns }),
    newRun("test-run-0", "trellis-implement", prompt),
    () => {},
  );
};

test("max_turns bounds the run: hard abort at N + GRACE_TURNS", async () => {
  // Child emits 6 turns and stays alive; the loop must kill it at 2 + 2 = 4.
  process.env.FAKE_PI_TURNS = "6";
  delete process.env.FAKE_PI_EXIT_AFTER;
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
  assert.ok(state.usage.turns >= 4, `expected >= 4 counted turns, got ${state.usage.turns}`);
});

test("max_turns exceeded records a diagnostic (v1 cancelled needs non-empty error)", async () => {
  process.env.FAKE_PI_TURNS = "6";
  delete process.env.FAKE_PI_EXIT_AFTER;
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
  assert.ok(state.usage.turns >= 4, `expected >= 4 counted turns, got ${state.usage.turns}`);
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
