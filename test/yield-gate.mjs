// yield-gate.mjs — Gate G: the fork yields when the project's .pi/settings.json
// loads the generated trellis extension, so the generated ext alone provides
// trellis_subagent (exactly one total). Also proves the fork registers
// normally in a project without that entry.
//
// Usage: node yield-gate.mjs <forkDir> <generatedExtPath> <workDir>
// Requires PI_DIR env (pi package dir) for the jiti + SDK alias.
// The jiti instance mirrors pi's extension loader (interopDefault, SDK alias).

const { createJiti } = await import(
  `${process.env.PI_DIR}/node_modules/jiti/lib/jiti-static.mjs`,
);
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [forkDir, generatedExt, work] = process.argv.slice(2);
// This harness itself may run inside a trellis child session; the fork's
// entry early-returns when TRELLIS_SUBAGENT_CHILD=1, so clear it.
delete process.env.TRELLIS_SUBAGENT_CHILD;
process.env.PI_FLEET_RUNS_DIR = join(work, "runs");

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`ok: ${msg}`);

// Recording fake pi (same shape as composed-load.mjs): captures registration
// calls; pi.events is a real recording bus because the fork subscribes at init.
function recordingPi() {
  const calls = [];
  const tools = [];
  const commands = [];
  const shortcuts = [];
  const events = {};
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
        try {
          h(payload);
        } catch {
          /* recorder bus must never throw */
        }
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
  return { pi, tools, commands, shortcuts, events };
}

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  tryNative: false,
  alias: {
    "@earendil-works/pi-coding-agent": `${process.env.PI_DIR}/dist/index.js`,
  },
});
const forkMod = await jiti.import(`${forkDir}/index.ts`);

// ── Case 1: project .pi/settings.json loads the generated ext → fork yields ──
const yieldProject = join(work, "yield-project");
mkdirSync(join(yieldProject, ".pi"), { recursive: true });
writeFileSync(
  join(yieldProject, ".pi", "settings.json"),
  JSON.stringify({ extensions: ["./extensions/trellis/index.ts"] }),
);
process.chdir(yieldProject);
const rec1 = recordingPi();
forkMod.default(rec1.pi);
if (rec1.tools.length !== 0)
  fail(`fork registered tools in a generated-ext project: ${rec1.tools.map((t) => t.name).join(",")}`);
if (rec1.shortcuts.length !== 0)
  fail(`fork registered shortcuts in a generated-ext project: ${rec1.shortcuts.join(",")}`);
if (Object.keys(rec1.events).length !== 0)
  fail(`fork registered events in a generated-ext project: ${Object.keys(rec1.events).join(",")}`);
ok("fork yields (no tool/shortcut/events) when .pi/settings.json loads the generated ext");

// The generated ext (real template) is then the sole provider.
const genDefault = await jiti.import(generatedExt);
genDefault.default(rec1.pi);
const total = rec1.tools.filter((t) => t.name === "trellis_subagent").length;
if (total !== 1)
  fail(`expected exactly one trellis_subagent total (fork yields), got ${total} (${rec1.tools.map((t) => t.name).join(",")})`);
ok("exactly one trellis_subagent total — the generated ext is the sole provider");

// ── Case 2: project without the generated-ext entry → fork active ─────────
const activeProject = join(work, "active-project");
mkdirSync(join(activeProject, ".pi"), { recursive: true });
process.chdir(activeProject);
const rec2 = recordingPi();
forkMod.default(rec2.pi);
const subagents = rec2.tools.filter((t) => t.name === "trellis_subagent").length;
if (subagents !== 1)
  fail(`expected exactly one trellis_subagent in an active project, got ${subagents}`);
if (typeof rec2.events["before_agent_start"] !== "function")
  fail("before_agent_start handler missing in active project");
ok("fork registers normally (tool + before_agent_start) without the generated-ext entry");

console.log("yield-gate: all assertions passed");
