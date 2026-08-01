import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryBlocks,
  buildPrompt,
  memKeywords,
  parseAgentFM,
  renderHandoff,
  renderOmBlock,
} from "../index.ts";
import { ContextBudget } from "../index.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────

function budget(): ContextBudget {
  return new ContextBudget(1_000_000);
}

function obsEntry(records: Array<{ id: string; content: string; timestamp?: string }>, ts: string) {
  return {
    type: "custom",
    id: `obs-${ts}`,
    customType: "om.observations.recorded",
    timestamp: ts,
    data: { observations: records },
  };
}

function refEntry(records: Array<{ id: string; content: string }>, ts: string) {
  return {
    type: "custom",
    id: `ref-${ts}`,
    customType: "om.reflections.recorded",
    timestamp: ts,
    data: { reflections: records },
  };
}

function messageEntry(role: string, content: string) {
  return { type: "message", message: { role, content } };
}

function compactionEntry(summary: string) {
  return { type: "compaction", summary };
}

const OM_CFG = { omContext: true, handoff: false, fallbackModels: [] };
const HANDOFF_CFG = { omContext: false, handoff: true, fallbackModels: [] };
const BOTH_CFG = { omContext: true, handoff: true, fallbackModels: [] };

const LEDGER = [
  obsEntry(
    [
      { id: "o1", content: "Cache optimizer patch pinned to 2.6.25.", timestamp: "2026-07-01T00:00:00.000Z" },
      { id: "o2", content: "Unrelated coffee note.", timestamp: "2026-07-02T00:00:00.000Z" },
    ],
    "2026-07-02T00:00:00.000Z",
  ),
  refEntry(
    [{ id: "r1", content: "Retirement gate passed for the cache optimizer patch." }],
    "2026-07-03T00:00:00.000Z",
  ),
  messageEntry("user", "Retire the cache optimizer patch."),
  messageEntry("assistant", "Verified the behavior gate on the candidate."),
  compactionEntry("[OpenAI native compaction checkpoint]"),
];

// ── memKeywords ──────────────────────────────────────────────────────────

test("memKeywords: deterministic keyword extraction", () => {
  assert.deepEqual(memKeywords("The PATCHES are being retired"), ["patch", "retir"]);
  assert.deepEqual(memKeywords("the and then 12345"), []);
  // identical input → identical output
  assert.deepEqual(memKeywords("Retire cache optimizer"), memKeywords("Retire cache optimizer"));
});

// ── renderOmBlock ────────────────────────────────────────────────────────

test("renderOmBlock: reflections first (newest), then keyword-scored observations", () => {
  const block = renderOmBlock(LEDGER, "retire the cache optimizer patch", 10_000);
  assert.ok(block.startsWith("<context_observations>"));
  assert.ok(block.endsWith("</context_observations>"));
  const rIdx = block.indexOf("Retirement gate passed");
  const oIdx = block.indexOf("Cache optimizer patch pinned");
  const fillIdx = block.indexOf("Unrelated coffee note");
  assert.ok(rIdx !== -1 && oIdx !== -1 && fillIdx !== -1);
  assert.ok(rIdx < oIdx, "reflections precede keyword-matched observations");
  assert.ok(oIdx < fillIdx, "keyword matches precede recency fill");
});

test("renderOmBlock: budget cap (chars/4) clips later lines", () => {
  const block = renderOmBlock(LEDGER, "retire the cache optimizer patch", 16);
  const payload = block.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2)).join("");
  assert.ok(block.includes("Retirement gate passed"));
  assert.ok(payload.length <= 64, "selected content must not exceed the token cap");
});

test("renderOmBlock: strictly caps a single oversized item", () => {
  const large = [obsEntry([{ id: "large", content: "x".repeat(200), timestamp: "2026-07-01T00:00:00.000Z" }], "2026-07-01T00:00:00.000Z")];
  const block = renderOmBlock(large, "anything", 10);
  const payload = block.split("\n").find((line) => line.startsWith("- "))?.slice(2) ?? "";
  assert.ok(payload.length <= 40);
});

test("renderOmBlock: empty when ledger empty or budget zero", () => {
  assert.equal(renderOmBlock([], "anything", 800), "");
  assert.equal(renderOmBlock(LEDGER, "anything", 0), "");
});

test("renderOmBlock: deterministic — identical inputs byte-identical", () => {
  assert.equal(renderOmBlock(LEDGER, "retire the cache optimizer patch", 800), renderOmBlock(LEDGER, "retire the cache optimizer patch", 800));
});

// ── renderHandoff ────────────────────────────────────────────────────────

test("renderHandoff: real summary included, native placeholder skipped", () => {
  const block = renderHandoff(LEDGER, 300);
  assert.ok(block.startsWith("<parent_handoff>"));
  assert.ok(block.includes("[User]: Retire the cache optimizer patch."));
  assert.ok(!block.includes("[OpenAI native compaction checkpoint]"));
  assert.ok(!block.includes("[Summary]"));
});

test("renderHandoff: truncation drops oldest parts; newest survives", () => {
  const block = renderHandoff(LEDGER, 10);
  assert.ok(block.includes("[Assistant]: Verified the behavior gate…"));
  assert.ok(!block.includes("Retire the cache optimizer patch."));
});

test("renderHandoff: strictly caps a single oversized remaining part", () => {
  const block = renderHandoff([messageEntry("assistant", "x".repeat(200))], 10);
  const payload = block.split("\n")[2] ?? "";
  assert.ok(payload.length <= 40);
});

test("renderHandoff: empty when nothing to include", () => {
  assert.equal(renderHandoff([], 300), "");
  assert.equal(renderHandoff([compactionEntry("[OpenAI native compaction checkpoint]")], 300), "");
  assert.equal(renderHandoff(LEDGER, 0), "");
});

// ── buildMemoryBlocks ────────────────────────────────────────────────────

test("buildMemoryBlocks: '' when both flags off (byte-identical-off)", () => {
  assert.equal(buildMemoryBlocks({ fallbackModels: [] }, LEDGER, "prompt", budget()), "");
  assert.equal(buildMemoryBlocks({ fallbackModels: [] }, LEDGER, "prompt", budget()), buildMemoryBlocks({ fallbackModels: [] }, LEDGER, "prompt", budget()));
});

test("buildMemoryBlocks: '' when ledger empty", () => {
  assert.equal(buildMemoryBlocks(OM_CFG, [], "prompt", budget()), "");
});

test("buildMemoryBlocks: om block when om_context on", () => {
  const blocks = buildMemoryBlocks(OM_CFG, LEDGER, "retire cache optimizer", budget());
  assert.ok(blocks.includes("<context_observations>"));
  assert.ok(!blocks.includes("<parent_handoff>"));
});

test("buildMemoryBlocks: handoff block when handoff on", () => {
  const blocks = buildMemoryBlocks(HANDOFF_CFG, LEDGER, "retire cache optimizer", budget());
  assert.ok(blocks.includes("<parent_handoff>"));
  assert.ok(!blocks.includes("<context_observations>"));
});

test("buildMemoryBlocks: both blocks, OM before handoff", () => {
  const blocks = buildMemoryBlocks(BOTH_CFG, LEDGER, "retire cache optimizer", budget());
  assert.ok(blocks.indexOf("<context_observations>") < blocks.indexOf("<parent_handoff>"));
});

test("buildMemoryBlocks: over-budget blocks are skipped, not truncated with noise", () => {
  const tight = new ContextBudget(10); // 10 bytes total — nothing fits
  assert.equal(buildMemoryBlocks(BOTH_CFG, LEDGER, "retire cache optimizer", tight), "");
});

test("buildMemoryBlocks: deterministic for identical inputs", () => {
  const a = buildMemoryBlocks(BOTH_CFG, LEDGER, "retire cache optimizer", budget());
  const b = buildMemoryBlocks(BOTH_CFG, LEDGER, "retire cache optimizer", budget());
  assert.equal(a, b);
});

// ── parseAgentFM om/handoff fields ───────────────────────────────────────

test("parseAgentFM: om_context/handoff read YAML booleans; absent = undefined", () => {
  const cfg = parseAgentFM("---\nom_context: true\nhandoff: true\n---\nBody");
  assert.equal(cfg.omContext, true);
  assert.equal(cfg.handoff, true);
  assert.equal(parseAgentFM("---\nom_context: false\nhandoff: false\n---\n").omContext, false);
  assert.equal(parseAgentFM("---\nom_context: FALSE\n---\n").omContext, false);
  assert.equal(parseAgentFM("---\nmodel: x\n---\n").omContext, undefined);
  assert.equal(parseAgentFM("---\nmodel: x\n---\n").handoff, undefined);
});

test("parseAgentFM: om_context_max_tokens/handoff_max_tokens positive ints; invalid dropped", () => {
  assert.equal(parseAgentFM("---\nom_context_max_tokens: 500\n---\n").omContextMaxTokens, 500);
  assert.equal(parseAgentFM("---\nhandoff_max_tokens: 250\n---\n").handoffMaxTokens, 250);
  assert.equal(parseAgentFM("---\nom_context_max_tokens: 0\n---\n").omContextMaxTokens, undefined);
  assert.equal(parseAgentFM("---\nom_context_max_tokens: -5\n---\n").omContextMaxTokens, undefined);
  assert.equal(parseAgentFM("---\nom_context_max_tokens: banana\n---\n").omContextMaxTokens, undefined);
  assert.equal(parseAgentFM("---\nmodel: x\n---\n").handoffMaxTokens, undefined);
});

// ── buildPrompt placement ────────────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), "trellis-ext-mem-"));
const projectRoot = join(work, "project");
const projectAgents = join(projectRoot, ".pi", "agents");
mkdirSync(projectAgents, { recursive: true });
mkdirSync(join(projectRoot, ".trellis"), { recursive: true });
writeFileSync(
  join(projectAgents, "trellis-implement.md"),
  "---\nom_context: true\nhandoff: true\n---\nImplement agent body",
);
process.env.PI_CODING_AGENT_DIR = join(work, "agent");

test("buildPrompt: memory blocks render after task context, before ## Delegated Task", () => {
  const prompt = buildPrompt(
    projectRoot,
    { agent: "trellis-implement", prompt: "Do the thing" },
    null,
    true,
    LEDGER,
  );
  const agentIdx = prompt.indexOf("## Trellis Agent Definition");
  const omIdx = prompt.indexOf("<context_observations>");
  const hoIdx = prompt.indexOf("<parent_handoff>");
  const taskIdx = prompt.indexOf("## Delegated Task");
  assert.ok(agentIdx !== -1 && omIdx !== -1 && hoIdx !== -1 && taskIdx !== -1);
  assert.ok(agentIdx < omIdx && omIdx < hoIdx && hoIdx < taskIdx);
  assert.ok(prompt.endsWith("Do the thing"));
});

test("buildPrompt: no blocks when agent frontmatter opts out — byte-identical to baseline", () => {
  writeFileSync(
    join(projectAgents, "trellis-explore.md"),
    "---\nmodel: x\n---\nExplore body",
  );
  const baseline = buildPrompt(projectRoot, { agent: "trellis-explore", prompt: "Look" }, null, true, LEDGER);
  const again = buildPrompt(projectRoot, { agent: "trellis-explore", prompt: "Look" }, null, true, LEDGER);
  assert.equal(again, baseline);
  assert.ok(!baseline.includes("<context_observations>"));
  assert.ok(!baseline.includes("<parent_handoff>"));
});

test("buildPrompt: no blocks when ledger empty", () => {
  const prompt = buildPrompt(
    projectRoot,
    { agent: "trellis-implement", prompt: "Do the thing" },
    null,
    true,
    [],
  );
  assert.ok(!prompt.includes("<context_observations>"));
  assert.ok(!prompt.includes("<parent_handoff>"));
});

test("buildPrompt: unchanged output when entries omitted (default [])", () => {
  const withDefault = buildPrompt(projectRoot, { agent: "trellis-explore", prompt: "Look" }, null, true);
  const withEmpty = buildPrompt(projectRoot, { agent: "trellis-explore", prompt: "Look" }, null, true, []);
  assert.equal(withDefault, withEmpty);
});
