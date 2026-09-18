// =============================================================================
// Dual-Gate Reflex Layer — Escalation Policy
//
// The single decision point that maps Reflex signals → loop actions:
//   CONTINUE          → proceed to the GPT-5.6 Judge (or DONE)
//   RETRY             → generate feedback → same Herdr executor pane
//   RETRY_WITH_HINT   → template hint → same pane (stuck/oscillation)
//   ESCALATE          → route to GPT-5.6 Judge / convergenceDiagnosis /
//                       user confirmation / stronger executor model
//
// System-2 (GPT-5.6) is NOT removed: it is simply only reached via ESCALATE
// or after the Reflex confirms evidence is sufficient. Ordinary judgments are
// absorbed locally at zero token cost.
// =============================================================================

import type { LoopAction, LoopContext, LoopDecision, ReflexPolicy, StuckDecision, Trend } from "./types.ts";
import type { FinishDecision } from "./types.ts";

export interface LoopInput {
  finish?: FinishDecision;
  trend?: Trend;
  stuck?: StuckDecision;
  riskTier: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  ctx: LoopContext;
  policy: ReflexPolicy;
}

export function decideLoop(input: LoopInput): LoopDecision {
  const p = input.policy.loop;

  // --- Hard escalation: only these reach GPT-5.6 / the user ---
  if (input.finish?.verdict === "escalate") {
    return { action: "ESCALATE", reason: `finish:${input.finish.reason}`, policyRule: "loop.escalate.finish" };
  }
  if (input.riskTier === "CRITICAL") {
    return { action: "ESCALATE", reason: "risk:critical", policyRule: "loop.escalate.critical_risk" };
  }
  if (input.stuck?.verdict === "STUCK" && input.ctx.sameErrorStreak >= p.escalate_stuck_same_error) {
    return { action: "ESCALATE", reason: `stuck:${input.stuck.reason}`, hint: input.stuck.hint, policyRule: "loop.escalate.stuck_same_error" };
  }
  if (input.trend === "REGRESSION" && input.ctx.retryCount >= p.escalate_regression_retries) {
    return { action: "ESCALATE", reason: "trend:regression", policyRule: "loop.escalate.regression" };
  }

  // --- Ordinary judgments: Reflex absorbs locally ---
  if (input.finish?.verdict === "needs_fix") {
    return { action: "RETRY", reason: `finish:${input.finish.reason}`, hint: input.finish.hint, policyRule: "loop.retry.finish" };
  }
  if (input.stuck?.verdict === "STUCK") {
    return { action: "RETRY_WITH_HINT", reason: `stuck:${input.stuck.reason}`, hint: input.stuck.hint, policyRule: "loop.retry.stuck" };
  }
  if (input.trend === "REGRESSION" || input.trend === "NO_PROGRESS") {
    if (input.ctx.retryCount < input.ctx.maxRetries) {
      return { action: "RETRY", reason: `trend:${input.trend}`, policyRule: "loop.retry.trend" };
    }
    return { action: "ESCALATE", reason: `trend:${input.trend} after retries`, policyRule: "loop.escalate.trend_after_retries" };
  }

  // PROGRESS / unknown → continue to the System-2 Judge (evidence is fine).
  return { action: "CONTINUE", reason: "progress_or_completed", policyRule: "loop.continue" };
}

export function loopActionLabel(a: LoopAction): string {
  switch (a) {
    case "CONTINUE": return "继续 → Judge";
    case "RETRY": return "重试（同一 pane）";
    case "RETRY_WITH_HINT": return "重试+模板提示（同一 pane）";
    case "ESCALATE": return "升级 → GPT-5.6 / 用户";
  }
}
