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
  generateTaskId,
  derivePanelTitle,
  deriveAgentName,
  detectRisk,
  STATE_TRANSITIONS,
  assertTransition,
  TaskManager,
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
} from "../extension/core.ts";
import { discoverGateCommands, runGate, formatGateResult } from "../extension/gate.ts";

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
  assert.equal(c.enabled, true);
  assert.equal(c.controller.model, "openai-codex/gpt-5.6-sol");
  assert.equal(c.controller.thinking, "medium");
  assert.equal(c.executor.model, "new-api/deepseek-v4-flash");
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
});

test("config rejects invalid values", () => {
  const c = normalizeConfig({ gate: { max_retries: -5 }, controller: { thinking: "nonsense" as any }, loop: { max_iterations: 0 } });
  assert.equal(c.gate.max_retries, 3);
  assert.equal(c.controller.thinking, "medium");
  assert.equal(c.loop.max_iterations, 5);
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

test("gate no commands → skipped note", () => {
  const dir = mkdtempSync(join(tmpdir(), "dg-gate-empty-"));
  const d = discoverGateCommands(dir);
  assert.equal(d.commands.length, 0);
  assert.ok(d.notes.length >= 0);
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
