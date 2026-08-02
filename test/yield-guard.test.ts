import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import trellisExtension, { projectLoadsGeneratedExt } from "../index.ts";

// Isolate fleet reconcile + agent discovery from the live profile.
const work = mkdtempSync(join(tmpdir(), "trellis-ext-yield-"));
process.env.PI_FLEET_RUNS_DIR = join(work, "fleet");
process.env.PI_CODING_AGENT_DIR = join(work, "agent");
delete process.env.TRELLIS_SUBAGENT_CHILD;

after(() => rmSync(work, { recursive: true, force: true }));

type RecordingPi = {
  tools: Record<string, unknown>[];
  shortcuts: { key: string; description?: string }[];
  events: Record<string, (...args: unknown[]) => unknown>;
  commands: string[];
};

function recordingPi(): RecordingPi {
  const rec: RecordingPi = { tools: [], shortcuts: [], events: {}, commands: [] };
  const pi = {
    registerTool: (t: Record<string, unknown>) => void rec.tools.push(t),
    registerShortcut: (key: string, opts: { description?: string }) =>
      void rec.shortcuts.push({ key, description: opts.description }),
    registerCommand: (name: string) => void rec.commands.push(name),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      rec.events[event] = handler;
    },
  };
  trellisExtension(pi as never);
  return rec;
}

// Create an isolated project dir with an optional .pi/settings.json and
// return its path. Registration tests chdir into it so findRoot() resolves
// there (cwd restored afterwards); helper tests pass the path as root.
let projSeq = 0;
function makeProject(settingsJson: string | null): string {
  const dir = join(work, `proj-${projSeq++}`);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (settingsJson !== null) writeFileSync(join(dir, ".pi", "settings.json"), settingsJson);
  return dir;
}

// ── projectLoadsGeneratedExt unit edges ─────────────────────────────────
test("projectLoadsGeneratedExt: no .pi/settings.json -> false (fork active)", () => {
  assert.equal(projectLoadsGeneratedExt(makeProject(null)), false);
});

test("projectLoadsGeneratedExt: unparseable settings.json -> false", () => {
  assert.equal(projectLoadsGeneratedExt(makeProject("{ not json")), false);
});

test("projectLoadsGeneratedExt: unrelated extensions entry -> false", () => {
  const dir = makeProject(JSON.stringify({ extensions: ["./extensions/other/index.ts"] }));
  assert.equal(projectLoadsGeneratedExt(dir), false);
});

test("projectLoadsGeneratedExt: detects ./extensions/trellis/index.ts", () => {
  const dir = makeProject(JSON.stringify({ extensions: ["./extensions/trellis/index.ts"] }));
  assert.equal(projectLoadsGeneratedExt(dir), true);
});

test("projectLoadsGeneratedExt: detects extensions/trellis/index.ts without ./", () => {
  const dir = makeProject(JSON.stringify({ extensions: ["extensions/trellis/index.ts"] }));
  assert.equal(projectLoadsGeneratedExt(dir), true);
});

test("projectLoadsGeneratedExt: detects absolute form", () => {
  const dir = makeProject(null);
  const abs = join(dir, ".pi", "extensions", "trellis", "index.ts");
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ extensions: [abs] }));
  assert.equal(projectLoadsGeneratedExt(dir), true);
});

// ── Registration behavior through the default export ────────────────────
test("yield guard: project loading the generated ext registers NOTHING", () => {
  const dir = makeProject(JSON.stringify({ extensions: ["./extensions/trellis/index.ts"] }));
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const rec = recordingPi();
    assert.equal(rec.tools.length, 0, "no tools");
    assert.equal(rec.shortcuts.length, 0, "no shortcuts");
    assert.equal(rec.commands.length, 0, "no commands");
    assert.deepEqual(Object.keys(rec.events), [], "no events/bus subscription");
  } finally {
    process.chdir(prevCwd);
  }
});

test("yield guard: entry without ./ is also detected (registers nothing)", () => {
  const dir = makeProject(JSON.stringify({ extensions: ["extensions/trellis/index.ts"] }));
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const rec = recordingPi();
    assert.equal(rec.tools.length, 0);
    assert.equal(rec.shortcuts.length, 0);
    assert.deepEqual(Object.keys(rec.events), []);
  } finally {
    process.chdir(prevCwd);
  }
});

test("yield guard: unrelated extension entry -> fork registers normally", () => {
  const dir = makeProject(JSON.stringify({ extensions: ["./extensions/other/index.ts"] }));
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const rec = recordingPi();
    assert.equal(rec.tools.filter((t) => t.name === "trellis_subagent").length, 1);
    const keys = rec.shortcuts.map((s) => s.key);
    assert.deepEqual(keys, ["alt+o"]);
    assert.equal(typeof rec.events["before_agent_start"], "function");
  } finally {
    process.chdir(prevCwd);
  }
});

test("yield guard: no .pi/settings.json -> fork registers normally", () => {
  const dir = makeProject(null);
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const rec = recordingPi();
    assert.equal(rec.tools.filter((t) => t.name === "trellis_subagent").length, 1);
    assert.equal(typeof rec.events["before_agent_start"], "function");
  } finally {
    process.chdir(prevCwd);
  }
});

// ── Auto-discovery: pi loads <root>/.pi/extensions/** regardless of
//    settings.json, so the generated ext FILE itself must trigger the yield.
test("projectLoadsGeneratedExt: generated ext FILE present (auto-discovery), clean settings -> true", () => {
  const dir = makeProject(JSON.stringify({ enableSkillCommands: true }));
  mkdirSync(join(dir, ".pi", "extensions", "trellis"), { recursive: true });
  writeFileSync(join(dir, ".pi", "extensions", "trellis", "index.ts"), "export default function(){}");
  assert.equal(projectLoadsGeneratedExt(dir), true);
});

test("projectLoadsGeneratedExt: generated ext FILE present, NO settings.json -> true", () => {
  const dir = makeProject(null);
  mkdirSync(join(dir, ".pi", "extensions", "trellis"), { recursive: true });
  writeFileSync(join(dir, ".pi", "extensions", "trellis", "index.ts"), "export default function(){}");
  assert.equal(projectLoadsGeneratedExt(dir), true);
});

test("yield guard: generated ext FILE present but clean settings -> registers NOTHING", () => {
  const dir = makeProject(JSON.stringify({ enableSkillCommands: true, prompts: ["./prompts"] }));
  mkdirSync(join(dir, ".pi", "extensions", "trellis"), { recursive: true });
  writeFileSync(join(dir, ".pi", "extensions", "trellis", "index.ts"), "export default function(){}");
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const rec = recordingPi();
    assert.equal(rec.tools.length, 0, "no tools");
    assert.equal(rec.shortcuts.length, 0, "no shortcuts");
    assert.deepEqual(Object.keys(rec.events), [], "no events/bus subscription");
  } finally {
    process.chdir(prevCwd);
  }
});
