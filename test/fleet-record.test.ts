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
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  fleetRunsRoot,
  newRun,
  reconcileFleetRuns,
  resolveSessionFile,
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

test("a running record is written atomically and conforms to FleetRunRecord v1", () => {
  plantTranscript(FLEET_ID);
  const s = runningState();
  writeTrellisFleetRecord(s, FLEET_ID);
  const file = join(runsDir, "trellis", `${FLEET_ID}.json`);
  const record = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(validateFleetRunRecordV1(record), []);
  assert.equal(record.status, "running");
  assert.equal(record.source, "trellis");
  assert.equal(record.id, FLEET_ID);
  assert.equal(record.finishedAt, null);
  assert.equal(record.error, null);
  assert.equal(record.version, 1);
  assert.ok(record.sessionFile.endsWith(`_${FLEET_ID}.jsonl`));
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
    writeTrellisFleetRecord(s, FLEET_ID);
    const record = JSON.parse(
      readFileSync(join(runsDir, "trellis", `${FLEET_ID}.json`), "utf-8"),
    );
    assert.deepEqual(validateFleetRunRecordV1(record), [], `status=${status}`);
  }
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
  writeTrellisFleetRecord(s, FLEET_ID);
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

test("writeTrellisFleetRecord skips (does not fabricate) when no transcript exists", () => {
  const before = readdirSync(join(runsDir, "trellis"));
  const s = runningState();
  writeTrellisFleetRecord(s, "never-flushed-run");
  const after = readdirSync(join(runsDir, "trellis"));
  assert.deepEqual(after, before, "no record may be written without a transcript");
});

test("writeTrellisFleetRecord rejects traversal ids (TPE-001)", () => {
  plantTranscript(FLEET_ID);
  const s = runningState();
  writeTrellisFleetRecord(s, "../../escape");
  writeTrellisFleetRecord(s, "trellis-x/y");
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
  writeTrellisFleetRecord(stale, staleId);
  // Overwrite the live-pid marker with a guaranteed-dead owner pid.
  writeFileSync(
    join(runsDir, "trellis", `${staleId}.pid`),
    JSON.stringify({ pid: await deadPid(), ts: Date.now() - 120_000 }),
  );

  reconcileFleetRuns();

  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${staleId}.json`), "utf-8"),
  );
  assert.equal(record.status, "cancelled");
  assert.match(record.error, /reconciled at startup; owner process exited/);
  assert.equal(record.sessionFile, transcript);
  assert.deepEqual(validateFleetRunRecordV1(record), []);
  assert.equal(existsSync(join(runsDir, "trellis", `${staleId}.pid`)), false);
});

test("reconcile leaves a stale run with a live owner pid running (two-process regression, TPE-005)", async () => {
  const liveId = "trellis-check-1-live00000000";
  plantTranscript(liveId);
  const live = runningState();
  live.id = liveId;
  live.startedAt = Date.now() - 120_000; // older than the age gate
  writeTrellisFleetRecord(live, liveId); // marker carries THIS process's pid (alive)

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
  writeTrellisFleetRecord(s, noMarkerId);
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
  const s = runningState();
  s.id = missingId;
  s.startedAt = Date.now() - 120_000;
  writeTrellisFleetRecord(s, missingId);
  // No transcript was planted, so no record was written at all — plant one
  // manually to exercise the drop path (fabricated-path era record).
  const dir = join(runsDir, "trellis");
  const file = join(dir, `${missingId}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      source: "trellis",
      id: missingId,
      agent: "trellis-implement",
      status: "running",
      startedAt: Date.now() - 120_000,
      finishedAt: null,
      prompt: "stale",
      sessionFile: join(dir, "2026-08-01T00-00-00-000Z_missing.jsonl"),
      error: null,
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
  writeTrellisFleetRecord(fresh, freshId);

  reconcileFleetRuns();

  const record = JSON.parse(
    readFileSync(join(runsDir, "trellis", `${freshId}.json`), "utf-8"),
  );
  assert.equal(record.status, "running");
});

test("vendored validator fixture matches the live fleet-core contract when FLEET_CORE_DIR is set", () => {
  if (!usingLiveValidator) {
    // No live checkout: the vendored fixture is the validated contract.
    assert.ok(validateFleetRunRecordV1({ version: 1 }).length > 0);
    return;
  }
  assertFixtureMatchesLive();
});
