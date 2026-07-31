// Type declarations for the fleet-validator resolver (TPE-008).
export const usingLiveValidator: boolean;
export const FLEET_RUN_RECORD_VERSION: number;
export function validateFleetRunRecordV1(value: unknown): string[];
export function assertFixtureMatchesLive(): void;
