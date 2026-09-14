// Real end-to-end Dual-Gate demo: Controller (GPT-5.6 Sol) → Herdr DeepSeek pane → Gate → Judge.
// Uses the same code paths as the extension: core.ts parsing + gate.ts + herdr CLI.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), 'demo-repo');
const CONTROLLER_MODEL = 'openai-codex/gpt-5.6-sol';
const EXECUTOR_MODEL = 'new-api/deepseek-v4-flash';
const THINKING = 'medium';

// pi -p under async pipes can hang (observed SIGTERM); use sync for one-shot CLI calls.
import { execFileSync } from 'node:child_process';
function exec(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { timeout: opts.timeoutMs ?? 120000, cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message ?? '') };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Load core parser (strip-types via node) ----
// We import from the compiled TS via dynamic import with strip-types.
// For the demo, inline the minimal YAML extraction + report parsing from core.ts exports.

async function main() {
  console.log('=== Dual-Gate E2E Demo ===');
  console.log(`Controller: ${CONTROLLER_MODEL} / ${THINKING}`);
  console.log(`Executor:   ${EXECUTOR_MODEL}`);
  console.log(`Repo:       ${REPO}`);
  console.log('');

  // ---- 1. Controller: produce Expected Outcome ----
  // We need ctx.modelRegistry.complete — not available outside Pi. Instead we
  // invoke a real pi -p child with the controller model to produce the contract.
  console.log('[1/6] Controller planning (GPT-5.6 Sol)...');
  const contractPrompt = `You are the Controller/Architect of a Dual-Gate workflow. You do NOT write code.
Produce an Acceptance Contract for this user request in the repo ${REPO}:

REQUEST: 让 detectTabletMode 在键盘 detach 时返回 true，attach 时返回 false，且不能破坏现有测试。

Output ONLY a fenced YAML block:
goal: ...
context: ...
architecture:
  relevant_components:
    - ...
constraints:
  - ...
expected_outcome:
  - ...
acceptance_criteria:
  - ...
validation:
  required:
    - ...
risk:
  level: low|medium|high
  concerns:
    - ...`;
  const ctl = await exec('pi', ['--model', CONTROLLER_MODEL, '--no-extensions', '-p', contractPrompt], { timeoutMs: 180000 });
  if (ctl.code !== 0) { console.error('Controller failed:', ctl.stderr.slice(-500)); process.exit(1); }
  const contractText = ctl.stdout.trim();
  console.log('  Contract:', contractText.slice(0, 200).replace(/\n/g, ' | '), '...');
  console.log('');

  // ---- 2. Spawn DeepSeek in a visible Herdr pane ----
  console.log('[2/6] Spawning DeepSeek in visible Herdr pane...');
  const split = await exec('herdr', ['pane', 'split', '--current', '--direction', 'right', '--cwd', REPO, '--no-focus'], { timeoutMs: 30000 });
  const paneId = JSON.parse(split.stdout).result.pane.pane_id;
  console.log('  pane:', paneId);
  await exec('herdr', ['pane', 'rename', paneId, 'DS · demo-rotate'], { timeoutMs: 15000 });
  const start = await exec('herdr', ['agent', 'start', 'ds-demo1', '--kind', 'pi', '--pane', paneId, '--timeout', '150000', '--', '--model', EXECUTOR_MODEL, '--no-extensions'], { timeoutMs: 180000 });
  if (start.code !== 0) { console.error('agent start failed:', start.stderr.slice(-500)); process.exit(1); }
  console.log('  agent started in pane', paneId);
  console.log('');

  // ---- 3. Send task ----
  console.log('[3/6] Sending task to DeepSeek...');
  const taskText = `You are the Executor. Repo: ${REPO}
Implement the following (Controller contract):

${contractText}

Rules: explore the repo yourself, implement, run "npm test", fix until green, and finish with a fenced YAML Execution Report (status/files_changed/tests/validation/acceptance_check). Do not commit.`;
  const dispatch = await exec('herdr', ['agent', 'prompt', 'ds-demo1', taskText, '--timeout', '30000'], { timeoutMs: 45000 });
  if (dispatch.code !== 0) {
    console.error('Executor prompt submission failed:', dispatch.stderr.slice(-500));
    process.exit(1);
  }

  // ---- 4. Wait for completion (poll idle) ----
  console.log('[4/6] Waiting for DeepSeek to finish...');
  let done = false;
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const st = await exec('herdr', ['agent', 'get', 'ds-demo1'], { timeoutMs: 15000 });
    try {
      const s = JSON.parse(st.stdout).result?.state ?? JSON.parse(st.stdout).result?.agent_status;
      if (s === 'idle' || s === 'done') { done = true; console.log('  agent state:', s); break; }
      console.log('  agent state:', s);
    } catch { /* */ }
  }
  if (!done) {
    console.error('Executor completion was not observed; refusing to invoke the gate or Judge.');
    process.exit(1);
  }
  const read = await exec('herdr', ['agent', 'read', 'ds-demo1', '--source', 'recent-unwrapped', '--lines', '200'], { timeoutMs: 15000 });
  const finalText = read.stdout;
  console.log('');
  console.log('=== EXECUTOR OUTPUT (tail) ===');
  console.log(finalText.slice(-1800));
  console.log('================================');
  console.log('');

  // ---- 5. Deterministic gate: npm test ----
  console.log('[5/6] Deterministic gate (npm test)...');
  const gate = await exec('npm', ['test'], { cwd: REPO, timeoutMs: 120000 });
  console.log('  npm test exit:', gate.code);
  console.log('  ' + gate.stdout.split('\n').filter(l => l.includes('pass') || l.includes('fail')).slice(-3).join('\n  '));
  if (gate.code !== 0) {
    console.error('Gate failed; refusing to invoke the Judge.');
    process.exit(1);
  }
  console.log('');

  // ---- 6. Judge ----
  console.log('[6/6] Judge (GPT-5.6 Sol)...');
  const diff = (await exec('git', ['diff', 'HEAD'], { cwd: REPO })).stdout;
  const judgePrompt = `You are the Judge of a Dual-Gate workflow. Gate passed.
Compare Expected vs Actual and output fenced YAML: verdict: converged|implementation_gap|spec_gap|mixed_gap|blocked, matched, gaps, implementation_changes, spec_changes, delta (matched/missing/incorrect/unexpected/required_changes/must_preserve), reason.

EXPECTED CONTRACT:
${contractText}

EXECUTION REPORT:
${finalText.slice(-1200)}

DIFF:
${diff.slice(0, 3000)}

GATE: npm test exit ${gate.code}`;
  const judge = await exec('pi', ['--model', CONTROLLER_MODEL, '--no-extensions', '-p', judgePrompt], { timeoutMs: 180000 });
  console.log('  Judge:', judge.stdout.slice(0, 600).replace(/\n/g, '\n  '));
  console.log('');

  // ---- cleanup: keep pane (on_complete=keep default) ----
  console.log('Pane kept open (on_complete=keep). Run: herdr pane close ' + paneId + ' to clean up.');
  console.log('');
  console.log('=== E2E DEMO DONE ===');
}

main().catch((e) => { console.error(e); process.exit(1); });
