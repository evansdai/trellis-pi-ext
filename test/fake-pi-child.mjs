// Scripted fake pi child for runPi tests, driven via TRELLIS_PI_CLI_JS.
// Emits pi-like JSON-mode events to stdout and, like real pi, consumes stdin
// to EOF before starting. Controlled by env:
//   FAKE_PI_TURNS          assistant message_end events to emit (default 3)
//   FAKE_PI_EXIT_AFTER     "1" -> exit 0 after the turns; else stay alive until killed
//   FAKE_PI_SESSION        "1" -> write a v3 session JSONL into --session-dir like real pi
//   FAKE_PI_SESSION_DELAY_MS delay before writing the session JSONL (default 0)
//                            (lets tests observe the running record before the transcript)
//   FAKE_PI_PROMPT_FILE    write the received prompt text to this file (for assertions)
//   FAKE_PI_STOP_REASON    optional stopReason on every assistant message_end
//   FAKE_PI_ERROR_MESSAGE  optional errorMessage on every assistant message_end
//   FAKE_PI_TURN_DELAY_MS  delay between turns (default 10)
// SIGTERM is handled so the parent's hard abort is deterministic: the child
// stops emitting immediately instead of racing one more turn.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.on("SIGTERM", () => process.exit(143));

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionDir = getArg("--session-dir");
const sessionId = getArg("--session-id");

// Consume the prompt like real pi (reads stdin to EOF).
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

if (process.env.FAKE_PI_PROMPT_FILE) {
  writeFileSync(process.env.FAKE_PI_PROMPT_FILE, prompt);
}

const turns = Number(process.env.FAKE_PI_TURNS ?? "3");
const exitAfter = process.env.FAKE_PI_EXIT_AFTER === "1";
const writeSession = process.env.FAKE_PI_SESSION === "1";
const stopReason = process.env.FAKE_PI_STOP_REASON;
const errorMessage = process.env.FAKE_PI_ERROR_MESSAGE;
const turnDelay = Number(process.env.FAKE_PI_TURN_DELAY_MS ?? "10");
const sessionDelayMs = Number(process.env.FAKE_PI_SESSION_DELAY_MS ?? "0");

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const messageEnd = (i) => {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text: `fake answer ${i}` }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
      totalTokens: 2,
    },
    model: "fake/model",
  };
  if (stopReason) msg.stopReason = stopReason;
  if (errorMessage) msg.errorMessage = errorMessage;
  return msg;
};

if (writeSession && sessionDir && sessionId) {
  if (sessionDelayMs > 0)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, sessionDelayMs));
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(sessionDir, `${ts}_${sessionId}.jsonl`);
  const now = new Date().toISOString();
  const lines = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: now,
      cwd: process.cwd(),
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: now,
      message: {
        role: "user",
        content: [{ type: "text", text: prompt.slice(0, 500) }],
      },
    },
  ];
  for (let i = 1; i <= turns; i++) {
    lines.push({
      type: "message",
      id: `a${i}`,
      parentId: i === 1 ? "u1" : `a${i - 1}`,
      timestamp: now,
      message: messageEnd(i),
    });
  }
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

out({ type: "agent_start" });

// NEW-001: Pi auto-retry replay. FAKE_PI_RETRY=recover -> error, agent_end,
// fresh agent_start, successful message, agent_end, exit 0. =fail -> the
// retry produces no message at all, so the terminal failure must survive.
const retry = process.env.FAKE_PI_RETRY;
if (retry === "recover" || retry === "fail") {
  const failedEnd = () => {
    const m = messageEnd(1);
    m.stopReason = "error";
    m.errorMessage = "first attempt failed";
    return m;
  };
  out({ type: "agent_start" });
  out({ type: "turn_start", turnIndex: 0 });
  await new Promise((r) => setTimeout(r, turnDelay));
  out({ type: "message_end", message: failedEnd() });
  await new Promise((r) => setTimeout(r, turnDelay));
  out({ type: "agent_end", messages: [] });
  out({ type: "agent_start" });
  out({ type: "turn_start", turnIndex: 0 });
  if (retry === "recover") {
    await new Promise((r) => setTimeout(r, turnDelay));
    out({ type: "message_end", message: messageEnd(2) });
    await new Promise((r) => setTimeout(r, turnDelay));
  }
  out({ type: "agent_end", messages: [] });
  process.exit(0);
}

for (let i = 1; i <= turns; i++) {
  out({ type: "turn_start", turnIndex: i - 1 });
  await new Promise((r) => setTimeout(r, turnDelay));
  out({ type: "message_end", message: messageEnd(i) });
  await new Promise((r) => setTimeout(r, turnDelay));
}
out({ type: "agent_end", messages: [] });
if (exitAfter) process.exit(0);
// Stay alive until the parent aborts/kills us (hard-abort observability).
// A bare pending promise does NOT hold node's event loop; the interval does.
setInterval(() => {}, 1 << 30);
await new Promise(() => {});
