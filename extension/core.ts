// =============================================================================
// Dual-Gate Orchestrator — core orchestration logic (pure, testable)
//
// The extension glue (dual-gate.ts) provides the Pi UI + Herdr transport; this
// module contains the closed-loop state machine (Expected ↔ Actual), task
// lifecycle, model resolution, configuration, prompt building, and artifact
// versioning. All of it is side-effect free except explicit artifact writes
// injected via an ArtifactStore interface.
// =============================================================================

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  DgConfig,
  TaskRecord,
  TaskState,
  AcceptanceContract,
  JudgeOutput,
  ModelRef,
  ThinkingLevel,
  Delta,
  SpecRevision,
  SpecRevisionResult,
  ConvergenceDiagnosis,
  ProjectPlan,
  Milestone,
  ProjectMilestoneContext,
  ProjectAcceptance,
  ProjectRecord,
  ProjectState,
  ProjectMilestoneFeedback,
} from "./types.ts";

export interface ArtifactStore {
  write(name: string, data: string | object): string;
  read(name: string): string | null;
  dir(): string;
}

export function createArtifactStore(taskDir: string): ArtifactStore {
  mkdirSync(taskDir, { recursive: true });
  return {
    write(name, data) {
      const p = join(taskDir, name);
      writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", "utf8");
      return p;
    },
    read(name) {
      const p = join(taskDir, name);
      if (!existsSync(p)) return null;
      return readFileSync(p, "utf8");
    },
    dir() {
      return taskDir;
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: DgConfig = {
  enabled: false,
  controller: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
  executor: { model: "new-api/deepseek-v4-flash" },
  // Project mode only. `default` deliberately follows the parent Pi model.
  product_manager: { model: "default" },
  runtime: { herdr: "required" },
  gate: { enabled: true, max_retries: 3, timeoutMs: 300_000 },
  judge: { max_retries: 2 },
  loop: { max_iterations: 5 },
  panel: { direction: "right", ratio: 0.4, on_complete: "keep" },
  worktree: { mode: "auto" },
  context: { send_full_executor_history_to_judge: false },
  ui: { show_widget: true },
};

export function normalizeConfig(raw: Partial<DgConfig> | null | undefined): DgConfig {
  const c: DgConfig = structuredClone(DEFAULT_CONFIG);
  if (!raw || typeof raw !== "object") return c;
  const r = raw as Record<string, any>;
  if (typeof r.enabled === "boolean") c.enabled = r.enabled;
  if (r.controller && typeof r.controller === "object") {
    if (typeof r.controller.model === "string" && r.controller.model.trim()) c.controller.model = r.controller.model.trim();
    if (isThinking(r.controller.thinking)) c.controller.thinking = r.controller.thinking;
  }
  if (r.executor && typeof r.executor === "object") {
    if (typeof r.executor.model === "string" && r.executor.model.trim()) c.executor.model = r.executor.model.trim();
  }
  // Optional for backwards-compatible persisted configuration.
  if (r.product_manager && typeof r.product_manager === "object") {
    if (typeof r.product_manager.model === "string" && r.product_manager.model.trim()) c.product_manager.model = r.product_manager.model.trim();
  }
  if (r.gate && typeof r.gate === "object") {
    if (typeof r.gate.enabled === "boolean") c.gate.enabled = r.gate.enabled;
    if (Number.isFinite(r.gate.max_retries) && r.gate.max_retries >= 0) c.gate.max_retries = Math.floor(r.gate.max_retries);
    if (Number.isFinite(r.gate.timeoutMs) && r.gate.timeoutMs > 0) c.gate.timeoutMs = r.gate.timeoutMs;
  }
  if (r.judge && typeof r.judge === "object") {
    if (Number.isFinite(r.judge.max_retries) && r.judge.max_retries >= 0) c.judge.max_retries = Math.floor(r.judge.max_retries);
  }
  if (r.loop && typeof r.loop === "object") {
    if (Number.isFinite(r.loop.max_iterations) && r.loop.max_iterations > 0) c.loop.max_iterations = Math.floor(r.loop.max_iterations);
  }
  if (r.panel && typeof r.panel === "object") {
    if (r.panel.direction === "right" || r.panel.direction === "down") c.panel.direction = r.panel.direction;
    if (Number.isFinite(r.panel.ratio) && r.panel.ratio > 0 && r.panel.ratio <= 1) c.panel.ratio = r.panel.ratio;
    if (r.panel.on_complete === "keep" || r.panel.on_complete === "close") c.panel.on_complete = r.panel.on_complete;
  }
  if (r.worktree && typeof r.worktree === "object") {
    if (r.worktree.mode === "auto" || r.worktree.mode === "current" || r.worktree.mode === "isolated") c.worktree.mode = r.worktree.mode;
  }
  if (r.context && typeof r.context === "object") {
    if (typeof r.context.send_full_executor_history_to_judge === "boolean") c.context.send_full_executor_history_to_judge = r.context.send_full_executor_history_to_judge;
  }
  if (r.ui && typeof r.ui === "object") {
    if (typeof r.ui.show_widget === "boolean") c.ui.show_widget = r.ui.show_widget;
  }
  return c;
}

export function isThinking(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v);
}

export function resolveModelString(spec: string): ModelRef | null {
  const s = spec.trim();
  if (!s) return null;
  const slash = s.indexOf("/");
  if (slash > 0) {
    return { provider: s.slice(0, slash), id: s.slice(slash + 1), name: s };
  }
  return { provider: "", id: s, name: s };
}

// ---------------------------------------------------------------------------
// Model registry adapter (interface — implemented by the extension glue)
// ---------------------------------------------------------------------------

export interface ModelRegistryAdapter {
  find(spec: string): ModelRef | null;
  available(): ModelRef[];
  clampThinking(modelRef: ModelRef, level: ThinkingLevel): ThinkingLevel | "off";
  hasAuth(modelRef: ModelRef): boolean;
}

/**
 * Resolve a model only from the authenticated models actually exposed by Pi.
 * Unlike registry.find(), this deliberately never accepts a synthetic model
 * reference for a qualified but unknown provider/model pair.
 */
export function findAvailableAuthenticatedModel(registry: ModelRegistryAdapter, spec: string): ModelRef | null {
  const requested = resolveModelString(spec);
  if (!requested) return null;
  const matches = registry.available().filter((model) => {
    if (requested.provider) return model.provider === requested.provider && model.id === requested.id;
    return model.id === requested.id || model.name.toLowerCase() === requested.name.toLowerCase();
  });
  const model = matches[0];
  return model && registry.hasAuth(model) ? model : null;
}

// ---------------------------------------------------------------------------
// Task ID and artifact layout
// ---------------------------------------------------------------------------

export function generateTaskId(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const seq = randomBytes(3).toString("hex").slice(0, 4);
  return `task-${y}${m}${d}-${seq}`;
}

export function artifactRoot(cwd: string): string {
  return join(cwd, ".pi", "dual-gate");
}

export function taskDirFor(cwd: string, taskId: string): string {
  return join(artifactRoot(cwd), taskId);
}

export function generateProjectId(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `project-${y}${m}${d}-${randomBytes(3).toString("hex").slice(0, 4)}`;
}

export function projectDirFor(cwd: string, projectId: string): string {
  return join(artifactRoot(cwd), "projects", projectId);
}

export function projectMilestoneDirFor(cwd: string, projectId: string, milestoneId: string): string {
  return join(projectDirFor(cwd, projectId), "milestones", milestoneId);
}

/** Load persisted project records under `<cwd>/.pi/dual-gate/projects/`. */
export function loadProjectsFromDisk(cwd: string): ProjectRecord[] {
  const root = join(artifactRoot(cwd), "projects");
  let dirs: string[] = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("project-")).map((d) => d.name); } catch { return []; }
  const out: ProjectRecord[] = [];
  for (const dir of dirs) {
    try {
      const p = join(root, dir, "project-state.json");
      if (!existsSync(p)) continue;
      const rec = JSON.parse(readFileSync(p, "utf8")) as ProjectRecord;
      if (rec && rec.projectId) out.push(rec);
    } catch { /* skip corrupt */ }
  }
  return out;
}

export function normalizeRepoPath(cwd: string): string {
  return resolve(cwd);
}

/** Human-friendly short label for the worker panel, e.g. "DS · tablet-auto-rotate". */
export function derivePanelTitle(taskId: string, repoName: string, request: string): string {
  const clean = request.replace(/[^\p{L}\p{N}\s-]/gu, "").trim().split(/\s+/).slice(0, 5).join("-");
  const slug = (clean || "task").toLowerCase().slice(0, 32) || "task";
  return `DS · ${repoName} · ${slug}`;
}

export function deriveAgentName(taskId: string): string {
  return `ds-${taskId.replace(/[^a-z0-9_-]/gi, "").slice(-24).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const STATE_TRANSITIONS: Record<TaskState, TaskState[]> = {
  IDLE: ["PLANNING"],
  PLANNING: ["SPAWNING_EXECUTOR", "FAILED", "CANCELLED", "ESCALATED", "WAITING_PERMISSION"],
  SPAWNING_EXECUTOR: ["EXECUTING", "FAILED", "CANCELLED", "ESCALATED"],
  EXECUTING: ["GATING", "FAILED", "CANCELLED", "ESCALATED", "PAUSED"],
  GATING: ["JUDGING", "FIXING_IMPLEMENTATION", "FAILED", "CANCELLED", "ESCALATED", "PAUSED"],
  FIXING_GATE: ["GATING", "FAILED", "CANCELLED", "ESCALATED", "PAUSED"],
  FIXING_IMPLEMENTATION: ["GATING", "REVISING_SPEC", "FAILED", "CANCELLED", "ESCALATED", "DIAGNOSING", "PAUSED"],
  REVISING_SPEC: ["EXECUTING", "GATING", "FAILED", "CANCELLED", "ESCALATED", "DIAGNOSING", "PAUSED"],
  JUDGING: ["DONE", "FIXING_IMPLEMENTATION", "REVISING_SPEC", "ESCALATED", "FAILED", "DIAGNOSING", "PAUSED"],
  DIAGNOSING: ["REVISING_SPEC", "FIXING_IMPLEMENTATION", "DONE", "ESCALATED", "FAILED", "CANCELLED", "PAUSED"],
  PAUSED: ["EXECUTING", "GATING", "JUDGING", "FIXING_IMPLEMENTATION", "REVISING_SPEC", "DIAGNOSING", "FAILED", "CANCELLED", "ESCALATED"],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
  ESCALATED: [],
  WAITING_PERMISSION: ["PLANNING", "CANCELLED", "ESCALATED"],
};

export class InvalidTransitionError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`Invalid state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: TaskState, to: TaskState): void {
  const allowed = STATE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

// ---------------------------------------------------------------------------
// Task manager
// ---------------------------------------------------------------------------

export class TaskManager {
  private tasks = new Map<string, TaskRecord>();
  private activeTaskId: string | null = null;
  private bypassNext = false;
  private cwd: string;

  constructor(cwd: string) { this.cwd = cwd; }

  begin(originalRequest: string, models: { controller: ModelRef; executor: ModelRef }, risk: RiskLevel = "low"): TaskRecord {
    return this.beginFor(this.cwd, originalRequest, models, risk);
  }

  /** Begin a task whose repository/artifacts live in `cwd` (project repo override). */
  beginFor(cwd: string, originalRequest: string, models: { controller: ModelRef; executor: ModelRef }, risk: RiskLevel = "low"): TaskRecord {
    const taskId = generateTaskId();
    const artifactDir = taskDirFor(cwd, taskId);
    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId,
      repoPath: normalizeRepoPath(cwd),
      state: "PLANNING",
      originalRequest,
      controllerModel: `${models.controller.provider}/${models.controller.id}`,
      executorModel: `${models.executor.provider}/${models.executor.id}`,
      herdrPanelId: null,
      herdrAgentName: null,
      worktreePath: null,
      panelCreated: false,
      gateFailures: 0,
      judgeFailures: 0,
      iteration: 0,
      expectedVersion: 1,
      gapCount: 0,
      previousGapCount: 0,
      progress: "improving",
      sameGapStreak: 0,
      executorStuck: false,
      specRevisions: 0,
      currentStage: "planning",
      artifactDir,
      createdAt: now,
      updatedAt: now,
      bypassNext: this.bypassNext,
      risk,
    };
    this.tasks.set(taskId, record);
    this.activeTaskId = taskId;
    this.bypassNext = false;
    return record;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  active(): TaskRecord | null {
    if (!this.activeTaskId) return null;
    const t = this.tasks.get(this.activeTaskId);
    return t && !["DONE", "FAILED", "CANCELLED", "ESCALATED"].includes(t.state) ? t : null;
  }

  all(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  transition(taskId: string, to: TaskState): TaskRecord {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`Unknown task: ${taskId}`);
    assertTransition(t.state, to);
    t.state = to;
    t.updatedAt = new Date().toISOString();
    if (to === "DONE") t.completedAt = t.updatedAt;
    if (to === "CANCELLED") { t.cancelledAt = t.updatedAt; if (this.activeTaskId === taskId) this.activeTaskId = null; }
    if (to === "FAILED" || to === "ESCALATED") { if (this.activeTaskId === taskId) this.activeTaskId = null; }
    return t;
  }

  patch(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`Unknown task: ${taskId}`);
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    return t;
  }

  cancelActive(reason?: string): TaskRecord | null {
    const t = this.active();
    if (!t) return null;
    this.patch(t.taskId, { currentStage: "cancelled", error: reason });
    return this.transition(t.taskId, "CANCELLED");
  }

  /**
   * Load task records persisted under the dual-gate task artifact directory.
   * Returns the non-terminal tasks that were interrupted (crash / restart)
   * and can be resumed. Each is restored from state.json + metadata.json.
   */
  loadFromDisk(cwd: string): TaskRecord[] {
    const root = artifactRoot(cwd);
    let dirs: string[] = [];
    try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("task-")).map((d) => d.name); } catch { return []; }
    const restored: TaskRecord[] = [];
    for (const dir of dirs) {
      const base = join(root, dir);
      const stPath = join(base, "state.json");
      const metaPath = join(base, "metadata.json");
      let st: Record<string, unknown>;
      try { st = JSON.parse(readFileSync(stPath, "utf8")); } catch { continue; }
      const taskId = String(st.taskId ?? dir);
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* metadata optional */ }
      const state = (typeof st.state === "string" && st.state) ? st.state as TaskState : "FAILED";
      const record: TaskRecord = {
        taskId,
        repoPath: String(meta.repoPath ?? st.repoPath ?? cwd),
        state,
        originalRequest: String(st.originalRequest ?? ""),
        controllerModel: String(meta.controller ?? ""),
        executorModel: String(meta.executor ?? ""),
        herdrPanelId: (st.herdrPanelId as string) ?? (meta.herdrPanel as string) ?? null,
        herdrAgentName: (st.herdrAgentName as string) ?? (meta.herdrAgent as string) ?? null,
        worktreePath: (st.worktreePath as string) ?? null,
        panelCreated: Boolean(meta.herdrPanel ?? st.herdrPanelId),
        gateFailures: Number(st.gateFailures ?? 0),
        judgeFailures: Number(st.judgeFailures ?? 0),
        iteration: Number(st.iteration ?? 0),
        expectedVersion: Number(st.expectedVersion ?? 1),
        gapCount: Number(st.gapCount ?? 0),
        previousGapCount: Number(st.previousGapCount ?? 0),
        progress: (st.progress === "improving" || st.progress === "stalled" || st.progress === "worsening") ? st.progress : "stalled",
        sameGapStreak: Number(st.sameGapStreak ?? 0),
        executorStuck: Boolean(st.executorStuck),
        specRevisions: Number(st.specRevisions ?? 0),
        currentStage: String(st.currentStage ?? "restored"),
        artifactDir: base,
        createdAt: String(st.createdAt ?? meta.createdAt ?? ""),
        updatedAt: String(st.updatedAt ?? ""),
        bypassNext: false,
        risk: (st.risk === "low" || st.risk === "medium" || st.risk === "high") ? st.risk : "low",
        error: typeof st.error === "string" ? st.error : undefined,
      };
      this.tasks.set(taskId, record);
      if (!["DONE", "FAILED", "CANCELLED", "ESCALATED"].includes(state)) {
        this.activeTaskId = taskId;
        restored.push(record);
      }
    }
    return restored;
  }

  /** List all tasks (terminal + active) loaded from disk. */
  persistedTasks(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  setBypassNext(v: boolean): void {
    this.bypassNext = v;
  }
  getBypassNext(): boolean {
    return this.bypassNext;
  }
}

// ---------------------------------------------------------------------------
// Convergence bookkeeping
// ---------------------------------------------------------------------------

/**
 * Track the closed-loop progress between iterations. Returns whether to keep
 * going, escalate, or diagnose.
 */
/** True only for two non-empty, semantically identical judge gap sets. */
export function sameJudgeGaps(a: Pick<JudgeOutput, "gaps"> | null | undefined, b: Pick<JudgeOutput, "gaps"> | null | undefined): boolean {
  if (!a || !b) return false;
  const normalize = (gaps: string[]) => gaps.map((gap) => gap.toLowerCase().trim()).filter(Boolean).sort().join("|");
  const left = normalize(a.gaps);
  return left !== "" && left === normalize(b.gaps);
}

export function trackConvergence(task: TaskRecord, newGapCount: number, sameGap: boolean): {
  gapCount: number;
  previousGapCount: number;
  progress: ProgressTrend;
  sameGapStreak: number;
  executorStuck: boolean;
} {
  const previousGapCount = task.gapCount;
  const gapCount = newGapCount;
  let progress: ProgressTrend;
  if (gapCount < previousGapCount) progress = "improving";
  else if (gapCount === previousGapCount) progress = "stalled";
  else progress = "worsening";
  const sameGapStreak = sameGap ? (task.sameGapStreak ?? 0) + 1 : 0;
  const executorStuck = sameGapStreak >= 2;
  return { gapCount, previousGapCount, progress, sameGapStreak, executorStuck };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export function formatProjectContext(context?: ProjectMilestoneContext): string {
  if (!context) return "";
  const scope = [...context.scope.files, ...context.scope.components].join(", ") || "(none)";
  const prior = context.completedSummaries.length
    ? context.completedSummaries.map((x) => `- ${x.milestoneId} (${x.verdict}): ${x.summary}`).join("\n")
    : "- none";
  const memory = context.repoMemory?.trim()
    ? `\n## REPO MEMORY (learned by earlier milestones — trust it, verify only what you touch)\n${context.repoMemory.trim()}`
    : "";
  return `\n## PROJECT / MILESTONE CONTEXT (authoritative boundary)\nPROJECT: ${context.projectId} — ${context.projectGoal}\nMILESTONE: ${context.milestoneId} — ${context.milestoneTitle}\nDEPENDENCIES: ${context.dependsOn.join(", ") || "none"}\nSCOPE: ${scope}\nCOMPLETED MILESTONES:\n${prior}${memory}\nDo not regress completed milestones or work outside this milestone scope.`;
}

export function buildExecutorPrompt(input: {
  originalRequest: string;
  contract: AcceptanceContract;
  repoPath: string;
  mode: "initial" | "gate-fix" | "delta-fix" | "executor-swap";
  gateErrors?: string;
  delta?: Delta;
  taskId: string;
  panelTitle: string;
  /** Controller-owned location, which may be outside an isolated worktree. */
  artifactDir?: string;
  projectContext?: ProjectMilestoneContext;
}): string {
  const c = input.contract;
  const criteriaLines = c.acceptance_criteria.map((x, i) => `  ${i + 1}. ${x}`).join("\n");
  const outcomeLines = c.expected_outcome.map((x) => `  - ${x}`).join("\n");
  const constraintLines = c.constraints.map((x) => `  - ${x}`).join("\n");
  const archLines = c.architecture.relevant_components.map((x) => `  - ${x}`).join("\n");
  const riskLines = c.risk.concerns.map((x) => `  - ${x}`).join("\n");
  const validationLines = c.validation.required.map((x) => `  - ${x}`).join("\n");
  // In isolated mode the controller's artifacts stay in the original checkout,
  // so never infer this path from the executor's worktree.
  const durableReportPath = input.artifactDir
    ? join(input.artifactDir, "executor-report.yaml")
    : join(input.repoPath, ".pi", "dual-gate", input.taskId, "executor-report.yaml");

  const projectContext = formatProjectContext(input.projectContext);
  let body = "";
  if (input.mode === "initial") {
    body = `You are the Executor in a Dual-Gate workflow. You own implementation, debugging and validation in the repository.

REPOSITORY: ${input.repoPath}
TASK ID: ${input.taskId}
${projectContext}

## ORIGINAL USER REQUEST
${input.originalRequest}

## EXPECTED OUTCOME (Controller, v${c.version}) — authoritative
${outcomeLines}

## ACCEPTANCE CRITERIA (authoritative)
${criteriaLines}

### Goal
${c.goal}

### Context
${c.context}

### Architecture (guidance unless explicitly a hard constraint)
${archLines}

### Constraints
${constraintLines}

### Validation
${validationLines}

### Risk: ${c.risk.level}
${riskLines}

## YOUR ROLE
- You are the Executor. The Expected Outcome and Acceptance Criteria are authoritative.
- The architecture is guidance unless marked as a hard constraint; explore the repository yourself.
- Explore, understand, implement, run, debug, test, validate, and report. Do not stop after editing files.
- Run the relevant tests and validation. Fix what you broke until it passes.
- Do not commit, push, merge, or force-push unless the user explicitly requested it.
- Work only in the given repository.

## EXECUTION REPORT (REQUIRED — final message)
When you have finished and verified your work, produce ONLY a structured Execution Report as a fenced YAML block:

status: completed|blocked|failed
summary: ...
files_changed:
  - path: ...
    purpose: ...
implementation:
  - ...
tests:
  commands:
    - ...
  passed:
    - ...
  failed:
    - ...
validation:
  lint: pass|fail|not_run
  typecheck: pass|fail|not_run
  build: pass|fail|not_run
acceptance_check:
  <short criterion label>: pass|fail
deviations:
  - ...
unresolved:
  - ...
risks:
  - ...

Do not include your internal chain-of-thought in the report. Be honest about failures.
Before sending the final message, write the same YAML report to this file (create parent directories if needed):
${durableReportPath}`;
  } else if (input.mode === "gate-fix") {
    body = `You are the Executor in a Dual-Gate workflow. Your previous work failed the deterministic gate.

REPOSITORY: ${input.repoPath}
TASK ID: ${input.taskId}

## ORIGINAL USER REQUEST
${input.originalRequest}

## EXPECTED OUTCOME (v${c.version}) — unchanged, still authoritative
${outcomeLines}

## ACCEPTANCE CRITERIA (authoritative)
${criteriaLines}

## GATE FAILURE
${input.gateErrors ?? "No details"}

Fix the implementation and rerun the validation yourself. Do not remove or regress already-correct behavior. When done, produce the same structured Execution Report (fenced YAML) as before.`;
  } else if (input.mode === "delta-fix") {
    const d = input.delta ?? { matched: [], missing: [], incorrect: [], unexpected: [], required_changes: [], must_preserve: [] };
    const lines = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  (none)");
    body = `You are the Executor in a Dual-Gate workflow. The previous implementation is partially correct.

REPOSITORY: ${input.repoPath}
TASK ID: ${input.taskId}

## ORIGINAL USER REQUEST
${input.originalRequest}

## EXPECTED OUTCOME (v${c.version}) — authoritative
${outcomeLines}

## ACCEPTANCE CRITERIA (authoritative)
${criteriaLines}

## DELTA (Controller/Judge analysis)
### Already correct — KEEP
${lines(d.matched)}

### MUST PRESERVE (do not regress)
${lines(d.must_preserve)}

### Missing (not yet satisfied)
${lines(d.missing)}

### Incorrect (wrong behavior)
${lines(d.incorrect)}

### Unexpected (side effects)
${lines(d.unexpected)}

## REQUIRED CHANGES
${lines(d.required_changes)}

Fix only the identified gaps. Keep the behavior listed under MUST PRESERVE.
After modifying the implementation:
1. rerun relevant tests
2. verify the original acceptance criteria
3. produce an updated Execution Report (fenced YAML, same structure).`;
  } else {
    // executor-swap
    const d = input.delta ?? { matched: [], missing: [], incorrect: [], unexpected: [], required_changes: [], must_preserve: [] };
    const lines = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  (none)");
    body = `You are a NEW Executor taking over a Dual-Gate task. A previous executor got stuck on the same implementation gap.

REPOSITORY: ${input.repoPath}
TASK ID: ${input.taskId}

## ORIGINAL USER REQUEST
${input.originalRequest}

## EXPECTED OUTCOME (v${c.version}) — authoritative
${outcomeLines}

## ACCEPTANCE CRITERIA (authoritative)
${criteriaLines}

## CURRENT DELTA
### Already correct — KEEP
${lines(d.matched)}

### MUST PRESERVE
${lines(d.must_preserve)}

### Missing
${lines(d.missing)}

### Incorrect
${lines(d.incorrect)}

### Unexpected
${lines(d.unexpected)}

## REQUIRED CHANGES
${lines(d.required_changes)}

## PREVIOUS ATTEMPTS (brief)
The previous executor failed to resolve these gaps over multiple iterations. Approach the problem from a fresh angle if needed.

Fix the gaps, rerun validation, and produce an updated Execution Report (fenced YAML).`;
  }

  if (input.mode !== "initial") {
    body += `\n\n${projectContext}\n\nBefore sending the final report, also write the same YAML to:\n${durableReportPath}`;
  }
  return body.trim();
}

export function buildJudgePrompt(input: {
  originalRequest: string;
  contract: AcceptanceContract;
  report: unknown;
  diff: string;
  gateSummary: string;
  taskId: string;
  risk: RiskLevel;
  iteration: number;
  previousJudge?: JudgeOutput;
  expectedVersion: number;
  projectContext?: ProjectMilestoneContext;
}): string {
  const prev = input.previousJudge
    ? `\n## PREVIOUS COMPARISON (for convergence tracking)\n${JSON.stringify(
        { verdict: input.previousJudge.verdict, gaps: input.previousJudge.gaps, matched: input.previousJudge.matched },
        null,
        2,
      )}`
    : "";
  return `You are the Judge in a Dual-Gate workflow. The deterministic gate passed. Your job is to compare the Expected Outcome against the Actual Outcome and determine the exact gap.

TASK ID: ${input.taskId}
RISK LEVEL: ${input.risk}
ITERATION: ${input.iteration}
EXPECTED OUTCOME VERSION: v${input.expectedVersion}
${formatProjectContext(input.projectContext)}

## ORIGINAL USER REQUEST
${input.originalRequest}

## EXPECTED OUTCOME (Contract v${input.contract.version})
${JSON.stringify(input.contract, null, 2)}

## EXECUTION REPORT (Actual)
${JSON.stringify(input.report, null, 2)}

## RELEVANT DIFF
${input.diff.slice(0, 30_000)}

## GATE RESULTS
${input.gateSummary}
${prev}

## YOUR ROLE
- Compare Expected ↔ Actual precisely. Do not just pass/fail — characterize the GAP.
- Priority: User Intent > Expected Outcome > Implementation.
- If the implementation misses the (still-correct) Expected Outcome → implementation_gap.
- If the Expected Outcome itself is wrong vs repository reality or user intent → spec_gap (propose a revision, but never change user intent).
- If both sides are partly wrong → mixed_gap (revise Expected first, then recompute delta).
- If the user's core intent cannot be satisfied → blocked.
- Do not re-read the whole repository by default; only read minimal files if you detect ambiguity/risk/unexpected diff.

## OUTPUT (REQUIRED — fenced YAML)
verdict: converged|implementation_gap|spec_gap|mixed_gap|blocked
confidence: high|medium|low
expected:
  - <expected outcomes relevant to the gap>
actual:
  - <observed actual behavior>
matched:
  - ...
gaps:
  - ...
implementation_changes:
  - <if implementation_gap/mixed_gap: concrete changes for DeepSeek>
spec_changes:
  - <if spec_gap/mixed_gap: how Expected should be revised>
spec_revision:
  version: <n+1>
  changed:
    - ...
  reason:
    - ...
  evidence:
    - ...
  user_intent_changed: false
delta:
  matched:
    - ...
  missing:
    - ...
  incorrect:
    - ...
  unexpected:
    - ...
  required_changes:
    - ...
  must_preserve:
    - ...
reason: ...`;
}

export function buildSpecRevisionPrompt(input: {
  originalRequest: string;
  contract: AcceptanceContract;
  judge: JudgeOutput;
  actualReport: unknown;
  repoPath: string;
  projectContext?: ProjectMilestoneContext;
}): string {
  return `You are the Controller/Architect of a Dual-Gate workflow. The Judge found the Expected Outcome does not match repository reality, so you must REVISE the Expected Outcome.

ORIGINAL USER REQUEST:
${input.originalRequest}

REPOSITORY: ${input.repoPath}
${formatProjectContext(input.projectContext)}

CURRENT EXPECTED OUTCOME (v${input.contract.version}):
${JSON.stringify(input.contract, null, 2)}

JUDGE SPEC_GAP ANALYSIS:
${JSON.stringify(input.judge, null, 2)}

ACTUAL (executor report):
${JSON.stringify(input.actualReport, null, 2)}

## YOUR ROLE
- Revise the Expected Outcome so it matches repository reality while PRESERVING the user's core intent.
- Priority: User Intent > Expected Outcome > Implementation.
- You may adjust: technical approach, intermediate state, implementation constraints, acceptance details, test method.
- You MUST NOT change the user's core goal. If the user's intent cannot be met at all → return blocked.
- Output the FULL revised contract as a fenced YAML block with EXACTLY this structure:

goal: ...
context: ...
architecture:
  relevant_components:
    - ...
constraints:
  - ...
expected_outcome:
  - ...
acceptance_criteria:
  - ...
validation:
  required:
    - ...
risk:
  level: low|medium|high
  concerns:
    - ...
spec_revision:
  version: ${input.contract.version + 1}
  changed:
    - ...
  reason:
    - ...
  evidence:
    - ...
  user_intent_changed: false`;
}

export function buildConvergenceDiagnosisPrompt(input: {
  originalRequest: string;
  contract: AcceptanceContract;
  history: unknown;
  taskId: string;
}): string {
  return `You are the Convergence Diagnostician of a Dual-Gate workflow. The loop has hit its iteration threshold and is not yet converged. Decide what to do.

TASK ID: ${input.taskId}

ORIGINAL USER REQUEST:
${input.originalRequest}

CURRENT EXPECTED OUTCOME (v${input.contract.version}):
${JSON.stringify(input.contract, null, 2)}

LOOP HISTORY:
${JSON.stringify(input.history, null, 2)}

## OUTPUT (fenced YAML)
assessment: continue|architecture|spec|executor|user
gap_trend: improving|stalled|worsening
recommendation: <what to do next>
continue_value: high|medium|low

Choose:
- continue: further iterations are clearly valuable.
- architecture: the proposed architecture cannot meet the goal.
- spec: the Expected Outcome is wrong and needs revision.
- executor: the executor model cannot solve this; recommend a stronger one.
- user: only the user can decide (goal conflict, scope, permissions, ambiguity).`;
}

// ---------------------------------------------------------------------------
// Task-Level Context: SPEC UPDATE / Executor Checkpoint / Session Recovery
// ---------------------------------------------------------------------------

/** Incremental spec update sent to the SAME executor session (no restart). */
export function buildSpecUpdatePrompt(input: {
  previousVersion: number;
  contract: AcceptanceContract;
  revision: SpecRevision;
  delta: Delta;
  originalRequest: string;
  repoPath: string;
  taskId: string;
  projectContext?: ProjectMilestoneContext;
}): string {
  const c = input.contract;
  const criteriaLines = c.acceptance_criteria.map((x, i) => `  ${i + 1}. ${x}`).join("\n");
  const outcomeLines = c.expected_outcome.map((x) => `  - ${x}`).join("\n");
  const lines = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  (none)");
  return `SPEC UPDATE
Previous Expected Version: v${input.previousVersion}
Current Expected Version: v${c.version}

TASK ID: ${input.taskId}
REPOSITORY: ${input.repoPath}
${formatProjectContext(input.projectContext)}

## CHANGED
${lines(input.revision.changed)}

## REASON
${lines(input.revision.reason)}

## EVIDENCE
${lines(input.revision.evidence)}

## CURRENT EXPECTED OUTCOME (v${c.version})
${outcomeLines}

## ACCEPTANCE CRITERIA (unchanged ones remain authoritative)
${criteriaLines}

## CURRENT DELTA
### Must preserve
${lines(input.delta.must_preserve)}
### Missing
${lines(input.delta.missing)}
### Incorrect
${lines(input.delta.incorrect)}
### Unexpected
${lines(input.delta.unexpected)}
### Required changes
${lines(input.delta.required_changes)}

v${c.version} supersedes v${input.previousVersion} where they conflict.
Acceptance criteria that were NOT changed remain fully in effect.
Continue from your existing implementation and context. Do NOT restart the task from scratch.
After modifying, rerun relevant tests, verify acceptance criteria, and produce an updated Execution Report (fenced YAML).`;
}

/** Durable L2 context snapshot: compress context, do not lose state. */
export function buildExecutorCheckpoint(input: {
  taskId: string;
  originalRequest: string;
  expectedVersion: number;
  contract: AcceptanceContract;
  iteration: number;
  report: Record<string, unknown>;
  delta: Delta | null;
  gateSummary: string;
  lastVerdict?: string;
  projectContext?: ProjectMilestoneContext;
}): string {
  const c = input.contract;
  const files = Array.isArray(input.report.files_changed)
    ? (input.report.files_changed as Array<{ path?: string; purpose?: string }>).map((f) => `  - ${f.path ?? ""}${f.purpose ? ` — ${f.purpose}` : ""}`).join("\n")
    : "  (none)";
  const tests = (input.report.tests as { commands?: string[]; passed?: string[]; failed?: string[] }) ?? {};
  const lines = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  (none)");
  return `task:
  id: ${input.taskId}
  original_request: ${input.originalRequest.replace(/\n/g, " ")}
current_expected_version: ${input.expectedVersion}
project_context: ${input.projectContext ? `${input.projectContext.projectId}/${input.projectContext.milestoneId}` : "none"}
goal: ${c.goal}
acceptance_criteria:
${c.acceptance_criteria.map((x) => `  - ${x}`).join("\n")}
repository_understanding:
${lines(c.context ? [c.context] : [])}
implemented:
${lines(input.report.implementation)}
files_changed:
${files}
tests:
${lines((tests.commands ?? []).map((c2: string) => `${c2} → ${(tests.failed ?? []).includes(c2) ? "FAIL" : "PASS"}`))}
resolved_gaps:
  (see delta.matched)
open_gaps:
${lines(input.delta ? input.delta.missing.concat(input.delta.incorrect, input.delta.unexpected) : [])}
must_preserve:
${lines(input.delta ? input.delta.must_preserve : [])}
last_verdict: ${input.lastVerdict ?? "none"}
iteration: ${input.iteration}
gate_summary:
${input.gateSummary.split("\n").map((l) => `  ${l}`).join("\n")}
environment_findings:
${lines(input.report.unresolved)}
next_action:
  - continue from existing implementation; do not restart unless required`;
}

/** Recovery prompt for a NEW pane/session after L1 (live session) loss. */
export function buildRecoveryPrompt(input: {
  taskId: string;
  originalRequest: string;
  contract: AcceptanceContract;
  checkpoint: string;
  repoPath: string;
  delta: Delta | null;
  projectContext?: ProjectMilestoneContext;
}): string {
  const c = input.contract;
  const criteriaLines = c.acceptance_criteria.map((x, i) => `  ${i + 1}. ${x}`).join("\n");
  const outcomeLines = c.expected_outcome.map((x) => `  - ${x}`).join("\n");
  const lines = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  (none)");
  return `This is a RECOVERED execution session for an existing Dual-Gate task.

TASK ID: ${input.taskId}
REPOSITORY: ${input.repoPath}
${formatProjectContext(input.projectContext)}

## ORIGINAL USER REQUEST
${input.originalRequest}

## CURRENT EXPECTED OUTCOME (v${c.version}) — authoritative
${outcomeLines}

## ACCEPTANCE CRITERIA (authoritative)
${criteriaLines}

## EXECUTOR CHECKPOINT (durable state from the previous session)
${input.checkpoint}

## CURRENT DELTA (if any)
### Must preserve
${lines(input.delta ? input.delta.must_preserve : [])}
### Missing
${lines(input.delta ? input.delta.missing : [])}
### Incorrect
${lines(input.delta ? input.delta.incorrect : [])}
### Required changes
${lines(input.delta ? input.delta.required_changes : [])}

Continue the existing task. Do NOT restart implementation from scratch unless required.
Inspect the current repo state, apply the delta, rerun relevant tests, verify acceptance criteria, and produce an updated Execution Report (fenced YAML).`;
}

// ---------------------------------------------------------------------------
// Execution report parsing
// ---------------------------------------------------------------------------

/** Extract a fenced YAML block (```yaml ... ```) from an agent message. */
export function extractYamlBlock(text: string): string | null {
  const fence = /```(?:ya?ml)?\s*\n([\s\S]*?)\n```/i;
  const m = text.match(fence);
  return m ? m[1].trim() : null;
}

/** Minimal tolerant YAML-ish parser for the fixed report shape. */
export function parseTolerantYaml(text: string): Record<string, unknown> | null {
  if (!text || !text.trim()) return null;
  const lines = text.split(/\r?\n/);
  // Indentation-aware recursive descent parser tolerant of the shapes we emit.

  function scalar(v: string): unknown {
    const t = v.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null" || t === "~") return null;
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d+\.\d+$/.test(t)) return Number(t);
    const quoted = t.match(/^(["'])(.*)\1$/s);
    if (quoted) return quoted[2];
    return t;
  }

  /** Split a flow value on top-level commas (respecting brackets and quotes). */
  function splitFlow(s: string): string[] {
    const out: string[] = [];
    let depth = 0; let quote: string | null = null; let cur = "";
    for (const ch of s) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === "[" || ch === "{") { depth++; cur += ch; continue; }
      if (ch === "]" || ch === "}") { depth--; cur += ch; continue; }
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  /** Parse a YAML flow-style value: `[a, b, c]` or `{ k: v, k2: [x] }`. */
  function flowValue(s: string): unknown | undefined {
    const t = s.trim();
    if (t.startsWith("[") && t.endsWith("]")) {
      const inner = t.slice(1, -1).trim();
      if (!inner) return [];
      return splitFlow(inner).map((item) => {
        const v = item.trim();
        const q = v.match(/^(["'])(.*)\1$/s);
        return q ? q[2] : scalar(v);
      }).filter((v) => v !== "" && v !== undefined);
    }
    if (t.startsWith("{") && t.endsWith("}")) {
      const inner = t.slice(1, -1).trim();
      const out: Record<string, unknown> = {};
      if (!inner) return out;
      for (const part of splitFlow(inner)) {
        const kv = part.trim().match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
        if (kv) out[kv[1]] = flowValue(kv[2]) ?? scalar(kv[2]);
      }
      return out;
    }
    return undefined;
  }

  function indentOf(line: string): number {
    return line.length - line.trimStart().length;
  }

  function parseBlock(i: number, indent: number): { value: unknown; next: number } {
    const map: Record<string, unknown> = {};
    const list: unknown[] = [];
    let mode: "map" | "list" | null = null;
    let lastKey: string | null = null;

    // YAML permits a block sequence at the same indentation as its parent key
    // (e.g. `acceptance_criteria:` followed directly by `- item` at indent 0).
    // Parse such a run into an array and return the next line index.
    function parseSameIndentList(start: number, indentLevel: number): { value: unknown[]; next: number } {
      const out: unknown[] = [];
      let j = start;
      while (j < lines.length) {
        const line = lines[j];
        const trimmed = line.trim();
        const itemIndent = indentOf(line);
        if (!trimmed || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...") { j++; continue; }
        if (itemIndent !== indentLevel || !(trimmed.startsWith("- ") || trimmed === "-")) break;
        const itemText = trimmed === "-" ? "" : trimmed.slice(2).trim();
        if (itemText === "") {
          const child = parseBlock(j + 1, indentLevel + 2);
          out.push(child.value);
          j = child.next;
        } else {
          const header = itemText.match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
          if (header) {
            const key = header[1];
            const rest = header[2].trim();
            if (rest === "") {
              const obj: Record<string, unknown> = {};
              out.push(obj);
              if (j + 1 < lines.length && indentOf(lines[j + 1]) > indentLevel + 2) {
                const child = parseBlock(j + 1, indentOf(lines[j + 1]));
                Object.assign(obj, child.value as Record<string, unknown>);
                j = child.next;
              } else { j++; }
            } else {
              out.push({ [key]: flowValue(rest) ?? scalar(rest) });
              j++;
            }
          } else {
            out.push(scalar(itemText));
            j++;
          }
        }
      }
      return { value: out, next: j };
    }

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...") {
        i++;
        continue;
      }
      const ind = indentOf(line);
      if (ind < indent) break; // dedent
      if (ind > indent) {
        // Deeper content belongs to previous key/item.
        if (mode === "list" && list.length > 0) {
          const child = parseBlock(i, ind);
          const lastItem = list[list.length - 1];
          if (lastItem && typeof lastItem === "object" && !Array.isArray(lastItem)) {
            Object.assign(lastItem as Record<string, unknown>, child.value as Record<string, unknown>);
          } else {
            list.push(child.value);
          }
          i = child.next;
          continue;
        }
        if (mode === "map" && lastKey) {
          const child = parseBlock(i, ind);
          map[lastKey] = child.value;
          i = child.next;
          continue;
        }
        i++;
        continue;
      }

      if (trimmed.startsWith("- ") || trimmed === "-") {
        if (mode === null) {
          mode = "list";
        } else if (mode === "map" && lastKey && ind === indent) {
          // Block sequence at the same indent as the parent key.
          const same = parseSameIndentList(i, ind);
          map[lastKey] = same.value;
          i = same.next;
          continue;
        } else if (mode !== "list") {
          break;
        }
        const itemText = trimmed === "-" ? "" : trimmed.slice(2).trim();
        if (itemText === "") {
          const child = parseBlock(i + 1, ind + 2);
          list.push(child.value);
          i = child.next;
        } else {
          // item may be "- key: value" inline map, "- key:" map header, or scalar
          const header = itemText.match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
          if (header) {
            const key = header[1];
            const rest = header[2].trim();
            if (rest === "") {
              const obj: Record<string, unknown> = {};
              list.push(obj);
              if (i + 1 < lines.length && indentOf(lines[i + 1]) > ind + 2) {
                const child = parseBlock(i + 1, indentOf(lines[i + 1]));
                Object.assign(obj, child.value as Record<string, unknown>);
                i = child.next;
              } else {
                i++;
              }
            } else {
              list.push({ [key]: flowValue(rest) ?? scalar(rest) });
              i++;
            }
          } else {
            list.push(scalar(itemText));
            i++;
          }
        }
        continue;
      }

      const m = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
      if (!m) {
        if (mode === "map" && lastKey && typeof map[lastKey] === "string") {
          map[lastKey] = map[lastKey] + "\n" + trimmed;
          i++;
          continue;
        }
        i++;
        continue;
      }
      const key = m[1];
      const rest = m[2].trim();
      if (mode === null) mode = "map";
      else if (mode !== "map") break;

      if (rest === "") {
        if (i + 1 < lines.length && indentOf(lines[i + 1]) > ind) {
          const child = parseBlock(i + 1, indentOf(lines[i + 1]));
          map[key] = child.value;
          i = child.next;
        } else {
          map[key] = "";
          i++;
        }
      } else if (/^[|>][+-]?$/.test(rest)) {
        const block: string[] = [];
        i++;
        while (i < lines.length && indentOf(lines[i]) > ind) {
          block.push(lines[i].trim());
          i++;
        }
        // `>` folds newlines into spaces; `|` preserves them.
        map[key] = rest.startsWith(">") ? block.join(" ") : block.join("\n");
      } else if (rest === "[]") {
        map[key] = [];
        i++;
      } else {
        const flow = flowValue(rest);
        map[key] = flow ?? scalar(rest);
        i++;
      }
      lastKey = key;
    }
    return { value: mode === "list" ? list : map, next: i };
  }

  const result = parseBlock(0, indentOf(lines[0] ?? ""));
  const value = result.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Normalize a parsed report into an ExecutorReport shape with defaults. */
export function normalizeReport(raw: Record<string, unknown> | null): Record<string, unknown> {
  if (!raw) raw = {};
  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  // Models frequently write Python-style `None`, `N/A`, or empty placeholders
  // in list fields instead of an empty array. Treat those as absent so an
  // empty unresolved/deviations list does not block convergence.
  const clean = (v: unknown): string => {
    const s = str(v).trim().toLowerCase();
    return s === "none" || s === "null" || s === "n/a" || s === "-" || s === "[]" || s === "{}" || s === "" ? "" : str(v);
  };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [{ path: v, purpose: v }] : []);
  const strArr = (v: unknown): string[] => arr(v).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).map(clean).filter(Boolean);
  return {
    status: raw.status ?? "failed",
    summary: str(raw.summary),
    files_changed: arr(raw.files_changed),
    implementation: strArr(raw.implementation),
    tests: raw.tests && typeof raw.tests === "object" ? {
      commands: Array.isArray((raw.tests as any).commands) ? (raw.tests as any).commands.map(str) : [],
      passed: Array.isArray((raw.tests as any).passed) ? (raw.tests as any).passed.map(str) : [],
      failed: Array.isArray((raw.tests as any).failed) ? (raw.tests as any).failed.map(str) : [],
    } : { commands: [], passed: [], failed: [] },
    validation: raw.validation && typeof raw.validation === "object" ? {
      lint: (raw.validation as any).lint ?? "not_run",
      typecheck: (raw.validation as any).typecheck ?? "not_run",
      build: (raw.validation as any).build ?? "not_run",
    } : { lint: "not_run", typecheck: "not_run", build: "not_run" },
    acceptance_check: raw.acceptance_check && typeof raw.acceptance_check === "object" ? raw.acceptance_check : {},
    deviations: strArr(raw.deviations),
    unresolved: strArr(raw.unresolved),
    risks: strArr(raw.risks),
  };
}

export function extractReportFromAgentMessage(message: string): Record<string, unknown> {
  const block = extractYamlBlock(message);
  if (block) {
    const parsed = parseTolerantYaml(block);
    if (parsed) return normalizeReport(parsed);
  }
  const parsed = parseTolerantYaml(message);
  if (parsed && (parsed.status || parsed.files_changed)) return normalizeReport(parsed);
  return normalizeReport(null);
}

// ---------------------------------------------------------------------------
// Judge output parsing (closed-loop verdicts)
// ---------------------------------------------------------------------------

export function parseJudgeOutput(text: string): JudgeOutput | null {
  const block = extractYamlBlock(text);
  const parsed = block ? parseTolerantYaml(block) : null;
  // Artifacts store the Judge result as JSON, not YAML. The tolerant parser
  // cannot read that shape, so fall back to strict JSON before rejecting.
  let src = parsed ?? parseTolerantYaml(text);
  if (!src || !Object.keys(src).length) {
    try {
      const v = JSON.parse(text.trim());
      src = v && typeof v === "object" ? v as Record<string, unknown> : null;
    } catch { src = null; }
  }
  if (!src) return null;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : typeof v === "string" && v.trim() ? [v.trim()] : []);
  const verdict =
    src.verdict === "converged" || src.verdict === "implementation_gap" || src.verdict === "spec_gap" || src.verdict === "mixed_gap" || src.verdict === "blocked"
      ? src.verdict
      : null;
  if (!verdict) return null;
  const delta = (src.delta && typeof src.delta === "object" ? src.delta : {}) as Record<string, unknown>;
  const deltaArr = (k: string) => (Array.isArray(delta[k]) ? (delta[k] as unknown[]).map((x) => String(x)) : []);
  const specRev = src.spec_revision && typeof src.spec_revision === "object" ? (src.spec_revision as Record<string, unknown>) : undefined;
  return {
    verdict,
    confidence: src.confidence === "high" || src.confidence === "medium" || src.confidence === "low" ? src.confidence : "medium",
    expected: arr(src.expected),
    actual: arr(src.actual),
    matched: arr(src.matched),
    gaps: arr(src.gaps),
    implementation_changes: arr(src.implementation_changes),
    spec_changes: arr(src.spec_changes),
    spec_revision: specRev
      ? {
          version: typeof specRev.version === "number" ? specRev.version : 0,
          changed: Array.isArray(specRev.changed) ? (specRev.changed as unknown[]).map(String) : [],
          reason: Array.isArray(specRev.reason) ? (specRev.reason as unknown[]).map(String) : [],
          evidence: Array.isArray(specRev.evidence) ? (specRev.evidence as unknown[]).map(String) : [],
          user_intent_changed: specRev.user_intent_changed === true,
        }
      : undefined,
    delta: {
      matched: deltaArr("matched"),
      missing: deltaArr("missing"),
      incorrect: deltaArr("incorrect"),
      unexpected: deltaArr("unexpected"),
      required_changes: deltaArr("required_changes"),
      must_preserve: deltaArr("must_preserve"),
    },
    reason: typeof src.reason === "string" ? src.reason : "",
  };
}

export function parseContractYaml(text: string, originalRequest: string, version = 1): AcceptanceContract {
  const fence = /```(?:ya?ml)?\s*\n([\s\S]*?)\n```/i;
  const m = text.match(fence);
  const yaml = m ? m[1] : text;
  const parsed = parseTolerantYaml(yaml) as Record<string, any> | null;
  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : typeof v === "string" && v.trim() ? [v.trim()] : []);
  const riskLevel = parsed?.risk?.level === "high" || parsed?.risk?.level === "medium" ? parsed.risk.level : "low";
  return {
    version,
    task: { original_request: originalRequest },
    goal: str(parsed?.goal) || originalRequest.slice(0, 200),
    context: str(parsed?.context),
    architecture: { relevant_components: arr(parsed?.architecture?.relevant_components ?? parsed?.architecture) },
    constraints: arr(parsed?.constraints),
    expected_outcome: arr(parsed?.expected_outcome),
    acceptance_criteria: arr(parsed?.acceptance_criteria),
    validation: { required: arr(parsed?.validation?.required ?? parsed?.validation) },
    risk: { level: riskLevel, concerns: arr(parsed?.risk?.concerns) },
  };
}

export function buildProjectPlanPrompt(input: { sourceRequest: string; repoPath: string }): string {
  return `You are the Controller/Architect planning a multi-milestone project. Do not implement code. Produce ONLY a fenced YAML Project Plan for explicit user approval.\n\nREPOSITORY: ${input.repoPath}\nREQUEST: ${input.sourceRequest}\n\nThe plan must decompose the work into a serial dependency-ordered WBS. Every milestone needs a stable id, title, depends_on, nonempty scope.files or scope.components, expected_outcome, acceptance_criteria, validation.required, and risk. Project-level acceptance_criteria and validation.required are mandatory. Do not include reasoning.\n\n\`\`\`yaml\ngoal: ...\ncontext: ...\nconstraints:\n  - ...\nacceptance_criteria:\n  - ...\nvalidation:\n  required:\n    - ...\nmilestones:\n  - id: M1\n    title: ...\n    depends_on: []\n    scope:\n      files:\n        - ...\n      components:\n        - ...\n    expected_outcome:\n      - ...\n    acceptance_criteria:\n      - ...\n    validation:\n      required:\n        - ...\n    risk:\n      level: low|medium|high\n      concerns:\n        - ...\`\`\``;
}

function projectString(v: unknown): string { return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim(); }
function projectStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(projectString).filter(Boolean);
  if (typeof v !== "string" || !v.trim()) return [];
  const text = v.trim();
  if (/^\[[\s\S]*\]$/.test(text)) return text.slice(1, -1).split(",").map(projectString).filter(Boolean);
  return [text];
}
function projectRisk(v: unknown): "low" | "medium" | "high" { return v === "medium" || v === "high" ? v : "low"; }

export function validateProjectPlan(plan: ProjectPlan): string[] {
  const errors: string[] = [];
  if (!plan.goal.trim()) errors.push("project goal is required");
  if (!plan.acceptance_criteria.length) errors.push("project acceptance_criteria is required");
  if (!plan.validation.required.length) errors.push("project validation.required is required");
  if (!plan.milestones.length) errors.push("at least one milestone is required");
  const ids = new Set<string>();
  for (const m of plan.milestones) {
    if (!/^[A-Za-z0-9._-]+$/.test(m.id)) errors.push(`invalid milestone id: ${m.id || "(empty)"}`);
    if (ids.has(m.id)) errors.push(`duplicate milestone id: ${m.id}`);
    ids.add(m.id);
    if (!m.title.trim()) errors.push(`milestone ${m.id}: title is required`);
    if (!m.scope.files.length && !m.scope.components.length) errors.push(`milestone ${m.id}: scope is required`);
    if (!m.expected_outcome.length) errors.push(`milestone ${m.id}: expected_outcome is required`);
    if (!m.acceptance_criteria.length) errors.push(`milestone ${m.id}: acceptance_criteria is required`);
    if (!m.validation.required.length) errors.push(`milestone ${m.id}: validation.required is required`);
    for (const dep of m.depends_on) {
      if (dep === m.id) errors.push(`milestone ${m.id}: cannot depend on itself`);
      else if (!ids.has(dep) && !plan.milestones.some((candidate) => candidate.id === dep)) errors.push(`milestone ${m.id}: unknown dependency ${dep}`);
    }
  }
  if (!errors.length) {
    try { topologicallyOrderMilestones(plan.milestones); } catch (e) { errors.push(errString(e)); }
  }
  return errors;
}

function errString(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function parseProjectPlan(text: string): ProjectPlan {
  const block = extractYamlBlock(text);
  // PM IPC wraps the unchanged plan schema in correlation metadata; the plan
  // validator deliberately consumes the original schema, not a second schema.
  const yaml = (block ?? text).replace(/^(?:protocol_version|request_id|kind):[^\n]*\n/gm, "");
  const raw = parseTolerantYaml(yaml);
  if (!raw) throw new Error("Project plan is not valid YAML");
  const projectValidation = raw.validation && typeof raw.validation === "object" ? raw.validation as Record<string, unknown> : {};
  const milestonesRaw = Array.isArray(raw.milestones) ? raw.milestones : [];
  // A PM may degrade to a bare list of strings (no id/title/scope objects).
  // Fail safe: collapse into a single serial milestone whose scope/outcome is
  // the full list, preserving the research decision and project acceptance.
  if (milestonesRaw.length && milestonesRaw.every((v) => typeof v === "string")) {
    const items = milestonesRaw.map((s) => String(s));
    const goal = projectString(raw.goal) || "Project";
    milestonesRaw.length = 0;
    milestonesRaw.push({ id: "M1", title: goal.slice(0, 60) || "Project", depends_on: [], scope: items, expected_outcome: items, acceptance_criteria: items, validation: projectValidation.required ? { required: projectStrings(projectValidation.required) } : {} });
  }
  const milestones: Milestone[] = milestonesRaw.map((value) => {
    const m = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const scope = m.scope && typeof m.scope === "object" ? m.scope as Record<string, unknown> : {};
    const validation = m.validation && typeof m.validation === "object" ? m.validation as Record<string, unknown> : {};
    const risk = m.risk && typeof m.risk === "object" ? m.risk as Record<string, unknown> : {};
    // Accept concise WBS variants from a PM while normalizing them into the
    // executor's stricter milestone contract: a list-valued scope describes
    // components, deliverables are expected outcomes, and project validation
    // is inherited when the milestone omits an equivalent command list.
    const scopeItems = projectStrings(scope.components).concat(projectStrings(m.scope), projectStrings(m.tasks), projectStrings(m.work_items), projectStrings(m.objective), projectStrings(m.description), projectStrings(m.deliverables), projectStrings(m.done_when));
    const fileItems = projectStrings(scope.files).concat(projectStrings(m.files_touched), projectStrings(m.files));
    const outcome = projectStrings(m.expected_outcome ?? m.deliverables ?? m.tasks ?? m.work_items ?? m.objective ?? m.validation);
    const acceptance = projectStrings(m.acceptance_criteria ?? m.acceptance ?? m.completion_criteria ?? m.exit_criteria ?? m.done_when ?? m.deliverables ?? m.verification ?? m.validation);
    const milestoneValidation = projectStrings(m.validation?.required ?? (m.validation && typeof m.validation === "object" ? undefined : m.validation) ?? m.verification);
    const rawId = projectString(m.id ?? m.key);
    const rawName = projectString(m.title ?? m.name ?? rawId);
    // Some PMs omit `id` and reference milestones by name/title in depends_on.
    // Derive a stable slug id from the name when no explicit id is present.
    const id = rawId && /^[A-Za-z0-9._-]+$/.test(rawId) ? rawId.toUpperCase() : (rawName || "M").toUpperCase().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "M";
    // Keep the original raw name for depends_on resolution below.
    return { id, title: rawName, depends_on: projectStrings(m.depends_on ?? m.dependencies).map((dep) => dep.toUpperCase()), scope: { files: fileItems, components: scopeItems }, expected_outcome: outcome.length ? outcome : scopeItems, acceptance_criteria: acceptance.length ? acceptance : fileItems.length ? fileItems : scopeItems, validation: { required: milestoneValidation.length ? milestoneValidation : projectStrings(projectValidation.required) }, risk: { level: projectRisk(risk.level), concerns: projectStrings(risk.concerns) } };
  });
  // Resolve depends_on references that used milestone names/titles instead of
  // ids (models sometimes reference by display name): map each reference to
  // the id whose title/name normalizes to it, else keep as-is (validation will
  // report unknown refs). References may be quoted flow strings, slug ids, or
  // space-separated names — normalize both sides the same way.
  const idByTitle = new Map<string, string>();
  for (const m of milestones) {
    const norm = m.title.toUpperCase().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (norm) idByTitle.set(norm, m.id);
    idByTitle.set(m.id.toUpperCase().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""), m.id);
  }
  for (const m of milestones) {
    m.depends_on = m.depends_on.map((dep) => {
      const norm = dep.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
      return idByTitle.get(norm) ?? dep;
    });
  }
  const plan: ProjectPlan = { version: typeof raw.version === "number" ? raw.version : 1, goal: projectString(raw.goal), context: projectString(raw.context), constraints: projectStrings(raw.constraints), acceptance_criteria: projectStrings(raw.acceptance_criteria), validation: { required: projectStrings(projectValidation.required ?? raw.validation) }, milestones };
  // Market-research block is optional (legacy plans omit it).
  const researchRaw = raw.research && typeof raw.research === "object" ? raw.research as Record<string, unknown> : null;
  if (researchRaw) {
    const existing = Array.isArray(researchRaw.existing_solutions)
      ? researchRaw.existing_solutions.map((e) => {
          const o = e && typeof e === "object" ? e as Record<string, unknown> : {};
          return { name: projectString(o.name), url: projectString(o.url), assessment: projectString(o.assessment) };
        }).filter((e) => e.name)
      : [];
    const decision = researchRaw.decision === "reuse" || researchRaw.decision === "adapt" || researchRaw.decision === "build" || researchRaw.decision === "hybrid" ? researchRaw.decision : undefined;
    if (projectString(researchRaw.summary) || existing.length || decision) {
      plan.research = { summary: projectString(researchRaw.summary), existing_solutions: existing, decision: decision ?? "build", rationale: projectString(researchRaw.rationale) };
    }
  }
  const errors = validateProjectPlan(plan);
  if (errors.length) throw new Error(`Invalid project plan: ${errors.join("; ")}`);
  return plan;
}

/** Kahn ordering that preserves source/WBS order among independently eligible milestones. */
export function topologicallyOrderMilestones(milestones: Milestone[]): Milestone[] {
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const remaining = new Map(milestones.map((m) => [m.id, new Set(m.depends_on)]));
  const ordered: Milestone[] = [];
  while (remaining.size) {
    const next = milestones.find((m) => remaining.has(m.id) && [...(remaining.get(m.id) ?? [])].every((dep) => !remaining.has(dep)));
    if (!next) throw new Error("milestone dependency cycle detected");
    ordered.push(next);
    remaining.delete(next.id);
  }
  return ordered;
}

/**
 * Group an already dependency-ordered milestone list into parallel batches.
 * Every milestone in a batch has ALL of its dependencies in earlier batches
 * (never in the same batch), so batch members can safely run concurrently in
 * isolated worktrees. Batches preserve dependency order.
 */
export function scheduleMilestoneBatches(ordered: Milestone[]): Milestone[][] {
  const batches: Milestone[][] = [];
  const placed = new Set<string>();
  while (placed.size < ordered.length) {
    const batch = ordered.filter((m) => !placed.has(m.id) && m.depends_on.every((d) => placed.has(d.toUpperCase())));
    if (!batch.length) throw new Error("milestone dependency cycle detected during scheduling");
    for (const m of batch) placed.add(m.id);
    batches.push(batch);
  }
  return batches;
}

/** True when a batch has more than one member, so members can run concurrently. */
export function isParallelBatch(batch: Milestone[]): boolean {
  return batch.length > 1;
}

export function milestoneToAcceptanceContract(plan: ProjectPlan, milestone: Milestone, sourceRequest: string): AcceptanceContract {
  return { version: 1, task: { original_request: sourceRequest }, goal: milestone.title, context: [plan.context, `Project goal: ${plan.goal}`, `Milestone scope: ${[...milestone.scope.files, ...milestone.scope.components].join(", ")}`].filter(Boolean).join("\n"), architecture: { relevant_components: [...milestone.scope.files, ...milestone.scope.components] }, constraints: [...plan.constraints, `Stay within milestone ${milestone.id} scope and preserve dependencies: ${milestone.depends_on.join(", ") || "none"}.`], expected_outcome: milestone.expected_outcome, acceptance_criteria: milestone.acceptance_criteria, validation: { required: milestone.validation.required }, risk: milestone.risk };
}

/** Read-only PM process arguments. Exported here to keep launch policy unit-testable. */
export function productManagerPiArgs(model: string, writeGuardExtensionPath: string, searchExtensionPath: string): string[] {
  // PM may write only its response artifacts (guarded) and research the web
  // (read-only pm_search); no shell/edit tools are granted.
  const args = ["--no-extensions", "--tools", "read,grep,find,ls,write,pm_search", "--extension", writeGuardExtensionPath, "--extension", searchExtensionPath];
  if (model && model !== "default") args.unshift("--model", model);
  return args;
}

/** Select the latest validated fenced response correlated with this IPC request. */
export function extractCorrelatedYamlBlock(text: string, requestId: string, expectedKind?: "plan" | "milestone_feedback" | "final_acceptance"): string | null {
  const fence = /```(?:ya?ml)?\s*\n([\s\S]*?)\n```/gi;
  let latest: string | null = null;
  for (const match of text.matchAll(fence)) {
    const parsed = parseTolerantYaml(match[1]);
    if (parsed && parsed.protocol_version === 1 && parsed.request_id === requestId && (!expectedKind || parsed.kind === expectedKind)) latest = match[1];
  }
  return latest;
}

export function buildProductManagerPlanPrompt(input: { sourceRequest: string; repoPath: string; requestId: string; responsePath: string }): string {
  return `You are the Product Manager for a Dual-Gate project. Produce a WBS only; never implement, edit, create, delete, or propose direct source edits. You may write exactly one response artifact at RESPONSE PATH; an enforced tool guard blocks every write outside the Product Manager artifact directory. You have a read-only pm_search web-search tool for market research.

REPOSITORY: ${input.repoPath}
REQUEST: ${input.sourceRequest}
RESPONSE PATH: ${input.responsePath}

## MANDATORY: market research first
Before writing the plan, use pm_search (1-3 targeted queries) to check whether this has already been solved:
1. Is there an existing open-source project/library that covers most of the request? (search GitHub/npm keywords)
2. Are there prior comparable products or implementations we can learn from or adapt?
3. What is the reuse-vs-build decision and why?
Then incorporate a research block into your plan with: summary, existing_solutions (name/url/assessment), decision (reuse|adapt|build|hybrid), rationale. The WBS milestones must reflect the decision: prefer adapting existing work over building from zero when a mature option exists.

Write exactly one YAML document to RESPONSE PATH, then reply briefly that it was written. The YAML MUST include protocol_version: 1, request_id: ${input.requestId}, kind: plan, followed by the complete Project Plan schema below, plus the research block. Every milestone must be dependency ordered and scoped. Use only simple one-line scalars and YAML lists: never use folded/literal block scalars (greater-than or pipe style), anchors, or multi-line values.

\`\`\`yaml
protocol_version: 1
request_id: <the request_id above>
kind: plan
goal: ...
context: ...
constraints: [...]
acceptance_criteria: [...]
validation: { required: [...] }
research:
  summary: ...
  existing_solutions:
    - name: ...
      url: ...
      assessment: ...
  decision: reuse|adapt|build|hybrid
  rationale: ...
milestones: [...]
\`\`\``;
}

export function buildMilestoneCompletionFeedbackPrompt(input: ProjectMilestoneFeedback & { response_path: string }): string {
  return `You are the Product Manager. Record the product consequence of this completed milestone; never edit source files. You may write exactly one YAML response to RESPONSE PATH; an enforced guard blocks every other write. REQUEST ID: ${input.request_id}. RESPONSE PATH: ${input.response_path}. Write the YAML there, then reply briefly that it was written.\n\nCOMPLETION HANDOFF:\n${JSON.stringify(input, null, 2)}\n\n\`\`\`yaml\nprotocol_version: 1\nrequest_id: <the request_id above>\nkind: milestone_feedback\nmilestone_id: <the milestone_id from the handoff>\ntask_id: <the task_id from the handoff>\ndecision: acknowledged|blocked\nsummary: ...\nunresolved: []\ndeviations: []\nreason: ...\n\`\`\``;
}

export function buildProductAcceptancePrompt(input: { requestId: string; responsePath: string; plan: ProjectPlan; milestones: unknown[]; diff: string; gateSummary: string }): string {
  return `You are the Product Manager issuing the mandatory product-level acceptance input. Never edit source files. You may write exactly one YAML response to RESPONSE PATH; an enforced guard blocks every other write. Verify the approved WBS, all durable milestone outcomes, final gate, and aggregate diff. REQUEST ID: ${input.requestId}. RESPONSE PATH: ${input.responsePath}. Write the YAML there, then reply briefly that it was written.\n\nPROJECT PLAN:\n${JSON.stringify(input.plan, null, 2)}\n\nMILESTONES:\n${JSON.stringify(input.milestones, null, 2)}\n\nFINAL GATE:\n${input.gateSummary}\n\nAGGREGATE DIFF:\n${input.diff.slice(0, 30000)}\n\n\`\`\`yaml\nprotocol_version: 1\nrequest_id: <the request_id above>\nkind: final_acceptance\nverdict: accepted|gaps|blocked\nsummary: ...\nsatisfied: []\ngaps: []\nunresolved: []\nreason: ...\n\`\`\``;
}

export function buildProductManagerRecoveryPrompt(input: { projectId: string; requestId: string; responsePath: string; outstandingRequest: unknown; persistedPlan?: unknown; persistedFeedback?: unknown[] }): string {
  return `You are a recovered Product Manager for project ${input.projectId}. Never edit source files. Reissue exactly one response for outstanding request ID ${input.requestId} at RESPONSE PATH ${input.responsePath}; do not invent a new request ID. The enforced guard permits writes only inside your artifact directory.\n\nPERSISTED PLAN:\n${JSON.stringify(input.persistedPlan ?? null, null, 2)}\n\nPERSISTED FEEDBACK:\n${JSON.stringify(input.persistedFeedback ?? [], null, 2)}\n\nOUTSTANDING REQUEST:\n${JSON.stringify(input.outstandingRequest, null, 2)}`;
}

export function parseProductMilestoneFeedback(text: string, requestId: string): ProjectMilestoneFeedback | null {
  const block = extractCorrelatedYamlBlock(text, requestId) ?? text;
  const raw = parseTolerantYaml(block);
  if (!raw || raw.kind !== "milestone_feedback" || raw.protocol_version !== 1 || raw.request_id !== requestId) return null;
  if (raw.decision !== "acknowledged" && raw.decision !== "blocked") return null;
  const milestone_id = projectString(raw.milestone_id);
  const task_id = projectString(raw.task_id);
  const summary = projectString(raw.summary);
  const reason = projectString(raw.reason);
  if (!milestone_id || !task_id || !summary || !reason || !Array.isArray(raw.unresolved) || !Array.isArray(raw.deviations)) return null;
  return { protocol_version: 1, request_id: requestId, kind: "milestone_feedback", milestone_id, task_id, executor_summary: "", judge: { verdict: "converged", gaps: [] }, gate_summary: "", unresolved: projectStrings(raw.unresolved), deviations: projectStrings(raw.deviations), decision: raw.decision, summary, reason };
}

export function buildProjectAcceptancePrompt(input: { plan: ProjectPlan; milestones: Array<{ milestoneId: string; title: string; summary: string; verdict: string; unresolved: string[]; deviations: string[] }>; diff: string; gateSummary: string; productAcceptance: ProjectAcceptance }): string {
  return `You are the Controller performing final ratification, not product acceptance. The Product Manager verdict below is authoritative product input. NEVER return accepted when it is gaps or blocked, or it contains gaps/unresolved. Independently enforce the final Gate and every milestone's convergence; PM acceptance alone never bypasses Controller, Gate, or Judge. Output ONLY fenced YAML.\n\nPRODUCT MANAGER ACCEPTANCE:\n${JSON.stringify(input.productAcceptance, null, 2)}\n\nPROJECT PLAN:\n${JSON.stringify(input.plan, null, 2)}\n\nMILESTONE RESULTS:\n${JSON.stringify(input.milestones, null, 2)}\n\nFINAL GATE:\n${input.gateSummary}\n\nAGGREGATE DIFF:\n${input.diff.slice(0, 30000)}\n\n\`\`\`yaml\nverdict: accepted|gaps|blocked\nsummary: ...\nsatisfied:\n  - ...\ngaps:\n  - ...\nunresolved:\n  - ...\nreason: ...\n\`\`\``;
}

export function parseProjectAcceptance(text: string, requestId?: string): ProjectAcceptance | null {
  // A pure-YAML artifact (PM wrote the response file directly) may still carry
  // the prompt's example fenced block as a tail. Prefer parsing the whole text
  // as YAML first (validating correlation); fall back to the correlated fence.
  const candidates: Array<string | null> = [text, requestId ? extractCorrelatedYamlBlock(text, requestId) : extractYamlBlock(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const raw = parseTolerantYaml(candidate);
    if (!raw || (requestId && (raw.protocol_version !== 1 || raw.request_id !== requestId || raw.kind !== "final_acceptance")) || (raw.verdict !== "accepted" && raw.verdict !== "gaps" && raw.verdict !== "blocked")) continue;
    const summary = projectString(raw.summary);
    const reason = projectString(raw.reason);
    if (!summary || !reason || !Array.isArray(raw.satisfied) || !Array.isArray(raw.gaps) || !Array.isArray(raw.unresolved)) continue;
    return { verdict: raw.verdict, summary, satisfied: projectStrings(raw.satisfied), gaps: projectStrings(raw.gaps), unresolved: projectStrings(raw.unresolved), reason };
  }
  return null;
}

export function isActiveProjectState(status: ProjectState): boolean {
  return status === "PLANNING" || status === "AWAITING_APPROVAL" || status === "RUNNING" || status === "ACCEPTING";
}

export function isProjectFinalizationStopped(status: ProjectState, stopRequested: boolean): boolean {
  return status === "CANCELLED" || stopRequested;
}

export function canAcceptProject(input: { orderedMilestoneIds: string[]; milestones: ProjectRecord["milestones"]; finalGatePassed: boolean; productAcceptance: ProjectAcceptance | null; acceptance: ProjectAcceptance | null }): boolean {
  const acceptedAndClear = (value: ProjectAcceptance | null) => !!value && value.verdict === "accepted" && !value.gaps.length && !value.unresolved.length;
  // A milestone counts as accepted when it CONVERGED with a converged Judge
  // verdict. Executor `unresolved` notes are retained for audit but do not
  // independently block acceptance (the Judge already weighed them).
  return acceptedAndClear(input.productAcceptance) && acceptedAndClear(input.acceptance) && input.finalGatePassed && input.orderedMilestoneIds.every((id) => { const m = input.milestones[id]; return m?.status === "CONVERGED" && m.verdict === "converged"; });
}

export function parseConvergenceDiagnosis(text: string): ConvergenceDiagnosis | null {
  const block = extractYamlBlock(text);
  const parsed = block ? parseTolerantYaml(block) : null;
  const src = parsed ?? parseTolerantYaml(text);
  if (!src) return null;
  const assessment = src.assessment === "continue" || src.assessment === "architecture" || src.assessment === "spec" || src.assessment === "executor" || src.assessment === "user" ? src.assessment : null;
  if (!assessment) return null;
  return {
    assessment,
    gap_trend: src.gap_trend === "improving" || src.gap_trend === "stalled" || src.gap_trend === "worsening" ? src.gap_trend : "stalled",
    recommendation: typeof src.recommendation === "string" ? src.recommendation : "",
    continue_value: src.continue_value === "high" || src.continue_value === "medium" || src.continue_value === "low" ? src.continue_value : "low",
  };
}

export function parseSpecRevision(text: string, originalRequest: string, version: number): { contract: AcceptanceContract; revision: SpecRevision } | null {
  const block = extractYamlBlock(text);
  const parsed = block ? parseTolerantYaml(block) : parseTolerantYaml(text);
  if (!parsed) return null;
  const contractBase = parseContractYaml(text, originalRequest, version);
  const rev = (parsed.spec_revision && typeof parsed.spec_revision === "object" ? parsed.spec_revision : {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  const revision: SpecRevision = {
    version: typeof rev.version === "number" ? rev.version : version,
    changed: arr(rev.changed),
    reason: arr(rev.reason),
    evidence: arr(rev.evidence),
    user_intent_changed: rev.user_intent_changed === true,
  };
  const contract: AcceptanceContract = { ...contractBase, version: revision.version };
  return { contract, revision };
}

// ---------------------------------------------------------------------------
// Risk detection
// ---------------------------------------------------------------------------

const HIGH_RISK_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(sudo|su\s+-)\b/i, label: "sudo/privilege escalation" },
  { re: /\b(systemctl|systemd|\/etc\/|\/var\/|\/usr\/|\/opt\/)\b/i, label: "system configuration" },
  { re: /\b(iptables|ufw|firewall|nftables|netfilter)\b/i, label: "network/firewall" },
  { re: /\b(dd\s|mkfs\.|fdisk|parted|\/dev\/)\b/i, label: "disk operations" },
  { re: /\b(ssh-keygen|chmod\s+[0-7]{3}|passwd|htpasswd|\/\.ssh\/)\b/i, label: "authentication material" },
  { re: /\b(terraform\s+apply|helm\s+upgrade|kubectl\s+apply|docker\s+(deploy|stack\s+deploy))\b/i, label: "production deployment" },
  { re: /\b(ALTER\s+TABLE|DROP\s+(TABLE|DATABASE|COLUMN)|TRUNCATE|DELETE\s+FROM|migration\s+(run|apply)|prisma\s+migrate\s+deploy)\b/i, label: "database migration" },
  { re: /\b(encrypt|decrypt|cipher|secret|token|api[-_]?key|password|credential)\b/i, label: "security-sensitive code" },
  { re: /\b(git\s+(push\s+--force|reset\s+--hard|clean\s+-[fxd]|rebase|filter-branch)|force[-_ ]?push)\b/i, label: "destructive git operations" },
  { re: /\b(rm\s+-rf|rm\s+-r\s+\/\s|shutdown|reboot|halt)\b/i, label: "destructive filesystem" },
];

export function detectRisk(request: string): { level: "low" | "medium" | "high"; concerns: string[] } {
  const concerns = HIGH_RISK_PATTERNS.filter((p) => p.re.test(request)).map((p) => p.label);
  if (concerns.length >= 2) return { level: "high", concerns };
  if (concerns.length === 1) return { level: "medium", concerns };
  return { level: "low", concerns: [] };
}
