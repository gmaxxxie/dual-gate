// =============================================================================
// Dual-Gate Reflex Layer — Progress / Stuck
//
// Two complementary signals:
//   1. Iteration-level quantified comparison  State(t-1) vs State(t):
//        tests_failed 8→5→2            = PROGRESS (even while failing)
//        error_signature changes       = PROGRESS (debugging moves forward)
//        requirements_completed rises  = PROGRESS
//        effective diff grows          = PROGRESS
//        build pass→fail               = REGRESSION
//        tests_failed rises            = REGRESSION
//        nothing above                 = NO_PROGRESS
//   2. Turn-level pre-signals (borrowed from Bicameral StuckTracker.preSignals):
//        identical command + identical error repeated
//        same file oscillating between <=2 hunks >= N times
//
// Bicameral only had #2 (plus a model's subjective `no_progress`). This version
// adds #1 so "连续三轮失败但 tests 8→5→2" is correctly seen as progress, not
// stuck. All deterministic, zero tokens.
// =============================================================================

import type { IterationState, ReflexPolicy, StuckDecision, TrendResult, TurnSignal } from "./types.ts";

// ---------------------------------------------------------------------------
// Pre-signal detection (borrowed from Bicameral StuckTracker.preSignals)
// ---------------------------------------------------------------------------

export interface PreSignal {
  type: "identical_command_error" | "oscillation";
  detail: string;
}

/** Detect identical command+error repetition and file oscillation in a turn window. */
export function preSignals(turns: TurnSignal[], minEdits = 3): PreSignal[] {
  const signals: PreSignal[] = [];
  if (turns.length === 0) return signals;
  const latest = turns[turns.length - 1];
  if (latest.isError) {
    const prior = turns.slice(0, -1).find(
      (t) => t.isError && t.toolName === latest.toolName && t.argsSummary === latest.argsSummary && t.errorLine === latest.errorLine,
    );
    if (prior) {
      signals.push({
        type: "identical_command_error",
        detail: `${latest.toolName} ${latest.argsSummary} → ${latest.errorLine ?? "error"}`,
      });
    }
  }
  for (const file of latest.filesEdited ?? []) {
    const history = turns.flatMap((t) => t.filesEdited ?? []).filter((f) => f.path === file.path);
    const unique = new Set(history.map((h) => h.hunkHash));
    if (history.length >= minEdits && unique.size <= 2) {
      signals.push({
        type: "oscillation",
        detail: `${file.path} oscillated between ${[...unique].join(" / ")}`,
      });
    }
  }
  return signals;
}

/** First non-empty line of a tool error output (for the signature). */
export function firstErrorLine(errorText: string): string {
  if (!errorText) return "";
  const line = errorText.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 160) : "";
}

// ---------------------------------------------------------------------------
// Iteration-state comparison (the quantified Progress signal)
// ---------------------------------------------------------------------------

/**
 * Compare previous vs current iteration state. Returns a Trend plus the
 * individual signals so the caller can audit why a trend was chosen.
 * `prev` may be undefined (first iteration) → PROGRESS (baseline established).
 */
export function compareState(prev: IterationState | undefined, curr: IterationState): TrendResult {
  if (!prev) return { trend: "PROGRESS", signals: [{ name: "baseline", hit: true, detail: "first measured iteration" }] };

  const num = (v: number | undefined, def: number): number => (v === undefined ? def : v);
  const signals: Array<{ name: string; hit: boolean; detail?: string }> = [];

  // Tests shrinking toward zero = progress even while failing.
  const testsShrinking =
    num(prev.testsFailed, -1) >= 0 &&
    num(curr.testsFailed, -1) >= 0 &&
    curr.testsFailed! < prev.testsFailed!;
  signals.push({ name: "tests_failed_decreased", hit: testsShrinking, detail: `${num(prev.testsFailed, -1)}→${num(curr.testsFailed, -1)}` });

  const errorChanged = prev.errorSignature !== "" && curr.errorSignature !== "" && prev.errorSignature !== curr.errorSignature;
  signals.push({ name: "error_signature_changed", hit: errorChanged, detail: curr.errorSignature || "(none)" });

  const reqProgress = curr.requirementsTotal > 0 && curr.requirementsCompleted > prev.requirementsCompleted;
  signals.push({ name: "requirements_increased", hit: reqProgress, detail: `${prev.requirementsCompleted}/${prev.requirementsTotal}→${curr.requirementsCompleted}/${curr.requirementsTotal}` });

  const diffGrew = curr.diffSize > prev.diffSize && curr.buildStatus !== "fail";
  signals.push({ name: "diff_grew", hit: diffGrew, detail: `${prev.diffSize}→${curr.diffSize}` });

  const buildFailed = prev.buildStatus === "pass" && curr.buildStatus === "fail";
  signals.push({ name: "build_regressed", hit: buildFailed });

  const testsGrew = num(curr.testsFailed, 0) > num(prev.testsFailed, 0);
  signals.push({ name: "tests_failed_increased", hit: testsGrew, detail: `${num(prev.testsFailed, 0)}→${num(curr.testsFailed, 0)}` });

  const regression = buildFailed || testsGrew;
  if (regression) return { trend: "REGRESSION", signals };

  const progress = testsShrinking || errorChanged || reqProgress || diffGrew;
  return progress ? { trend: "PROGRESS", signals } : { trend: "NO_PROGRESS", signals };
}

// ---------------------------------------------------------------------------
// Stuck decision
// ---------------------------------------------------------------------------

/**
 * Combine iteration-level comparison and turn-level pre-signals into a
 * StuckDecision. Avoids false-positives on normal iterative debugging:
 *   - STUCK requires identical error repeated AND no progress, OR hard
 *     oscillation evidence.
 *   - WATCH records without interrupting.
 *   - OK is the default for any actual progress.
 */
export function decideStuck(input: {
  prev: IterationState | undefined;
  curr: IterationState;
  turns: TurnSignal[];
  history: { noProgressStreak: number; sameErrorStreak: number };
  policy: ReflexPolicy;
}): StuckDecision {
  const p = input.policy.progress;
  if (!p.enabled) return { verdict: "OK", reason: "disabled", policyRule: "stuck.disabled" };

  const trend = compareState(input.prev, input.curr);
  const signals = preSignals(input.turns, p.oscillation_min_edits);
  const oscillating = signals.some((s) => s.type === "oscillation");
  const identicalCmdError = signals.some((s) => s.type === "identical_command_error");

  const noProgressStreak = trend.trend === "NO_PROGRESS" ? input.history.noProgressStreak + 1 : 0;
  const sameErrorStreak =
    input.prev && input.prev.errorSignature !== "" && input.curr.errorSignature === input.prev.errorSignature
      ? input.history.sameErrorStreak + 1
      : 0;

  // Hard stuck evidence: oscillation, or repeated identical error with no progress.
  if (oscillating) {
    return {
      verdict: "STUCK",
      reason: "oscillation",
      hint: `Edits are oscillating (${signals.filter((s) => s.type === "oscillation").map((s) => s.detail).join("; ")}). Pick one approach or revert and rethink the goal.`,
      policyRule: "stuck.oscillation",
    };
  }
  if (identicalCmdError && noProgressStreak >= 1) {
    const err = signals.find((s) => s.type === "identical_command_error")?.detail ?? "the same error";
    return {
      verdict: "STUCK",
      reason: "repeated_failure",
      hint: `You ran the same command and got the same error: ${err}. Stop repeating it; inspect the error, change the approach, then retry once.`,
      policyRule: "stuck.repeated_failure",
    };
  }
  if (noProgressStreak >= p.no_progress_stuck_after && sameErrorStreak >= p.same_error_stuck_after) {
    return {
      verdict: "STUCK",
      reason: "no_progress_same_error",
      hint: `No measurable progress and the same error persisted across ${noProgressStreak} iterations. Change strategy: read the error, inspect relevant files, take a different action.`,
      policyRule: "stuck.no_progress_same_error",
    };
  }
  if (noProgressStreak >= p.no_progress_stuck_after) {
    return {
      verdict: "STUCK",
      reason: "no_progress",
      hint: `No measurable progress across ${noProgressStreak} iterations. Read the error, inspect the relevant files, then take a different action.`,
      policyRule: "stuck.no_progress",
    };
  }
  if (noProgressStreak >= p.watch_after) {
    return { verdict: "WATCH", reason: "no_progress_watch", policyRule: "stuck.watch" };
  }
  return { verdict: "OK", reason: trend.trend === "REGRESSION" ? "regression_observed" : "progress_or_idle", policyRule: "stuck.ok" };
}

// ---------------------------------------------------------------------------
// Jev-assisted Stuck (asked when a full iteration's results come back)
// ---------------------------------------------------------------------------

/** State text handed to Jev when NO_PROGRESS has persisted for >= jev_after rounds. */
export function stuckJevState(input: {
  prev?: IterationState;
  curr: IterationState;
  noProgressStreak: number;
  sameErrorStreak: number;
  turns: TurnSignal[];
}): string {
  const p = input.prev
    ? `prev tests_failed=${input.prev.testsFailed ?? "?"} build=${input.prev.buildStatus} error="${input.prev.errorSignature}" req=${input.prev.requirementsCompleted}/${input.prev.requirementsTotal}`
    : "no previous iteration";
  const turns = input.turns.slice(-6).map((t) => `${t.toolName}${t.isError ? " ERR:" + (t.errorLine ?? "") : ""} ${t.argsSummary.slice(0, 80)}`).join("\n") || "(no turn signals)";
  return [
    `Current iteration ${input.curr.iteration}: tests_failed=${input.curr.testsFailed ?? "?"} build=${input.curr.buildStatus} error="${input.curr.errorSignature}" req=${input.curr.requirementsCompleted}/${input.curr.requirementsTotal} diff_size=${input.curr.diffSize}`,
    p,
    `no_progress_streak=${input.noProgressStreak} same_error_streak=${input.sameErrorStreak}`,
    `Recent turn signals:\n${turns}`,
  ].join("\n");
}

/**
 * In Jev-first mode, when NO_PROGRESS persists (>= jev_after), ask Jev whether
 * the agent is genuinely stuck (`no_progress` noul) rather than trusting the
 * rule streak alone. 0.5s / ~$0.00002. Falls back to rule on error/timeout.
 */
export async function decideStuckWithJev(
  input: {
    prev: IterationState | undefined;
    curr: IterationState;
    turns: TurnSignal[];
    history: { noProgressStreak: number; sameErrorStreak: number };
    policy: ReflexPolicy;
  },
  jev: ((req: { state: string; questions: Record<string, import("./backend.ts").S1Question> }) => Promise<{ no_progress: number } | undefined>) | undefined,
): Promise<StuckDecision> {
  const rule = decideStuck(input);
  if (!jev) return rule;
  const p = input.policy.progress;
  // The meaningful streak is the internal one: history + 1 if the current
  // round is also NO_PROGRESS (compareState already said so via rule.verdict).
  const trend = compareState(input.prev, input.curr);
  const internalNoProgress = trend.trend === "NO_PROGRESS" ? input.history.noProgressStreak + 1 : input.history.noProgressStreak;
  // Consult Jev only in the ambiguous watch zone: past jev_after but still
  // below the rule's hard STUCK threshold. Rule STUCK (hard signals) or OK
  // (real progress) never asks.
  const shouldAsk =
    internalNoProgress >= p.jev_after &&
    internalNoProgress < p.no_progress_stuck_after &&
    rule.verdict !== "STUCK" &&
    rule.verdict !== "OK";
  if (!shouldAsk) return rule;

  const state = stuckJevState({ prev: input.prev, curr: input.curr, noProgressStreak: internalNoProgress, sameErrorStreak: input.history.sameErrorStreak, turns: input.turns });
  try {
    const res = await jev({
      state,
      questions: {
        no_progress: {
          type: "noul",
          instructions: "The agent is genuinely stuck: the last iterations made no measurable progress toward the goal (not just slow normal debugging)",
          criteria: { true: "确实卡住", false: "仍在正常推进" },
        },
      },
    });
    if (res === undefined) return rule;
    if (res.no_progress >= 0.7) {
      return { verdict: "STUCK", reason: "jev_no_progress", hint: rule.hint, policyRule: "stuck.jev_no_progress" };
    }
    return rule;
  } catch {
    return rule;
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers for the orchestration loop
// ---------------------------------------------------------------------------

/** Compact ring buffer: append, keep last `window`. */
export function pushWindow<T>(arr: T[], item: T, window: number): T[] {
  const next = [...arr, item];
  return next.length > window ? next.slice(next.length - window) : next;
}
