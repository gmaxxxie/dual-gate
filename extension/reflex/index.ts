// =============================================================================
// Dual-Gate Reflex Layer — orchestration entry
//
// `runReflexLayer` assembles all four capabilities into one pass over the
// evidence the orchestration loop already has:
//
//   1. Honest Finish   → decideFinish (rule) + decideFinishWithJev (ambiguous band)
//   2. Progress/Stuck  → compareState + decideStuck (+ Jev `no_progress` when
//                        NO_PROGRESS persists — asked when iteration results return)
//   3. Tool Risk Gate  → tierOf (task-level, at plan time)
//   4. Escalation      → decideLoop → CONTINUE | RETRY | RETRY_WITH_HINT | ESCALATE
//
// Jev-first mode (policy.backend = "hybrid" | "jev"): the rule signals are the
// prior; Jev is consulted at the decision points that gate whether we spend a
// GPT-5.6 Judge call (the expensive System-2). On Jev timeout/error the rule
// verdict stands (Bicameral degraded-mode fallback). Output is a plain
// ReflexResult object — no I/O beyond the injected `jev` callback.
// =============================================================================

import { compareState, decideStuck, decideStuckWithJev, preSignals } from "./progress.ts";
import { decideFinish, buildFinishEvidence, decideFinishWithJev } from "./finish.ts";
import { decideLoop } from "./policy.ts";
import type { JevBackend } from "./backend.ts";
import type {
  FinishDecision,
  IterationState,
  LoopDecision,
  ReflexPolicy,
  StuckDecision,
  Trend,
  TurnSignal,
} from "./types.ts";

/** How the caller wants Jev consulted. Backend owns the actual CLI call + fallback. */
export interface JevClient {
  /** Ask one or more noul questions; returns probabilities or undefined on degraded. */
  ask(state: string, questions: Record<string, import("./backend.ts").S1Question>): Promise<Record<string, number> | undefined>;
}

export function makeJevClient(backend: JevBackend | undefined, policy: ReflexPolicy): JevClient | undefined {
  if (!backend || policy.backend === "rule") return undefined;
  return {
    async ask(state, questions) {
      try {
        const res = await backend.decide({ state, questions }, { timeoutMs: policy.jev_deadline_ms });
        const out: Record<string, number> = {};
        for (const [name, a] of Object.entries(res.answers)) {
          if (a.type === "noul") out[name] = a.noul;
          else if (a.type === "choice") out[name] = 0; // choices not used as noul
        }
        return out;
      } catch {
        return undefined; // degraded → callers fall back to rule
      }
    },
  };
}

export interface ReflexRunInput {
  policy: ReflexPolicy;
  /** Jev client (undefined in rule mode, or when Jev unavailable). */
  jev?: JevClient;
  /** Iteration index (1-based). */
  iteration: number;
  /** Normalized executor report (core.ts normalizeReport shape). */
  report: Record<string, unknown>;
  /** Gate result, or null when the deterministic gate did not run yet. */
  gate: { passed: boolean; steps: Array<{ name: string; passed: boolean; skipped: boolean }> } | null;
  /** git diff text vs baseline ("" when unavailable). */
  diffText: string;
  /** git diff --name-only ([] when unavailable). */
  filesChanged: string[];
  /** Repo path (for scope-escape). */
  cwd: string;
  /** Previous iteration state for comparison (undefined on iteration 1). */
  prevState?: IterationState;
  /** Current iteration state (computed by caller, or left for us to fill from report). */
  state: IterationState;
  /** Turn-level signals from the executor pane (for pre-signals). */
  turns: TurnSignal[];
  /** Streak history from TaskRecord. */
  history: { noProgressStreak: number; sameErrorStreak: number };
  /** Escalation context. */
  ctx: { retryCount: number; maxRetries: number; totalIterations: number };
}

export interface ReflexResult {
  finish?: FinishDecision;
  trend: Trend;
  stuck: StuckDecision;
  loop: LoopDecision;
  preSignals: ReturnType<typeof preSignals>;
  /** Whether Jev was consulted this run (for audit). */
  jevConsulted: string[];
}

export async function runReflexLayer(input: ReflexRunInput): Promise<ReflexResult> {
  const { policy } = input;
  const jevConsulted: string[] = [];

  // 1. Honest Finish — evidence checklist; Jev decides the ambiguous band.
  const ev = buildFinishEvidence({
    report: input.report,
    gate: input.gate,
    diffText: input.diffText,
    filesChanged: input.filesChanged,
    cwd: input.cwd,
  });
  let finish: FinishDecision | undefined;
  if (policy.finish.enabled) {
    finish = await decideFinishWithJev(ev, policy, input.jev?.ask ? (req) => input.jev!.ask(req.state, req.questions).then((r) => (r ? { goal_met: r.goal_met ?? 0 } : undefined)) : undefined);
    if (finish.policyRule.startsWith("finish.jev_")) jevConsulted.push("finish");
  }

  // 2. Progress / Stuck — quantified comparison + local pre-signals; Jev
  //    `no_progress` when NO_PROGRESS persists (result-returned timing).
  const trendResult = compareState(input.prevState, input.state);
  const stuck = await decideStuckWithJev(
    {
      prev: input.prevState,
      curr: input.state,
      turns: input.turns,
      history: input.history,
      policy,
    },
    input.jev?.ask
      ? (req) => input.jev!.ask(req.state, req.questions).then((r) => (r ? { no_progress: r.no_progress ?? 0 } : undefined))
      : undefined,
  );
  if (stuck.policyRule === "stuck.jev_no_progress") jevConsulted.push("progress");

  // 3. Escalation policy (risk tier is decided separately at plan time)
  const loop = decideLoop({
    finish,
    trend: trendResult.trend,
    stuck,
    riskTier: "LOW", // task-level risk handled by risk-tier.ts at plan time
    ctx: {
      retryCount: input.ctx.retryCount,
      maxRetries: input.ctx.maxRetries,
      totalIterations: input.ctx.totalIterations,
      sameErrorStreak: input.history.sameErrorStreak,
      noProgressStreak: input.history.noProgressStreak,
    },
    policy,
  });

  return {
    finish,
    trend: trendResult.trend,
    stuck,
    loop,
    preSignals: preSignals(input.turns, policy.progress.oscillation_min_edits),
    jevConsulted,
  };
}

/**
 * Serialize a reflex run for the audit log / TaskRecord. Small, readable, JSON-safe.
 */
export function formatReflexResult(r: ReflexResult): string {
  const lines: string[] = [];
  if (r.finish) lines.push(`finish=${r.finish.verdict}(${r.finish.reason}) score=${r.finish.score.toFixed(2)} [${r.finish.policyRule}]`);
  lines.push(`trend=${r.trend}`);
  lines.push(`stuck=${r.stuck.verdict}(${r.stuck.reason}) [${r.stuck.policyRule}]`);
  for (const s of r.preSignals) lines.push(`preSignal=${s.type}: ${s.detail}`);
  lines.push(`loop=${r.loop.action}(${r.loop.reason}) [${r.loop.policyRule}]`);
  if (r.jevConsulted.length > 0) lines.push(`jev_consulted=${r.jevConsulted.join(",")}`);
  return lines.join("\n");
}
