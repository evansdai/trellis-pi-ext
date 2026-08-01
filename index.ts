import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isUtf8 } from "node:buffer";

// ── Types ──────────────────────────────────────────────────────────────
type JsonObject = Record<string, unknown>;
type TextContent = { type: "text"; text: string };
interface PiToolResult {
  content: TextContent[];
  details?: unknown;
}
interface PiExtensionContext {
  hasUI?: boolean;
  model?: {
    provider?: string;
    id?: string;
  };
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  /** Pi surfaces this on the tool-execution context (see agent-session.js). */
  isProjectTrusted?: () => boolean;
  ui?: {
    notify?: (msg: string, type?: "info" | "warning" | "error") => void;
  };
}
interface SubagentInput {
  agent?: string;
  prompt?: string;
  mode?: "single" | "parallel" | "chain";
  prompts?: string[];
  model?: string;
  thinking?: string;
}
interface AgentConfig {
  model?: string;
  thinking?: string;
  tools?: string[];
  fallbackModels: string[];
  /** gotgenes dialect: explicit "append" only; absent keeps replace-style behavior. */
  promptMode?: "append" | "replace";
  /** gotgenes dialect: parsed; full conversation-forking semantics deferred. */
  inheritContext?: boolean;
  /** gotgenes dialect: integer >= 0; 0/unset = unlimited. */
  maxTurns?: number;
}
interface PiRunConfig {
  model?: string;
  thinking?: string;
  tools?: string[];
  maxTurns?: number;
}

// ── Lazy-load pi-tui (avoid failing top-level imports) ─────────────────
let _piTui: {
  visibleWidth?: (s: string) => number;
  truncateToWidth?: (s: string, w: number, ellipsis?: string) => string;
} | null = null;
function piTui() {
  if (!_piTui) {
    try {
      // Approved compatibility exception (TCF-005): inherited verbatim from
      // the trellis template. pi-tui is CommonJS; the synchronous require is
      // required for this lazy-load pattern. Do NOT refactor to a top-level
      // ESM import — keep the lazy require so truncation degrades gracefully
      // when pi-tui is absent.
      _piTui = require("@earendil-works/pi-tui");
    } catch {
      _piTui = {};
    }
  }
  return _piTui;
}
function trunc(s: string, w: number) {
  const t = piTui();
  if (t?.truncateToWidth) return t.truncateToWidth(s, w, "…");
  return s.length <= w ? s : w > 1 ? s.slice(0, w - 1) + "…" : s.slice(0, w);
}

// ── Constants ─────────────────────────────────────────────────────────
const TRELLIS_AGENT_JSONL: Record<string, string> = {
  "trellis-implement": "implement.jsonl",
  implement: "implement.jsonl",
  "trellis-check": "check.jsonl",
  check: "check.jsonl",
};
const MAX_STDOUT = 8 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;
const MAX_TAIL = 256 * 1024;
const MAX_LINE_BUFFER = 1024 * 1024;
const MAX_TOOL_ARG_CHARS = 2048;
const MAX_TOOLS = 256;
const MAX_PARALLEL_PROMPTS = 6;
const ABORT_KILL_GRACE_MS = 1500;
// ── max_turns enforcement + fleet producer ──────────────────────────────
/** Assistant-turn grace beyond max_turns before the hard abort. */
const GRACE_TURNS = 2;
/** Stale "running" fleet records older than this are reconciled at startup. */
const RECONCILE_MIN_AGE_MS = 60_000;
/** FleetRunRecord v1 disk contract (see fleet-core fleet-record-v1.mjs). */
const FLEET_RECORD_VERSION = 1;
const FLEET_RUN_DIR = "trellis";
/**
 * Trellis agent names must be a basename only. The name is tool-controlled and
 * flows into agent-file paths and fleet record/session names, so anything that
 * does not match is rejected outright (no `../`, no separators, no absolute
 * paths). The `trellis-` prefix is required after normalization.
 */
const AGENT_NAME_RE = /^trellis-[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Fleet ids are derived from sanitized run state; must stay basename-safe. */
const FLEET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Throttle for the fleet owner-marker refresh (see refreshFleetOwnerMarker). */
const FLEET_MARKER_REFRESH_MS = 30_000;
/** Best-effort steering write at the turn limit (see runPi). */
const TURN_LIMIT_STEERING =
  "wrap up now — provide your final answer for the delegated task and stop.";
const SESSION_OVERVIEW_TIMEOUT_MS = 1500;
const THROTTLE_MS = 500;
const SUBAGENT_SESSION_CREATED = "subagents:child:session-created";
const SUBAGENT_SESSION_DISPOSED = "subagents:child:disposed";
// Process-realm shared state. Pi's extension loader clears its factory cache
// when the session cwd changes and re-imports the module via jiti with
// `moduleCache: false`, so a child binding gets a fresh module instance whose
// module-local state is empty. Keying on Symbol.for stores one child-ID Set on
// globalThis that every module instance in the process reads/writes, so the set
// the parent populated before the child bound extensions is visible to the
// child. The WeakSet tracks event buses already subscribed so each distinct
// parent bus registers its lifecycle listeners once and duplicate bindings
// (same bus, reloads) do not accumulate handlers.
const CHILD_IDS_SYMBOL = Symbol.for("trellis.pi.communityChildSessionIds");
const SUBSCRIBED_BUSES_SYMBOL = Symbol.for("trellis.pi.subscribedLifecycleBuses");
function communityChildSessionIds(): Set<string> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const existing = g[CHILD_IDS_SYMBOL];
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  g[CHILD_IDS_SYMBOL] = created;
  return created;
}
function subscribedLifecycleBuses(): WeakSet<object> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const existing = g[SUBSCRIBED_BUSES_SYMBOL];
  if (existing instanceof WeakSet) return existing as WeakSet<object>;
  const created = new WeakSet<object>();
  g[SUBSCRIBED_BUSES_SYMBOL] = created;
  return created;
}
const FIRST_REPLY_NOTICE = `<first-reply-notice>
On the first visible assistant reply in this session, briefly acknowledge that Trellis SessionStart context loaded.
Choose the acknowledgment language in this order:
1. Use the language of the user's current request (the user message that triggered this reply).
2. If that request has no clear natural language, use an explicitly established project communication language.
3. If neither provides a language, output the language-neutral fallback exactly: \`Trellis SessionStart ✓\`.
Continue directly with the user's request after the acknowledgment.
The acknowledgment must not alter the language used for the remainder of the response.
This notice is one-shot: do not repeat it after the first visible assistant reply in this session.
</first-reply-notice>`;

// ── State types ───────────────────────────────────────────────────────
type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
type ToolStatus = "running" | "succeeded" | "failed";

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  ctxTokens: number;
  turns: number;
}
interface ToolTrace {
  id: string;
  name: string;
  args: string;
  status: ToolStatus;
  startedAt: number;
  finishedAt?: number;
}
interface RunState {
  id: string;
  agent: string;
  prompt: string;
  step?: number;
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  finalText: string;
  textTail: string;
  thinkingTail: string;
  stderrTail: string;
  tools: ToolTrace[];
  usage: Usage;
  model?: string;
  thinking?: string;
  errorMessage?: string;
}
interface ProgressDetails {
  kind: "trellis-subagent-progress";
  agent: string;
  mode: "single" | "parallel" | "chain";
  startedAt: number;
  updatedAt: number;
  final: boolean;
  runs: RunState[];
}

// ── Native partial-update card state ──────────────────────────────────
interface NativeCardHandle {
  state: JsonObject;
  invalidate: () => void;
  updatedAt: number;
}
const MAX_NATIVE_CARDS = 20;
const nativeCards = new Map<string, NativeCardHandle>();
let activeSubagentToolCallId: string | null = null;
function rememberNativeCard(id: string, card: NativeCardHandle) {
  nativeCards.set(id, card);
  const active = activeSubagentToolCallId
    ? nativeCards.get(activeSubagentToolCallId)
    : undefined;
  if (!active || card.updatedAt >= active.updatedAt)
    activeSubagentToolCallId = id;
  for (const key of nativeCards.keys()) {
    if (nativeCards.size <= MAX_NATIVE_CARDS) break;
    if (key !== activeSubagentToolCallId) nativeCards.delete(key);
  }
}
function totalUsage(d: ProgressDetails): Usage {
  const u: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    ctxTokens: 0,
    turns: 0,
  };
  for (const r of d.runs) {
    u.input += r.usage.input;
    u.output += r.usage.output;
    u.cacheRead += r.usage.cacheRead;
    u.cacheWrite += r.usage.cacheWrite;
    u.cost += r.usage.cost;
    u.ctxTokens = Math.max(u.ctxTokens, r.usage.ctxTokens);
    u.turns += r.usage.turns;
  }
  return u;
}
function activeRun(d: ProgressDetails) {
  return d.runs.find((r) => r.status === "running") ?? d.runs.at(-1);
}
function toolArgs(t: ToolTrace) {
  try {
    return JSON.parse(t.args) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function bashCommand(t: ToolTrace) {
  const a = toolArgs(t);
  return String(a.command || "").toLowerCase();
}
function isSearchTool(t: ToolTrace) {
  return t.name === "read" || t.name === "grep" || t.name === "find";
}
function isMutationTool(t: ToolTrace) {
  return t.name === "edit" || t.name === "write";
}
function isValidationCommand(t: ToolTrace) {
  const c = bashCommand(t);
  return /\b(test|typecheck|lint|build|gofmt|go test|npm run|pnpm|vitest|tsc)\b/.test(
    c,
  );
}
function isInspectionCommand(t: ToolTrace) {
  const c = bashCommand(t);
  return /\b(rg|grep|find|git diff|git status|ls|tree)\b/.test(c);
}
function thinkingIntent(text: string) {
  const s = text.toLowerCase();
  if (/error|failed|failure|panic|exception|报错|失败|错误|异常/.test(s))
    return "Analyzing failure cause";
  if (/test|verify|check|typecheck|lint|验证|测试|检查/.test(s))
    return "Planning verification steps";
  if (/plan|approach|design|strategy|方案|计划|思路|设计/.test(s))
    return "Structuring the implementation approach";
  if (/implement|change|edit|modify|refactor|实现|修改|重构/.test(s))
    return "Reasoning through code changes";
  if (/inspect|search|locate|read|context|定位|搜索|阅读|上下文/.test(s))
    return "Locating relevant context";
  return "";
}
function behaviorSummary(r: RunState) {
  if (r.status === "succeeded") return "Task completed and result returned";
  if (r.status === "failed")
    return "Task failed and error details were retained";

  const runningTool = r.tools.findLast((t) => t.status === "running");
  if (runningTool) {
    if (isMutationTool(runningTool)) return "Applying the plan to code";
    if (runningTool.name === "bash" && isValidationCommand(runningTool))
      return "Verifying whether the implementation passes";
    if (runningTool.name === "bash" && isInspectionCommand(runningTool))
      return "Inspecting current code state";
    if (isSearchTool(runningTool)) return "Locating relevant code and context";
    if (runningTool.name === "bash")
      return "Validating assumptions with commands";
    return "Using tools to advance the task";
  }

  const recent = r.tools.slice(-5);
  if (recent.some((t) => t.status === "failed"))
    return "Investigating tool or command failure";
  if (recent.some(isMutationTool)) return "Reviewing recent changes";
  if (recent.some((t) => t.name === "bash" && isValidationCommand(t)))
    return "Analyzing verification results";
  if (
    recent.length >= 2 &&
    recent.every(
      (t) => isSearchTool(t) || (t.name === "bash" && isInspectionCommand(t)),
    )
  )
    return "Mapping code structure and impact";

  const intent = thinkingIntent(`${r.thinkingTail}\n${r.textTail}`);
  if (intent) return intent;
  if (!r.tools.length) return "Understanding the task and planning execution";
  return "Advancing the task and preparing next steps";
}
function progressState(d: ProgressDetails) {
  const running = d.runs.filter((r) => r.status === "running").length;
  const failed = d.runs.some((r) => r.status === "failed");
  return failed
    ? "failed"
    : d.final
      ? "completed"
      : running
        ? `${running} running`
        : "pending";
}
function progressDone(d: ProgressDetails) {
  return d.runs.filter((r) => r.status !== "pending" && r.status !== "running")
    .length;
}
function summaryText(text: string) {
  return `${text.trim().replace(/[。.!?…]+$/u, "")}...`;
}
function splitModelThinking(model?: string, fallbackThinking?: string) {
  const m = model?.match(/^(.*):(off|minimal|low|medium|high|xhigh|max)$/i);
  return {
    model: m ? m[1] : model,
    thinking: (m?.[2] ?? fallbackThinking)?.toLowerCase(),
  };
}
function modelLabel(r: RunState) {
  const { model, thinking } = splitModelThinking(r.model, r.thinking);
  if (!model) return undefined;
  return thinking && thinking !== "off" ? `${model}(${thinking})` : model;
}
function applyRunConfig(r: RunState, cfg: PiRunConfig) {
  const parsed = splitModelThinking(cfg.model, cfg.thinking);
  r.model = parsed.model;
  r.thinking = parsed.thinking;
}
function runElapsed(d: ProgressDetails, r: RunState) {
  const start = r.startedAt ?? d.startedAt;
  const end =
    r.finishedAt ?? (r.status === "running" ? Date.now() : d.updatedAt);
  return fmtDur(Math.max(0, end - start));
}
function runHeader(d: ProgressDetails, r: RunState) {
  const usage = fmtUsage(r.usage, modelLabel(r)) || fmtUsage(totalUsage(d));
  return `${r.agent} · ${progressDone(d)}/${d.runs.length} done · ${progressState(d)} · ${runElapsed(d, r)}${usage ? ` · ${usage}` : ""}`;
}
function renderRunBlock(
  lines: string[],
  d: ProgressDetails,
  run: RunState,
  expanded: boolean,
) {
  const step = run.step ? `step ${run.step} · ` : "";
  lines.push(`  - ${step}${runHeader(d, run)}`);
  const summary = behaviorSummary(run);
  if (summary) lines.push(`    › ${summaryText(summary)}`);
  const visibleTools = expanded ? run.tools.slice(-8) : run.tools.slice(-1);
  for (const t of visibleTools)
    lines.push(`    ${toolIcon(t.status)} ${toolBrief(t)}`);
  if (expanded && run.errorMessage) {
    lines.push(`    ✗ ${oneLine(run.errorMessage, 120)}`);
  }
}
function renderProgressCard(
  d: ProgressDetails,
  expanded: boolean,
  w: number,
): string[] {
  const r = activeRun(d);
  if (!r) return [];
  const spinner = ["◐", "◓", "◑", "◒"][Math.floor(Date.now() / 250) % 4]!;
  const icon = d.final
    ? d.runs.some((x) => x.status === "failed")
      ? "✗"
      : "✓"
    : spinner;
  const totalElapsed = fmtDur(
    (d.final ? d.updatedAt : Date.now()) - d.startedAt,
  );
  const lines: string[] = [
    `${icon} subagent ${d.mode} · total ${totalElapsed}`,
  ];

  if (!expanded) {
    renderRunBlock(lines, d, r, false);
    lines.push("  Alt+O expand latest subagent card");
    return lines.map((l) => trunc(l, w));
  }

  for (const run of d.runs) renderRunBlock(lines, d, run, true);
  lines.push("  Alt+O collapse latest subagent card");
  const max = 48;
  const shown =
    lines.length > max
      ? [
          ...lines.slice(0, max - 1),
          `  … ${lines.length - max + 1} lines hidden`,
        ]
      : lines;
  return shown.map((l) => trunc(l, w));
}
function progressKey(d: ProgressDetails) {
  return d.runs
    .map((r) => {
      const t = r.tools.at(-1);
      return [
        r.id,
        r.status,
        r.tools.length,
        t?.id ?? "",
        t?.status ?? "",
        r.usage.turns,
        r.usage.input,
        r.usage.output,
        r.usage.cacheRead,
        r.usage.cacheWrite,
        r.usage.ctxTokens,
        r.model ?? "",
        r.thinking ?? "",
        r.errorMessage ?? "",
      ].join("~");
    })
    .join("|");
}

// ── Utilities ─────────────────────────────────────────────────────────
function isObj(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function childSessionId(data: unknown): string | null {
  return isObj(data) ? str(data.sessionId) : null;
}
function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}
function readText(p: string) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}
function exists(p: string) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function shellQuote(v: string) {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
function callStr(cb: (() => string | undefined) | undefined): string | null {
  if (!cb) return null;
  try {
    return str(cb());
  } catch {
    return null;
  }
}
function lookupStr(data: unknown, keys: string[]): string | null {
  if (!isObj(data)) return null;
  for (const k of keys) {
    const v = str(data[k]);
    if (v) return v;
  }
  for (const nk of [
    "input",
    "properties",
    "event",
    "hook_input",
    "hookInput",
  ]) {
    const nested = data[nk];
    const v = lookupStr(nested, keys);
    if (v) return v;
  }
  return null;
}
function cmdHasTrellisCtx(cmd: string) {
  const t = cmd.trimStart();
  return (
    /^export\s+TRELLIS_CONTEXT_ID=/.test(t) ||
    /^TRELLIS_CONTEXT_ID=/.test(t) ||
    /^env\s+.*TRELLIS_CONTEXT_ID=/.test(t)
  );
}
function fmtDur(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}
function fmtNum(n: number) {
  if (!n) return "0";
  if (Math.abs(n) < 1000) return `${n}`;
  if (Math.abs(n) < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(1)}m`;
}
function fmtUsage(u: Usage, m?: string) {
  const p: string[] = [];
  if (u.turns) p.push(`${u.turns}t`);
  if (u.input) p.push(`↑${fmtNum(u.input)}`);
  if (u.output) p.push(`↓${fmtNum(u.output)}`);
  if (u.cost) p.push(`$${u.cost.toFixed(3)}`);
  if (u.ctxTokens) p.push(`ctx:${fmtNum(u.ctxTokens)}`);
  if (m) p.push(m);
  return p.join(" ");
}
function statusIcon(s: RunStatus) {
  return s === "pending"
    ? "○"
    : s === "running"
      ? "●"
      : s === "succeeded"
        ? "✓"
        : s === "failed"
          ? "✗"
          : "⊘";
}
function toolIcon(s: ToolStatus) {
  return s === "running" ? "•" : s === "succeeded" ? "✓" : "✗";
}
function latest(text: string, n: number) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}
function appendTail(cur: string, next: string, max: number) {
  if (!next) return cur;
  const c = cur + next;
  return c.length <= max ? c : c.slice(-max);
}
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      isObj(b) && b.type === "text" && typeof b.text === "string" ? b.text : "",
    )
    .join("");
}
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      isObj(b) && b.type === "thinking" && typeof b.thinking === "string"
        ? b.thinking
        : "",
    )
    .join("\n");
}
function newUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    ctxTokens: 0,
    turns: 0,
  };
}
export function newRun(
  id: string,
  agent: string,
  prompt: string,
  step?: number,
): RunState {
  return {
    id,
    agent,
    prompt: trunc(prompt.replace(/\s+/g, " ").trim(), 120) || "(empty)",
    step,
    status: "pending",
    finalText: "",
    textTail: "",
    thinkingTail: "",
    stderrTail: "",
    tools: [],
    usage: newUsage(),
  };
}
function cloneProgress(d: ProgressDetails): ProgressDetails {
  return {
    ...d,
    runs: d.runs.map((r) => ({
      ...r,
      tools: r.tools.map((t) => ({ ...t })),
      usage: { ...r.usage },
    })),
  };
}

function oneLine(v: unknown, max = 80) {
  return String(v || "...")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
function summarizeToolArgs(name: string, args: unknown): string {
  const a = isObj(args) ? args : {};
  const summary: JsonObject = {};
  if ("path" in a) summary.path = oneLine(a.path, 240);
  if ("file_path" in a) summary.file_path = oneLine(a.file_path, 240);
  if ("command" in a) summary.command = oneLine(a.command, 240);
  if ("pattern" in a) summary.pattern = oneLine(a.pattern, 120);
  if ("limit" in a) summary.limit = a.limit;
  if ("offset" in a) summary.offset = a.offset;
  if (name === "edit" && Array.isArray(a.edits))
    summary.edits = `${a.edits.length} edit(s)`;
  if (name === "write" && "content" in a)
    summary.content = `<${String(a.content ?? "").length} chars>`;
  const json = JSON.stringify(
    Object.keys(summary).length ? summary : { tool: name },
  );
  return json.length <= MAX_TOOL_ARG_CHARS
    ? json
    : json.slice(0, MAX_TOOL_ARG_CHARS);
}
function toolBrief(t: ToolTrace): string {
  const a = toolArgs(t);
  if (t.name === "read") return `read: ${oneLine(a.path || a.file_path, 80)}`;
  if (t.name === "bash") return `bash: ${oneLine(a.command, 60)}`;
  if (t.name === "write") return `write: ${oneLine(a.path || a.file_path, 80)}`;
  if (t.name === "edit") return `edit: ${oneLine(a.path || a.file_path, 80)}`;
  if (t.name === "grep") return `grep: ${oneLine(a.pattern, 50)}`;
  if (t.name === "find") return `find: ${oneLine(a.pattern || "*", 50)}`;
  return oneLine(t.name, 50);
}

// ── Pi CLI path resolution ────────────────────────────────────────────
const PI_CLI_SEGMENTS = [
  ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"],
  ["node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"],
];

function resolvePiCli(): { command: string; args: string[] } {
  const envCli = str(process.env.TRELLIS_PI_CLI_JS);
  if (envCli) {
    const p = resolve(envCli);
    if (!exists(p)) throw new Error(`TRELLIS_PI_CLI_JS missing: ${p}`);
    return { command: process.execPath, args: [p] };
  }
  const candidates: string[] = [];
  for (const arg of process.argv)
    if (/pi-coding-agent[\\/]dist[\\/]cli\.js$/i.test(arg))
      candidates.push(resolve(arg));
  const prefix =
    str(process.env.npm_config_prefix) ?? str(process.env.NPM_CONFIG_PREFIX);
  const appData = str(process.env.APPDATA);
  const pathVal = process.env.PATH ?? process.env.Path ?? "";
  const addBase = (base: string) => {
    for (const seg of PI_CLI_SEGMENTS) candidates.push(join(base, ...seg));
  };
  if (prefix) {
    addBase(prefix);
    addBase(join(prefix, "lib"));
  }
  if (appData) addBase(join(appData, "npm"));
  for (const entry of pathVal.split(delimiter)) {
    const e = entry.trim();
    if (!e) continue;
    addBase(e);
    addBase(dirname(e));
    addBase(join(dirname(e), "lib"));
  }
  for (const c of [...new Set(candidates)])
    if (exists(c)) return { command: process.execPath, args: [c] };
  return { command: "pi", args: [] };
}

export function resolveRunCfg(
  input: SubagentInput,
  agentCfg: AgentConfig,
  inheritedThinking?: string,
  inheritedModel?: string,
): PiRunConfig {
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const normalize = (v: unknown): string | undefined => {
    const s = typeof v === "string" && v.trim() ? v.trim().toLowerCase() : "";
    return THINKING_LEVELS.includes(s) ? s : undefined;
  };
  const suffixRe = /:(off|minimal|low|medium|high|xhigh|max)$/i;
  const inputModel = str(input.model);
  const agentModel = agentCfg.model;
  const rawModel = inputModel ?? agentModel ?? str(inheritedModel) ?? undefined;
  const inputSuffixThinking = normalize(inputModel?.match(suffixRe)?.[1]);
  const agentSuffixThinking = normalize(agentModel?.match(suffixRe)?.[1]);
  const baseModel = rawModel?.replace(suffixRe, "");
  const thinking =
    normalize(input.thinking) ??
    inputSuffixThinking ??
    normalize(agentCfg.thinking) ??
    agentSuffixThinking ??
    normalize(inheritedThinking);
  if (baseModel && thinking && thinking !== "off")
    return {
      model: `${baseModel}:${thinking}`,
      thinking,
      tools: agentCfg.tools,
      maxTurns: agentCfg.maxTurns,
    };
  return {
    model: baseModel || rawModel,
    thinking,
    tools: agentCfg.tools,
    maxTurns: agentCfg.maxTurns,
  };
}

function contextModelRef(ctx?: PiExtensionContext): string | undefined {
  const provider = str(ctx?.model?.provider);
  const modelId = str(ctx?.model?.id);
  return provider && modelId ? `${provider}/${modelId}` : undefined;
}

export function buildPiArgs(cfg: PiRunConfig, fleetId?: string): string[] {
  const args = ["--mode", "json", "-p"];
  if (fleetId) {
    // Fleet producer: persist the child transcript under the fleet runs dir so
    // the run appears in the standalone roster with an openable sessionFile.
    args.push("--session-id", fleetId, "--session-dir", trellisFleetDir());
  } else {
    args.push("--no-session");
  }
  if (cfg.model)
    args.push(
      "--model",
      cfg.thinking && cfg.thinking !== "off" && !cfg.model.includes(":")
        ? `${cfg.model}:${cfg.thinking}`
        : cfg.model,
    );
  else if (cfg.thinking && cfg.thinking !== "off")
    args.push("--thinking", cfg.thinking);
  if (cfg.tools && cfg.tools.length > 0)
    args.push("--tools", cfg.tools.join(","));
  return args;
}

// ── Fleet producer (FleetRunRecord v1) ──────────────────────────────────

type FleetRecordStatus = "running" | "succeeded" | "failed" | "cancelled";

interface FleetRunRecord {
  version: number;
  source: "trellis";
  id: string;
  agent: string;
  status: FleetRecordStatus;
  startedAt: number;
  finishedAt: number | null;
  prompt: string;
  sessionFile: string;
  error: string | null;
}

/** Root fleet runs dir: $PI_FLEET_RUNS_DIR else ~/.pi/fleet/runs. */
export function fleetRunsRoot(): string {
  return (
    str(process.env.PI_FLEET_RUNS_DIR) ?? join(homedir(), ".pi", "fleet", "runs")
  );
}

function trellisFleetDir(): string {
  return join(fleetRunsRoot(), FLEET_RUN_DIR);
}

function toFleetStatus(status: RunStatus): FleetRecordStatus {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/**
 * Pi names session files `<ISO-ts with :/. -> ->_<sessionId>.jsonl`; the
 * timestamp is computed by the child at session init, so discover by the
 * `<fleetId>` suffix and pick the newest. Returns null when no transcript
 * exists yet — callers must never fabricate a path (the child's timestamp is
 * not predictable from the parent's).
 */
export function resolveSessionFile(fleetId: string): string | null {
  if (!FLEET_ID_RE.test(fleetId)) return null;
  const dir = trellisFleetDir();
  let newest: { name: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl") || !name.endsWith(`_${fleetId}.jsonl`))
        continue;
      const mtime = statSync(join(dir, name)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { name, mtime };
    }
  } catch {
    return null; // dir missing — no transcript yet
  }
  return newest ? join(dir, newest.name) : null;
}

function fleetRecordFor(state: RunState, fleetId: string): FleetRunRecord {
  return {
    version: FLEET_RECORD_VERSION,
    source: "trellis",
    id: fleetId,
    agent: state.agent,
    status: toFleetStatus(state.status),
    startedAt: state.startedAt ?? Date.now(),
    finishedAt: state.finishedAt ?? null,
    prompt: state.prompt.slice(0, 200),
    sessionFile: resolveSessionFile(fleetId) ?? "",
    error: state.errorMessage ?? null,
  };
}

/**
 * Write the run record atomically (tmp + rename); best-effort, never breaks a
 * run. Skips silently when the fleet id is unsafe or no real transcript exists
 * yet (never fabricates a sessionFile). Running records carry a sidecar owner
 * marker (`<fleetId>.pid`, pid + process-birth identity) so reconcile can
 * distinguish a dead owner from another process's live run — including a pid
 * that was reused by an unrelated process (NEW-003); terminal writes remove it.
 */
export function writeTrellisFleetRecord(state: RunState, fleetId: string): void {
  try {
    if (!FLEET_ID_RE.test(fleetId)) return; // never trust an unvalidated id
    const file = resolveSessionFile(fleetId);
    if (!file) return; // no real transcript yet — do not fabricate a path
    const dir = trellisFleetDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dest = join(dir, `${fleetId}.json`);
    const tmp = join(dir, `.${fleetId}.${process.pid}.tmp`);
    const record = fleetRecordFor(state, fleetId);
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, dest);
    if (toFleetStatus(state.status) === "running") {
      writeFleetOwnerMarker(fleetId);
    } else {
      removeFleetOwnerMarker(fleetId);
    }
  } catch {
    /* best-effort: fleet records must never break a run */
  }
}

function writeFleetOwnerMarker(fleetId: string): void {
  try {
    const dir = trellisFleetDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, `${fleetId}.pid`),
      JSON.stringify({
        pid: process.pid,
        starttime: processStarttime(process.pid),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
}

function removeFleetOwnerMarker(fleetId: string): void {
  try {
    unlinkSync(join(trellisFleetDir(), `${fleetId}.pid`));
  } catch {
    /* best-effort */
  }
}

function readFleetOwnerMarker(
  dir: string,
  fleetId: string,
): { pid: number; starttime: number | null } | null {
  if (!FLEET_ID_RE.test(fleetId)) return null;
  try {
    const raw = JSON.parse(readText(join(dir, `${fleetId}.pid`))) as JsonObject;
    const pid = typeof raw.pid === "number" ? raw.pid : NaN;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const starttime =
      typeof raw.starttime === "number" ? raw.starttime : null;
    return { pid, starttime };
  } catch {
    return null;
  }
}

/**
 * Process-birth identity: Linux /proc/<pid>/stat field 22 (starttime, clock
 * ticks since boot). Returns null where unsupported (non-Linux, no /proc
 * permission) — callers then fall back to pid-liveness only, with PID-reuse
 * leakage documented as a known limitation.
 */
export function processStarttime(pid: number): number | null {
  try {
    // Field 2 (comm) may contain spaces/parens, so split after the last ')'
    // (field 3 = state); starttime is the 22nd field -> index 22 - 3 = 19.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const v = Number(stat.slice(close + 1).trim().split(/\s+/)[19]);
    return Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Throttled refresh of the current run's owner marker. Called from the
 * JSON-mode event loop; the marker proves the owner process is alive even for
 * runs started by an earlier pi process. The marker carries a static
 * process-birth identity, not a lease — the refresh only restores a marker
 * deleted mid-run.
 */
let lastFleetMarkerRefresh = 0;
function refreshFleetOwnerMarker(fleetId: string): void {
  const now = Date.now();
  if (now - lastFleetMarkerRefresh < FLEET_MARKER_REFRESH_MS) return;
  lastFleetMarkerRefresh = now;
  writeFleetOwnerMarker(fleetId);
}

/**
 * Reconcile orphaned trellis "running" records at extension startup. A record
 * is only touched when it is at least RECONCILE_MIN_AGE_MS old, and only when
 * the owner can be proven dead: the session transcript is missing (a live run
 * always has one), the owner marker's pid is no longer alive, or the pid is
 * alive but its process-birth identity differs from the marker's (the pid was
 * reused by an unrelated process — NEW-003). Anything uncertain is left as
 * `running` — never cancel another process's live run.
 */
export function reconcileFleetRuns(): void {
  const dir = trellisFleetDir();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return; // no runs dir yet — nothing to reconcile
  }
  const now = Date.now();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const dest = join(dir, file);
    let record: JsonObject;
    try {
      record = JSON.parse(readText(dest)) as JsonObject;
    } catch {
      continue; // unparseable — leave for the roster to skip
    }
    if (record.status !== "running" || record.version !== FLEET_RECORD_VERSION)
      continue;
    const startedAt =
      typeof record.startedAt === "number" ? record.startedAt : 0;
    if (now - startedAt < RECONCILE_MIN_AGE_MS) continue;
    const id =
      typeof record.id === "string" && FLEET_ID_RE.test(record.id)
        ? record.id
        : "";
    let sessionFile =
      typeof record.sessionFile === "string" && record.sessionFile
        ? record.sessionFile
        : "";
    if (!sessionFile && id) sessionFile = resolveSessionFile(id) ?? "";
    if (sessionFile && !exists(sessionFile)) {
      // A live run always has its transcript; a missing one proves the run is
      // dead (or its transcript was cleaned) — the record is unopenable, so
      // drop it rather than preserve a bogus path.
      try {
        unlinkSync(dest);
        if (id) removeFleetOwnerMarker(id);
      } catch {
        /* best-effort */
      }
      continue;
    }
    if (!sessionFile) {
      // No transcript at all and none discoverable — drop the unopenable record.
      try {
        unlinkSync(dest);
      } catch {
        /* best-effort */
      }
      continue;
    }
    let reason = "";
    if (id) {
      const owner = readFleetOwnerMarker(dir, id);
      if (owner && !pidAlive(owner.pid)) {
        reason = "owner process exited";
      } else if (owner && owner.starttime != null) {
        const current = processStarttime(owner.pid);
        if (current != null && current !== owner.starttime) {
          // The pid is alive but is a DIFFERENT process than the owner: the old
          // owner is dead and its pid was reused. Without this identity check a
          // reused pid would keep the orphaned record "running" forever.
          reason = "owner pid reused by a different process";
        }
      }
      // No marker, or a live owner with a matching birth identity (or an
      // unsupported /proc): uncertain -> leave as running.
    }
    if (!reason) continue;
    const cancelled: FleetRunRecord = {
      version: FLEET_RECORD_VERSION,
      source: "trellis",
      id: id || file.slice(0, -5),
      agent: typeof record.agent === "string" ? record.agent : "unknown",
      status: "cancelled",
      startedAt,
      finishedAt: now,
      prompt:
        typeof record.prompt === "string" ? record.prompt.slice(0, 200) : "",
      sessionFile,
      error: `interrupted (stale trellis run reconciled at startup; ${reason})`,
    };
    try {
      const tmp = join(dir, `.${file}.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(cancelled, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tmp, dest);
      removeFleetOwnerMarker(id);
    } catch {
      /* best-effort */
    }
  }
}

// ── BoundedBufferCollector ─────────────────────────────────────────────
class BBC {
  private c: Buffer[] = [];
  private len = 0;
  private trunc = 0;
  constructor(private max: number) {}
  append(b: Buffer) {
    if (b.length >= this.max) {
      this.trunc += this.len + b.length - this.max;
      this.c = [b.subarray(b.length - this.max)];
      this.len = this.max;
      return;
    }
    this.c.push(b);
    this.len += b.length;
    while (this.len > this.max) {
      const f = this.c[0]!;
      if (f.length <= this.len - this.max) {
        this.c.shift();
        this.len -= f.length;
        this.trunc += f.length;
      } else {
        const ov = this.len - this.max;
        this.c[0] = f.subarray(ov);
        this.len -= ov;
        this.trunc += ov;
        break;
      }
    }
  }
  toString() {
    const body = Buffer.concat(this.c, this.len).toString("utf-8");
    return this.trunc ? `[${this.trunc} bytes truncated]\n${body}` : body;
  }
}

// ── Context Injection Limits (issue #441) ───────────────────────────────
//
// Notice text and behavior mirrored byte-for-byte from the shared-hooks
// Python sub-agent context injection hook. Changing wording there requires
// changing it here too.
interface ContextInjectionLimits {
  max_file_bytes: number;
  max_artifact_bytes: number;
  max_total_bytes: number;
}
const DEFAULT_CONTEXT_INJECTION_LIMITS: ContextInjectionLimits = {
  max_file_bytes: 32768,
  max_artifact_bytes: 65536,
  max_total_bytes: 131072,
};

function truncateUtf8(buf: Buffer, cap: number): Buffer {
  if (cap <= 0 || buf.length <= cap) return buf;
  let i = cap;
  // Back off over continuation bytes (10xxxxxx) to find the lead byte.
  while (i > 0 && (buf[i - 1]! & 0xc0) === 0x80) i--;
  if (i === 0) return Buffer.alloc(0);
  const lead = buf[i - 1]!;
  if (lead & 0x80) {
    let seqLen = 1;
    if ((lead & 0xe0) === 0xc0) seqLen = 2;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xf8) === 0xf0) seqLen = 4;
    // Drop the lead byte too if its full sequence didn't fit.
    if (i - 1 + seqLen > cap) i--;
  }
  return buf.subarray(0, i);
}

function stripInlineComment(value: string): string {
  let inQuote: string | null = null;
  for (let idx = 0; idx < value.length; idx++) {
    const ch = value[idx]!;
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "#" && (idx === 0 || /\s/.test(value[idx - 1]!)))
      return value.slice(0, idx);
  }
  return value;
}
function unquoteYaml(s: string): string {
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'"))
    return s.slice(1, -1);
  return s;
}

/** Line-based parser for ONLY the `context_injection:` block of
 * `.trellis/config.yaml`. Not a general YAML parser — mirrors
 * `common.config.get_context_injection_limits()` semantics for this
 * section only (missing keys keep the default; invalid/negative values
 * fall back to the default for that key). */
function readContextInjectionLimits(repoRoot: string): ContextInjectionLimits {
  const limits: ContextInjectionLimits = { ...DEFAULT_CONTEXT_INJECTION_LIMITS };
  const text = readText(join(repoRoot, ".trellis", "config.yaml"));
  if (!text) return limits;

  let inSection = false;
  let sectionIndent = -1;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!inSection) {
      if (/^context_injection\s*:\s*(#.*)?$/.test(trimmed)) {
        inSection = true;
        sectionIndent = rawLine.length - rawLine.trimStart().length;
      }
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent <= sectionIndent) break;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    if (!(key in limits)) continue;
    const raw = unquoteYaml(stripInlineComment(m[2]!).trim()).trim();
    if (!/^-?\d+$/.test(raw)) continue; // invalid -> keep default
    const value = parseInt(raw, 10);
    if (value < 0) continue; // negative -> keep default
    (limits as unknown as Record<string, number>)[key] = value;
  }
  return limits;
}

class ContextBudget {
  used = 0;
  constructor(private maxTotalBytes: number) {}
  hasRoom(size: number): boolean {
    if (this.maxTotalBytes <= 0) return true;
    return this.used + size <= this.maxTotalBytes;
  }
  add(size: number): void {
    this.used += size;
  }
}

function truncateNotice(path: string, cap: number): string {
  return `\n[Trellis: truncated at ${cap} bytes — read ${path} for the full content]`;
}
function isBinaryContent(data: Buffer): boolean {
  return data.includes(0) || !isUtf8(data);
}
function binaryNotice(path: string, size: number, reason: string): string {
  return `[Trellis: not inlined (binary file) — ${path} (${size} bytes): ${reason}]`;
}
function indexNotice(path: string, size: number, reason: string): string {
  return `[Trellis: not inlined (total context limit reached) — ${path} (${size} bytes): ${reason}]`;
}
function budgetedBlock(
  budget: ContextBudget,
  header: string,
  plainPath: string,
  content: string,
  reason: string,
  sizeForIndex: number,
): string {
  const block = `=== ${header} ===\n${content}`;
  const blockBytes = Buffer.byteLength(block, "utf-8");
  if (!budget.hasRoom(blockBytes)) {
    const notice = indexNotice(plainPath, sizeForIndex, reason);
    budget.add(Buffer.byteLength(notice, "utf-8"));
    return notice;
  }
  budget.add(blockBytes);
  return block;
}
function readFileBytes(basePath: string, filePath: string): Buffer | null {
  const full = join(basePath, filePath);
  try {
    if (!statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  try {
    return readFileSync(full);
  } catch {
    return null;
  }
}
function materializeFile(
  basePath: string,
  filePath: string,
  reason: string,
  limits: ContextInjectionLimits,
  budget: ContextBudget,
): string | null {
  const data = readFileBytes(basePath, filePath);
  if (data === null) return null;
  const size = data.length;
  if (isBinaryContent(data)) {
    const notice = binaryNotice(filePath, size, reason);
    budget.add(Buffer.byteLength(notice, "utf-8"));
    return notice;
  }
  const cap = limits.max_file_bytes;
  const truncated = truncateUtf8(data, cap);
  let content = truncated.toString("utf-8");
  if (truncated.length < size) content += truncateNotice(filePath, cap);
  return budgetedBlock(budget, filePath, filePath, content, reason, size);
}
function materializeArtifact(
  basePath: string,
  filePath: string,
  headerLabel: string,
  reason: string,
  limits: ContextInjectionLimits,
  budget: ContextBudget,
): string | null {
  const data = readFileBytes(basePath, filePath);
  if (data === null) return null;
  const size = data.length;
  const cap = limits.max_artifact_bytes;
  const truncated = truncateUtf8(data, cap);
  let content = truncated.toString("utf-8");
  if (truncated.length < size) content += truncateNotice(filePath, cap);
  return budgetedBlock(budget, headerLabel, filePath, content, reason, size);
}
interface JsonlEntry {
  file: string;
  type: string;
  reason: string;
}
function readJsonlEntries(basePath: string, jsonlPath: string): JsonlEntry[] {
  const text = readText(join(basePath, jsonlPath));
  if (!text) return [];
  const entries: JsonlEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const item = JSON.parse(t) as JsonObject;
      const filePath =
        (typeof item.file === "string" && item.file) ||
        (typeof item.path === "string" && item.path) ||
        "";
      if (!filePath) continue;
      entries.push({
        file: filePath,
        type: typeof item.type === "string" ? item.type : "file",
        reason: (typeof item.reason === "string" && item.reason) || "-",
      });
    } catch {}
  }
  return entries;
}

// ── Trellis Context ────────────────────────────────────────────────────
function findRoot(start: string): string {
  let c = resolve(start);
  while (true) {
    if (existsSync(join(c, ".trellis")) || existsSync(join(c, ".pi"))) return c;
    const p = dirname(c);
    if (p === c) return resolve(start);
    c = p;
  }
}

// True when <root>/.pi/settings.json still loads the generated Trellis
// extension (./extensions/trellis/index.ts). The fork is a global pi package
// and must yield to the generated ext in such projects, otherwise pi reports
// a "Tool 'trellis_subagent' conflicts with <generated ext>" startup error.
// Missing/unparseable settings.json or unrelated entries -> false (fork
// active). Matches `./extensions/trellis/index.ts`, `extensions/trellis/index.ts`,
// and absolute forms.
export function projectLoadsGeneratedExt(root: string): boolean {
  const settingsPath = join(root, ".pi", "settings.json");
  if (!existsSync(settingsPath)) return false;
  let settings: { extensions?: unknown };
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      extensions?: unknown;
    };
  } catch {
    return false;
  }
  if (!Array.isArray(settings.extensions)) return false;
  return settings.extensions.some((entry) => {
    if (typeof entry !== "string") return false;
    const resolved = join(root, ".pi", entry.replace(/^\.\//, ""))
      .split(sep)
      .join("/");
    return resolved.endsWith("extensions/trellis/index.ts");
  });
}
function splitFM(c: string) {
  const m = c.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m
    ? { fm: m[1] ?? "", body: c.slice(m[0].length) }
    : { fm: "", body: c };
}
function stripFM(c: string) {
  return splitFM(c).body.trimStart();
}
export function parseAgentFM(c: string): AgentConfig {
  const cfg: AgentConfig = { fallbackModels: [] };
  const { fm } = splitFM(c);
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1] ?? "",
      v = m[2] ?? "";
    // Supported frontmatter syntax is a documented YAML scalar subset: plain
    // scalars, single/double-quoted scalars, flow lists `[a, b]`, block lists
    // `- item`, and `#` inline comments (quote-aware). YAML booleans and
    // integers are honored (case-insensitive true/false). Nested YAML
    // structures, anchors/aliases, and multi-line quoted scalars are NOT
    // supported — keep agent frontmatter flat. Invalid values are dropped
    // (gotgenes semantics), never coerced.
    const clean = (raw: string) =>
      unquoteYaml(stripInlineComment(raw).trim()).trim();
    const val = clean(v);
    if (k === "model")
      cfg.model = val || undefined;
    else if (k === "thinking")
      cfg.thinking = (val || undefined) as string | undefined;
    else if (k === "fallbackModels" || k === "fallback_models") {
      if (val) {
        cfg.fallbackModels = val
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(clean)
          .filter(Boolean);
      } else {
        i++;
        while (i < lines.length && /^\s+-\s/.test(lines[i] ?? "")) {
          const item = clean((lines[i] ?? "").replace(/^\s+-\s+/, ""));
          if (item) cfg.fallbackModels.push(item);
          i++;
        }
        i--;
      }
    } else if (k === "tools") {
      // Pi tool names are lowercase (read, bash, edit, write, grep, find, ls).
      // Normalize to lowercase so mixed-case frontmatter still matches.
      if (val) {
        cfg.tools = val
          .split(",")
          .map((s) => clean(s).toLowerCase())
          .filter(Boolean);
      }
    } else if (k === "prompt_mode") {
      // gotgenes dialect: only an explicit "append" is honored; absent keeps
      // the Trellis replace-style behavior (agent body is the system prompt).
      cfg.promptMode = val === "append" ? "append" : "replace";
    } else if (k === "inherit_context") {
      // gotgenes dialect: YAML booleans are case-insensitive; parsed only,
      // full conversation-forking semantics deferred.
      cfg.inheritContext = val.toLowerCase() === "true";
    } else if (k === "max_turns") {
      // gotgenes dialect: non-negative integer; 0/unset = unlimited.
      const n = Number(val);
      cfg.maxTurns = Number.isInteger(n) && n >= 0 ? n : undefined;
    }
  }
  return cfg;
}

function contextKey(input?: unknown, ctx?: PiExtensionContext): string | null {
  const ov = str(process.env.TRELLIS_CONTEXT_ID);
  if (ov) return ov.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160) || hash(ov);
  // Pi's SessionManager methods read `this`; pass a receiver-preserving arrow
  // rather than the detached method reference, which would lose `this` and
  // throw -> callStr returns null -> identity silently lost.
  const sessionId =
    callStr(() => ctx?.sessionManager?.getSessionId?.()) ??
    str(process.env.PI_SESSION_ID) ??
    str(process.env.PI_SESSIONID) ??
    lookupStr(input, ["session_id", "sessionId", "sessionID"]);
  if (sessionId)
    return `pi_${sessionId.replace(/[^A-Za-z0-9._-]+/g, "_") || hash(sessionId)}`;
  const transcriptPath =
    callStr(() => ctx?.sessionManager?.getSessionFile?.()) ??
    lookupStr(input, ["transcript_path", "transcriptPath", "transcript"]);
  if (transcriptPath) return `pi_transcript_${hash(transcriptPath)}`;
  return null;
}

function readTaskDir(root: string, key: string | null): string | null {
  if (!key) return null;
  try {
    const ctx = JSON.parse(
      readText(join(root, ".trellis", ".runtime", "sessions", `${key}.json`)),
    ) as JsonObject;
    let ref = str(ctx.current_task);
    if (!ref) return null;
    ref = ref;
    ref = ref.replace(/\\/g, "/").replace(/^\.\//, "");
    if (ref.startsWith("tasks/")) ref = `.trellis/${ref}`;
    return ref.startsWith(".trellis/")
      ? join(root, ref)
      : isAbsolute(ref)
        ? ref
        : join(root, ".trellis", "tasks", ref);
  } catch {
    return null;
  }
}
function sessionHasTask(root: string, key: string): boolean {
  try {
    const ctx = JSON.parse(
      readText(join(root, ".trellis", ".runtime", "sessions", `${key}.json`)),
    ) as JsonObject;
    return !!str(ctx.current_task);
  } catch {
    return false;
  }
}
function adoptKey(root: string, key: string): string {
  if (sessionHasTask(root, key)) return key;
  try {
    const dir = join(root, ".trellis", ".runtime", "sessions");
    const keys = readdirSync(dir)
      .filter(
        (f) => f.endsWith(".json") && sessionHasTask(root, f.slice(0, -5)),
      )
      .map((f) => f.slice(0, -5));
    const proc = keys.filter((k) => k.startsWith("pi_process_"));
    const cands = proc.length ? proc : keys;
    return cands.length === 1 ? cands[0]! : key;
  } catch {
    return key;
  }
}

// ── Workflow State Breadcrumb ─────────────────────────────────────────
const WF_RE =
  /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g;
function workflowBreadcrumb(root: string, key: string | null): string {
  const wf = readText(join(root, ".trellis", "workflow.md"));
  if (!wf) return "";
  const templates: Record<string, string> = {};
  for (const m of wf.matchAll(WF_RE)) {
    const s = m[1] ?? "",
      b = (m[2] ?? "").trim();
    if (s && b) templates[s] = b;
  }
  const dir = readTaskDir(root, key);
  let header = "Status: no_task",
    lookup = "no_task";
  if (dir) {
    try {
      const d = JSON.parse(readText(join(dir, "task.json"))) as JsonObject;
      const status = str(d.status) ?? "";
      const id = str(d.id) ?? dir.split(/[\\/]/).pop() ?? "";
      if (status) {
        header = `Task: ${id} (${status})`;
        lookup = status;
      }
    } catch {}
  }
  const body = templates[lookup] ?? "Refer to workflow.md for current step.";
  return `<workflow-state>\n${header}\n${body}\n</workflow-state>`;
}

// ── Session Overview ───────────────────────────────────────────────────
function runContextScript(root: string, key: string | null, args: string[]): string {
  const script = join(root, ".trellis", "scripts", "get_context.py");
  if (!exists(script)) return "";
  try {
    const py = process.platform === "win32" ? "python" : "python3";
    const result = spawnSync(py, [script, ...args], {
      cwd: root,
      env: key ? { ...process.env, TRELLIS_CONTEXT_ID: key } : process.env,
      encoding: "utf-8",
      timeout: SESSION_OVERVIEW_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0) return "";
    const stdout = (result.stdout ?? "").trim();
    return stdout;
  } catch {
    return "";
  }
}

function sessionOverview(root: string, key: string | null): string {
  const stdout = runContextScript(root, key, []);
  return stdout ? `<session-overview>\n${stdout}\n</session-overview>` : "";
}

function workflowOverview(root: string, key: string | null): string {
  const stdout = runContextScript(root, key, [
    "--mode",
    "phase",
    "--platform",
    "pi",
  ]);
  return stdout ? `<trellis-workflow>\n${stdout}\n</trellis-workflow>` : "";
}

function buildStartupContext(
  root: string,
  key: string | null,
  overview: string,
): string {
  const workflow = workflowOverview(root, key);
  return [
    "<session-context>\nTrellis compact SessionStart context. Use it to orient the session; load details on demand.\n</session-context>",
    FIRST_REPLY_NOTICE,
    overview,
    workflow,
    "<ready>\nUse the current workflow state to decide whether to create, continue, or skip a Trellis task.\n</ready>",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildContext(root: string, agent: string, key: string | null): string {
  const dir = readTaskDir(root, key);
  if (!dir)
    return "No active Trellis task found. Read .trellis/ before proceeding.";
  const relTaskDir = relative(root, dir).replace(/\\/g, "/");
  const limits = readContextInjectionLimits(root);
  const budget = new ContextBudget(limits.max_total_bytes);

  // 1. Curated spec/research files from {agent}.jsonl (same order, budget
  //    processed first, matching Python's get_agent_context()).
  const jsonlName = TRELLIS_AGENT_JSONL[agent] ?? "";
  const specBlocks: string[] = [];
  if (jsonlName) {
    for (const entry of readJsonlEntries(dir, jsonlName)) {
      if (entry.type === "directory") continue;
      const block = materializeFile(root, entry.file, entry.reason, limits, budget);
      if (block) specBlocks.push(block);
    }
  }
  const spec = specBlocks.join("\n\n");

  // 2-4. Task artifacts, in order: prd.md -> design.md -> implement.md.
  const prd = materializeArtifact(
    root,
    `${relTaskDir}/prd.md`,
    `${relTaskDir}/prd.md (Requirements)`,
    "Requirements document",
    limits,
    budget,
  );
  const design = materializeArtifact(
    root,
    `${relTaskDir}/design.md`,
    `${relTaskDir}/design.md (Technical Design)`,
    "Technical design document",
    limits,
    budget,
  );
  const impl = materializeArtifact(
    root,
    `${relTaskDir}/implement.md`,
    `${relTaskDir}/implement.md (Execution Plan)`,
    "Execution plan document",
    limits,
    budget,
  );

  // prd/design/impl already carry their own "=== path (label) ===" header
  // (from materializeArtifact) — no extra "### x.md" wrapper needed, that
  // would just double the header.
  return [
    `## Trellis Task Context`,
    `Task directory: ${dir}`,
    "",
    prd ?? `(missing) ${relTaskDir}/prd.md`,
    design ? "\n" + design : "",
    impl ? "\n" + impl : "",
    spec ? "\n### Curated Spec / Research Context\n" + spec : "",
  ].join("\n");
}

function normalizeAgent(agent: string | undefined): string {
  const name = agent ?? "trellis-implement";
  return name.startsWith("trellis-") ? name : `trellis-${name}`;
}

/**
 * Validate a tool-supplied agent name. Returns an error message, or null when
 * the normalized name is a safe basename (`trellis-<alnum>…`). Never trust a
 * raw name on a path: `join` would happily normalize embedded `../`.
 */
export function agentNameError(agent: string | undefined): string | null {
  const name = normalizeAgent(agent);
  if (!AGENT_NAME_RE.test(name))
    return `Invalid Trellis agent name ${JSON.stringify(agent ?? null)}: names must match ${AGENT_NAME_RE} (basename only — no path separators, no \`..\`, no leading dots)`;
  return null;
}

/** Basename-safe fleet id derived from run state; never the raw agent name. */
export function sanitizeFleetId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "");
}

function projectAgentsDir(root: string): string {
  return join(root, ".pi", "agents");
}

/** Global agents dir, mirroring pi's getAgentDir(): $PI_CODING_AGENT_DIR else ~/.pi/agent. */
export function globalAgentsDir(): string {
  const envDir = str(process.env.PI_CODING_AGENT_DIR);
  return join(envDir ?? join(homedir(), ".pi", "agent"), "agents");
}

/**
 * Resolve `<agentsDir>/<name>.md` and assert the result stays directly inside
 * the agents dir. Returns null for invalid names or escaped paths — never a
 * path outside the intended directory.
 */
function agentFilePath(agentsDir: string, agent: string): string | null {
  if (agentNameError(agent) !== null) return null;
  const p = resolve(join(agentsDir, `${agent}.md`));
  const base = resolve(agentsDir);
  return p.startsWith(base + sep) ? p : null;
}

/**
 * Two-tier discovery: project <root>/.pi/agents wins over the global agents
 * dir, but only when the project is trusted. Untrusted projects fall back to
 * the global tier so an untrusted repo cannot control model/tools/prompt/
 * turn-limit config for this privileged extension.
 */
export function isTrellisAgent(
  root: string,
  agent: string,
  projectTrusted = true,
): boolean {
  const project = agentFilePath(projectAgentsDir(root), agent);
  if (projectTrusted && project && exists(project)) return true;
  const global = agentFilePath(globalAgentsDir(), agent);
  return global !== null && exists(global);
}

/**
 * Read an agent definition: project file wins (when trusted); else global;
 * else "" (the default-path fallback handles it). Invalid names read empty.
 */
export function readTrellisAgent(
  root: string,
  agent: string,
  projectTrusted = true,
): string {
  if (projectTrusted) {
    const project = agentFilePath(projectAgentsDir(root), agent);
    if (project && exists(project)) return readText(project);
  }
  const global = agentFilePath(globalAgentsDir(), agent);
  return global ? readText(global) : "";
}

export function buildPrompt(
  root: string,
  input: SubagentInput,
  key: string | null,
  projectTrusted = true,
): string {
  const agent = normalizeAgent(input.agent);
  const raw = readTrellisAgent(root, agent, projectTrusted);
  const def = stripFM(raw);
  const ctx = buildContext(root, agent, key);
  return [
    "## Trellis Agent Definition",
    def || "(missing)",
    "",
    ctx,
    "",
    "## Delegated Task",
    input.prompt ?? "",
  ].join("\n");
}

// ── Event parsing ─────────────────────────────────────────────────────
function parseJsonEvent(line: string): JsonObject | null {
  const t = line.trim();
  if (!t) return null;
  const i = t.indexOf("{");
  if (i < 0) return null;
  try {
    const p = JSON.parse(t.slice(i));
    return isObj(p) ? p : null;
  } catch {
    return null;
  }
}

function applyEvent(r: RunState, evt: JsonObject): boolean {
  const type = typeof evt.type === "string" ? evt.type : "";
  if (!type) return false;
  if (type === "agent_start" || type === "turn_start") {
    // Start events alone must not erase a terminal failure: after a failed/
    // aborted assistant message the state is terminal, and a Pi auto-retry
    // only recovers once a successful assistant message proves it (NEW-001).
    // "pending" is the initial state and promotes to running on the first start.
    if (r.status === "pending") r.status = "running";
    r.startedAt ??= Date.now();
    return true;
  }
  if (type === "message_update") {
    const ae = isObj(evt.assistantMessageEvent)
      ? evt.assistantMessageEvent
      : null;
    if (!ae || typeof ae.delta !== "string") return false;
    if (ae.type === "thinking_delta") {
      r.thinkingTail = appendTail(r.thinkingTail, ae.delta, MAX_TAIL);
      return true;
    }
    if (ae.type === "text_delta") {
      r.textTail = appendTail(r.textTail, ae.delta, MAX_TAIL);
      return true;
    }
    return false;
  }
  if (type === "message_end" && isObj(evt.message)) {
    const msg = evt.message;
    if (msg.role !== "assistant") return false;
    r.usage.turns += 1;
    const u = isObj(msg.usage) ? msg.usage : null;
    const cost = isObj(u?.cost) ? u.cost : null;
    r.usage.input += num(u?.input);
    r.usage.output += num(u?.output);
    r.usage.cacheRead += num(u?.cacheRead);
    r.usage.cacheWrite += num(u?.cacheWrite);
    r.usage.cost += num(cost?.total);
    r.usage.ctxTokens = num(u?.totalTokens);
    const thinking = extractThinking(msg.content);
    if (thinking) r.thinkingTail = appendTail("", thinking, MAX_TAIL);
    const text = extractText(msg.content);
    if (text) {
      r.finalText = text;
      r.textTail = appendTail("", text, MAX_TAIL);
    }
    if (typeof msg.model === "string") {
      const parsed = splitModelThinking(msg.model, r.thinking);
      r.model = parsed.model;
      r.thinking = parsed.thinking;
    }
    if (typeof msg.errorMessage === "string") r.errorMessage = msg.errorMessage;
    // Assistant stopReason is authoritative: an error/aborted message makes the
    // run failed/cancelled even when the child process exits 0 afterwards, so
    // agent_end and the close handler cannot misreport it as success.
    const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "";
    if (stopReason === "error") {
      r.status = "failed";
      r.errorMessage =
        typeof msg.errorMessage === "string" && msg.errorMessage.trim()
          ? msg.errorMessage
          : "assistant stopReason=error";
    } else if (stopReason === "aborted") {
      r.status = "cancelled";
      r.errorMessage =
        typeof msg.errorMessage === "string" && msg.errorMessage.trim()
          ? msg.errorMessage
          : "assistant stopReason=aborted";
    } else {
      // The final assistant outcome is authoritative (NEW-001): a successful
      // message must never leave a stale diagnostic behind. Pi auto-retries a
      // failed attempt with a fresh agent_start; without this recovery the
      // stale errorMessage would survive into a "succeeded" record — a v1
      // violation (succeeded records require error=null). Recovery is only
      // granted by a successful message, never by start events alone.
      r.errorMessage = undefined;
      if (r.status === "failed" || r.status === "cancelled")
        r.status = "running";
    }
    return true;
  }
  if (type === "tool_execution_start") {
    const id =
      typeof evt.toolCallId === "string"
        ? evt.toolCallId
        : hash(`${Date.now()}`);
    const name = typeof evt.toolName === "string" ? evt.toolName : "tool";
    const args = summarizeToolArgs(name, evt.args);
    const existing = r.tools.findIndex((t) => t.id === id);
    if (existing >= 0)
      r.tools[existing] = { ...r.tools[existing]!, args, status: "running" };
    else
      r.tools.push({
        id,
        name,
        args,
        status: "running",
        startedAt: Date.now(),
      });
    if (r.tools.length > MAX_TOOLS)
      r.tools.splice(0, r.tools.length - MAX_TOOLS);
    return true;
  }
  if (type === "tool_execution_end") {
    const id = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
    const idx = r.tools.findIndex((t) => t.id === id);
    if (idx >= 0)
      r.tools[idx] = {
        ...r.tools[idx]!,
        status: evt.isError ? "failed" : "succeeded",
        finishedAt: Date.now(),
      };
    return true;
  }
  if (type === "agent_end") {
    r.finishedAt = Date.now();
    if (r.status === "running" || r.status === "pending")
      r.status = "succeeded";
    return true;
  }
  return false;
}

function finalize(r: RunState, fallback: string): string {
  return r.finalText || fallback.trim() || r.stderrTail.trim();
}
function formatPiOutput(stdout: string, stderr: string): string {
  let ft = "";
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const evt = JSON.parse(t) as JsonObject;
      const msg = isObj(evt.message) ? evt.message : null;
      if (msg?.role === "assistant") {
        const txt = extractText(msg.content);
        if (txt) ft = txt;
      }
    } catch {}
  }
  return ft || stdout || stderr;
}

// ── runPi: subprocess execution + event processing ───────────────────

export function runPi(
  root: string,
  prompt: string,
  cfg: PiRunConfig,
  state: RunState,
  emit: () => void,
  key?: string | null,
  signal?: AbortSignal,
): Promise<{ output: string; failed: boolean }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      state.status = "cancelled";
      state.errorMessage = "cancelled";
      state.finishedAt = Date.now();
      emit();
      resolve({ output: "cancelled", failed: true });
      return;
    }
    const inv = resolvePiCli();
    // Unique per run: distinct from other parallel/chain runs and across calls.
    // The id is sanitized — the raw agent name never flows into filesystem
    // names (state.id embeds the agent name; see TPE-001).
    const fleetId = sanitizeFleetId(
      `${state.id}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    );
    const childEnv = {
      ...process.env,
      TRELLIS_SUBAGENT_CHILD: "1",
      ...(key ? { TRELLIS_CONTEXT_ID: key } : {}),
    };
    const cli = spawn(inv.command, [...inv.args, ...buildPiArgs(cfg, fleetId)], {
      cwd: root,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = new BBC(MAX_STDOUT);
    const stderr = new BBC(MAX_STDERR);
    let buf = "";
    let settled = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => {
      if (aborted) return;
      aborted = true;
      cli.kill();
      killTimer = setTimeout(() => {
        if (!settled && cli.exitCode === null) cli.kill("SIGKILL");
      }, ABORT_KILL_GRACE_MS);
      killTimer?.unref?.();
    };
    const done = (v: { output: string; failed: boolean }) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      writeTrellisFleetRecord(state, fleetId); // terminal record (replaces start)
      emit();
      resolve(v);
    };
    signal?.addEventListener("abort", abort, { once: true });
    state.status = "running";
    state.startedAt = Date.now();
    emit();
    // Start record (running): written lazily — only once the child has flushed
    // its real transcript (TPE-004: never fabricate a sessionFile). Retried on
    // every processed event; if the child exits without ever writing a
    // transcript, no record is produced.
    let startRecordWritten = false;
    const writeStartRecord = () => {
      if (startRecordWritten || settled) return;
      if (!resolveSessionFile(fleetId)) return;
      startRecordWritten = true;
      writeTrellisFleetRecord(state, fleetId);
    };
    writeStartRecord();
    // max_turns enforcement: assistant turns are counted in applyEvent via
    // message_end(role=assistant). Pi -p consumes stdin to EOF before starting,
    // so the mid-run steering write below is best-effort (a no-op for -p
    // children); the actual soft steer is the turn-budget directive embedded in
    // the child prompt, and the hard abort below is the guarantee.
    const maxTurns = cfg.maxTurns;
    let steered = false;
    const steerOnce = () => {
      if (steered) return;
      steered = true;
      try {
        cli.stdin?.write(`${TURN_LIMIT_STEERING}\n`);
      } catch {
        /* best-effort: never throw from steering */
      }
    };
    const processLine = (line: string) => {
      const evt = parseJsonEvent(line);
      if (!evt || !applyEvent(state, evt)) return;
      writeStartRecord();
      refreshFleetOwnerMarker(fleetId);
      emit();
      if (maxTurns && maxTurns > 0) {
        const turns = state.usage.turns;
        if (!steered && turns >= maxTurns) steerOnce();
        if (turns >= maxTurns + GRACE_TURNS) {
          if (!state.errorMessage)
            state.errorMessage = `max_turns exceeded (${maxTurns} + ${GRACE_TURNS} grace)`;
          abort();
        }
      }
    };
    cli.stdout?.on("data", (d: Buffer) => {
      stdout.append(d);
      buf += d.toString("utf-8");
      if (buf.length > MAX_LINE_BUFFER) buf = buf.slice(-MAX_LINE_BUFFER);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) processLine(l);
    });
    cli.stderr?.on("data", (d: Buffer) => {
      stderr.append(d);
      state.stderrTail = appendTail(
        state.stderrTail,
        d.toString("utf-8"),
        MAX_TAIL,
      );
    });
    cli.stdin?.on("error", (e: Error & { code?: string }) => {
      // Steering writes land on an already-ended pipe; those are expected noise.
      if (
        !aborted &&
        e.code !== "EPIPE" &&
        e.code !== "ERR_STREAM_WRITE_AFTER_END"
      )
        done({ output: e.message, failed: true });
    });
    cli.on("error", (e) => {
      state.status = aborted ? "cancelled" : "failed";
      state.errorMessage = e instanceof Error ? e.message : String(e);
      state.finishedAt = Date.now();
      done({ output: finalize(state, state.errorMessage), failed: true });
    });
    cli.on("close", (code) => {
      if (buf.trim()) processLine(buf);
      const out = stdout.toString();
      const err = stderr.toString();
      state.stderrTail = appendTail("", err, MAX_TAIL);
      state.finishedAt = Date.now();
      if (aborted) {
        state.status = "cancelled";
        // A successful message_end processed after the abort branch could have
        // cleared the max_turns diagnostic (NEW-001 makes success authoritative);
        // restore it deterministically so the record keeps the real reason.
        if (
          !state.errorMessage &&
          maxTurns &&
          maxTurns > 0 &&
          state.usage.turns >= maxTurns + GRACE_TURNS
        ) {
          state.errorMessage = `max_turns exceeded (${maxTurns} + ${GRACE_TURNS} grace)`;
        }
        state.errorMessage = state.errorMessage ?? "cancelled";
        done({ output: finalize(state, "cancelled"), failed: true });
        return;
      }
      if (code === 0) {
        if (state.status === "pending" || state.status === "running")
          state.status = "succeeded";
        // A JSON-mode assistant stopReason (error/aborted) already moved the
        // state to a terminal failure; the child's exit code alone must not
        // mask that (TPE-003).
        const failed = state.status === "failed" || state.status === "cancelled";
        done({
          output: finalize(state, formatPiOutput(out, err)),
          failed,
        });
        return;
      }
      state.status = "failed";
      state.errorMessage = err || out || `exit ${code ?? "?"}`;
      done({ output: finalize(state, state.errorMessage), failed: true });
    });
    const maxTurnsDirective =
      maxTurns && maxTurns > 0
        ? `\n\n## Turn budget (enforced)\nYou have a budget of at most ${maxTurns} assistant turns for this delegated task. When you reach that budget, wrap up now — provide your final answer and do not start new tool calls. Further turns are force-terminated by the parent process.`
        : "";
    cli.stdin?.end(prompt + maxTurnsDirective);
  });
}

// ── runSubagent: orchestrate single/parallel/chain via native partial updates ──
async function runSubagent(
  root: string,
  input: SubagentInput,
  key: string | null,
  signal?: AbortSignal,
  onUpdate?: (r: PiToolResult) => void,
  inheritedThinking?: string,
  inheritedModel?: string,
  projectTrusted = true,
): Promise<{ output: string; details: ProgressDetails; failed: boolean }> {
  const agentName = normalizeAgent(input.agent);
  const agentRaw = readTrellisAgent(root, agentName, projectTrusted);
  const agentCfg = parseAgentFM(agentRaw);
  const runCfg = resolveRunCfg(
    input,
    agentCfg,
    inheritedThinking,
    inheritedModel,
  );
  const mode = input.mode ?? "single";
  const startedAt = Date.now();
  const details: ProgressDetails = {
    kind: "trellis-subagent-progress",
    agent: agentName,
    mode,
    startedAt,
    updatedAt: startedAt,
    final: false,
    runs: [],
  };
  let lastEmit = 0;
  let lastPartialKey = "";
  let closed = false;
  const pushPartial = (force = false) => {
    if (closed || !onUpdate) return;
    const key = progressKey(details);
    if (!force && key === lastPartialKey) return;
    lastPartialKey = key;
    onUpdate({
      // Keep native partial content stable; renderResult owns the visible progress UI.
      content: [{ type: "text", text: "subagent running" }],
      details: cloneProgress(details),
    });
  };
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < THROTTLE_MS) return;
    lastEmit = now;
    details.updatedAt = now;
    pushPartial(force);
  };
  const finish = (output: string, failed: boolean) => {
    closed = true;
    details.final = true;
    details.updatedAt = Date.now();
    return { output, details: cloneProgress(details), failed };
  };

  try {
    if (mode === "parallel") {
      const prompts = input.prompts ?? (input.prompt ? [input.prompt] : []);
      details.runs = prompts.map((p, i) => {
        const r = newRun(`${agentName}-${i + 1}`, agentName, p);
        applyRunConfig(r, runCfg);
        return r;
      });
      emit(true);
      const results = await Promise.all(
        prompts.map((p, i) =>
          runPi(
            root,
            buildPrompt(root, { ...input, prompt: p }, key, projectTrusted),
            runCfg,
            details.runs[i]!,
            emit,
            key,
            signal,
          ),
        ),
      );
      return finish(
        results.map((r) => r.output).join("\n\n---\n\n"),
        results.some((r) => r.failed),
      );
    }
    if (mode === "chain") {
      let prev = "";
      let failed = false;
      for (let i = 0; i < (input.prompts?.length ?? 1); i++) {
        const p = input.prompts?.[i] ?? input.prompt ?? "";
        const rs = newRun(`${agentName}-${i + 1}`, agentName, p, i + 1);
        applyRunConfig(rs, runCfg);
        details.runs.push(rs);
        emit(true);
        const result = await runPi(
          root,
          buildPrompt(
            root,
            {
              ...input,
              prompt: prev ? `${p}\n\nPrevious output:\n${prev}` : p,
            },
            key,
            projectTrusted,
          ),
          runCfg,
          rs,
          emit,
          key,
          signal,
        );
        prev = result.output;
        failed = failed || result.failed;
        if (result.failed) break;
      }
      return finish(prev, failed);
    }
    const rs = newRun(`${agentName}-1`, agentName, input.prompt ?? "");
    applyRunConfig(rs, runCfg);
    details.runs = [rs];
    emit(true);
    const result = await runPi(
      root,
      buildPrompt(root, input, key, projectTrusted),
      runCfg,
      rs,
      emit,
      key,
      signal,
    );
    return finish(result.output, result.failed);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const r = activeRun(details);
    if (r) {
      r.status = "failed";
      r.errorMessage = message;
      r.finishedAt = Date.now();
    }
    return finish(message, true);
  }
}

// ── Extension ──────────────────────────────────────────────────────────
export default function trellisExtension(pi: {
  registerTool?: (tool: JsonObject) => void;
  registerShortcut?: (
    key: string,
    opts: {
      description?: string;
      handler: (ctx: PiExtensionContext) => unknown;
    },
  ) => void;
  events?: {
    on: (channel: string, handler: (data: unknown) => void) => () => void;
  };
  on?: (
    event: string,
    handler: (event: unknown, ctx?: PiExtensionContext) => unknown,
  ) => void;
  getThinkingLevel?: () => string;
}): void {
  if (process.env.TRELLIS_SUBAGENT_CHILD === "1") return;
  const root = findRoot(process.cwd());
  if (projectLoadsGeneratedExt(root)) {
    console.warn(
      "[trellis-pi-ext] inactive in this project: .pi/settings.json loads the generated trellis extension (./extensions/trellis/index.ts). Remove that entry to activate @evansdai/trellis-pi-ext (fleet producer, max_turns, global agents).",
    );
    return;
  }
  reconcileFleetRuns(); // flag stale running records from a previous pi process
  if (pi.events) {
    const childIds = communityChildSessionIds();
    const subscribed = subscribedLifecycleBuses();
    const bus = pi.events;
    if (!subscribed.has(bus)) {
      subscribed.add(bus);
      bus.on(SUBAGENT_SESSION_CREATED, (data) => {
        const sessionId = childSessionId(data);
        if (sessionId) childIds.add(sessionId);
      });
      bus.on(SUBAGENT_SESSION_DISPOSED, (data) => {
        const sessionId = childSessionId(data);
        if (sessionId) childIds.delete(sessionId);
      });
    }
  }
  const procKey = `pi_process_${hash([root, process.pid, Date.now(), randomBytes(8).toString("hex")].join(":"))}`;
  let curKey: string | null = null;

  const getKey = (input?: unknown, ctx?: PiExtensionContext) => {
    const k = adoptKey(root, contextKey(input, ctx) ?? curKey ?? procKey);
    curKey = k;
    return k;
  };

  // Per-turn cache to avoid double-spawning python
  let turnCache: {
    key: string | null;
    ts: number;
    wf: string;
    ov: string;
  } | null = null;
  const getTurnCtx = (k: string | null) => {
    const now = Date.now();
    if (turnCache && turnCache.key === k && now - turnCache.ts < 1500)
      return turnCache;
    turnCache = {
      key: k,
      ts: now,
      wf: workflowBreadcrumb(root, k),
      ov: sessionOverview(root, k),
    };
    return turnCache;
  };
  // Provider prefix caches invalidate from byte 0 whenever the system prompt
  // changes, so everything injected into systemPrompt is memoized per context
  // key and stays byte-identical for the life of the process. Volatile state
  // travels through persisted custom messages instead (append-only history).
  const startupCtxCache = new Map<string, string>();
  const getStartupCtx = (
    k: string | null,
    turn: { ov: string },
  ): string => {
    const key = k ?? "default";
    let startup = startupCtxCache.get(key);
    if (startup === undefined) {
      startup = buildStartupContext(root, k, turn.ov);
      startupCtxCache.set(key, startup);
    }
    return startup;
  };
  const taskCtxSnapshot = new Map<string, string>();
  const lastSentTaskCtx = new Map<string, string>();
  const lastSentRuntimeCtx = new Map<string, string>();

  // Toggle only the latest subagent native card; do not use Pi global tool expansion.
  const toggleDetail = (ctx: PiExtensionContext) => {
    const id = activeSubagentToolCallId;
    const card = id ? nativeCards.get(id) : undefined;
    if (!card) {
      ctx.ui?.notify?.("No subagent card to toggle yet.", "warning");
      return;
    }
    card.state.localExpanded = card.state.localExpanded !== true;
    card.invalidate();
  };

  pi.registerShortcut?.("alt+o", {
    description: "Toggle latest subagent card details",
    handler: async (ctx: PiExtensionContext) => toggleDetail(ctx),
  });

  // Tool registration
  pi.registerTool?.({
    name: "trellis_subagent",
    label: "Trellis Subagent",
    description:
      "Run a Trellis project sub-agent (definition from project .pi/agents/ or the global agents dir) with active task context.",
    promptSnippet:
      'Sub-agent dispatch protocol (Trellis): your dispatch prompt MUST start with one line "Active task: <task path from `task.py current`>" before any other instructions.',
    promptGuidelines: [
      'Use subagent for task delegation. Your dispatch prompt MUST start with "Active task: <task path from `task.py current`>".',
    ],
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description:
            "Agent name, such as trellis-implement or trellis-check.",
        },
        prompt: {
          type: "string",
          description: "Task prompt for the sub-agent.",
        },
        mode: { type: "string", enum: ["single", "parallel", "chain"] },
        prompts: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_PARALLEL_PROMPTS,
        },
        model: {
          type: "string",
          description:
            "Optional Pi model override for the child sub-agent process.",
        },
        thinking: {
          type: "string",
          description:
            "Optional Pi thinking level override for the child sub-agent process.",
          enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        },
      },
    },
    execute: async (
      id: string,
      input: SubagentInput,
      signal?: AbortSignal,
      onUpdate?: (r: PiToolResult) => void,
      ctx?: PiExtensionContext,
    ) => {
      activeSubagentToolCallId = id;
      const nameErr = agentNameError(input.agent);
      if (nameErr !== null) {
        return {
          content: [{ type: "text", text: nameErr }],
          details: { agent: input.agent, error: "invalid agent name" },
        };
      }
      const agentName = normalizeAgent(input.agent);
      // Project agents are only trusted when the project itself is trusted;
      // an untrusted project cannot steer this privileged extension's
      // model/tools/prompt/turn-limit config (see TPE-002).
      const projectTrusted = ctx?.isProjectTrusted
        ? ctx.isProjectTrusted()
        : true;
      if (!isTrellisAgent(root, agentName, projectTrusted)) {
        return {
          content: [
            {
              type: "text",
              text:
                "`trellis_subagent` is only for Trellis workflow agents with a definition file in .pi/agents/ or the global agents dir.\n\n" +
                `No definition found for: ${agentName}\n\n` +
                "For general-purpose sub-agents, use one of these community tools:\n" +
                "- `subagent` tool from npm:pi-subagents (nicobailon/pi-subagents)\n" +
                "- `Agent` tool from npm:@tintinweb/pi-subagents\n\n" +
                "If neither is installed, ask the user to either:\n" +
                `- Create .pi/agents/${agentName}.md for your custom Trellis agent\n` +
                "- Install a community subagent package: pi install -l npm:@tintinweb/pi-subagents",
            },
          ],
          details: { agent: agentName, error: "not a trellis workflow agent" },
        };
      }
      const mode = input.mode ?? "single";
      const prompt = input.prompt?.trim();
      const prompts = input.prompts?.map((p) => p.trim()).filter(Boolean);
      if (mode === "single" && !prompt)
        throw new Error("subagent prompt is required for single mode");
      if (
        (mode === "parallel" || mode === "chain") &&
        !prompt &&
        !prompts?.length
      )
        throw new Error(
          "subagent prompt or prompts are required for parallel/chain mode",
        );
      if (
        mode === "parallel" &&
        prompts &&
        prompts.length > MAX_PARALLEL_PROMPTS
      )
        throw new Error(
          `subagent parallel mode supports at most ${MAX_PARALLEL_PROMPTS} prompts`,
        );
      const cleanInput: SubagentInput = {
        ...input,
        prompt,
        prompts: prompts?.length ? prompts : undefined,
      };
      const key = getKey(cleanInput, ctx);
      const inheritedThinking = pi.getThinkingLevel?.();
      const inheritedModel = contextModelRef(ctx);
      const result = await runSubagent(
        root,
        cleanInput,
        key,
        signal,
        onUpdate,
        inheritedThinking,
        inheritedModel,
        projectTrusted,
      );
      return {
        content: [{ type: "text", text: result.output }],
        details: result.details,
      };
    },
    // Hide the call renderer so the native card only shows result/progress once.
    renderCall: () => ({
      render() {
        return [];
      },
      invalidate() {},
    }),
    renderResult: (
      result: PiToolResult,
      _opts?: { expanded?: boolean; isPartial?: boolean },
      _theme?: unknown,
      context?: unknown,
    ) => {
      const ctxObj = isObj(context) ? context : null;
      const toolCallId = str(ctxObj?.toolCallId);
      const state = isObj(ctxObj?.state) ? (ctxObj.state as JsonObject) : null;
      const invalidate =
        typeof ctxObj?.invalidate === "function"
          ? (ctxObj.invalidate as () => void)
          : null;
      const isProgress =
        isObj(result.details) &&
        result.details.kind === "trellis-subagent-progress";
      if (toolCallId && state && invalidate) {
        const updatedAt = isProgress
          ? (result.details as ProgressDetails).updatedAt
          : Date.now();
        rememberNativeCard(toolCallId, { state, invalidate, updatedAt });
      }
      return {
        render(w: number) {
          if (isProgress) {
            const expanded = state?.localExpanded === true;
            return renderProgressCard(
              result.details as ProgressDetails,
              expanded,
              w,
            );
          }
          return [trunc(result.content?.[0]?.text ?? "(no output)", w)];
        },
        invalidate() {},
      };
    },
  });

  // Events
  pi.on?.("session_start", (event, ctx) => {
    getKey(event, ctx);
    ctx?.ui?.notify?.(
      "Trellis project context is available. Use /trellis-start to bootstrap or /trellis-continue to resume.",
      "info",
    );
  });
  pi.on?.("session_shutdown", () => {
    nativeCards.clear();
    activeSubagentToolCallId = null;
  });
  pi.on?.("tool_call", (event, ctx) => {
    const k = getKey(event, ctx);
    const ev = event as { toolName?: string; input?: JsonObject };
    if (
      ev.toolName === "bash" &&
      isObj(ev.input) &&
      typeof ev.input.command === "string" &&
      !cmdHasTrellisCtx(ev.input.command)
    )
      ev.input.command = `export TRELLIS_CONTEXT_ID=${shellQuote(k)}; ${ev.input.command}`;
  });
  // Preserve progress details from execute(); mark failed subagent results through
  // the official tool_result patch hook instead of throwing away renderer details.
  pi.on?.("tool_result", (event) => {
    const ev = event as { toolName?: string; details?: unknown };
    if (
      ev.toolName === "trellis_subagent" &&
      isObj(ev.details) &&
      ev.details.kind === "trellis-subagent-progress" &&
      Array.isArray(ev.details.runs) &&
      ev.details.runs.some(
        (r) => isObj(r) && (r.status === "failed" || r.status === "cancelled"),
      )
    )
      return { isError: true };
    return undefined;
  });
  pi.on?.("before_agent_start", (event, ctx) => {
    // Invoke through the receiver: SessionManager.getSessionId() reads `this`,
    // so a detached method ref throws and the child guard would get null and
    // never suppress a community child session.
    const sessionId = callStr(() => ctx?.sessionManager?.getSessionId?.());
    if (sessionId && communityChildSessionIds().has(sessionId)) return undefined;
    const k = getKey(event, ctx);
    const key = k ?? "default";
    const cur = (event as { systemPrompt?: string }).systemPrompt ?? "";
    const turn = getTurnCtx(k);
    const startup = getStartupCtx(k, turn);
    // Task context is snapshotted into systemPrompt once; later on-disk
    // changes are delivered as persisted messages so the prefix stays stable.
    const freshTaskCtx = buildContext(root, "trellis-implement", k);
    let taskCtx = taskCtxSnapshot.get(key);
    if (taskCtx === undefined) {
      taskCtx = freshTaskCtx;
      taskCtxSnapshot.set(key, taskCtx);
      lastSentTaskCtx.set(key, freshTaskCtx);
    }
    const updates: string[] = [];
    const runtimeContext = [turn.wf, turn.ov].filter(Boolean).join("\n\n");
    if (runtimeContext && runtimeContext !== lastSentRuntimeCtx.get(key)) {
      lastSentRuntimeCtx.set(key, runtimeContext);
      updates.push(runtimeContext);
    }
    if (freshTaskCtx !== lastSentTaskCtx.get(key)) {
      lastSentTaskCtx.set(key, freshTaskCtx);
      updates.push(
        "<trellis-task-context-update>\nTask context changed on disk. This supersedes the Trellis Task Context in the system prompt.\n\n" +
          freshTaskCtx +
          "\n</trellis-task-context-update>",
      );
    }
    const content = updates.join("\n\n");
    return {
      message: content
        ? {
            customType: "trellis-runtime-context",
            content,
            display: false,
          }
        : undefined,
      systemPrompt: [cur, startup, taskCtx].filter(Boolean).join("\n\n"),
    };
  });
  pi.on?.("context", (event, ctx) => {
    getKey(event, ctx);
  });
}
