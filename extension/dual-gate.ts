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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
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
  findAvailableAuthenticatedModel,
  taskDirFor,
  projectDirFor,
  projectMilestoneDirFor,
  generateProjectId,
  createArtifactStore,
  buildProductManagerPlanPrompt,
  buildMilestoneCompletionFeedbackPrompt,
  buildProductAcceptancePrompt,
  buildProductManagerRecoveryPrompt,
  parseProductMilestoneFeedback,
  extractCorrelatedYamlBlock,
  productManagerPiArgs as buildProductManagerPiArgs,
  parseProjectPlan,
  topologicallyOrderMilestones,
  scheduleMilestoneBatches,
  isParallelBatch,
  milestoneToAcceptanceContract,
  buildProjectAcceptancePrompt,
  parseProjectAcceptance,
  isActiveProjectState,
  isProjectFinalizationStopped,
  canAcceptProject,
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
  sameJudgeGaps,
  TaskManager,
  loadProjectsFromDisk,
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
import type { ProjectPlan, ProjectRecord, ProjectMilestoneContext, ProductManagerRecord, ProjectMilestoneFeedback } from "./types.ts";
import { discoverGateCommands, runGate, formatGateResult, skippedGateResult, type GateResult } from "./gate.ts";
import { runReflexLayer, makeJevClient, formatReflexResult, type JevClient, type ReflexRunInput, type ReflexResult } from "./reflex/index.ts";
import { JevBackend } from "./reflex/backend.ts";
import { normalizeReflexPolicy, type ReflexPolicy, type IterationState, type TurnSignal, type LoopAction } from "./reflex/types.ts";
import { pushWindow } from "./reflex/progress.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXT_VERSION = "1.0.0";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "dual-gate.json");
const HERDR_PI_STATE_EXTENSION_PATH = join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");

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
  pauseRequested: boolean;
  /** A separate flag keeps an argument-less resume distinct from no resume. */
  resumeRequested: boolean;
  pendingResumeRequirement: string | undefined;
  activeProject: ProjectRecord | null;
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

function taskStopped(task: TaskRecord): boolean {
  const rt = getRuntime();
  const current = rt.manager.get(task.taskId);
  return rt.stopRequested || !current || ["CANCELLED", "FAILED", "ESCALATED", "DONE"].includes(current.state);
}

function higherRisk(
  contract: AcceptanceContract,
  deterministic: ReturnType<typeof detectRisk>,
): AcceptanceContract {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  if (rank[deterministic.level] <= rank[contract.risk.level]) return contract;
  return {
    ...contract,
    risk: {
      level: deterministic.level,
      concerns: [...new Set([...contract.risk.concerns, ...deterministic.concerns])],
    },
  };
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
    if (patch.reflex && typeof patch.reflex === "object") {
      merged.reflex = {
        ...(base.reflex ?? {}),
        ...(patch.reflex as Partial<typeof base.reflex>),
      } as typeof base.reflex;
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

/**
 * Check whether the current Pi process can actually drive Herdr panes:
 * it must run INSIDE a Herdr pane (HERDR_PANE_ID + HERDR_ENV set).
 * Without these, `herdr pane split --current` fails with
 * "--current requires HERDR_PANE_ID" and every executor spawn errors out.
 */
function herdrEnvironmentProblem(): string | null {
  if (!process.env.HERDR_PANE_ID) return "Pi 不在 Herdr pane 中运行：缺少 HERDR_PANE_ID";
  if (!herdrAvailable()) return "Pi 不在 Herdr 环境中运行：缺少 HERDR_ENV";
  return null;
}

function parseHerdrJson<T>(raw: string): { ok: boolean; result?: T; error?: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    // Herdr CLI responses are envelopes: { id, result: { ... }, type }.
    // Return the payload, not the envelope itself, so callers can read fields
    // such as result.pane.pane_id consistently.
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      return { ok: true, result: (parsed as { result: T }).result };
    }
    return { ok: true, result: parsed as T };
  } catch {
    return { ok: false, error: "non-JSON herdr output" };
  }
}

// Herdr can immediately recycle panes split with a Git-worktree cwd. The
// Executor/PM always receive the repository explicitly in their prompts, so
// start side panes from a stable non-repository shell location instead.
function stableHerdrPaneCwd(): string {
  return process.env.HOME || homedir() || process.cwd();
}

const PM_WRITE_GUARD_EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "pm-write-guard.ts");
const PM_SEARCH_EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "pm-search.ts");

async function herdrPaneSplit(opts: { direction: "right" | "down"; cwd: string; noFocus: boolean; ratio?: number; env?: Record<string, string> }): Promise<string> {
  const args = ["pane", "split", "--current", "--direction", opts.direction, "--cwd", opts.cwd];
  for (const [key, value] of Object.entries(opts.env ?? {})) args.push("--env", `${key}=${value}`);
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

function deriveProductManagerName(projectId: string): string {
  return `pm-${projectId.replace(/[^a-z0-9_-]/gi, "").slice(-24).toLowerCase()}`;
}

function deriveProductManagerTitle(projectId: string, repoPath: string): string {
  return `PM · ${basename(repoPath)} · ${projectId}`;
}

/** PM deliberately gets only read-only Pi tools; all artifact writes stay in Main Pi. */
function productManagerPiArgs(model: string): string[] {
  return buildProductManagerPiArgs(model, PM_WRITE_GUARD_EXTENSION_PATH, PM_SEARCH_EXTENSION_PATH);
}

function executorPiArgs(model: string): string[] {
  // Keep all user extensions disabled to prevent recursive Dual-Gate tasks,
  // but explicitly retain Herdr's Pi state reporter so worker lifecycle can
  // be observed reliably. An empty model means "use the parent Pi's current
  // model" (Executor=default), so no --model flag is passed at all.
  const args = ["--no-extensions"];
  if (model && model !== "default") {
    args.unshift("--model", model);
  }
  if (existsSync(HERDR_PI_STATE_EXTENSION_PATH)) {
    args.push("--extension", HERDR_PI_STATE_EXTENSION_PATH);
  }
  return args;
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
  if (opts.wait) {
    args.push("--wait");
    if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
  }
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
    const agent = result?.agent ?? result;
    const state = agent?.agent_status ?? agent?.state;
    return { state, idle: typeof agent?.idle === "boolean" ? agent.idle : state === "idle" };
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
    error: task.error,
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
    case "PAUSED": return { symbol: "❚❚", label: "Paused" };
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
      const project = rt.activeProject;
      const pm = project?.productManager;
      ctx.ui.setWidget("dual-gate", [ctx.ui.theme.fg("muted", project ? `dual-gate project · ${project.status} · PM ${pm?.state ?? "none"}${pm?.paneId ? ` · ${pm.paneId}` : ""}` : "dual-gate: idle")]);
      return;
    }
    const s = stateOf(task);
    const controller = resolveModelString(task.controllerModel);
    const execRaw = task.executorModel;
    const executorLabel = execRaw === "default" ? "default（跟随主 Pi）" : (resolveModelString(execRaw)?.id ?? execRaw);
    const lines = [
      ctx.ui.theme.fg("accent", `dual-gate · ${s.symbol} ${s.label}`),
      ctx.ui.theme.fg("muted", `  it ${task.iteration} · spec v${task.expectedVersion} · ctl ${controller?.id ?? "?"}`),
      ctx.ui.theme.fg("muted", `  exe ${executorLabel}${task.herdrPanelId ? ` · ${task.herdrPanelId}` : ""}`),
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

/** Remove an isolated worktree (and its branch) after parallel execution. */
async function removeWorktree(repoPath: string, worktreePath: string, taskId: string): Promise<void> {
  await exec("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, timeoutMs: 30_000 }).catch(() => {});
  const branch = `dg-${taskId}`;
  await exec("git", ["branch", "-D", branch], { cwd: repoPath, timeoutMs: 15_000 }).catch(() => {});
}

/**
 * Commit the executor's changes inside an isolated worktree so they can be
 * merged back. The executor deliberately does not commit, so we do it here
 * on its branch before merging into the main checkout.
 */
async function commitWorktree(repoPath: string, worktreePath: string, taskId: string): Promise<{ ok: boolean; message?: string }> {
  const branch = `dg-${taskId}`;
  const configOk = await exec("git", ["config", "user.email", "dual-gate@local"], { cwd: worktreePath, timeoutMs: 15_000 }).catch(() => ({ code: 1 } as const));
  await exec("git", ["config", "user.name", "Dual-Gate"], { cwd: worktreePath, timeoutMs: 15_000 }).catch(() => {});
  const add = await exec("git", ["add", "-A"], { cwd: worktreePath, timeoutMs: 30_000 });
  if (add.code !== 0) return { ok: false, message: add.stderr };
  const status = await exec("git", ["status", "--porcelain"], { cwd: worktreePath, timeoutMs: 15_000 });
  if (status.code === 0 && !status.stdout.trim()) {
    return { ok: true, message: "no changes" }; // nothing to commit
  }
  const commit = await exec("git", ["commit", "-m", `dual-gate: ${taskId}`], { cwd: worktreePath, timeoutMs: 30_000 });
  if (commit.code !== 0) return { ok: false, message: commit.stderr || commit.stdout };
  return { ok: true, message: commit.stdout.slice(0, 300) };
}

/**
 * Resolve a merge conflict in a test file by concatenating both sides (minus
 * conflict markers), deduplicating imports. Test files are additive: both
 * parallel milestones' tests belong in the final tree. Returns true when the
 * conflict was resolved and staged.
 */
async function resolveTestFileConflict(repoPath: string, worktreePath: string, file: string): Promise<boolean> {
  void repoPath;
  const abs = join(worktreePath, file);
  let raw: string;
  try { raw = readFileSync(abs, "utf8"); } catch { return false; }
  if (!raw.includes("<<<<<<<")) return false;
  const segments = raw.split(/^<{7} [^\n]*\n/m);
  const blocks: string[] = [];
  for (const seg of segments) {
    const oursEnd = seg.indexOf("=======\n");
    const theirsStart = seg.indexOf(">>>>>>>");
    if (oursEnd !== -1 && theirsStart !== -1) {
      const ours = seg.slice(0, oursEnd);
      const theirs = seg.slice(oursEnd + 8, theirsStart).replace(/^>+[^\n]*$/m, "");
      blocks.push(ours, theirs);
    } else {
      blocks.push(seg);
    }
  }
  const merged = blocks.join("");
  // Deduplicate import lines (keep first occurrence).
  const seen = new Set<string>();
  const out = merged.split(/\r?\n/).map((line) => {
    if (/^import .* from ".+";?$/.test(line.trim())) {
      const key = line.trim();
      if (seen.has(key)) return "";
      seen.add(key);
    }
    return line;
  }).filter((l, i, arr) => !(l === "" && (i === 0 || arr[i - 1] === ""))).join("\n");
  writeFileSync(abs, out, "utf8");
  const add = await exec("git", ["add", file], { cwd: worktreePath, timeoutMs: 15_000 });
  return add.code === 0;
}

/**
 * Merge a completed parallel worktree branch back into the main checkout.
 * Returns the merge outcome; on conflict the worktree is left in place for
 * inspection and the milestone is marked MERGE_CONFLICT.
 */
async function mergeWorktreeBack(repoPath: string, worktreePath: string, taskId: string): Promise<{ outcome: "merged" | "conflict" | "skipped"; message?: string }> {
  const branch = `dg-${taskId}`;
  const { code, stdout, stderr } = await exec("git", ["merge", branch, "--no-edit", "--no-ff"], { cwd: repoPath, timeoutMs: 60_000 });
  if (code === 0) return { outcome: "merged", message: stdout.slice(0, 500) };
  return { outcome: "conflict", message: (stderr || stdout).slice(0, 500) };
}

/** Resolve whether a milestone ran in an isolated worktree for this batch. */
async function gitIsClean(repoPath: string): Promise<boolean> {
  const { code, stdout } = await exec("git", ["status", "--porcelain"], { cwd: repoPath, timeoutMs: 15_000 });
  return code === 0 && stdout.trim().length === 0;
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
  // Show a working message so the user knows it's thinking (not frozen),
  // and reflect the actual controller model + thinking level.
  try {
    const ctlLabel = controllerRef.id || config.controller.model;
    ctx.ui.setWorkingMessage(`Dual-Gate · ${ctlLabel} (${config.controller.thinking}) 正在规划…`);
  } catch { /* ignore */ }
  const t0 = Date.now();

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

  try {
    ctx.ui.setWorkingMessage();
  } catch { /* ignore */ }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  ctx.ui.notify(`Dual-Gate: 规划完成（${elapsed}s）`, "info");
  setStatus(ctx, `dual-gate: planned (${elapsed}s)`);

  store.write("task.md", `# Task ${task.taskId}\n\n## Original Request\n${task.originalRequest}\n`);
  const contract = parseContractYaml(text, task.originalRequest, 1);
  presentPlanningSummary(task, contract, elapsed);
  writeSpecVersioned(store, 1, contract);
  store.write("spec-raw-v1.txt", text);
  return contract;
}

// ---------------------------------------------------------------------------
// Controller plan visibility
// ---------------------------------------------------------------------------

/** Display the Controller's actionable plan, never its private reasoning. */
function presentPlanningSummary(task: TaskRecord, contract: AcceptanceContract, elapsed: string): void {
  const bullets = (items: string[], empty = "（未指定）") =>
    items.length ? items.map((item) => `  • ${item}`).join("\n") : `  ${empty}`;
  showText([
    `## Dual-Gate · Controller 规划完成（${elapsed}s）`,
    `任务：${task.taskId}`,
    "",
    `**目标**\n${contract.goal}`,
    "",
    `**相关组件**\n${bullets(contract.architecture.relevant_components)}`,
    "",
    `**约束**\n${bullets(contract.constraints)}`,
    "",
    `**预期结果**\n${bullets(contract.expected_outcome)}`,
    "",
    `**验收标准**\n${bullets(contract.acceptance_criteria)}`,
    "",
    `**验证计划**\n${bullets(contract.validation.required)}`,
    "",
    `**风险：${contract.risk.level}**\n${bullets(contract.risk.concerns, "无特别风险")}`,
    "",
    "接下来：将该契约交给 Executor 实现，并以 Gate + Judge 验收。",
  ].join("\n"));
}

// ---------------------------------------------------------------------------
// The closed-loop orchestration
// ---------------------------------------------------------------------------

async function orchestrate(ctx: ExtensionCommandContext, task: TaskRecord, options: { initialContract?: AcceptanceContract; projectContext?: ProjectMilestoneContext; suppressGlobalFlags?: boolean; resumeFromCheckpoint?: boolean } = {}): Promise<void> {
  const rt = getRuntime();
  const config = rt.config;
  const store = makeStore(task);
  const suppress = options.suppressGlobalFlags === true;
  // Project batch runs hold rt.running themselves; individual milestone loops
  // must not clobber it (parallel members would reset each other's flag).
  if (!suppress) {
    rt.running = true;
    rt.stopRequested = false;
  }

  try {
    // ---- Phase 0: Plan (Expected V1) ----
    rt.manager.patch(task.taskId, { state: "PLANNING", currentStage: "planning" });
    writeMetadata(task, store);
    writeState(task, store);
    let contract: AcceptanceContract;
    if (options.initialContract) {
      contract = options.initialContract;
      store.write("task.md", `# Task ${task.taskId}\n\n## Original Request\n${task.originalRequest}\n`);
      writeSpecVersioned(store, contract.version, contract);
      presentPlanningSummary(task, contract, "project plan");
    } else if (options.resumeFromCheckpoint) {
      // Restart an interrupted task: reuse the latest persisted spec (no new
      // Controller planning) and continue the closed loop from its progress.
      const raw = store.read("spec.yaml");
      if (!raw) {
        throw new Error(`cannot resume ${task.taskId}: spec.yaml missing`);
      }
      contract = JSON.parse(raw) as AcceptanceContract;
      rt.manager.patch(task.taskId, { expectedVersion: contract.version });
      writeState(task, store);
      ctx.ui.notify(`Dual-Gate: resuming ${task.taskId} from checkpoint (spec v${contract.version})`, "info");
    } else {
      contract = await plan(ctx, task, config, store);
    }
    if (taskStopped(task)) return;
    // Model-produced risk can add detail, but cannot downgrade deterministic
    // risk derived from the user's original request.
    contract = higherRisk(contract, detectRisk(task.originalRequest));
    writeSpecVersioned(store, contract.version, contract);
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
      if (taskStopped(task)) return;
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
    // A project batch may have pre-created an isolated worktree (parallel
    // milestones); reuse it instead of creating a second one.
    if (task.worktreePath && existsSync(task.worktreePath)) {
      worktreePath = task.worktreePath;
    } else if (mode === "isolated" || (mode === "auto" && concurrentWriters > 0)) {
      worktreePath = await createWorktree(repoPath, task.taskId);
      if (taskStopped(task)) return;
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

    // ---- Reflex Layer (System-1) runtime state ----
    const reflexEnabled = config.reflex.enabled;
    const reflexPolicy: ReflexPolicy = normalizeReflexPolicy({
      mode: config.reflex.mode,
      backend: config.reflex.backend,
      jev_deadline_ms: config.reflex.jev_deadline_ms,
    });
    const reflexJev: JevClient | undefined =
      reflexEnabled && config.reflex.backend !== "rule"
        ? makeJevClient(new JevBackend(), reflexPolicy)
        : undefined;
    // Persisted reflex history (survives pause/resume within one orchestrate call).
    let reflexHistory = loadReflexHistory(store);
    let iterStates: IterationState[] = [];
    let turnSignals: TurnSignal[] = [];

    while (iteration < maxIterations) {
      if (taskStopped(task)) return;
      iteration += 1;
      rt.manager.patch(task.taskId, { iteration, currentStage: `iteration-${iteration}` });
      writeState(task, store);

      // ---- Pause checkpoint (user may pause at any point) ----
      const pause = await pauseCheckpoint(ctx, task, config, store);
      if (!pause.resumed) return; // cancelled/failed while paused
      if (pause.newRequirement) {
        // Re-analyze: merge the new requirement into the contract (spec v+1).
        ctx.ui.notify("Dual-Gate: re-analyzing new requirement…", "info");
        const revised = await reviseSpec(ctx, task, config, contract, {
          verdict: "spec_gap",
          confidence: "medium",
          expected: contract.expected_outcome,
          actual: [],
          matched: [],
          gaps: ["New requirement from user: " + pause.newRequirement],
          implementation_changes: [],
          spec_changes: ["Merge new requirement"],
          delta: { matched: [], missing: [], incorrect: [], unexpected: [], required_changes: [], must_preserve: [] },
          reason: "User requested a change during execution.",
        }, report, store, options.projectContext);
        if (revised) {
          contract = revised.contract;
          rt.manager.patch(task.taskId, { expectedVersion: contract.version, specRevisions: (task.specRevisions ?? 0) + 1 });
          writeState(task, store);
        }
      }

      // ---- Spawn executor (only on first iteration or spec revision) ----
      if (!executorActive) {
        await spawnExecutor(ctx, task, config, options.projectContext);
        if (taskStopped(task) || task.state !== "EXECUTING") return; // stopped or spawn failed
        executorActive = true;
      }

      // ---- Execute ----
      const cwd = worktreePath ?? repoPath;
      const waitResult = await waitForExecutorCompletion(task, config, {
        onTick: (state) => setStatus(ctx, `dual-gate: executing (${state})`),
        shouldStop: () => taskStopped(task),
        shouldPause: () => rt.pauseRequested,
      });
      if (taskStopped(task)) return;
      if (waitResult.paused) {
        const pause = await pauseCheckpoint(ctx, task, config, store);
        if (!pause.resumed) return;
        if (pause.newRequirement) {
          const revised = await reviseSpec(ctx, task, config, contract, {
            verdict: "spec_gap", confidence: "medium", expected: contract.expected_outcome, actual: [], matched: [],
            gaps: ["New requirement from user: " + pause.newRequirement], implementation_changes: [], spec_changes: ["Merge new requirement"],
            delta: { matched: [], missing: [], incorrect: [], unexpected: [], required_changes: [], must_preserve: [] },
            reason: "User requested a change during execution.",
          }, report, store, options.projectContext);
          if (revised) {
            contract = revised.contract;
            rt.manager.patch(task.taskId, { expectedVersion: contract.version, specRevisions: (task.specRevisions ?? 0) + 1 });
            writeState(task, store);
            const update = buildExecutorPrompt({
              originalRequest: task.originalRequest, contract, repoPath: cwd, mode: "delta-fix",
              delta: { matched: [], missing: [], incorrect: [], unexpected: [], required_changes: revised.implementation_changes, must_preserve: [] },
              taskId: task.taskId, panelTitle: derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest), artifactDir: store.dir(),
            });
            const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: update, wait: false, timeoutMs: 120_000 });
            if (taskStopped(task)) return;
            if (!send.ok) throw new Error(`requirement update prompt failed: ${send.error}`);
          }
        }
        continue;
      }
      if (waitResult.lost) {
        // L1 (live session) lost — recover from L2 durable context in a new pane.
        ctx.ui.notify("Dual-Gate: executor session lost — recovering from checkpoint…", "warning");
        const recovered = await recoverExecutor(ctx, task, config, contract, store, iteration, options.projectContext);
        if (taskStopped(task)) return;
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

      // ---- Pause checkpoint after execution (user may inspect / re-analyze) ----
      let requirementRevised = false;
      {
        const pause = await pauseCheckpoint(ctx, task, config, store);
        if (!pause.resumed) return;
        if (pause.newRequirement) {
          ctx.ui.notify("Dual-Gate: re-analyzing new requirement…", "info");
          const revised = await reviseSpec(ctx, task, config, contract, {
            verdict: "spec_gap",
            confidence: "medium",
            expected: contract.expected_outcome,
            actual: [],
            matched: [],
            gaps: ["New requirement from user: " + pause.newRequirement],
            implementation_changes: [],
            spec_changes: ["Merge new requirement"],
            delta: { matched: [], missing: [], incorrect: [], unexpected: [], required_changes: [], must_preserve: [] },
            reason: "User requested a change during execution.",
          }, report, store, options.projectContext);
          if (taskStopped(task)) return;
          if (revised) {
            contract = revised.contract;
            rt.manager.patch(task.taskId, { expectedVersion: contract.version, specRevisions: (task.specRevisions ?? 0) + 1 });
            writeState(task, store);
            const update = buildExecutorPrompt({
              originalRequest: task.originalRequest, contract, repoPath: cwd, mode: "delta-fix",
              delta: { matched: [], missing: [], incorrect: [], unexpected: [], required_changes: revised.implementation_changes, must_preserve: [] },
              taskId: task.taskId, panelTitle: derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest), artifactDir: store.dir(),
            });
            const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: update, wait: false, timeoutMs: 120_000 });
            if (taskStopped(task)) return;
            if (!send.ok) throw new Error(`requirement update prompt failed: ${send.error}`);
            requirementRevised = true;
          }
        }
      }
      if (requirementRevised) continue;

      // ---- Read the execution report ----
      // The agent reports idle as soon as the turn settles, but Pi's
      // alternate-screen output and the durable file may still be flushing.
      // Poll for a substantive report (file content or transcript) before
      // judging; a large report can take a while to write.
      let finalText = "";
      let durableReport = store.read("executor-report.yaml");
      for (let attempt = 0; attempt < 12; attempt++) {
        if (durableReport && durableReport.trim() && durableReport.trim() !== "{}" && !/^\{\s*"status":\s*"failed"/.test(durableReport.trim())) break;
        if (!finalText.trim()) {
          finalText = await herdrAgentRead({ target: task.herdrAgentName!, lines: 400 });
          if (taskStopped(task)) return;
        }
        const extracted = extractReportFromAgentMessage(finalText);
        if ((extracted.status === "completed" || extracted.summary) && finalText.trim()) break;
        if (durableReport && durableReport.trim() && !/^\{\s*"status":\s*"failed"/.test(durableReport.trim())) break;
        await sleep(5000);
        if (taskStopped(task)) return;
        durableReport = store.read("executor-report.yaml");
      }
      // Pi's alternate-screen scrollback may retain only the tail of a report.
      // Prefer the executor's durable report when it was written, then fall
      // back to the terminal transcript for older workers.
      report = extractReportFromAgentMessage(durableReport || finalText);
      if (config.context.send_full_executor_history_to_judge) {
        report = { ...report, executor_history: finalText };
      }
      store.write("execution-report.yaml", JSON.stringify(report, null, 2));
      store.write(`execution-report-it${iteration}.yaml`, JSON.stringify(report, null, 2));
      store.write(`execution-report-raw-it${iteration}.md`, finalText);

      // ---- Reflex: collect iteration state + Honest Finish pre-check ----
      // (before the deterministic gate: intercept "claimed done but never ran
      // any validation" without spending a GPT-5.6 Judge call).
      if (reflexEnabled) {
        const filesChanged = await gitNameOnly(cwd);
        const diffText = await getDiff(cwd);
        const state: IterationState = collectIterationState({ iteration, report, gate: null, diffText, filesChanged });
        iterStates = pushWindow(iterStates, state, reflexPolicy.progress.window);
        // Pre-check: if the executor claims completed but never ran any
        // validation and there's no gate yet, flag unverified_claim.
        const preResult = await runReflex(ctx, task, store, config, { policy: reflexPolicy, jev: reflexJev, history: reflexHistory, iterStates, turnSignals }, {
          iteration,
          report,
          gate: null,
          diffText,
          filesChanged,
          cwd,
          state,
          turns: turnSignals,
        });
        if (preResult?.finish?.verdict === "needs_fix" && preResult.finish.reason === "unverified_claim") {
          // Executor claimed done without running the gate — RETRY same pane
          // with a template hint, never calling GPT-5.6.
          ctx.ui.notify("Dual-Gate reflex: unverified_claim — asking executor to run validation", "warning");
          const hint = preResult.finish.hint ?? "Run the deterministic gate (test/lint/build) before claiming done.";
          const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: `[Reflex] ${hint}`, wait: false, timeoutMs: 120_000 });
          if (taskStopped(task)) return;
          if (!send.ok) throw new Error(`reflex unverified prompt failed: ${send.error}`);
          reflexHistory.retryCount += 1;
          persistReflexHistory(store, reflexHistory);
          await waitForExecutorCompletion(task, config, { shouldStop: () => taskStopped(task) });
          if (taskStopped(task)) return;
          continue; // re-read report next iteration
        }
        persistReflexHistory(store, { ...reflexHistory, states: iterStates, turns: turnSignals });
      }

      // ---- Deterministic gate ----
      if (taskStopped(task)) return;
      rt.manager.patch(task.taskId, { state: "GATING", currentStage: "gating" });
      writeState(task, store);
      gateResult = await runDeterministicGate(ctx, task, config);
      if (taskStopped(task)) return;

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

        // ---- Reflex: gate-fix stuck check (no progress on same failing step) ----
        // If the same gate step keeps failing with the same error, steer the
        // executor to change approach instead of blindly retrying (deterministic).
        if (reflexEnabled && gateLoop > 0) {
          const sameStepFails = gateResult.steps
            .filter((s) => !s.passed && !s.skipped)
            .every((s) => firstReflexErrorLine({ passed: false, steps: [s] }) === firstReflexErrorLine({ passed: false, steps: [s] }));
          const stuckHint = "[Reflex] The same validation step keeps failing with the same error. Stop repeating the same fix; read the error carefully, inspect the relevant files, change approach, then retry once.";
          if (sameStepFails) {
            ctx.ui.notify("Dual-Gate reflex: same gate error repeating — steering executor", "warning");
            const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: stuckHint, wait: false, timeoutMs: 120_000 });
            if (taskStopped(task)) return;
            if (!send.ok) throw new Error(`reflex gate-stuck prompt failed: ${send.error}`);
          }
        }

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
          artifactDir: store.dir(),
        });
        const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: fixPrompt, wait: false, timeoutMs: 120_000 });
        if (taskStopped(task)) return;
        if (!send.ok) {
          throw new Error(`fix prompt failed: ${send.error}`);
        }
        await waitForExecutorCompletion(task, config, { shouldStop: () => taskStopped(task) });
        if (taskStopped(task)) return;
        await sleep(4000);
        const fixText = await herdrAgentRead({ target: task.herdrAgentName!, lines: 400 });
        if (taskStopped(task)) return;
        report = extractReportFromAgentMessage(fixText);
        store.write("execution-report.yaml", JSON.stringify(report, null, 2));
        gateResult = await runDeterministicGate(ctx, task, config);
        if (taskStopped(task)) return;
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
      if (taskStopped(task)) return;
      const gateSummary = formatGateResult(gateResult);

      // ---- Reflex (System-1): full pass with gate evidence, before Judge ----
      // Jev/rule decide whether this iteration even needs the expensive GPT-5.6
      // Judge. CONTINUE → Judge; RETRY → same pane with template hint; ESCALATE
      // → fall through to existing escalation (Judge / user / stronger model).
      let reflexAction: LoopAction | null = null;
      if (reflexEnabled) {
        const filesChanged = await gitNameOnly(cwd);
        const state: IterationState = collectIterationState({ iteration, report, gate: gateResult, diffText: diff, filesChanged });
        iterStates = pushWindow(iterStates, state, reflexPolicy.progress.window);
        const result = await runReflex(ctx, task, store, config, { policy: reflexPolicy, jev: reflexJev, history: reflexHistory, iterStates, turnSignals }, {
          iteration,
          report,
          gate: { passed: gateResult.passed, steps: gateResult.steps },
          diffText: diff,
          filesChanged,
          cwd,
          state,
          turns: turnSignals,
        });
        if (result) {
          reflexAction = result.loop.action;
          reflexHistory.jevConsulted = result.jevConsulted;
          reflexHistory.noProgressStreak = result.trend === "NO_PROGRESS" ? reflexHistory.noProgressStreak + 1 : 0;
          reflexHistory.sameErrorStreak =
            reflexHistory.states.length > 0 &&
            reflexHistory.states[reflexHistory.states.length - 1].errorSignature !== "" &&
            state.errorSignature === reflexHistory.states[reflexHistory.states.length - 1].errorSignature
              ? reflexHistory.sameErrorStreak + 1
              : 0;
          reflexHistory.states = iterStates;
          reflexHistory.turns = turnSignals;
          persistReflexHistory(store, reflexHistory);

          if (config.reflex.mode === "enforce") {
            if (reflexAction === "RETRY" || reflexAction === "RETRY_WITH_HINT") {
              // Same pane, same session — send template hint, skip GPT-5.6 Judge.
              ctx.ui.notify(`Dual-Gate reflex: ${reflexAction} — sending to same pane`, "warning");
              const hint = result.finish?.hint ?? result.stuck?.hint ?? "Reflex: evidence incomplete; complete the flagged checks and rerun validation.";
              const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: `[Reflex] ${hint}`, wait: false, timeoutMs: 120_000 });
              if (taskStopped(task)) return;
              if (!send.ok) throw new Error(`reflex retry prompt failed: ${send.error}`);
              reflexHistory.retryCount += 1;
              persistReflexHistory(store, reflexHistory);
              await waitForExecutorCompletion(task, config, { shouldStop: () => taskStopped(task) });
              if (taskStopped(task)) return;
              continue; // re-enter loop → gate → reflex again
            }
            if (reflexAction === "ESCALATE") {
              ctx.ui.notify("Dual-Gate reflex: ESCALATE — routing to System-2 Judge", "warning");
              // fall through to Judge below (existing escalation paths handle verdicts)
            }
            // CONTINUE → Judge below
          }
        }
      }

      let judgeOutput: JudgeOutput | null = null;
      let judgeError: unknown;
      for (let attempt = 0; attempt <= config.judge.max_retries; attempt++) {
        try {
          judgeOutput = await judge(ctx, task, config, contract, report, diff, gateSummary, lastJudge, options.projectContext);
          break;
        } catch (e) {
          judgeError = e;
          rt.manager.patch(task.taskId, { judgeFailures: (task.judgeFailures ?? 0) + 1 });
          store.write(`judge-error-it${iteration}-${attempt + 1}.txt`, errMsg(e));
          if (taskStopped(task)) return;
        }
      }
      if (!judgeOutput) {
        rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: `Judge failed after ${config.judge.max_retries + 1} attempts: ${errMsg(judgeError)}` });
        writeState(task, store);
        ctx.ui.notify(`Dual-Gate: Judge error — ${errMsg(judgeError)}`, "error");
        return;
      }
      store.write(`judge-it${iteration}.yaml`, JSON.stringify(judgeOutput, null, 2));
      store.write("judge.yaml", JSON.stringify(judgeOutput, null, 2));
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
        projectContext: options.projectContext,
      });
      store.write(`checkpoint-it${iteration}.yaml`, checkpoint);
      store.write("checkpoint.yaml", checkpoint);

      // ---- Convergence tracking ----
      const gapCount = judgeOutput.gaps.length;
      const sameGap = sameJudgeGaps(lastJudge, judgeOutput);
      lastJudge = judgeOutput;
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
          artifactDir: store.dir(),
        });
        const send = await herdrAgentPrompt({ target: task.herdrAgentName!, text: fixPrompt, wait: false, timeoutMs: 120_000 });
        if (taskStopped(task)) return;
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
        const revised = await reviseSpec(ctx, task, config, contract, judgeOutput, report, store, options.projectContext);
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
          projectContext: options.projectContext,
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
          artifactDir: store.dir(),
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
        const revised = await reviseSpec(ctx, task, config, contract, lastJudge!, report, store, options.projectContext);
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
    // A cancellation can race any awaited transport call; never overwrite its
    // terminal state with FAILED.
    if (!taskStopped(task)) {
      rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: errMsg(e) });
      writeState(task, store);
      ctx.ui.notify(`Dual-Gate: error — ${errMsg(e)}`, "error");
    }
  } finally {
    if (!suppress) {
      rt.running = false;
      updateWidget(ctx);
      setStatus(ctx, undefined);
      try { ctx.ui.setStatus("dual-gate-reflex", undefined); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Spawn executor in a Herdr pane
// ---------------------------------------------------------------------------

async function spawnExecutor(ctx: ExtensionCommandContext, task: TaskRecord, config: ReturnType<typeof normalizeConfig>, projectContext?: ProjectMilestoneContext): Promise<void> {
  const rt = getRuntime();
  const registry = makeRegistry(ctx);
  const configured = config.executor.model;
  // Executor=default means the worker follows the parent Pi's current model:
  // omit the --model flag when launching so pi uses its own default.
  const executorLabel = configured === "default" ? "default（跟随主 Pi）" : (registry.find(configured)?.id ?? configured);
  const executorModel = configured === "default" ? "default" : configured;

  // Preflight: dual-gate needs to run INSIDE a Herdr pane to split a new
  // executor pane. Outside Herdr this fails with a bare CLI error; give the
  // user a clear message instead.
  const envProblem = herdrEnvironmentProblem();
  if (envProblem) {
    rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: envProblem });
    writeState(task, makeStore(task));
    ctx.ui.notify(
      `Dual-Gate: ${envProblem} — 请在 Herdr pane 中启动 Pi（或执行 /dual status 查看）`,
      "error",
    );
    return;
  }

  ctx.ui.notify(`Dual-Gate: spawning Executor (${executorLabel})…`, "info");
  setStatus(ctx, "dual-gate: spawning executor");
  rt.manager.patch(task.taskId, { state: "SPAWNING_EXECUTOR", currentStage: "spawning" });
  writeState(task, makeStore(task));

  const cwd = task.worktreePath ?? task.repoPath;
  const panelTitle = derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest);
  const agentName = deriveAgentName(task.taskId);

  try {
    // 1. Split from a stable non-repository cwd. Herdr can recycle panes whose
    //    shell starts in a Git checkout; the Executor receives the real
    //    REPOSITORY path in its prompt and changes there itself.
    //    --ratio: worker pane takes ~40% width by default (config.panel.ratio).
    const splitCwd = stableHerdrPaneCwd();
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
      args: executorPiArgs(executorModel),
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
      artifactDir: makeStore(task).dir(),
      projectContext,
    });
    // Dispatch is deliberately non-blocking: Herdr's --wait can report a
    // false stall after successfully delivering a prompt. Completion is polled.
    const send = await herdrAgentPrompt({ target: agentName, text: prompt, wait: false, timeoutMs: 120_000 });
    if (!send.ok) {
      throw new Error(`agent prompt failed: ${send.error}`);
    }

    rt.manager.patch(task.taskId, { state: "EXECUTING", currentStage: "executing" });
    writeState(task, makeStore(task));
    ctx.ui.notify(`Dual-Gate: Executor running in ${panelTitle}`, "info");
  } catch (e) {
    if (!taskStopped(task)) {
      rt.manager.patch(task.taskId, { state: "FAILED", currentStage: "failed", error: errMsg(e) });
      writeState(task, makeStore(task));
      ctx.ui.notify(`Dual-Gate: executor spawn failed — ${errMsg(e)}`, "error");
    }
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
  projectContext?: ProjectMilestoneContext,
): Promise<boolean> {
  const rt = getRuntime();
  const registry = makeRegistry(ctx);
  const configured = config.executor.model;
  const executorModel = configured === "default" ? "default" : configured;

  try {
    // Old pane may still exist but be unusable; try to close it, ignore errors.
    if (task.herdrPanelId) {
      await herdrPaneClose(task.herdrPanelId).catch(() => {});
    }

    const cwd = task.worktreePath ?? task.repoPath;
    const baseTitle = derivePanelTitle(task.taskId, basename(task.repoPath), task.originalRequest);
    const panelTitle = `${baseTitle} · recovered`;
    const agentName = (deriveAgentName(task.taskId) + "-r").slice(0, 31);

    const splitCwd = stableHerdrPaneCwd();
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
      args: executorPiArgs(executorModel),
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
      projectContext,
    });
    const recoveryPrompt = buildRecoveryPrompt({
      taskId: task.taskId,
      originalRequest: task.originalRequest,
      contract,
      checkpoint,
      repoPath: cwd,
      delta: null,
      projectContext,
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
  opts: { pollMs?: number; timeoutMs?: number; onTick?: (state: string) => void; shouldStop?: () => boolean; shouldPause?: () => boolean } = {},
): Promise<{ completed: boolean; state?: string; lost?: boolean; paused?: boolean }> {
  const agent = task.herdrAgentName;
  if (!agent) return { completed: false, lost: true };
  const pollMs = opts.pollMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 45 * 60 * 1000;
  const started = Date.now();
  let lastState = "unknown";
  let lostStreak = 0;
  while (Date.now() - started < timeoutMs) {
    if (opts.shouldStop?.()) return { completed: false, state: lastState };
    if (opts.shouldPause?.()) return { completed: false, state: lastState, paused: true };
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
// Persistent read-only Product Manager pane (project mode only)
// ---------------------------------------------------------------------------

function productManagerStore(project: ProjectRecord): ArtifactStore {
  return createArtifactStore(join(project.artifactDir, "product-manager"));
}

function writeProductManagerMetadata(project: ProjectRecord): void {
  productManagerStore(project).write("metadata.json", project.productManager ?? {});
  writeProjectState(project);
}

function pmRequestPrefix(kind: "plan" | "milestone_feedback" | "final_acceptance", payload: Record<string, unknown>): string {
  if (kind === "plan") return "plan";
  if (kind === "final_acceptance") return "final-acceptance";
  return `milestone-${String(payload.milestone_id ?? "unknown")}`;
}

function nextProductManagerRequestId(project: ProjectRecord): string {
  const old = project.productManager?.lastRequestId;
  const n = old?.match(/-(\d+)$/)?.[1];
  return `pm-${project.projectId}-${(Number(n ?? 0) || 0) + 1}`;
}

async function spawnProductManager(ctx: ExtensionCommandContext, project: ProjectRecord, config: ReturnType<typeof normalizeConfig>): Promise<void> {
  const pm: ProductManagerRecord = project.productManager ?? {
    model: config.product_manager.model, state: "STARTING", recoveryCount: 0,
  };
  project.productManager = pm;
  // Resolve `default` once to the active Main Pi model. A Herdr child inherits
  // terminal environment, not Pi's transient --model selection, so omitting
  // --model here would not reliably follow the controller pane.
  const model = pm.model === "default"
    ? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "")
    : pm.model;
  if (!model || !findAvailableAuthenticatedModel(makeRegistry(ctx), model)) {
    throw new Error(`Product Manager model is not available with configured authentication: ${model || "default"}`);
  }
  pm.model = model;
  const problem = herdrEnvironmentProblem();
  if (problem) throw new Error(problem);
  const title = deriveProductManagerTitle(project.projectId, project.repoPath);
  const name = deriveProductManagerName(project.projectId);
  const splitCwd = stableHerdrPaneCwd();
  let paneId: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const candidate = await herdrPaneSplit({
      direction: config.panel.direction,
      cwd: splitCwd,
      noFocus: true,
      ratio: config.panel.ratio,
      env: { DUAL_GATE_PM_ARTIFACT_DIR: productManagerStore(project).dir() },
    });
    await sleep(1500);
    if (await herdrPaneExists(candidate)) { paneId = candidate; break; }
  }
  if (!paneId) throw new Error("failed to create a persistent Product Manager pane after 3 attempts");
  await exec("herdr", ["pane", "rename", paneId, title], { timeoutMs: 15_000 });
  await herdrAgentStart({ name, kind: "pi", pane: paneId, timeoutMs: 180_000, args: productManagerPiArgs(model) });
  pm.paneId = paneId; pm.agentName = name; pm.state = "ACTIVE"; pm.error = undefined;
  writeProductManagerMetadata(project);
  ctx.ui.notify(`Dual-Gate: Product Manager ready in ${title}`, "info");
}

async function waitForProductManagerResponse(project: ProjectRecord, responsePath: string, timeoutMs = 10 * 60 * 1000): Promise<{ completed: boolean; lost?: boolean; state?: string }> {
  const agent = project.productManager?.agentName;
  if (!agent) return { completed: false, lost: true };
  const started = Date.now(); let missing = 0; let state = "unknown";
  while (Date.now() - started < timeoutMs) {
    if (project.status === "CANCELLED" || getRuntime().stopRequested) return { completed: false, state };
    // The guarded response artifact, not a transient terminal state, is the
    // IPC completion signal. This works for slow starts and alternate-screen
    // Pi transcripts alike.
    if (existsSync(responsePath) && readFileSync(responsePath, "utf8").trim()) return { completed: true, state };
    const current = await herdrAgentGet({ target: agent });
    if (!current.state && current.idle === undefined) {
      if (++missing >= 3) return { completed: false, lost: true, state };
    } else {
      missing = 0;
      state = current.state ?? (current.idle ? "idle" : state);
    }
    await sleep(2000);
  }
  return { completed: false, state };
}

async function recoverProductManager(ctx: ExtensionCommandContext, project: ProjectRecord, config: ReturnType<typeof normalizeConfig>, requestId: string, responsePath: string, request: unknown, originalPrompt: string): Promise<boolean> {
  const pm = project.productManager;
  if (!pm || pm.recoveryCount >= 1) return false;
  pm.recoveryCount++; pm.state = "RECOVERING";
  writeProductManagerMetadata(project);
  try {
    if (pm.paneId) await herdrPaneClose(pm.paneId).catch(() => {});
    const title = `${deriveProductManagerTitle(project.projectId, project.repoPath)} · recovered`;
    const name = `${deriveProductManagerName(project.projectId)}-r`.slice(0, 31);
    const paneId = await herdrPaneSplit({
      direction: config.panel.direction,
      cwd: stableHerdrPaneCwd(),
      noFocus: true,
      ratio: config.panel.ratio,
      env: { DUAL_GATE_PM_ARTIFACT_DIR: productManagerStore(project).dir() },
    });
    await sleep(1500);
    if (!await herdrPaneExists(paneId)) throw new Error("recovery PM pane was recycled");
    await exec("herdr", ["pane", "rename", paneId, title], { timeoutMs: 15_000 });
    await herdrAgentStart({ name, kind: "pi", pane: paneId, timeoutMs: 180_000, args: productManagerPiArgs(pm.model) });
    pm.paneId = paneId; pm.agentName = name; pm.state = "WAITING";
    const store = productManagerStore(project);
    const persistedFeedback = readdirSync(store.dir()).filter((name) => /^milestone-.*-feedback\.yaml$/.test(name)).map((name) => store.read(name)).filter(Boolean);
    const recovery = buildProductManagerRecoveryPrompt({ projectId: project.projectId, requestId, responsePath, outstandingRequest: { request, originalPrompt }, persistedPlan: store.read("plan.yaml"), persistedFeedback });
    store.write("recovery-request.json", { requestId, request, recovery, at: new Date().toISOString() });
    writeProductManagerMetadata(project);
    const sent = await herdrAgentPrompt({ target: name, text: recovery, wait: false, timeoutMs: 120_000 });
    if (!sent.ok) throw new Error(sent.error ?? "PM recovery prompt failed");
    return true;
  } catch (e) {
    pm.state = "FAILED"; pm.error = errMsg(e); writeProductManagerMetadata(project); return false;
  }
}

async function requestProductManager<T>(ctx: ExtensionCommandContext, project: ProjectRecord, config: ReturnType<typeof normalizeConfig>, kind: "plan" | "milestone_feedback" | "final_acceptance", payload: Record<string, unknown>, promptFor: (requestId: string, responsePath: string) => string, parse: (raw: string, requestId: string) => T | null): Promise<T> {
  const pm = project.productManager;
  if (!pm?.agentName) throw new Error("Product Manager session is unavailable");
  const requestId = nextProductManagerRequestId(project);
  const prefix = pmRequestPrefix(kind, payload);
  const store = productManagerStore(project);
  const responsePath = join(store.dir(), `${prefix}-response.yaml`);
  // Remove any stale response from a previous request so the completion poll
  // cannot mistake it for this request's answer (resume reuses the same file).
  try { if (existsSync(responsePath)) rmSync(responsePath); } catch { /* best-effort */ }
  const prompt = promptFor(requestId, responsePath);
  // Persist before transport so an L1 recovery can replay exactly this request.
  pm.lastRequestId = requestId; pm.lastRequestKind = kind; pm.state = "WAITING";
  store.write(`${prefix}-request.json`, { ...payload, protocol_version: 1, request_id: requestId, kind, prompt, response_path: responsePath, at: new Date().toISOString() });
  writeProductManagerMetadata(project);
  const sent = await herdrAgentPrompt({ target: pm.agentName, text: prompt, wait: false, timeoutMs: 120_000 });
  if (!sent.ok) throw new Error(`Product Manager prompt failed: ${sent.error}`);
  let wait = await waitForProductManagerResponse(project, responsePath);
  if (wait.lost) {
    const recovered = await recoverProductManager(ctx, project, config, requestId, responsePath, payload, prompt);
    if (!recovered) throw new Error("Product Manager session lost and recovery failed");
    wait = await waitForProductManagerResponse(project, responsePath);
  }
  if (!wait.completed) throw new Error(`Product Manager ${wait.lost ? "session lost" : "timed out"}`);
  const transcript = await herdrAgentRead({ target: project.productManager?.agentName!, lines: 600 });
  store.write(`${prefix}-response-raw.md`, transcript);
  // Pi's alternate-screen transcript can retain only a response tail. PM IPC
  // therefore uses the guarded, durable response file as its source of truth.
  const raw = store.read(`${prefix}-response.yaml`) ?? "";
  const result = parse(raw, requestId);
  if (!result) throw new Error(`Product Manager returned malformed or mismatched ${kind} response`);
  pm.state = "ACTIVE";
  store.write(kind === "milestone_feedback" ? `${prefix}-feedback.yaml` : kind === "final_acceptance" ? "product-acceptance.yaml" : "plan.yaml", result as object);
  writeProductManagerMetadata(project);
  return result;
}

/**
 * Pause checkpoint: if the user requested a pause, persist PAUSED state and
 * block until resumed. Resume may carry a revised requirement: it is merged
 * into the task for re-analysis instead of restarting.
 */
async function pauseCheckpoint(
  ctx: ExtensionCommandContext,
  task: TaskRecord,
  config: ReturnType<typeof normalizeConfig>,
  store: ArtifactStore,
): Promise<{ resumed: boolean; newRequirement?: string }> {
  const rt = getRuntime();
  if (!rt.pauseRequested) return { resumed: true };
  rt.pauseRequested = false;

  // Snapshot where we paused so resume can return to the same stage.
  const pausedStage = task.currentStage;
  const pausedState = task.state;
  rt.manager.patch(task.taskId, { state: "PAUSED", currentStage: "paused" });
  writeState(task, store);
  ctx.ui.notify("Dual-Gate: ⏸ paused (Executor kept alive, work preserved)", "warning");
  setStatus(ctx, "dual-gate: paused");
  updateWidget(ctx);

  // Wait until the user resumes or cancels.
  while (true) {
    const t = rt.manager.get(task.taskId);
    if (!t) return { resumed: false };
    if (t.state === "CANCELLED" || t.state === "FAILED" || t.state === "ESCALATED") return { resumed: false };
    if (t.state === "PAUSED") {
      // still paused: check for a queued resume requirement
      const pending = rt.pendingResumeRequirement;
      if (rt.resumeRequested) {
        rt.resumeRequested = false;
        rt.pendingResumeRequirement = undefined;
        // restore to the state we were in before pausing (or EXECUTING default)
        const backTo = pausedState && pausedState !== "PAUSED" ? pausedState : "EXECUTING";
        rt.manager.patch(task.taskId, { state: backTo, currentStage: pausedStage ?? "executing" });
        writeState(task, store);
        ctx.ui.notify("Dual-Gate: ▶ resumed" + (pending ? " — re-analyzing new requirement" : ""), "info");
        setStatus(ctx, "dual-gate: resumed");
        updateWidget(ctx);
        return { resumed: true, newRequirement: pending || undefined };
      }
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Reflex Layer (System-1) integration helpers
// ---------------------------------------------------------------------------

/** Reflex history persisted in the task artifact dir (survives pause/resume). */
interface ReflexHistory {
  states: IterationState[];
  noProgressStreak: number;
  sameErrorStreak: number;
  turns: TurnSignal[];
  jevConsulted: string[];
  retryCount: number;
}

const EMPTY_REFLEX_HISTORY: ReflexHistory = {
  states: [],
  noProgressStreak: 0,
  sameErrorStreak: 0,
  turns: [],
  jevConsulted: [],
  retryCount: 0,
};

function loadReflexHistory(store: ArtifactStore): ReflexHistory {
  try {
    const raw = store.read("reflex-history.json");
    if (!raw) return structuredClone(EMPTY_REFLEX_HISTORY);
    const parsed = JSON.parse(raw) as Partial<ReflexHistory>;
    return {
      states: Array.isArray(parsed.states) ? parsed.states : [],
      noProgressStreak: typeof parsed.noProgressStreak === "number" ? parsed.noProgressStreak : 0,
      sameErrorStreak: typeof parsed.sameErrorStreak === "number" ? parsed.sameErrorStreak : 0,
      turns: Array.isArray(parsed.turns) ? parsed.turns : [],
      jevConsulted: Array.isArray(parsed.jevConsulted) ? parsed.jevConsulted : [],
      retryCount: typeof parsed.retryCount === "number" ? parsed.retryCount : 0,
    };
  } catch {
    return structuredClone(EMPTY_REFLEX_HISTORY);
  }
}

function persistReflexHistory(store: ArtifactStore, h: ReflexHistory): void {
  try {
    store.write("reflex-history.json", JSON.stringify(h, null, 2));
  } catch { /* audit is best-effort */ }
}

/** Build an IterationState from the report + gate + diff (mirrors reflex/types.ts). */
function collectIterationState(input: {
  iteration: number;
  report: Record<string, unknown>;
  gate: GateResult | null;
  diffText: string;
  filesChanged: string[];
}): IterationState {
  const r = input.report;
  const tests = (r.tests && typeof r.tests === "object" ? r.tests : {}) as Record<string, unknown>;
  const testsPassed = Array.isArray(tests.passed) ? (tests.passed as unknown[]).length : 0;
  const testsFailed = Array.isArray(tests.failed) ? (tests.failed as unknown[]).length : 0;
  const validation = (r.validation && typeof r.validation === "object" ? r.validation : {}) as Record<string, unknown>;
  const build = typeof validation.build === "string" ? validation.build : "not_run";
  const acceptance = (r.acceptance_check && typeof r.acceptance_check === "object" ? r.acceptance_check : {}) as Record<string, unknown>;
  const reqCompleted = Object.values(acceptance).filter((v) => String(v) === "pass").length;
  const reqTotal = Object.keys(acceptance).length;
  const errorSignature =
    input.gate && !input.gate.passed
      ? firstReflexErrorLine(input.gate)
      : "";
  return {
    iteration: input.iteration,
    filesChanged: input.filesChanged,
    testsPassed,
    testsFailed,
    buildStatus: build === "pass" ? "pass" : build === "fail" ? "fail" : "not_run",
    errorSignature,
    diffSize: countReflexDiffLines(input.diffText),
    requirementsCompleted: reqCompleted,
    requirementsTotal: reqTotal,
  };
}

function firstReflexErrorLine(gate: GateResult): string {
  const failed = gate.steps.find((s) => !s.passed && !s.skipped);
  if (!failed) return "";
  const line = (failed.outputTail ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 160) : "";
}

function countReflexDiffLines(diffText: string): number {
  if (!diffText) return 0;
  let n = 0;
  for (const l of diffText.split(/\r?\n/)) {
    if ((l.startsWith("+") || l.startsWith("-")) && !l.startsWith("++") && !l.startsWith("--")) n++;
  }
  return n;
}

/**
 * Run the reflex layer over the current iteration's evidence and record the
 * audit entry. Returns the ReflexResult (or null when disabled).
 */
async function runReflex(
  ctx: ExtensionCommandContext,
  task: TaskRecord,
  store: ArtifactStore,
  config: ReturnType<typeof normalizeConfig>,
  reflexState: {
    policy: ReflexPolicy;
    jev?: JevClient;
    history: ReflexHistory;
    iterStates: IterationState[];
    turnSignals: TurnSignal[];
  },
  input: Omit<ReflexRunInput, "policy" | "jev" | "history" | "ctx">,
): Promise<ReflexResult | null> {
  if (!config.reflex.enabled) return null;
  const h = reflexState.history;
  const prevState = h.states.length > 0 ? h.states[h.states.length - 1] : undefined;
  const result = await runReflexLayer({
    policy: reflexState.policy,
    jev: reflexState.jev,
    iteration: input.iteration,
    report: input.report,
    gate: input.gate,
    diffText: input.diffText,
    filesChanged: input.filesChanged,
    cwd: input.cwd,
    prevState,
    state: input.state,
    turns: input.turns,
    history: { noProgressStreak: h.noProgressStreak, sameErrorStreak: h.sameErrorStreak },
    ctx: {
      retryCount: h.retryCount,
      maxRetries: config.gate.max_retries,
      totalIterations: input.iteration,
    },
  });

  // Record + persist audit. Observe mode never changes loop behavior; the
  // result is still logged so we can inspect what reflex WOULD have done.
  store.write(`reflex-it${input.iteration}.log`, formatReflexResult(result));
  store.write("reflex-latest.log", formatReflexResult(result));
  ctx.ui.setStatus("dual-gate-reflex", reflexStatusLabel(result));

  if (config.reflex.mode === "observe") {
    ctx.ui.notify(`Dual-Gate reflex (observe): ${reflexStatusLabel(result)}`, "info");
  }
  return result;
}

function reflexStatusLabel(r: ReflexResult): string {
  const loop = r.loop.action;
  const trend = r.trend;
  const stuck = r.stuck.verdict;
  const finish = r.finish?.verdict ?? "-";
  return `reflex ${loop} · ${trend} · ${stuck} · ${finish}${r.jevConsulted.length ? ` · j:${r.jevConsulted.join(",")}` : ""}`;
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
  if (!config.gate.enabled) {
    const result = skippedGateResult("Deterministic gate disabled by configuration.");
    store.write("gate-discovery.json", { commands: [], notes: ["Deterministic gate disabled by configuration."] });
    store.write("gate.log", formatGateResult(result));
    return result;
  }
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
  projectContext?: ProjectMilestoneContext,
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
    projectContext,
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
  projectContext?: ProjectMilestoneContext,
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
    projectContext,
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

async function gitNameOnly(cwd: string): Promise<string[]> {
  const { code, stdout } = await exec("git", ["diff", "--name-only", "HEAD"], { cwd, timeoutMs: 30_000 });
  if (code === 0 && stdout.trim()) {
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  const { code: c2, stdout: s2 } = await exec("git", ["diff", "--name-only"], { cwd, timeoutMs: 30_000 });
  if (c2 === 0) return s2.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return [];
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
// Project coordinator (outer layer; task loop remains the milestone engine)
// ---------------------------------------------------------------------------

function writeProjectState(project: ProjectRecord): void {
  createArtifactStore(project.artifactDir).write("project-state.json", project);
}

function projectPlanDisplay(plan: ProjectPlan, projectId: string): string {
  const list = (items: string[]) => items.length ? items.map((x) => `  • ${x}`).join("\n") : "  • (none)";
  const research = plan.research
    ? [
        "**Market research (reuse-vs-build)**",
        `  • Decision: ${plan.research.decision}`,
        plan.research.summary ? `  • ${plan.research.summary}` : "",
        ...plan.research.existing_solutions.map((s) => `  • ${s.name} — ${s.url} — ${s.assessment}`),
        plan.research.rationale ? `  • Why: ${plan.research.rationale}` : "",
      ].join("\n")
    : null;
  return [
    `## Dual-Gate Project Plan · ${projectId}`,
    `**Goal**\n${plan.goal}`,
    `**Constraints**\n${list(plan.constraints)}`,
    research ?? "",
    "**Milestones (dependency-ordered batches; independent ones run in parallel worktrees)**",
    ...topologicallyOrderMilestones(plan.milestones).flatMap((m, i) => [
      `${i + 1}. **${m.id}: ${m.title}** (depends on: ${m.depends_on.join(", ") || "none"})`,
      `   Scope: ${[...m.scope.files, ...m.scope.components].join(", ")}`,
      `   Outcome: ${m.expected_outcome.join("; ")}`,
      `   Acceptance: ${m.acceptance_criteria.join("; ")}`,
      `   Validation: ${m.validation.required.join("; ")}`,
      `   Risk: ${m.risk.level}${m.risk.concerns.length ? ` — ${m.risk.concerns.join("; ")}` : ""}`,
    ]),
    "**Project acceptance**",
    list(plan.acceptance_criteria),
    "**Final validation**",
    list(plan.validation.required),
  ].filter((x) => x !== "").join("\n\n");
}

function readPersistedProject(cwd: string, projectId: string): ProjectRecord | null {
  try {
    const path = join(projectDirFor(cwd, projectId), "project-state.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ProjectRecord : null;
  } catch { return null; }
}

function presentProjectStatus(project: ProjectRecord): void {
  const lines = [
    `Dual-Gate Project ${project.projectId}`,
    `Status: ${project.status}`,
    `Current milestone: ${project.currentMilestoneId ?? "none"}`,
    `Product acceptance: ${project.productAcceptance?.verdict ?? "pending"}`,
    `Controller ratification: ${project.finalAcceptance ?? "pending"}`,
    `Product Manager: ${project.productManager?.model ?? "legacy"} · ${project.productManager?.state ?? "not started"} · pane ${project.productManager?.paneId ?? "-"}`,
    "Milestones:",
    ...project.orderedMilestoneIds.map((id, i) => { const m = project.milestones[id]; return `  ${i + 1}. ${id}: ${m?.title ?? ""} — ${m?.status ?? "unknown"}${m?.taskId ? ` (${m.taskId})` : ""}`; }),
    `Artifacts: ${project.artifactDir}`,
  ];
  showText(lines.join("\n"));
}

async function runProject(ctx: ExtensionCommandContext, request: string, repoOverride?: string, resumeProject?: ProjectRecord): Promise<void> {
  const rt = getRuntime();
  const config = rt.config;
  // A repoOverride (from `/dual project repo=<path> <request>`) lets the
  // controller run projects against a Git checkout even when its pane cwd is
  // a non-repository directory (Herdr reaps panes split into a Git worktree).
  const repoPath = normalizeRepoPath(repoOverride ?? ctx.cwd);
  if (config.worktree.mode === "isolated") {
    ctx.ui.notify("Dual-Gate project mode requires worktree.mode auto or current; isolated milestones cannot share changes.", "error");
    return;
  }
  if (!resumeProject && (rt.running || rt.manager.active() || (rt.activeProject && isActiveProjectState(rt.activeProject.status)))) {
    ctx.ui.notify("Dual-Gate already has an active task or project", "warning");
    return;
  }
  if (!resumeProject && config.product_manager.model !== "default" && !findAvailableAuthenticatedModel(makeRegistry(ctx), config.product_manager.model)) {
    ctx.ui.notify(`Product Manager model is not available with configured authentication: ${config.product_manager.model}`, "error");
    return;
  }
  rt.running = true;
  rt.stopRequested = false;
  const projectId = resumeProject?.projectId ?? generateProjectId();
  const artifactDir = projectDirFor(repoPath, projectId);
  const store = createArtifactStore(artifactDir);
  const now = new Date().toISOString();
  let project: ProjectRecord = resumeProject ?? { projectId, sourceRequest: request, repoPath, artifactDir, status: "PLANNING", orderedMilestoneIds: [], milestones: {}, productManager: { model: config.product_manager.model, state: "STARTING", recoveryCount: 0 }, createdAt: now, updatedAt: now };
  rt.activeProject = project;
  if (!resumeProject) writeProjectState(project);
  try {
    const registry = makeRegistry(ctx);
    const controller = registry.find(config.controller.model) ?? { provider: "", id: config.controller.model, name: config.controller.model };
    let plan: ProjectPlan;
    if (resumeProject) {
      // Resume: reuse the persisted plan; do not re-plan or re-approve.
      const raw = store.read("project-plan.yaml");
      if (!raw) throw new Error(`cannot resume ${project.projectId}: project-plan.yaml missing`);
      plan = JSON.parse(raw) as ProjectPlan;
      ctx.ui.notify(`Dual-Gate: resuming project ${project.projectId} — continuing unmerged milestones…`, "info");
      // The PM pane may have died with the previous session; rebuild it if
      // its agent no longer resolves, so milestone feedback/acceptance work.
      const pmAgent = project.productManager?.agentName;
      const pmState = pmAgent ? await herdrAgentGet({ target: pmAgent }) : null;
      const pmAlive = !!pmState?.state || !!pmState?.idle;
      if (!pmAlive) {
        ctx.ui.notify("Dual-Gate: PM pane lost — respawning…", "warning");
        if (project.productManager?.paneId) {
          await herdrPaneClose(project.productManager.paneId).catch(() => {});
          project.productManager.paneId = undefined;
          project.productManager.agentName = undefined;
        }
        await spawnProductManager(ctx, project, config);
      }
      project.status = "RUNNING"; project.updatedAt = new Date().toISOString(); writeProjectState(project);
    } else {
      // The PM is created once before WBS generation and persists through final acceptance.
      await spawnProductManager(ctx, project, config);
      plan = await requestProductManager(ctx, project, config, "plan", { source_request: request, repo_path: project.repoPath }, (requestId, responsePath) => buildProductManagerPlanPrompt({ sourceRequest: request, repoPath: project.repoPath, requestId, responsePath }), (raw, requestId) => {
        try {
          const block = extractCorrelatedYamlBlock(raw, requestId, "plan") ?? raw;
          const plan = parseProjectPlan(block);
          return plan;
        } catch { return null; }
      });
      const ordered0 = topologicallyOrderMilestones(plan.milestones);
      project.orderedMilestoneIds = ordered0.map((m) => m.id);
      for (const m of ordered0) project.milestones[m.id] = { title: m.title, status: "PENDING" };
      store.write("project-plan.yaml", JSON.stringify(plan, null, 2));
      project.status = "AWAITING_APPROVAL"; project.updatedAt = new Date().toISOString(); writeProjectState(project);
      showText(projectPlanDisplay(plan, projectId));
      const approved = await ctx.ui.confirm("Approve project plan", `Execute ${ordered0.length} milestones in dependency-ordered batches${scheduleMilestoneBatches(ordered0).some((b) => b.length > 1) ? " (independent milestones run in parallel worktrees)" : ""} for: ${plan.goal}?`);
      store.write("project-approval.json", { approved, at: new Date().toISOString() });
      if (!approved || project.status === "CANCELLED" || rt.stopRequested) {
        project.status = "CANCELLED"; project.updatedAt = new Date().toISOString();
        if (project.productManager) {
          project.productManager.state = "CANCELLED";
          if (project.productManager.paneId) await exec("herdr", ["pane", "rename", project.productManager.paneId, `${deriveProductManagerTitle(project.projectId, project.repoPath)} · CANCELLED`], { timeoutMs: 15_000 }).catch(() => {});
          writeProductManagerMetadata(project);
        }
        writeProjectState(project); return;
      }
      project.status = "RUNNING"; project.updatedAt = new Date().toISOString(); writeProjectState(project);
    }
    const ordered = topologicallyOrderMilestones(plan.milestones);
    // Reconcile plan milestones with persisted records (resume may already
    // have CONVERGED ones; keep their status and task refs).
    for (const m of ordered) {
      if (!project.milestones[m.id]) project.milestones[m.id] = { title: m.title, status: "PENDING" };
    }
    const completed: ProjectMilestoneContext["completedSummaries"] = [];
    const batches = scheduleMilestoneBatches(ordered);
    for (const batch of batches) {
      if (project.status !== "RUNNING") break;
      const parallel = isParallelBatch(batch);
      // Resume support: milestones already CONVERGED in a previous session are
      // skipped (their changes are already merged into the main checkout).
      const pendingBatch = batch.filter((m) => project.milestones[m.id]?.status !== "CONVERGED");
      if (pendingBatch.length === 0) {
        for (const m of batch) {
          if (project.milestones[m.id]?.status === "CONVERGED") {
            completed.push({ milestoneId: m.id, title: m.title, summary: project.milestones[m.id].summary ?? "", verdict: "converged" });
          }
        }
        continue;
      }
      ctx.ui.notify(`Dual-Gate: executing milestone batch ${batches.indexOf(batch) + 1}/${batches.length}${parallel ? ` (${pendingBatch.length} parallel)` : ""}…`, "info");

      // Run every milestone in this batch, concurrently when the batch is
      // parallel (each in its own worktree), serially otherwise.
      const results = await Promise.all(pendingBatch.map(async (milestone) => {
        const record = project.milestones[milestone.id];
        const milestoneStore = createArtifactStore(projectMilestoneDirFor(repoPath, projectId, milestone.id));
        project.currentMilestoneId = milestone.id; record.status = "RUNNING"; project.updatedAt = new Date().toISOString(); writeProjectState(project);
        milestoneStore.write("milestone.yaml", JSON.stringify(milestone, null, 2));
        milestoneStore.write("state.json", record);

        let contract = milestoneToAcceptanceContract(plan, milestone, request);
        const riskText = [request, milestone.title, ...milestone.expected_outcome, ...milestone.acceptance_criteria, ...milestone.risk.concerns].join("\n");
        contract = higherRisk(contract, detectRisk(riskText));
        const task = rt.manager.beginFor(repoPath, request, { controller: resolveModelString(config.controller.model) ?? controller, executor: resolveModelString(config.executor.model) ?? { provider: "", id: config.executor.model, name: config.executor.model } }, detectRisk(riskText).level);
        record.taskId = task.taskId; record.taskArtifactDir = task.artifactDir; record.parallel = parallel;

        // Parallel milestones need an isolated worktree so their changes do not
        // collide on the main checkout; the worktree is merged back afterwards.
        let worktreePath: string | null = null;
        if (parallel) {
          worktreePath = await createWorktree(project.repoPath, task.taskId);
          rt.manager.patch(task.taskId, { worktreePath });
          record.worktreePath = worktreePath;
        }

        const repoMemoryPath = join(store.dir(), "repo-memory.md");
        const repoMemory = existsSync(repoMemoryPath) ? readFileSync(repoMemoryPath, "utf8").slice(0, 12000) : undefined;
        const context: ProjectMilestoneContext = { projectId, projectGoal: plan.goal, milestoneId: milestone.id, milestoneTitle: milestone.title, scope: milestone.scope, dependsOn: milestone.depends_on, completedSummaries: [...completed], repoMemory };
        await orchestrate(ctx, task, { initialContract: contract, projectContext: context, suppressGlobalFlags: true });
        rt.running = true; // the task runner clears its own flag; the project still owns input
        const taskStore = makeStore(task);
        const report = extractReportFromAgentMessage(taskStore.read("executor-report.yaml") ?? "");
        const judge = parseJudgeOutput(taskStore.read("judge.yaml") ?? "");
        // Convergence is decided by the Judge (which saw gate pass + expected vs
        // actual). Executor `unresolved` notes are retained as records but do not
        // independently block a milestone that the Judge already converged.
        record.status = task.state === "DONE" && judge?.verdict === "converged" ? "CONVERGED" : task.state === "CANCELLED" ? "CANCELLED" : task.state === "ESCALATED" ? "BLOCKED" : "FAILED";
        record.summary = typeof report.summary === "string" ? report.summary : ""; record.verdict = judge?.verdict; record.unresolved = Array.isArray(report.unresolved) ? report.unresolved.map(String) : []; record.deviations = Array.isArray(report.deviations) ? report.deviations.map(String) : []; record.completedAt = new Date().toISOString();
        milestoneStore.write("task-ref.json", { taskId: task.taskId, taskArtifactDir: task.artifactDir, taskState: task.state, judgeVerdict: judge?.verdict, worktreePath, parallel, completedAt: record.completedAt });
        milestoneStore.write("state.json", record);
        project.updatedAt = new Date().toISOString(); writeProjectState(project);

        // Merge the isolated worktree back into the main checkout.
        let mergeOutcome: "merged" | "conflict" | "skipped" | undefined;
        if (parallel && worktreePath && record.status === "CONVERGED") {
          const committed = await commitWorktree(project.repoPath, worktreePath, task.taskId);
          if (!committed.ok) {
            record.status = "FAILED"; record.merge = { outcome: "conflict", message: `worktree commit failed: ${committed.message}` , at: new Date().toISOString() };
          } else {
            let merged = await mergeWorktreeBack(project.repoPath, worktreePath, task.taskId);
            if (merged.outcome === "conflict") {
              // Test-file conflicts are additive: try to auto-resolve them so
              // independent milestones can both land their tests.
              const conflicts = (merged.message ?? "").match(/CONFLICT \(content\): Merge conflict in ([^\n]+)/g) ?? [];
              let resolvedAll = true;
              for (const m of conflicts) {
                const file = m.replace(/^CONFLICT \(content\): Merge conflict in /, "").trim();
                if (!/^(tests|test|__tests__)[\/]/.test(file)) { resolvedAll = false; break; }
                const ok = await resolveTestFileConflict(project.repoPath, project.repoPath, file);
                if (!ok) { resolvedAll = false; break; }
              }
              if (resolvedAll && conflicts.length > 0) {
                const commit = await exec("git", ["commit", "--no-edit"], { cwd: project.repoPath, timeoutMs: 30_000 });
                if (commit.code === 0) {
                  merged = { outcome: "merged", message: "auto-resolved test-file conflicts" };
                }
              }
            }
            mergeOutcome = merged.outcome;
            record.merge = { outcome: merged.outcome, message: merged.message, at: new Date().toISOString() };
            if (merged.outcome === "conflict") {
              record.status = "MERGE_CONFLICT";
              ctx.ui.notify(`Dual-Gate: milestone ${milestone.id} merge conflict — worktree kept for inspection`, "warning");
            } else {
              await removeWorktree(project.repoPath, worktreePath, task.taskId).catch(() => {});
            }
          }
        } else if (parallel && worktreePath) {
          // milestone failed before merge; clean up the worktree
          await removeWorktree(project.repoPath, worktreePath, task.taskId).catch(() => {});
        }
        project.updatedAt = new Date().toISOString(); writeProjectState(project);
        return { milestone, record, mergeOutcome };
      }));

      // Batch finished: feed converged milestones to the PM in dependency order.
      const settled = results.sort((a, b) => ordered.findIndex((m) => m.id === a.milestone.id) - ordered.findIndex((m) => m.id === b.milestone.id));
      for (const { milestone, record } of settled) {
        if (record.status === "CONVERGED") {
          const taskStore = makeStore(rt.manager.get(record.taskId!)!);
          const judge = parseJudgeOutput(taskStore.read("judge.yaml") ?? "");
          const feedbackBase: ProjectMilestoneFeedback = {
            protocol_version: 1, request_id: "", kind: "milestone_feedback", milestone_id: milestone.id, task_id: record.taskId!,
            executor_summary: (record.summary ?? "").slice(0, 8000), judge: { verdict: judge?.verdict ?? "converged", gaps: (judge?.gaps ?? []).slice(0, 20).map((gap) => gap.slice(0, 1000)) },
            gate_summary: (taskStore.read("gate.log") ?? "").slice(0, 12000), unresolved: (record.unresolved ?? []).slice(0, 20).map((item) => item.slice(0, 1000)), deviations: (record.deviations ?? []).slice(0, 20).map((item) => item.slice(0, 1000)),
            artifact_refs: { taskArtifactDir: record.taskArtifactDir!, milestoneArtifactDir: createArtifactStore(projectMilestoneDirFor(repoPath, projectId, milestone.id)).dir() },
          };
          const pmFeedback = await requestProductManager(ctx, project, config, "milestone_feedback", feedbackBase as unknown as Record<string, unknown>, (requestId, responsePath) => buildMilestoneCompletionFeedbackPrompt({ ...feedbackBase, request_id: requestId, response_path: responsePath }), parseProductMilestoneFeedback);
          const persistedFeedback = { ...feedbackBase, ...pmFeedback, request_id: project.productManager?.lastRequestId ?? "" };
          productManagerStore(project).write(`milestone-${milestone.id}-feedback.yaml`, persistedFeedback);
          if (pmFeedback.decision === "blocked") { project.status = "BLOCKED"; project.error = pmFeedback.reason; project.updatedAt = new Date().toISOString(); writeProjectState(project); break; }
          completed.push({ milestoneId: milestone.id, title: milestone.title, summary: record.summary ?? "", verdict: "converged" });
          // Repo Memory: accumulate durable knowledge for later milestones.
          const memoryPath = join(store.dir(), "repo-memory.md");
          const memFile = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
          const memReport = extractReportFromAgentMessage(taskStore.read("executor-report.yaml") ?? "");
          const memFiles = (memReport.files_changed as Array<{ path?: string; purpose?: string }> | undefined) ?? [];
          const fileNote = memFiles.length ? memFiles.map((f) => `  - ${f.path ?? ""}${f.purpose ? ` — ${f.purpose}` : ""}`).join("\n") : "  - (none)";
          const implNote = Array.isArray(memReport.implementation) && memReport.implementation.length ? memReport.implementation.slice(0, 4).map((s) => `  - ${String(s).slice(0, 300)}`).join("\n") : "";
          const memoryEntry = [
            `## ${milestone.id}: ${milestone.title}`,
            `- ${(record.summary ?? "").slice(0, 600)}`,
            "- Files:", fileNote,
            implNote ? "- Implementation notes:" : "",
            implNote,
            "",
          ].filter((l) => l !== "").join("\n");
          writeFileSync(memoryPath, (memFile ? memFile + "\n" : "") + memoryEntry, "utf8");
        }
      }

      // A non-converged milestone blocks the project unless it was a merge
      // conflict (which only stops later batches, this batch already ran).
      const failed = settled.find(({ record }) => record.status !== "CONVERGED");
      if (failed) {
        const { milestone, record } = failed;
        if (record.status === "MERGE_CONFLICT") {
          project.status = "BLOCKED"; project.error = `Milestone ${milestone.id} merge conflict — resolve manually in ${record.worktreePath}`;
        } else {
          project.status = record.status === "BLOCKED" ? "BLOCKED" : record.status === "CANCELLED" ? "CANCELLED" : "FAILED";
        }
        project.updatedAt = new Date().toISOString(); writeProjectState(project);
        break;
      }
    }
    if (project.status !== "RUNNING") {
      if (project.productManager && project.productManager.state !== "CANCELLED" && project.productManager.state !== "FAILED") { project.productManager.state = "DONE"; writeProductManagerMetadata(project); }
      return;
    }
    project.status = "ACCEPTING"; project.currentMilestoneId = undefined; project.updatedAt = new Date().toISOString(); writeProjectState(project);
    const finalStore = createArtifactStore(project.artifactDir);
    const discovery = config.gate.enabled ? discoverGateCommands(project.repoPath) : { commands: [], notes: ["Deterministic gate disabled by configuration."] };
    finalStore.write("final-gate-discovery.json", { commands: discovery.commands, notes: discovery.notes });
    const finalGate = config.gate.enabled ? await runGate(project.repoPath, discovery, { timeoutMs: config.gate.timeoutMs }) : skippedGateResult("Deterministic gate disabled by configuration.");
    if (isProjectFinalizationStopped(project.status, rt.stopRequested)) return;
    finalStore.write("final-gate.log", formatGateResult(finalGate));
    const diff = await getDiff(project.repoPath);
    if (isProjectFinalizationStopped(project.status, rt.stopRequested)) return;
    const milestoneResults = ordered.map((m) => {
      const rec = project.milestones[m.id];
      // A CONVERGED milestone's historical unresolved notes were resolved by
      // its own Judge; passing them to final ratification would make the
      // Controller reject on stale evidence.
      const unresolved = rec?.status === "CONVERGED" ? [] : (rec?.unresolved ?? []);
      return { milestoneId: m.id, title: m.title, summary: rec?.summary ?? "", verdict: rec?.verdict ?? "", unresolved, deviations: rec?.deviations ?? [] };
    });
    const productAcceptance = await requestProductManager(ctx, project, config, "final_acceptance", { plan, milestones: milestoneResults, gate_summary: formatGateResult(finalGate), diff }, (requestId, responsePath) => buildProductAcceptancePrompt({ requestId, responsePath, plan, milestones: milestoneResults, diff, gateSummary: formatGateResult(finalGate) }), parseProjectAcceptance);
    if (isProjectFinalizationStopped(project.status, rt.stopRequested)) return;
    project.productAcceptance = productAcceptance; writeProjectState(project);
    const acceptanceRaw = await completeText(ctx, controller, "You are the final Controller ratifier. Output only the requested fenced YAML.", buildProjectAcceptancePrompt({ plan, milestones: milestoneResults, diff, gateSummary: formatGateResult(finalGate), productAcceptance }), { thinking: config.controller.thinking });
    if (isProjectFinalizationStopped(project.status, rt.stopRequested)) return;
    finalStore.write("controller-ratification-raw.md", acceptanceRaw);
    const acceptance = parseProjectAcceptance(acceptanceRaw);
    finalStore.write("controller-ratification.yaml", JSON.stringify(acceptance ?? { verdict: "blocked", reason: "unparseable ratification" }, null, 2));
    // Keep the Stage-1 field/artifact name as controller ratification compatibility data.
    project.finalAcceptance = acceptance?.verdict;
    project.status = canAcceptProject({ orderedMilestoneIds: project.orderedMilestoneIds, milestones: project.milestones, finalGatePassed: finalGate.passed, productAcceptance, acceptance }) ? "ACCEPTED" : productAcceptance.verdict === "blocked" || acceptance?.verdict === "blocked" ? "BLOCKED" : "REJECTED";
    project.updatedAt = new Date().toISOString(); writeProjectState(project);
    finalStore.write("project-acceptance-report.md", `# Project ${project.status}\n\nProduct Manager: ${productAcceptance.summary}\n\nController ratification: ${acceptance?.summary ?? "could not be parsed"}\n\n${formatGateResult(finalGate)}`);
    if (project.productManager) { project.productManager.state = "DONE"; writeProductManagerMetadata(project); }
    showText(`Dual-Gate Project ${project.status}\nProject: ${projectId}\nFinal gate: ${finalGate.passed ? "passed" : "failed"}\nProduct acceptance: ${productAcceptance.verdict}\nController ratification: ${acceptance?.verdict ?? "unparseable"}`);
  } catch (e) {
    if (project.status !== "CANCELLED") {
      project.status = "FAILED"; project.error = errMsg(e); project.updatedAt = new Date().toISOString();
      if (project.productManager) { project.productManager.state = "FAILED"; project.productManager.error = errMsg(e); writeProductManagerMetadata(project); }
      writeProjectState(project);
      ctx.ui.notify(`Dual-Gate project failed: ${errMsg(e)}`, "error");
    }
  } finally {
    rt.running = false;
    // PM is kept for inspection unless the existing completion policy requests closure.
    if (config.panel.on_complete === "close" && project.productManager?.paneId && !isActiveProjectState(project.status)) await herdrPaneClose(project.productManager.paneId).catch(() => {});
    updateWidget(ctx);
    // Retain terminal project state for /dual status during this session.
  }
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
    pauseRequested: false,
    resumeRequested: false,
    pendingResumeRequirement: undefined,
    activeProject: null,
  };

  const rt = getRuntime();

  pi.on("session_start", (_event, ctx) => {
    rt.manager = new TaskManager(ctx.cwd);
    // Restore interrupted task/project records from disk (crash/restart).
    try {
      const resumedTasks = rt.manager.loadFromDisk(ctx.cwd);
      const projects = loadProjectsFromDisk(ctx.cwd);
      const activeProject = projects.find((p) => isActiveProjectState(p.status)) ?? null;
      rt.activeProject = activeProject;
      if (resumedTasks.length || activeProject) {
        ctx.ui.notify(
          `Dual-Gate: recovered ${resumedTasks.length} interrupted task(s)${activeProject ? ` + project ${activeProject.projectId} (${activeProject.status})` : ""} — run /dual status or /dual resume`,
          "warning",
        );
      }
    } catch { /* recovery is best-effort */ }
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

    // While paused, the user's text is a NEW REQUIREMENT for re-analysis:
    // queue it and resume automatically (no /dual resume needed).
    const active = rt.manager.active();
    if (active && active.state === "PAUSED") {
      rt.resumeRequested = true;
      rt.pendingResumeRequirement = text;
      ctx.ui.notify("Dual-Gate: new requirement received — resuming for re-analysis", "info");
      updateWidget(ctx);
      return { action: "handled" };
    }

    // A Dual-Gate task owns the next non-command input. Do not let the main
    // Pi model execute it in parallel with the Controller/Executor workflow.
    if (rt.running || active || (rt.activeProject && isActiveProjectState(rt.activeProject.status))) return { action: "handled" };

    if ((globalThis as any).__dg_handling_input) return { action: "handled" };
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
    return { action: "handled" };
  });

  const SUBCOMMANDS: Array<{ name: string; label: string; description: string }> = [
    { name: "on", label: "Turn ON", description: "Enable Dual-Gate (default: off)" },
    { name: "off", label: "Turn OFF", description: "Disable Dual-Gate, restore normal Pi" },
    { name: "status", label: "Status", description: "Show current state (models, task, pane, session, project)" },
    { name: "project", label: "Project", description: "Open PM third pane, approve WBS, then run milestone batches (parallel where possible)" },
    { name: "models", label: "Models", description: "Show current model configuration" },
    { name: "controller", label: "Controller / Judge", description: "Pick the Controller/Judge model" },
    { name: "executor", label: "Executor", description: "Pick the Executor model" },
    { name: "product-manager", label: "Product Manager", description: "Pick the project-only read-only PM model" },
    { name: "thinking", label: "Thinking level", description: "Set Controller thinking level (minimal..max)" },
    { name: "cancel", label: "Cancel task", description: "Cancel the active task, keep the pane" },
    { name: "pause", label: "Pause task", description: "Pause the active task (Executor kept alive)" },
    { name: "resume", label: "Resume task", description: "Resume with optional new requirement" },
    { name: "bypass", label: "Bypass next", description: "Next prompt uses normal Pi, then Dual-Gate resumes" },
    { name: "reflex", label: "Reflex Layer", description: "System-1 reflex: on/off/observe/enforce (Gate/Finish/Stuck/Policy)" },
    { name: "cleanup", label: "Cleanup panes", description: "Close done Dual-Gate worker panes" },
    { name: "help", label: "Help", description: "Show the full command list" },
  ];

  pi.registerCommand("dual", {
    description: "Dual-Gate Orchestrator: on/off/status/models/thinking/controller/executor/product-manager/cancel/bypass/cleanup",
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
          // OFF stops an in-flight loop as well as future input interception.
          rt.stopRequested = true;
          const active = rt.manager.active();
          if (active) {
            rt.manager.cancelActive("Dual-Gate disabled by user");
            writeState(active, makeStore(active));
            if (active.herdrPanelId) await exec("herdr", ["pane", "rename", active.herdrPanelId, `${derivePanelTitle(active.taskId, basename(active.repoPath), active.originalRequest)} · CANCELLED`], { timeoutMs: 15_000 }).catch(() => {});
          }
          if (rt.activeProject && isActiveProjectState(rt.activeProject.status)) {
            const project = rt.activeProject;
            project.status = "CANCELLED"; project.updatedAt = new Date().toISOString();
            if (project.productManager) {
              project.productManager.state = "CANCELLED";
              if (project.productManager.paneId) await exec("herdr", ["pane", "rename", project.productManager.paneId, `${deriveProductManagerTitle(project.projectId, project.repoPath)} · CANCELLED`], { timeoutMs: 15_000 }).catch(() => {});
              writeProductManagerMetadata(project);
            }
            writeProjectState(project);
          }
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
        case "project": {
          if (rest[0]?.toLowerCase() === "status") {
            const project = rest[1] ? readPersistedProject(ctx.cwd, rest[1]) : rt.activeProject;
            if (project) presentProjectStatus(project);
            else ctx.ui.notify(rest[1] ? `Project ${rest[1]} not found` : "No project in this session; provide a project ID", "info");
          } else if (rest.length) {
            const first = rest[0] ?? "";
            const repoMatch = first.match(/^repo=(.+)$/);
            if (repoMatch) {
              await runProject(ctx, rest.slice(1).join(" "), repoMatch[1]);
            } else {
              await runProject(ctx, rest.join(" "));
            }
          } else {
            ctx.ui.notify("Usage: /dual project [repo=<path>] <request> or /dual project status", "info");
          }
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
        case "product-manager": {
          await setProductManager(ctx, rt, rest);
          break;
        }
        case "thinking": {
          await setThinking(ctx, rt, rest);
          break;
        }
        case "cancel": {
          // Project cancellation takes precedence over its currently active child task.
          const project = rt.activeProject;
          if (project && isActiveProjectState(project.status)) {
            rt.stopRequested = true;
            project.status = "CANCELLED"; project.updatedAt = new Date().toISOString();
            if (project.productManager) {
              project.productManager.state = "CANCELLED";
              if (project.productManager.paneId) await exec("herdr", ["pane", "rename", project.productManager.paneId, `${deriveProductManagerTitle(project.projectId, project.repoPath)} · CANCELLED`], { timeoutMs: 15_000 }).catch(() => {});
              writeProductManagerMetadata(project);
            }
            const child = rt.manager.cancelActive("project cancelled by user");
            if (child) {
              writeState(child, makeStore(child));
              if (child.herdrPanelId) await exec("herdr", ["pane", "rename", child.herdrPanelId, `${derivePanelTitle(child.taskId, basename(child.repoPath), child.originalRequest)} · CANCELLED`], { timeoutMs: 15_000 }).catch(() => {});
            }
            writeProjectState(project);
            ctx.ui.notify(`Dual-Gate: project ${project.projectId} cancelled`, "info");
          } else {
            const t = rt.manager.cancelActive("cancelled by user");
            if (t) {
              writeState(t, makeStore(t));
              if (t.herdrPanelId) await exec("herdr", ["pane", "rename", t.herdrPanelId, `${derivePanelTitle(t.taskId, basename(t.repoPath), t.originalRequest)} · CANCELLED`], { timeoutMs: 15_000 }).catch(() => {});
              ctx.ui.notify(`Dual-Gate: task ${t.taskId} cancelled (panel kept open)`, "info");
            } else ctx.ui.notify("Dual-Gate: no active task", "info");
          }
          updateWidget(ctx);
          break;
        }
        case "pause": {
          const t = rt.manager.active();
          if (!t) {
            ctx.ui.notify("Dual-Gate: no active task", "info");
            break;
          }
          rt.pauseRequested = true;
          ctx.ui.notify("Dual-Gate: pause requested — will pause at next checkpoint", "info");
          updateWidget(ctx);
          break;
        }
        case "resume": {
          // /dual resume project <projectId> — restart a stalled project.
          if (rest[0]?.toLowerCase() === "project") {
            const projectId = rest[1];
            const repoMatch = rest.slice(2).find((a) => a.startsWith("repo="));
            const repoScan = repoMatch ? repoMatch.slice(5) : ctx.cwd;
            const projects = loadProjectsFromDisk(repoScan);
            const project = projects.find((p) => p.projectId === projectId) ?? (rt.activeProject?.projectId === projectId ? rt.activeProject : null);
            if (!project || !isActiveProjectState(project.status)) {
              ctx.ui.notify(projectId ? `Project ${projectId} not found or not resumable (scanned ${repoScan})` : "Usage: /dual resume project <projectId> [repo=<path>]", "info");
              break;
            }
            rt.activeProject = project;
            rt.running = true;
            rt.stopRequested = false;
            ctx.ui.notify(`Dual-Gate: resuming project ${projectId} (${project.status}) — continuing milestones…`, "info");
            // Re-enter the project executor at its current milestone. The
            // milestone loop re-reads project-state.json and skips converged
            // milestones via their record status.
            await runProject(ctx, project.sourceRequest, project.repoPath, project);
            rt.running = false;
            updateWidget(ctx);
            break;
          }
          const t = rest[0] ? rt.manager.persistedTasks().find((x) => x.taskId === rest[0] || x.taskId.startsWith(rest[0]!)) : rt.manager.active();
          if (!t) {
            ctx.ui.notify(rest[0] ? `Task ${rest[0]} not found` : "Dual-Gate: no active task", "info");
            break;
          }
          if (rest[0] && ["DONE", "FAILED", "CANCELLED", "ESCALATED"].includes(t.state)) {
            ctx.ui.notify(`Task ${t.taskId} is terminal (${t.state}); nothing to resume`, "info");
            break;
          }
          if (rest[0]) {
            // Resume an interrupted (restart-recovered) task from checkpoint.
            await orchestrate(ctx, t, { resumeFromCheckpoint: true });
            updateWidget(ctx);
            break;
          }
          if (t.state !== "PAUSED") {
            ctx.ui.notify("Dual-Gate: task is not paused (use /dual pause first)", "info");
            break;
          }
          // Optional: remainder of args becomes the new requirement text.
          const newReq = rest.length ? rest.join(" ") : undefined;
          rt.resumeRequested = true;
          rt.pendingResumeRequirement = newReq;
          ctx.ui.notify(newReq ? "Dual-Gate: resume with new requirement — re-analyzing…" : "Dual-Gate: resume", "info");
          updateWidget(ctx);
          break;
        }
        case "bypass": {
          rt.manager.setBypassNext(true);
          ctx.ui.notify("Dual-Gate: next prompt will use normal Pi (bypass)", "info");
          break;
        }
        case "reflex": {
          // Toggle/view the Reflex Layer (System-1).
          const action = (rest[0] ?? "").toLowerCase();
          if (action === "on") {
            rt.config.reflex.enabled = true;
            saveConfig({ reflex: { ...rt.config.reflex, enabled: true } });
            ctx.ui.notify("Dual-Gate reflex: ENABLED (mode: " + rt.config.reflex.mode + ")", "success");
          } else if (action === "off") {
            rt.config.reflex.enabled = false;
            saveConfig({ reflex: { ...rt.config.reflex, enabled: false } });
            ctx.ui.notify("Dual-Gate reflex: disabled", "info");
          } else if (action === "enforce") {
            rt.config.reflex.mode = "enforce";
            saveConfig({ reflex: { ...rt.config.reflex, mode: "enforce" } });
            ctx.ui.notify("Dual-Gate reflex: mode=enforce (will intervene)", "warning");
          } else if (action === "observe") {
            rt.config.reflex.mode = "observe";
            saveConfig({ reflex: { ...rt.config.reflex, mode: "observe" } });
            ctx.ui.notify("Dual-Gate reflex: mode=observe (log only)", "info");
          } else {
            const r = rt.config.reflex;
            showText([
              "Dual-Gate Reflex Layer (System-1)",
              `  enabled: ${r.enabled}`,
              `  mode:    ${r.mode}`,
              `  backend: ${r.backend}`,
              `  jev deadline: ${r.jev_deadline_ms}ms`,
              "",
              "  /dual reflex on|off          enable/disable",
              "  /dual reflex observe|enforce switch mode",
              "  reflex artifacts: .pi/dual-gate/<task>/reflex-*.log",
            ].join("\n"));
          }
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
              "  /dual status               current task/project state",
              "  /dual project <request>    open PM third pane, plan/approve, then run milestone batches (parallel where possible)",
              "  /dual project status       project progress",
              "  /dual models               model configuration",
              "  /dual controller [id]      pick controller model",
              "  /dual executor [id|default]  pick executor model (default = follow main Pi)",
              "  /dual product-manager [id|default]  pick read-only project PM model",
              "  /dual thinking [level]     thinking level (minimal..max)",
              "  /dual cancel               cancel active task",
              "  /dual pause                pause active task (Executor kept alive)",
              "  /dual resume [需求说明]    resume; optional new requirement triggers re-analysis",
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
    const exeRaw = config.executor.model;
    const exe = exeRaw === "default" ? null : resolveModelString(exeRaw);
    const task = rt.manager.active();
    const herdrOk = herdrAvailable();
    const lines: string[] = [];
    if (config.enabled) {
      lines.push("DUAL-GATE ON");
      lines.push(`Controller   ${ctl?.id ?? "?"}`);
      lines.push(`Thinking     ${config.controller.thinking}`);
      lines.push(`Executor     ${exe ? exe.id : "default（跟随主 Pi）"}`);
      const pmRaw = config.product_manager.model;
      const pm = pmRaw === "default" ? null : resolveModelString(pmRaw);
      lines.push(`Product PM   ${pm ? pm.id : "default（跟随主 Pi）"} · project-only read-only pane`);
      lines.push("Herdr        " + (herdrOk ? "Ready" : "NOT DETECTED"));
      lines.push(`Config       ${CONFIG_PATH} (跨 session/项目持久化)`);
      if (rt.activeProject) {
        const project = rt.activeProject;
        const current = project.currentMilestoneId ? project.milestones[project.currentMilestoneId] : undefined;
        lines.push("", "Project", `  ${project.projectId} · ${project.status}`, `  Milestone ${project.currentMilestoneId ?? "-"}: ${current?.title ?? "-"} (${current?.status ?? "-"}) · ${project.orderedMilestoneIds.length} total`, `  PM ${project.productManager?.state ?? "not started"} · pane ${project.productManager?.paneId ?? "-"}`, `  Product acceptance ${project.productAcceptance?.verdict ?? "pending"} · Controller ratification ${project.finalAcceptance ?? "pending"}`);
      }
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
      // Interrupted tasks/projects from a previous session (recoverable).
      const interrupted = rt.manager.all().filter((t) => !["DONE", "FAILED", "CANCELLED", "ESCALATED"].includes(t.state));
      if (!task && interrupted.length) {
        lines.push("", "Recoverable tasks", ...interrupted.map((t) => `  ${t.taskId} · ${t.state} · ${t.originalRequest.slice(0, 60)}`), "  Run: /dual resume <taskId>");
      }
      const persistedProjects = loadProjectsFromDisk(rt.manager.all()[0]?.repoPath ?? ctx.cwd);
      const stalledProjects = persistedProjects.filter((p) => isActiveProjectState(p.status) && p.projectId !== rt.activeProject?.projectId);
      if (stalledProjects.length) {
        lines.push("", "Recoverable projects", ...stalledProjects.map((p) => `  ${p.projectId} · ${p.status} · milestone ${p.currentMilestoneId ?? "-"}`), "  Run: /dual resume project <projectId>");
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
    const exeRaw = config.executor.model;
    const exe = exeRaw === "default" ? null : resolveModelString(exeRaw);
    const reg = makeRegistry(ctx);
    const ctlValid = reg.find(config.controller.model) ? "✓" : "⚠";
    const exeValid = exeRaw === "default" ? "✓" : reg.find(exeRaw) ? "✓" : "⚠";
    const pmRaw = config.product_manager.model;
    const pm = pmRaw === "default" ? null : resolveModelString(pmRaw);
    const pmValid = pmRaw === "default" ? "✓" : findAvailableAuthenticatedModel(reg, pmRaw) ? "✓" : "⚠";
    showText(
      [
        "Dual-Gate Models",
        `Controller / Judge  ${ctl?.id ?? "?"} ${ctlValid}`,
        `Thinking            ${config.controller.thinking}`,
        `Executor            ${exe ? exe.id : "default（跟随主 Pi）"} ${exeValid}`,
        `Product Manager     ${pm ? pm.id : "default（跟随主 Pi）"} ${pmValid} (project-only, read-only pane)`,
        rt.activeProject?.productManager ? `PM session          ${rt.activeProject.productManager.state} · pane ${rt.activeProject.productManager.paneId ?? "-"}` : "PM session          no active project",
        "",
        "Set with:  /dual controller [id]   /dual executor [id]   /dual product-manager [id|default]   /dual thinking [level]",
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
      if (spec.toLowerCase() === "default") {
        rt.config.executor.model = "default";
        saveConfig({ executor: { model: "default" } });
        ctx.ui.notify("Executor → default（跟随主 Pi 当前模型）", "success");
        return;
      }
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
    const registry = makeRegistry(ctx);
    const labels = [
      "default（跟随主 Pi 当前模型）",
      ...registry.available().map((m) => `${m.provider}/${m.id}${m.name && m.name !== `${m.provider}/${m.id}` ? ` — ${m.name}` : ""}`),
    ];
    const chosen = await ctx.ui.select("Executor model:", labels);
    if (!chosen) return;
    if (chosen.startsWith("default")) {
      rt.config.executor.model = "default";
      saveConfig({ executor: { model: "default" } });
      ctx.ui.notify("Executor → default（跟随主 Pi 当前模型）", "success");
      return;
    }
    const picked = registry.available()[labels.indexOf(chosen) - 1];
    if (picked) {
      rt.config.executor.model = `${picked.provider}/${picked.id}`;
      saveConfig({ executor: { model: rt.config.executor.model } });
      ctx.ui.notify(`Executor → ${picked.id}（已保存，跨 session/项目生效）`, "success");
    }
  }

  async function setProductManager(ctx: ExtensionCommandContext, rt: DgRuntime, rest: string[]): Promise<void> {
    const set = (model: string, label: string) => {
      rt.config.product_manager.model = model;
      saveConfig({ product_manager: { model } } as Partial<ReturnType<typeof normalizeConfig>>);
      ctx.ui.notify(`Product Manager → ${label}（仅项目模式，只读 pane；已保存）`, "success");
    };
    if (rest.length) {
      const spec = rest.join(" ");
      if (spec.toLowerCase() === "default") { set("default", "default（跟随主 Pi 当前模型）"); return; }
      const ref = findAvailableAuthenticatedModel(makeRegistry(ctx), spec);
      if (!ref) { ctx.ui.notify(`Product Manager model is not available with configured authentication: ${spec}`, "error"); return; }
      set(`${ref.provider}/${ref.id}`, ref.id); return;
    }
    const registry = makeRegistry(ctx);
    const pmModels = registry.available().filter((model) => registry.hasAuth(model));
    const labels = ["default（跟随主 Pi 当前模型）", ...pmModels.map((m) => `${m.provider}/${m.id}${m.name && m.name !== `${m.provider}/${m.id}` ? ` — ${m.name}` : ""}`)];
    const chosen = await ctx.ui.select("Product Manager model:", labels);
    if (!chosen) return;
    if (chosen.startsWith("default")) { set("default", "default（跟随主 Pi 当前模型）"); return; }
    const picked = pmModels[labels.indexOf(chosen) - 1];
    if (picked) set(`${picked.provider}/${picked.id}`, picked.id);
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
    const pm = rt.activeProject?.productManager;
    const closePm = !!pm?.paneId && ["DONE", "FAILED", "CANCELLED"].includes(pm.state);
    if (done.length === 0 && !closePm) {
      ctx.ui.notify("Dual-Gate: no terminal worker or Product Manager panes to clean up", "info");
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
    if (closePm && pm?.paneId) {
      try { await herdrPaneClose(pm.paneId); ctx.ui.notify(`Closed Product Manager panel ${pm.paneId}`, "info"); }
      catch (e) { ctx.ui.notify(`Failed to close Product Manager ${pm.paneId}: ${errMsg(e)}`, "warning"); }
    }
    ctx.ui.notify(`Dual-Gate: cleaned up ${done.length + (closePm ? 1 : 0)} panel(s)`, "success");
  }
}
