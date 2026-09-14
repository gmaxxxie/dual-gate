# Dual-Gate Orchestrator（Pi + Herdr）

> **English** → [README.md](README.md) · English version available here.

普通任务保持双角色闭环；项目模式为明确的**三 pane 架构**：**Astra（主 Pi）仍做 Controller/Judge**，持久、只读的 **Product Manager** 使用独立可见 Herdr pane，每个里程碑由 **DeepSeek Executor** 执行；Deterministic Gate 仍位于实现和判断之间。

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
Deterministic Gate  (项目已有 test/lint/typecheck/build)
 │
 ▼
Astra Compare  Expected ↔ Actual
 │
 ├─ CONVERGED ───────────────► DONE
 ├─ IMPLEMENTATION_GAP ──────► Delta ──► resume 同一个 DeepSeek pane
 ├─ SPEC_GAP ────────────────► Expected V2 ──► SPEC UPDATE ──► resume 同一个 pane
 ├─ MIXED_GAP ───────────────► Expected V2 + Delta ──► resume 同一个 pane
 └─ BLOCKED ─────────────────► ESCALATE（询问用户）
```

## 核心原则

- **Astra 是唯一 Controller/Judge**，用户只与主 Pi 对话；DeepSeek 是后台 Executor。
- **一个 Task = 一个持久 DeepSeek Session = 一个持久可见 Herdr Pane**。
  任务内所有迭代（gate 失败、implementation gap、spec 修订、judge 反馈）全部 **resume 同一个 pane 的同一个 session**，只发增量 Delta / SPEC UPDATE，绝不每轮重启。
- **Context 生命周期以 Task 为边界**：Task A 的 session 不会污染 Task B；新 Task 默认新 pane。
- **Spec 可以修订，但 User Intent 不可自动改变**：`User Intent > Expected Outcome > Implementation`。
  若用户核心目标无法满足 → `blocked` / ESCALATE，交给用户。
- **收敛条件**：Gate PASS **且** Acceptance Criteria 满足 **且** Expected ≈ Actual（verdict=converged）**且** 无阻塞 unresolved。
- **Token 策略**：昂贵智能做判断（GPT-5.6 Sol 只看 Spec/Report/Diff/Gate），便宜智能做执行（DeepSeek 全量探索 repo）；Gate 失败不调用 Judge。

## 安装

**默认关闭**：安装后 Dual-Gate 处于 OFF，完全不影响普通 Pi；用 `/dual on` 手动开启，`/dual off` 关闭。

### 方式 A：从 GitHub 安装（推荐，跨设备）

```bash
pi install git:github.com/gmaxxxie/dual-gate
# 或指定版本
pi install git:github.com/gmaxxxie/dual-gate@v1.0.0
# 临时试用（不写入配置）
pi -e git:github.com/gmaxxxie/dual-gate
```

### 方式 B：本地安装

```bash
bash install.sh
# 或手动
cp -r extension ~/.pi/agent/extensions/dual-gate/
```

安装后 **重启 Pi 或 `/reload`** 使扩展生效，然后：

```bash
/dual on      # 开启（默认关闭）
/dual status  # 确认
```

> 扩展依赖 `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` / `typebox`，这些在 Pi 运行时已内置（`npm:` 包已装在 Pi 的 node_modules），无需额外 npm install。

### 依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| Pi | 0.85.1 | 宿主；Controller/Judge 推理（`ctx.modelRegistry.complete`） |
| Herdr | 0.9.0 | 可见 Pane 运行时（`pane split/rename/get`、`agent start/prompt/get/read`） |
| pi-subagents | 0.67.0（已装，未编程调用） | 不重复实现；仅作为参考/可选 |

> **职责边界**：Herdr 负责 terminal/pane runtime；pi-subagents 负责 Pi 子会话编排（本项目 Executor 直接跑在 Herdr 可见 pane 中，由 Herdr 官方 agent API 管理，故未调用 pi-subagents 编程 API）；**Dual-Gate 只负责 workflow / policy / convergence**。`executor/subagent-adapter` 保持薄：只把 `spawn / resume / status / cancel / result / pane reference` 映射到 Herdr CLI。

## 模型（真实 ID 映射）

模型 ID **从当前 Pi registry 读取**，不硬编码。本机默认（已在安装时验证）：

| 角色 | 默认 | 说明 |
|---|---|---|
| Controller / Judge | `openai-codex/gpt-5.6-sol` | GPT-5.6 Sol，经 ChatGPT 订阅后端（`opencode/*` 无 auth，不可用） |
| Controller thinking | `medium` | 模型支持映射到 medium |
| Executor | `new-api/deepseek-v4-flash` | DeepSeek V4 Flash（本地网关，有 auth） |
| Product Manager | `default` | 仅项目模式；跟随主 Pi，使用只读 Herdr pane |

可随时切换：`/dual controller [id]`、`/dual executor [id]`、`/dual product-manager [id|default]`、`/dual thinking [level]`。

## 命令

| 命令 | 作用 |
|---|---|
| `/dual on` / `/dual off` | 开启/关闭。OFF 完全恢复普通 Pi |
| `/dual status` | 状态：模型、Herdr、Task、State、Iteration、Spec 版本、Pane、Session 存活及当前项目进度 |
| `/dual project <request>` | 生成项目 WBS，展示并显式确认后，按依赖串行执行里程碑 |
| `/dual project status` | 显示当前项目的里程碑/最终验收进度 |
| `/dual models` | 查看当前模型配置 |
| `/dual controller [id]` | 选择 Controller/Judge 模型（无参数弹 selector） |
| `/dual executor [id]` | 选择 Executor 模型（无参数弹 selector） |
| `/dual product-manager [id\|default]` | 选择仅项目模式、只读的 PM 模型 |
| `/dual thinking [level]` | thinking: minimal/low/medium/high/xhigh/max |
| `/dual cancel` | 取消当前任务：停止编排、保留 pane（重命名 `· CANCELLED`）、不删代码不 reset git |
| `/dual bypass` | 下一条用户任务走普通 Pi，之后恢复 Dual-Gate |
| `/dual cleanup` | 只关闭 Dual-Gate 创建的、已 DONE/CANCELLED/FAILED 的 pane（按 task ownership） |

## 配置（`~/.pi/agent/dual-gate.json`）

```json
{
  "enabled": false,   // 默认关闭；/dual on 后持久化为 true
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

## 项目模式（三 pane）

`/dual project <request>` 是显式入口；普通输入仍走原有单任务闭环。项目开始前会创建持久、可见的 **PM** Herdr pane，与主 Controller/Judge pane 和当前里程碑 Executor pane 并存。PM 只读（`read,grep,find,ls`，无 shell 或写入工具），只通过持久项目产物提交 WBS；主 Pi 校验、展示并让用户显式批准，且始终独占里程碑契约、任务规划/控制、Gate、Judge、持久化和取消权。

每个里程碑仍复用 Executor → Gate → Judge 闭环；其任务收敛并持久化后，主 Pi 向同一个 PM 发送有界、持久化的完成交接。PM 返回 `blocked` 会停止项目；PM 响应畸形、超时或会话丢失会 fail closed。全部里程碑后，主 Pi 先跑最终 Gate，再取得强制的 PM 产品验收，最后进行 Controller 独立 ratification。只有 PM 与 Controller 都 `accepted` 且无 gaps/unresolved、最终 Gate 通过、所有里程碑无 unresolved 地收敛，项目才会 `ACCEPTED`。默认保留 PM pane 供检查；`panel.on_complete: close` 或 `/dual cleanup` 才关闭。

## Artifacts（每个任务）

```
.pi/dual-gate/<task-id>/
├── task.md
├── spec.yaml            # 最新 Expected Outcome
├── spec-v1.yaml …       # 版本化 Expected
├── spec-update.md       # SPEC UPDATE（增量同步给同一 session）
├── spec-revisions.jsonl # 修订历史（为什么改）
├── checkpoint.yaml      # L2 durable context（Executor Checkpoint）
├── checkpoint-itN.yaml
├── execution-report.yaml
├── execution-report-itN.yaml
├── judge.yaml / judge-itN.yaml
├── gate.log / gate-discovery.json
├── recovery-prompt.md
├── state.json / metadata.json
```

不保存模型 private CoT；只保存 Expected / Actual / Delta / Gate / State。

## 项目产物

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
└── project-acceptance-report.md（PM 输入 + Controller ratification）
```

里程碑的标准任务产物仍在 `.pi/dual-gate/<task-id>/`；`task-ref.json` 只链接它们，不改变恢复或 worktree 行为。

## 状态机

```
IDLE → PLANNING → SPAWNING_EXECUTOR → EXECUTING → GATING
  ├─ GATING FAIL → FIXING_GATE → GATING（deterministic，不调 GPT）
  └─ GATING PASS → JUDGING
       ├─ converged → DONE
       ├─ implementation_gap → FIXING_IMPLEMENTATION → (同 session) → GATING
       ├─ spec_gap / mixed_gap → REVISING_SPEC → SPEC UPDATE → (同 session) → GATING
       └─ blocked → ESCALATED
另：DIAGNOSING（迭代阈值 → Convergence Diagnosis）、WAITING_PERMISSION（高风险）、FAILED、CANCELLED
```

## 收敛与防循环

- 每轮记录 `gap_count / previous_gap_count / same_gap_streak / progress`。
- `gap_count` 下降 → improving；持平 → stalled；上升 → worsening。
- 连续 2 轮相同 gap → `executor_stuck = true`，提示可 `/dual executor` 换更强模型（不迁就 Executor 改正确 Spec）。
- 达到 `max_iterations`（默认 5）不机械失败：执行一次 **Convergence Diagnosis**（Astra），判断 continue / architecture / spec / executor / user。

## Session 异常恢复（L1/L2）

- **L1 Live Context**：DeepSeek session（pane 内 pi 进程）。
- **L2 Durable Context**：Expected / Actual / Delta / Checkpoint / Diff / Gate。
- 若 L1 丢失（pane 回收 / crash / restart），用 L2 在**新 pane**（标题 `· recovered`）恢复，提示 "Continue the existing task, do not restart from scratch"。

## 已知环境事实（本机验证）

- `herdr pane split --cwd <git-repo>` 的 pane 会被回收（shell 检测失败），故 **split 始终用主 pane cwd**，Executor 通过 prompt 里的 REPOSITORY 路径自行 cd。
- `agent prompt --wait` 对快速完成的回复会误报 `agent_prompt_stalled`——实际消息已处理；扩展用**轮询 `agent get` 到 idle/done**。
- `pi -p`（print 模式）在异步 execFile 下可能 SIGTERM（需同步调用）；扩展内推理走 `modelRegistry.complete`（进程内），不受影响。
- 主 pane cwd 的 split 稳定（连续 5/5 存活），git repo cwd 的 split 稳定回收（0/5 存活）。

## 测试

```bash
cd /home/max/dual-gate
node --experimental-strip-types tests/core.test.ts
```

覆盖：config 默认/规范化/非法值、模型解析与 PM 的严格可用/已认证模型校验、task id/标题/agent 名、状态机转移、收敛跟踪、风险检测、YAML/Execution Report/Judge 解析（converged/implementation_gap/spec_gap/blocked）、contract/spec-revision/diagnosis 解析、prompt 构建（initial/delta-fix/judge）、项目 WBS/依赖排序/里程碑契约、PM 只读启动参数及计划/交接反馈/最终产品验收的 prompt+response IPC 关联、artifact store、gate 发现（node/python/go/无命令）、gate 运行（pass/fail）。

## 端到端验证记录（真实运行）

已在 demo-repo（`/home/max/dual-gate/demo-repo`）真实跑通：

1. `pane split --current --direction right --cwd /home/max --ratio 0.4 --no-focus` → `w2:p21`（可见 pane，与主 pane 同 tab）
2. `agent start ds-* --kind pi --pane w2:p21 -- --model new-api/deepseek-v4-flash --no-extensions` → `idle, interactive_ready`
3. `agent prompt`（含 REPOSITORY + Expected Outcome）→ DeepSeek 在 pane 内真实执行：cd 到 repo、实现 `detectTabletMode`、发现 `node --test tests/` 目录参数问题并修复 package.json、`npm test` 1/1 pass
4. 第二个 prompt（Delta：处理 undefined）→ **同一 session** 完成增量修复，最终 `return attached !== true`，测试通过
5. `agent read` 全程可观察执行过程

---

**License**: MIT

**English** → [README.md](README.md)
