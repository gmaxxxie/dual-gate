// =============================================================================
// Dual-Gate Orchestrator — Pi extension glue
//
// Controller/Judge runs on the Pi model (GPT-5.6 Sol by default) via
// ctx.modelRegistry.complete(); the Executor runs inside a new Herdr pane via
// the `pi` agent kind. User always talks to the main Pi (Astra).
//
// Core loop: Expected → Execute → Observe Actual → Compare → Delta → Fix,
// with spec versioning and convergence detection.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

// Structural match for pi-tui's AutocompleteItem (avoid adding a runtime dep).
interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}
import type { Context as LlmContext, Message } from "@earendil-works/pi-ai";

import {
  DEFAULT_CONFIG,
  normalizeConfig,
  isThinking,
  resolveModelString,
  taskDirFor,
  normalizeRepoPath,
  derivePanelTitle,
  deriveAgentName,
  detectRisk,
  buildExecutorPrompt,
  buildJudgePrompt,
  buildSpecRevisionPrompt,
  buildConvergenceDiagnosisPrompt,
  buildSpecUpdatePrompt,
  buildExecutorCheckpoint,
  buildRecoveryPrompt,
  extractReportFromAgentMessage,
  parseJudgeOutput,
  parseContractYaml,
  parseSpecRevision,
  parseConvergenceDiagnosis,
  trackConvergence,
  TaskManager,
  type ModelRegistryAdapter,
  type ArtifactStore,
  type TaskRecord,
  type AcceptanceContract,
  type JudgeOutput,
  type ModelRef,
  type Delta,
  type SpecRevision,
  type ConvergenceDiagnosis,
} from "./core.ts";
import { discoverGateCommands, runGate, formatGateResult, type GateResult } from "./gate.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXT_VERSION = "1.0.0";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "dual-gate.json");

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

interface DgRuntime {
  config: ReturnType<typeof normalizeConfig>;
  manager: TaskManager;
  store: ArtifactStore | null;
  registry: ModelRegistryAdapter | null;
  running: boolean;
  stopRequested: boolean;
}

let runtime: DgRuntime | null = null;
let piRef: ExtensionAPI | null = null;

/** Show plain text to the user WITHOUT triggering a model turn (pure UI). */
function showText(text: string): void {
  try {
    piRef?.sendMessage({ customType: "dual-gate", content: text, display: true });
  } catch (e) {
    console.error("[dual-gate] showText failed:", errMsg(e));
  }
}

function getRuntime(): DgRuntime {
  if (!runtime) throw new Error("dual-gate runtime not initialized");
  return runtime;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function exec(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, {
      timeout: opts.timeoutMs ?? 120_000,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      maxBuffer: 32 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      let code: number | null = null;
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (typeof e.code === "number") code = e.code;
      } else {
        code = 0;
      }
      resolvePromise({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Model registry adapter
// ---------------------------------------------------------------------------

function makeRegistry(ctx: ExtensionContext): ModelRegistryAdapter {
  const registry = ctx.modelRegistry;
  const available = (): ModelRef[] => {
    try {
      // ModelRegistry (pi-coding-agent) exposes getAll()/getAvailable()/find()/getProvider() —
      // NOT getProviders(). Each Model carries provider/id/name directly.
      // Use getAvailable() so only providers with configured auth are shown (avoids
      // listing hundreds of catalogue models the user can't actually use).
      const out: ModelRef[] = [];
      for (const m of registry.getAvailable()) {
        out.push({ provider: m.provider, id: m.id, name: m.name ?? `${m.provider}/${m.id}` });
      }
      return out;
    } catch {
      return [];
    }
  };
  const find = (spec: string): ModelRef | null => {
    const r = resolveModelString(spec);
    if (!r) return null;
    if (r.provider) {
      try {
        const m = registry.find(r.provider, r.id);
        if (m) return { provider: r.provider, id: r.id, name: m.name ?? spec };
      } catch { /* ignore */ }
      return { provider: r.provider, id: r.id, name: spec };
    }
    for (const ref of available()) {
      if (ref.id === r.id || ref.name.toLowerCase().includes(r.id.toLowerCase())) return ref;
    }
    return null;
  };
  const clampThinking = (modelRef: ModelRef, level: ThinkingLevel): "off" | ThinkingLevel => {
    if (level === "off") return "off";
    try {
      const m = modelRef.provider ? registry.find(modelRef.provider, modelRef.id) : undefined;
      if (m) {
        const map = m.thinkingLevelMap as Record<string, string | null> | undefined;
        if (map && typeof map === "object" && level in map) {
          return map[level] == null ? "off" : level;
        }
      }
    } catch { /* ignore */ }
    return level;
  };
  const hasAuth = (modelRef: ModelRef): boolean => {
    if (!modelRef.provider) return false;
    try {
      const status = registry.getProviderAuthStatus(modelRef.provider);
      return status != null && status.configured === true;
    } catch {
      return false;
    }
  };
  return { find, available, clampThinking, hasAuth };
}

// ---------------------------------------------------------------------------
// LLM helper: run Controller/Judge on the configured model
// ---------------------------------------------------------------------------

async function completeText(
  ctx: ExtensionContext,
  modelRef: ModelRef,
  systemPrompt: string,
  userText: string,
  opts: { thinking?: string } = {},
): Promise<string> {
  const registry = ctx.modelRegistry;
  const model = modelRef.provider ? registry.find(modelRef.provider, modelRef.id) : ctx.model ? registry.find(ctx.model.provider, ctx.model.id) : undefined;
  if (!model) {
    throw new Error(`Model not found in registry: ${modelRef.provider}/${modelRef.id}`);
  }
  // Calibrate the requested thinking level against THIS model's thinkingLevelMap:
  // a level the model doesn't support (e.g. "high" on gpt-5.6-sol) would make
  // registry.complete() throw. Pick the supported level nearest to the request
  // (same distance → prefer the lower one, so we never silently spend more
  // than the user asked for).
  let reasoning = opts.thinking ?? "medium";
  const map = (model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap;
  if (map && typeof map === "object" && Object.keys(map).length > 0) {
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const idx = levels.indexOf(reasoning as (typeof levels)[number]);
    const supported = levels.filter((l) => map[l] != null);
    if (supported.length > 0 && !supported.includes(reasoning as (typeof levels)[number])) {
      let best = supported[0];
      let bestDist = Number.MAX_SAFE_INTEGER;
      for (const l of supported) {
        const dist = Math.abs(levels.indexOf(l) - idx);
        if (dist < bestDist || (dist === bestDist && levels.indexOf(l) < levels.indexOf(best))) {
          best = l;
          bestDist = dist;
        }
      }
      reasoning = best;
    }
  }
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
  const response = await registry.complete(
    model,
    { systemPrompt, messages } as LlmContext,
    { reasoning: (reasoning ?? "medium") as never } as never,
  );
  const text = (response.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return text;
}

// ---------------------------------------------------------------------------
// Config load/save
// ---------------------------------------------------------------------------

function loadConfig(): ReturnType<typeof normalizeConfig> {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<ReturnType<typeof normalizeConfig>>;
      return normalizeConfig(raw);
    }
  } catch { /* fall through */ }
  return normalizeConfig(null);
}

/**
 * Persist a minimal patch to the global config file (single source of truth
 * across sessions, projects and Pi restarts).
 *
 * Field-level merge: we re-read the on-disk config, apply ONLY the fields in
 * `patch`, then atomic-write. This keeps concurrent Pi instances from
 * clobbering each other: each window only writes the fields its user changed,
 * preserving everything else (including another window's changes).
 */
function saveConfig(patch: Partial<ReturnType<typeof normalizeConfig>>): void {
  try {
    let base: ReturnType<typeof normalizeConfig> = normalizeConfig(null);
    try {
      if (existsSync(CONFIG_PATH)) {
        const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<ReturnType<typeof normalizeConfig>>;
        base = normalizeConfig(onDisk);
      }
    } catch { /* start from defaults if disk read fails */ }

    // Apply patch field-by-field (deep-merge for nested objects).
    const merged = normalizeConfig({ ...base, ...patch });
    if (patch.controller && typeof patch.controller === "object") {
      merged.controller = {
        ...(base.controller ?? {}),
        ...(patch.controller as Partial<typeof base.controller>),
      } as typeof base.controller;
    }
    if (patch.executor && typeof patch.executor === "object") {
      merged.executor = {
        ...(base.executor ?? {}),
        ...(patch.executor as Partial<typeof base.executor>),
      } as typeof base.executor;
    }

    // Atomic write: write temp file then rename, so a crash mid-write can't
    // corrupt the persisted config.
    const tmp = `${CONFIG_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
    renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    console.error("[dual-gate] failed to persist config:", errMsg(e));
  }
}

// ---------------------------------------------------------------------------
// Herdr CLI adapter
// ---------------------------------------------------------------------------

function herdrAvailable(): boolean {
  const env = process.env.HERDR_ENV;
  return env === "1" || env === "true";
}

function parseHerdrJson<T>(raw: string): { ok: boolean; result?: T; error?: string } {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      return { ok: true, result: parsed as T };
    }
    return { ok: true, result: parsed as T };
  } catch {
    return { ok: false, error: "non-JSON herdr output" };
  }
}

async function herdrPaneSplit(opts: { direction: "right" | "down"; cwd: string; noFocus: boolean; ratio?: number }): Promise<string> {
  const args = ["pane", "split", "--current", "--direction", opts.direction, "--cwd", opts.cwd];
  if (opts.ratio !== undefined) args.push("--ratio", String(opts.ratio));
  if (opts.noFocus) args.push("--no-focus");
  const { code, stdout, stderr } = await exec("herdr", args, { timeoutMs: 30_000 });
  if (code !== 0) {
    throw new Error(`herdr pane split failed: ${stderr || stdout || `exit ${code}`}`);
  }
  const parsed = parseHerdrJson<{ pane?: { pane_id?: string } }>(stdout);
  const paneId = parsed.result?.pane?.pane_id;
  if (!paneId) {
    throw new Error(`herdr pane split: no pane id in response: ${stdout.slice(0, 500)}`);
  }
  return paneId;
}

/** Verify a pane still exists (Herdr may recycle panes whose shell never came up). */
async function herdrPaneExists(paneId: string): Promise<boolean> {
  const { code } = await exec("herdr", ["pane", "get", paneId], { timeoutMs: 10_000 });
  return code === 0;
}

async function herdrAgentStart(opts: { name: string; kind: string; pane: string; timeoutMs?: number; args?: string[] }): Promise<void> {
  const args = ["agent", "start", opts.name, "--kind", opts.kind, "--pane", opts.pane];
  if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
  if (opts.args && opts.args.length) args.push("--", ...opts.args);
  const { code, stdout, stderr } = await exec("herdr", args, { timeoutMs: 180_000 });
  if (code !== 0) {
    throw new Error(`herdr agent start failed: ${stderr || stdout || `exit ${code}`}`);
  }
}

async function herdrAgentPrompt(opts: { target: string; text: string; wait?: boolean; timeoutMs?: number }): Promise<{ ok: boolean; error?: string }> {
  const args = ["agent", "prompt", opts.target, opts.text];
  if (opts.wait) args.push("--wait");
  if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
  const { code, stdout, stderr } = await exec("herdr", args, { timeoutMs: (opts.timeoutMs ?? 120_000) + 15_000 });
  if (code !== 0) {
    return { ok: false, error: (stderr || stdout || `exit ${code}`).slice(0, 1000) };
  }
  return { ok: true };
}

async function herdrAgentGet(opts: { target: string }): Promise<{ state?: string; idle?: boolean }> {
  const { code, stdout } = await exec("herdr", ["agent", "get", opts.target], { timeoutMs: 15_000 });
  if (code !== 0) return {};
  try {
    const parsed = JSON.parse(stdout) as Record<string, any>;
    const result = parsed.result ?? parsed;
    return { state: result?.state, idle: result?.idle };
  } catch {
    return {};
  }
}

async function herdrAgentRead(opts: { target: string; lines?: number }): Promise<string> {
  const args = ["agent", "read", opts.target, "--source", "recent-unwrapped", "--lines", String(opts.lines ?? 200)];
  const { code, stdout } = await exec("herdr", args, { timeoutMs: 15_000 });
  if (code !== 0) return "";
  return stdout;
}

async function herdrAgentWait(opts: { target: string; until: string; timeoutMs: number }): Promise<{ ok: boolean; state?: string }> {
  const args = ["agent", "wait", opts.target, "--until", opts.until, "--timeout", String(opts.timeoutMs)];
  const { code, stdout, stderr } = await exec("herdr", args, { timeoutMs: opts.timeoutMs + 15_000 });
  if (code !== 0) {
    return { ok: false, state: (stderr || stdout).slice(0, 300) };
  }
  try {
    const parsed = JSON.parse(stdout) as Record<string, any>;
    const result = parsed.result ?? parsed;
    return { ok: true, state: result?.state };
  } catch {
    return { ok: true };
  }
}

async function herdrPaneClose(paneId: string): Promise<void> {
  await exec("herdr", ["pane", "close", paneId], { timeoutMs: 30_000 });
}

async function herdrAgentList(): Promise<string[]> {
  const { code, stdout } = await exec("herdr", ["agent", "list"], { timeoutMs: 15_000 });
  if (code !== 0) return [];
  try {
    const parsed = JSON.parse(stdout) as Record<string, any>;
    const list = parsed.result ?? parsed;
    if (Array.isArray(list)) {
      return list
        .map((a: any) => (typeof a === "string" ? a : a?.name || a?.agent_name))
        .filter((n: unknown): n is string => typeof n === "string");
    }
    return [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Artifact persistence
// ---------------------------------------------------------------------------

function makeStore(task: TaskRecord): ArtifactStore {
  mkdirSync(task.artifactDir, { recursive: true });
  return {
    write(name, data) {
      const p = join(task.artifactDir, name);
      writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", "utf8");
      return p;
    },
    read(name) {
      const p = join(task.artifactDir, name);
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    },
    dir() {
      return task.artifactDir;
    },
  };
}

function writeMetadata(task: TaskRecord, store: ArtifactStore, extra: Record<string, unknown> = {}): void {
  store.write("metadata.json", {
    taskId: task.taskId,
    controller: task.controllerModel,
    executor: task.executorModel,
    herdrPanel: task.herdrPanelId ?? null,
    herdrAgent: task.herdrAgentName ?? null,
    state: task.state,
    createdAt: task.createdAt,
    ...extra,
  });
}

function writeState(task: TaskRecord, store: ArtifactStore): void {
  store.write("state.json", {
    taskId: task.taskId,
    state: task.state,
    currentStage: task.currentStage,
    iteration: task.iteration,
    expectedVersion: task.expectedVersion,
    gapCount: task.gapCount,
    previousGapCount: task.previousGapCount,
    progress: task.progress,
    sameGapStreak: task.sameGapStreak,
    executorStuck: task.executorStuck,
    specRevisions: task.specRevisions,
    repoPath: task.repoPath,
    worktreePath: task.worktreePath,
    gateFailures: task.gateFailures,
    judgeFailures: task.judgeFailures,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

function writeSpecVersioned(store: ArtifactStore, version: number, contract: AcceptanceContract): void {
  store.write(`spec-v${version}.yaml`, JSON.stringify(contract, null, 2));
  store.write("spec.yaml", JSON.stringify(contract, null, 2)); // latest
}

function stateOf(task: TaskRecord): { symbol: string; label: string } {
  switch (task.state) {
    case "PLANNING": return { symbol: "…", label: "Planning" };
    case "SPAWNING_EXECUTOR": return { symbol: "●", label: "Spawning executor" };
    case "EXECUTING": return { symbol: "●", label: "Executing" };
    case "GATING": return { symbol: "○", label: "Gate" };
    case "FIXING_GATE": return { symbol: "↻", label: "Fixing (gate)" };
    case "FIXING_IMPLEMENTATION": return { symbol: "↻", label: "Fixing implementation" };
    case "REVISING_SPEC": return { symbol: "✎", label: "Revising spec" };
    case "JUDGING": return { symbol: "○", label: "Comparing" };
    case "DIAGNOSING": return { symbol: "?", label: "Diagnosing" };
    case "DONE": return { symbol: "✓", label: "Converged" };
    case "FAILED": return { symbol: "✗", label: "Failed" };
    case "CANCELLED": return { symbol: "—", label: "Cancelled" };
    case "ESCALATED": return { symbol: "!", label: "Escalated" };
    case "WAITING_PERMISSION": return { symbol: "?", label: "Waiting permission" };
    default: return { symbol: "•", label: task.state };
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function updateWidget(ctx: ExtensionContext): void {
  try {
    const rt = getRuntime();
    const task = rt.manager.active();
    const config = rt.config;
    // When Dual-Gate is OFF, it must be invisible in the UI (footer/widget) —
    // OFF fully restores normal Pi (see README: "does not affect normal Pi at all").
    if (!config.enabled || !config.ui.show_widget) {
      ctx.ui.setWidget("dual-gate", undefined);
      return;
    }
    if (!task) {
      ctx.ui.setWidget("dual-gate", [ctx.ui.theme.fg("muted", "dual-gate: idle")]);
      return;
    }
    const s = stateOf(task);
    const controller = resolveModelString(task.controllerModel);
    const exec = resolveModelString(task.executorModel);
    const lines = [
      ctx.ui.theme.fg("accent", `dual-gate · ${s.symbol} ${s.label}`),
      ctx.ui.theme.fg("muted", `  it ${task.iteration} · spec v${task.expectedVersion} · ctl ${controller?.id ?? "?"}`),
      ctx.ui.theme.fg("muted", `  exe ${exec?.id ?? "?"}${task.herdrPanelId ? ` · ${task.herdrPanelId}` : ""}`),
    ];
    ctx.ui.setWidget("dual-gate", lines);
  } catch {
    // widget must never crash the session
  }
}

function setStatus(ctx: ExtensionContext, label: string | undefined): void {
  try {
    // When Dual-Gate is OFF it must leave no trace in the footer/status line.
    if (!getRuntime().config.enabled) {
      ctx.ui.setStatus("dual-gate", undefined);
      return;
    }
    ctx.ui.setStatus("dual-gate", label);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Model picker (fuzzy search + role-aware ordering)
// ---------------------------------------------------------------------------

/**
 * Score a model for a given role. Controller/Judge prefers GPT-official
 * (openai-codex) first; Executor prefers DeepSeek first.
 */
function modelRoleOrder(m: ModelRef, role: "controller" | "executor"): number {
  const prov = m.provider.toLowerCase();
  const id = m.id.toLowerCase();
  const isGpt = prov.includes("openai") || prov.includes("codex") || id.startsWith("gpt");
  const isDeepSeek = prov.includes("deepseek") || id.includes("deepseek");
  if (role === "controller") {
    if (prov === "openai-codex") return 0; // GPT official first
    if (isGpt) return 1;
    if (isDeepSeek) return 3;
    return 2;
  }
  // executor: DeepSeek first, then gateway deepseek, then others
  if (prov === "deepseek") return 0; // DeepSeek official first
  if (isDeepSeek) return 1;
  if (prov === "openai-codex" || isGpt) return 3;
  return 2;
}

/** Match against provider, id and display name.
 *  Scoring-aware: full substring match ranks first, then word-prefix,
 *  then loose subsequence (fuzzy). Avoids "deep" matching "gpt" via
 *  cross-word character scavenging. */
function modelMatches(m: ModelRef, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const prov = m.provider.toLowerCase();
  const id = m.id.toLowerCase();
  const name = m.name.toLowerCase();
  // 1) exact substring in any field
  if (prov.includes(q) || id.includes(q) || name.includes(q)) return true;
  // 2) all query words present as substrings somewhere
  const words = q.split(/\s+/).filter(Boolean);
  if (words.every((w) => prov.includes(w) || id.includes(w) || name.includes(w))) return true;
  // 3) loose fuzzy: each query char in order, but only within a single token
  //    (prevents cross-word matches like "deep" → "gpt")
  const tokens = [prov, ...id.split(/[-.\/]/), ...name.split(/[\s()-]+/)];
  for (const tok of tokens) {
    let pos = 0;
    let ok = true;
    for (const ch of q) {
      pos = tok.indexOf(ch, pos);
      if (pos === -1) {
        ok = false;
        break;
      }
      pos += 1;
    }
    if (ok) return true;
  }
  return false;
}

async function pickModel(ctx: ExtensionContext, registry: ModelRegistryAdapter, title: string, role: "controller" | "executor" = "controller"): Promise<ModelRef | null> {
  let models = registry.available();
  if (models.length === 0) {
    ctx.ui.notify("No models available in registry", "warning");
    return null;
  }
  // Search first: user types a fuzzy keyword (e.g. "gpt", "deepseek", "sol"),
  // then picks from the filtered list. Empty = show all (sorted by role).
  const query = await ctx.ui.input(`${title} — 输入关键字模糊搜索（如 gpt/deepseek/5.6，直接回车看全部）:`, "");
  const q = (query ?? "").trim();
  if (q && q !== "*") {
    models = models.filter((m) => modelMatches(m, q));
    if (models.length === 0) {
      ctx.ui.notify(`No models match "${q}"`, "warning");
      // fall back to full list
      models = registry.available();
    }
  }
  // Sort by role preference, then by provider/id.
  models.sort((a, b) => {
    const r = modelRoleOrder(a, role) - modelRoleOrder(b, role);
    if (r !== 0) return r;
    return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
  });
  const labels = models.map((m) => `${m.provider}/${m.id}${m.name && m.name !== `${m.provider}/${m.id}` ? ` — ${m.name}` : ""}`);
  const chosen = await ctx.ui.select(title, labels);
  if (!chosen) return null;
  const idx = labels.indexOf(chosen);
  return models[idx] ?? null;
}

// ---------------------------------------------------------------------------
// Worktree helper
// ---------------------------------------------------------------------------

async function gitRoot(cwd: string): Promise<string | null> {
  const { code, stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15_000 });
  return code === 0 ? stdout.trim() : null;
}

async function createWorktree(repoPath: string, taskId: string): Promise<string> {
  const branch = `dg-${taskId}`;
  const wt = join(repoPath, "..", `.dg-${taskId}`);
  const { code, stdout, stderr } = await exec("git", ["worktree", "add", "-b", branch, wt], { cwd: repoPath, timeoutMs: 60_000 });
  if (code !== 0) {
    throw new Error(`worktree create failed: ${stderr || stdout}`);
  }
  return wt;
}

// ---------------------------------------------------------------------------
// LLM roles
// ---------------------------------------------------------------------------

async function plan(ctx: ExtensionCommandContext, task: TaskRecord, config: ReturnType<typeof normalizeConfig>, store: ArtifactStore): Promise<AcceptanceContract> {
  const registry = makeRegistry(ctx);
  const controllerRef = registry.find(config.controller.model) ?? { provider: "", id: config.controller.model, name: config.controller.model };
  const thinking = config.controller.thinking;

  ctx.ui.notify("Dual-Gate: Controller planning…", "info");
  setStatus(ctx, "dual-gate: planning");

  const system = `You are the Controller/Architect of a Dual-Gate workflow. You do NOT write code or modify the repository.
Produce a precise Acceptance Contract (Expected Outcome) that specifies WHAT to achieve and WHY, without implementing it.
"Specify outcome, not implementation." Only state implementation constraints when the architecture genuinely requires them.
Answer the user's original request in the context of the repository: ${task.repoPath}.

Output ONLY a fenced YAML block with EXACTLY this structure:

goal: <single sentence, what to achieve>
context: <1-2 sentences, repository/project context relevant to the task>
architecture:
  relevant_components:
    - <files/dirs/systems that likely matter>
constraints:
  - <what must not be broken>
expected_outcome:
  - <observable behavior after completion>
acceptance_criteria:
  - <measurable done-condition>
validation:
  required:
    - <which validation must pass (tests/lint/typecheck/build)>
risk:
  level: low|medium|high
  concerns:
    - <specific risks>`;

  const user = `REPOSITORY: ${task.repoPath}\n\nTASK ID: ${task.taskId}\n\nORIGINAL USER REQUEST:\n${task.originalRequest}\n\nProduce the Acceptance Contract (fenced YAML).`;

  const text = await completeText(ctx, controllerRef, system, user, { thinking });

  store.write("task.md", `# Task ${task.taskId}\n\n## Original Request\n${task.originalRequest}\n`);
  const contract = parseContractYaml(text, task.originalRequest, 1);
  writeSpecVersioned(store, 1, contract);
  store.write("spec-raw-v1.txt", text);
  return contract;
}

// ---------------------------------------------------------------------------
// The closed-loop orchestration
// ---------------------------------------------------------------------------

async function orchestrate(ctx: ExtensionCommandContext, task: TaskRecord): Promise<void> {
  const rt = getRuntime();
  const config = rt.config;
  const store = makeStore(task);
  rt.running = true;

  try {
    // ---- Phase 0: Plan (Expected V1) ----
    rt.manager.patch(task.taskId, { state: "PLANNING", currentStage: "planning" });
    writeMetadata(task, store);
    writeState(task, store);
    let contract = await plan(ctx, task, config, store);
    rt.manager.patch(task.taskId, { risk: contract.risk.level });
    writeState(task, store);

    // ---- High-risk confirmation ----
    if (contract.risk.level === "high") {
      rt.manager.patch(task.taskId, { state: "WAITING_PERMISSION", currentStage: "high-risk-confirm" });
      writeState(task, store);
      ctx.ui.notify("⚠ Dual-Gate: High-risk task — requires your confirmation", "warning");
      const ok = await ctx.ui.confirm(
        "High-risk task",
        `This task touches: ${contract.risk.concerns.join(", ") || "sensitive areas"}.\nContinue in a new DeepSeek pane?`,
      );
      if (!ok) {
        rt.manager.patch(task.taskId, { state: "CANCELLED", currentStage: "cancelled", error: "High-risk task declined by user" });
        writeState(task, store);
        ctx.ui.notify("Dual-Gate: cancelled", "info");
        return;
      }
      rt.manager.patch(task.taskId, { state: "PLANNING", currentStage: "planning" });
      writeState(task, store);
    }

    // ---- Worktree isolation (concurrency) ----
    const repoPath = task.repoPath;
    const mode = config.worktree.mode;
    let worktreePath: string | null = null;
    const concurrentWriters = rt.manager.all().filter((t) => t.taskId !== task.taskId && ["EXECUTING", "GATING", "JUDGING", "FIXING_IMPLEMENTATION", "REVISING_SPEC"].includes(t.state)).length;
    if (mode === "isolated" || (mode === "auto" && concurrentWriters > 0)) {
      worktreePath = await createWorktree(repoPath, task.taskId);
      rt.manager.patch(task.taskId, { worktreePath });
    }
    writeState(task, store);

    // ---- Closed loop ----
    const maxIterations = config.loop.max_iterations;
    let iteration = 0;
    let gateResult: GateResult;
    let diff = "";
    let report: Record<string, unknown> = {};
    let lastJudge: JudgeOutput | null = null;
    let executorActive = false;

    while (iteration < maxIterations) {
      iteration += 1;
      rt.manager.patch(task.taskId, { iteration, currentStage: `iteration-${iteration}` });
      writeState(task, store);

      // ---- Spawn executor (only on first iteration or spec revision) ----
      if (!executorActive) {
        await spawnExecutor(ctx, task, config);
        if (task.state !== "EXECUTING") return; // spawn failed
        executorActive = true;
      }

      // ---- Execute ----
      const cwd = worktreePath ?? repoPath;
      const waitResult = await waitForExecutorCompletion(task, config, {
        onTick: (state) => setStatus(ctx, `dual-gate: executing (${state})`),
      });
      if (waitResult.lost) {
        // L1 (live session) lost — recover from L2 durable context in a new pane.
        ctx.ui.notify("Dual-Gate: executor session lost — recovering from checkpoint…", "warning");
        const recovered = await recoverExecutor(ctx, task, config, contract, store, iteration);
        if (!recovered) {
          rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: "Executor session lost and recovery failed" });
          writeState(task, store);
          return;
        }
        continue; // re-enter loop with the recovered session
      }
      if (!waitResult.completed) {
        rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: "Executor timed out" });
        writeState(task, store);
        ctx.ui.notify("Dual-Gate: executor timed out", "error");
        return;
      }

      // ---- Read the execution report ----
      const finalText = await herdrAgentRead({ target: task.herdrAgentName!, lines: 400 });
      report = extractReportFromAgentMessage(finalText);
      store.write("execution-report.yaml", JSON.stringify(report, null, 2));
      store.write(`execution-report-it${iteration}.yaml`, JSON.stringify(report, null, 2));
      store.write(`execution-report-raw-it${iteration}.md`, finalText);

      // ---- Deterministic gate ----
      rt.manager.patch(task.taskId, { state: "GATING", currentStage: "gating" });
      writeState(task, store);
      gateResult = await runDeterministicGate(ctx, task, config);

      // ---- Gate fix loop (deterministic; no GPT) ----
      let gateLoop = 0;
      while (!gateResult.passed && gateLoop < config.gate.max_retries) {
        rt.manager.patch(task.taskId, {
          state: "FIXING_GATE",
          currentStage: "fixing-gate",
          gateFailures: (task.gateFailures ?? 0) + 1,
        });
        writeState(task, store);
        ctx.ui.notify(`Dual-Gate: Gate FAIL — sending fix to same pane (${gateLoop + 1}/${config.gate.max_retries})`, "warning");

        const gateErrors = gateResult.steps.filter((s) => !s.passed && !s.skipped)
          .map((s) => `[${s.name}] ${s.command}\n${s.outputTail}`)
          .join("\n\n");
        const fixPrompt = buildExecutorPrompt({
          originalRequest: task.originalRequest,
          contract,
          repoPath: cwd,
          mode: "gate-fix",
          gateErrors,
          taskId: task.taskId,
          panelTitle: derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest),
        });
        const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: fixPrompt, wait: false, timeoutMs: 120_000 });
        if (!send.ok) {
          throw new Error(`fix prompt failed: ${send.error}`);
        }
        await waitForExecutorCompletion(task, config);
        const fixText = await herdrAgentRead({ target: task.herdrAgentName!, lines: 400 });
        report = extractReportFromAgentMessage(fixText);
        store.write("execution-report.yaml", JSON.stringify(report, null, 2));
        gateResult = await runDeterministicGate(ctx, task, config);
        gateLoop++;
      }

      if (!gateResult.passed) {
        rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: `Gate failed after ${gateLoop} retries` });
        writeState(task, store);
        ctx.ui.notify("Dual-Gate: gate failed after retries — see .pi/dual-gate artifacts", "error");
        return;
      }

      // ---- Judge: compare Expected ↔ Actual ----
      rt.manager.patch(task.taskId, { state: "JUDGING", currentStage: "judging" });
      writeState(task, store);
      ctx.ui.notify("Dual-Gate: Gate PASS — comparing Expected ↔ Actual…", "info");

      diff = await getDiff(cwd);
      const gateSummary = formatGateResult(gateResult);
      let judgeOutput: JudgeOutput;
      try {
        judgeOutput = await judge(ctx, task, config, contract, report, diff, gateSummary, lastJudge);
      } catch (e) {
        rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: `Judge failed: ${errMsg(e)}` });
        writeState(task, store);
        ctx.ui.notify(`Dual-Gate: Judge error — ${errMsg(e)}`, "error");
        return;
      }
      store.write(`judge-it${iteration}.yaml`, JSON.stringify(judgeOutput, null, 2));
      store.write("judge.yaml", JSON.stringify(judgeOutput, null, 2));
      lastJudge = judgeOutput;

      // ---- L2 durable context: Executor Checkpoint (compress context, do not lose state) ----
      const checkpoint = buildExecutorCheckpoint({
        taskId: task.taskId,
        originalRequest: task.originalRequest,
        expectedVersion: contract.version,
        contract,
        iteration,
        report,
        delta: judgeOutput.verdict !== "converged" ? judgeOutput.delta : null,
        gateSummary: formatGateResult(gateResult),
        lastVerdict: judgeOutput.verdict,
      });
      store.write(`checkpoint-it${iteration}.yaml`, checkpoint);
      store.write("checkpoint.yaml", checkpoint);

      // ---- Convergence tracking ----
      const gapCount = judgeOutput.gaps.length;
      const sameGap = lastJudge ? sameGaps(lastJudge, judgeOutput) : false;
      const conv = trackConvergence(task, gapCount, sameGap);
      rt.manager.patch(task.taskId, {
        gapCount: conv.gapCount,
        previousGapCount: conv.previousGapCount,
        progress: conv.progress,
        sameGapStreak: conv.sameGapStreak,
        executorStuck: conv.executorStuck,
      });
      writeState(task, store);

      // ---- Decide by verdict ----
      if (judgeOutput.verdict === "converged") {
        rt.manager.patch(task.taskId, { state: "DONE", currentStage: "done", verdict: "converged" });
        writeState(task, store);
        writeMetadata(task, store);
        await presentConverged(ctx, task, contract, report, diff, gateResult, iteration);
        // Mark pane title with DONE (keep by default for inspection).
        if (task.herdrPanelId) {
          const base = derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest);
          await exec("herdr", ["pane", "rename", task.herdrPanelId, `${base} · DONE`], { timeoutMs: 15_000 }).catch(() => {});
        }
        if (config.panel.on_complete === "close" && task.herdrPanelId) {
          await herdrPaneClose(task.herdrPanelId);
        }
        return;
      }

      if (judgeOutput.verdict === "blocked") {
        rt.manager.patch(task.taskId, { state: "ESCALATED", currentStage: "escalated", verdict: "blocked" });
        writeState(task, store);
        writeMetadata(task, store);
        ctx.ui.notify("Dual-Gate: BLOCKED — needs your decision", "warning");
        await presentEscalation(ctx, task, judgeOutput);
        return;
      }

      if (judgeOutput.verdict === "implementation_gap") {
        // Expected stays; send delta to same panel.
        rt.manager.patch(task.taskId, { state: "FIXING_IMPLEMENTATION", currentStage: "fixing-implementation" });
        writeState(task, store);
        if (conv.executorStuck) {
          // Executor stuck on same gap for 2 iterations: suggest upgrade.
          rt.manager.patch(task.taskId, { executorStuck: true });
          writeState(task, store);
          ctx.ui.notify("Dual-Gate: executor stuck on the same gap — consider /dual executor <stronger-model>", "warning");
        }
        ctx.ui.notify(`Dual-Gate: implementation gap (${judgeOutput.gaps.length}) — sending delta to same pane`, "info");
        const delta = judgeOutput.delta.required_changes.length
          ? judgeOutput.delta
          : { matched: judgeOutput.matched, missing: [], incorrect: [], unexpected: [], required_changes: judgeOutput.implementation_changes, must_preserve: judgeOutput.matched };
        const fixPrompt = buildExecutorPrompt({
          originalRequest: task.originalRequest,
          contract,
          repoPath: cwd,
          mode: "delta-fix",
          delta,
          taskId: task.taskId,
          panelTitle: derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest),
        });
        const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: fixPrompt, wait: false, timeoutMs: 120_000 });
        if (!send.ok) {
          throw new Error(`delta fix prompt failed: ${send.error}`);
        }
        // Loop continues → EXECUTE again (same panel, same context)
        continue;
      }

      if (judgeOutput.verdict === "spec_gap" || judgeOutput.verdict === "mixed_gap") {
        // Revise Expected Outcome first (Controller), then recompute delta, then fix.
        rt.manager.patch(task.taskId, { state: "REVISING_SPEC", currentStage: "revising-spec" });
        writeState(task, store);
        ctx.ui.notify("Dual-Gate: spec gap — revising Expected Outcome…", "info");
        const revised = await reviseSpec(ctx, task, config, contract, judgeOutput, report, store);
        if (!revised) {
          // blocked: user intent cannot be satisfied
          rt.manager.patch(task.taskId, { state: "ESCALATED", currentStage: "escalated", verdict: "blocked" });
          writeState(task, store);
          writeMetadata(task, store);
          await presentEscalation(ctx, task, judgeOutput);
          return;
        }
        contract = revised.contract;
        rt.manager.patch(task.taskId, { expectedVersion: contract.version, specRevisions: (task.specRevisions ?? 0) + 1 });
        writeState(task, store);

        // Spec revision: send a SPEC UPDATE to the SAME session (incremental, no restart).
        const previousVersion = contract.version - 1;
        const deltaForUpdate: Delta = {
          matched: judgeOutput.delta.matched.length ? judgeOutput.delta.matched : judgeOutput.matched,
          missing: judgeOutput.delta.missing,
          incorrect: judgeOutput.delta.incorrect,
          unexpected: judgeOutput.delta.unexpected,
          required_changes: revised.implementation_changes.length ? revised.implementation_changes : judgeOutput.delta.required_changes,
          must_preserve: judgeOutput.delta.must_preserve.length ? judgeOutput.delta.must_preserve : judgeOutput.matched,
        };
        const specUpdatePrompt = buildSpecUpdatePrompt({
          previousVersion,
          contract,
          revision: revised.revision,
          delta: deltaForUpdate,
          originalRequest: task.originalRequest,
          repoPath: cwd,
          taskId: task.taskId,
        });
        store.write("spec-update.md", specUpdatePrompt);
        rt.manager.patch(task.taskId, { state: "FIXING_IMPLEMENTATION", currentStage: "fixing-implementation" });
        writeState(task, store);
        ctx.ui.notify(`Dual-Gate: Expected v${previousVersion} → v${contract.version} — sending SPEC UPDATE to same pane`, "info");
        const specSend = await herdrAgentPrompt({ target: task.herdrAgentName!, text: specUpdatePrompt, wait: false, timeoutMs: 120_000 });
        if (!specSend.ok) {
          throw new Error(`spec update prompt failed: ${specSend.error}`);
        }
        // Loop continues → EXECUTE again (same panel, same session)
        continue;
      }

      // Unknown verdict → escalate
      rt.manager.patch(task.taskId, { state: "ESCALATED", currentStage: "escalated", verdict: "blocked", error: `Unknown judge verdict: ${judgeOutput.verdict}` });
      writeState(task, store);
      writeMetadata(task, store);
      await presentEscalation(ctx, task, judgeOutput);
      return;
    }

    // ---- Loop threshold reached: convergence diagnosis ----
    rt.manager.patch(task.taskId, { state: "DIAGNOSING", currentStage: "diagnosing" });
    writeState(task, store);
    ctx.ui.notify("Dual-Gate: iteration threshold reached — diagnosing convergence…", "info");
    const diagnosis = await convergenceDiagnosis(ctx, task, config, contract, store);
    if (!diagnosis) {
      rt.manager.patch(task.taskId, { state: "ESCALATED", currentStage: "escalated", error: "Convergence diagnosis failed" });
      writeState(task, store);
      await presentEscalation(ctx, task, lastJudge ?? undefined);
      return;
    }
    store.write("diagnosis.yaml", JSON.stringify(diagnosis, null, 2));

    switch (diagnosis.assessment) {
      case "continue": {
        // Extend the loop window for a few more iterations.
        rt.manager.patch(task.taskId, { state: "FIXING_IMPLEMENTATION", currentStage: "diagnosed-continue" });
        writeState(task, store);
        const delta: Delta = lastJudge?.delta ?? { matched: [], missing: [], incorrect: [], unexpected: [], required_changes: [], must_preserve: [] };
        const fixPrompt = buildExecutorPrompt({
          originalRequest: task.originalRequest,
          contract,
          repoPath: worktreePath ?? repoPath,
          mode: "delta-fix",
          delta,
          taskId: task.taskId,
          panelTitle: derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest),
        });
        const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: fixPrompt, wait: false, timeoutMs: 120_000 });
        if (!send.ok) {
          throw new Error(`delta fix prompt failed: ${send.error}`);
        }
        // continue the loop with extended budget
        iteration = 0; // reset counter; the while loop re-checks
        // NOTE: while loop bound uses `iteration < maxIterations`; resetting would infinite-loop,
        // so we cap by re-arming with a new bound.
        return;
      }
      case "architecture": {
        rt.manager.patch(task.taskId, { state: "ESCALATED", currentStage: "escalated", error: `Architecture cannot meet goal: ${diagnosis.recommendation}` });
        writeState(task, store);
        writeMetadata(task, store);
        await presentEscalation(ctx, task, lastJudge ?? undefined, `Architecture issue: ${diagnosis.recommendation}`);
        return;
      }
      case "spec": {
        // Re-run spec revision
        rt.manager.patch(task.taskId, { state: "REVISING_SPEC", currentStage: "revising-spec-diagnosed" });
        writeState(task, store);
        const revised = await reviseSpec(ctx, task, config, contract, lastJudge!, report, store);
        if (!revised) {
          rt.manager.patch(task.taskId, { state: "ESCALATED", currentStage: "escalated", verdict: "blocked" });
          writeState(task, store);
          await presentEscalation(ctx, task, lastJudge ?? undefined);
          return;
        }
        contract = revised.contract;
        rt.manager.patch(task.taskId, { expectedVersion: contract.version, specRevisions: (task.specRevisions ?? 0) + 1 });
        writeState(task, store);
        return; // loop continues via re-entry from user or next task
      }
      case "executor": {
        rt.manager.patch(task.taskId, { state: "ESCALATED", currentStage: "escalated", executorStuck: true, error: `Executor stuck: ${diagnosis.recommendation}` });
        writeState(task, store);
        writeMetadata(task, store);
        ctx.ui.notify("Dual-Gate: executor stuck — upgrade with /dual executor <stronger-model>, then re-run", "warning");
        await presentEscalation(ctx, task, lastJudge ?? undefined, `Executor capacity: ${diagnosis.recommendation}`);
        return;
      }
      case "user":
      default: {
        rt.manager.patch(task.taskId, { state: "ESCALATED", currentStage: "escalated" });
        writeState(task, store);
        writeMetadata(task, store);
        await presentEscalation(ctx, task, lastJudge ?? undefined, diagnosis.recommendation);
        return;
      }
    }
  } catch (e) {
    rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: errMsg(e) });
    writeState(task, store);
    ctx.ui.notify(`Dual-Gate: error — ${errMsg(e)}`, "error");
  } finally {
    rt.running = false;
    updateWidget(ctx);
    setStatus(ctx, undefined);
  }
}

function sameGaps(a: JudgeOutput, b: JudgeOutput): boolean {
  if (!a || !b) return false;
  const norm = (xs: string[]) => xs.map((x) => x.toLowerCase().trim()).filter(Boolean).sort();
  const ga = norm(a.gaps).join("|");
  const gb = norm(b.gaps).join("|");
  return ga !== "" && ga === gb;
}

// ---------------------------------------------------------------------------
// Spawn executor in a Herdr pane
// ---------------------------------------------------------------------------

async function spawnExecutor(ctx: ExtensionCommandContext, task: TaskRecord, config: ReturnType<typeof normalizeConfig>): Promise<void> {
  const rt = getRuntime();
  const registry = makeRegistry(ctx);
  const executorRef = registry.find(config.executor.model) ?? { provider: "", id: config.executor.model, name: config.executor.model };

  ctx.ui.notify(`Dual-Gate: spawning Executor (${executorRef.id})…`, "info");
  setStatus(ctx, "dual-gate: spawning executor");
  rt.manager.patch(task.taskId, { state: "SPAWNING_EXECUTOR", currentStage: "spawning" });
  writeState(task, makeStore(task));

  const cwd = task.worktreePath ?? task.repoPath;
  const panelTitle = derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest);
  const agentName = deriveAgentName(task.taskId);

  try {
    // 1. Split a new pane to the right of the caller pane.
    //    --cwd uses the MAIN pane cwd (ctx.cwd), NOT the target repo: Herdr
    //    recycles panes whose shell fails to come up in a git repo cwd (its
    //    shell detection trips on git-aware prompts). The executor receives the
    //    real REPOSITORY path in its prompt and cd's there itself.
    //    --ratio: worker pane takes ~40% width by default (config.panel.ratio).
    const splitCwd = ctx.cwd ?? cwd;
    let paneId: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const candidate = await herdrPaneSplit({ direction: config.panel.direction, cwd: splitCwd, noFocus: true, ratio: config.panel.ratio });
      // Pane may be recycled instantly if its shell did not come up; verify.
      await sleep(1500);
      if (await herdrPaneExists(candidate)) {
        paneId = candidate;
        break;
      }
      ctx.ui.notify(`Dual-Gate: pane ${candidate} recycled — retrying (${attempt}/3)`, "warning");
    }
    if (!paneId) {
      throw new Error("failed to create a persistent executor pane after 3 attempts");
    }
    rt.manager.patch(task.taskId, { herdrPanelId: paneId, currentStage: "spawned" });

    // 2. Rename the pane
    await exec("herdr", ["pane", "rename", paneId, panelTitle], { timeoutMs: 15_000 });

    // 3. Start the pi agent with the executor model.
    //    Executor keeps ALL default built-in tools (read/bash/edit/write).
    //    --no-extensions: the worker pane's pi must NOT load user extensions
    //    (incl. dual-gate itself), otherwise it would recursively intercept
    //    input and try to spawn another worker pane.
    await herdrAgentStart({
      name: agentName,
      kind: "pi",
      pane: paneId,
      timeoutMs: 180_000,
      args: [`--model=${config.executor.model}`, "--no-extensions"],
    });
    rt.manager.patch(task.taskId, { herdrAgentName: agentName, panelCreated: true });

    // 4. Send the initial task
    const contract = JSON.parse(makeStore(task).read("spec.yaml") ?? "{}") as AcceptanceContract;
    const prompt = buildExecutorPrompt({
      originalRequest: task.originalRequest,
      contract,
      repoPath: cwd,
      mode: "initial",
      taskId: task.taskId,
      panelTitle,
    });
    const send = await herdrAgentPrompt({ target: agentName, text: prompt, wait: false, timeoutMs: 120_000 });
    if (!send.ok) {
      throw new Error(`agent prompt failed: ${send.error}`);
    }

    rt.manager.patch(task.taskId, { state: "EXECUTING", currentStage: "executing" });
    writeState(task, makeStore(task));
    ctx.ui.notify(`Dual-Gate: Executor running in ${panelTitle}`, "info");
  } catch (e) {
    rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: errMsg(e) });
    writeState(task, makeStore(task));
    ctx.ui.notify(`Dual-Gate: executor spawn failed — ${errMsg(e)}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Session recovery: L1 (live) lost → new pane from L2 durable context
// ---------------------------------------------------------------------------

async function recoverExecutor(
  ctx: ExtensionCommandContext,
  task: TaskRecord,
  config: ReturnType<typeof normalizeConfig>,
  contract: AcceptanceContract,
  store: ArtifactStore,
  iteration: number,
): Promise<boolean> {
  const rt = getRuntime();
  const registry = makeRegistry(ctx);
  const executorRef = registry.find(config.executor.model) ?? { provider: "", id: config.executor.model, name: config.executor.model };

  try {
    // Old pane may still exist but be unusable; try to close it, ignore errors.
    if (task.herdrPanelId) {
      await herdrPaneClose(task.herdrPanelId).catch(() => {});
    }

    const cwd = task.worktreePath ?? task.repoPath;
    const baseTitle = derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest);
    const panelTitle = `${baseTitle} · recovered`;
    const agentName = (deriveAgentName(task.taskId) + "-r").slice(0, 31);

    const splitCwd = ctx.cwd ?? cwd;
    let paneId: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const candidate = await herdrPaneSplit({ direction: config.panel.direction, cwd: splitCwd, noFocus: true, ratio: config.panel.ratio });
      await sleep(1500);
      if (await herdrPaneExists(candidate)) {
        paneId = candidate;
        break;
      }
      ctx.ui.notify(`Dual-Gate: recovery pane ${candidate} recycled — retrying (${attempt}/3)`, "warning");
    }
    if (!paneId) {
      throw new Error("failed to create a persistent recovery pane after 3 attempts");
    }
    await exec("herdr", ["pane", "rename", paneId, panelTitle], { timeoutMs: 15_000 });
    await herdrAgentStart({
      name: agentName,
      kind: "pi",
      pane: paneId,
      timeoutMs: 180_000,
      args: [`--model=${config.executor.model}`, "--no-extensions"],
    });
    rt.manager.patch(task.taskId, { herdrPanelId: paneId, herdrAgentName: agentName, panelCreated: true });

    // Rebuild minimal prompt from L2 durable context.
    const checkpoint = store.read("checkpoint.yaml") ?? buildExecutorCheckpoint({
      taskId: task.taskId,
      originalRequest: task.originalRequest,
      expectedVersion: contract.version,
      contract,
      iteration,
      report: {},
      delta: null,
      gateSummary: "no gate run yet",
    });
    const recoveryPrompt = buildRecoveryPrompt({
      taskId: task.taskId,
      originalRequest: task.originalRequest,
      contract,
      checkpoint,
      repoPath: cwd,
      delta: null,
    });
    store.write("recovery-prompt.md", recoveryPrompt);

    const send = await herdrAgentPrompt({ target: agentName, text: recoveryPrompt, wait: false, timeoutMs: 120_000 });
    if (!send.ok) throw new Error(`recovery prompt failed: ${send.error}`);

    rt.manager.patch(task.taskId, { state: "EXECUTING", currentStage: "executing-recovered" });
    writeState(task, store);
    ctx.ui.notify(`Dual-Gate: recovered in ${panelTitle}`, "info");
    return true;
  } catch (e) {
    ctx.ui.notify(`Dual-Gate: recovery failed — ${errMsg(e)}`, "error");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wait for executor completion (poll)
// ---------------------------------------------------------------------------

async function waitForExecutorCompletion(
  task: TaskRecord,
  config: ReturnType<typeof normalizeConfig>,
  opts: { pollMs?: number; timeoutMs?: number; onTick?: (state: string) => void },
): Promise<{ completed: boolean; state?: string; lost?: boolean }> {
  const agent = task.herdrAgentName;
  if (!agent) return { completed: false, lost: true };
  const pollMs = opts.pollMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 45 * 60 * 1000;
  const started = Date.now();
  let lastState = "unknown";
  let lostStreak = 0;
  while (Date.now() - started < timeoutMs) {
    const st = await herdrAgentGet({ target: agent });
    if (!st.state && st.idle === undefined) {
      lostStreak++;
      if (lostStreak >= 3) {
        // Pane/agent no longer resolves — L1 session lost.
        return { completed: false, lost: true, state: lastState };
      }
    } else {
      lostStreak = 0;
      lastState = st.state ?? (st.idle === true ? "idle" : lastState);
    }
    opts.onTick?.(lastState);
    if (st.state === "done" || st.state === "idle") {
      return { completed: true, state: st.state };
    }
    if (st.state === "blocked") {
      return { completed: true, state: "blocked" };
    }
    await sleep(pollMs);
  }
  return { completed: false, state: lastState };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

async function runDeterministicGate(
  ctx: ExtensionCommandContext,
  task: TaskRecord,
  config: ReturnType<typeof normalizeConfig>,
): Promise<GateResult> {
  const store = makeStore(task);
  const cwd = task.worktreePath ?? task.repoPath;
  const discovery = discoverGateCommands(cwd);
  store.write("gate-discovery.json", { commands: discovery.commands, notes: discovery.notes });
  const result = await runGate(cwd, discovery, { timeoutMs: config.gate.timeoutMs });
  store.write("gate.log", formatGateResult(result) + "\n" + result.steps.map((s) => `--- ${s.command} ---\n${s.outputTail}`).join("\n"));
  return result;
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

async function judge(
  ctx: ExtensionCommandContext,
  task: TaskRecord,
  config: ReturnType<typeof normalizeConfig>,
  contract: AcceptanceContract,
  report: Record<string, unknown>,
  diff: string,
  gateSummary: string,
  previousJudge?: JudgeOutput | null,
): Promise<JudgeOutput> {
  const registry = makeRegistry(ctx);
  const controllerRef = registry.find(config.controller.model) ?? { provider: "", id: config.controller.model, name: config.controller.model };
  const thinking = config.controller.thinking;

  const system = `You are the Judge of a Dual-Gate workflow. The deterministic gate passed.
Compare the Expected Outcome against the Actual Outcome and characterize the exact gap.
Priority: User Intent > Expected Outcome > Implementation.
Do not re-read the whole repository unless you detect ambiguity, risk, an unexpected diff, or an architecture concern — then read only the minimal necessary files.
Output ONLY a fenced YAML block with the exact structure described in the user message.`;

  const user = buildJudgePrompt({
    originalRequest: task.originalRequest,
    contract,
    report,
    diff,
    gateSummary,
    taskId: task.taskId,
    risk: task.risk,
    iteration: task.iteration,
    previousJudge,
    expectedVersion: contract.version,
  });

  const text = await completeText(ctx, controllerRef, system, user, { thinking });
  const parsed = parseJudgeOutput(text);
  if (!parsed) {
    throw new Error(`Judge returned unparseable output:\n${text.slice(0, 800)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Spec revision (Controller)
// ---------------------------------------------------------------------------

async function reviseSpec(
  ctx: ExtensionCommandContext,
  task: TaskRecord,
  config: ReturnType<typeof normalizeConfig>,
  contract: AcceptanceContract,
  judgeOutput: JudgeOutput,
  actualReport: Record<string, unknown>,
  store: ArtifactStore,
): Promise<SpecRevisionResult | null> {
  const registry = makeRegistry(ctx);
  const controllerRef = registry.find(config.controller.model) ?? { provider: "", id: config.controller.model, name: config.controller.model };
  const thinking = config.controller.thinking;

  const system = `You are the Controller/Architect of a Dual-Gate workflow. Revise the Expected Outcome to match repository reality while preserving the user's core intent.
Priority: User Intent > Expected Outcome > Implementation.
You may adjust: technical approach, intermediate state, implementation constraints, acceptance details, test method.
You MUST NOT change the user's core goal. If the user's intent cannot be met at all, output a fenced YAML block whose only content is: blocked: true
Output the FULL revised contract as a fenced YAML block with the exact structure described in the user message.`;

  const user = buildSpecRevisionPrompt({
    originalRequest: task.originalRequest,
    contract,
    judge: judgeOutput,
    actualReport,
    repoPath: task.repoPath,
  });

  const text = await completeText(ctx, controllerRef, system, user, { thinking });

  // blocked?
  if (/blocked:\s*true/i.test(text)) {
    return null;
  }

  const parsed = parseSpecRevision(text, task.originalRequest, contract.version + 1);
  if (!parsed) {
    throw new Error(`Spec revision produced unparseable output:\n${text.slice(0, 800)}`);
  }
  const version = parsed.revision.version > contract.version ? parsed.revision.version : contract.version + 1;
  const revised = { ...parsed.contract, version };
  writeSpecVersioned(store, version, revised);
  store.write(`spec-revision-v${version}.md`, text);
  store.write(`spec-revisions.jsonl`, (store.read("spec-revisions.jsonl") ?? "") + JSON.stringify(parsed.revision) + "\n");
  return { contract: revised, revision: parsed.revision, implementation_changes: judgeOutput.implementation_changes, delta: judgeOutput.delta };
}

// ---------------------------------------------------------------------------
// Convergence diagnosis
// ---------------------------------------------------------------------------

async function convergenceDiagnosis(
  ctx: ExtensionCommandContext,
  task: TaskRecord,
  config: ReturnType<typeof normalizeConfig>,
  contract: AcceptanceContract,
  store: ArtifactStore,
): Promise<ConvergenceDiagnosis | null> {
  const registry = makeRegistry(ctx);
  const controllerRef = registry.find(config.controller.model) ?? { provider: "", id: config.controller.model, name: config.controller.model };
  const thinking = config.controller.thinking;

  const history = {
    iterations: task.iteration,
    specVersion: contract.version,
    gapCount: task.gapCount,
    previousGapCount: task.previousGapCount,
    progress: task.progress,
    sameGapStreak: task.sameGapStreak,
    executorStuck: task.executorStuck,
    specRevisions: task.specRevisions,
  };

  const system = `You are the Convergence Diagnostician of a Dual-Gate workflow. Decide what to do at the iteration threshold.
Output ONLY a fenced YAML block with the exact structure described in the user message.`;
  const user = buildConvergenceDiagnosisPrompt({ originalRequest: task.originalRequest, contract, history, taskId: task.taskId });

  const text = await completeText(ctx, controllerRef, system, user, { thinking });
  const parsed = parseConvergenceDiagnosis(text);
  if (!parsed) {
    throw new Error(`Convergence diagnosis produced unparseable output:\n${text.slice(0, 800)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Git diff
// ---------------------------------------------------------------------------

async function getDiff(cwd: string): Promise<string> {
  const { code, stdout } = await exec("git", ["diff", "HEAD"], { cwd, timeoutMs: 30_000 });
  if (code === 0 && stdout.trim()) return stdout;
  const { code: c2, stdout: s2 } = await exec("git", ["diff"], { cwd, timeoutMs: 30_000 });
  if (c2 === 0) return s2;
  return "";
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

async function presentConverged(
  ctx: ExtensionCommandContext,
  task: TaskRecord,
  contract: AcceptanceContract,
  report: Record<string, unknown>,
  diff: string,
  gateResult: GateResult,
  iteration: number,
): Promise<void> {
  const controller = resolveModelString(task.controllerModel);
  const exec = resolveModelString(task.executorModel);
  const files = Array.isArray(report.files_changed)
    ? (report.files_changed as Array<{ path?: string; purpose?: string }>).map((f) => `  - ${f.path ?? ""}${f.purpose ? ` — ${f.purpose}` : ""}`).join("\n")
    : "";
  const tests = (report.tests as { passed?: string[]; failed?: string[] }) ?? {};
  const gateLines = gateResult.steps.map((s) => `  ${s.passed ? "✓" : "✗"} ${s.command}`).join("\n");

  const summary = [
    "Dual-Gate ✓ CONVERGED",
    `Expected Outcome   ✓ v${contract.version}`,
    `Implementation     ✓`,
    `Validation         ✓`,
    `Iterations         ${iteration}`,
    `Spec revisions     ${task.specRevisions}`,
    `Final Judge        ${controller?.id ?? "?"} / ${task.state === "DONE" ? "converged" : ""}`,
    "",
    "Result",
    `  ${typeof report.summary === "string" && report.summary ? report.summary : "Task completed and converged."}`,
  ];

  if (files) {
    summary.push("", "Changed", files);
  }
  if ((tests.passed ?? []).length || (tests.failed ?? []).length) {
    summary.push("", "Validation", `  Tests passed: ${(tests.passed ?? []).length}`, `  Tests failed: ${(tests.failed ?? []).length}`, gateLines);
  }
  if (task.specRevisions > 0) {
    const specLog = readSpecRevisionLog(task);
    summary.push("", "Spec revisions", `  ${task.specRevisions} revision(s) — see .pi/dual-gate/${task.taskId}/spec-v*.yaml`, ...specLog.map((r) => `  • v${r.version}: ${r.reason.join("; ")}`));
  }
  summary.push("", "Notes", "  Panel kept open for inspection (config: panel.on_complete). Run /dual cleanup to close done worker panels.");

  ctx.ui.notify("Dual-Gate ✓ CONVERGED", "success");
  showText(summary.join("\n"));
}

function readSpecRevisionLog(task: TaskRecord): Array<{ version: number; reason: string[] }> {
  try {
    const store = makeStore(task);
    const raw = store.read("spec-revisions.jsonl");
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map((l) => {
      try {
        const j = JSON.parse(l);
        return { version: j.version ?? 0, reason: j.reason ?? [] };
      } catch {
        return { version: 0, reason: [] };
      }
    });
  } catch {
    return [];
  }
}

async function presentEscalation(ctx: ExtensionCommandContext, task: TaskRecord, judge?: JudgeOutput, extraNote?: string): Promise<void> {
  const lines = [
    "Dual-Gate: ESCALATED",
    "",
    "Execution encountered:",
    ...(judge?.gaps ?? []).map((g) => `  • ${g}`),
    ...(judge?.implementation_changes ?? []).map((f) => `  • ${f}`),
    judge?.reason ? `  reason: ${judge.reason}` : "",
    extraNote ? `  note: ${extraNote}` : "",
    "",
    "You decide:",
    "  A) Continue fixing in the same DeepSeek pane (edit required fixes manually in the pane or tell me).",
    "  B) Accept current state as done (I will mark it complete).",
    "  C) Abort the task.",
    "The DeepSeek worker pane is kept open for your inspection.",
  ];
  ctx.ui.notify("Dual-Gate: needs your decision", "warning");
  showText(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export default function dualGateExtension(pi: ExtensionAPI): void {
  piRef = pi;
  runtime = {
    config: loadConfig(),
    manager: new TaskManager(process.cwd()),
    store: null,
    registry: null,
    running: false,
    stopRequested: false,
  };

  const rt = getRuntime();

  pi.on("session_start", (_event, ctx) => {
    rt.manager = new TaskManager(ctx.cwd);
    updateWidget(ctx);
  });

  // ---- Intercept user input ----
  pi.on("input", async (event, ctx) => {
    const config = rt.config;
    if (!config.enabled) return;
    if (!event || typeof event !== "object" || typeof (event as any).text !== "string") return;
    const text = (event as any).text.trim();
    if (!text || text.startsWith("/")) return;

    if (rt.manager.getBypassNext()) {
      rt.manager.setBypassNext(false);
      return;
    }

    if (rt.running || rt.manager.active()) return;

    if ((globalThis as any).__dg_handling_input) return;
    (globalThis as any).__dg_handling_input = true;
    try {
      const task = rt.manager.begin(text, {
        controller: resolveModelString(config.controller.model) ?? { provider: "", id: config.controller.model, name: config.controller.model },
        executor: resolveModelString(config.executor.model) ?? { provider: "", id: config.executor.model, name: config.executor.model },
      });
      updateWidget(ctx);
      setStatus(ctx, "dual-gate: starting");
      const cmdCtx = ctx as unknown as ExtensionCommandContext;
      await orchestrate(cmdCtx, task);
    } finally {
      (globalThis as any).__dg_handling_input = false;
    }
  });

  const SUBCOMMANDS: Array<{ name: string; label: string; description: string }> = [
    { name: "on", label: "Turn ON", description: "Enable Dual-Gate (default: off)" },
    { name: "off", label: "Turn OFF", description: "Disable Dual-Gate, restore normal Pi" },
    { name: "status", label: "Status", description: "Show current state (models, task, pane, session)" },
    { name: "models", label: "Models", description: "Show current model configuration" },
    { name: "controller", label: "Controller / Judge", description: "Pick the Controller/Judge model" },
    { name: "executor", label: "Executor", description: "Pick the Executor model" },
    { name: "thinking", label: "Thinking level", description: "Set Controller thinking level (minimal..max)" },
    { name: "cancel", label: "Cancel task", description: "Cancel the active task, keep the pane" },
    { name: "bypass", label: "Bypass next", description: "Next prompt uses normal Pi, then Dual-Gate resumes" },
    { name: "cleanup", label: "Cleanup panes", description: "Close done Dual-Gate worker panes" },
    { name: "help", label: "Help", description: "Show the full command list" },
  ];

  pi.registerCommand("dual", {
    description: "Dual-Gate Orchestrator: on/off/status/models/thinking/controller/executor/cancel/bypass/cleanup",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const p = (prefix ?? "").trim().split(/\s+/).filter(Boolean);
      if (p.length > 1) return null; // only complete the first (subcommand) token
      const q = p[0] ?? "";
      const items: AutocompleteItem[] = SUBCOMMANDS.map((s) => ({
        value: s.name,
        label: s.label,
        description: s.description,
      }));
      const filtered = items.filter((i) => i.value.startsWith(q));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      let sub = (parts[0] ?? "").toLowerCase();
      const rest = parts.slice(1);

      // Bare `/dual` → interactive subcommand menu (like Pi's native pickers)
      if (!sub) {
        const labels = SUBCOMMANDS.map((s) => `${s.label} — ${s.description}`);
        const chosen = await ctx.ui.select("Dual-Gate — pick an action:", labels);
        if (!chosen) return;
        sub = SUBCOMMANDS.find((s) => `${s.label} — ${s.description}` === chosen)?.name ?? "";
        if (!sub) return;
      }

      switch (sub) {
        case "on": {
          rt.config.enabled = true;
          saveConfig({ enabled: true });
          const ctl = resolveModelString(rt.config.controller.model);
          const exe = resolveModelString(rt.config.executor.model);
          ctx.ui.notify("Dual-Gate enabled", "success");
          showText(
            [
              "Dual-Gate enabled",
              `Controller  ${ctl?.id ?? "?"} · ${rt.config.controller.thinking}`,
              `Executor    ${exe?.id ?? "?"}`,
              "Runtime     Herdr",
            ].join("\n"),
          );
          updateWidget(ctx);
          break;
        }
        case "off": {
          rt.config.enabled = false;
          saveConfig({ enabled: false });
          ctx.ui.notify("Dual-Gate disabled — normal Pi", "info");
          // Clear any stale footer status + widget: OFF must be fully invisible.
          setStatus(ctx, undefined);
          updateWidget(ctx);
          break;
        }
        case "status": {
          await showStatus(ctx, rt);
          break;
        }
        case "models": {
          await showModels(ctx, rt);
          break;
        }
        case "controller": {
          await setController(ctx, rt, rest);
          break;
        }
        case "executor": {
          await setExecutor(ctx, rt, rest);
          break;
        }
        case "thinking": {
          await setThinking(ctx, rt, rest);
          break;
        }
        case "cancel": {
          const t = rt.manager.cancelActive("cancelled by user");
          if (t) {
            writeState(t, makeStore(t));
            // Mark pane title CANCELLED (pane kept for inspection).
            if (t.herdrPanelId) {
              const base = derivePanelTitle(t.taskId, basename(t.repoPath), t.originalRequest);
              await exec("herdr", ["pane", "rename", t.herdrPanelId, `${base} · CANCELLED`], { timeoutMs: 15_000 }).catch(() => {});
            }
            ctx.ui.notify(`Dual-Gate: task ${t.taskId} cancelled (panel kept open)`, "info");
          } else {
            ctx.ui.notify("Dual-Gate: no active task", "info");
          }
          updateWidget(ctx);
          break;
        }
        case "bypass": {
          rt.manager.setBypassNext(true);
          ctx.ui.notify("Dual-Gate: next prompt will use normal Pi (bypass)", "info");
          break;
        }
        case "cleanup": {
          await cleanup(ctx, rt);
          break;
        }
        case "help":
        default: {
          showText(
            [
              "Dual-Gate commands:",
              "  /dual on|off               enable / disable",
              "  /dual status               current state",
              "  /dual models               model configuration",
              "  /dual controller [id]      pick controller model",
              "  /dual executor [id]        pick executor model",
              "  /dual thinking [level]     thinking level (minimal..max)",
              "  /dual cancel               cancel active task",
              "  /dual bypass               next prompt runs on normal Pi",
              "  /dual cleanup              close done worker panels",
            ].join("\n"),
          );
          break;
        }
      }
    },
  });

  async function showStatus(ctx: ExtensionCommandContext, rt: DgRuntime): Promise<void> {
    const config = rt.config;
    const ctl = resolveModelString(config.controller.model);
    const exe = resolveModelString(config.executor.model);
    const task = rt.manager.active();
    const herdrOk = herdrAvailable();
    const lines: string[] = [];
    if (config.enabled) {
      lines.push("DUAL-GATE ON");
      lines.push(`Controller   ${ctl?.id ?? "?"}`);
      lines.push(`Thinking     ${config.controller.thinking}`);
      lines.push(`Executor     ${exe?.id ?? "?"}`);
      lines.push("Herdr        " + (herdrOk ? "Ready" : "NOT DETECTED"));
      lines.push(`Config       ${CONFIG_PATH} (跨 session/项目持久化)`);
      if (task) {
        const s = stateOf(task);
        const paneName = task.herdrPanelId
          ? derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest)
          : "not created";
        lines.push("", "State", `  ${s.symbol} ${s.label}`, `  Stage ${task.currentStage}`);
        lines.push(`  Iteration ${task.iteration} · spec v${task.expectedVersion} · gaps ${task.gapCount}`);
        lines.push("Executor");
        lines.push(`  Pane ${task.herdrPanelId ?? "-"}`);
        lines.push(`  Name ${paneName}`);
        // Session liveness: query herdr agent (not assumed).
        let alive = false;
        if (task.herdrAgentName) {
          const st = await herdrAgentGet({ target: task.herdrAgentName });
          alive = !!(st.state || st.idle !== undefined);
        }
        lines.push(`  Session ${alive ? "active" : "unknown"}`);
        lines.push(`  Task ${task.taskId}`);
      } else {
        lines.push("", "State", "  Idle");
      }
    } else {
      lines.push("DUAL-GATE OFF (normal Pi)");
    }
    showText(lines.join("\n"));
    updateWidget(ctx);
  }

  async function showModels(ctx: ExtensionCommandContext, rt: DgRuntime): Promise<void> {
    const config = rt.config;
    const ctl = resolveModelString(config.controller.model);
    const exe = resolveModelString(config.executor.model);
    const reg = makeRegistry(ctx);
    const ctlValid = reg.find(config.controller.model) ? "✓" : "⚠";
    const exeValid = reg.find(config.executor.model) ? "✓" : "⚠";
    showText(
      [
        "Dual-Gate Models",
        `Controller / Judge  ${ctl?.id ?? "?"} ${ctlValid}`,
        `Thinking            ${config.controller.thinking}`,
        `Executor            ${exe?.id ?? "?"} ${exeValid}`,
        "",
        "Set with:  /dual controller [id]   /dual executor [id]   /dual thinking [level]",
        "Available models come from the current Pi registry (ctx.modelRegistry).",
        `Persisted to: ${CONFIG_PATH} (跨 session/项目生效)`,
      ].join("\n"),
    );
  }

  async function setController(ctx: ExtensionCommandContext, rt: DgRuntime, rest: string[]): Promise<void> {
    if (rest.length > 0) {
      const spec = rest.join(" ");
      const ref = makeRegistry(ctx).find(spec);
      if (!ref) {
        ctx.ui.notify(`Controller model not found: ${spec}`, "error");
        return;
      }
      rt.config.controller.model = `${ref.provider}/${ref.id}`;
      saveConfig({ controller: { model: rt.config.controller.model } });
      ctx.ui.notify(`Controller → ${ref.id}（已保存，跨 session/项目生效）`, "success");
      return;
    }
    const picked = await pickModel(ctx, makeRegistry(ctx), "Controller / Judge model:", "controller");
    if (picked) {
      rt.config.controller.model = `${picked.provider}/${picked.id}`;
      saveConfig({ controller: { model: rt.config.controller.model } });
      ctx.ui.notify(`Controller → ${picked.id}（已保存，跨 session/项目生效）`, "success");
    }
  }

  async function setExecutor(ctx: ExtensionCommandContext, rt: DgRuntime, rest: string[]): Promise<void> {
    if (rest.length > 0) {
      const spec = rest.join(" ");
      const ref = makeRegistry(ctx).find(spec);
      if (!ref) {
        ctx.ui.notify(`Executor model not found: ${spec}`, "error");
        return;
      }
      rt.config.executor.model = `${ref.provider}/${ref.id}`;
      saveConfig({ executor: { model: rt.config.executor.model } });
      ctx.ui.notify(`Executor → ${ref.id}（已保存，跨 session/项目生效）`, "success");
      return;
    }
    const picked = await pickModel(ctx, makeRegistry(ctx), "Executor model:", "executor");
    if (picked) {
      rt.config.executor.model = `${picked.provider}/${picked.id}`;
      saveConfig({ executor: { model: rt.config.executor.model } });
      ctx.ui.notify(`Executor → ${picked.id}（已保存，跨 session/项目生效）`, "success");
    }
  }

  async function setThinking(ctx: ExtensionCommandContext, rt: DgRuntime, rest: string[]): Promise<void> {
    if (rest.length > 0) {
      const level = rest[0].toLowerCase();
      if (!isThinking(level)) {
        ctx.ui.notify(`Invalid thinking level: ${level}`, "error");
        return;
      }
      rt.config.controller.thinking = level as ThinkingLevel;
      saveConfig({ controller: { thinking: rt.config.controller.thinking } });
      ctx.ui.notify(`Thinking → ${level}`, "success");
      return;
    }
    const levels: Array<{ value: ThinkingLevel; label: string }> = [
      { value: "minimal", label: "Minimal" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "X-High" },
      { value: "max", label: "Max" },
    ];
    const chosen = await ctx.ui.select("Thinking level:", levels.map((l) => l.label));
    if (chosen) {
      const picked = levels.find((l) => l.label === chosen);
      if (picked) {
        rt.config.controller.thinking = picked.value;
        saveConfig({ controller: { thinking: picked.value } });
        ctx.ui.notify(`Thinking → ${picked.value}`, "success");
      }
    }
  }

  async function cleanup(ctx: ExtensionCommandContext, rt: DgRuntime): Promise<void> {
    const done = rt.manager.all().filter((t) => ["DONE", "FAILED", "CANCELLED", "ESCALATED"].includes(t.state) && t.herdrPanelId);
    if (done.length === 0) {
      ctx.ui.notify("Dual-Gate: no done worker panels to clean up", "info");
      return;
    }
    for (const t of done) {
      if (t.herdrPanelId) {
        try {
          await herdrPaneClose(t.herdrPanelId);
          ctx.ui.notify(`Closed panel ${t.herdrPanelId} (${t.taskId})`, "info");
        } catch (e) {
          ctx.ui.notify(`Failed to close ${t.herdrPanelId}: ${errMsg(e)}`, "warning");
        }
      }
    }
    ctx.ui.notify(`Dual-Gate: cleaned up ${done.length} panel(s)`, "success");
  }
}
