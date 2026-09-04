import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import trellisExtension, { projectLoadsGeneratedExt } from "../index.ts";

const work = mkdtempSync(join(tmpdir(), "trellis-ext-conflict-"));
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
    registerTool: (tool: Record<string, unknown>) => void rec.tools.push(tool),
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
// there; helper tests pass the path as root.
let projSeq = 0;
function makeProject(settingsJson: string | null): string {
  const dir = join(work, `proj-${projSeq++}`);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (settingsJson !== null) writeFileSync(join(dir, ".pi", "settings.json"), settingsJson);
  return dir;
}

function makeOhMyPiProject(settingsJson: string | null): string {
  const dir = join(work, `omp-${projSeq++}`);
  mkdirSync(join(dir, ".omp"), { recursive: true });
  if (settingsJson !== null) writeFileSync(join(dir, ".omp", "settings.json"), settingsJson);
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
test("projectLoadsGeneratedExt: detects Oh My Pi settings entry", () => {
  const dir = makeOhMyPiProject(JSON.stringify({ extensions: ["./extensions/trellis/index.ts"] }));
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
test("generated Trellis extension conflict fails closed", () => {
  const dir = makeProject(JSON.stringify({ extensions: ["./extensions/trellis/index.ts"] }));
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.throws(() => recordingPi(), /generated Trellis extension conflict|move .* out/i);
  } finally {
    process.chdir(prevCwd);
  }
});

test("generated Trellis extension conflict fails closed without ./", () => {
  const dir = makeProject(JSON.stringify({ extensions: ["extensions/trellis/index.ts"] }));
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.throws(() => recordingPi(), /generated Trellis extension conflict|move .* out/i);
  } finally {
    process.chdir(prevCwd);
  }
});

test("conflict guard: unrelated extension entry -> context/lifecycle registers without native dispatch", () => {
  const dir = makeProject(JSON.stringify({ extensions: ["./extensions/other/index.ts"] }));
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const rec = recordingPi();
    assert.equal(rec.tools.length, 0);
    assert.equal(rec.shortcuts.length, 0);
    assert.equal(rec.commands.length, 0);
    assert.equal(typeof rec.events["before_agent_start"], "function");
  } finally {
    process.chdir(prevCwd);
  }
});

test("conflict guard: no .pi/settings.json -> context/lifecycle registers without native dispatch", () => {
  const dir = makeProject(null);
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const rec = recordingPi();
    assert.equal(rec.tools.length, 0);
    assert.equal(rec.shortcuts.length, 0);
    assert.equal(rec.commands.length, 0);
    assert.equal(typeof rec.events["before_agent_start"], "function");
  } finally {
    process.chdir(prevCwd);
  }
});

// ── Auto-discovery: pi loads <root>/.pi/extensions/** regardless of
// settings.json, so the generated ext FILE itself must trigger the conflict.
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
test("generated Trellis extension conflict fails closed for Oh My Pi", () => {
  const dir = makeOhMyPiProject(JSON.stringify({ extensions: ["./extensions/trellis/index.ts"] }));
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.throws(() => recordingPi(), /generated Trellis extension conflict|move .* out/i);
  } finally {
    process.chdir(prevCwd);
  }
});
test("generated Trellis extension conflict fails closed for auto-discovery", () => {
  const dir = makeProject(JSON.stringify({ enableSkillCommands: true, prompts: ["./prompts"] }));
  mkdirSync(join(dir, ".pi", "extensions", "trellis"), { recursive: true });
  writeFileSync(join(dir, ".pi", "extensions", "trellis", "index.ts"), "export default function(){}");
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.throws(() => recordingPi(), /generated Trellis extension conflict|move .* out/i);
  } finally {
    process.chdir(prevCwd);
  }
});

test("workflow breadcrumb keeps Pi/OMP dispatch and excludes native dispatch", () => {
  const dir = makeProject(null);
  mkdirSync(join(dir, ".trellis", ".runtime", "sessions"), { recursive: true });
  mkdirSync(join(dir, ".trellis", "tasks", "example"), { recursive: true });
  writeFileSync(
    join(dir, ".trellis", "tasks", "example", "task.json"),
    JSON.stringify({ id: "example", status: "in_progress" }),
  );
  writeFileSync(
    join(dir, ".trellis", "workflow.md"),
    [
      "[workflow-state:in_progress]",
      "[Pi, Oh My Pi]",
      "Use gotgenes `subagent` with `worker`, `oracle`, `researcher`, or `scout`.",
      "[/Pi, Oh My Pi]",
      "[Claude Code]",
      "Use `trellis-implement` and `trellis-check`.",
      "[/Claude Code]",
      "[/workflow-state:in_progress]",
    ].join("\n"),
  );
  const key = "pi_test";
  writeFileSync(
    join(dir, ".trellis", ".runtime", "sessions", `${key}.json`),
    JSON.stringify({ current_task: "tasks/example" }),
  );
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const rec = recordingPi();
    const result = rec.events["before_agent_start"]?.(
      { systemPrompt: "base" },
      { sessionManager: { getSessionId: () => key } },
    ) as { systemPrompt?: string; message?: { content?: string } };
    const context = [result.systemPrompt, result.message?.content].filter(Boolean).join("\n");
    assert.match(context, /gotgenes `subagent`/);
    assert.doesNotMatch(context, /trellis-implement|trellis-check/);
  } finally {
    process.chdir(prevCwd);
  }
});
