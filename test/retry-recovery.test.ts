// NEW-001: Pi auto-retry must not leave a stale error on a succeeded run.
//
// The oracle reproduced the defect with a direct retry-stream probe: an
// assistant error is followed by agent_end, then pi auto-retries with a fresh
// agent_start. The stale errorMessage from the failed attempt used to survive
// into the succeeded record — a FleetRunRecord v1 violation ("succeeded
// records must have error=null"). This suite replays the same probe through
// runPi + the scripted fake child (FAKE_PI_RETRY) and asserts the final
// assistant outcome is authoritative:
//   - recover: error -> agent_end -> retry agent_start -> successful message
//     -> agent_end must yield failed:false, status "succeeded", error null,
//     and a record that passes the fleet-core v1 validator;
//   - fail:    error -> agent_end -> retry agent_start -> agent_end with no
//     successful message must KEEP the terminal failure (start events alone
//     never erase it).
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newRun, resolveRunCfg, runPi } from "../index.ts";

const work = mkdtempSync(join(tmpdir(), "trellis-ext-retry-"));
const root = join(work, "root");
mkdirSync(root, { recursive: true });
const fakeChild = resolve(
  fileURLToPath(new URL("./fake-pi-child.mjs", import.meta.url)),
);

process.env.TRELLIS_PI_CLI_JS = fakeChild;
process.env.PI_FLEET_RUNS_DIR = join(work, "fleet");

after(() => rmSync(work, { recursive: true, force: true }));

const run = async (retryMode: "recover" | "fail") => {
  process.env.FAKE_PI_RETRY = retryMode;
  process.env.FAKE_PI_SESSION = "1"; // real transcript so records are written
  delete process.env.FAKE_PI_EXIT_AFTER;
  try {
    const state = newRun("test-run-retry", "trellis-implement", "do the thing");
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
    return { result, state };
  } finally {
    delete process.env.FAKE_PI_RETRY;
    delete process.env.FAKE_PI_SESSION;
  }
};

test("a successful assistant message after a Pi auto-retry recovers the run and clears the stale error (NEW-001)", async () => {
  const { result, state } = await run("recover");

  assert.equal(result.failed, false, "the recovered run must not be failed");
  assert.equal(state.status, "succeeded");
  assert.equal(state.errorMessage, undefined, "no stale error may survive");

  const record = latestRecordFor("test-run-retry");
  assert.ok(record, "a terminal fleet record must be written");
  assert.equal(record.version, 2, "record must satisfy the v2 contract");
  assert.equal(record.parentSessionId, "test-parent-session");
  assert.equal(record.status, "succeeded");
  assert.equal(record.error, null);
});

test("start events alone never erase a terminal failure when the retry produces no message (NEW-001)", async () => {
  const { result, state } = await run("fail");

  assert.equal(result.failed, true);
  assert.equal(state.status, "failed", "a retry without a successful message must keep the failure");
  assert.equal(state.errorMessage, "first attempt failed");

  const record = latestRecordFor("test-run-retry");
  assert.ok(record);
  assert.equal(record.version, 2);
  assert.equal(record.parentSessionId, "test-parent-session");
  assert.equal(record.status, "failed");
  assert.equal(record.error, "first attempt failed");
});

function latestRecordFor(prefix: string): Record<string, unknown> | null {
  const dir = join(process.env.PI_FLEET_RUNS_DIR!, "trellis");
  const matches = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json") && !f.startsWith("."))
    .sort();
  if (!matches.length) return null;
  return JSON.parse(readFileSync(join(dir, matches[matches.length - 1]!), "utf-8"));
}
