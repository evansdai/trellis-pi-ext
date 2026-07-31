import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentNameError,
  buildPrompt,
  globalAgentsDir,
  isTrellisAgent,
  parseAgentFM,
  readTrellisAgent,
  sanitizeFleetId,
} from "../index.ts";

const work = mkdtempSync(join(tmpdir(), "trellis-ext-agents-"));
const globalDir = join(work, "agent", "agents");
const projectRoot = join(work, "project");
const projectAgents = join(projectRoot, ".pi", "agents");
mkdirSync(globalDir, { recursive: true });
mkdirSync(projectAgents, { recursive: true });

const GLOBAL_ONLY = "---\nmodel: global-only-model\n---\nGlobal-only body";
const PROJECT_ONLY = "---\nmodel: project-only-model\n---\nProject-only body";
const GLOBAL_SHARED = "---\nmodel: global-shared-model\n---\nGlobal shared body";
const PROJECT_SHARED = "---\nmodel: project-shared-model\n---\nProject shared body";
writeFileSync(join(globalDir, "trellis-global.md"), GLOBAL_ONLY);
writeFileSync(join(globalDir, "trellis-shared.md"), GLOBAL_SHARED);
writeFileSync(join(projectAgents, "trellis-project.md"), PROJECT_ONLY);
writeFileSync(join(projectAgents, "trellis-shared.md"), PROJECT_SHARED);
// A project .trellis marker so buildPrompt's context lookup has a root.
mkdirSync(join(projectRoot, ".trellis"), { recursive: true });

process.env.PI_CODING_AGENT_DIR = join(work, "agent");
process.env.TRELLIS_CONTEXT_ID = ""; // avoid ambient session-key leakage in buildPrompt

after(() => rmSync(work, { recursive: true, force: true }));

test("globalAgentsDir mirrors pi's getAgentDir (env override)", () => {
  assert.equal(globalAgentsDir(), join(work, "agent", "agents"));
});

test("globalAgentsDir falls back to ~/.pi/agent when the env var is unset", () => {
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(
    globalAgentsDir(),
    join(homedir(), ".pi", "agent", "agents"),
  );
  process.env.PI_CODING_AGENT_DIR = join(work, "agent"); // restore for later tests
});

test("a global-only agent resolves from a project without a local file", () => {
  assert.equal(isTrellisAgent(projectRoot, "trellis-global"), true);
  assert.equal(readTrellisAgent(projectRoot, "trellis-global"), GLOBAL_ONLY);
  assert.equal(
    parseAgentFM(readTrellisAgent(projectRoot, "trellis-global")).model,
    "global-only-model",
  );
});

test("a project-only agent resolves from the project dir", () => {
  assert.equal(isTrellisAgent(projectRoot, "trellis-project"), true);
  assert.equal(readTrellisAgent(projectRoot, "trellis-project"), PROJECT_ONLY);
});

test("project agent files override global ones with the same name", () => {
  assert.equal(readTrellisAgent(projectRoot, "trellis-shared"), PROJECT_SHARED);
});

test("missing agents are not trellis agents and read empty", () => {
  assert.equal(isTrellisAgent(projectRoot, "trellis-missing"), false);
  assert.equal(readTrellisAgent(projectRoot, "trellis-missing"), "");
});

test("buildPrompt uses the resolved (global) agent definition body", () => {
  const prompt = buildPrompt(projectRoot, { agent: "trellis-global", prompt: "do it" }, null);
  assert.match(prompt, /Global-only body/);
  assert.match(prompt, /## Delegated Task/);
  assert.match(prompt, /do it/);
});

// ── TPE-002: project agents are trust-gated ────────────────────────────

test("untrusted projects cannot resolve project-tier agents", () => {
  // trellis-project.md exists only in the project tier: untrusted -> gone.
  assert.equal(
    isTrellisAgent(projectRoot, "trellis-project", false),
    false,
    "project-tier agent must not resolve in an untrusted project",
  );
  assert.equal(readTrellisAgent(projectRoot, "trellis-project", false), "");
  // trusted -> project tier works as before
  assert.equal(isTrellisAgent(projectRoot, "trellis-project", true), true);
});

test("untrusted projects fall back to the global tier (project no longer wins)", () => {
  // trellis-shared exists in both tiers with different bodies.
  const raw = readTrellisAgent(projectRoot, "trellis-shared", false);
  assert.equal(raw, GLOBAL_SHARED, "untrusted: global body must win over the project body");
  assert.equal(
    parseAgentFM(raw).model,
    "global-shared-model",
  );
  assert.equal(
    readTrellisAgent(projectRoot, "trellis-shared", true),
    PROJECT_SHARED,
    "trusted: project override still applies",
  );
});

test("untrusted projects still resolve global-only agents", () => {
  assert.equal(isTrellisAgent(projectRoot, "trellis-global", false), true);
  assert.equal(readTrellisAgent(projectRoot, "trellis-global", false), GLOBAL_ONLY);
});

test("buildPrompt honors the trust flag", () => {
  const untrustedPrompt = buildPrompt(
    projectRoot,
    { agent: "trellis-shared", prompt: "x" },
    null,
    false,
  );
  assert.match(untrustedPrompt, /Global shared body/);
  assert.doesNotMatch(untrustedPrompt, /Project shared body/);
  const trustedPrompt = buildPrompt(projectRoot, { agent: "trellis-shared", prompt: "x" }, null, true);
  assert.match(trustedPrompt, /Project shared body/);
});

// ── TPE-001: agent-name path traversal ─────────────────────────────────

test("agentNameError rejects traversal and separator names", () => {
  for (const bad of [
    "../escape",
    "trellis-../escape",
    "a/b",
    "a\\b",
    "..",
    "trellis-..",
    ".hidden",
    "trellis-.hidden",
    "",
    "/etc/passwd",
    "trellis-x/y",
  ])
    assert.notEqual(agentNameError(bad), null, `name must be rejected: ${JSON.stringify(bad)}`);
  for (const good of ["trellis-implement", "implement", "trellis-check", "trellis-A1_b-c.d"])
    assert.equal(agentNameError(good), null, `name must be accepted: ${JSON.stringify(good)}`);
});

test("read/isTrellisAgent never follow an escaped agent path", () => {
  // Plant a file exactly where a traversal would escape to: it must be
  // invisible to agent resolution.
  const escapeTarget = join(work, "agents-escape.md");
  writeFileSync(escapeTarget, "---\nmodel: escaped\n---\nESCAPED BODY");
  assert.equal(isTrellisAgent(projectRoot, "trellis-../agents-escape"), false);
  assert.equal(readTrellisAgent(projectRoot, "trellis-../agents-escape"), "");
  assert.equal(
    readTrellisAgent(projectRoot, "trellis-..\\agents-escape"),
    "",
  );
  assert.equal(readTrellisAgent(projectRoot, "../agents-escape"), "");
});

test("sanitizeFleetId never carries path separators or traversal", () => {
  assert.equal(sanitizeFleetId("trellis-implement-1"), "trellis-implement-1");
  assert.equal(sanitizeFleetId("a/b\\c"), "a_b_c");
  assert.equal(sanitizeFleetId("../escape"), "escape");
  assert.equal(sanitizeFleetId("x y z"), "x_y_z");
  assert.equal(/[^A-Za-z0-9._-]/.test(sanitizeFleetId("../../..")), false);
});
