import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrompt,
  globalAgentsDir,
  isTrellisAgent,
  parseAgentFM,
  readTrellisAgent,
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
