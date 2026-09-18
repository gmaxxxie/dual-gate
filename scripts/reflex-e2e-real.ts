// Real closed-loop reflex verification over the actual demo-repo working tree.
// This mirrors EXACTLY what orchestrate() does after an executor finishes:
//   1. read executor report (parse via core's extractReportFromAgentMessage)
//   2. run real deterministic gate over the repo (gate.ts)
//   3. get real git diff/name-only (what the loop feeds reflex)
//   4. run reflex with REAL Jev, persist reflex-itN.log + reflex-history.json
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { discoverGateCommands, runGate, formatGateResult } from "../extension/gate.ts";
import { extractReportFromAgentMessage } from "../extension/core.ts";
import { runReflexLayer, makeJevClient, formatReflexResult } from "../extension/reflex/index.ts";
import { JevBackend } from "../extension/reflex/backend.ts";
import { normalizeReflexPolicy, type IterationState } from "../extension/reflex/types.ts";
import { execFile } from "node:child_process";

const repo = "demo-repo";
const artifactDir = join(repo, ".pi", "dual-gate", "reflex-e2e");
mkdirSync(artifactDir, { recursive: true });

const sh = (cmd: string[], cwd: string) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    execFile(cmd[0], cmd.slice(1), { cwd, timeout: 30000 }, (err, stdout) => {
      resolve({ code: err ? (err as any).code ?? -1 : 0, stdout: String(stdout ?? "") });
    });
  });

// --- 1. Real diff + name-only (what orchestrate feeds reflex) ---
const diffRes = await sh(["git", "diff", "HEAD"], repo);
const diffText = diffRes.stdout;
const nameRes = await sh(["git", "diff", "--name-only", "HEAD"], repo);
const filesChanged = nameRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
console.log("diff files:", filesChanged, "| diff size:", diffText.length, "chars");

// --- 2. Real deterministic gate ---
const discovery = discoverGateCommands(repo);
const gate = await runGate(repo, discovery, { timeoutMs: 60000 });
console.log("gate:", gate.passed ? "PASS" : "FAIL", "| steps:", gate.steps.map((s) => `${s.name}:${s.passed ? "PASS" : "FAIL"} (${s.durationMs}ms)`).join(", "));

// --- 3. Executor report — exactly the fenced YAML the executor writes ---
const report = extractReportFromAgentMessage(`\`\`\`yaml
status: completed
summary: detectTabletMode implemented per spec: tablet mode on when keyboard detached or undefined
files_changed:
  - path: src/rotate.js
    purpose: implementation
implementation:
  - tablet mode = attached===undefined || attached===false
tests:
  commands:
    - node --test tests/rotate.test.js
  passed:
    - node --test tests/rotate.test.js
  failed: []
validation:
  lint: not_run
  typecheck: not_run
  build: not_run
acceptance_check:
  keyboard attached → off: pass
  keyboard detached → on: pass
  undefined → on: pass
deviations: []
unresolved: []
risks: []
\`\`\``);

// --- 4. IterationState (mirrors collectIterationState in dual-gate.ts) ---
const state: IterationState = {
  iteration: 1,
  filesChanged,
  testsPassed: 1,
  testsFailed: 0,
  buildStatus: "not_run",
  errorSignature: "",
  diffSize: diffText.split(/\r?\n/).filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("++") && !l.startsWith("--")).length,
  requirementsCompleted: 3,
  requirementsTotal: 3,
};

// --- 5. Reflex with REAL Jev (observe mode) ---
const policy = normalizeReflexPolicy({ mode: "observe", backend: "hybrid", jev_deadline_ms: 3000 });
const jev = makeJevClient(new JevBackend(), policy);
const r = await runReflexLayer({
  policy, jev, iteration: 1, report,
  gate: { passed: gate.passed, steps: gate.steps },
  diffText, filesChanged, cwd: repo,
  prevState: undefined, state, turns: [],
  history: { noProgressStreak: 0, sameErrorStreak: 0 },
  ctx: { retryCount: 0, maxRetries: 3, totalIterations: 1 },
});

const log = [
  "=== REAL E2E REFLEX (demo-repo working tree) ===",
  `gate: ${gate.passed ? "PASS" : "FAIL"} (${formatGateResult(gate).replace(/\n/g, " | ")})`,
  `diff files: ${filesChanged.join(", ")}`,
  "--- reflex result ---",
  formatReflexResult(r),
  "",
  "interpretation:",
  r.loop.action === "CONTINUE"
    ? "evidence sufficient → would route to GPT-5.6 Judge (or DONE if no judge needed)"
    : r.loop.action === "RETRY"
      ? "evidence insufficient → same-pane RETRY, GPT-5.6 Judge skipped"
      : `loop action ${r.loop.action}`,
].join("\n");

writeFileSync(join(artifactDir, "reflex-it1.log"), log + "\n");
writeFileSync(join(artifactDir, "reflex-latest.log"), log + "\n");
writeFileSync(join(artifactDir, "reflex-history.json"), JSON.stringify({
  states: [state], noProgressStreak: 0, sameErrorStreak: 0, turns: [], jevConsulted: r.jevConsulted, retryCount: 0,
}, null, 2) + "\n");

console.log(log);
console.log(`\nartifacts written: ${artifactDir}/reflex-it1.log, reflex-history.json`);
