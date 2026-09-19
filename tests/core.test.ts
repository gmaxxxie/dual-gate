// =============================================================================
// Dual-Gate Orchestrator — test suite
//
// Pure-logic tests: state machine, config, convergence, parsing, gate discovery.
// Run: node --experimental-strip-types tests/core.test.ts
// =============================================================================

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  normalizeConfig,
  isThinking,
  resolveModelString,
  findAvailableAuthenticatedModel,
  generateTaskId,
  derivePanelTitle,
  deriveAgentName,
  detectRisk,
  STATE_TRANSITIONS,
  assertTransition,
  TaskManager,
  sameJudgeGaps,
  trackConvergence,
  buildExecutorPrompt,
  buildJudgePrompt,
  buildSpecRevisionPrompt,
  buildConvergenceDiagnosisPrompt,
  extractYamlBlock,
  parseTolerantYaml,
  normalizeReport,
  extractReportFromAgentMessage,
  parseJudgeOutput,
  parseContractYaml,
  parseSpecRevision,
  parseConvergenceDiagnosis,
  createArtifactStore,
  taskDirFor,
  generateProjectId,
  projectDirFor,
  projectMilestoneDirFor,
  loadProjectsFromDisk,
  parseProjectPlan,
  validateProjectPlan,
  topologicallyOrderMilestones,
  scheduleMilestoneBatches,
  isParallelBatch,
  milestoneToAcceptanceContract,
  buildProjectPlanPrompt,
  buildProductManagerPlanPrompt,
  buildMilestoneCompletionFeedbackPrompt,
  buildProductAcceptancePrompt,
  buildProductManagerRecoveryPrompt,
  productManagerPiArgs,
  extractCorrelatedYamlBlock,
  parseProductMilestoneFeedback,
  buildProjectAcceptancePrompt,
  parseProjectAcceptance,
  isActiveProjectState,
  isProjectFinalizationStopped,
  canAcceptProject,
  buildSpecUpdatePrompt,
  buildExecutorCheckpoint,
  buildRecoveryPrompt,
} from "../extension/core.ts";
import { discoverGateCommands, runGate, formatGateResult, skippedGateResult } from "../extension/gate.ts";
import { decideLane, type TriageConfig } from "../extension/triage.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(
        () => { passed++; },
        (e) => { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); },
      );
    } else {
      passed++;
    }
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------

test("config defaults", () => {
  const c = normalizeConfig(null);
  assert.equal(c.enabled, false);  // default OFF — user opts in with /dual on
  assert.equal(c.controller.model, "openai-codex/gpt-5.6-sol");
  assert.equal(c.controller.thinking, "medium");
  assert.equal(c.executor.model, "new-api/deepseek-v4-flash");
  assert.equal(c.product_manager.model, "default");
  assert.equal(c.gate.max_retries, 3);
  assert.equal(c.judge.max_retries, 2);
  assert.equal(c.loop.max_iterations, 5);
  assert.equal(c.panel.on_complete, "keep");
  assert.equal(c.worktree.mode, "auto");
});

test("config normalize partial", () => {
  const c = normalizeConfig({ enabled: false, controller: { model: "kimi-k3", thinking: "high" } });
  assert.equal(c.enabled, false);
  assert.equal(c.controller.model, "kimi-k3");
  assert.equal(c.controller.thinking, "high");
  // untouched defaults preserved
  assert.equal(c.gate.max_retries, 3);
  assert.equal(c.executor.model, "new-api/deepseek-v4-flash");
  assert.equal(c.product_manager.model, "default"); // legacy config remains safe
});

test("product manager config accepts only nonempty model values", () => {
  assert.equal(normalizeConfig({ product_manager: { model: "provider/pm" } } as any).product_manager.model, "provider/pm");
  assert.equal(normalizeConfig({ product_manager: { model: "  " } } as any).product_manager.model, "default");
});

test("config rejects invalid values", () => {
  const c = normalizeConfig({ gate: { max_retries: -5 }, controller: { thinking: "nonsense" as any }, loop: { max_iterations: 0 } });
  assert.equal(c.gate.max_retries, 3);
  assert.equal(c.controller.thinking, "medium");
  assert.equal(c.loop.max_iterations, 5);
});

test("triage config defaults and normalization", () => {
  const d = normalizeConfig(null).triage;
  assert.equal(d.mode, "observe"); // decide + log, no behavior change
  assert.equal(d.gate, 0.5);
  assert.equal(d.excerpt_chars, 2000);
  assert.equal(d.timeout_ms, 8000);
  assert.equal(d.interactive_only, true); // only TUI typing is intercepted

  const c = normalizeConfig({ triage: { mode: "enforce", gate: 0.7, interactive_only: false } } as any).triage;
  assert.equal(c.mode, "enforce");
  assert.equal(c.gate, 0.7);
  assert.equal(c.interactive_only, false);
  assert.equal(c.excerpt_chars, 2000); // untouched default preserved

  const bad = normalizeConfig({ triage: { mode: "bogus", gate: 5, excerpt_chars: -1, timeout_ms: 0 } } as any).triage;
  assert.equal(bad.mode, "observe");
  assert.equal(bad.gate, 0.5);
  assert.equal(bad.excerpt_chars, 2000);
  assert.equal(bad.timeout_ms, 8000);
});

test("triage lane gate holds uncertain lanes at pipeline (fail-closed)", () => {
  const cfg: TriageConfig = { mode: "enforce", gate: 0.5, excerpt_chars: 2000, timeout_ms: 8000, interactive_only: true };
  const choice = (c: string, conf: number) => ({ lane: { type: "choice" as const, choice: c, confidence: conf, probabilities: {} } });

  const inline = decideLane(choice("inline", 0.9), 10, cfg);
  assert.equal(inline.lane, "inline");
  assert.equal(inline.hold, false);

  // Below the gate → hold at pipeline (never a quality regression).
  const held = decideLane(choice("inline", 0.3), 10, cfg);
  assert.equal(held.lane, "pipeline");
  assert.equal(held.hold, true);

  const project = decideLane(choice("project", 0.8), 10, cfg);
  assert.equal(project.lane, "project");
  assert.equal(project.hold, false);

  // Unknown/empty answers must not become inline.
  assert.equal(decideLane(choice("weird", 0.99), 10, cfg).lane, "pipeline");
  assert.equal(decideLane({}, 5, cfg).lane, "pipeline");
});

test("isThinking", () => {
  assert.ok(isThinking("medium"));
  assert.ok(isThinking("off"));
  assert.ok(!isThinking("ultra"));
});

test("resolveModelString", () => {
  assert.deepEqual(resolveModelString("opencode/gpt-5.6-sol"), { provider: "opencode", id: "gpt-5.6-sol", name: "opencode/gpt-5.6-sol" });
  assert.deepEqual(resolveModelString("deepseek-v4-flash"), { provider: "", id: "deepseek-v4-flash", name: "deepseek-v4-flash" });
  assert.equal(resolveModelString("  "), null);
});

test("strict PM model lookup rejects synthetic, unknown, and unauthenticated models", () => {
  const registry = {
    // Mirrors Pi's permissive qualified lookup: strict PM selection must not use it.
    find: (spec: string) => resolveModelString(spec),
    available: () => [
      { provider: "provider", id: "known", name: "Known PM" },
      { provider: "provider", id: "unauthenticated", name: "Unauthenticated PM" },
    ],
    clampThinking: () => "off" as const,
    hasAuth: (model: { id: string }) => model.id === "known",
  };
  assert.deepEqual(findAvailableAuthenticatedModel(registry, "provider/known"), { provider: "provider", id: "known", name: "Known PM" });
  assert.equal(findAvailableAuthenticatedModel(registry, "provider/nonexistent"), null);
  assert.equal(findAvailableAuthenticatedModel(registry, "provider/unauthenticated"), null);
});

// ---------------------------------------------------------------------------
// 2. Task ids / titles
// ---------------------------------------------------------------------------

test("generateTaskId format", () => {
  const id = generateTaskId(new Date(2026, 8, 14, 12, 0, 0));
  assert.match(id, /^task-20260914-[0-9a-f]{4}$/);
});

test("derivePanelTitle slugs request", () => {
  const t = derivePanelTitle("task-1", "tablet-auto-rotate", "帮我给 tablet-auto-rotate 增加自动旋转功能");
  assert.ok(t.startsWith("DS · tablet-auto-rotate ·"));
  assert.ok(t.length <= 64);
});

test("deriveAgentName is herdr-safe", () => {
  const n = deriveAgentName("task-20260914-abcd");
  assert.match(n, /^ds-[a-z0-9_-]+$/);
});

// ---------------------------------------------------------------------------
// 3. State machine
// ---------------------------------------------------------------------------

test("state transitions valid", () => {
  assertTransition("PLANNING", "SPAWNING_EXECUTOR");
  assertTransition("EXECUTING", "GATING");
  assertTransition("GATING", "FIXING_IMPLEMENTATION");
  assertTransition("GATING", "JUDGING");
  assertTransition("JUDGING", "REVISING_SPEC");
  assertTransition("JUDGING", "FIXING_IMPLEMENTATION");
  assertTransition("JUDGING", "DONE");
  assertTransition("JUDGING", "ESCALATED");
});

test("state transition invalid throws", () => {
  assert.throws(() => assertTransition("DONE", "PLANNING"), /Invalid state transition/);
  assert.throws(() => assertTransition("EXECUTING", "DONE"), /Invalid state transition/);
});

test("task manager lifecycle", () => {
  const tm = new TaskManager("/repo");
  const t = tm.begin("do the thing", {
    controller: { provider: "opencode", id: "gpt-5.6-sol", name: "x" },
    executor: { provider: "new-api", id: "deepseek-v4-flash", name: "y" },
  });
  assert.equal(t.state, "PLANNING");
  assert.equal(t.expectedVersion, 1);
  assert.equal(t.iteration, 0);
  tm.transition(t.taskId, "SPAWNING_EXECUTOR");
  tm.transition(t.taskId, "EXECUTING");
  tm.transition(t.taskId, "GATING");
  tm.transition(t.taskId, "JUDGING");
  tm.transition(t.taskId, "DONE");
  assert.equal(tm.active(), null);
  assert.equal(t.state, "DONE");
});

test("task manager cancel", () => {
  const tm = new TaskManager("/repo");
  tm.begin("x", { controller: { provider: "a", id: "b", name: "b" }, executor: { provider: "c", id: "d", name: "d" } });
  const cancelled = tm.cancelActive("user requested");
  assert.equal(cancelled?.state, "CANCELLED");
  assert.equal(tm.active(), null);
});

test("task manager bypass", () => {
  const tm = new TaskManager("/repo");
  tm.setBypassNext(true);
  const t = tm.begin("x", { controller: { provider: "a", id: "b", name: "b" }, executor: { provider: "c", id: "d", name: "d" } });
  assert.equal(t.bypassNext, true);
  assert.equal(tm.getBypassNext(), false); // consumed
});

// ---------------------------------------------------------------------------
// 4. Convergence tracking
// ---------------------------------------------------------------------------

test("trackConvergence improving", () => {
  const tm = new TaskManager("/repo");
  const t = tm.begin("x", { controller: { provider: "a", id: "b", name: "b" }, executor: { provider: "c", id: "d", name: "d" } });
  tm.patch(t.taskId, { gapCount: 3, previousGapCount: 0 });
  const r = trackConvergence(t, 1, false);
  assert.equal(r.gapCount, 1);
  assert.equal(r.previousGapCount, 3);
  assert.equal(r.progress, "improving");
  assert.equal(r.sameGapStreak, 0);
  assert.equal(r.executorStuck, false);
});

test("trackConvergence stuck after 2 same gaps", () => {
  const tm = new TaskManager("/repo");
  const t = tm.begin("x", { controller: { provider: "a", id: "b", name: "b" }, executor: { provider: "c", id: "d", name: "d" } });
  tm.patch(t.taskId, { gapCount: 2, sameGapStreak: 1 });
  const r = trackConvergence(t, 2, true);
  assert.equal(r.progress, "stalled");
  assert.equal(r.sameGapStreak, 2);
  assert.equal(r.executorStuck, true);
});

test("trackConvergence worsening", () => {
  const tm = new TaskManager("/repo");
  const t = tm.begin("x", { controller: { provider: "a", id: "b", name: "b" }, executor: { provider: "c", id: "d", name: "d" } });
  tm.patch(t.taskId, { gapCount: 1 });
  const r = trackConvergence(t, 4, false);
  assert.equal(r.progress, "worsening");
});

test("distinct nonempty judge gaps reset convergence streak", () => {
  assert.equal(sameJudgeGaps({ gaps: ["missing attach"] }, { gaps: ["missing detach"] }), false);
  assert.equal(sameJudgeGaps({ gaps: ["Missing attach"] }, { gaps: ["missing attach"] }), true);
  const tm = new TaskManager("/repo");
  const t = tm.begin("x", { controller: { provider: "a", id: "b", name: "b" }, executor: { provider: "c", id: "d", name: "d" } });
  tm.patch(t.taskId, { gapCount: 1, sameGapStreak: 1 });
  assert.equal(trackConvergence(t, 1, false).sameGapStreak, 0);
});

// ---------------------------------------------------------------------------
// 5. Risk detection
// ---------------------------------------------------------------------------

test("detectRisk low", () => {
  assert.equal(detectRisk("给 auto-rotate 增加一个配置项").level, "low");
});

test("detectRisk medium (one signal)", () => {
  const r = detectRisk("执行 sudo apt update 并配置防火墙规则");
  assert.equal(r.level, "medium");
  assert.ok(r.concerns.length >= 1);
});

test("detectRisk high (two signals)", () => {
  const r = detectRisk("用 sudo 修改 /etc/hosts 并执行 git push --force");
  assert.equal(r.level, "high");
  assert.ok(r.concerns.length >= 2);
});

test("detectRisk destructive git", () => {
  assert.ok(detectRisk("git push --force origin main").concerns.some((c) => c.includes("git")));
});

// ---------------------------------------------------------------------------
// 6. YAML parsing / reports
// ---------------------------------------------------------------------------

test("extractYamlBlock", () => {
  const s = "intro\n```yaml\nstatus: completed\n```\noutro";
  assert.equal(extractYamlBlock(s), "status: completed");
});

test("parseTolerantYaml scalars + lists", () => {
  const y = parseTolerantYaml("status: completed\nsummary: did things\nfiles_changed:\n  - path: a.ts\n    purpose: x\n  - path: b.ts\n    purpose: y\n");
  assert.equal(y?.status, "completed");
  assert.equal(y?.summary, "did things");
  assert.ok(Array.isArray(y?.files_changed));
});

test("normalizeReport defaults", () => {
  const r = normalizeReport(null);
  assert.equal(r.status, "failed");
  assert.deepEqual(r.files_changed, []);
  assert.deepEqual(r.validation, { lint: "not_run", typecheck: "not_run", build: "not_run" });
});

test("normalizeReport cleans None/null placeholders in list fields", () => {
  // DeepSeek executor reports often write `unresolved: [None]` instead of an
  // empty array; that must not block convergence.
  const r = normalizeReport({ status: "completed", summary: "ok", unresolved: ["None"], deviations: ["None", "n/a"], risks: ["-", "null"], implementation: ["did stuff", "None"] });
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(r.deviations, []);
  assert.deepEqual(r.risks, []);
  assert.deepEqual(r.implementation, ["did stuff"]);
});

test("extractReportFromAgentMessage with fence", () => {
  const msg = `Done.\n\`\`\`yaml\nstatus: completed\nsummary: Implemented feature\nfiles_changed:\n  - path: src/main.ts\n    purpose: added handler\nimplementation:\n  - added the rotate handler\ntests:\n  commands:\n    - npm test\n  passed:\n    - rotate.test.ts\n  failed: []\nvalidation:\n  lint: pass\n  typecheck: pass\n  build: pass\nacceptance_check:\n  rotate_works: pass\ndeviations: []\nunresolved: []\nrisks: []\n\`\`\``;
  const r = extractReportFromAgentMessage(msg);
  assert.equal(r.status, "completed");
  assert.equal(r.summary, "Implemented feature");
  assert.equal((r.files_changed as any[])[0].path, "src/main.ts");
  assert.equal((r.validation as any).lint, "pass");
});

test("malformed report still yields normalized shape", () => {
  const r = extractReportFromAgentMessage("I have no idea what happened. 3 bugs found.");
  assert.ok(r); // normalizeReport(null) gives defaults
  assert.equal(r.status, "failed");
});

test("parseTolerantYaml flow-style map/list with nested arrays", () => {
  const parsed = parseTolerantYaml("validation: { required: [npm test pass, re-export works] }\nconstraints: [a, b]");
  assert.deepEqual(parsed?.validation, { required: ["npm test pass", "re-export works"] });
  assert.deepEqual(parsed?.constraints, ["a", "b"]);
  const nested = parseTolerantYaml("files: [lib/a.js, tests/clamp.test.js]\nscope: { files: [x], components: [y] }");
  assert.deepEqual(nested?.files, ["lib/a.js", "tests/clamp.test.js"]);
  assert.deepEqual(nested?.scope, { files: ["x"], components: ["y"] });
});

test("parseTolerantYaml handles folded/literal block scalars with chomping (|-, >-)", () => {
  const parsed = parseTolerantYaml("summary: >-\n  line one\n  line two\nstatus: completed\nnotes: |-\n  kept\n  as-is");
  assert.equal(parsed?.summary, "line one line two"); // folded → spaces
  assert.equal(parsed?.notes, "kept\nas-is"); // literal → newlines preserved
  assert.equal(parsed?.status, "completed");
});

// ---------------------------------------------------------------------------
// 7. Judge output parsing
// ---------------------------------------------------------------------------

test("parseJudgeOutput converged", () => {
  const j = parseJudgeOutput(`\`\`\`yaml
verdict: converged
confidence: high
expected:
  - rotate works
actual:
  - rotate works
matched:
  - rotate works
gaps: []
implementation_changes: []
spec_changes: []
delta:
  matched:
    - rotate works
  missing: []
  incorrect: []
  unexpected: []
  required_changes: []
  must_preserve:
    - detach behavior
reason: all criteria satisfied
\`\`\``);
  assert.ok(j);
  assert.equal(j?.verdict, "converged");
  assert.equal(j?.confidence, "high");
  assert.deepEqual(j?.delta.matched, ["rotate works"]);
  assert.deepEqual(j?.delta.must_preserve, ["detach behavior"]);
});

test("parseJudgeOutput implementation_gap", () => {
  const j = parseJudgeOutput(`\`\`\`yaml
verdict: implementation_gap
confidence: medium
expected:
  - state restores on re-attach
actual:
  - state stays tablet after reconnect
matched:
  - detach detection works
gaps:
  - re-attach does not restore laptop state
implementation_changes:
  - handle re-attach event
  - make state transition idempotent
spec_changes: []
delta:
  matched:
    - detach detection works
  missing:
    - re-attach restores state
  incorrect:
    - state remains tablet after reconnect
  unexpected:
    - duplicate udev event
  required_changes:
    - handle re-attach event
  must_preserve:
    - existing detach behavior
reason: partial implementation
\`\`\``);
  assert.ok(j);
  assert.equal(j?.verdict, "implementation_gap");
  assert.equal(j?.delta.missing[0], "re-attach restores state");
  assert.equal(j?.implementation_changes[0], "handle re-attach event");
});

test("parseJudgeOutput spec_gap with revision", () => {
  const j = parseJudgeOutput(`\`\`\`yaml
verdict: spec_gap
confidence: medium
expected:
  - use SW_TABLET_MODE
actual:
  - hardware exposes no SW_TABLET_MODE
matched: []
gaps:
  - target hardware does not expose SW_TABLET_MODE
implementation_changes: []
spec_changes:
  - infer tablet mode from detachable keyboard state
spec_revision:
  version: 2
  changed:
    - replace SW_TABLET_MODE detection
  reason:
    - target hardware does not expose SW_TABLET_MODE
  evidence:
    - device tree has no sw_tablet_mode node
  user_intent_changed: false
delta:
  matched: []
  missing:
    - infer mode from keyboard
  incorrect: []
  unexpected: []
  required_changes:
    - detect keyboard attach/detach
  must_preserve:
    - accelerometer behavior
reason: spec mismatch with hardware
\`\`\``);
  assert.ok(j);
  assert.equal(j?.verdict, "spec_gap");
  assert.equal(j?.spec_revision?.version, 2);
  assert.equal(j?.spec_revision?.user_intent_changed, false);
});

test("parseJudgeOutput blocked", () => {
  const j = parseJudgeOutput(`\`\`\`yaml
verdict: blocked
confidence: high
expected: []
actual: []
matched: []
gaps:
  - user intent cannot be satisfied with current hardware
implementation_changes: []
spec_changes: []
delta:
  matched: []
  missing: []
  incorrect: []
  unexpected: []
  required_changes: []
  must_preserve: []
reason: goal is impossible
\`\`\``);
  assert.equal(j?.verdict, "blocked");
});

test("parseJudgeOutput invalid verdict returns null", () => {
  assert.equal(parseJudgeOutput("```yaml\nverdict: pass\n```"), null);
});

test("parseJudgeOutput accepts artifact JSON", () => {
  const j = parseJudgeOutput(JSON.stringify({ verdict: "converged", confidence: "high", expected: ["e"], actual: ["a"], matched: ["m"], gaps: [], implementation_changes: [], spec_changes: [], spec_revision: { version: 2, changed: [], reason: [], evidence: [], user_intent_changed: false }, delta: { matched: ["m"], missing: [], incorrect: [], unexpected: [], required_changes: [], must_preserve: [] }, reason: "all good" }));
  assert.equal(j?.verdict, "converged");
  assert.deepEqual(j?.expected, ["e"]);
  assert.deepEqual(j?.delta.matched, ["m"]);
  assert.equal(parseJudgeOutput(JSON.stringify({ verdict: "nope" })), null);
});

// ---------------------------------------------------------------------------
// 8. Contract parsing / spec revision
// ---------------------------------------------------------------------------

test("parseContractYaml full", () => {
  const c = parseContractYaml(`\`\`\`yaml
goal: auto rotate screen in tablet mode
context: systemd udev based project
architecture:
  relevant_components:
    - src/tablet.ts
    - udev rules
constraints:
  - keep CLI compat
expected_outcome:
  - rotates when detached
acceptance_criteria:
  - rotate on detach test passes
validation:
  required:
    - npm test
risk:
  level: medium
  concerns:
    - udev rules touch system
\`\`\``, "orig request", 1);
  assert.equal(c.version, 1);
  assert.equal(c.goal, "auto rotate screen in tablet mode");
  assert.ok(c.architecture.relevant_components.includes("src/tablet.ts"));
  assert.equal(c.risk.level, "medium");
});

test("parseSpecRevision yields v2 contract", () => {
  const r = parseSpecRevision(`\`\`\`yaml
goal: auto rotate screen in tablet mode
context: updated
architecture:
  relevant_components:
    - src/tablet.ts
constraints: []
expected_outcome:
  - rotate based on keyboard state
acceptance_criteria:
  - keyboard detach rotates
validation:
  required:
    - npm test
risk:
  level: low
  concerns: []
spec_revision:
  version: 2
  changed:
    - replace SW_TABLET_MODE
  reason:
    - hardware lacks sensor
  evidence:
    - dtb check
  user_intent_changed: false
\`\`\``, "orig", 1);
  assert.ok(r);
  assert.equal(r?.contract.version, 2);
  assert.equal(r?.revision.version, 2);
  assert.ok(r?.revision.changed.length >= 1);
});

test("parseConvergenceDiagnosis", () => {
  const d = parseConvergenceDiagnosis(`\`\`\`yaml
assessment: executor
gap_trend: stalled
recommendation: upgrade to a stronger executor model
continue_value: low
\`\`\``);
  assert.equal(d?.assessment, "executor");
  assert.equal(d?.gap_trend, "stalled");
});

// ---------------------------------------------------------------------------
// 9. Prompt building
// ---------------------------------------------------------------------------

test("buildExecutorPrompt initial contains role + repo", () => {
  const contract = parseContractYaml(`goal: g\ncontext: c\narchitecture:\n  relevant_components:\n    - a.ts\nconstraints:\n  - keep x\nexpected_outcome:\n  - works\nacceptance_criteria:\n  - passes\nvalidation:\n  required:\n    - npm test\nrisk:\n  level: low\n  concerns: []`, "req", 1);
  const p = buildExecutorPrompt({ originalRequest: "req", contract, repoPath: "/repo", mode: "initial", taskId: "t1", panelTitle: "DS · x" });
  assert.ok(p.includes("You are the Executor"));
  assert.ok(p.includes("/repo"));
  assert.ok(p.includes("EXECUTION REPORT"));
  assert.ok(p.includes("Do not include your internal chain-of-thought"), "prompt must tell executor not to leak CoT");
});

test("buildExecutorPrompt honors explicit controller artifact directory", () => {
  const contract = parseContractYaml("goal: g\ncontext: c\narchitecture:\n  relevant_components: []\nconstraints: []\nexpected_outcome:\n  - works\nacceptance_criteria:\n  - passes\nvalidation:\n  required: []\nrisk:\n  level: low\n  concerns: []", "req", 1);
  const p = buildExecutorPrompt({ originalRequest: "req", contract, repoPath: "/worktree", mode: "initial", taskId: "t1", panelTitle: "DS · x", artifactDir: "/controller/.pi/dual-gate/t1" });
  assert.ok(p.includes("/controller/.pi/dual-gate/t1/executor-report.yaml"));
  assert.ok(!p.includes("/worktree/.pi/dual-gate/t1/executor-report.yaml"));
});

test("buildExecutorPrompt delta-fix has MUST PRESERVE + DELTA", () => {
  const contract = parseContractYaml(`goal: g\ncontext: c\narchitecture:\n  relevant_components:\n    - a.ts\nconstraints: []\nexpected_outcome:\n  - works\nacceptance_criteria:\n  - passes\nvalidation:\n  required: []\nrisk:\n  level: low\n  concerns: []`, "req", 2);
  const p = buildExecutorPrompt({
    originalRequest: "req", contract, repoPath: "/repo", mode: "delta-fix", taskId: "t1", panelTitle: "DS · x",
    delta: { matched: ["detach works"], missing: ["reattach restore"], incorrect: [], unexpected: [], required_changes: ["handle reattach"], must_preserve: ["detach behavior"] },
  });
  assert.ok(p.includes("MUST PRESERVE"));
  assert.ok(p.includes("reattach restore"));
  assert.ok(p.includes("handle reattach"));
});

test("buildJudgePrompt carries expected/actual/diff/gate", () => {
  const contract = parseContractYaml(`goal: g\ncontext: c\narchitecture:\n  relevant_components: []\nconstraints: []\nexpected_outcome:\n  - works\nacceptance_criteria:\n  - passes\nvalidation:\n  required: []\nrisk:\n  level: low\n  concerns: []`, "req", 1);
  const p = buildJudgePrompt({ originalRequest: "req", contract, report: { status: "completed" }, diff: "diff", gateSummary: "PASS", taskId: "t1", risk: "low", iteration: 1, expectedVersion: 1 });
  assert.ok(p.includes("converged|implementation_gap|spec_gap|mixed_gap|blocked"));
  assert.ok(p.includes("RELEVANT DIFF"));
});

// ---------------------------------------------------------------------------
// 10. Artifact store
// ---------------------------------------------------------------------------

test("artifact store writes/reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-test-"));
  const store = createArtifactStore(dir);
  store.write("state.json", { a: 1 });
  assert.ok(store.read("state.json")?.includes('"a": 1'));
  assert.equal(store.read("missing"), null);
});

test("taskDirFor layout", () => {
  assert.ok(taskDirFor("/repo", "task-1").endsWith("/.pi/dual-gate/task-1"));
});

// ---------------------------------------------------------------------------
// 11. Gate discovery
// ---------------------------------------------------------------------------

test("gate discovers node scripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-gate-node-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }));
  const d = discoverGateCommands(dir);
  assert.ok(d.commands.some((c) => c.name === "npm:test" && c.command.join(" ").includes("npm run test")));
  assert.ok(d.commands.some((c) => c.name === "npm:lint"));
});

test("gate discovers python", () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-gate-py-"));
  writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n[tool.ruff]\n");
  const d = discoverGateCommands(dir);
  assert.ok(d.commands.some((c) => c.name === "pytest"));
  assert.ok(d.commands.some((c) => c.name === "ruff"));
});

test("gate discovers go", () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-gate-go-"));
  writeFileSync(join(dir, "go.mod"), "module test\n");
  const d = discoverGateCommands(dir);
  assert.ok(d.commands.some((c) => c.command.join(" ") === "go test ./..."));
});

test("gate no commands is an explicit successful skip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-gate-empty-"));
  const d = discoverGateCommands(dir);
  assert.equal(d.commands.length, 0);
  assert.ok(d.notes.some((note) => note.includes("skipping gate")));
  const result = await runGate(dir, d);
  assert.equal(result.passed, true);
  assert.equal(result.steps.length, 0);
  assert.ok(formatGateResult(result).includes("no validation commands"));
});

test("configured gate skip is visible and successful", () => {
  const result = skippedGateResult("disabled by configuration");
  assert.equal(result.passed, true);
  assert.equal(result.steps[0].skipped, true);
  assert.ok(formatGateResult(result).includes("[SKIP]"));
});

test("gate runGate passes trivial true command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-gate-run-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  const d = discoverGateCommands(dir);
  const r = await runGate(dir, d);
  assert.equal(r.passed, true);
});

test("gate runGate fails on exit 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-gate-fail-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));
  const d = discoverGateCommands(dir);
  const r = await runGate(dir, d);
  assert.equal(r.passed, false);
  assert.ok(r.steps.some((s) => !s.passed));
});

test("formatGateResult", () => {
  const r = formatGateResult({ passed: false, steps: [{ name: "npm:test", command: "npm test", passed: false, skipped: false, exitCode: 1, outputTail: "", durationMs: 10 }] });
  assert.ok(r.includes("[FAIL]"));
});

// ---------------------------------------------------------------------------
// 10. Project planning and acceptance (pure outer-coordinator contracts)
// ---------------------------------------------------------------------------

const projectYaml = `goal: Ship project flow
context: Existing task loop remains intact
constraints:
  - Preserve task loop
acceptance_criteria:
  - All milestones converge
validation:
  required:
    - node --test
milestones:
  - id: M1
    title: Foundation
    depends_on: []
    scope:
      files:
        - extension/core.ts
      components: []
    expected_outcome:
      - Project contracts exist
    acceptance_criteria:
      - Parser validates plans
    validation:
      required:
        - node --test
    risk:
      level: low
      concerns: []
  - id: M2
    title: Coordinator
    depends_on:
      - M1
    scope:
      files:
        - extension/dual-gate.ts
      components: []
    expected_outcome:
      - Project command runs serially
    acceptance_criteria:
      - Dependencies are respected
    validation:
      required:
        - node --test
    risk:
      level: medium
      concerns:
        - orchestration
`;

test("project plan parses and orders stable WBS", () => {
  const plan = parseProjectPlan(projectYaml);
  assert.equal(plan.goal, "Ship project flow");
  assert.deepEqual(topologicallyOrderMilestones(plan.milestones).map((m) => m.id), ["M1", "M2"]);
  assert.deepEqual(validateProjectPlan(plan), []);
});

test("project plan parses optional market-research block", () => {
  const plan = parseProjectPlan(`goal: Build X\nacceptance_criteria: [a]\nvalidation: { required: [npm test] }\nresearch:\n  summary: Mature OSS exists; we adapt it\n  existing_solutions:\n    - name: lib-y\n      url: https://github.com/x/y\n      assessment: covers 80%\n  decision: adapt\n  rationale: avoid reimplementing mature logic\nmilestones:\n  - id: M1\n    title: Adapt lib-y\n    depends_on: []\n    scope: [integrate lib-y]\n    deliverables: [lib-y integrated]\n    acceptance: [works]`);
  assert.equal(plan.research?.decision, "adapt");
  assert.equal(plan.research?.existing_solutions[0].name, "lib-y");
  assert.equal(plan.research?.summary.includes("OSS"), true);
  // legacy plan without research still parses
  const legacy = parseProjectPlan(projectYaml);
  assert.equal(legacy.research, undefined);
});

test("parallel milestone scheduler groups independent milestones into batches", () => {
  // M1 -> M2, M1 -> M3: M2 and M3 are independent and can run in parallel.
  const milestones: any[] = [
    { id: "M1", depends_on: [] },
    { id: "M2", depends_on: ["M1"] },
    { id: "M3", depends_on: ["M1"] },
  ];
  const batches = scheduleMilestoneBatches(milestones);
  assert.deepEqual(batches.map((b) => b.map((m) => m.id)), [["M1"], ["M2", "M3"]]);
  assert.ok(isParallelBatch(batches[1]));
  assert.ok(!isParallelBatch(batches[0]));
});

test("parallel scheduler handles independent roots and chains", () => {
  // M1 and M2 independent; M3 depends on both; M4 depends on M3.
  const milestones: any[] = [
    { id: "M1", depends_on: [] },
    { id: "M2", depends_on: [] },
    { id: "M3", depends_on: ["M1", "M2"] },
    { id: "M4", depends_on: ["M3"] },
  ];
  const batches = scheduleMilestoneBatches(milestones);
  const ids = batches.map((b) => b.map((m) => m.id).sort().join(","));
  assert.deepEqual(ids, ["M1,M2", "M3", "M4"]);
  assert.ok(isParallelBatch(batches[0]));
});

test("parallel scheduler detects dependency cycles", () => {
  const milestones: any[] = [
    { id: "M1", depends_on: ["M2"] },
    { id: "M2", depends_on: ["M1"] },
  ];
  assert.throws(() => scheduleMilestoneBatches(milestones), /cycle/);
});

test("project plan tolerates real PM output: same-indent lists, name/work_items/done_when, case-insensitive deps", () => {
  // Captured shape from a live DeepSeek PM: top-level block sequences at key
  // indentation, `name` instead of `title`, work_items/done_when instead of
  // expected_outcome/acceptance_criteria, and lowercase dependency refs.
  const plan = parseProjectPlan(`goal: Add formatGreeting
acceptance_criteria:
  - exports both greeting and formatGreeting
  - returns Hello, friend! for blank input
  - README documents the API
validation:
  required:
    - npm test passes
milestones:
  - id: milestone-1
    name: Implement and test
    depends_on: []
    work_items:
      - add formatGreeting to src/greeting.js
      - keep greeting unchanged
      - add focused tests
    done_when:
      - all behavior cases pass
      - full suite passes
  - id: milestone-2
    name: Document and validate
    depends_on: [milestone-1]
    work_items:
      - document formatGreeting in README
    done_when:
      - README documents usage
      - npm test passes`);
  assert.deepEqual(plan.milestones.map((m) => m.id), ["MILESTONE-1", "MILESTONE-2"]);
  assert.equal(plan.milestones[0].title, "Implement and test");
  assert.ok(plan.milestones[0].scope.components.length >= 2);
  assert.ok(plan.milestones[0].expected_outcome.length >= 2);
  assert.ok(plan.milestones[0].acceptance_criteria.length >= 2);
  assert.ok(plan.validation.required.includes("npm test passes"));
  // dependency reference case is normalized to the uppercased id
  assert.deepEqual(plan.milestones[1].depends_on, ["MILESTONE-1"]);
  assert.deepEqual(validateProjectPlan(plan), []);
  assert.deepEqual(topologicallyOrderMilestones(plan.milestones).map((m) => m.id), ["MILESTONE-1", "MILESTONE-2"]);
});

test("project plan rejects missing fields, duplicate IDs, unknown/self/cyclic dependencies", () => {
  assert.throws(() => parseProjectPlan("goal: x\nacceptance_criteria: []\nvalidation:\n  required: []\nmilestones: []"), /Invalid project plan/);
  const plan = parseProjectPlan(projectYaml);
  const duplicate = structuredClone(plan); duplicate.milestones[1].id = "M1";
  assert.ok(validateProjectPlan(duplicate).some((e) => e.includes("duplicate")));
  const unknown = structuredClone(plan); unknown.milestones[1].depends_on = ["NOPE"];
  assert.ok(validateProjectPlan(unknown).some((e) => e.includes("unknown")));
  const self = structuredClone(plan); self.milestones[0].depends_on = ["M1"];
  assert.ok(validateProjectPlan(self).some((e) => e.includes("itself")));
  const cycle = structuredClone(plan); cycle.milestones[0].depends_on = ["M2"];
  assert.ok(validateProjectPlan(cycle).some((e) => e.includes("cycle")));
});

test("milestone projects to unchanged acceptance contract and project paths are isolated", () => {
  const plan = parseProjectPlan(projectYaml);
  const contract = milestoneToAcceptanceContract(plan, plan.milestones[1], "exact original request");
  assert.equal(contract.task.original_request, "exact original request");
  assert.deepEqual(contract.architecture.relevant_components, ["extension/dual-gate.ts"]);
  assert.deepEqual(contract.acceptance_criteria, ["Dependencies are respected"]);
  assert.ok(contract.constraints.some((x) => x.includes("Preserve task loop")));
  assert.match(generateProjectId(new Date(2026, 8, 14)), /^project-20260914-/);
  assert.equal(projectDirFor("/repo", "project-x"), "/repo/.pi/dual-gate/projects/project-x");
  assert.equal(projectMilestoneDirFor("/repo", "project-x", "M1"), "/repo/.pi/dual-gate/projects/project-x/milestones/M1");
});

test("project prompts and optional milestone context preserve existing schemas", () => {
  const plan = parseProjectPlan(projectYaml);
  const contract = milestoneToAcceptanceContract(plan, plan.milestones[0], "request");
  const context = { projectId: "project-x", projectGoal: plan.goal, milestoneId: "M1", milestoneTitle: "Foundation", scope: plan.milestones[0].scope, dependsOn: [], completedSummaries: [] as any[] };
  assert.ok(buildProjectPlanPrompt({ sourceRequest: "request", repoPath: "/repo" }).includes("depends_on"));
  assert.ok(buildExecutorPrompt({ originalRequest: "request", contract, repoPath: "/repo", mode: "initial", taskId: "task-x", panelTitle: "x", projectContext: context }).includes("PROJECT / MILESTONE CONTEXT"));
  assert.ok(buildJudgePrompt({ originalRequest: "request", contract, report: {}, diff: "", gateSummary: "PASS", taskId: "task-x", risk: "low", iteration: 1, expectedVersion: 1, projectContext: context }).includes("MILESTONE: M1"));
  assert.ok(buildSpecUpdatePrompt({ previousVersion: 1, contract, revision: { version: 2, changed: [], reason: [], evidence: [], user_intent_changed: false }, delta: { matched: [], missing: [], incorrect: [], unexpected: [], required_changes: [], must_preserve: [] }, originalRequest: "request", repoPath: "/repo", taskId: "task-x", projectContext: context }).includes("MILESTONE: M1"));
  assert.ok(buildExecutorCheckpoint({ taskId: "task-x", originalRequest: "request", expectedVersion: 1, contract, iteration: 1, report: { implementation: [], tests: {}, unresolved: [] }, delta: null, gateSummary: "PASS", projectContext: context }).includes("project-x/M1"));
  assert.ok(buildRecoveryPrompt({ taskId: "task-x", originalRequest: "request", contract, checkpoint: "x", repoPath: "/repo", delta: null, projectContext: context }).includes("MILESTONE: M1"));
});

test("PM protocol correlates the latest fenced response and uses a guarded artifact-only launch", () => {
  assert.deepEqual(productManagerPiArgs("default", "/guard.ts", "/search.ts"), ["--no-extensions", "--tools", "read,grep,find,ls,write,pm_search", "--extension", "/guard.ts", "--extension", "/search.ts"]);
  const args = productManagerPiArgs("provider/pm", "/guard.ts", "/search.ts");
  assert.deepEqual(args.slice(0, 2), ["--model", "provider/pm"]);
  assert.ok(args.includes("read,grep,find,ls,write,pm_search"));
  assert.ok(args.includes("/guard.ts"));
  assert.ok(args.includes("/search.ts"));
  assert.ok(!args.join(" ").match(/\b(bash|edit)\b/));
  const stale = "```yaml\nprotocol_version: 1\nrequest_id: pm-x-2\nkind: plan\ngoal: stale\n```\n```yaml\nprotocol_version: 1\nrequest_id: pm-x-2\nkind: plan\ngoal: current\n```";
  assert.ok(extractCorrelatedYamlBlock(stale, "pm-x-2")?.includes("current"));
  assert.equal(extractCorrelatedYamlBlock(stale, "pm-x-3"), null);
  const prompt = buildProductManagerPlanPrompt({ sourceRequest: "x", repoPath: "/repo", requestId: "pm-x-2", responsePath: "/artifacts/plan.yaml" });
  const response = `\`\`\`yaml\nprotocol_version: 1\nrequest_id: pm-x-2\nkind: plan\n${projectYaml}\`\`\``;
  assert.ok(prompt.includes("never implement"));
  assert.ok(!prompt.includes("```yaml\nprotocol_version: 1\nrequest_id: pm-x-2"));
  assert.equal(parseProjectPlan(extractCorrelatedYamlBlock(`${prompt}\n${response}`, "pm-x-2", "plan")!).goal, "Ship project flow");
});

test("PM feedback and acceptance require matching protocol responses", () => {
  const feedback = "```yaml\nprotocol_version: 1\nrequest_id: pm-x-3\nkind: milestone_feedback\nmilestone_id: M1\ntask_id: task-1\ndecision: acknowledged\nsummary: reviewed\nunresolved: []\ndeviations: []\nreason: aligned\n```";
  assert.equal(parseProductMilestoneFeedback(feedback, "pm-x-3")?.decision, "acknowledged");
  const feedbackPrompt = buildMilestoneCompletionFeedbackPrompt({ protocol_version: 1, request_id: "pm-x-3", kind: "milestone_feedback", milestone_id: "M1", task_id: "task-1", executor_summary: "done", judge: { verdict: "converged", gaps: [] }, gate_summary: "PASS", unresolved: [], deviations: [], response_path: "/artifacts/feedback.yaml" });
  assert.ok(!feedbackPrompt.includes("```yaml\nprotocol_version: 1\nrequest_id: pm-x-3"));
  assert.equal(parseProductMilestoneFeedback(`${feedbackPrompt}\n${feedback}`, "pm-x-3")?.summary, "reviewed");
  assert.equal(parseProductMilestoneFeedback(feedback, "pm-x-4"), null);
  assert.equal(parseProductMilestoneFeedback("```yaml\nprotocol_version: 1\nrequest_id: pm-x-3\nkind: milestone_feedback\ndecision: maybe\n```", "pm-x-3"), null);
  const final = "```yaml\nprotocol_version: 1\nrequest_id: pm-x-4\nkind: final_acceptance\nverdict: accepted\nsummary: done\nsatisfied: []\ngaps: []\nunresolved: []\nreason: verified\n```";
  assert.equal(parseProjectAcceptance(final, "pm-x-4")?.verdict, "accepted");
  const acceptancePrompt = buildProductAcceptancePrompt({ requestId: "pm-x-4", responsePath: "/artifacts/acceptance.yaml", plan: parseProjectPlan(projectYaml), milestones: [], diff: "", gateSummary: "PASS" });
  assert.ok(!acceptancePrompt.includes("```yaml\nprotocol_version: 1\nrequest_id: pm-x-4"));
  assert.equal(parseProjectAcceptance(`${acceptancePrompt}\n${final}`, "pm-x-4")?.verdict, "accepted");
  assert.equal(parseProjectAcceptance(final, "pm-x-5"), null);
  const recovery = buildProductManagerRecoveryPrompt({ projectId: "project-x", requestId: "pm-x-4", responsePath: "/artifacts/acceptance.yaml", outstandingRequest: { kind: "final_acceptance" }, persistedFeedback: [] });
  assert.ok(recovery.includes("pm-x-4"));
  assert.ok(!recovery.toLowerCase().includes("write source"));
  assert.ok(buildMilestoneCompletionFeedbackPrompt({ protocol_version: 1, request_id: "pm-x-3", kind: "milestone_feedback", milestone_id: "M1", task_id: "task-1", executor_summary: "done", judge: { verdict: "converged", gaps: [] }, gate_summary: "PASS", unresolved: [], deviations: [], response_path: "/artifacts/feedback.yaml" }).includes("acknowledged|blocked"));
  assert.ok(buildProductAcceptancePrompt({ requestId: "pm-x-4", responsePath: "/artifacts/acceptance.yaml", plan: parseProjectPlan(projectYaml), milestones: [], diff: "", gateSummary: "PASS" }).includes("RESPONSE PATH"));
});

test("project lifecycle only treats nonterminal states as active", () => {
  for (const status of ["PLANNING", "AWAITING_APPROVAL", "RUNNING", "ACCEPTING"] as const) assert.ok(isActiveProjectState(status));
  for (const status of ["ACCEPTED", "REJECTED", "BLOCKED", "FAILED", "CANCELLED"] as const) assert.ok(!isActiveProjectState(status));
  assert.ok(isProjectFinalizationStopped("CANCELLED", false));
  assert.ok(isProjectFinalizationStopped("ACCEPTING", true));
  assert.ok(!isProjectFinalizationStopped("ACCEPTING", false));
});

test("TaskManager.loadFromDisk restores interrupted tasks from artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-restore-"));
  const root = join(dir, ".pi", "dual-gate");
  mkdirSync(join(root, "task-20260915-abcd"), { recursive: true });
  writeFileSync(join(root, "task-20260915-abcd", "state.json"), JSON.stringify({
    taskId: "task-20260915-abcd", state: "EXECUTING", currentStage: "iteration-1", iteration: 1,
    expectedVersion: 1, gapCount: 0, previousGapCount: 0, progress: "improving", sameGapStreak: 0,
    executorStuck: false, specRevisions: 0, repoPath: dir, createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
  }));
  writeFileSync(join(root, "task-20260915-abcd", "metadata.json"), JSON.stringify({
    taskId: "task-20260915-abcd", controller: "new-api/deepseek-v4-pro", executor: "default",
    herdrPanel: null, herdrAgent: null, state: "EXECUTING", createdAt: "2026-09-15T00:00:00.000Z",
  }));
  // A terminal task should not be returned as resumable.
  mkdirSync(join(root, "task-20260915-done"), { recursive: true });
  writeFileSync(join(root, "task-20260915-done", "state.json"), JSON.stringify({ taskId: "task-20260915-done", state: "DONE" }));
  writeFileSync(join(root, "task-20260915-done", "metadata.json"), JSON.stringify({ taskId: "task-20260915-done" }));

  const tm = new TaskManager(dir);
  const resumed = tm.loadFromDisk(dir);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].taskId, "task-20260915-abcd");
  assert.equal(resumed[0].state, "EXECUTING");
  assert.equal(resumed[0].controllerModel, "new-api/deepseek-v4-pro");
  assert.equal(resumed[0].artifactDir, join(root, "task-20260915-abcd"));
  assert.equal(tm.persistedTasks().length, 2);

  // Project restoration.
  mkdirSync(join(root, "projects", "project-20260915-0001"), { recursive: true });
  writeFileSync(join(root, "projects", "project-20260915-0001", "project-state.json"), JSON.stringify({
    projectId: "project-20260915-0001", sourceRequest: "x", repoPath: dir,
    artifactDir: join(root, "projects", "project-20260915-0001"), status: "RUNNING",
    orderedMilestoneIds: ["M1"], milestones: { M1: { title: "M1", status: "RUNNING" } },
    createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
  }));
  const projects = loadProjectsFromDisk(dir);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].status, "RUNNING");
});

test("project acceptance parser and guards reject incomplete, unresolved, or failed gate", () => {
  const accepted = parseProjectAcceptance("```yaml\nverdict: accepted\nsummary: done\nsatisfied:\n  - all\ngaps: []\nunresolved: []\nreason: verified\n```");
  const acceptedWithGaps = parseProjectAcceptance("verdict: accepted\nsummary: done\nsatisfied: []\ngaps:\n  - missing requirement\nunresolved: []\nreason: contradictory");
  const acceptedWithUnresolved = parseProjectAcceptance("verdict: accepted\nsummary: done\nsatisfied: []\ngaps: []\nunresolved:\n  - pending investigation\nreason: contradictory");
  assert.equal(accepted?.verdict, "accepted");
  assert.equal(parseProjectAcceptance("verdict: nope"), null);
  assert.equal(parseProjectAcceptance("verdict: blocked\nsummary: stop\nsatisfied: []\ngaps: []\nunresolved: []\nreason: x")?.verdict, "blocked");
  const milestones: any = { M1: { status: "CONVERGED", verdict: "converged", unresolved: [] } };
  assert.ok(canAcceptProject({ orderedMilestoneIds: ["M1"], milestones, finalGatePassed: true, productAcceptance: accepted, acceptance: accepted }));
  assert.ok(!canAcceptProject({ orderedMilestoneIds: ["M1"], milestones, finalGatePassed: true, productAcceptance: acceptedWithGaps, acceptance: accepted }));
  assert.ok(!canAcceptProject({ orderedMilestoneIds: ["M1"], milestones, finalGatePassed: true, productAcceptance: accepted, acceptance: acceptedWithGaps }));
  assert.ok(!canAcceptProject({ orderedMilestoneIds: ["M1"], milestones, finalGatePassed: true, productAcceptance: accepted, acceptance: acceptedWithUnresolved }));
  milestones.M1.unresolved = ["x"]; assert.ok(canAcceptProject({ orderedMilestoneIds: ["M1"], milestones, finalGatePassed: true, productAcceptance: accepted, acceptance: accepted })); // converged + judge converged → accepted even with unresolved notes
  milestones.M1.unresolved = []; assert.ok(!canAcceptProject({ orderedMilestoneIds: ["M1"], milestones, finalGatePassed: false, productAcceptance: accepted, acceptance: accepted }));
  assert.ok(buildProjectAcceptancePrompt({ plan: parseProjectPlan(projectYaml), milestones: [], diff: "", gateSummary: "PASS", productAcceptance: accepted! }).includes("never bypasses Controller"));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

setTimeout(() => {
  console.log(`\nDual-Gate core tests: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}, 200);
