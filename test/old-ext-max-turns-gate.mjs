// old-ext-max-turns-gate.mjs — Gate C behavioral fail-before proof.
//
// The max_turns gate must be behavioral, not a static symbol grep (trellis-check
// TCF-002): drive the PRE-FORK generated trellis ext's own `runPi` with the
// scripted fake-pi child and assert it does NOT bound a run, then drive the
// fork's `runPi` under the same 6-turn stream and assert it hard-aborts at
// maxTurns + GRACE_TURNS (2 + 2 = 4).
//
// The pre-fork ext exports only its default function; its run helpers are
// module-private, so the harness loads a TEMP COPY of the file with an
// appended `export { runPi, newRun, resolveRunCfg };` (hoisted function
// declarations — no behavior change). The live file is never touched.
//
// Usage: node old-ext-max-turns-gate.mjs <oldExt|none> <forkDir> <workDir>
//   oldExt  path to the pre-fork generated ext, or "none" to skip that half
//   (the old-ext half is environment-specific evidence; the fork half always
//   runs, so the gate works from a clean public checkout).
// Requires PI_DIR env (pi package dir) for jiti.
const { createJiti } = await import(
  `${process.env.PI_DIR}/node_modules/jiti/lib/jiti-static.mjs`,
);
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [oldExtArg, forkDir, workDir] = process.argv.slice(2);
if (!forkDir || !workDir || !process.env.PI_DIR) {
  console.error("usage: node old-ext-max-turns-gate.mjs <oldExt|none> <forkDir> <workDir> (PI_DIR required)");
  process.exit(2);
}
const oldExtPath = oldExtArg === "none" ? null : oldExtArg;
if (oldExtPath && !existsSync(oldExtPath)) {
  console.error(`old ext missing: ${oldExtPath}`);
  process.exit(2);
}

mkdirSync(join(workDir, "old-ext"), { recursive: true });
mkdirSync(join(workDir, "root"), { recursive: true });
mkdirSync(join(workDir, "fleet"), { recursive: true });
process.env.TRELLIS_PI_CLI_JS = `${forkDir}/test/fake-pi-child.mjs`;
process.env.PI_FLEET_RUNS_DIR = `${workDir}/fleet`;
delete process.env.TRELLIS_SUBAGENT_CHILD;

const jiti = createJiti(import.meta.url, { interopDefault: true, tryNative: false });
const root = join(workDir, "root");
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (oldExtPath) {
  const src = readFileSync(oldExtPath, "utf8");
  // Static context (informational; the pass/fail decision is behavioral below).
  console.log(`old_ext_maxTurns_symbols=${(src.match(/maxTurns/g) ?? []).length}`);
  console.log(`old_ext_session_id_flags=${(src.match(/--session-id/g) ?? []).length}`);
  const copyPath = join(workDir, "old-ext", "index.ts");
  writeFileSync(copyPath, src + '\nexport { runPi, newRun, resolveRunCfg };\n');
  const oldMod = await jiti.import(copyPath);

  // Scripted 6-turn child that exits 0: the pre-fork ext must complete all
  // turns with no abort (it has no max_turns handling at all).
  process.env.FAKE_PI_TURNS = "6";
  process.env.FAKE_PI_EXIT_AFTER = "1";
  process.env.FAKE_PI_TURN_DELAY_MS = "10";
  delete process.env.FAKE_PI_SESSION;
  const oldState = oldMod.newRun("old-ext-gate", "trellis-implement", "do the thing");
  const oldResult = await oldMod.runPi(root, "do the thing", { model: "fake/model" }, oldState, () => {});
  console.log(`old_ext_bounded=${oldResult.failed ? "yes" : "no"} turns=${oldState.usage.turns} status=${oldState.status}`);
  if (oldResult.failed) fail("pre-fork ext bounded a run it has no max_turns handling for");
  if (oldState.usage.turns !== 6)
    fail(`pre-fork ext turn count ${oldState.usage.turns} != 6 (run was cut short)`);
} else {
  console.log("old_ext_skipped=missing (no pre-fork ext; set TRELLIS_OLD_EXT to enable the fail-before half)");
}

// Fork half: the SAME 6-turn stream with maxTurns=2 must hard-abort at
// 2 + GRACE_TURNS(2) = 4 (slow cadence so the abort lands deterministically).
process.env.FAKE_PI_TURNS = "6";
delete process.env.FAKE_PI_EXIT_AFTER;
process.env.FAKE_PI_TURN_DELAY_MS = "100";
const forkMod = await jiti.import(`${forkDir}/index.ts`);
const forkState = forkMod.newRun("fork-gate", "trellis-implement", "do the thing");
const forkResult = await forkMod.runPi(
  root,
  "do the thing",
  forkMod.resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [], maxTurns: 2 }),
  forkState,
  () => {},
);
console.log(`fork_abort=${forkResult.failed ? "yes" : "no"} turns=${forkState.usage.turns} status=${forkState.status}`);
if (!forkResult.failed || forkState.status !== "cancelled")
  fail("fork did not hard-abort at maxTurns + grace under the same stream");
if (forkState.usage.turns !== 4) fail(`fork turn count ${forkState.usage.turns} != 4 (expected N+grace)`);

console.log("old-ext-max-turns-gate: all assertions passed");
