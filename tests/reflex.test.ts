// =============================================================================
// Dual-Gate Reflex Layer — test suite
//
// Pure-logic tests for the deterministic reflex modules.
// Run: node --experimental-strip-types tests/reflex.test.ts
// =============================================================================

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_REFLEX_POLICY,
  normalizeReflexPolicy,
  mergeReflexPolicy,
} from "../extension/reflex/types.ts";
import {
  isTestPath,
  detectTestWeakening,
  detectStub,
  detectScopeEscape,
  buildFinishEvidence,
  decideFinish,
} from "../extension/reflex/finish.ts";
import {
  preSignals,
  compareState,
  decideStuck,
  firstErrorLine,
  pushWindow,
} from "../extension/reflex/progress.ts";
import { tierOf, scanTaskRisk, isOutsideCwd } from "../extension/reflex/risk-tier.ts";
import { decideLoop } from "../extension/reflex/policy.ts";
import { runReflexLayer, makeJevClient, formatReflexResult } from "../extension/reflex/index.ts";
import { JevBackend } from "../extension/reflex/backend.ts";

const P = DEFAULT_REFLEX_POLICY;

// =============================================================================
// risk-tier
// =============================================================================

function testRiskTier() {
  const cwd = "/tmp/proj";

  // LOW: read-only and common dev tools
  assert.equal(tierOf("read", { path: "/tmp/proj/a.ts" }, cwd).tier, "LOW");
  assert.equal(tierOf("grep", { path: "/tmp/proj" }, cwd).tier, "LOW");
  assert.equal(tierOf("edit", { path: "/tmp/proj/a.ts" }, cwd).tier, "LOW");
  assert.equal(tierOf("write", { path: "/tmp/proj/a.ts" }, cwd).tier, "LOW");
  assert.equal(tierOf("bash", { command: "npm test" }, cwd).tier, "LOW");
  assert.equal(tierOf("bash", { command: "git status" }, cwd).tier, "LOW");

  // CRITICAL: destructive
  assert.equal(tierOf("bash", { command: "rm -rf node_modules" }, cwd).tier, "CRITICAL");
  assert.equal(tierOf("bash", { command: "git reset --hard HEAD~1" }, cwd).tier, "CRITICAL");
  assert.equal(tierOf("bash", { command: "git clean -fd" }, cwd).tier, "CRITICAL");
  assert.equal(tierOf("bash", { command: "git push --force origin main" }, cwd).tier, "CRITICAL");
  assert.equal(tierOf("bash", { command: "rm -r dist" }, cwd).tier, "CRITICAL");

  // HIGH: network / sudo / credentials / system
  assert.equal(tierOf("bash", { command: "git push origin main" }, cwd).tier, "HIGH");
  assert.equal(tierOf("bash", { command: "curl -s http://example.com" }, cwd).tier, "HIGH");
  assert.equal(tierOf("bash", { command: "sudo apt update" }, cwd).tier, "HIGH");
  assert.equal(tierOf("bash", { command: "cat .env" }, cwd).tier, "HIGH");
  assert.equal(tierOf("bash", { command: "chmod 777 script.sh" }, cwd).tier, "HIGH");
  assert.equal(tierOf("bash", { command: "systemctl restart nginx" }, cwd).tier, "HIGH");

  // MEDIUM: package install / non-recursive rm / forced ops
  assert.equal(tierOf("bash", { command: "npm install lodash" }, cwd).tier, "MEDIUM");
  assert.equal(tierOf("bash", { command: "pip install flask" }, cwd).tier, "MEDIUM");
  assert.equal(tierOf("bash", { command: "rm old.txt" }, cwd).tier, "MEDIUM");
  assert.equal(tierOf("bash", { command: "git stash pop" }, cwd).tier, "MEDIUM");

  // Path outside cwd → HIGH regardless of tool
  assert.equal(tierOf("edit", { path: "/etc/hosts" }, cwd).tier, "HIGH");
  assert.equal(tierOf("write", { path: "/tmp/outside/x.ts" }, cwd).tier, "HIGH");

  // Unknown shell command → MEDIUM (conservative)
  assert.equal(tierOf("bash", { command: "obscure-tool --flag" }, cwd).tier, "MEDIUM");

  // Task-level intent scan: natural-language tasks are unclassified shell
  // text → MEDIUM (conservative, recorded but never interrupts); destructive
  // intent keywords raise to HIGH.
  assert.equal(scanTaskRisk("please delete the entire project and reset --hard", cwd).tier, "HIGH");
  assert.equal(scanTaskRisk("implement a small feature in src/", cwd).tier, "MEDIUM");
  assert.equal(scanTaskRisk("add tests for the parser", cwd).tier, "MEDIUM");

  // isOutsideCwd
  assert.equal(isOutsideCwd("/tmp/proj/src/a.ts", cwd), false);
  assert.equal(isOutsideCwd("../outside.ts", cwd), true);
  assert.equal(isOutsideCwd("/etc/hosts", cwd), true);
}

// =============================================================================
// finish.ts
// =============================================================================

function testIsTestPath() {
  assert.ok(isTestPath("tests/test_a.py"));
  assert.ok(isTestPath("src/foo.test.ts"));
  assert.ok(isTestPath("src/__tests__/a.ts"));
  assert.ok(isTestPath("src/foo.spec.jsx"));
  assert.ok(!isTestPath("src/foo.ts"));
  assert.ok(!isTestPath("lib/helper.py"));
}

function testDetectTestWeakening() {
  // Removing an assertion in a test file
  const r1 = detectTestWeakening("-  assert.equal(x, 3)\n+  assert.equal(x, 2)", "tests/test_a.py");
  assert.ok(r1.weakened, "removing/changing assertion should flag weakened");
  // Skipping a test
  const r2 = detectTestWeakening("+  it.skip('does nothing', () => {})", "src/foo.test.ts");
  assert.ok(r2.weakened);
  // Removing a whole test file (all lines removed, none added)
  const r3 = detectTestWeakening("-test one\n-test two", "tests/test_a.py");
  assert.ok(r3.removed, "deleting a test file should flag removed");
  // Non-test file: no flag
  const r4 = detectTestWeakening("-  assert.equal(x, 3)\n+  assert.equal(x, 2)", "src/foo.ts");
  assert.equal(r4.weakened, false);
}

function testDetectStub() {
  assert.ok(detectStub({ implementationLines: 1, status: "completed" }, "TODO: implement"));
  assert.ok(detectStub({ implementationLines: 1, status: "completed" }, "return null; // todo"));
  assert.ok(!detectStub({ implementationLines: 10, status: "completed" }, "full implementation here"));
}

function testDetectScopeEscape() {
  const cwd = "/tmp/proj";
  const r = detectScopeEscape(["/etc/hosts", "src/a.ts"], cwd);
  assert.ok(r.escaped);
  assert.deepEqual(r.paths, ["/etc/hosts"]);
  const r2 = detectScopeEscape(["src/a.ts", "tests/b.ts"], cwd);
  assert.equal(r2.escaped, false);
}

function testDecideFinish() {
  const mkGate = (passed: boolean, steps = [{ name: "npm:test", passed, skipped: false }]) => ({
    passed,
    steps,
  });
  const mkReport = (over: Record<string, unknown> = {}) => ({
    status: "completed",
    summary: "implemented feature",
    files_changed: [{ path: "src/a.ts", purpose: "impl" }],
    implementation: ["added parser"],
    tests: { commands: ["npm test"], passed: ["npm test"], failed: [] },
    validation: { lint: "pass", typecheck: "pass", build: "pass" },
    acceptance_check: { criterion1: "pass", criterion2: "pass" },
    deviations: [],
    unresolved: [],
    risks: [],
    ...over,
  });

  // Silent failure
  const d1 = decideFinish(buildFinishEvidence({ report: {}, gate: null, diffText: "", filesChanged: [], cwd: "/tmp/proj" }), P);
  assert.equal(d1.verdict, "needs_fix");
  assert.equal(d1.reason, "silent_failure");

  // status=failed
  const d2 = decideFinish(buildFinishEvidence({ report: mkReport({ status: "failed" }), gate: null, diffText: "", filesChanged: [], cwd: "/tmp/proj" }), P);
  assert.equal(d2.verdict, "needs_fix");
  assert.equal(d2.reason, "executor_failed");

  // Gate failed
  const d3 = decideFinish(buildFinishEvidence({ report: mkReport(), gate: mkGate(false), diffText: "", filesChanged: [], cwd: "/tmp/proj" }), P);
  assert.equal(d3.verdict, "needs_fix");
  assert.equal(d3.reason, "gate_failed");

  // Scope escape
  const d4 = decideFinish(buildFinishEvidence({ report: mkReport({ files_changed: [{ path: "/etc/hosts", purpose: "x" }] }), gate: mkGate(true), diffText: "", filesChanged: [], cwd: "/tmp/proj" }), P);
  assert.equal(d4.verdict, "escalate");

  // Unverified claim: completed but no gate, no tests
  const d5 = decideFinish(buildFinishEvidence({ report: mkReport({ tests: { commands: [], passed: [], failed: [] }, validation: { lint: "not_run", typecheck: "not_run", build: "not_run" }, acceptance_check: {} }), gate: null, diffText: "", filesChanged: [], cwd: "/tmp/proj" }), P);
  assert.equal(d5.verdict, "needs_fix");
  assert.equal(d5.reason, "unverified_claim");

  // Fully verified → completed
  const d6 = decideFinish(buildFinishEvidence({ report: mkReport(), gate: mkGate(true), diffText: "diff", filesChanged: ["src/a.ts"], cwd: "/tmp/proj" }), P);
  assert.equal(d6.verdict, "completed");
  assert.ok(d6.score >= 0.8);

  // Incomplete evidence (acceptance not run, no files changed)
  const d7 = decideFinish(buildFinishEvidence({ report: mkReport({ files_changed: [], acceptance_check: {} }), gate: mkGate(true), diffText: "", filesChanged: [], cwd: "/tmp/proj" }), P);
  assert.equal(d7.verdict, "needs_fix");
  assert.equal(d7.reason, "insufficient_evidence");

  // Evidence ok but test-weakened flag → needs_fix (flagged)
  const weakReport = mkReport();
  const weak = decideFinish(buildFinishEvidence({
    report: weakReport,
    gate: mkGate(true),
    diffText: "-  assert.equal(x, 3)\n+  assert.equal(x, 2)",
    filesChanged: ["tests/test_a.py"],
    cwd: "/tmp/proj",
  }), P);
  // buildFinishEvidence detects testWeakened only when diffText has a test path;
  // here filesChanged has the test path but diffText has no file header, so
  // detectTestWeakening("", "tests/test_a.py") should still flag via path.
  assert.equal(weak.verdict, "needs_fix");
}

// =============================================================================
// progress.ts
// =============================================================================

function testPreSignals() {
  // Identical command + error
  const turns: Parameters<typeof preSignals>[0] = [
    { toolName: "bash", argsSummary: "npm test", isError: true, errorLine: "Error: ENOENT" },
    { toolName: "bash", argsSummary: "npm test", isError: true, errorLine: "Error: ENOENT" },
  ];
  const s1 = preSignals(turns, 3);
  assert.ok(s1.some((s) => s.type === "identical_command_error"));

  // Different error line → no signal
  const s2 = preSignals([
    { toolName: "bash", argsSummary: "npm test", isError: true, errorLine: "Error: A" },
    { toolName: "bash", argsSummary: "npm test", isError: true, errorLine: "Error: B" },
  ], 3);
  assert.equal(s2.some((s) => s.type === "identical_command_error"), false);

  // Oscillation: same file flipped between 2 hunks 3+ times
  const osc: Parameters<typeof preSignals>[0] = [
    { toolName: "edit", argsSummary: "a.ts", isError: false, filesEdited: [{ path: "a.ts", hunkHash: "h1" }] },
    { toolName: "edit", argsSummary: "a.ts", isError: false, filesEdited: [{ path: "a.ts", hunkHash: "h2" }] },
    { toolName: "edit", argsSummary: "a.ts", isError: false, filesEdited: [{ path: "a.ts", hunkHash: "h1" }] },
    { toolName: "edit", argsSummary: "a.ts", isError: false, filesEdited: [{ path: "a.ts", hunkHash: "h2" }] },
  ];
  const s3 = preSignals(osc, 3);
  assert.ok(s3.some((s) => s.type === "oscillation"), "4 edits across 2 hunks should oscillate");
}

function testCompareState() {
  const mk = (over: Partial<import("../extension/reflex/types.ts").IterationState> = {}) => ({
    iteration: 1,
    filesChanged: ["a.ts"],
    testsPassed: 0,
    testsFailed: 0,
    buildStatus: "pass" as const,
    errorSignature: "",
    diffSize: 10,
    requirementsCompleted: 0,
    requirementsTotal: 3,
    ...over,
  });

  // tests 8→5→2 = PROGRESS even while failing
  const t1 = compareState(mk({ testsFailed: 8, errorSignature: "E1" }), mk({ testsFailed: 5, errorSignature: "E1" }));
  assert.equal(t1.trend, "PROGRESS");
  const t2 = compareState(mk({ testsFailed: 5, errorSignature: "E1" }), mk({ testsFailed: 2, errorSignature: "E1" }));
  assert.equal(t2.trend, "PROGRESS");

  // 5→5→5 same error = NO_PROGRESS
  const t3 = compareState(mk({ testsFailed: 5, errorSignature: "E1" }), mk({ testsFailed: 5, errorSignature: "E1" }));
  assert.equal(t3.trend, "NO_PROGRESS");

  // build pass→fail = REGRESSION
  const t4 = compareState(mk({ buildStatus: "pass", testsFailed: 0 }), mk({ buildStatus: "fail", testsFailed: 0 }));
  assert.equal(t4.trend, "REGRESSION");

  // error signature changed but tests same = PROGRESS (debugging moves)
  const t5 = compareState(mk({ testsFailed: 5, errorSignature: "E1" }), mk({ testsFailed: 5, errorSignature: "E2" }));
  assert.equal(t5.trend, "PROGRESS");

  // requirements completed rises = PROGRESS
  const t6 = compareState(mk({ requirementsCompleted: 1, errorSignature: "E1" }), mk({ requirementsCompleted: 2, errorSignature: "E1" }));
  assert.equal(t6.trend, "PROGRESS");

  // first iteration (no prev) = PROGRESS baseline
  const t7 = compareState(undefined, mk());
  assert.equal(t7.trend, "PROGRESS");
}

function testDecideStuck() {
  const mk = (over: Partial<import("../extension/reflex/types.ts").IterationState> = {}) => ({
    iteration: 1, filesChanged: [], testsFailed: 0, buildStatus: "pass" as const,
    errorSignature: "", diffSize: 0, requirementsCompleted: 0, requirementsTotal: 0, ...over,
  });

  // Healthy progress → OK
  const d1 = decideStuck({ prev: mk({ testsFailed: 8 }), curr: mk({ testsFailed: 5 }), turns: [], history: { noProgressStreak: 0, sameErrorStreak: 0 }, policy: P });
  assert.equal(d1.verdict, "OK");

  // Oscillation → STUCK
  const d2 = decideStuck({ prev: mk(), curr: mk(), turns: [
    { toolName: "edit", argsSummary: "a.ts", isError: false, filesEdited: [{ path: "a.ts", hunkHash: "h1" }] },
    { toolName: "edit", argsSummary: "a.ts", isError: false, filesEdited: [{ path: "a.ts", hunkHash: "h2" }] },
    { toolName: "edit", argsSummary: "a.ts", isError: false, filesEdited: [{ path: "a.ts", hunkHash: "h1" }] },
    { toolName: "edit", argsSummary: "a.ts", isError: false, filesEdited: [{ path: "a.ts", hunkHash: "h2" }] },
  ], history: { noProgressStreak: 0, sameErrorStreak: 0 }, policy: P });
  assert.equal(d2.verdict, "STUCK");

  // Repeated identical error + no progress → STUCK
  const d3 = decideStuck({ prev: mk({ errorSignature: "E1", testsFailed: 5 }), curr: mk({ errorSignature: "E1", testsFailed: 5 }), turns: [
    { toolName: "bash", argsSummary: "npm test", isError: true, errorLine: "E1" },
    { toolName: "bash", argsSummary: "npm test", isError: true, errorLine: "E1" },
  ], history: { noProgressStreak: 2, sameErrorStreak: 1 }, policy: P });
  assert.equal(d3.verdict, "STUCK");

  // no_progress_stuck_after=3 → WATCH at 2, STUCK at 3
  const d4 = decideStuck({ prev: mk({ errorSignature: "E1", testsFailed: 5 }), curr: mk({ errorSignature: "E1", testsFailed: 5 }), turns: [], history: { noProgressStreak: 1, sameErrorStreak: 1 }, policy: P });
  assert.equal(d4.verdict, "WATCH");
  const d5 = decideStuck({ prev: mk({ errorSignature: "E1", testsFailed: 5 }), curr: mk({ errorSignature: "E1", testsFailed: 5 }), turns: [], history: { noProgressStreak: 2, sameErrorStreak: 2 }, policy: P });
  assert.equal(d5.verdict, "STUCK");

  // Normal debug: error changed → OK even if tests still failing
  const d6 = decideStuck({ prev: mk({ errorSignature: "E1", testsFailed: 5 }), curr: mk({ errorSignature: "E2", testsFailed: 4 }), turns: [], history: { noProgressStreak: 0, sameErrorStreak: 0 }, policy: P });
  assert.equal(d6.verdict, "OK");
}

function testFirstErrorLine() {
  assert.equal(firstErrorLine("  \nError: boom\n  at x"), "Error: boom");
  assert.equal(firstErrorLine(""), "");
}

function testPushWindow() {
  const w = pushWindow([1, 2, 3], 4, 3);
  assert.deepEqual(w, [2, 3, 4]);
}

// =============================================================================
// policy.ts (decideLoop)
// =============================================================================

function testDecideLoop() {
  const baseCtx = { retryCount: 0, maxRetries: 3, totalIterations: 1, sameErrorStreak: 0, noProgressStreak: 0 };
  const finish = (verdict: "completed" | "needs_fix" | "escalate", reason: string): Parameters<typeof decideLoop>[0]["finish"] => ({
    verdict, reason, score: verdict === "completed" ? 0.9 : 0.4, checks: [], policyRule: `finish.${reason}`,
  });

  // CONTINUE on progress
  const c1 = decideLoop({ finish: finish("completed", "evidence_satisfied"), trend: "PROGRESS", stuck: { verdict: "OK", reason: "ok", policyRule: "stuck.ok" }, riskTier: "LOW", ctx: baseCtx, policy: P });
  assert.equal(c1.action, "CONTINUE");

  // RETRY on needs_fix
  const c2 = decideLoop({ finish: finish("needs_fix", "gate_failed"), trend: "NO_PROGRESS", stuck: { verdict: "OK", reason: "ok", policyRule: "stuck.ok" }, riskTier: "LOW", ctx: baseCtx, policy: P });
  assert.equal(c2.action, "RETRY");

  // ESCALATE on finish escalate
  const c3 = decideLoop({ finish: finish("escalate", "scope_escape"), trend: "PROGRESS", stuck: { verdict: "OK", reason: "ok", policyRule: "stuck.ok" }, riskTier: "LOW", ctx: baseCtx, policy: P });
  assert.equal(c3.action, "ESCALATE");

  // ESCALATE on CRITICAL risk
  const c4 = decideLoop({ finish: finish("completed", "evidence_satisfied"), trend: "PROGRESS", stuck: { verdict: "OK", reason: "ok", policyRule: "stuck.ok" }, riskTier: "CRITICAL", ctx: baseCtx, policy: P });
  assert.equal(c4.action, "ESCALATE");

  // RETRY_WITH_HINT on STUCK
  const c5 = decideLoop({ finish: finish("completed", "evidence_satisfied"), trend: "NO_PROGRESS", stuck: { verdict: "STUCK", reason: "oscillation", hint: "pick one", policyRule: "stuck.oscillation" }, riskTier: "LOW", ctx: baseCtx, policy: P });
  assert.equal(c5.action, "RETRY_WITH_HINT");

  // ESCALATE: stuck + sameErrorStreak >= 3
  const c6 = decideLoop({ finish: finish("completed", "evidence_satisfied"), trend: "NO_PROGRESS", stuck: { verdict: "STUCK", reason: "no_progress", policyRule: "stuck.no_progress" }, riskTier: "LOW", ctx: { ...baseCtx, sameErrorStreak: 3 }, policy: P });
  assert.equal(c6.action, "ESCALATE");

  // ESCALATE: regression after retries
  const c7 = decideLoop({ finish: finish("completed", "evidence_satisfied"), trend: "REGRESSION", stuck: { verdict: "OK", reason: "ok", policyRule: "stuck.ok" }, riskTier: "LOW", ctx: { ...baseCtx, retryCount: 3, maxRetries: 3 }, policy: P });
  assert.equal(c7.action, "ESCALATE");
}

// =============================================================================
// policy (types.ts) — normalization / merge
// =============================================================================

function testPolicyNormalization() {
  const p = normalizeReflexPolicy({ mode: "enforce", finish: { complete_threshold: 0.9 }, progress: { window: 6 } });
  assert.equal(p.mode, "enforce");
  assert.equal(p.finish.complete_threshold, 0.9);
  assert.equal(p.progress.window, 6);
  assert.equal(p.risk.critical_confirm, DEFAULT_REFLEX_POLICY.risk.critical_confirm);

  const merged = mergeReflexPolicy(DEFAULT_REFLEX_POLICY, { finish: { complete_threshold: 0.5 } });
  assert.equal(merged.finish.complete_threshold, 0.5);
  assert.equal(merged.progress.window, DEFAULT_REFLEX_POLICY.progress.window);
  assert.notEqual(merged, DEFAULT_REFLEX_POLICY); // no mutation
}

// =============================================================================
// runReflexLayer (index.ts)
// =============================================================================

async function testRunReflexLayer() {
  const base = {
    policy: P,
    iteration: 1,
    report: {
      status: "completed",
      summary: "did it",
      files_changed: [{ path: "src/a.ts", purpose: "impl" }],
      implementation: ["added parser"],
      tests: { commands: ["npm test"], passed: ["npm test"], failed: [] },
      validation: { lint: "pass", typecheck: "pass", build: "pass" },
      acceptance_check: { c1: "pass" },
      deviations: [], unresolved: [], risks: [],
    },
    gate: { passed: true, steps: [{ name: "npm:test", passed: true, skipped: false }] },
    diffText: "diff",
    filesChanged: ["src/a.ts"],
    cwd: "/tmp/proj",
    state: {
      iteration: 1, filesChanged: ["src/a.ts"], testsPassed: 1, testsFailed: 0,
      buildStatus: "pass" as const, errorSignature: "", diffSize: 10, requirementsCompleted: 1, requirementsTotal: 1,
    },
    turns: [],
    history: { noProgressStreak: 0, sameErrorStreak: 0 },
    ctx: { retryCount: 0, maxRetries: 3, totalIterations: 1 },
  };

  const r = await runReflexLayer(base);
  assert.equal(r.finish?.verdict, "completed");
  assert.equal(r.trend, "PROGRESS");
  assert.equal(r.stuck.verdict, "OK");
  assert.equal(r.loop.action, "CONTINUE");
  assert.ok(formatReflexResult(r).includes("loop=CONTINUE"));
}

// =============================================================================
// Jev integration (fake backend, no CLI)
// =============================================================================

/** A fake JevBackend that returns scripted nouls without touching the CLI. */
function fakeJevClient(scripted: Record<string, number>): ReturnType<typeof makeJevClient> {
  const backend: JevBackend = {
    name: "fake-jev",
    async decide(req) {
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const [name] of Object.entries(req.questions)) {
        answers[name] = { type: "noul", noul: scripted[name] ?? 0.5 };
      }
      return { answers: answers as never, latencyMs: 0, source: "jev" };
    },
  } as unknown as JevBackend;
  return makeJevClient(backend, P);
}

async function testJevFinishAmbiguous() {
  // Evidence below threshold (score 0.6: gate+build+files pass, tests FAIL,
  // acceptance not run) but above jev_low_band (0.6) and not a hard failure
  // → Jev decides goal_met.
  const evBase = {
    policy: { ...P, finish: { ...P.finish, complete_threshold: 0.8, jev_low_band: 0.6 } },
    iteration: 1,
    report: {
      status: "completed", summary: "did it",
      files_changed: [{ path: "src/a.ts", purpose: "impl" }],
      implementation: ["x"],
      tests: { commands: ["npm test"], passed: [], failed: ["npm test"] },
      validation: { lint: "pass", typecheck: "pass", build: "pass" },
      acceptance_check: {},
      deviations: [], unresolved: [], risks: [],
    },
    gate: { passed: true, steps: [{ name: "npm:test", passed: true, skipped: false }] },
    diffText: "", filesChanged: ["src/a.ts"], cwd: "/tmp/proj",
    state: {
      iteration: 1, filesChanged: ["src/a.ts"], testsPassed: 0, testsFailed: 0,
      buildStatus: "pass" as const, errorSignature: "", diffSize: 5, requirementsCompleted: 0, requirementsTotal: 0,
    },
    turns: [], history: { noProgressStreak: 0, sameErrorStreak: 0 },
    ctx: { retryCount: 0, maxRetries: 3, totalIterations: 1 },
  };

  // Rule alone: score 0.6 → insufficient_evidence (needs_fix).
  const ruleOnly = await runReflexLayer({ ...evBase, jev: undefined });
  assert.equal(ruleOnly.finish?.verdict, "needs_fix");

  // Jev goal_met=0.95 → confirmed completed.
  const jevYes = await runReflexLayer({ ...evBase, jev: fakeJevClient({ goal_met: 0.95 }) });
  assert.equal(jevYes.finish?.verdict, "completed");
  assert.ok(jevYes.jevConsulted.includes("finish"));

  // Jev goal_met=0.2 → rejected.
  const jevNo = await runReflexLayer({ ...evBase, jev: fakeJevClient({ goal_met: 0.2 }) });
  assert.equal(jevNo.finish?.verdict, "needs_fix");
  assert.ok(jevNo.finish?.reason.startsWith("jev_rejected"));

  // Jev degraded (returns undefined) → falls back to rule verdict.
  const jevDegraded = await runReflexLayer({ ...evBase, jev: { ask: async () => undefined } });
  assert.equal(jevDegraded.finish?.verdict, "needs_fix");
}

async function testJevStuckAmbiguous() {
  // NO_PROGRESS streak >= jev_after (2) and rule is WATCH → Jev no_progress decides.
  const base = {
    policy: P,
    iteration: 3,
    report: {
      status: "completed", summary: "x", files_changed: [], implementation: [],
      tests: { commands: [], passed: [], failed: [] },
      validation: { lint: "not_run", typecheck: "not_run", build: "not_run" },
      acceptance_check: {}, deviations: [], unresolved: [], risks: [],
    },
    gate: null, diffText: "", filesChanged: [], cwd: "/tmp/proj",
    state: {
      iteration: 3, filesChanged: [], testsFailed: 5, buildStatus: "not_run" as const,
      errorSignature: "E1", diffSize: 0, requirementsCompleted: 0, requirementsTotal: 0,
    },
    prevState: {
      iteration: 2, filesChanged: [], testsFailed: 5, buildStatus: "not_run" as const,
      errorSignature: "E1", diffSize: 0, requirementsCompleted: 0, requirementsTotal: 0,
    },
    turns: [],
    history: { noProgressStreak: 1, sameErrorStreak: 1 },
    ctx: { retryCount: 1, maxRetries: 3, totalIterations: 3 },
  };

  // Rule alone: no_progress streak 1 + current NO_PROGRESS → internal 2 = WATCH (below stuck_after=3).
  const ruleOnly = await runReflexLayer({ ...base, jev: undefined });
  assert.equal(ruleOnly.stuck.verdict, "WATCH");

  // Jev no_progress=0.85 → STUCK.
  const jevStuck = await runReflexLayer({ ...base, jev: fakeJevClient({ no_progress: 0.85 }) });
  assert.equal(jevStuck.stuck.verdict, "STUCK");
  assert.ok(jevStuck.jevConsulted.includes("progress"));

  // Jev no_progress=0.3 → stays WATCH.
  const jevNotStuck = await runReflexLayer({ ...base, jev: fakeJevClient({ no_progress: 0.3 }) });
  assert.equal(jevNotStuck.stuck.verdict, "WATCH");
}

function testPolicyBackendField() {
  const p = normalizeReflexPolicy({ backend: "jev", jev_deadline_ms: 1500 });
  assert.equal(p.backend, "jev");
  assert.equal(p.jev_deadline_ms, 1500);
  assert.equal(p.finish.jev_low_band, DEFAULT_REFLEX_POLICY.finish.jev_low_band);
  const p2 = normalizeReflexPolicy({ backend: "bogus" });
  assert.equal(p2.backend, "hybrid");
}

// =============================================================================
// Integration: ambiguous-band evidence → Jev consulted → RETRY (mimics the
// orchestrate() wiring where reflex runs after gate, before GPT-5.6 Judge)
// =============================================================================

async function testJevBandRetryFlow() {
  // score = 3/5 checks: gate ✓, build ✓, files ✓; tests FAILED (1 fail),
  // acceptance not run → lands in [0.6, 0.8) ambiguous band → Jev goal_met decides.
  const report = {
    status: "completed", summary: "implemented",
    files_changed: [{ path: "src/feature.ts", purpose: "impl" }],
    implementation: ["added feature"],
    tests: { commands: ["npm test"], passed: [], failed: ["npm test"] },
    validation: { lint: "pass", typecheck: "pass", build: "pass" },
    acceptance_check: {},
    deviations: [], unresolved: [], risks: [],
  };
  const state: import("../extension/reflex/types.ts").IterationState = {
    iteration: 1, filesChanged: ["src/feature.ts"], testsPassed: 0, testsFailed: 1,
    buildStatus: "pass", errorSignature: "", diffSize: 10, requirementsCompleted: 0, requirementsTotal: 0,
  };
  const base = {
    policy: P, iteration: 1, report, gate: { passed: true, steps: [{ name: "npm:test", passed: true, skipped: false }] },
    diffText: "diff --git a/src/feature.ts b/src/feature.ts", filesChanged: ["src/feature.ts"], cwd: "/tmp/proj",
    prevState: undefined, state, turns: [], history: { noProgressStreak: 0, sameErrorStreak: 0 },
    ctx: { retryCount: 0, maxRetries: 3, totalIterations: 1 },
  };

  // Without Jev: rule alone → needs_fix (score 0.6 in band but rule lacks Jev override).
  const ruleOnly = await runReflexLayer({ ...base, jev: undefined });
  assert.equal(ruleOnly.finish?.verdict, "needs_fix");
  assert.equal(ruleOnly.loop.action, "RETRY");
  assert.equal(ruleOnly.jevConsulted.length, 0);

  // With Jev rejecting (goal_met=0.3) → RETRY, Jev consulted.
  const jevReject = await runReflexLayer({ ...base, jev: fakeJevClient({ goal_met: 0.3 }) });
  assert.equal(jevReject.finish?.verdict, "needs_fix");
  assert.equal(jevReject.loop.action, "RETRY");
  assert.ok(jevReject.jevConsulted.includes("finish"));

  // With Jev confirming (goal_met=0.9) → completed → CONTINUE to Judge.
  const jevConfirm = await runReflexLayer({ ...base, jev: fakeJevClient({ goal_met: 0.9 }) });
  assert.equal(jevConfirm.finish?.verdict, "completed");
  assert.equal(jevConfirm.loop.action, "CONTINUE");
  assert.ok(jevConfirm.jevConsulted.includes("finish"));
}

// =============================================================================
// Runner
// =============================================================================

const tests: Array<[string, () => void | Promise<void>]> = [
  ["risk-tier", testRiskTier],
  ["isTestPath", testIsTestPath],
  ["detectTestWeakening", testDetectTestWeakening],
  ["detectStub", testDetectStub],
  ["detectScopeEscape", testDetectScopeEscape],
  ["decideFinish", testDecideFinish],
  ["preSignals", testPreSignals],
  ["compareState", testCompareState],
  ["decideStuck", testDecideStuck],
  ["firstErrorLine", testFirstErrorLine],
  ["pushWindow", testPushWindow],
  ["decideLoop", testDecideLoop],
  ["policy normalization/merge", testPolicyNormalization],
  ["policy backend field", testPolicyBackendField],
  ["jev band retry flow", testJevBandRetryFlow],
  ["runReflexLayer", testRunReflexLayer],
  ["jev finish ambiguous", testJevFinishAmbiguous],
  ["jev stuck ambiguous", testJevStuckAmbiguous],
];

let failures = 0;
async function main() {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures++;
      console.error(`  ✗ ${name}`);
      console.error(e instanceof Error ? `    ${e.message}` : e);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed${failures ? `, ${failures} failed` : ""}`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
