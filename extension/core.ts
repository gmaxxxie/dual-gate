// =============================================================================
// Dual-Gate Orchestrator — core orchestration logic (pure, testable)
//
// The extension glue (dual-gate.ts) provides the Pi UI + Herdr transport; this
// module contains the closed-loop state machine (Expected ↔ Actual), task
// lifecycle, model resolution, configuration, prompt building, and artifact
// versioning. All of it is side-effect free except explicit artifact writes
// injected via an ArtifactStore interface.
// =============================================================================

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
    const taskId = generateTaskId();
    const artifactDir = taskDirFor(this.cwd, taskId);
    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId,
      repoPath: normalizeRepoPath(this.cwd),
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
  return `\n## PROJECT / MILESTONE CONTEXT (authoritative boundary)\nPROJECT: ${context.projectId} — ${context.projectGoal}\nMILESTONE: ${context.milestoneId} — ${context.milestoneTitle}\nDEPENDENCIES: ${context.dependsOn.join(", ") || "none"}\nSCOPE: ${scope}\nCOMPLETED MILESTONES:\n${prior}\nDo not regress completed milestones or work outside this milestone scope.`;
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

  function indentOf(line: string): number {
    return line.length - line.trimStart().length;
  }

  function parseBlock(i: number, indent: number): { value: unknown; next: number } {
    const map: Record<string, unknown> = {};
    const list: unknown[] = [];
    let mode: "map" | "list" | null = null;
    let lastKey: string | null = null;

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
        if (mode === null) mode = "list";
        else if (mode !== "list") break;
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
              list.push({ [key]: scalar(rest) });
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
      } else if (rest === "|" || rest === ">") {
        const block: string[] = [];
        i++;
        while (i < lines.length && indentOf(lines[i]) > ind) {
          block.push(lines[i].trim());
          i++;
        }
        map[key] = block.join("\n");
      } else if (rest === "[]") {
        map[key] = [];
        i++;
      } else {
        map[key] = scalar(rest);
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
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [{ path: v, purpose: v }] : []);
  return {
    status: raw.status ?? "failed",
    summary: str(raw.summary),
    files_changed: arr(raw.files_changed),
    implementation: Array.isArray(raw.implementation) ? raw.implementation.map(str) : [],
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
    deviations: arr(raw.deviations),
    unresolved: arr(raw.unresolved),
    risks: arr(raw.risks),
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
  const src = parsed ?? parseTolerantYaml(text);
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
  const milestonesRaw = Array.isArray(raw.milestones) ? raw.milestones : [];
  const milestones: Milestone[] = milestonesRaw.map((value) => {
    const m = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const scope = m.scope && typeof m.scope === "object" ? m.scope as Record<string, unknown> : {};
    const validation = m.validation && typeof m.validation === "object" ? m.validation as Record<string, unknown> : {};
    const risk = m.risk && typeof m.risk === "object" ? m.risk as Record<string, unknown> : {};
    return { id: projectString(m.id), title: projectString(m.title), depends_on: projectStrings(m.depends_on), scope: { files: projectStrings(scope.files), components: projectStrings(scope.components) }, expected_outcome: projectStrings(m.expected_outcome), acceptance_criteria: projectStrings(m.acceptance_criteria), validation: { required: projectStrings(validation.required ?? m.validation) }, risk: { level: projectRisk(risk.level), concerns: projectStrings(risk.concerns) } };
  });
  const validation = raw.validation && typeof raw.validation === "object" ? raw.validation as Record<string, unknown> : {};
  const plan: ProjectPlan = { version: typeof raw.version === "number" ? raw.version : 1, goal: projectString(raw.goal), context: projectString(raw.context), constraints: projectStrings(raw.constraints), acceptance_criteria: projectStrings(raw.acceptance_criteria), validation: { required: projectStrings(validation.required ?? raw.validation) }, milestones };
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

export function milestoneToAcceptanceContract(plan: ProjectPlan, milestone: Milestone, sourceRequest: string): AcceptanceContract {
  return { version: 1, task: { original_request: sourceRequest }, goal: milestone.title, context: [plan.context, `Project goal: ${plan.goal}`, `Milestone scope: ${[...milestone.scope.files, ...milestone.scope.components].join(", ")}`].filter(Boolean).join("\n"), architecture: { relevant_components: [...milestone.scope.files, ...milestone.scope.components] }, constraints: [...plan.constraints, `Stay within milestone ${milestone.id} scope and preserve dependencies: ${milestone.depends_on.join(", ") || "none"}.`], expected_outcome: milestone.expected_outcome, acceptance_criteria: milestone.acceptance_criteria, validation: { required: milestone.validation.required }, risk: milestone.risk };
}

/** Read-only PM process arguments. Exported here to keep launch policy unit-testable. */
export function productManagerPiArgs(model: string): string[] {
  const args = ["--no-extensions", "--tools", "read,grep,find,ls"];
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

export function buildProductManagerPlanPrompt(input: { sourceRequest: string; repoPath: string; requestId: string }): string {
  return `You are the read-only Product Manager for a Dual-Gate project. Produce a WBS only; never implement, edit, create, delete, or propose direct source edits. Your response is captured by the main Pi, which is the only writer of durable artifacts. Do not use any write-capable action.\n\nREPOSITORY: ${input.repoPath}\nREQUEST: ${input.sourceRequest}\n\nReturn ONLY one fenced YAML response. It MUST include protocol_version: 1, request_id: ${input.requestId}, kind: plan, followed by the complete Project Plan schema below. Every milestone must be dependency ordered and scoped.\n\n\`\`\`yaml\nprotocol_version: 1\nrequest_id: <the request_id above>\nkind: plan\ngoal: ...\ncontext: ...\nconstraints: [...]\nacceptance_criteria: [...]\nvalidation: { required: [...] }\nmilestones: [...]\n\`\`\``;
}

export function buildMilestoneCompletionFeedbackPrompt(input: ProjectMilestoneFeedback): string {
  return `You are the read-only Product Manager. Record the product consequence of this completed milestone; do not edit source files or write artifacts. The main Pi persists this transcript. REQUEST ID: ${input.request_id}. Return ONLY the correlated fenced YAML response.\n\nCOMPLETION HANDOFF:\n${JSON.stringify(input, null, 2)}\n\n\`\`\`yaml\nprotocol_version: 1\nrequest_id: <the request_id above>\nkind: milestone_feedback\nmilestone_id: <the milestone_id from the handoff>\ntask_id: <the task_id from the handoff>\ndecision: acknowledged|blocked\nsummary: ...\nunresolved: []\ndeviations: []\nreason: ...\n\`\`\``;
}

export function buildProductAcceptancePrompt(input: { requestId: string; plan: ProjectPlan; milestones: unknown[]; diff: string; gateSummary: string }): string {
  return `You are the read-only Product Manager issuing the mandatory product-level acceptance input. Do not edit source files or write artifacts. Verify the approved WBS, all durable milestone outcomes, final gate, and aggregate diff. REQUEST ID: ${input.requestId}. Return ONLY the correlated fenced YAML response.\n\nPROJECT PLAN:\n${JSON.stringify(input.plan, null, 2)}\n\nMILESTONES:\n${JSON.stringify(input.milestones, null, 2)}\n\nFINAL GATE:\n${input.gateSummary}\n\nAGGREGATE DIFF:\n${input.diff.slice(0, 30000)}\n\n\`\`\`yaml\nprotocol_version: 1\nrequest_id: <the request_id above>\nkind: final_acceptance\nverdict: accepted|gaps|blocked\nsummary: ...\nsatisfied: []\ngaps: []\nunresolved: []\nreason: ...\n\`\`\``;
}

export function buildProductManagerRecoveryPrompt(input: { projectId: string; requestId: string; outstandingRequest: unknown; persistedPlan?: unknown; persistedFeedback?: unknown[] }): string {
  return `You are a recovered read-only Product Manager for project ${input.projectId}. Do not edit source files and do not write any artifact; the main Pi owns persistence. Reissue exactly one response for the outstanding request ID ${input.requestId}; do not invent a new request ID.\n\nPERSISTED PLAN:\n${JSON.stringify(input.persistedPlan ?? null, null, 2)}\n\nPERSISTED FEEDBACK:\n${JSON.stringify(input.persistedFeedback ?? [], null, 2)}\n\nOUTSTANDING REQUEST:\n${JSON.stringify(input.outstandingRequest, null, 2)}`;
}

export function parseProductMilestoneFeedback(text: string, requestId: string): ProjectMilestoneFeedback | null {
  const block = extractCorrelatedYamlBlock(text, requestId);
  const raw = block ? parseTolerantYaml(block) : null;
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
  const block = requestId ? extractCorrelatedYamlBlock(text, requestId) : extractYamlBlock(text);
  const raw = parseTolerantYaml(block ?? text);
  if (!raw || (requestId && (raw.protocol_version !== 1 || raw.request_id !== requestId || raw.kind !== "final_acceptance")) || (raw.verdict !== "accepted" && raw.verdict !== "gaps" && raw.verdict !== "blocked")) return null;
  const summary = projectString(raw.summary);
  const reason = projectString(raw.reason);
  if (!summary || !reason || !Array.isArray(raw.satisfied) || !Array.isArray(raw.gaps) || !Array.isArray(raw.unresolved)) return null;
  return { verdict: raw.verdict, summary, satisfied: projectStrings(raw.satisfied), gaps: projectStrings(raw.gaps), unresolved: projectStrings(raw.unresolved), reason };
}

export function isActiveProjectState(status: ProjectState): boolean {
  return status === "PLANNING" || status === "AWAITING_APPROVAL" || status === "RUNNING" || status === "ACCEPTING";
}

export function isProjectFinalizationStopped(status: ProjectState, stopRequested: boolean): boolean {
  return status === "CANCELLED" || stopRequested;
}

export function canAcceptProject(input: { orderedMilestoneIds: string[]; milestones: ProjectRecord["milestones"]; finalGatePassed: boolean; productAcceptance: ProjectAcceptance | null; acceptance: ProjectAcceptance | null }): boolean {
  const acceptedAndClear = (value: ProjectAcceptance | null) => !!value && value.verdict === "accepted" && !value.gaps.length && !value.unresolved.length;
  return acceptedAndClear(input.productAcceptance) && acceptedAndClear(input.acceptance) && input.finalGatePassed && input.orderedMilestoneIds.every((id) => { const m = input.milestones[id]; return m?.status === "CONVERGED" && m.verdict === "converged" && !(m.unresolved?.length); });
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
