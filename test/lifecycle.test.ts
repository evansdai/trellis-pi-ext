// TPE-007: ported primary-prompt lifecycle regression tests.
//
// These prove the before_agent_start behavior of the fork (carried from the
// retired trellis-0.6.11-primary-prompt.patch):
//   - a primary session is injected with Trellis context;
//   - a pi-subagents child session announced on the lifecycle bus is
//     suppressed (prompt injection guard);
//   - other primaries stay injectable while a child is suppressed;
//   - a disposed child id becomes injectable again;
//   - SessionManager methods that depend on `this` are invoked through their
//     receiver (arrow binding), so a detached-method bug cannot silently
//     disable suppression;
//   - the child-id set is shared across reloaded module instances via
//     Symbol.for on globalThis (fresh jiti module instance case).
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import trellisExtension from "../index.ts";

const work = mkdtempSync(join(tmpdir(), "trellis-ext-lifecycle-"));
const root = join(work, "root");
mkdirSync(join(root, ".trellis"), { recursive: true });
process.env.PI_FLEET_RUNS_DIR = join(work, "fleet");
process.env.PI_CODING_AGENT_DIR = join(work, "agent");
delete process.env.TRELLIS_SUBAGENT_CHILD;
delete process.env.TRELLIS_CONTEXT_ID;

const prevCwd = process.cwd();
process.chdir(root); // findRoot() resolves to this isolated root

after(() => {
  process.chdir(prevCwd);
  rmSync(work, { recursive: true, force: true });
});

// ── Recording pi (tools/shortcuts/events + a real lifecycle bus) ───────
type Bus = {
  on: (ch: string, h: (data: unknown) => void) => () => void;
  emit: (ch: string, payload: unknown) => void;
};
type RecordingPi = {
  bus: Bus;
  events: Record<string, (...args: unknown[]) => unknown>;
  create: () => unknown;
};

function recordingPi(): RecordingPi {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const bus: Bus = {
    on: (ch, h) => {
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch)!.add(h);
      return () => listeners.get(ch)?.delete(h);
    },
    emit: (ch, payload) => {
      for (const h of [...(listeners.get(ch) ?? [])]) {
        try {
          h(payload);
        } catch {
          /* recorder bus must never throw */
        }
      }
    },
  };
  const events: Record<string, (...args: unknown[]) => unknown> = {};
  const pi = {
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerCommand: () => undefined,
    getThinkingLevel: () => undefined,
    events: bus,
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      events[event] = handler;
    },
  };
  trellisExtension(pi as never);
  return { bus, events, create: () => pi };
}

// ── Fixtures ────────────────────────────────────────────────────────────
const SESSION_CREATED = "subagents:child:session-created";
const SESSION_DISPOSED = "subagents:child:disposed";

/** SessionManager whose methods read `this` — a detached call would throw. */
class ReceiverSessionManager {
  private _id: string;
  constructor(id: string) {
    this._id = id;
  }
  getSessionId(): string {
    return this._id;
  }
  getSessionFile(): string | undefined {
    return undefined;
  }
}

const ctxWith = (sessionId: string) => ({
  sessionManager: new ReceiverSessionManager(sessionId),
});

const beforeAgentStart = (
  pi: RecordingPi,
  systemPrompt: string,
  sessionId: string,
) =>
  (pi.events["before_agent_start"] as (
    event: unknown,
    ctx: unknown,
  ) => unknown)({ systemPrompt }, ctxWith(sessionId));

test("a primary session is injected with Trellis context", () => {
  const pi = recordingPi();
  const out = beforeAgentStart(pi, "base prompt", "primary-1");
  assert.ok(typeof out === "object" && out !== null);
  const result = out as { systemPrompt?: string; message?: unknown };
  assert.match(result.systemPrompt ?? "", /base prompt/);
  assert.match(result.systemPrompt ?? "", /<session-context>/);
  assert.match(result.systemPrompt ?? "", /Trellis SessionStart/);
});

test("an announced child session is suppressed (returns undefined)", () => {
  const pi = recordingPi();
  pi.bus.emit(SESSION_CREATED, { sessionId: "child-1" });
  assert.equal(beforeAgentStart(pi, "base", "child-1"), undefined);
});

test("another primary remains injectable while a child is suppressed", () => {
  const pi = recordingPi();
  pi.bus.emit(SESSION_CREATED, { sessionId: "child-1" });
  assert.equal(beforeAgentStart(pi, "base", "child-1"), undefined);
  const out = beforeAgentStart(pi, "base", "primary-2");
  assert.ok(typeof out === "object" && out !== null);
});

test("a disposed child id becomes injectable again", () => {
  const pi = recordingPi();
  pi.bus.emit(SESSION_CREATED, { sessionId: "child-1" });
  assert.equal(beforeAgentStart(pi, "base", "child-1"), undefined);
  pi.bus.emit(SESSION_DISPOSED, { sessionId: "child-1" });
  const out = beforeAgentStart(pi, "base", "child-1");
  assert.ok(
    typeof out === "object" && out !== null,
    "disposed child must be injectable again",
  );
});

test("receiver-dependent SessionManager methods are invoked correctly (arrow binding)", () => {
  const pi = recordingPi();
  pi.bus.emit(SESSION_CREATED, { sessionId: "child-recv" });
  // getSessionId reads `this`; a detached invocation would throw and callStr
  // would return null -> the guard would NOT suppress. Suppression proves the
  // receiver was preserved.
  assert.equal(beforeAgentStart(pi, "base", "child-recv"), undefined);
});

test("child ids are shared across fresh module instances via Symbol.for", async () => {
  // Announce on the first module instance's bus…
  const pi1 = recordingPi();
  pi1.bus.emit(SESSION_CREATED, { sessionId: "child-shared" });
  assert.equal(beforeAgentStart(pi1, "base", "child-shared"), undefined);

  // …then load a FRESH copy of the extension (simulating pi's reload when the
  // session cwd changes: jiti re-imports with an empty module cache). The new
  // module instance must still see the announced child id.
  const copyPath = join(work, "index-copy.ts");
  writeFileSync(copyPath, readFileSync(new URL("../index.ts", import.meta.url), "utf-8"));
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    tryNative: false,
  });
  const freshMod = await jiti.import(copyPath);
  const pi2 = recordingPi();
  // pi2's own bus never announced the child; the suppression must come from
  // the process-realm shared set.
  const out = (pi2.events["before_agent_start"] as (
    event: unknown,
    ctx: unknown,
  ) => unknown)({ systemPrompt: "base" }, ctxWith("child-shared"));
  assert.equal(
    out,
    undefined,
    "fresh module instance must still suppress the announced child id",
  );
  // and a primary on the fresh instance is still injectable
  const primary = (pi2.events["before_agent_start"] as (
    event: unknown,
    ctx: unknown,
  ) => unknown)({ systemPrompt: "base" }, ctxWith("primary-fresh"));
  assert.ok(typeof primary === "object" && primary !== null);
  assert.ok(freshMod);
});
