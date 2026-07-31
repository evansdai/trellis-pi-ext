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
});

test("parseAgentFM handles YAML scalar values (TPE-006): inline comments, booleans, quotes", () => {
  // inline comments are stripped (quote-aware) before interpretation
  assert.equal(parseAgentFM("---\nmax_turns: 42 # cap\n---\n").maxTurns, 42);
  assert.equal(
    parseAgentFM("---\nprompt_mode: append # comment\n---\n").promptMode,
    "append",
  );
  assert.equal(
    parseAgentFM("---\nmodel: foo/bar # keep me\n---\n").model,
    "foo/bar",
  );
  // YAML booleans are case-insensitive (TRUE/True/true, FALSE/False/false)
  assert.equal(parseAgentFM("---\ninherit_context: TRUE\n---\n").inheritContext, true);
  assert.equal(parseAgentFM("---\ninherit_context: True\n---\n").inheritContext, true);
  assert.equal(parseAgentFM("---\ninherit_context: FALSE\n---\n").inheritContext, false);
  // quoted scalars are unquoted before interpretation (YAML semantics)
  assert.equal(parseAgentFM('---\nmax_turns: "7"\n---\n').maxTurns, 7);
  assert.equal(parseAgentFM("---\nmodel: 'foo/bar'\n---\n").model, "foo/bar");
  // a '#' glued to the value is not a comment (YAML plain-scalar rule)
  assert.equal(parseAgentFM("---\nmodel: foo#bar\n---\n").model, "foo#bar");
  // flow lists with inline comments
  assert.deepEqual(
    parseAgentFM("---\nfallback_models: [baz/qux, quux/corge] # fallbacks\n---\n")
      .fallbackModels,
    ["baz/qux", "quux/corge"],
  );
  // block list items with inline comments
  assert.deepEqual(
    parseAgentFM(
      "---\nfallback_models:\n  - baz/qux # primary\n  - quux/corge\n---\n",
    ).fallbackModels,
    ["baz/qux", "quux/corge"],
  );
  // tools with a comment
  assert.deepEqual(
    parseAgentFM("---\ntools: read, bash # core\n---\n").tools,
    ["read", "bash"],
  );
});
