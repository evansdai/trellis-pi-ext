import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fleetRunsRoot,
  newRun,
  reconcileFleetRuns,
  resolveSessionFile,
  writeTrellisFleetRecord,
} from "../index.ts";

const work = mkdtempSync(join(tmpdir(), "trellis-ext-fleet-"));
const runsDir = join(work, "fleet-runs");
process.env.PI_FLEET_RUNS_DIR = runsDir;

after(() => rmSync(work, { recursive: true, force: true }));

// Test-time fixture: the fleet-core v1 validator (NOT a runtime dependency of
// the fork; the checkout path mirrors the phase-c evidence location).
const validatorPath =
  process.env.FLEET_CORE_VALIDATOR ??
  "/home/evans/.pi/agent/git/github.com/evansdai/pi-fleet/fleet-record-v1.mjs";
const { validateFleetRunRecordV1 } = await import(
  pathToFileURL(validatorPath).href
);

const FLEET_ID = "trellis-implement-1-m0ck1d-abcdef";

const runningState = () => {
  const s = newRun(FLEET_ID, "trellis-implement", "do the fleet thing");
  s.status = "running";
  s.startedAt = Date.now() - 1000;
  return s;
};

test("fleetRunsRoot honors PI_FLEET_RUNS_DIR", () => {
  assert.equal(fleetRunsRoot(), runsDir);
});

test("a running record is written atomically and conforms to FleetRunRecord v1", () => {
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
  // no leftover temp files
  assert.deepEqual(
    readdirSync(join(runsDir, "trellis")).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("terminal records conform for succeeded, failed, cancelled", () => {
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

test("sessionFile falls back to an expected path before the child flushes", () => {
  const file = resolveSessionFile("never-flushed");
  assert.match(file, /never-flushed\.jsonl$/);
  assert.match(file, /^.*\d{4}-\d{2}-\d{2}T[\d-]+Z_never-flushed\.jsonl$/);
});

test("reconcileFleetRuns flags stale running records, leaves fresh ones alone", () => {
  const dir = join(runsDir, "trellis");
  const staleId = "trellis-check-1-stale0000000";
  const freshId = "trellis-check-1-fresh0000000";
  const stale = runningState();
  stale.id = staleId;
  stale.startedAt = Date.now() - 120_000; // older than RECONCILE_MIN_AGE_MS
  writeTrellisFleetRecord(stale, staleId);
  const fresh = runningState();
  fresh.id = freshId;
  writeTrellisFleetRecord(fresh, freshId);

  reconcileFleetRuns();

  const staleRecord = JSON.parse(
    readFileSync(join(dir, `${staleId}.json`), "utf-8"),
  );
  assert.equal(staleRecord.status, "cancelled");
  assert.match(staleRecord.error, /reconciled at startup/);
  assert.deepEqual(validateFleetRunRecordV1(staleRecord), []);

  const freshRecord = JSON.parse(
    readFileSync(join(dir, `${freshId}.json`), "utf-8"),
  );
  assert.equal(freshRecord.status, "running");
});
