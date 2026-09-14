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
