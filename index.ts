import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────────
type JsonObject = Record<string, unknown>;
interface PiExtensionContext {
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    /** All session entries; read child-side to detect the pi-subagents dispatch marker. */
    getEntries?: () => unknown[];
  };
  ui?: {
    notify?: (msg: string, type?: "info" | "warning" | "error") => void;
  };
}

// ── Constants ─────────────────────────────────────────────────────────
const CONTEXT_JSONL_FILES = ["implement.jsonl", "check.jsonl"] as const;
const SESSION_OVERVIEW_TIMEOUT_MS = 1500;
const SUBAGENT_SESSION_CREATED = "subagents:child:session-created";
const SUBAGENT_SESSION_DISPOSED = "subagents:child:disposed";
/**
 * Non-LLM `custom` entry `customType` that `pi-subagents` writes into a dispatched
 * leaf's own session at creation (see create-subagent-session.ts). `before_agent_start`
 * reads it child-side via `sessionManager.getEntries()` so a leaf self-gates
 * suppression without depending on the parent's lifecycle subscription or a shared
 * `globalThis` set — the gap that let a compliant dispatched model receive the
 * interactive Request-Triage triage and halt.
 */
const DISPATCH_MARKER_CUSTOM_TYPE = "pi-subagents:child";
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

// ── Utilities ─────────────────────────────────────────────────────────
function isObj(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function childSessionId(data: unknown): string | null {
  return isObj(data) ? str(data.sessionId) : null;
}
function hasDispatchMarker(ctx?: PiExtensionContext): boolean {
  const entries = ctx?.sessionManager?.getEntries?.();
  return (
    Array.isArray(entries) &&
    entries.some(
      (e) =>
        isObj(e) &&
        e.type === "custom" &&
        e.customType === DISPATCH_MARKER_CUSTOM_TYPE,
    )
  );
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
  for (const nk of ["input", "properties", "event", "hook_input", "hookInput"]) {
    const v = lookupStr(data[nk], keys);
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

export class ContextBudget {
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

// True when a generated project extension would also load this fork. The
// fork yields to that generated extension to avoid duplicate registration.
// A settings entry may use `./extensions/trellis/index.ts`,
// `extensions/trellis/index.ts`, or an absolute path.
export function projectLoadsGeneratedExt(root: string): boolean {
  // Primary signal: pi AUTO-DISCOVERS <root>/.pi/extensions/** (subdirectory
  // with index.ts) regardless of settings.json, so the generated ext file
  // itself being present means it will load and the fork must yield.
  if (existsSync(join(root, ".pi", "extensions", "trellis", "index.ts"))) return true;
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
    const resolved = resolve(root, ".pi", entry.replace(/^\.\//, ""))
      .split(sep)
      .join("/");
    return resolved.endsWith("extensions/trellis/index.ts");
  });
}

function contextKey(input?: unknown, ctx?: PiExtensionContext): string | null {
  const override = str(process.env.TRELLIS_CONTEXT_ID);
  if (override) return override.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160) || hash(override);
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
  return transcriptPath ? `pi_transcript_${hash(transcriptPath)}` : null;
}

function readTaskDir(root: string, key: string | null): string | null {
  if (!key) return null;
  try {
    const ctx = JSON.parse(
      readText(join(root, ".trellis", ".runtime", "sessions", `${key}.json`)),
    ) as JsonObject;
    let ref = str(ctx.current_task);
    if (!ref) return null;
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
      .filter((f) => f.endsWith(".json") && sessionHasTask(root, f.slice(0, -5)))
      .map((f) => f.slice(0, -5));
    const processKeys = keys.filter((k) => k.startsWith("pi_process_"));
    const candidates = processKeys.length ? processKeys : keys;
    return candidates.length === 1 ? candidates[0]! : key;
  } catch {
    return key;
  }
}

const WF_RE =
  /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g;
function workflowBreadcrumb(root: string, key: string | null): string {
  const workflow = readText(join(root, ".trellis", "workflow.md"));
  if (!workflow) return "";
  const templates: Record<string, string> = {};
  for (const match of workflow.matchAll(WF_RE)) {
    const status = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    if (status && body) templates[status] = body;
  }
  const dir = readTaskDir(root, key);
  let header = "Status: no_task";
  let lookup = "no_task";
  if (dir) {
    try {
      const task = JSON.parse(readText(join(dir, "task.json"))) as JsonObject;
      const status = str(task.status) ?? "";
      const id = str(task.id) ?? dir.split(/[\\/]/).pop() ?? "";
      if (status) {
        header = `Task: ${id} (${status})`;
        lookup = status;
      }
    } catch {}
  }
  return `<workflow-state>\n${header}\n${templates[lookup] ?? "Refer to workflow.md for current step."}\n</workflow-state>`;
}

function runContextScript(root: string, key: string | null, args: string[]): string {
  const script = join(root, ".trellis", "scripts", "get_context.py");
  if (!exists(script)) return "";
  try {
    const python = process.platform === "win32" ? "python" : "python3";
    const result = spawnSync(python, [script, ...args], {
      cwd: root,
      env: key ? { ...process.env, TRELLIS_CONTEXT_ID: key } : process.env,
      encoding: "utf-8",
      timeout: SESSION_OVERVIEW_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.status === 0 ? (result.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

function sessionOverview(root: string, key: string | null): string {
  const output = runContextScript(root, key, []);
  return output ? `<session-overview>\n${output}\n</session-overview>` : "";
}

function workflowOverview(root: string, key: string | null): string {
  const output = runContextScript(root, key, ["--mode", "phase", "--platform", "pi"]);
  return output ? `<trellis-workflow>\n${output}\n</trellis-workflow>` : "";
}

function buildStartupContext(root: string, key: string | null, overview: string): string {
  return [
    "<session-context>\nTrellis compact SessionStart context. Use it to orient the session; load details on demand.\n</session-context>",
    FIRST_REPLY_NOTICE,
    overview,
    workflowOverview(root, key),
    "<ready>\nUse the current workflow state to decide whether to create, continue, or skip a Trellis task.\n</ready>",
  ].filter(Boolean).join("\n\n");
}

function buildContext(root: string, key: string | null, sharedBudget?: ContextBudget): string {
  const dir = readTaskDir(root, key);
  if (!dir) return "No active Trellis task found. Read .trellis/ before proceeding.";
  const relTaskDir = relative(root, dir).replace(/\\/g, "/");
  const limits = readContextInjectionLimits(root);
  const budget = sharedBudget ?? new ContextBudget(limits.max_total_bytes);
  const specBlocks: string[] = [];
  const seen = new Set<string>();
  for (const jsonlName of CONTEXT_JSONL_FILES) {
    for (const entry of readJsonlEntries(dir, jsonlName)) {
      if (entry.type === "directory" || seen.has(entry.file)) continue;
      seen.add(entry.file);
      const block = materializeFile(root, entry.file, entry.reason, limits, budget);
      if (block) specBlocks.push(block);
    }
  }
  const spec = specBlocks.join("\n\n");
  const prd = materializeArtifact(root, `${relTaskDir}/prd.md`, `${relTaskDir}/prd.md (Requirements)`, "Requirements document", limits, budget);
  const design = materializeArtifact(root, `${relTaskDir}/design.md`, `${relTaskDir}/design.md (Technical Design)`, "Technical design document", limits, budget);
  const impl = materializeArtifact(root, `${relTaskDir}/implement.md`, `${relTaskDir}/implement.md (Execution Plan)`, "Execution plan document", limits, budget);
  return [
    "## Trellis Task Context",
    `Task directory: ${dir}`,
    "",
    prd ?? `(missing) ${relTaskDir}/prd.md`,
    design ? "\n" + design : "",
    impl ? "\n" + impl : "",
    spec ? "\n### Curated Spec / Research Context\n" + spec : "",
  ].join("\n");
}


// ── Extension ──────────────────────────────────────────────────────────
export default function trellisExtension(pi: {
  events?: {
    on: (channel: string, handler: (data: unknown) => void) => () => void;
  };
  on?: (
    event: string,
    handler: (event: unknown, ctx?: PiExtensionContext) => unknown,
  ) => void;
}): void {
  const root = findRoot(process.cwd());
  if (projectLoadsGeneratedExt(root)) {
    console.warn(
      "[trellis-pi-ext] inactive in this project: a generated Trellis extension is already loaded. Move it out of .pi/extensions/trellis/ to activate the pinned fork.",
    );
    return;
  }
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
  const procKey = `pi_process_${hash([root, process.pid, Date.now()].join(":"))}`;
  let curKey: string | null = null;
  const getKey = (input?: unknown, ctx?: PiExtensionContext) => {
    const key = adoptKey(root, contextKey(input, ctx) ?? curKey ?? procKey);
    curKey = key;
    return key;
  };
  let turnCache: { key: string | null; ts: number; wf: string; ov: string } | null = null;
  const getTurnCtx = (key: string | null) => {
    const now = Date.now();
    if (turnCache && turnCache.key === key && now - turnCache.ts < 1500)
      return turnCache;
    turnCache = {
      key,
      ts: now,
      wf: workflowBreadcrumb(root, key),
      ov: sessionOverview(root, key),
    };
    return turnCache;
  };
  const startupCtxCache = new Map<string, string>();
  const getStartupCtx = (key: string | null, turn: { ov: string }): string => {
    const cacheKey = key ?? "default";
    let startup = startupCtxCache.get(cacheKey);
    if (startup === undefined) {
      startup = buildStartupContext(root, key, turn.ov);
      startupCtxCache.set(cacheKey, startup);
    }
    return startup;
  };
  const taskCtxSnapshot = new Map<string, string>();
  const lastSentTaskCtx = new Map<string, string>();
  const lastSentRuntimeCtx = new Map<string, string>();
  pi.on?.("session_start", (event, ctx) => {
    getKey(event, ctx);
    ctx?.ui?.notify?.(
      "Trellis project context is available. Use /trellis-start to bootstrap or /trellis-continue to resume.",
      "info",
    );
  });
  pi.on?.("tool_call", (event, ctx) => {
    const key = getKey(event, ctx);
    const ev = event as { toolName?: string; input?: JsonObject };
    if (
      ev.toolName === "bash" &&
      isObj(ev.input) &&
      typeof ev.input.command === "string" &&
      !cmdHasTrellisCtx(ev.input.command)
    )
      ev.input.command = `export TRELLIS_CONTEXT_ID=${shellQuote(key)}; ${ev.input.command}`;
  });
  pi.on?.("before_agent_start", (event, ctx) => {
    const sessionId = callStr(() => ctx?.sessionManager?.getSessionId?.());
    if (sessionId && communityChildSessionIds().has(sessionId)) return undefined;
    if (hasDispatchMarker(ctx)) return undefined;
    const key = getKey(event, ctx);
    const cacheKey = key ?? "default";
    const current = (event as { systemPrompt?: string }).systemPrompt ?? "";
    const turn = getTurnCtx(key);
    const startup = getStartupCtx(key, turn);
    const freshTaskCtx = buildContext(root, key);
    let taskCtx = taskCtxSnapshot.get(cacheKey);
    if (taskCtx === undefined) {
      taskCtx = freshTaskCtx;
      taskCtxSnapshot.set(cacheKey, taskCtx);
      lastSentTaskCtx.set(cacheKey, freshTaskCtx);
    }
    const updates: string[] = [];
    const runtimeContext = [turn.wf, turn.ov].filter(Boolean).join("\n\n");
    if (runtimeContext && runtimeContext !== lastSentRuntimeCtx.get(cacheKey)) {
      lastSentRuntimeCtx.set(cacheKey, runtimeContext);
      updates.push(runtimeContext);
    }
    if (freshTaskCtx !== lastSentTaskCtx.get(cacheKey)) {
      lastSentTaskCtx.set(cacheKey, freshTaskCtx);
      updates.push(
        "<trellis-task-context-update>\nTask context changed on disk. This supersedes the Trellis Task Context in the system prompt.\n\n" +
          freshTaskCtx +
          "\n</trellis-task-context-update>",
      );
    }
    const content = updates.join("\n\n");
    return {
      message: content
        ? { customType: "trellis-runtime-context", content, display: false }
        : undefined,
      systemPrompt: [current, startup, taskCtx].filter(Boolean).join("\n\n"),
    };
  });
  pi.on?.("context", (event, ctx) => {
    getKey(event, ctx);
  });
}
