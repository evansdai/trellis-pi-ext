// Vendored test fixture: fleet-core FleetRunRecord v1 validator.
// Source: github.com/evansdai/pi-fleet @ 2698d3ac829b7becc59cbde09e36f1aa01701436
// (fleet-record-v1.mjs, sha256 a5b6ce2127b7dcea6c6a4df2734297ae81b5339e98224f1065046c3f26695518)
// Re-vendor (copy verbatim + update this header) only when the contract changes.
// Tests use this by default; set FLEET_CORE_DIR to validate against the live checkout
// (a drift-guard test then asserts both copies match).
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FLEET_RUN_RECORD_VERSION = 1;
export const FLEET_RUN_STATUSES = ["running", "succeeded", "failed", "cancelled"];

/**
 * Validate the source-agnostic FleetRunRecord v1 disk contract.
 * Producers may add source-specific data elsewhere; fleet records are deliberately closed.
 * Missing `version` means a legacy record during migration; new writers must emit `version: 1`.
 */
export function validateFleetRunRecordV1(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["record must be an object"];

  const allowed = new Set([
    "version", "source", "id", "agent", "status", "startedAt", "finishedAt",
    "prompt", "sessionFile", "error",
  ]);
  const required = [
    "source", "id", "agent", "status", "startedAt", "finishedAt",
    "prompt", "sessionFile", "error",
  ];
  for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`missing field: ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`unexpected field: ${key}`);

  if (value.version !== undefined && value.version !== FLEET_RUN_RECORD_VERSION) errors.push("version must be 1 when present");
  for (const key of ["source", "id", "agent", "sessionFile"]) {
    if (typeof value[key] !== "string" || value[key].trim() === "") errors.push(`${key} must be a non-empty string`);
  }
  if (typeof value.prompt !== "string") errors.push("prompt must be a string");
  if (!FLEET_RUN_STATUSES.includes(value.status)) errors.push("status must be running, succeeded, failed, or cancelled");
  if (!Number.isSafeInteger(value.startedAt) || value.startedAt < 0) errors.push("startedAt must be a non-negative integer");
  if (value.finishedAt !== null && (!Number.isSafeInteger(value.finishedAt) || value.finishedAt < value.startedAt)) {
    errors.push("finishedAt must be null or an integer no earlier than startedAt");
  }
  if (value.error !== null && typeof value.error !== "string") errors.push("error must be null or a string");

  if (value.status === "running") {
    if (value.finishedAt !== null) errors.push("running records must have finishedAt=null");
    if (value.error !== null) errors.push("running records must have error=null");
  } else if (value.finishedAt === null) {
    errors.push("terminal records must have finishedAt");
  }
  if (value.status === "succeeded" && value.error !== null) errors.push("succeeded records must have error=null");
  if (value.status === "failed" && (typeof value.error !== "string" || value.error.trim() === "")) {
    errors.push("failed records must have a non-empty error");
  }
  if (value.status === "cancelled" && value.version === FLEET_RUN_RECORD_VERSION &&
      (typeof value.error !== "string" || value.error.trim() === "")) {
    errors.push("versioned cancelled records must have a non-empty diagnostic");
  }
  return errors;
}

export function assertFleetRunRecordV1(value) {
  const errors = validateFleetRunRecordV1(value);
  if (errors.length) throw new TypeError(`Invalid FleetRunRecord v1: ${errors.join("; ")}`);
  return value;
}

/**
 * Replace one record atomically. The temporary file is in the destination directory,
 * so rename is a same-filesystem operation; callers retain the previous record on failure.
 */
export function writeFleetRunRecordV1(file, record) {
  assertFleetRunRecordV1(record);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(file), `.${randomUUID()}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
