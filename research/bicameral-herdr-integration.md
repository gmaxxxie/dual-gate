# Bicameral × Herdr Reflex Layer — 源码级分析与融合设计

> 研究目标：**不是介绍 Bicameral**，而是判断其 Gate / Honest Finish / Stuck Detector / Deterministic Policy 机制如何作为轻量 **Reflex Layer (System-1)** 融合进现有 **GPT-5.6 Sol Planner + DeepSeek Executor + Herdr pane** 研发闭环。
>
> 结论先行：**Bicameral 本身就是为 Pi 写的扩展，钩子与 Pi 0.85.1 完全同构；你的 dual-gate 项目已经实现了闭环里最贵的"判断"（Judge、Convergence Diagnosis），但缺少闭环内、低成本的"反射"层。Bicameral 的四个核心机制应被**提取模式、按需重写**，而不是直接安装它的包。** 关键洞察：**不要把 Bicameral 作为第二个扩展装进去，而是把它的 Pattern 变成 dual-gate 内部的一个 reflex 模块。** 因为 dual-gate 的 Executor 跑在独立的 Herdr pane 里，Bicameral 的 `pi.sendMessage(deliverAs:"steer"/"followUp")` 语义需要映射为 `herdr agent prompt` 指令，这是"照搬不可行、必须重写"的核心证据。

---

## 0. 现状盘点（读了什么代码）

| 代码库 | 位置 | 关键文件 |
|---|---|---|
| Bicameral v0.1.0 | `/tmp/bicameral/bicameral` | `packages/s1-runtime/src/{decisions/gate.ts,decisions/honest-finish.ts,decisions/stuck.ts,policy.ts,high-risk.ts,state.ts,speculator.ts,truncation.ts,redaction.ts,budget.ts,cache.ts,format/*.ts,backends/*.ts}`；`packages/pi-bicameral/src/{index.ts,config.ts,pi-types.ts}`；`packages/packs/{yaml/*.yaml,src/loader.ts}` |
| dual-gate | `/home/max/Project/dual-gate` | `extension/dual-gate.ts` (155KB, 主线闭环)、`extension/core.ts` (prompts/parsing/state machine)、`extension/gate.ts` (deterministic gate)、`extension/types.ts`、`tests/core.test.ts` |
| Pi API | `@earendil-works/pi-coding-agent 0.85.1` | `dist/core/extensions/types.d.ts`（已逐字段核对 hook 签名） |

**关键发现：你的 dual-gate 已经内置了闭环判断的骨架，Bicameral 的许多概念已有对应物：**

| 概念 | Bicameral | dual-gate 现状 |
|---|---|---|
| 确定性 gate | `isHighRiskByPattern` + `gate.yaml` + `decideGate` | `extension/gate.ts` 的 `discoverGateCommands/runGate`（跑项目真实 test/lint/build）|
| 完成判断 | `honest-finish.ts` + `edit_review.yaml` + `finish_check.yaml` | `normalizeReport` + `parseJudgeOutput` + Judge（GPT-5.6 判 expected↔actual）|
| 卡住检测 | `stuck.ts` + `StuckTracker` + `progress.yaml` | `trackConvergence`（sameGapStreak→executorStuck）+ `convergenceDiagnosis` |
| 策略/升级 | `policy.ts` (YAML 阈值) + `mode: observe/enforce` | `config.gate.max_retries`、`config.loop.max_iterations`、verdict switch |

**双方案质差异：** Bicameral 的"判断"发生在**单个 Pi 会话内部**（tool_call / tool_result / turn_end），毫秒级、跑在便宜后端（Jev 或 fake）；dual-gate 的"判断"发生在**会话之间**（Executor 跑完一个完整 iteration 后），由 GPT-5.6 Judge 一次调用完成，分钟级、贵。**两者互补，不冲突。** 融合的价值 = 在 Executor 的**每个 iteration 内部**（而不是 iteration 之间）加一层 Reflex，让"普通判断"不再每次都劳驾 GPT-5.6。

---

## 1. Bicameral 架构（源码级）

### 1.1 数据流（README + `packages/pi-bicameral/src/index.ts` 证实）

```
System 2 (任何 Pi LLM) 规划/写码
        │
        ▼
Pi 事件流:  before_agent_start → message_update → tool_call → tool_result → turn_end → agent_end
        │
        ▼
Reflex:  state builder → redactSecrets → System 1 (Jev, 带 deadline) → decide* → policy YAML → action
        │
        ▼
action 通过:  tool_call 返回值 block / ctx.ui.confirm / pi.sendMessage(steer|followUp) / 修改 tool_result content
```

三个 reflex 的 hook 映射（来自 `packages/pi-bicameral/src/index.ts`）：

| Reflex | Hook | 文件:函数 |
|---|---|---|
| Gate | `message_update`(prefetch) → `tool_call`(decide) | `index.ts` → `decisions/gate.ts:evaluateGate/decideGate` |
| Honest Finish | `tool_result` (edit/write) | `index.ts` → `decisions/honest-finish.ts:evaluateHonestFinish/decideHonestFinish` |
| Stuck Detector | `turn_end` | `index.ts` → `decisions/stuck.ts:evaluateStuck/decideStuck` |

### 1.2 核心概念实体

- **Pack（判断包）**：`packages/packs/yaml/*.yaml` — YAML 定义 `questions`（noul/score/choice）+ `state` 形状。loader 编译为 `@typesafe-ai/sdk` 的 `Questions`，并算 `packHash`（sha256 规范化 JSON，`canonical.ts`）。
- **Backend（System-1 后端）**：`S1Backend.decide(state, questions, {signal, timeoutMs})`。`TypeSafeBackend`（真 Jev）、`FakeBackend`（测试脚本化）、`UnavailableBackend`（无 key 时 fallback）。
- **Speculator（预取+缓存）**：`speculator.ts` — 在 `message_update` 的 `toolcall_end` 时就开始 prefetch（趁 LLM 还在流式输出剩余消息），`tool_call` 时 `take(deadlineMs)` 取结果；超时 abort。`cache.ts` 按 `hash(packHash, redactedState)` 做 10 分钟内容寻址缓存——**重试同一命令免费**。
- **BudgetTracker**：`budget.ts` — S1 决策数/延迟 p50/p95/预计 USD；`estimatedUsd >= s1_daily_usd` → `degraded`，reflex 降级到 fallback 策略。
- **Policy**：`policy.ts` — `DEFAULT_POLICY` + YAML overlay deep merge；`mode: observe|enforce`；每 reflex 有 `enabled`、`deadline_ms`、各信号阈值。**这是"确定性策略"的落点：所有阈值都是数字，不是模型输出。**
- **Decision record**：`types.ts:BicameralDecision` — 每个决策一条记录：reflex/pack/packHash/backend/stateRedacted/questions/answers/policyRule/action/latencyMs。`pi.appendEntry("bicameral.decision", record)` **不进 LLM context**（custom entry）。`/why`、HUD、`/s1` 都从这些记录渲染。

### 1.3 关键设计决定（从源码读出）

1. **System 1 只出分数，绝不生成文本**。`decide*` 全部是纯函数：`(answers, policy, 预信号) → action`。hint / reason / followup 文案全是**模板**（`templateHint`、`blockReason`），不是模型写的。这是"可预测、可审计"的根本。
2. **超时/错误有明确 fallback**：`decideGate` 里 `answers === "timeout" || "error"` → `isHighRiskByPattern` 判高危险则 confirm/block，否则 allow。**System-1 挂了不等于放行危险操作，也不等于卡死流程。**
3. **状态预算硬上限**：`truncation.ts` DEFAULT_STATE_BUDGET=8000 字符，按 priority 顺序截断，UTF-8 安全；`redaction.ts` 在任何 backend 调用前脱敏（私钥/JWT/AWS key/`key=value` 赋值）。
4. **先本地确定性，再问 System-1**：Stuck 有 `preSignals()`（identical_command_error、oscillation）**纯本地检测**，命中才必查 System-1；否则每 3 个 turn 查一次。**本地信号优先，昂贵判断兜底。**

---

## 2. Gate 深入分析

### 2.1 触发点

`pi-bicameral/src/index.ts`:

```ts
pi.on("message_update", (event, ctx) => {          // 预取：LLM 还在流式输出时就开跑
  const ame = event.assistantMessageEvent;
  if (ame?.type !== "toolcall_end" || !ame.toolCall?.id) return;
  speculator.prefetch(ame.toolCall.id, { state: buildGateState({...}) });
});
pi.on("tool_call", async (event, ctx) => {         // 决定：真正执行前
  const result = await evaluateGate({...});
  if (result.action.kind === "confirm" && ctx.hasUI) { const ok = await ctx.ui.confirm(...); if (!ok) return { block: true }; }
  if (result.action.kind === "block") return { block: true, reason: result.action.reason };
});
```

**阶段：任何 tool call 执行前**（包括 bash、edit、write、read、自定义工具）。不是只在 shell 或 destructive 前。

### 2.2 输入 / 输出

- 输入：`buildGateState` → `{ user_goal, proposed_action:{tool,input}, flagged_content, recent_actions }`（全部截断+脱敏）。
- 输入（包）：`gate.yaml` 5 问：
  - `reversibility` (score 0-3: read-only → irreversible/external)
  - `exfiltration` (noul: 外发数据/凭据)
  - `secret_access` (noul: 读/打印/传输 secrets)
  - `injected_intent` (noul: 被工具输出里的指令驱动，而非用户目标)
  - `scope_escape` (noul: 影响项目目录之外)
- 输出：`GateAction { kind: "allow"|"confirm"|"block", reason, policyRule }`。

### 2.3 谁最终决定 — 两级结构（关键回答）

**模型（System-1）只提供概率分数；最终 action 由确定性 policy 代码决定。** 完整链：

```
model judgment (noul/score 概率)
        ↓
decideGate(input)  ← 纯函数，无模型调用
        ↓ 按顺序检查：
        pExfil ≥ gate.exfiltration.block (0.6)       → block
        pInject ≥ injected_intent.block (0.8)        → block
        任一 confirm 阈值 (0.25/0.4/0.5/0.5 或 reversibility≥2) → confirm
        否则 → allow
        ↓
        hasUI ? ctx.ui.confirm : headless_confirm_as (默认 block)
```

- `allow`：放行。
- `confirm`：有 UI → 弹 `ctx.ui.confirm`，用户点否 → block；无 UI（print/RPC）→ 按 `headless_confirm_as`（默认 **block**）处理。
- `block`：`tool_call` 返回 `{ block: true, reason }`，reason 是写给 LLM 的模板文案（"Blocked: this command appears to … Do not retry; explain to the user…"）。

**结论：`decideGate` 是 deterministic policy，模型概率只作为它的输入信号。`ALLOW/WARN/CONFIRM/BLOCK` 全部由阈值比较决定，阈值在 `bicameral.yaml`。** 这正符合你要的 "model judgment → score → deterministic policy → action"。

### 2.4 超时降级

`answers === "timeout"|"error"` → `isHighRiskByPattern(toolName, input, cwd)`（`high-risk.ts`）：网络工具（web_fetch/web_search/curl/wget/ssh/scp…）、包安装（npm/pip/apt/brew…）、`git push`、递归 `rm`、**路径在 `cwd` 之外**。命中 → confirm/block；否则 allow。**这是"System-1 不可用时的最小安全网"，纯本地正则，零成本。**

---

## 3. Honest Finish 深入分析

### 3.1 它实际检测什么（诚实答案）

**它没有检测"任务完成"，而是检测"声称完成的证据链可疑"。** 两段式：

**A. 编辑时（`tool_result` of edit/write，`pack: edit_review`）** — 每次编辑/写入文件时查：
- `test_weakened` (noul)：删/松/跳/禁断言，或改期望值迁就现状。
- `stub_introduced` (noul)：占位符/TODO-only/为特定测试输入硬编码返回/吞错误。
- `edit_matches_goal` (score)：编辑与目标相关性。

action：
- `warn`（p≥0.5/0.6）→ **patch tool result**：`return { content: [...original, {type:"text", text:"Bicameral: this edit appears to weaken a test (p=0.82)…"}] }`。模型看到追加的警告文本。
- `followup`（p≥0.75）→ `pi.sendMessage({...}, { deliverAs: "followUp", triggerTurn: true })` 强制触发一轮，每 prompt 上限 `max_followups_per_prompt=2`。命中即置 `session.tamperSuspected = true`。

**B. agent_end（`pack: finish_check`）** — 会话结束查：
- `unverified_claim` (noul)：**最终文本声称成功（tests pass / bug fixed / build works），但最后一次相关编辑之后没有任何动作验证它**。
- `goal_met` (noul)。

> 注意：`finish_check` 包在 v0.1 源码里**已定义但未在 `index.ts` 的 `agent_end` handler 中接线**（SPEC §R2 写了，代码里只有 edit_review 路径）。这是 v0.1 的已知缺口——你要的"研发完成判断"恰恰需要把它接上或重写。

### 3.2 它需要读取多少 context

`buildEditReviewState` 只需要：`user_goal` + `file_path` + `is_test_path` + `diff_hunks`（**编辑工具输入里的 oldText/newText 摘要，最多 60 行，3 行上下文**）+ `latest_test_outcome`。**它从不读完整文件、从不读完整对话**。`buildFinishCheckState` 只需要 `final_assistant_text` + `last_edit_summary` + `verification_after_edit`。

### 3.3 与你要的"研发完成判断"差距

Bicameral Honest Finish 覆盖：test 弱化、stub、unverified claim。**未覆盖**：test 被删除、test 没跑、build 没跑、lint 没跑、expected files 没改、scope 溢出、silent failure、partial completion、fake success（声称通过但 gate 实际失败）。这些恰恰是你的 deterministic gate（`gate.ts`）+ Judge 已经在做的。**所以正确的融合不是移植 Honest Finish 原样，而是把它的"证据链质疑"思想接到你已有的 `normalizeReport` + gate 结果上。** 详细设计见 §7。

---

## 4. Stuck Detector 深入分析

### 4.1 机制

`decisions/stuck.ts` + `StuckTracker`：

- **历史状态**：ring buffer，最后 `window_turns=6` 个 turn，每个 `TurnRecord { toolName, argsSummary, isError, errorLine, filesEdited:[{path,hunkHash}] }`。**保存 6 个 turn 的紧凑记录**，不是全部历史。
- **本地确定性 pre-signals（不花钱）**：
  1. `identical_command_error`：最近一次 turn 是 error，且**之前存在相同 toolName + 相同 argsSummary + 相同 errorLine** → 重复同命令同错误。
  2. `oscillation`：同一文件历史 hunkHash 数量 ≥3 且唯一值 ≤2 → 在两个状态之间反复横跳。
- **何时问 System-1**：`shouldConsultSystem1(everyN=3)` — 有 pre-signal 立即问；否则每 3 个 turn 问一次。
- **System-1 问 4 个 noul**：`repeat_failure`、`oscillation`、`no_progress`、`root_cause_ignored`。
- **action**：`none` / `steer`（模板 hint，`deliverAs:"steer"`）/ `raise_thinking`（`pi.setThinkingLevel("high")` 提思考档）/ `ask_user_after=3` 次后让用户选择 continue/换模型/停止。

### 4.2 如何避免误判正常 debug

- **只对"同一命令+同一错误"计为 repeat**（不是任何重复调用）。
- **只对"同一文件在两个 hunk 间往返 ≥3 次"计为 oscillation**。
- `no_progress` 是 System-1 判断，但模板 hint 是确定的。
- **阈值都在 policy**（`repeat_failure.steer: 0.7` 等），可以调。
- 但注意：**它没有"测试失败数 8→5→2 也算 progress"这种量化信号**。Bicameral 的 progress = 模型对 "no_progress" 的主观概率 + 两个本地 pre-signal。**它不比较 State(t-1) vs State(t)。**

### 4.3 与你的 `trackConvergence` 对比（重要）

dual-gate 已有：`gapCount` 比较（`improving/stalled/worsening`）、`sameJudgeGaps`（规范化后完全相同的 gap 集）、`sameGapStreak ≥2 → executorStuck`。

**Bicameral 在单会话内部检测"重复错误/振荡"，dual-gate 在迭代之间检测"gap 不缩、gap 相同"。两者检测的粒度不同、互补：**
- Bicameral 的粒度：**同一个 prompt 内**的 tool 级重复（秒级）。
- dual-gate 的粒度：**整个 iteration** 的 gap 级停滞（分钟级）。
- **融合后**：Executor pane 内部跑 Bicameral 式 stuck 检测（同 pane 内 early-steer），iteration 之间跑 dual-gate 现有 `trackConvergence`（同 pane 持续迭代、超过阈值才升级）。详见 §5/§7。

---

## 5. Policy / Deterministic Policy 深入分析

`policy.ts`：`DEFAULT_POLICY`（纯数字阈值）+ `bicameral.yaml` overlay（`mergePolicy` 深合并，zod 校验，无效 YAML 保留旧 policy）。

```yaml
reflexes:
  gate:     { enabled: true, deadline_ms: 900, exfiltration:{block:0.6,confirm:0.25}, injected_intent:{block:0.8,confirm:0.4}, secret_access:{confirm:0.5}, scope_escape:{confirm:0.5}, reversibility:{confirm_at_level:2,min_confidence:0.5}, headless_confirm_as: block }
  honest_finish: { enabled: true, deadline_ms: 900, test_weakened:{warn:0.5,followup:0.75}, stub_introduced:{warn:0.6}, unverified_claim:{followup:0.7}, max_followups_per_prompt: 2 }
  stuck:    { enabled: true, deadline_ms: 900, window_turns: 6, repeat_failure:{steer:0.7}, no_progress:{steer:0.7,raise_thinking:0.85,ask_user_after:3} }
mode: enforce | observe        # observe = 记录但不干预（灰度）
```

- `mode: observe` 是**灰度开关**：先看 reflex 会做什么，不实际干预。这是"easy to disable / safe rollout"的关键。
- `deadline_ms: 900` = 每次 System-1 判断的预算，超时走降级路径。
- `budget.s1_daily_usd: 5` = 每日 S1 花费上限，超了自动降级（`degraded`）。

**对你最重要的两个政策思想：**
1. **阈值可调、单一来源**（YAML），所有 reflex 共用。
2. **observe/enforce 双模式**：先观察再强制，零风险上线。

---

## 6. What is Reusable / What should be Rewritten

### A. 直接复用（borrow code）

| 项 | 来源文件 | 理由 |
|---|---|---|
| `isHighRiskByPattern` + `isOutsideCwd` | `s1-runtime/src/high-risk.ts` | 纯本地正则+路径检查，无依赖，直接可拷。**这正是你要的"HIGH/CRITICAL 风险分级的确定性底座"。** |
| `redactSecrets` | `s1-runtime/src/redaction.ts` | 纯函数，脱敏后任何"外部判断"才安全。 |
| `truncateState` / `truncateUtf8` | `s1-runtime/src/truncation.ts` | 预算化状态截断，priority 排序。 |
| `StuckTracker`（含 preSignals） | `s1-runtime/src/decisions/stuck.ts` | **纯本地、无模型依赖**，ring buffer + 重复错误/振荡检测。 |
| `Decide*` 纯函数模式 | `decisions/gate.ts`, `decisions/honest-finish.ts`, `decisions/stuck.ts` | `(answers, policy, preSignals) → action` 的可测试纯函数模式。 |
| `PolicyStore`/`mergePolicy`/`DEFAULT_POLICY` 模式 | `policy.ts` | YAML overlay + 深合并 + zod 校验。 |
| `DecisionCache`（内容寻址） | `cache.ts` | hash(packHash, state) → 10min TTL，重试免费。 |
| `formatHud`/`formatWhy` | `format/*.ts` | 观察性 UI。 |

### B. 借鉴实现后自己写（rewrite the pattern）

| 项 | 为什么重写 |
|---|---|
| **System-1 后端** | Bicameral 默认 `TypeSafeBackend`（Jev）。**你的环境没有 TypeSafe key**，但有现成的多模型注册表（`ctx.modelRegistry`）和 DeepSeek/GPT 可用。**借鉴 `LlmBackend` 的 SPEC 设计（用 `ctx.modelRegistry.complete` 问一个便宜模型输出严格 JSON 概率）自己实现。** 或者更简单：**v0.1 先用确定性信号 + 阈值，不接任何模型**（见 §7 设计——你的"判断"大部分可以用本地信号完成，模型只在低置信时升级）。 |
| **Hooks 接线** | Bicameral 全部 hook 在**主 Pi 会话**。你的 Executor 在 **Herdr pane**，hook 根本不会在主 Pi 触发。**必须在 dual-gate 自己的 orchestration 里显式调用**（在 `waitForExecutorCompletion` 后、`runDeterministicGate` 前，以及 gate 结果出来后）。这是"不能照搬"的核心。 |
| `pi.sendMessage(steer/followUp)` | 你的"steer/followUp"必须变成 `herdr agent prompt`（`herdrAgentPrompt`）。**模板 hint 内容可借用，投递机制重写。** |
| `finish_check` 未接线的 agent_end | 你不需要它——你有自己的 `normalizeReport` + gate + Judge。**把你的 `ExecutorReport` 当 `finish_check` 的 state，重写完成判断。** |

### C. 不适合你的架构（don't copy）

| 项 | 原因 |
|---|---|
| `Speculator` 的 `message_update` prefetch | 那是主会话内流式优化。你的 executor 在 pane 里，你拿不到它的 `message_update`（除非走 `herdr agent read` 轮询，成本不值）。**你只需要同步判断，不需要 prefetch。** |
| `ui.setWidget` HUD / `/why` / `/s1` | dual-gate 已有自己的 widget/status 体系（`updateWidget`/`setStatus`）。**把 reflex 决策并入现有 widget，不另开一套。** |
| TypeSafe SDK 依赖 | 你的运行时不需要额外 SDK 依赖；自己定义 `noul/score` 数据结构即可（3 个类型，`types.ts`）。 |
| `pi.setThinkingLevel("high")` 自动提档 | 对 Herdr pane 的 executor 不适用（不同会话）。**升级路径是你已有的 `/dual executor <stronger-model>` + ESCALATE。** |

---

## 7. Herdr Reflex v0.1 设计（最小可落地）

### 7.1 设计原则

```
small · observable · deterministic · easy to disable · easy to debug · low token
```

**核心决策：v0.1 不接任何 System-1 模型。** 全部用本地确定性信号 + 阈值。理由：
1. 你的"判断"大多数有客观信号（gate 步骤、report 字段、diff 统计），不需要概率模型。
2. 不接模型 = 零 token、零延迟、完全可预测、完全可测（纯函数）。
3. 模型只在**低置信/冲突信号**时升级——但升级对象是**已有的 GPT-5.6 Judge**，不是新模型。**这保持了"GPT-5.6 不消失"的约束。**

### 7.2 四个能力（按你的倾向，经源码分析确认）

| # | 能力 | 输入信号（全本地） | 输出 |
|---|---|---|---|
| 1 | **Honest Finish**（研发完成判断） | ExecutorReport + gate 结果 + diff 统计 | `completed` / `needs_fix` / `unverified` |
| 2 | **Progress / Stuck** | `IterationState(t)` vs `IterationState(t-1)` + turn 级重复信号 | `PROGRESS` / `NO_PROGRESS` / `REGRESSION` / `STUCK` |
| 3 | **Tool Risk Gate** | tool name + args + cwd（`isHighRiskByPattern` 扩展） | risk tier → auto / warn / block |
| 4 | **Escalation Policy** | 以上三者的汇总 + 计数 | `CONTINUE` / `RETRY` / `ESCALATE` |

### 7.3 能力 1：Honest Finish（研发完成判断）— 你最关心的部分

**设计原则：不信任 Executor 的 "Task completed successfully" 文本，只信任可验证的 evidence。** 在 `waitForExecutorCompletion` 返回后、`runDeterministicGate` 前后各跑一次：

```ts
interface FinishEvidence {
  // 客观事实（来自 gate + report + git）
  gate: { ran: boolean; passed: boolean; steps: GateStep[] };
  report: { status: string; has_summary: boolean; files_changed: number };
  validation: { lint: "pass"|"fail"|"not_run"; typecheck: "pass"|"fail"|"not_run"; build: "pass"|"fail"|"not_run" };
  tests: { ran: boolean; passed: number; failed: number };
  diff: { files_changed: number; insertions: number; deletions: number };
  acceptance_check: { ran: boolean; all_pass: boolean };
  // 红旗（与 Bicameral edit_review 同思路，但用本地信号）
  flags: {
    stub_heuristic: boolean;       // report 里 TODO/FIXME/placeholder/hardcoded return 关键词
    test_weakened: boolean;        // diff 中 test 文件删断言/改期望值（isTestPath + diff 模式）
    test_removed: boolean;         // test 文件删除
    unverified_claim: boolean;     // status=completed 但 gate 未跑 或 无 test 命令
    silent_failure: boolean;       // report 空 / 解析失败
    scope_escape: boolean;         // files_changed 含项目外路径
  };
}
```

**决定（确定性策略）：**

```ts
function decideFinish(ev: FinishEvidence, policy: FinishPolicy): FinishDecision {
  // 硬性失败（无争议）
  if (ev.flags.silent_failure) return { verdict: "needs_fix", reason: "no_report", ... };
  if (ev.report.status === "failed") return { verdict: "needs_fix", reason: "executor_failed" };
  if (ev.gate.ran && !ev.gate.passed) return { verdict: "needs_fix", reason: "gate_failed" };
  if (ev.flags.scope_escape) return { verdict: "escalate", reason: "scope_escape" };

  // 完成度评分（替代"完成"声明）
  const checks = [
    ev.gate.passed,                                  // build/lint/test 客观通过
    ev.validation.build !== "not_run" || !ev.gate.ran, // build 有证据
    ev.tests.ran && ev.tests.failed === 0,
    ev.report.files_changed > 0,                     // expected files changed
    ev.acceptance_check.ran && ev.acceptance_check.all_pass,
  ];
  const score = checks.filter(Boolean).length / checks.length;

  if (score >= policy.complete_threshold) return { verdict: "completed", score, reason: "evidence_satisfied" };
  if (ev.flags.unverified_claim) return { verdict: "needs_fix", reason: "unverified_claim", hint: "run gate: <commands>" };
  return { verdict: "needs_fix", reason: "insufficient_evidence", score, hint: listMissing(checks) };
}
```

**与现有流程的关系：** 这个 `decideFinish` 放在 `runDeterministicGate` **之前**（提前拦截"自称完成但根本没跑 gate"），以及 gate 结果出来后（把 gate 客观结果并入完成度）。它**不替代** Judge——它只决定"要不要把 iteration 交到 GPT-5.6 Judge 手里"。**低置信才升级 Judge** 正好符合你的约束。

> **这是对 Bicameral 的最大改进点**：Bicameral 的 `finish_check` 是"模型判断 unverified_claim"；你的版本是"evidence checklist + 确定性评分"，更符合你"不依赖 DeepSeek 说 DONE"的目标。

### 7.4 能力 2：Progress / Stuck

**用你想要的 `IterationState` 序列，纯本地：**

```ts
interface IterationState {
  iteration: number;
  files_changed: string[];          // git diff --name-only
  tests_passed: number;             // 从 gate/test 输出解析（尽力而为）
  tests_failed: number;
  build_status: "pass"|"fail"|"not_run";
  error_signature: string;          // 首个失败 gate step 的归一化错误头（如 "Error: ENOENT"）
  diff_size: number;                // 插入+删除行数
  requirements_completed: number;   // report.acceptance_check 中 pass 数
}

function compareState(prev: IterationState, curr: IterationState): Trend {
  const progressSignals = [
    curr.tests_failed < prev.tests_failed,                    // 8→5→2 = PROGRESS
    curr.error_signature !== prev.error_signature,            // 错误变了 = 在前进
    curr.requirements_completed > prev.requirements_completed,
    curr.diff_size > prev.diff_size && curr.build_status !== "fail",
  ];
  const regressionSignals = [
    curr.tests_failed > prev.tests_failed,
    curr.build_status === "fail" && prev.build_status === "pass",
  ];
  if (regressionSignals.some(Boolean)) return "REGRESSION";
  if (progressSignals.some(Boolean)) return "PROGRESS";
  return "NO_PROGRESS";
}
```

**Stuck 判定（不是 retry_count >= 3）：**

```ts
function decideStuck(states: IterationState[], turnSignals: TurnSignal[]): StuckDecision {
  const last = states[states.length - 1];
  // 组合信号
  const noProgressStreak = 连续 NO_PROGRESS 的轮数;
  const sameErrorStreak = 连续相同 error_signature 的轮数;
  const oscillation = turnSignals 中同一文件在两个 hunk 间往返 ≥3;   // borrow StuckTracker.preSignals
  const identicalCmdError = turnSignals 中同一命令同一错误重复;        // borrow

  if (oscillation || identicalCmdError || (sameErrorStreak >= 2 && noProgressStreak >= 1)) {
    return { verdict: "STUCK", reason: "repeated_failure_or_oscillation", hint: 模板 };
  }
  if (noProgressStreak >= 3 && last.build_status === "not_run") return { verdict: "STUCK", reason: "no_progress" };
  if (noProgressStreak >= 2) return { verdict: "WATCH", reason: "no_progress_2" };  // 观察，不打断
  return { verdict: "OK", reason: "progress_or_idle" };
}
```

**关键点（对应你的问题）：**
- **历史状态**：只保留最近 N=3~4 个 IterationState + 每轮 turn 信号 ring buffer（borrow `StuckTracker`，window=6）。**不是整个会话。**
- **Progress 定义**：`tests_failed` 下降 / `error_signature` 变化 / `requirements_completed` 上升 / 有效 diff 增长。**"8→5→2 连续失败也是 PROGRESS"由第一条保证。**
- **避免误判**：连续相同 error_signature 才累计；正常 debug（错误在变）算 progress；oscillation 要求同一文件两 hunk 往返 ≥3 次。
- **不打断正常开发**：`WATCH` 只记录不干预；`STUCK` 才生成 hint。

### 7.5 能力 3：Tool Risk Gate

**直接 borrow `isHighRiskByPattern`，扩展出 risk tier（满足你的 §6 要求）：**

```ts
type RiskTier = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

function tierOf(toolName: string, input: unknown, cwd: string): { tier: RiskTier; reason: string } {
  // 工具名分类
  if (["read","grep","rg","ls","find","cat"].includes(toolName)) return LOW;      // 只读 → 自动
  if (["edit","write"].includes(toolName)) return LOW;                            // 普通文件修改 → 自动（有版本控制）
  if (["bash","powershell"].includes(toolName)) {
    const cmd = String(input?.command ?? "");
    if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/.test(cmd) || /git\s+reset\s+--hard|git\s+clean|git\s+push\s+-f|git\s+push\s+--force/.test(cmd))
      return { tier: "CRITICAL", reason: "destructive_git_or_recursive_rm" };
    if (/git\s+push\b/.test(cmd)) return { tier: "HIGH", reason: "git_push" };
    if (/\b(curl|wget|ssh|scp|sftp|nc|ncat)\b/.test(cmd)) return { tier: "HIGH", reason: "network_egress" };
    if (/npm\s+(i|install|add)|pip3?\s+install|apt(-get)?\s+install|brew\s+install|cargo\s+install/.test(cmd)) return { tier: "MEDIUM", reason: "package_install" };
    if (/sudo\b/.test(cmd)) return { tier: "HIGH", reason: "sudo" };
    if (/\.env|credential|secret|token|api[_-]?key/i.test(cmd)) return { tier: "HIGH", reason: "credential_touch" };
    if (/rm\b/.test(cmd)) return { tier: "MEDIUM", reason: "rm_non_recursive" };
    if (/mkdir|touch|cp|mv|sed|awk|grep|rg|cat|ls|find|echo|export|cd\b/.test(cmd)) return { tier: "LOW", reason: "common_dev" };
  }
  if (isOutsideCwd(input?.path, cwd)) return { tier: "HIGH", reason: "path_outside_cwd" };
  return { tier: "LOW", reason: "default" };
}
```

**映射（你要求的 risk tiers → 动作）：**

| Tier | 动作 |
|---|---|
| LOW | **自动执行**（零判断，不进任何模型） |
| MEDIUM | 记录 + 计数；**不打断**（默认 allow，仅 HUD 显示） |
| HIGH | 记录 + **WARN**（若可以，把警告附到结果/或进 HUD）；策略可配置为 confirm |
| CRITICAL | **BLOCK** 或弹 `ctx.ui.confirm`（有 UI）；headless 默认 block |

> 为什么对 dual-gate 尤其重要：**Executor 是独立 pane 的 DeepSeek，主 Pi 的 `tool_call` hook 拦截不到它**。所以 Risk Gate 必须挂在 **dual-gate orchestration** 里（在把任务/增量交给 executor **之前**，静态检查任务描述里的高风险意图；以及在 gate 结果和 report 里检测 scope_escape）。同时，如果你想要"执行中实时拦截"，需要 Herdr pane 里的 Pi 也装 reflex——那是 v0.2 的事（见 §9）。

### 7.6 能力 4：Escalation Policy（CONTINUE / RETRY / ESCALATE）

```ts
interface ReflexResult {
  finish?: FinishDecision;      // completed | needs_fix | escalate
  trend?: Trend;                // PROGRESS | NO_PROGRESS | REGRESSION
  stuck?: StuckDecision;        // OK | WATCH | STUCK
  risk?: RiskTier;              // 任务级
}

function decideLoop(result: ReflexResult, ctx: { retryCount: number; maxRetries: number; sameErrorStreak: number; totalIterations: number }): "CONTINUE" | "RETRY" | "ESCALATE" {
  // 硬升级：只有这些才劳驾 GPT-5.6 / 用户
  if (result.finish?.verdict === "escalate") return "ESCALATE";        // scope_escape 等
  if (result.stuck?.verdict === "STUCK" && ctx.sameErrorStreak >= 3) return "ESCALATE"; // 多轮无法解决
  if (result.trend === "REGRESSION" && ctx.retryCount >= ctx.maxRetries) return "ESCALATE";
  if (result.risk === "CRITICAL") return "ESCALATE";                   // 用户确认

  // 普通判断：Reflex 自己消化
  if (result.finish?.verdict === "needs_fix") return "RETRY";          // 生成 feedback → 同一 pane
  if (result.stuck?.verdict === "STUCK") return "RETRY_WITH_HINT";     // 模板 hint → 同一 pane
  if (result.trend === "PROGRESS" || result.trend === undefined) return "CONTINUE";

  // 阈值内重试，不升级
  if (ctx.retryCount < ctx.maxRetries) return "RETRY";
  return "ESCALATE";
}
```

**升级到 GPT-5.6 的路径（明确列出）：** `ESCALATE` 分支 → 走 dual-gate **已有的** `judge()` / `convergenceDiagnosis()` / `presentEscalation()`，或 `/dual executor <stronger-model>`。**GPT-5.6 没有从流程消失，只是不再被"普通判断"调用。**

---

## 8. 融合后的完整循环（System-2 + Fast Exec + System-1 Reflex + Deterministic Control）

```
USER
 │
 ▼
GPT-5.6 Sol  (Controller/Judge)          ◄── System-2（保留，只处理升级）
 │  Expected Outcome v1
 ▼
DeepSeek Executor（Herdr pane，同一 pane 持续迭代）
 │  执行 → 报告
 ▼
┌─────────────── Reflex Layer (v0.1, 零 token) ───────────────┐
│ ① Honest Finish    finish = decideFinish(report, gate, diff) │
│ ② Progress/Stuck   trend = compareState(S(t-1), S(t))       │
│                    stuck  = decideStuck(states, turnSignals) │
│ ③ Tool Risk Gate   tier  = tierOf(task/action, cwd)         │
│ ④ Escalation Policy → CONTINUE | RETRY | ESCALATE            │
└──────────────────────────┬───────────────────────────────────┘
                           │
        ┌──────────────────┼───────────────────┐
        ▼                  ▼                   ▼
   CONTINUE            RETRY               ESCALATE
   （gate 客观通过 →    （生成 feedback →     （→ GPT-5.6 Judge /
    进 Judge 或 DONE）   同一 DeepSeek pane）    convergenceDiagnosis /
                                                用户确认 / 换模型）
```

**关键：这个 Reflex Layer 不是新 Agent，不产生任何 LLM 对话，只产生 `{verdict, reason, hint, evidence}` 结构。** 它全部由你已有的数据驱动：`ExecutorReport`（已有）、`GateResult`（已有）、`git diff`（已有）、iteration 计数（已有）。

---

## 9. Integration Points（以实际源码为准）

> 以下 hook/函数名**全部来自你已安装的 Pi 0.85.1 `types.d.ts` 和 dual-gate 源码**，没有虚构。

### 9.1 在 dual-gate 内（`extension/dual-gate.ts`）插入点

| 插入点（实际代码位置） | 插入什么 | 说明 |
|---|---|---|
| `orchestrate()` 循环顶部，`iteration += 1` 之后 | **IterationState 记录**（Progress Recorder 起点） | 已有 `rt.manager.patch(task.taskId, {iteration,...})`；在此收集 diff 统计 |
| `waitForExecutorCompletion` 返回后、`runDeterministicGate` 前 | **Honest Finish ①（预检查）** | `decideFinish(report, 无gate结果, diff)`：拦截"自称完成但没跑验证"；`unverified_claim → RETRY`（省掉一次昂贵的 Judge 调用） |
| `runDeterministicGate` 结果出来后、`judge()` 前 | **Honest Finish ②（合并 gate 证据）** | `decideFinish(report, gateResult, diff)`；`completed` 且 gate pass → 继续走 Judge（或按策略直接 DONE）；`needs_fix → RETRY`（生成 feedback 到同一 pane，**不调用 GPT-5.6**） |
| Gate 失败循环（`FIXING_GATE` while 循环）内、每次 gate 重试前 | **Progress/Stuck ②** | `compareState` + `decideStuck`；检测"gate 修复无进展"→ 提前提示换策略，而不是傻等 `config.gate.max_retries` |
| `trackConvergence` 之后、verdict switch 之前 | **Progress/Stuck 汇总 + Escalation Policy ④** | 把 `conv.progress`（已有）+ Reflex 信号合并；`ESCALATE` 走已有 `presentEscalation` / `convergenceDiagnosis` |
| `orchestrate()` 循环 `while (iteration < maxIterations)` 出口 | **Stuck 判定（iteration 级）** | 现有 `convergenceDiagnosis` 已处理"循环耗尽"；reflex 只在"同一 error_signature ≥3"时**提前**触发，省得白跑 5 轮 |
| `plan()` 产出的 contract 后、`spawnExecutor` 前 | **Tool Risk Gate ③（任务级）** | `tierOf` 扫描 `contract.risk` + `originalRequest` 里的危险意图；CRITICAL → 已有 `WAITING_PERMISSION`/`ctx.ui.confirm`（已有 high-risk confirm 逻辑，可复用）；把 tier 写入 `TaskRecord` |

### 9.2 在 Pi 扩展层面（可选，v0.2）

| Pi hook（真实存在） | 用途 | 备注 |
|---|---|---|
| `pi.on("tool_call", ...)` 返回 `{ block, reason }` | 主会话内 Tool Risk Gate | **只保护主 Pi，不保护 Herdr pane 里的 executor**（不同进程）。v0.1 不做。 |
| `pi.on("tool_result", ...)` 返回 `{ content }` | 主会话内 Honest Finish patch | 同上，v0.2 若把 executor 也跑成 Pi 会话才有意义。 |
| `pi.on("turn_end", ...)` | 主会话内 Stuck | 同上。 |
| `pi.on("agent_end", ...)` | 主会话完成判断 | 同上。 |
| `pi.on("input", ...)` 返回 `{ action: "handled" }` | dual-gate 已用 | 用于拦截用户输入开始任务。 |

**结论：v0.1 的 Reflex 是 dual-gate orchestration 内部的纯函数层（不是 Pi 扩展 hook 层），因为 executor 不在主会话。** 这是与 Bicameral 最本质的架构差异，也是必须"提取模式而非照搬"的根本原因。

---

## 10. State Model（v0.1）

```ts
// 持久化在 TaskRecord（已有）+ 新增 reflex 字段
interface TaskRecord { /* 已有字段 */ 
  // ---- 新增（v0.1）----
  reflex?: {
    trendHistory: Trend[];                 // 最近 N=4 轮 ["PROGRESS","NO_PROGRESS",...]
    errorSignatures: string[];             // 每轮首个失败 gate step 的 error signature
    sameErrorStreak: number;
    noProgressStreak: number;
    lastFinish?: { verdict: string; reason: string; score?: number };
    lastStuck?: { verdict: "OK"|"WATCH"|"STUCK"; reason?: string };
    riskTier: RiskTier;
    riskReasons: string[];
  };
}

// 每轮（内存中，不持久化大对象）
interface IterationState {
  iteration: number;
  filesChanged: string[];                  // git diff --name-only HEAD
  testsPassed: number; testsFailed: number;
  buildStatus: "pass"|"fail"|"not_run";
  errorSignature: string;
  diffSize: number;
  requirementsCompleted: number;
}
```

**Budget/上下文影响**：Reflex 全本地，**0 token、0 LLM 调用、<1ms/轮**。唯一成本是 `git diff`（已有）和 gate 输出解析（gate 已在跑）。对比：现在每轮最贵的是 GPT-5.6 Judge（完整 contract + report + 30KB diff + gate summary）。**Reflex 能把"明显没完成/明显卡住"的轮次直接 RETRY，省下这些 Judge 调用。**

---

## 11. Event Flow（v0.1 时序）

```
iteration N 开始
  │
  ├─ [Reflex:RiskGate] tierOf(任务, cwd) → HIGH/CRITICAL? → WARN/确认（CRITICAL 才打断）
  │
  ├─ spawnExecutor / resume same pane（已有）
  ├─ waitForExecutorCompletion（已有）
  │
  ├─ [Reflex:HonestFinish-预] decideFinish(report, ∅gate, diff)
  │     ├─ silent_failure / status=failed / unverified_claim → RETRY（feedback → same pane）
  │     └─ 通过 → 继续
  │
  ├─ runDeterministicGate（已有）
  │     └─ fail → [Reflex:Stuck] compareState + decideStuck
  │            ├─ STUCK(sameError≥2) → 模板 hint → same pane（替代盲目重试）
  │            └─ 否则 → gate-fix loop（已有）
  │
  ├─ [Reflex:HonestFinish-合] decideFinish(report, gateResult, diff)
  │     ├─ completed → 记录 evidence → 进 Judge
  │     ├─ needs_fix → RETRY（feedback → same pane，不调用 GPT-5.6）
  │     └─ escalate → ESCALATE
  │
  ├─ trackConvergence（已有）→ [Reflex:EscalationPolicy]
  │     ├─ CONTINUE → Judge（GPT-5.6）或 DONE
  │     ├─ RETRY → same pane
  │     └─ ESCALATE → presentEscalation / convergenceDiagnosis（GPT-5.6）
  │
  └─ 持久化 reflex 字段到 TaskRecord
```

---

## 12. Failure Modes（Reflex 自身的风险）

| 模式 | 症状 | 缓解 |
|---|---|---|
| **误报 STUCK**（正常 debug 被判卡） | 同一错误连续 2 次其实是"错误信息重复但排查方向在变" | STUCK 需要 `sameErrorStreak≥2 && noProgressStreak≥1` **或** oscillation 证据；hint 是建议不是命令 |
| **漏报 fake success**（Executor 报完成但 gate 没跑） | `status: completed` + gate 从未执行 | `unverified_claim` 硬性检查：completed 但 `gate.ran=false` → needs_fix |
| **test 弱化漏检**（diff 改了断言） | Judge 未必逐行看 test 文件 | `test_weakened` 本地启发式（test 文件 diff 含 `assert` 增删/期望值变化）→ 标记并在给 Judge 的输入里**附加"test diff 已标记"**，让 Judge 复核；不做自动 block |
| **Risk Gate 误伤正常开发** | `curl` 用于本地 API 测试被 HIGH | HIGH 默认只 WARN 不打断；CRITICAL 才打断；阈值可配 |
| **Reflex 自身 bug** | 影响主流程 | 纯函数 + 单测（§14）；`mode: observe` 灰度（只记录不干预） |
| **gate 输出解析失败**（tests_passed 拿不到） | Progress 信号缺失 | `tests_passed/failed` 解析失败时置 `undefined`，进度信号回退到 `error_signature`/`requirements_completed`/diff |
| **Herdr pane 里 executor 行为不在主会话** | 无法实时拦截 | v0.1 接受"轮次间判断"；v0.2 可让 executor pane 也加载 reflex 扩展（同款包） |

---

## 13. Performance / Token Implications

| 项 | 现状（每轮） | 加 Reflex 后（每轮） |
|---|---|---|
| GPT-5.6 Judge 调用 | 每轮 1 次（除非 gate fail） | **减少**：needs_fix/unverified 轮直接 RETRY，不进 Judge |
| Convergence Diagnosis | 仅循环耗尽时 | 不变（ESCALATE 才走） |
| Reflex 计算 | — | **0 token、0 LLM、<1ms**（纯函数 + 已有数据） |
| git diff | 已有（Judge 输入） | 复用，不新增 |
| 新增依赖 | — | **无**（不装 Bicameral 包、不装 TypeSafe SDK） |
| 每轮延迟 | Judge 为主 | Reflex 侧 +0ms；**可能减少总轮数**（更早 RETRY/ESCALATE） |

**Bicameral 自己的成本结构**（源码 `budget.ts`）：S1 每次决策预估 <$0.0001（输入几千 token × $0.042/M），目标整场会话 <$0.05；延迟 p50 <50ms（预取后）。**我们 v0.1 连这个钱都不用花（无模型）**，只 borrow 它的"budget + degraded"思想用于未来接模型时。

---

## 14. Implementation File Plan

```
extension/
  reflex/
    types.ts          # FinishEvidence, IterationState, Trend, StuckDecision, RiskTier, ReflexResult, ReflexPolicy
    risk-tier.ts      # tierOf() + isOutsideCwd + 危险命令表   ← borrow high-risk.ts
    finish.ts         # decideFinish() + 本地启发式（stub/test_weakened/unverified/scope_escape）
    progress.ts       # compareState() + decideStuck() + TurnSignal ring buffer   ← borrow StuckTracker 思路
    policy.ts         # DEFAULT_REFLEX_POLICY + loadReflexPolicy(json) + observe/enforce
    index.ts          # collectIterationState(), runReflexLayer() 编排
  dual-gate.ts        # MODIFY：在 §9.1 的 6 个插入点调用 reflex
  core.ts             # MODIFY：TaskRecord.reflex 字段序列化 + report 解析复用
  types.ts            # MODIFY：TaskRecord + reflex 字段
  gate.ts             # MODIFY（可选）：输出 tests_passed/failed 结构化解析
tests/
  reflex.test.ts      # 纯函数单测（见 §15）
```

**新增文件 ~6 个，总计估 ~500-700 行。** 全部纯函数，不碰 Herdr CLI 逻辑、不碰 Judge/Controller prompt（除了可选地在 Judge 输入里附加 "test diff flagged" 标记）。

---

## 15. Test Plan

```
tests/reflex.test.ts
  decideFinish:
    - status=completed + gate.ran=false → needs_fix/unverified_claim
    - status=completed + gate pass + tests 0 failed + acceptance all pass → completed (score=1)
    - status=completed + gate fail → needs_fix/gate_failed
    - report 空/解析失败 → needs_fix/silent_failure
    - files_changed 含项目外路径 → escalate/scope_escape
    - stub_heuristic: report.implementation 含 "TODO"/"placeholder" → flag 置位
    - test_weakened: diff 中 test 文件删除 assert / 改期望值 → flag 置位
  compareState:
    - tests_failed 8→5→2 → PROGRESS（连续失败但收敛）
    - tests_failed 5→5→5 + same error_signature → NO_PROGRESS → STUCK
    - build pass→fail → REGRESSION
    - error_signature 变化但 failed 持平 → PROGRESS
  decideStuck:
    - oscillation: 同文件两 hunk ≥3 往返 → STUCK
    - identical_command_error: 同命令同错误 2 次 → STUCK 信号
    - noProgressStreak=2 → WATCH（不打断）
    - noProgressStreak=3 + build not_run → STUCK
  tierOf:
    - read/grep/ls → LOW；edit/write → LOW
    - rm -rf / git reset --hard / git clean → CRITICAL
    - git push → HIGH；curl/wget/ssh → HIGH；sudo → HIGH
    - npm install → MEDIUM；rm 非递归 → MEDIUM
    - path outside cwd → HIGH
  decideLoop（Escalation Policy）:
    - finish=needs_fix → RETRY（不升级）
    - stuck=STUCK && sameErrorStreak<3 → RETRY_WITH_HINT
    - stuck=STUCK && sameErrorStreak≥3 → ESCALATE
    - trend=REGRESSION && retry≥max → ESCALATE
    - risk=CRITICAL → ESCALATE
    - trend=PROGRESS → CONTINUE
  policy: observe 模式下所有 decide* 仍运行但不产生 action；enforce 下正常
```

**兼容性保证：** 所有 reflex 函数纯函数、不读环境、不碰 Herdr；`mode: observe` 默认开启，先看日志再 enforce。

---

## Recommended Implementation

### CREATE
- `extension/reflex/types.ts` — Reflex 类型与 `ReflexPolicy`（含 observe/enforce）
- `extension/reflex/risk-tier.ts` — `tierOf()` + 危险命令表（borrow Bicameral `high-risk.ts` 的 `isHighRiskByPattern`/`isOutsideCwd`）
- `extension/reflex/finish.ts` — `decideFinish()` + evidence checklist + 本地启发式
- `extension/reflex/progress.ts` — `compareState()` + `decideStuck()` + turn-signal ring buffer
- `extension/reflex/policy.ts` — `DEFAULT_REFLEX_POLICY` + JSON overlay + `mode`
- `extension/reflex/index.ts` — `collectIterationState()` + `runReflexLayer()` 编排 + 审计日志（写 artifact）
- `tests/reflex.test.ts` — §15 全量纯函数单测

### MODIFY
- `extension/types.ts` — `TaskRecord` 增加 `reflex?` 字段（trendHistory/errorSignatures/sameErrorStreak/noProgressStreak/lastFinish/lastStuck/riskTier）
- `extension/core.ts` — `normalizeReport` 已具备字段；增加 `parseGateSteps`（若需结构化 tests_passed/failed）；`buildJudgePrompt` 可选附加 `## REFLEX FLAGS (test diff flagged, scope_escape, …)` 让 Judge 复核
- `extension/dual-gate.ts` — 在 §9.1 的 6 个插入点接入 reflex：
  1. loop 顶部 → `collectIterationState` + `RiskGate`（任务级）
  2. `waitForExecutorCompletion` 后 → HonestFinish-预
  3. `runDeterministicGate` 后 → HonestFinish-合 + Progress/Stuck
  4. gate-fix while 循环内 → `decideStuck` 提前干预
  5. `trackConvergence` 后 → `decideLoop`（Escalation Policy）
  6. 持久化 `task.reflex`
- `extension/gate.ts`（可选）— `GateResult` 增加 `testsSummary?: { passed: number; failed: number }` 尽力解析
- `~/.pi/agent/dual-gate.json` — 新增 `"reflex": { "mode": "observe", "complete_threshold": 0.8, "stuck": { ... }, "risk": { "critical_confirm": true } }`

### BORROW FROM BICAMERAL（明确到文件）
- `packages/s1-runtime/src/high-risk.ts` → `isHighRiskByPattern` / `isOutsideCwd` → 直接移植进 `reflex/risk-tier.ts`
- `packages/s1-runtime/src/decisions/stuck.ts` → `StuckTracker.preSignals()`（identical_command_error / oscillation 检测逻辑）→ 重写成 `reflex/progress.ts` 的本地信号
- `packages/s1-runtime/src/truncation.ts` → `truncateState` / `truncateUtf8` → 若未来接模型时复用
- `packages/s1-runtime/src/redaction.ts` → `redactSecrets` → 若未来接模型时复用
- `packages/s1-runtime/src/policy.ts` → `mergePolicy`/`DEFAULT_POLICY` 的 YAML-overlay 模式 → 简化成 JSON overlay 版 `reflex/policy.ts`
- `packages/s1-runtime/src/cache.ts` → `DecisionCache` 思路 → v0.2 接模型时实现
- `packages/s1-runtime/src/format/hud.ts` / `why.ts` → 决策审计展示思路 → v0.1 用 artifact 文件 + 现有 `updateWidget` 即可

### DO NOT COPY
- `packages/pi-bicameral/src/index.ts` 的 **hook 接线**（`message_update`/`tool_call`/`tool_result`/`turn_end`）— 你的 executor 在 Herdr pane，hook 触发不到；改用 orchestration 内显式调用
- `Speculator`（`message_update` prefetch）— 无主会话流式场景
- `TypeSafeBackend` / `@typesafe-ai/sdk` — 你无 TypeSafe key，且 v0.1 不需要模型后端
- `pi.sendMessage(deliverAs:"steer"/"followUp")` / `setThinkingLevel` — 跨 pane 无效；改为 `herdrAgentPrompt` 模板 hint + 你的 `/dual executor` 升级路径
- `ui.setWidget` HUD / `/why` / `/s1` — 并入 dual-gate 现有 widget/status
- `finish_check.yaml` 原样（模型判断 unverified_claim）— 重写为 evidence checklist 确定性评分（§7.3）
