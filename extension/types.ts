// =============================================================================
// Dual-Gate Orchestrator — shared types (Expected ↔ Actual closed-loop)
// =============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type RiskLevel = "low" | "medium" | "high";
export type TaskState =
  | "IDLE"
  | "PLANNING"
  | "SPAWNING_EXECUTOR"
  | "EXECUTING"
  | "GATING"
  | "FIXING_GATE"
  | "JUDGING"
  | "FIXING_IMPLEMENTATION"
  | "REVISING_SPEC"
  | "DIAGNOSING"
  | "PAUSED"
  | "DONE"
  | "FAILED"
  | "CANCELLED"
  | "ESCALATED"
  | "WAITING_PERMISSION";

export type JudgeVerdict = "converged" | "implementation_gap" | "spec_gap" | "mixed_gap" | "blocked";
export type ProgressTrend = "improving" | "stalled" | "worsening";

export interface ModelRef {
  provider: string;
  id: string;
  /** Display name, from the registry when available. */
  name: string;
}

export interface DgConfig {
  enabled: boolean;
  controller: { model: string; thinking: ThinkingLevel };
  executor: { model: string };
  /** Project-only, read-only PM pane. `default` follows the parent Pi model. */
  product_manager: { model: string };
  runtime: { herdr: "required" };
  gate: { enabled: boolean; max_retries: number; timeoutMs: number };
  judge: { max_retries: number };
  loop: { max_iterations: number };
  panel: { direction: "right" | "down"; ratio: number; on_complete: "keep" | "close" };
  worktree: { mode: "auto" | "current" | "isolated" };
  context: { send_full_executor_history_to_judge: boolean };
  ui: { show_widget: boolean };
}

export interface AcceptanceContract {
  version: number;
  task: { original_request: string };
  goal: string;
  context: string;
  architecture: { relevant_components: string[] };
  constraints: string[];
  expected_outcome: string[];
  acceptance_criteria: string[];
  validation: { required: string[] };
  risk: { level: RiskLevel; concerns: string[] };
}

export interface Delta {
  matched: string[];
  missing: string[];
  incorrect: string[];
  unexpected: string[];
  required_changes: string[];
  must_preserve: string[];
}

export interface SpecRevision {
  version: number;
  changed: string[];
  reason: string[];
  evidence: string[];
  user_intent_changed: boolean;
}

export interface JudgeOutput {
  verdict: JudgeVerdict;
  confidence: "high" | "medium" | "low";
  expected: string[];
  actual: string[];
  matched: string[];
  gaps: string[];
  implementation_changes: string[];
  spec_changes: string[];
  spec_revision?: SpecRevision;
  delta: Delta;
  reason: string;
}

export interface SpecRevisionResult {
  contract: AcceptanceContract;
  revision: SpecRevision;
  implementation_changes: string[];
  delta: Delta;
}

export interface ConvergenceDiagnosis {
  assessment: "continue" | "architecture" | "spec" | "executor" | "user";
  gap_trend: ProgressTrend;
  recommendation: string;
  continue_value: "high" | "medium" | "low";
}

export interface ExecutorReport {
  status: "completed" | "blocked" | "failed";
  summary: string;
  files_changed: Array<{ path: string; purpose: string }>;
  implementation: string[];
  tests: { commands: string[]; passed: string[]; failed: string[] };
  validation: { lint: "pass" | "fail" | "not_run"; typecheck: "pass" | "fail" | "not_run"; build: "pass" | "fail" | "not_run" };
  acceptance_check: Record<string, "pass" | "fail">;
  deviations: string[];
  unresolved: string[];
  risks: string[];
}

export interface GateStep {
  name: string;
  command: string;
  passed: boolean;
  skipped: boolean;
  exitCode: number | null;
  outputTail: string;
  durationMs: number;
}

export type ProjectState = "PLANNING" | "AWAITING_APPROVAL" | "RUNNING" | "ACCEPTING" | "ACCEPTED" | "REJECTED" | "BLOCKED" | "FAILED" | "CANCELLED";
export type ProjectAcceptanceVerdict = "accepted" | "gaps" | "blocked";

export interface Milestone {
  id: string;
  title: string;
  depends_on: string[];
  scope: { files: string[]; components: string[] };
  expected_outcome: string[];
  acceptance_criteria: string[];
  validation: { required: string[] };
  risk: { level: RiskLevel; concerns: string[] };
}

export interface ProjectPlan {
  version: number;
  goal: string;
  context: string;
  constraints: string[];
  acceptance_criteria: string[];
  validation: { required: string[] };
  milestones: Milestone[];
}

export interface ProjectMilestoneContext {
  projectId: string;
  projectGoal: string;
  milestoneId: string;
  milestoneTitle: string;
  scope: Milestone["scope"];
  dependsOn: string[];
  completedSummaries: Array<{ milestoneId: string; title: string; summary: string; verdict: JudgeVerdict }>;
}

export interface ProjectMilestoneRecord {
  title?: string;
  status: "PENDING" | "RUNNING" | "CONVERGED" | "BLOCKED" | "FAILED" | "CANCELLED";
  taskId?: string;
  taskArtifactDir?: string;
  summary?: string;
  verdict?: JudgeVerdict;
  unresolved?: string[];
  deviations?: string[];
  completedAt?: string;
}

export type ProductManagerState = "STARTING" | "ACTIVE" | "WAITING" | "RECOVERING" | "FAILED" | "CANCELLED" | "DONE";

export interface ProductManagerRecord {
  model: string;
  paneId?: string;
  agentName?: string;
  state: ProductManagerState;
  recoveryCount: number;
  lastRequestId?: string;
  lastRequestKind?: "plan" | "milestone_feedback" | "final_acceptance";
  error?: string;
}

/** Durable PM handoff input and response decision for one converged milestone. */
export interface ProjectMilestoneFeedback {
  protocol_version: 1;
  request_id: string;
  kind: "milestone_feedback";
  milestone_id: string;
  task_id: string;
  executor_summary: string;
  judge: { verdict: JudgeVerdict; gaps: string[] };
  gate_summary: string;
  unresolved: string[];
  deviations: string[];
  artifact_refs?: { taskArtifactDir: string; milestoneArtifactDir: string };
  decision?: "acknowledged" | "blocked";
  summary?: string;
  reason?: string;
}

export interface ProjectRecord {
  projectId: string;
  sourceRequest: string;
  repoPath: string;
  artifactDir: string;
  status: ProjectState;
  orderedMilestoneIds: string[];
  currentMilestoneId?: string;
  milestones: Record<string, ProjectMilestoneRecord>;
  createdAt: string;
  updatedAt: string;
  /** Persistent PM session for this project; absent in legacy project artifacts. */
  productManager?: ProductManagerRecord;
  /** Mandatory product-level verdict from the PM. */
  productAcceptance?: ProjectAcceptance;
  /** Controller ratification/result retained for Stage-1 artifact compatibility. */
  finalAcceptance?: ProjectAcceptanceVerdict;
  error?: string;
}

export interface ProjectAcceptance {
  verdict: ProjectAcceptanceVerdict;
  summary: string;
  satisfied: string[];
  gaps: string[];
  unresolved: string[];
  reason: string;
}

export interface TaskRecord {
  taskId: string;
  repoPath: string;
  state: TaskState;
  originalRequest: string;
  controllerModel: string;
  executorModel: string;
  herdrPanelId: string | null;
  herdrAgentName: string | null;
  worktreePath: string | null;
  panelCreated: boolean;
  gateFailures: number;
  judgeFailures: number;
  iteration: number;
  expectedVersion: number;
  gapCount: number;
  previousGapCount: number;
  progress: ProgressTrend;
  sameGapStreak: number;
  executorStuck: boolean;
  specRevisions: number;
  currentStage: string;
  artifactDir: string;
  createdAt: string;
  updatedAt: string;
  bypassNext: boolean;
  risk: RiskLevel;
  error?: string;
  lastAgentMessage?: string;
  verdict?: JudgeVerdict;
  completedAt?: string;
  cancelledAt?: string;
}
