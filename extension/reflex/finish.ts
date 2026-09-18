// =============================================================================
// Dual-Gate Reflex Layer — Honest Finish (研发完成判断)
//
// Decides whether the Executor actually completed the task — NOT by trusting
// its "Done" text, but by an evidence checklist over deterministic signals:
//   - the project's own deterministic gate (test/lint/build) actually ran & passed
//   - the executor report is non-empty and not "failed"
//   - validation/build has a real result (not "not_run")
//   - tests ran with zero failures (when available)
//   - files actually changed
//   - acceptance_check ran and all passed
//   - heuristic red flags (stub / test weakened / test removed / scope escape /
//     unverified claim / silent failure)
//
// Conceptually the successor to Bicameral's `finish_check` pack (which was
// defined in YAML but never wired in v0.1). Bicameral asked a model for
// `unverified_claim`/`goal_met` probabilities; this version is deterministic
// and zero-token. If evidence is ambiguous, the Escalation Policy routes to
// the existing GPT-5.6 Judge — System-2 does not disappear.
// =============================================================================

import type { FinishCheck, FinishDecision, FinishEvidence, ReflexPolicy } from "./types.ts";

// ---------------------------------------------------------------------------
// Local heuristic flags (deterministic)
// ---------------------------------------------------------------------------

const STUB_KEYWORDS = /\b(TODO|FIXME|XXX|placeholder|stub|not implemented|hardcoded|lorem ipsum|throw new Error\("not implemented|return null\s*;?\s*\/\/\s*todo)\b/i;

/** Is the path a test file? (mirrors Bicameral's isTestPath) */
export function isTestPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  return (
    /(^|\/)(__tests__|tests?|spec)(\/|$)/i.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(p)
  );
}

/** Detect test weakening / removal in a diff hunk (lines with +/-). */
export function detectTestWeakening(diffText: string, filePath: string): { weakened: boolean; removed: boolean; detail?: string } {
  if (!isTestPath(filePath) && !/\b(test|spec)\.(?:[cm]?[jt]sx?|py)$/.test(filePath)) return { weakened: false, removed: false };
  const lines = diffText.split(/\r?\n/);
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  let weakened = false;
  let detail: string | undefined;
  // Removing assertions or changing expected values in a test file.
  for (const l of lines) {
    const t = l.slice(1).trim();
    if (
      (l.startsWith("-") &&
        (/\b(?:assert|expect|should|assert\.equal|assert\.deep|assert\.strict|test\(|it\(|describe\()/.test(t) ||
          /\b(expected|toBe|toEqual|toHave|assertThrows|raises)\b/.test(t))) ||
      (l.startsWith("+") && (/\b(?:it\.skip|describe\.skip|test\.skip|xit\b|@pytest\.mark\.skip|\.skip\s*\()/.test(t)))
    ) {
      weakened = true;
      detail = t.slice(0, 120);
      break;
    }
  }
  return { weakened, removed: removed > 0 && added === 0, detail };
}

/** Detect stub-like implementation lines in the report. */
export function detectStub(report: { implementationLines: number; status: string }, diffText: string): boolean {
  if (report.status === "failed") return false;
  return STUB_KEYWORDS.test(diffText);
}

/** Detect path escaping the repo (scope escape). */
export function detectScopeEscape(files: string[], cwd: string): { escaped: boolean; paths: string[] } {
  const escaped = files.filter((f) => !f.startsWith(cwd) && !f.startsWith(".") && /^([A-Za-z]:)?[\\/]/.test(f));
  return { escaped: escaped.length > 0, paths: escaped };
}

// ---------------------------------------------------------------------------
// Evidence assembly
// ---------------------------------------------------------------------------

/**
 * Build FinishEvidence from already-normalized inputs. Pure; no I/O.
 *
 * `report` is the normalized ExecutorReport (shape from core.ts normalizeReport).
 * `gate` is the GateResult (gate.ts) or null when the gate didn't run yet.
 * `diffText` is the git diff text ("" when unavailable).
 * `filesChanged` is git diff --name-only ([] when unavailable).
 * `cwd` is the repo path (for scope-escape check).
 */
export function buildFinishEvidence(input: {
  report: Record<string, unknown>;
  gate: { passed: boolean; steps: Array<{ name: string; passed: boolean; skipped: boolean }> } | null;
  diffText: string;
  filesChanged: string[];
  cwd: string;
}): FinishEvidence {
  const r = input.report;
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const status = str(r.status);
  const filesChangedReportRaw = Array.isArray(r.files_changed) ? (r.files_changed as unknown[]) : [];
  // files_changed entries are either "path" strings or { path, purpose } objects.
  const filesChangedReport = filesChangedReportRaw.map((f) => {
    if (typeof f === "string") return f;
    if (f && typeof f === "object") {
      const p = (f as Record<string, unknown>).path;
      return typeof p === "string" ? p : "";
    }
    return "";
  }).filter(Boolean);
  const implementationLines = Array.isArray(r.implementation) ? (r.implementation as unknown[]).length : 0;
  const tests = (r.tests && typeof r.tests === "object" ? r.tests : {}) as Record<string, unknown>;
  const testsCommands = Array.isArray(tests.commands) ? (tests.commands as unknown[]).length : 0;
  const testsPassed = Array.isArray(tests.passed) ? (tests.passed as unknown[]).length : 0;
  const testsFailed = Array.isArray(tests.failed) ? (tests.failed as unknown[]).length : 0;
  const validation = (r.validation && typeof r.validation === "object" ? r.validation : {}) as Record<string, unknown>;
  const lint = str(validation.lint);
  const typecheck = str(validation.typecheck);
  const build = str(validation.build);
  const acceptance = (r.acceptance_check && typeof r.acceptance_check === "object" ? r.acceptance_check : {}) as Record<string, unknown>;
  const acceptanceEntries = Object.entries(acceptance);
  const acceptancePassed = acceptanceEntries.filter(([, v]) => str(v) === "pass").length;
  const acceptanceTotal = acceptanceEntries.length;
  const deviations = Array.isArray(r.deviations) ? (r.deviations as unknown[]).length : 0;
  const unresolved = Array.isArray(r.unresolved) ? (r.unresolved as unknown[]).length : 0;

  const gateRan = input.gate !== null && input.gate.steps.length > 0;
  const gateFailedSteps = input.gate ? input.gate.steps.filter((s) => !s.passed && !s.skipped).map((s) => s.name) : [];
  const gateErrorTail = gateFailedSteps[0] ?? "";

  // Heuristic flags
  const silentFailure = !status || status === "failed" || (str(r.summary) === "" && status === "");
  const scopeEscape = detectScopeEscape([...filesChangedReport, ...input.filesChanged], input.cwd);
  // Test-weakening detection: consider the whole diff; any changed test file
  // makes assertion/expectation edits suspicious.
  const anyTestFileChanged = [...filesChangedReport, ...input.filesChanged].some((f) => isTestPath(f));
  const testWeakened = anyTestFileChanged ? detectTestWeakening(input.diffText, "tests/placeholder.test.ts") : { weakened: false, removed: false };
  const stubHeuristic = detectStub({ implementationLines, status }, input.diffText);
  const unverifiedClaim = status === "completed" && !gateRan && testsCommands === 0;
  const testNotRun = status === "completed" && !gateRan && testsCommands === 0 && !unverifiedClaim;

  return {
    gate: {
      ran: gateRan,
      passed: gateRan ? input.gate!.passed : false,
      steps: input.gate?.steps.length ?? 0,
      failedSteps: gateFailedSteps,
      errorTail: gateErrorTail,
    },
    report: {
      status,
      hasSummary: str(r.summary).trim().length > 0,
      filesChanged: filesChangedReport.length,
      implementationLines,
      testsCommands,
      testsPassed,
      testsFailed,
      validation: { lint, typecheck, build },
      acceptancePassed,
      acceptanceTotal,
      deviations,
      unresolved,
    },
    diff: {
      filesChanged: input.filesChanged.length,
      insertions: countDiffLines(input.diffText, "+"),
      deletions: countDiffLines(input.diffText, "-"),
    },
    flags: {
      silentFailure,
      scopeEscape: scopeEscape.escaped,
      testWeakened: testWeakened.weakened || testWeakened.removed,
      stubHeuristic,
      unverifiedClaim,
      testNotRun,
    },
  };
}

function countDiffLines(diffText: string, sign: "+" | "-"): number {
  if (!diffText) return 0;
  let n = 0;
  for (const l of diffText.split(/\r?\n/)) {
    if (l.startsWith(sign) && !l.startsWith(sign + sign)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideFinish(ev: FinishEvidence, policy: ReflexPolicy): FinishDecision {
  const f = policy.finish;
  const checks: FinishCheck[] = [];

  // Hard failures — no ambiguity, no model needed.
  if (ev.report.status === "failed") {
    return fail("executor_failed", "Executor reported status=failed", "finish.executor_failed");
  }
  if (ev.flags.silentFailure) {
    return fail("silent_failure", "No substantive executor report; cannot verify completion", "finish.silent_failure");
  }
  if (ev.gate.ran && !ev.gate.passed) {
    return fail("gate_failed", `Deterministic gate failed: ${ev.gate.failedSteps.join(", ") || "unknown step"}`, "finish.gate_failed");
  }
  if (ev.flags.scopeEscape) {
    return {
      verdict: "escalate",
      reason: "scope_escape",
      score: 0,
      checks: [],
      policyRule: "finish.scope_escape",
    };
  }

  // Evidence checklist. The deterministic gate is the authoritative signal:
  // when it ran and passed, supplementary checks (build/tests/acceptance)
  // act as confirmation and `not_run` does not penalize (the gate already
  // covered project validation). When the gate did NOT run, those checks are
  // the primary evidence and must be positive.
  const gatePassed = ev.gate.ran && ev.gate.passed;
  checks.push(check("gate", gatePassed, ev.gate.ran ? (ev.gate.passed ? "gate passed" : `gate failed: ${ev.gate.failedSteps.join(",")}`) : "gate not run"));
  checks.push(check(
    "build",
    gatePassed ? ev.report.validation.build !== "fail" : ev.report.validation.build === "pass",
    ev.report.validation.build === "pass" ? "build passed" : ev.report.validation.build === "fail" ? "build failed" : gatePassed ? "build not_run (gate covered validation)" : "build not_run",
  ));
  checks.push(check(
    "tests",
    gatePassed ? ev.report.testsFailed === 0 : ev.report.testsCommands > 0 && ev.report.testsFailed === 0,
    ev.report.testsFailed > 0 ? `${ev.report.testsFailed} failed` : ev.report.testsCommands === 0 ? (gatePassed ? "no test command (gate ran tests)" : "no test command") : `${ev.report.testsPassed} passed`,
  ));
  checks.push(check("files_changed", ev.report.filesChanged > 0 || ev.diff.filesChanged > 0, `report:${ev.report.filesChanged} diff:${ev.diff.filesChanged}`));
  checks.push(check("acceptance", ev.report.acceptanceTotal > 0 && ev.report.acceptancePassed === ev.report.acceptanceTotal, ev.report.acceptanceTotal === 0 ? "acceptance not run" : `${ev.report.acceptancePassed}/${ev.report.acceptanceTotal}`));

  // Red flags reduce the score but never auto-block (Judge may review).
  const redFlags = [
    ["test_weakened", ev.flags.testWeakened],
    ["stub_heuristic", ev.flags.stubHeuristic],
    ["unverified_claim", ev.flags.unverifiedClaim],
  ] as const;
  const redFlagNames = redFlags.filter(([, hit]) => hit).map(([n]) => n);

  const passed = checks.filter((c) => c.passed).length;
  const score = checks.length === 0 ? 0 : passed / checks.length;

  if (ev.flags.unverifiedClaim) {
    const missing = checks.filter((c) => !c.passed).map((c) => c.name);
    return {
      verdict: "needs_fix",
      reason: "unverified_claim",
      score,
      checks,
      hint: `Executor claimed completion without running validation. Run the deterministic gate (${missing.join(", ") || "test/lint/build"}) before claiming done.`,
      policyRule: "finish.unverified_claim",
    };
  }

  if (score >= f.complete_threshold && redFlagNames.length === 0) {
    return { verdict: "completed", reason: "evidence_satisfied", score, checks, policyRule: "finish.completed" };
  }
  if (score >= f.complete_threshold && redFlagNames.length > 0) {
    // Evidence looks complete but heuristics flag tampering risk → let Judge review.
    return {
      verdict: "needs_fix",
      reason: `flagged:${redFlagNames.join(",")}`,
      score,
      checks,
      hint: `Evidence checks passed but flagged (${redFlagNames.join(", ")}). Review the flagged diff before claiming done.`,
      policyRule: "finish.flagged",
    };
  }
  const missing = checks.filter((c) => !c.passed).map((c) => c.name);
  return {
    verdict: "needs_fix",
    reason: "insufficient_evidence",
    score,
    checks,
    hint: `Incomplete evidence: ${missing.join(", ") || "unknown"}. Complete these before the next report.`,
    policyRule: "finish.insufficient_evidence",
  };
}

// ---------------------------------------------------------------------------
// Jev-assisted Honest Finish
// ---------------------------------------------------------------------------

/** The state text we hand to Jev when the rule band is ambiguous. */
export function finishJevState(ev: FinishEvidence, checks: FinishCheck[]): string {
  const passed = checks.filter((c) => c.passed).map((c) => c.name).join(", ") || "none";
  const missing = checks.filter((c) => !c.passed).map((c) => c.name).join(", ") || "none";
  const flags = Object.entries(ev.flags)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ") || "none";
  return [
    `Executor report status=${ev.report.status}; gate ran=${ev.gate.ran} passed=${ev.gate.passed}; tests ${ev.report.testsPassed} passed ${ev.report.testsFailed} failed; build=${ev.report.validation.build}; acceptance ${ev.report.acceptancePassed}/${ev.report.acceptanceTotal}; files changed report=${ev.report.filesChanged} diff=${ev.diff.filesChanged}`,
    `Evidence checks passed: ${passed}`,
    `Evidence checks missing: ${missing}`,
    `Heuristic flags: ${flags}`,
    `stub=${ev.flags.stubHeuristic}, test_weakened=${ev.flags.testWeakened}, unverified=${ev.flags.unverifiedClaim}, scope_escape=${ev.flags.scopeEscape}`,
  ].join("\n");
}

/**
 * In Jev-first mode, the rule verdict is only a prior; the ambiguous band
 * (evidence present but below threshold, or flagged) asks Jev whether the
 * task is genuinely complete (`goal_met`) — 0.5s, ~$0.00002.
 *
 * Returns a plain FinishDecision; Jev answers are consumed via the callback.
 * When `jev` is undefined (backend=rule), falls back to the pure rule verdict.
 */
export async function decideFinishWithJev(
  ev: FinishEvidence,
  policy: ReflexPolicy,
  jev: ((req: { state: string; questions: Record<string, import("./backend.ts").S1Question> }) => Promise<{ goal_met: number } | undefined>) | undefined,
): Promise<FinishDecision> {
  const rule = decideFinish(ev, policy);
  if (!jev) return Promise.resolve(rule);

  const f = policy.finish;
  // Only the ambiguous band consults Jev: score in [jev_low_band, complete_threshold)
  // OR evidence-complete-but-flagged. Hard failures stay rule decisions.
  const ambiguous =
    rule.verdict === "needs_fix" &&
    rule.reason !== "silent_failure" &&
    rule.reason !== "executor_failed" &&
    rule.reason !== "gate_failed" &&
    (rule.score >= f.jev_low_band || rule.reason.startsWith("flagged"));
  if (!ambiguous) return Promise.resolve(rule);

  const state = finishJevState(ev, rule.checks);
  try {
    const res = await jev({
      state,
      questions: {
        goal_met: {
          type: "noul",
          instructions: "The user's goal appears to have been genuinely met, based on the recorded actions and outcomes, rather than merely claimed",
          criteria: { true: "真正完成", false: "未真正完成" },
        },
      },
    });
    if (res === undefined) return rule; // degraded / timeout → keep rule verdict
    const goalMet = res.goal_met;
    if (goalMet >= f.complete_threshold) {
      return { ...rule, verdict: "completed", reason: `jev_confirmed`, score: Math.max(rule.score, goalMet), policyRule: "finish.jev_confirmed" };
    }
    if (goalMet < f.jev_low_band) {
      return { ...rule, verdict: "needs_fix", reason: `jev_rejected:${rule.reason}`, score: rule.score, policyRule: "finish.jev_rejected" };
    }
    return rule;
  } catch {
    return rule; // Jev error → fall back to rule verdict (Bicameral degraded pattern)
  }
}

function fail(reason: string, hint: string, rule: string): FinishDecision {
  return { verdict: "needs_fix", reason, score: 0, checks: [], hint, policyRule: rule };
}

function check(name: string, passed: boolean, detail?: string): FinishCheck {
  return { name, passed, detail };
}
