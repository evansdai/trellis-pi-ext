// composed-load.mjs — Gate B: jiti-load fork + fleet-core + @gotgenes/pi-subagents
// with a recording fake pi. Asserts no duplicate tools/commands/shortcuts and
// exercises two-tier agent resolution through the fork's exported helpers.
//
// Usage: node composed-load.mjs <forkDir> <fleetDir> <gotgenesDir> <globalAgentsDir> <mimicProjectDir>
// Requires PI_DIR env (pi package dir) for the jiti + SDK alias.
// The jiti instance mirrors pi's extension loader (interopDefault, SDK alias).

const { createJiti } = await import(
  `${process.env.PI_DIR}/node_modules/jiti/lib/jiti-static.mjs`,
);
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [forkDir, fleetDir, gotgenesDir, globalAgentsDir, mimicProjectDir] = process.argv.slice(2);
// This harness itself may run inside a trellis child session; the fork's
// entry early-returns when TRELLIS_SUBAGENT_CHILD=1, so clear it to exercise
// the parent registration path.
delete process.env.TRELLIS_SUBAGENT_CHILD;

// Recording fake pi: any method call is captured; registration calls are
// classified into tools/commands/shortcuts/events.
const calls = [];
const tools = [];
const commands = [];
const shortcuts = [];
const events = {};
// pi-subagents and the fork both use pi.events as an event bus at init time:
// give it a real (recording) bus instead of a function stub.
const busListeners = new Map();
const eventBus = {
  on: (ch, h) => {
    if (!busListeners.has(ch)) busListeners.set(ch, new Set());
    busListeners.get(ch).add(h);
    events[ch] = h;
    return () => busListeners.get(ch)?.delete(h);
  },
  subscribe: (ch, h) => eventBus.on(ch, h),
  off: (ch, h) => busListeners.get(ch)?.delete(h),
  emit: (ch, payload) => {
    for (const h of [...(busListeners.get(ch) ?? [])]) {
      try { h(payload); } catch { /* recorder bus must never throw */ }
    }
  },
};
const pi = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "then") return undefined; // not a thenable
      if (prop === "events") return eventBus;
      return (...args) => {
        calls.push([String(prop), args]);
        if (prop === "registerTool") tools.push(args[0]);
        else if (prop === "registerCommand")
          commands.push(typeof args[0] === "string" ? args[0] : args[0]?.name);
        else if (prop === "registerShortcut") shortcuts.push(args[0]);
        else if (prop === "on") events[args[0]] = args[1];
        return undefined;
      };
    },
  },
);

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  tryNative: false,
  alias: {
    "@earendil-works/pi-coding-agent": `${process.env.PI_DIR}/dist/index.js`,
    "#src/": `${gotgenesDir}/src/`,
  },
});

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`ok: ${msg}`);

// ── 1. Load the three extensions with the recording fake pi ─────────────
const forkMod = await jiti.import(`${forkDir}/index.ts`);
const fleetDefault = await jiti.import(`${fleetDir}/index.ts`);
const fleetCore = fleetDefault.default ?? fleetDefault;
const subagentsDefault = await jiti.import(`${gotgenesDir}/src/index.ts`);
const subagents = subagentsDefault.default ?? subagentsDefault;

forkMod.default(pi);
await fleetCore(pi);
await subagents(pi);

const toolNames = tools.map((t) => t.name).sort();
const trellisSubagents = toolNames.filter((n) => n === "trellis_subagent").length;
if (trellisSubagents !== 1)
  fail(`expected exactly one trellis_subagent tool, got ${trellisSubagents} (${toolNames.join(",")})`);
ok(`exactly one trellis_subagent tool (all tools: ${toolNames.join(", ")})`);

const fleetCommands = commands.filter((c) => c === "fleet").length;
if (fleetCommands !== 1)
  fail(`expected exactly one fleet command, got ${fleetCommands} (${commands.join(",")})`);
ok(`exactly one fleet command (all commands: ${commands.join(", ")})`);

if (shortcuts.some((k) => String(k).includes("ctrl+s")))
  fail(`ctrl+s shortcut registered by the composed candidate: ${shortcuts.join(",")}`);
ok(`no ctrl+s shortcut (shortcuts: ${shortcuts.join(", ") || "none"})`);

if (typeof events["before_agent_start"] !== "function")
  fail("before_agent_start handler missing");
ok("before_agent_start handler present");

if (!toolNames.includes("Agent") && !toolNames.includes("get_subagent_result"))
  fail(`pi-subagents tools missing (${toolNames.join(",")})`);
ok("pi-subagents tools present alongside trellis_subagent (distinct names)");

// ── 2. Two-tier agent resolution (global + project, project wins) ───────
mkdirSync(join(globalAgentsDir, "agents"), { recursive: true });
mkdirSync(join(mimicProjectDir, ".pi", "agents"), { recursive: true });
writeFileSync(
  join(globalAgentsDir, "agents", "trellis-global-only.md"),
  "---\nmodel: global-only\n---\nGlobal-only body",
);
writeFileSync(
  join(globalAgentsDir, "agents", "trellis-shared.md"),
  "---\nmodel: global-shared\n---\nGlobal shared body",
);
writeFileSync(
  join(mimicProjectDir, ".pi", "agents", "trellis-shared.md"),
  "---\nmodel: project-shared\n---\nProject shared body",
);
process.env.PI_CODING_AGENT_DIR = globalAgentsDir;

if (!forkMod.isTrellisAgent(mimicProjectDir, "trellis-global-only"))
  fail("global-only agent did not resolve from a foreign project");
ok("global-only agent resolves from a project without a local file");

if (!forkMod.isTrellisAgent(mimicProjectDir, "trellis-shared"))
  fail("shared-name agent did not resolve");
if (!forkMod.readTrellisAgent(mimicProjectDir, "trellis-shared").includes("Project shared body"))
  fail("project agent file did not override the global one");
ok("project .pi/agents file overrides the global agent with the same name");

if (forkMod.isTrellisAgent(mimicProjectDir, "trellis-missing"))
  fail("missing agent resolved as a trellis agent");
ok("missing agent does not resolve");

// ── 3. Trust gating + agent-name validation (TPE-001/002) ──────────────
writeFileSync(
  join(mimicProjectDir, ".pi", "agents", "trellis-project-only.md"),
  "---\nmodel: project-only\n---\nProject-only body",
);
if (forkMod.isTrellisAgent(mimicProjectDir, "trellis-project-only", false))
  fail("untrusted project resolved a project-tier-only agent");
ok("untrusted project cannot resolve project-tier agents");
if (!forkMod.isTrellisAgent(mimicProjectDir, "trellis-project-only", true))
  fail("trusted project did not resolve its project-tier agent");
if (
  forkMod
    .readTrellisAgent(mimicProjectDir, "trellis-shared", false)
    .includes("Project shared body")
)
  fail("untrusted project still resolved the project-tier override");
if (
  !forkMod
    .readTrellisAgent(mimicProjectDir, "trellis-shared", false)
    .includes("Global shared body")
)
  fail("untrusted project did not fall back to the global tier");
ok("untrusted project falls back to the global tier (project no longer wins)");

if (forkMod.agentNameError("../escape") === null)
  fail("traversal agent name was accepted");
if (forkMod.agentNameError("trellis-implement") !== null)
  fail("valid agent name was rejected");
ok("agent-name validation rejects traversal names");

console.log("composed-load: all assertions passed");
