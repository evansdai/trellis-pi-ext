import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  utimesSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  fleetRunsRoot,
  newRun,
  processStarttime,
  reconcileFleetRuns,
  resolveRunCfg,
  resolveSessionFile,
  runPi,
  writeTrellisFleetRecord,
} from "../index.ts";
import {
  validateFleetRunRecordV1,
  assertFixtureMatchesLive,
  usingLiveValidator,
} from "./fleet-validator.mjs";

const work = mkdtempSync(join(tmpdir(), "trellis-ext-fleet-"));
const runsDir = join(work, "fleet-runs");
process.env.PI_FLEET_RUNS_DIR = runsDir;

after(() => rmSync(work, { recursive: true, force: true }));

const FLEET_ID = "trellis-implement-1-m0ck1d-abcdef";
/** Invoking primary pi session id (captured at tool execution in production). */
const PARENT_SESSION = "primary-session-0123456789abcdef";

/**
 * Producer-side v2 conformance: v1 fields + required non-empty parentSessionId;
 * sessionFile nullable. The v2 validator itself lives in the pi-fleet consumer
 * package; this mirrors the v1 fixture's checks for the v2 deltas.
 */
const validateV2 = (r: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  if (r.version !== 2) errors.push("version must be 2");
  for (const key of ["source", "id", "agent"]) {
    if (typeof r[key] !== "string" || (r[key] as string).trim() === "")
      errors.push(`${key} must be a non-empty string`);
  }
  if (typeof r.parentSessionId !== "string" || !r.parentSessionId.trim())
    errors.push("parentSessionId must be a non-empty string");
  if (
    r.sessionFile !== null &&
    (typeof r.sessionFile !== "string" || !r.sessionFile.trim())
  )
    errors.push("sessionFile must be null or a non-empty string");
  if (!["running", "succeeded", "failed", "cancelled"].includes(r.status as string))
    errors.push("status must be running, succeeded, failed, or cancelled");
  if (!Number.isSafeInteger(r.startedAt) || (r.startedAt as number) < 0)
    errors.push("startedAt must be a non-negative integer");
  if (
    r.finishedAt !== null &&
    (!Number.isSafeInteger(r.finishedAt) ||
      (r.finishedAt as number) < (r.startedAt as number))
  )
    errors.push("finishedAt must be null or an integer no earlier than startedAt");
  if (r.error !== null && typeof r.error !== "string")
    errors.push("error must be null or a string");
  if (r.status === "running") {
    if (r.finishedAt !== null) errors.push("running records must have finishedAt=null");
    if (r.error !== null) errors.push("running records must have error=null");
  } else if (r.finishedAt === null) {
    errors.push("terminal records must have finishedAt");
  }
  return errors;
};

/** Read the record file whose fleet id starts with `prefix` (unique per test). */
const recordJson = (prefix: string) => {
  const dir = join(runsDir, "trellis");
  const files = readdirSync(dir).filter(
    (f) =>
      f.endsWith(".json") &&
      !f.startsWith(".") &&
      f.startsWith(prefix),
  );
  assert.equal(files.length, 1, `expected exactly one record, got ${files}`);
  return JSON.parse(readFileSync(join(dir, files[0]!), "utf-8"));
};

/** Create a real pi-named transcript file so record writes find it (TPE-004). */
const plantTranscript = (fleetId: string, ts = "2026-08-01T12-00-00-000Z") => {
  const dir = join(runsDir, "trellis");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ts}_${fleetId}.jsonl`);
  writeFileSync(file, '{"type":"session","version":3}\n');
  return file;
};

const runningState = () => {
  const s = newRun(FLEET_ID, "trellis-implement", "do the fleet thing");
  s.status = "running";
  s.startedAt = Date.now() - 1000;
  return s;
};

/** A pid that is guaranteed dead: spawn a node child and wait for its exit. */
const deadPid = () =>
  new Promise<number>((resolve) => {
    const c = spawn(process.execPath, ["-e", "process.exit(0)"]);
    c.on("exit", () => resolve(c.pid!));
  });

test("fleetRunsRoot honors PI_FLEET_RUNS_DIR", () => {
  assert.equal(fleetRunsRoot(), runsDir);
});

test("a running record is written atomically and conforms to FleetRunRecord v2", () => {
  plantTranscript(FLEET_ID);
  const s = runningState();
  writeTrellisFleetRecord(s, FLEET_ID, PARENT_SESSION);
  const file = join(runsDir, "trellis", `${FLEET_ID}.json`);
  const record = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(validateV2(record), []);
  assert.equal(record.status, "running");
  assert.equal(record.source, "trellis");
  assert.equal(record.id, FLEET_ID);
  assert.equal(record.finishedAt, null);
  assert.equal(record.error, null);
  assert.equal(record.version, 2);
  assert.equal(record.parentSessionId, PARENT_SESSION);
  assert.ok(record.sessionFile.endsWith(`_${FLEET_ID}.jsonl`));
  // v2 is a strict superset — the closed v1 validator must reject it
  assert.ok(
    validateFleetRunRecordV1(record).length > 0,
    "v1 validator must reject v2 records",
  );
  // running records carry an owner marker; no leftover temp files
  assert.ok(existsSync(join(runsDir, "trellis", `${FLEET_ID}.pid`)));
  assert.deepEqual(
    readdirSync(join(runsDir, "trellis")).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("terminal records conform for succeeded, failed, cancelled", () => {
  plantTranscript(FLEET_ID);
  const cases = [
    { status: "succeeded", error: null },
    { status: "failed", error: "boom" },
    { status: "cancelled", error: "cancelled" },
  ] as const;
  for (const { status, error } of cases) {
    const s = runningState();
    s.status = status;
    s.finishedAt = Date.now();
    s.errorMessage = error ?? undefined;
    writeTrellisFleetRecord(s, FLEET_ID, PARENT_SESSION);
    const record = JSON.parse(
      readFileSync(join(runsDir, "trellis", `${FLEET_ID}.json`), "utf-8"),
    );
    assert.deepEqual(validateV2(record), [], `status=${status}`);
    assert.equal(record.parentSessionId, PARENT_SESSION);
  }
});

test("terminal record keeps sessionFile null and the error diagnostic when the transcript was never created", () => {
  const neverId = "trellis-implement-1-nofile00000";
  const s = runningState();
  s.id = neverId;
  s.status = "failed";
  s.errorMessage = "crashed before first message";
  s.finishedAt = Date.now();
  writeTrellisFleetRecord(s, neverId, PARENT_SESSION);
  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${neverId}.json`), "utf-8"),
  );
  assert.deepEqual(validateV2(record), []);
  assert.equal(record.sessionFile, null);
  assert.equal(record.status, "failed");
  assert.equal(record.error, "crashed before first message");
  assert.equal(
    existsSync(join(runsDir, "trellis", `${neverId}.pid`)),
    false,
    "terminal writes remove the owner marker",
  );
});

test("sessionFile resolves to the real pi-named transcript (newest <ts>_<id>.jsonl)", () => {
  const dir = join(runsDir, "trellis");
  mkdirSync(dir, { recursive: true });
  // two candidates, different timestamps; the newest by mtime must win
  writeFileSync(join(dir, "2026-08-01T00-00-00-000Z_old.jsonl"), "old\n");
  writeFileSync(
    join(dir, `2026-08-01T11-00-00-000Z_${FLEET_ID}.jsonl`),
    "older\n",
  );
  writeFileSync(
    join(dir, `2026-08-01T12-00-00-000Z_${FLEET_ID}.jsonl`),
    "new\n",
  );
  // Explicit mtimes: writes within the same millisecond would tie.
  utimesSync(
    join(dir, `2026-08-01T11-00-00-000Z_${FLEET_ID}.jsonl`),
    new Date("2026-08-01T11:00:00Z"),
    new Date("2026-08-01T11:00:00Z"),
  );
  utimesSync(
    join(dir, `2026-08-01T12-00-00-000Z_${FLEET_ID}.jsonl`),
    new Date("2026-08-01T12:00:00Z"),
    new Date("2026-08-01T12:00:00Z"),
  );
  const s = runningState();
  writeTrellisFleetRecord(s, FLEET_ID, PARENT_SESSION);
  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${FLEET_ID}.json`), "utf-8"),
  );
  assert.equal(
    record.sessionFile,
    join(dir, `2026-08-01T12-00-00-000Z_${FLEET_ID}.jsonl`),
  );
});

test("resolveSessionFile returns null when no transcript exists — never fabricates a path", () => {
  assert.equal(resolveSessionFile("never-flushed"), null);
});

test("a running record is written at spawn with sessionFile null when no transcript exists yet", () => {
  // No plantTranscript: the child JSONL is created lazily on its first
  // assistant message — the v2 spawn record must not fabricate a path.
  const spawnId = "trellis-implement-1-spawn000000";
  const s = runningState();
  s.id = spawnId;
  writeTrellisFleetRecord(s, spawnId, PARENT_SESSION);
  const record = recordJson(spawnId);
  assert.deepEqual(validateV2(record), []);
  assert.equal(record.status, "running");
  assert.equal(record.sessionFile, null);
  assert.equal(record.parentSessionId, PARENT_SESSION);
  assert.equal(record.finishedAt, null);
  assert.equal(record.error, null);
  assert.ok(
    existsSync(join(runsDir, "trellis", `${spawnId}.pid`)),
    "starting runs keep the owner marker",
  );
});

test("writeTrellisFleetRecord skips entirely when the parent session id is unavailable (v2 requires it)", () => {
  const before = readdirSync(join(runsDir, "trellis"));
  writeTrellisFleetRecord(runningState(), "never-scoped-run", undefined);
  const after = readdirSync(join(runsDir, "trellis"));
  assert.deepEqual(
    after,
    before,
    "no record may be written without a parentSessionId",
  );
  assert.equal(
    existsSync(join(runsDir, "trellis", "never-scoped-run.pid")),
    false,
  );
});

test("writeTrellisFleetRecord rejects traversal ids (TPE-001)", () => {
  plantTranscript(FLEET_ID);
  const s = runningState();
  writeTrellisFleetRecord(s, "../../escape", PARENT_SESSION);
  writeTrellisFleetRecord(s, "trellis-x/y", PARENT_SESSION);
  assert.equal(existsSync(join(work, "escape.json")), false);
  assert.equal(existsSync(join(runsDir, "escape.json")), false);
  assert.equal(existsSync(join(runsDir, "trellis", "escape.json")), false);
  assert.equal(existsSync(join(runsDir, "trellis", "trellis-x_y.json")), false);
});

test("reconcile cancels a stale run whose owner process is dead (TPE-005)", async () => {
  const staleId = "trellis-check-1-dead00000000";
  const transcript = plantTranscript(staleId);
  const stale = runningState();
  stale.id = staleId;
  stale.startedAt = Date.now() - 120_000; // older than RECONCILE_MIN_AGE_MS
  writeTrellisFleetRecord(stale, staleId, PARENT_SESSION);
  // Overwrite the live-pid marker with a guaranteed-dead owner pid.
  writeFileSync(
    join(runsDir, "trellis", `${staleId}.pid`),
    JSON.stringify({ pid: await deadPid(), starttime: 123 }),
  );

  reconcileFleetRuns();

  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${staleId}.json`), "utf-8"),
  );
  assert.equal(record.status, "cancelled");
  assert.match(record.error, /reconciled at startup; owner process exited/);
  assert.equal(record.sessionFile, transcript);
  assert.equal(record.parentSessionId, PARENT_SESSION);
  assert.deepEqual(validateV2(record), []);
  assert.equal(existsSync(join(runsDir, "trellis", `${staleId}.pid`)), false);
});

test("reconcile cancels a stale run whose owner pid was reused by an unrelated process (NEW-003)", async (t) => {
  if (processStarttime(process.pid) == null) {
    t.skip("process-birth identity unsupported on this platform (no /proc)");
    return;
  }
  const reusedId = "trellis-check-1-reused000000";
  plantTranscript(reusedId);
  const stale = runningState();
  stale.id = reusedId;
  stale.startedAt = Date.now() - 120_000; // older than the age gate
  writeTrellisFleetRecord(stale, reusedId, PARENT_SESSION);
  // The pid is ALIVE (this process) but the marker's birth identity differs:
  // the recorded owner died and an unrelated process now holds the pid.
  writeFileSync(
    join(runsDir, "trellis", `${reusedId}.pid`),
    JSON.stringify({ pid: process.pid, starttime: 1 }),
  );

  reconcileFleetRuns();

  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${reusedId}.json`), "utf-8"),
  );
  assert.equal(record.status, "cancelled", "a reused pid must not keep the record running");
  assert.match(record.error, /reconciled at startup; owner pid reused by a different process/);
  assert.equal(record.parentSessionId, PARENT_SESSION);
  assert.deepEqual(validateV2(record), []);
  assert.equal(existsSync(join(runsDir, "trellis", `${reusedId}.pid`)), false);
});

test("reconcile leaves a stale run with a live owner pid running (two-process regression, TPE-005)", async () => {
  const liveId = "trellis-check-1-live00000000";
  plantTranscript(liveId);
  const live = runningState();
  live.id = liveId;
  live.startedAt = Date.now() - 120_000; // older than the age gate
  writeTrellisFleetRecord(live, liveId, PARENT_SESSION); // marker carries THIS process's pid (alive)

  reconcileFleetRuns();

  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${liveId}.json`), "utf-8"),
  );
  assert.equal(record.status, "running", "a live owner's run must survive reconcile");
});

test("reconcile leaves a stale run with no owner marker running (uncertain stays running, TPE-005)", async () => {
  const noMarkerId = "trellis-check-1-nomarker0000";
  plantTranscript(noMarkerId);
  const s = runningState();
  s.id = noMarkerId;
  s.startedAt = Date.now() - 120_000;
  writeTrellisFleetRecord(s, noMarkerId, PARENT_SESSION);
  // remove the marker — an old-format record has no owner proof
  rmSync(join(runsDir, "trellis", `${noMarkerId}.pid`), { force: true });

  reconcileFleetRuns();

  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${noMarkerId}.json`), "utf-8"),
  );
  assert.equal(record.status, "running");
});

test("reconcile drops a stale run whose transcript is missing (no bogus paths, TPE-004)", () => {
  const missingId = "trellis-check-1-missing0000";
  const dir = join(runsDir, "trellis");
  const file = join(dir, `${missingId}.json`);
  // No transcript was planted — fabricate a v2 record with a bogus path to
  // exercise the drop path (fabricated-path era record).
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      source: "trellis",
      id: missingId,
      agent: "trellis-implement",
      status: "running",
      startedAt: Date.now() - 120_000,
      finishedAt: null,
      prompt: "stale",
      sessionFile: join(dir, "2026-08-01T00-00-00-000Z_missing.jsonl"),
      error: null,
      parentSessionId: PARENT_SESSION,
    }),
  );

  reconcileFleetRuns();

  assert.equal(existsSync(file), false, "unopenable record must be dropped");
  assert.equal(existsSync(join(dir, `${missingId}.pid`)), false);
});

test("reconcile leaves fresh running records alone", () => {
  const freshId = "trellis-check-1-fresh0000000";
  plantTranscript(freshId);
  const fresh = runningState();
  fresh.id = freshId;
  writeTrellisFleetRecord(fresh, freshId, PARENT_SESSION);

  reconcileFleetRuns();

  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${freshId}.json`), "utf-8"),
  );
  assert.equal(record.status, "running");
});

test("reconcile cancels a stale starting run (sessionFile null, no transcript) whose owner is dead", async () => {
  const staleId = "trellis-check-1-starting0000";
  const stale = runningState();
  stale.id = staleId;
  stale.startedAt = Date.now() - 120_000;
  // No transcript: the v2 spawn record has sessionFile null.
  writeTrellisFleetRecord(stale, staleId, PARENT_SESSION);
  const spawnRecord = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${staleId}.json`), "utf-8"),
  );
  assert.equal(spawnRecord.sessionFile, null);
  // Overwrite the live-pid marker with a guaranteed-dead owner pid.
  writeFileSync(
    join(runsDir, "trellis", `${staleId}.pid`),
    JSON.stringify({ pid: await deadPid(), starttime: 123 }),
  );

  reconcileFleetRuns();

  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${staleId}.json`), "utf-8"),
  );
  assert.equal(record.status, "cancelled");
  assert.equal(
    record.sessionFile,
    null,
    "a starting run never gets a fabricated path",
  );
  assert.equal(record.parentSessionId, PARENT_SESSION);
  assert.match(record.error, /reconciled at startup; owner process exited/);
  assert.deepEqual(validateV2(record), []);
  assert.equal(existsSync(join(runsDir, "trellis", `${staleId}.pid`)), false);
});

test("reconcile leaves a stale starting run with a live owner running (uncertain stays running)", () => {
  const liveStartId = "trellis-check-1-livestart000";
  const s = runningState();
  s.id = liveStartId;
  s.startedAt = Date.now() - 120_000;
  writeTrellisFleetRecord(s, liveStartId, PARENT_SESSION); // marker = this process (alive)

  reconcileFleetRuns();

  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${liveStartId}.json`), "utf-8"),
  );
  assert.equal(record.status, "running", "a live owner's starting run must survive reconcile");
  assert.equal(record.sessionFile, null);
});

test("reconcile drops a running v2 record without parentSessionId (unattributable)", () => {
  const orphanId = "trellis-check-1-noparent000";
  const dir = join(runsDir, "trellis");
  const file = join(dir, `${orphanId}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      source: "trellis",
      id: orphanId,
      agent: "trellis-implement",
      status: "running",
      startedAt: Date.now() - 120_000,
      finishedAt: null,
      prompt: "stale",
      sessionFile: null,
      error: null,
    }),
  );

  reconcileFleetRuns();

  assert.equal(
    existsSync(file),
    false,
    "a v2 record without parentSessionId cannot be attributed and must be dropped",
  );
});

test("runPi publishes the v2 running record at spawn (sessionFile null) and updates it once the transcript appears", async () => {
  const fakeChild = resolve(
    fileURLToPath(new URL("./fake-pi-child.mjs", import.meta.url)),
  );
  process.env.TRELLIS_PI_CLI_JS = fakeChild;
  process.env.FAKE_PI_TURNS = "1";
  process.env.FAKE_PI_EXIT_AFTER = "1";
  process.env.FAKE_PI_SESSION = "1";
  process.env.FAKE_PI_SESSION_DELAY_MS = "400"; // transcript appears well after spawn
  try {
    const state = newRun("test-run-v2", "trellis-implement", "do the thing");
    const pending = runPi(
      work,
      "do the thing",
      resolveRunCfg({ agent: "trellis-implement" }, { fallbackModels: [] }),
      state,
      () => {},
      null,
      undefined,
      PARENT_SESSION,
    );

    // Spawn record: written synchronously before any child event — the child
    // JSONL cannot exist yet, so sessionFile must be null.
    const spawnRecord = recordJson("test-run-v2-");
    assert.equal(spawnRecord.status, "running");
    assert.equal(spawnRecord.sessionFile, null);
    assert.equal(spawnRecord.parentSessionId, PARENT_SESSION);
    assert.deepEqual(validateV2(spawnRecord), []);

    const result = await pending;
    assert.equal(result.failed, false);
    assert.equal(state.status, "succeeded");

    // Terminal record: real transcript path, same id, same parent session.
    const terminal = recordJson("test-run-v2-");
    assert.equal(terminal.id, spawnRecord.id, "id must be fixed across rewrites");
    assert.equal(terminal.status, "succeeded");
    assert.equal(terminal.parentSessionId, PARENT_SESSION);
    assert.ok(
      typeof terminal.sessionFile === "string" &&
        terminal.sessionFile.endsWith(`_${terminal.id}.jsonl`),
      `sessionFile must be the real transcript path, got ${terminal.sessionFile}`,
    );
    assert.ok(existsSync(terminal.sessionFile), "transcript must exist");
    assert.deepEqual(validateV2(terminal), []);
    assert.equal(
      existsSync(join(runsDir, "trellis", `${terminal.id}.pid`)),
      false,
      "terminal writes remove the owner marker",
    );
  } finally {
    delete process.env.TRELLIS_PI_CLI_JS;
    delete process.env.FAKE_PI_TURNS;
    delete process.env.FAKE_PI_EXIT_AFTER;
    delete process.env.FAKE_PI_SESSION;
    delete process.env.FAKE_PI_SESSION_DELAY_MS;
  }
});

test("vendored validator fixture matches the live fleet-core contract when FLEET_CORE_DIR is set", () => {
  if (!usingLiveValidator) {
    // No live checkout: the vendored fixture is the validated contract.
    assert.ok(validateFleetRunRecordV1({ version: 1 }).length > 0);
    return;
  }
  assertFixtureMatchesLive();
});
