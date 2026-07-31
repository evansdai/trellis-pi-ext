// Shared resolver for the fleet-core FleetRunRecord v1 validator used by the
// fork's conformance tests (TPE-008: reproducible from a clean checkout).
//
// Resolution order:
//   1. $FLEET_CORE_DIR — a checkout of github.com/evansdai/pi-fleet; used when
//      the caller wants to validate against the live contract. Must contain
//      fleet-record-v1.mjs, otherwise this module fails loudly.
//   2. The vendored SHA-pinned fixture (test/fixtures/fleet-record-v1.mjs).
//
// There is intentionally NO owner-specific default path: tests must never
// silently depend on local machine state.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FIXTURE = new URL("./fixtures/fleet-record-v1.mjs", import.meta.url);
const liveDir = process.env.FLEET_CORE_DIR;

export const usingLiveValidator = Boolean(liveDir);

let mod;
if (liveDir) {
  const validator = join(liveDir, "fleet-record-v1.mjs");
  if (!existsSync(validator))
    throw new Error(
      `FLEET_CORE_DIR=${liveDir} has no fleet-record-v1.mjs — point it at a ` +
        "checkout of github.com/evansdai/pi-fleet",
    );
  mod = await import(pathToFileURL(validator).href);
} else {
  mod = await import(FIXTURE.href);
}

export const { validateFleetRunRecordV1, FLEET_RUN_RECORD_VERSION } = mod;

/** Drift guard: when FLEET_CORE_DIR is set, the vendored fixture must match the live validator byte-for-byte. */
export function assertFixtureMatchesLive() {
  if (!liveDir) return;
  const live = readFileSync(join(liveDir, "fleet-record-v1.mjs"), "utf-8");
  const fixture = readFileSync(FIXTURE, "utf-8").replace(
    /^\/\/ Vendored test fixture[\s\S]*?Re-vendor[\s\S]*?drift-guard test then asserts both copies match\)\.\n/,
    "",
  );
  const liveStripped = live.replace(/^\uFEFF/, "");
  if (fixture.trim() !== liveStripped.trim()) {
    throw new Error(
      "vendored fleet-record-v1.mjs fixture drifted from $FLEET_CORE_DIR — " +
        "re-vendor the fixture (copy fleet-record-v1.mjs verbatim) and record the new SHA",
    );
  }
}
