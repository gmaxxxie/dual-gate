// =============================================================================
// Dual-Gate Reflex Layer — shared types
//
// The Reflex Layer (System-1) is a deterministic, zero-token judgment layer
// that runs INSIDE the dual-gate orchestration loop (the Executor lives in a
// separate Herdr pane, so main-session Pi hooks never see its tool calls).
//
// Everything here is a pure data shape. No model calls, no I/O. The decisions
// (`decide*` functions in finish.ts / progress.ts / risk-tier.ts / policy.ts)
// turn structured evidence into structured verdicts, and only the Escalation
// Policy decides when to route back to the expensive System-2 (GPT-5.6 Judge).
// =============================================================================

// ---------------------------------------------------------------------------
// Risk tiers (Tool Risk Gate)
// ---------------------------------------------------------------------------

export type RiskTier = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface TierVerdict {
  tier: RiskTier;
  reason: string;
  /** Which pattern matched, if any. */
  matched?: string;
}

// ---------------------------------------------------------------------------
// Honest Finish (研发完成判断)
// ---------------------------------------------------------------------------

export interface FinishEvidence {
  /** Deterministic gate outcome (project's own test/lint/build commands). */
  gate: {
    ran: boolean;
    passed: boolean;
    /** Number of gate steps that ran. */
    steps: number;
    /** Failing step names, e.g. ["npm:test"]. */
    failedSteps: string[];
    /** Tail of the first failing step output. */
    errorTail?: string;
  };
  /** Executor report (already normalized via normalizeReport). */
  report: {
    status: string;
    hasSummary: boolean;
    filesChanged: number;
    implementationLines: number;
    testsCommands: number;
    testsPassed: number;
    testsFailed: number;
    validation: { lint: string; typecheck: string; build: string };
    acceptancePassed: number;
    acceptanceTotal: number;
    deviations: number;
    unresolved: number;
  };
  /** Git diff statistics vs the baseline (HEAD or previous iteration). */
  diff: { filesChanged: number; insertions: number; deletions: number };
  /** Local heuristic red flags (all deterministic, no model). */
  flags: {
    silentFailure: boolean;
    scopeEscape: boolean;
    testWeakened: boolean;
    stubHeuristic: boolean;
    unverifiedClaim: boolean;
    testNotRun: boolean;
  };
}

export type FinishVerdict = "completed" | "needs_fix" | "escalate";

export interface FinishDecision {
  verdict: FinishVerdict;
  reason: string;
  /** 0..1 fraction of evidence checks satisfied. */
  score: number;
  checks: FinishCheck[];
  /** Template hint for the Executor (RETRY case). */
  hint?: string;
  policyRule: string;
}

export interface FinishCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Progress / Stuck (iteration-level quantified comparison)
// ---------------------------------------------------------------------------

export interface IterationState {
  iteration: number;
  filesChanged: string[];
  testsPassed?: number;
  testsFailed?: number;
  buildStatus: "pass" | "fail" | "not_run";
  /** Normalized first failing gate-step error line ("" when none). */
  errorSignature: string;
  diffSize: number;
  requirementsCompleted: number;
  requirementsTotal: number;
}

export type Trend = "PROGRESS" | "NO_PROGRESS" | "REGRESSION";

export interface TrendResult {
  trend: Trend;
  signals: Array<{ name: string; hit: boolean; detail?: string }>;
}

/** One turn-level signal, fed by the orchestration loop (borrowed from Bicameral's StuckTracker.preSignals). */
export interface TurnSignal {
  toolName: string;
  argsSummary: string;
  isError: boolean;
  errorLine?: string;
  filesEdited?: Array<{ path: string; hunkHash: string }>;
}

export type StuckVerdict = "OK" | "WATCH" | "STUCK";

export interface StuckDecision {
  verdict: StuckVerdict;
  reason: string;
  /** Template hint for the Executor (STUCK case). */
  hint?: string;
  policyRule: string;
}

// ---------------------------------------------------------------------------
// Escalation Policy
// ---------------------------------------------------------------------------

export type LoopAction = "CONTINUE" | "RETRY" | "RETRY_WITH_HINT" | "ESCALATE";

export interface LoopContext {
  retryCount: number;
  maxRetries: number;
  totalIterations: number;
  sameErrorStreak: number;
  noProgressStreak: number;
}

export interface LoopDecision {
  action: LoopAction;
  reason: string;
  hint?: string;
  policyRule: string;
}

// ---------------------------------------------------------------------------
// Reflex policy (deterministic thresholds; YAML/JSON overlay over defaults)
// ---------------------------------------------------------------------------

export type ReflexMode = "observe" | "enforce";

export type ReflexBackend = "rule" | "jev" | "hybrid";

export interface ReflexPolicy {
  mode: ReflexMode;
  /** Primary System-1 backend: rule (deterministic) | jev | hybrid (jev first, rule fallback). */
  backend: ReflexBackend;
  /** Jev call deadline; on timeout/error fall back to rule signals. */
  jev_deadline_ms: number;
  finish: {
    enabled: boolean;
    /** Fraction of evidence checks required for `completed`. */
    complete_threshold: number;
    /** Evidence scores in [low_band, complete_threshold) ask Jev goal_met. */
    jev_low_band: number;
  };
  progress: {
    enabled: boolean;
    /** Iteration states retained for comparison. */
    window: number;
    /** Consecutive NO_PROGRESS before STUCK. */
    no_progress_stuck_after: number;
    /** Consecutive identical error signature before STUCK. */
    same_error_stuck_after: number;
    /** WATCH at this many consecutive NO_PROGRESS (record only). */
    watch_after: number;
    /** Turn-level oscillation: same file flipped between <=2 hunks >= N times. */
    oscillation_min_edits: number;
    /** Ask Jev `no_progress` after this many consecutive NO_PROGRESS. */
    jev_after: number;
  };
  risk: {
    enabled: boolean;
    /** CRITICAL tier blocks (or confirms when UI available). */
    critical_confirm: boolean;
    /** HIGH tier records + warns but does not interrupt. */
    warn_high: boolean;
  };
  loop: {
    /** Escalate when stuck and same error streak >= this. */
    escalate_stuck_same_error: number;
    /** Escalate on REGRESSION after this many retries. */
    escalate_regression_retries: number;
    /** Ask Jev `escalate` when rule signals conflict (e.g. PROGRESS but flagged). */
    jev_on_conflict: boolean;
  };
}

export const DEFAULT_REFLEX_POLICY: ReflexPolicy = {
  mode: "observe",
  backend: "hybrid",
  jev_deadline_ms: 2000,
  finish: { enabled: true, complete_threshold: 0.8, jev_low_band: 0.6 },
  progress: {
    enabled: true,
    window: 4,
    no_progress_stuck_after: 3,
    same_error_stuck_after: 2,
    watch_after: 2,
    oscillation_min_edits: 3,
    jev_after: 2,
  },
  risk: { enabled: true, critical_confirm: true, warn_high: true },
  loop: { escalate_stuck_same_error: 3, escalate_regression_retries: 2, jev_on_conflict: true },
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge a partial policy overlay over the defaults. Returns a fresh object. */
export function mergeReflexPolicy(base: ReflexPolicy, overlay: unknown): ReflexPolicy {
  if (!isPlainObject(overlay)) return structuredClone(base);
  const out: Record<string, unknown> = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeReflexPolicy(out[key] as ReflexPolicy, value) : value;
  }
  return out as ReflexPolicy;
}

/** Validate an untrusted overlay (from config JSON). Unknown keys are ignored. */
export function normalizeReflexPolicy(raw: unknown): ReflexPolicy {
  if (!isPlainObject(raw)) return structuredClone(DEFAULT_REFLEX_POLICY);
  const ok = <T>(v: unknown, def: T): T => (v === undefined ? def : (v as T));
  const finish = isPlainObject(raw.finish) ? raw.finish : {};
  const progress = isPlainObject(raw.progress) ? raw.progress : {};
  const risk = isPlainObject(raw.risk) ? raw.risk : {};
  const loop = isPlainObject(raw.loop) ? raw.loop : {};
  const b = structuredClone(DEFAULT_REFLEX_POLICY);
  const num = (v: unknown, def: number): number => (typeof v === "number" && Number.isFinite(v) ? v : def);
  const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);
  const str = (v: unknown, def: ReflexMode): ReflexMode => (v === "observe" || v === "enforce" ? v : def);
  const backend = (v: unknown): ReflexBackend => (v === "rule" || v === "jev" || v === "hybrid" ? v : b.backend);
  return {
    mode: str(raw.mode, b.mode),
    backend: backend(raw.backend),
    jev_deadline_ms: Math.max(200, Math.floor(num(raw.jev_deadline_ms, b.jev_deadline_ms))),
    finish: {
      enabled: bool(finish.enabled, b.finish.enabled),
      complete_threshold: Math.min(1, Math.max(0, num(finish.complete_threshold, b.finish.complete_threshold))),
      jev_low_band: Math.min(1, Math.max(0, num(finish.jev_low_band, b.finish.jev_low_band))),
    },
    progress: {
      enabled: bool(progress.enabled, b.progress.enabled),
      window: Math.max(2, Math.floor(num(progress.window, b.progress.window))),
      no_progress_stuck_after: Math.max(1, Math.floor(num(progress.no_progress_stuck_after, b.progress.no_progress_stuck_after))),
      same_error_stuck_after: Math.max(1, Math.floor(num(progress.same_error_stuck_after, b.progress.same_error_stuck_after))),
      watch_after: Math.max(1, Math.floor(num(progress.watch_after, b.progress.watch_after))),
      oscillation_min_edits: Math.max(2, Math.floor(num(progress.oscillation_min_edits, b.progress.oscillation_min_edits))),
      jev_after: Math.max(1, Math.floor(num(progress.jev_after, b.progress.jev_after))),
    },
    risk: {
      enabled: bool(risk.enabled, b.risk.enabled),
      critical_confirm: bool(risk.critical_confirm, b.risk.critical_confirm),
      warn_high: bool(risk.warn_high, b.risk.warn_high),
    },
    loop: {
      escalate_stuck_same_error: Math.max(1, Math.floor(num(loop.escalate_stuck_same_error, b.loop.escalate_stuck_same_error))),
      escalate_regression_retries: Math.max(0, Math.floor(num(loop.escalate_regression_retries, b.loop.escalate_regression_retries))),
      jev_on_conflict: bool(loop.jev_on_conflict, b.loop.jev_on_conflict),
    },
  };
}
