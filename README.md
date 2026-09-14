# Dual-Gate Orchestrator (Pi + Herdr)

> **中文版** → [README.zh-CN.md](README.zh-CN.md) · Chinese version available here.

A development workflow with a normal two-role task loop and an explicit **three-pane project mode**: **Astra (main Pi) remains Controller/Judge**, a persistent read-only **Product Manager** runs in its own visible Herdr pane, and **DeepSeek runs each milestone as Executor**. The Deterministic Gate remains between implementation and judgment.

```
USER
 │
 ▼
Astra / Main Pi  (GPT-5.6 Sol · Medium)          ◄── Controller + Judge
 │
 │ Expected Outcome V1
 ▼
Herdr  ── split right 40% ──►  New Visible Pane  ◄── DeepSeek V4 Flash Executor
 │                                (DS · <task>)
 │                                Explore → Implement → Debug → Test → Report
 ▼
Deterministic Gate  (existing project test/lint/typecheck/build)
 │
 ▼
Astra Compare  Expected ↔ Actual
 │
 ├─ CONVERGED ───────────────► DONE
 ├─ IMPLEMENTATION_GAP ──────► Delta ──► resume the same DeepSeek pane
 ├─ SPEC_GAP ────────────────► Expected V2 ──► SPEC UPDATE ──► resume the same pane
 ├─ MIXED_GAP ───────────────► Expected V2 + Delta ──► resume the same pane
 └─ BLOCKED ─────────────────► ESCALATE (ask the user)
```

## Core Principles

- **Astra is the only Controller/Judge**; the user talks only to the main Pi; DeepSeek is the background Executor.
- **One Task = one persistent DeepSeek Session = one persistent visible Herdr pane.**
  Every iteration within a task (gate failure, implementation gap, spec revision, judge feedback) **resumes the same pane / the same session**, sending only incremental Deltas / SPEC UPDATEs — never restarting from scratch.
- **Context lifetime is bounded by the Task**: Task A's session never pollutes Task B; a new task gets a new pane by default.
- **Spec may be revised, but User Intent can never be changed automatically**: `User Intent > Expected Outcome > Implementation`.
  If the user's core goal cannot be met → `blocked` / ESCALATE, hand it back to the user.
- **Convergence conditions**: Gate PASS **and** Acceptance Criteria met **and** Expected ≈ Actual (verdict=converged) **and** no blocking unresolved item.
- **Token strategy**: expensive intelligence judges (GPT-5.6 Sol only reads Spec/Report/Diff/Gate), cheap intelligence executes (DeepSeek explores the full repo); gate failures do not call the Judge.

## Installation

**OFF by default**: after installing, Dual-Gate is OFF and does not affect normal Pi at all. Enable manually with `/dual on`, disable with `/dual off`.

### Option A: Install from GitHub (recommended, cross-device)

```bash
pi install git:github.com/gmaxxxie/dual-gate
# or pin a version
pi install git:github.com/gmaxxxie/dual-gate@v1.0.0
# try temporarily (not persisted to config)
pi -e git:github.com/gmaxxxie/dual-gate
```

### Option B: Local install

```bash
bash install.sh
# or manually
cp -r extension ~/.pi/agent/extensions/dual-gate/
```

After installing, **restart Pi or `/reload`** for the extension to take effect, then:

```bash
/dual on      # enable (off by default)
/dual status  # verify
```

> The extension depends on `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` / `typebox`, which are already bundled with the Pi runtime (`npm:` packages are installed in Pi's node_modules). No extra `npm install` needed.

### Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| Pi | 0.85.1 | Host; Controller/Judge reasoning (`ctx.modelRegistry.complete`) |
| Herdr | 0.9.0 | Visible pane runtime (`pane split/rename/get`, `agent start/prompt/get/read`) |
| pi-subagents | 0.67.0 (installed, not called programmatically) | Not reimplemented; reference/optional only |

> **Responsibility boundary**: Herdr owns the terminal/pane runtime; pi-subagents owns Pi sub-session orchestration (this project's Executor runs directly in a visible Herdr pane, managed by Herdr's official agent API, so pi-subagents' programming API is not called); **Dual-Gate only owns workflow / policy / convergence**. `executor/subagent-adapter` stays thin: it only maps `spawn / resume / status / cancel / result / pane reference` onto the Herdr CLI.

## Models (real ID mapping)

Model IDs are **read from the current Pi registry**, never hardcoded. Defaults on this machine (verified at install time):

| Role | Default | Notes |
|---|---|---|
| Controller / Judge | `openai-codex/gpt-5.6-sol` | GPT-5.6 Sol, via ChatGPT subscription backend (`opencode/*` has no auth, unusable) |
| Controller thinking | `medium` | model supports mapping to medium |
| Executor | `new-api/deepseek-v4-flash` | DeepSeek V4 Flash (local gateway, has auth) |
| Product Manager | `default` | Project-only, follows the parent Pi model; read-only Herdr pane |

Switch anytime: `/dual controller [id]`, `/dual executor [id]`, `/dual product-manager [id|default]`, `/dual thinking [level]`.

## Commands

| Command | Effect |
|---|---|
| `/dual on` / `/dual off` | Enable/disable. OFF fully restores normal Pi |
| `/dual status` | Status: models, Herdr, Task, State, Iteration, Spec version, Pane, Session alive, and active project progress |
| `/dual project <request>` | Create a project WBS, show it for explicit approval, then execute dependency-ordered milestones serially |
| `/dual project status` | Show active project milestone/final-acceptance progress |
| `/dual models` | View current model config |
| `/dual controller [id]` | Choose Controller/Judge model (no arg opens a selector) |
| `/dual executor [id]` | Choose Executor model (no arg opens a selector) |
| `/dual product-manager [id\|default]` | Choose the project-only read-only PM model |
| `/dual thinking [level]` | thinking: minimal/low/medium/high/xhigh/max |
| `/dual cancel` | Cancel current task: stop orchestration, keep the pane (renamed `· CANCELLED`), don't delete code or reset git |
| `/dual bypass` | Next user task goes through normal Pi, then Dual-Gate resumes |
| `/dual cleanup` | Close only panes created by Dual-Gate that are DONE/CANCELLED/FAILED (by task ownership) |

## Configuration (`~/.pi/agent/dual-gate.json`)

```json
{
  "enabled": false,   // off by default; persisted to true after /dual on
  "controller": { "model": "openai-codex/gpt-5.6-sol", "thinking": "medium" },
  "executor": { "model": "new-api/deepseek-v4-flash" },
  "product_manager": { "model": "default" },
  "runtime": { "herdr": "required" },
  "gate": { "enabled": true, "max_retries": 3, "timeoutMs": 300000 },
  "judge": { "max_retries": 2 },
  "loop": { "max_iterations": 5 },
  "panel": { "direction": "right", "ratio": 0.4, "on_complete": "keep" },
  "worktree": { "mode": "auto" },
  "context": { "send_full_executor_history_to_judge": false },
  "ui": { "show_widget": true }
}
```

## When to enable Dual-Gate

Use this extension for **delivery work that needs an explicit acceptance contract and an auditable implementation loop**, not ordinary conversation or tiny, low-risk edits.

| Need level | Entry point | Use it when |
|---|---|---|
| Conversation / exploration | Do not enable | You need an answer, research, brainstorming, or a decision—not repository changes with acceptance evidence. |
| Bounded engineering task | `/dual on`, then send the task normally | One coherent change can be owned by one Executor session and verified by tests/Gate/Judge. Examples: a bug fix, a focused feature, a refactor, or a security-sensitive change. |
| Project / product delivery | `/dual on`, then `/dual project <request>` | The request needs product planning, WBS/milestones, dependencies, staged acceptance, and progress feedback. This is the three-pane mode. |

Do not use project mode for trivial edits, independent chores, or work that cannot justify milestone planning and an additional model session. Use ordinary task mode first when a project can be safely reduced to one acceptance contract.

## Project mode (three panes)

`/dual project <request>` is explicit: ordinary prompts remain unchanged. Project mode creates a persistent visible **PM** Herdr pane before WBS generation, alongside the main Controller/Judge pane and the current milestone Executor pane. The PM is read-only (`read,grep,find,ls`; no shell or write tools) and produces its WBS only through durable project artifacts. Main Pi validates and presents that WBS for explicit user approval, then remains sole owner of milestone contracts, task planning/control, Gate, Judge, persistence, and cancellation.

Each milestone still uses the unchanged Executor → Gate → Judge loop. Once its persisted task has converged, Main sends the same PM a bounded durable completion handoff. A PM `blocked` handoff stops the project; malformed, timeout, or lost-PM failures fail closed. After all milestones, Main runs the final Gate, obtains mandatory PM product acceptance, then independently asks the Controller for ratification. `ACCEPTED` requires clear PM acceptance, clear Controller ratification, a final Gate pass, and every milestone converged with no unresolved items. PM panes remain for inspection unless `panel.on_complete` is `close` or `/dual cleanup` is run.

## Artifacts (per task)

```
.pi/dual-gate/<task-id>/
├── task.md
├── spec.yaml            # latest Expected Outcome
├── spec-v1.yaml …       # versioned Expected
├── spec-update.md       # SPEC UPDATE (incremental sync to the same session)
├── spec-revisions.jsonl # revision history (why it changed)
├── checkpoint.yaml      # L2 durable context (Executor Checkpoint)
├── checkpoint-itN.yaml
├── execution-report.yaml
├── execution-report-itN.yaml
├── judge.yaml / judge-itN.yaml
├── gate.log / gate-discovery.json
├── recovery-prompt.md
├── state.json / metadata.json
```

Model private CoT is never saved; only Expected / Actual / Delta / Gate / State.

## Project artifacts

```
.pi/dual-gate/projects/<project-id>/
├── project-plan.yaml
├── project-state.json / project-approval.json
├── product-manager/
│   ├── metadata.json / plan-request.json / plan-response-raw.md
│   ├── milestone-<M>-request.json / milestone-<M>-feedback.yaml
│   └── final-acceptance-request.json / product-acceptance.yaml
├── controller-ratification.yaml
├── milestones/<M-id>/milestone.yaml
├── milestones/<M-id>/state.json / task-ref.json
├── final-gate-discovery.json / final-gate.log
└── project-acceptance-report.md (PM input + Controller ratification)
```

Milestone task artifacts remain in their normal `.pi/dual-gate/<task-id>/` directories; `task-ref.json` links them without changing recovery or worktree behavior.

## State Machine

```
IDLE → PLANNING → SPAWNING_EXECUTOR → EXECUTING → GATING
  ├─ GATING FAIL → FIXING_GATE → GATING (deterministic, no GPT)
  └─ GATING PASS → JUDGING
       ├─ converged → DONE
       ├─ implementation_gap → FIXING_IMPLEMENTATION → (same session) → GATING
       ├─ spec_gap / mixed_gap → REVISING_SPEC → SPEC UPDATE → (same session) → GATING
       └─ blocked → ESCALATED
Also: DIAGNOSING (iteration threshold → Convergence Diagnosis), WAITING_PERMISSION (high risk), FAILED, CANCELLED
```

## Convergence & Anti-loop

- Each round records `gap_count / previous_gap_count / same_gap_streak / progress`.
- `gap_count` decreasing → improving; flat → stalled; increasing → worsening.
- 2 consecutive identical gaps → `executor_stuck = true`, suggest `/dual executor` to switch to a stronger model (never bend the correct Spec to accommodate the Executor).
- Reaching `max_iterations` (default 5) is not a mechanical failure: run a **Convergence Diagnosis** (Astra) to decide continue / architecture / spec / executor / user.

## Session Crash Recovery (L1/L2)

- **L1 Live Context**: the DeepSeek session (the pi process inside the pane).
- **L2 Durable Context**: Expected / Actual / Delta / Checkpoint / Diff / Gate.
- If L1 is lost (pane reaped / crash) while the extension session remains active, recover with L2 in a **new pane** (titled `· recovered`), prompting "Continue the existing task, do not restart from scratch". A Pi restart preserves artifacts for inspection but does not yet resume an in-flight loop automatically.

## Known Environment Facts (verified on this machine)

- `herdr pane split --cwd <git-repo>` panes get reaped (shell detection failure), so **split always uses the main pane cwd**; the Executor cd's itself via the REPOSITORY path in the prompt.
- `agent prompt --wait` can falsely report `agent_prompt_stalled` for fast replies — the message is actually processed; the extension **polls `agent get` until idle/done** instead.
- `pi -p` (print mode) can SIGTERM under async execFile (needs sync calls); in-extension reasoning goes through `modelRegistry.complete` (in-process), unaffected.
- Splits on the main pane cwd are stable (5/5 survived); splits on a git repo cwd are reliably reaped (0/5 survived).

## Tests

```bash
cd /path/to/dual-gate
node --experimental-strip-types tests/core.test.ts   # core assertions
```

Covers: config defaults/normalization/invalid values, task id/title/agent name, state machine transitions, convergence tracking, risk detection, YAML/Execution Report/Judge parsing (converged/implementation_gap/spec_gap/blocked), contract/spec-revision/diagnosis parsing, prompt building (initial/delta-fix/judge), artifact store, gate discovery (node/python/go/no command), gate running (pass/fail).

## End-to-End Verification (real runs)

The authenticated, mutating end-to-end demo targets this checkout's `demo-repo/` (the scripts derive the path from their own location):

1. `pane split --current --direction right --cwd /home/max --ratio 0.4 --no-focus` → `w2:p21` (visible pane, same tab as main pane)
2. `agent start ds-* --kind pi --pane w2:p21 -- --model new-api/deepseek-v4-flash --no-extensions` → `idle, interactive_ready`
3. `agent prompt` (with REPOSITORY + Expected Outcome) → DeepSeek actually executes in the pane: cd to repo, implement `detectTabletMode`, discover the `node --test tests/` directory-arg problem and fix package.json, `npm test` 1/1 pass
4. Second prompt (Delta: handle undefined) → **same session** completes the incremental fix, final `return attached !== true`, tests pass
5. `agent read` observes the whole execution process

---

**License**: MIT

**中文版** → [README.zh-CN.md](README.zh-CN.md)
