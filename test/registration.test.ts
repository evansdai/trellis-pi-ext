import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import trellisExtension from "../index.ts";

// Run from an isolated cwd so findRoot() does not walk into a project with a
// generated Trellis extension that would make the fork yield.
const work = mkdtempSync(join(tmpdir(), "trellis-ext-register-"));
const isolatedCwd = mkdtempSync(join(tmpdir(), "trellis-ext-register-cwd-"));
const previousCwd = process.cwd();
process.chdir(isolatedCwd);

after(() => {
  process.chdir(previousCwd);
  rmSync(isolatedCwd, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

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

test("registration smoke: native dispatch UI is not registered", () => {
  const rec = recordingPi();
  assert.deepEqual(rec.tools, []);
  assert.deepEqual(rec.shortcuts, []);
  assert.deepEqual(rec.commands, []);
});

test("registration smoke: primary-prompt lifecycle wiring is present", () => {
  const rec = recordingPi();
  assert.equal(typeof rec.events["before_agent_start"], "function");
  assert.equal(typeof rec.events["session_start"], "function");
  assert.equal(typeof rec.events["tool_call"], "function");
  assert.equal(typeof rec.events["context"], "function");
  assert.equal(rec.events["tool_result"], undefined);
});
