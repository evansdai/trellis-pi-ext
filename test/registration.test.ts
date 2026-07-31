import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import trellisExtension from "../index.ts";

// Isolate fleet reconcile + agent discovery from the live profile.
const work = mkdtempSync(join(tmpdir(), "trellis-ext-register-"));
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

test("registration smoke: exactly one trellis_subagent tool, no fleet command, no ctrl+s", () => {
  const rec = recordingPi();
  const subagents = rec.tools.filter((t) => t.name === "trellis_subagent");
  assert.equal(subagents.length, 1);
  assert.equal(
    rec.tools.filter((t) => t.name !== "trellis_subagent").length,
    0,
  );
  assert.equal(rec.commands.length, 0, "fork registers no commands (fleet lives in fleet-core)");
  const keys = rec.shortcuts.map((s) => s.key);
  assert.deepEqual(keys, ["alt+o"], "only the stock alt+o shortcut, no ctrl+s");
  assert.ok(!keys.some((k) => k === "ctrl+s"));
});

test("registration smoke: primary-prompt lifecycle wiring is present", () => {
  const rec = recordingPi();
  assert.equal(typeof rec.events["before_agent_start"], "function");
  assert.equal(typeof rec.events["session_start"], "function");
  assert.equal(typeof rec.events["tool_call"], "function");
  assert.equal(typeof rec.events["tool_result"], "function");
});

test("registration smoke: tool description advertises global agent discovery", async () => {
  const rec = recordingPi();
  const tool = rec.tools.find((t) => t.name === "trellis_subagent");
  assert.match(String(tool?.description), /global agents dir/);
  // execute must reject an unknown agent with the two-tier error message
  const execute = tool?.execute as (
    id: string,
    input: { agent?: string },
  ) => Promise<{ content: { type: string; text: string }[] }>;
  const out = await execute("id-1", { agent: "trellis-does-not-exist" });
  assert.match(out.content[0]!.text, /global agents dir/);
});
