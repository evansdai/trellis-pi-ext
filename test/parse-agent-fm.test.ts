import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentFM } from "../index.ts";

const AGENT = `---
model: foo/bar
thinking: high
fallback_models: [baz/qux, quux/corge]
tools: read, bash, edit
prompt_mode: append
inherit_context: true
max_turns: 42
---
Agent body`;

test("parseAgentFM preserves stock fields", () => {
  const cfg = parseAgentFM(AGENT);
  assert.equal(cfg.model, "foo/bar");
  assert.equal(cfg.thinking, "high");
  assert.deepEqual(cfg.fallbackModels, ["baz/qux", "quux/corge"]);
  assert.deepEqual(cfg.tools, ["read", "bash", "edit"]);
});

test("parseAgentFM reads the gotgenes dialect fields", () => {
  const cfg = parseAgentFM(AGENT);
  assert.equal(cfg.promptMode, "append");
  assert.equal(cfg.inheritContext, true);
  assert.equal(cfg.maxTurns, 42);
});

test("parseAgentFM: prompt_mode only honors explicit values", () => {
  assert.equal(parseAgentFM("---\nprompt_mode: replace\n---\n").promptMode, "replace");
  assert.equal(parseAgentFM("---\nprompt_mode: garbage\n---\n").promptMode, "replace");
  assert.equal(parseAgentFM("---\nmodel: x\n---\n").promptMode, undefined);
  assert.equal(parseAgentFM("").promptMode, undefined);
});

test("parseAgentFM: inherit_context reads true/false; absent = undefined", () => {
  assert.equal(parseAgentFM("---\ninherit_context: true\n---\n").inheritContext, true);
  assert.equal(parseAgentFM("---\ninherit_context: false\n---\n").inheritContext, false);
  assert.equal(parseAgentFM("---\nmodel: x\n---\n").inheritContext, undefined);
});

test("parseAgentFM: max_turns gotgenes semantics (0/unset = unlimited)", () => {
  assert.equal(parseAgentFM("---\nmax_turns: 0\n---\n").maxTurns, 0);
  assert.equal(parseAgentFM("---\nmax_turns: 1\n---\n").maxTurns, 1);
  assert.equal(parseAgentFM("---\nmodel: x\n---\n").maxTurns, undefined);
  // invalid values are dropped, not coerced
  assert.equal(parseAgentFM("---\nmax_turns: -3\n---\n").maxTurns, undefined);
  assert.equal(parseAgentFM("---\nmax_turns: 2.5\n---\n").maxTurns, undefined);
  assert.equal(parseAgentFM("---\nmax_turns: banana\n---\n").maxTurns, undefined);
  // quoted values follow the stock fields' stripping, then Number():
  // `Number('"7"')` is NaN, so quoted values are dropped (design-faithful)
  assert.equal(parseAgentFM('---\nmax_turns: "7"\n---\n').maxTurns, undefined);
});
