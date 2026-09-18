# 研发日志（Dual-Gate Orchestrator）

> 记录功能演进、决策与待办。按日期倒序。

---

## 2026-09-19

### Reflex Layer v0.2c：真实环境端到端验证 + 安装同步 + 语义修正

**同步**：`install.sh` 修复——原来只复制顶层 `*.ts`，漏了 `reflex/` 子目录；已改为递归复制，并重新执行安装（`~/.pi/agent/extensions/dual-gate/reflex/*.ts` 全部就位，syntax + load 通过）。

**真实环境端到端验证**（用 demo-repo 实际工作树 + 真实 gate + 真实 Jev CLI）：
- 场景 1（健全）：executor 报告 `completed` + 真实 gate PASS（`npm test` 154ms）+ 3 测试全过 → `finish=completed(evidence_satisfied) score=0.80` → `loop=CONTINUE`（进 GPT-5.6 Judge）✅
- 场景 2（unverified）：executor 说 `completed` 但 validation 全 not_run + 无 test 命令 → `needs_fix/unverified_claim` → `RETRY`（同一 pane，**连 Jev 都不花**，硬规则拦截）✅
- 审计产物：`demo-repo/.pi/dual-gate/reflex-e2e/reflex-it1.log` + `reflex-history.json`（真实写入，验证了 orchestrate 的产物路径）

**语义修正（重要 bug）**：`finish.ts` 的 build/tests check 原逻辑在 gate 已通过时把 `build: not_run` 算失败，导致健全案例（gate 通过 + tests 全过）被误判 `needs_fix`（真实 Jev 都拒绝）。修正：**gate 通过 = 权威信号，build/tests 的 not_run 不再扣分（gate 已覆盖项目验证），只有显式 fail 才扣分**。修正后健全案例 score 0.8 → completed，模糊带案例（tests 报告有失败）仍正确落进 Jev 判定区。

**验证脚本**：`scripts/reflex-e2e-real.ts`（真实 Jev，需要 CLI，可选运行）；单测 `tests/reflex.test.ts` 18/18 覆盖同等逻辑（fake Jev）。

**测试**：reflex 18/18，core 68/68，全部安装产物 syntax + load 通过。

---

## 2026-09-19

### Reflex Layer v0.2b：接入 orchestrate()（Jev 分流 GPT-5.6 Judge）

把含 Jev 的 `runReflexLayer` 接入 `orchestrate()` 循环，实现研究文档 §9.1 的插入点。**当前默认 OFF + observe**（`/dual reflex on` 启用，`/dual reflex observe|enforce` 切换模式）。

**接线（4 个真实锚点，均为 dual-gate.ts orchestrate()）**：
1. **report 读取后、deterministic gate 前**：收集 IterationState + Honest Finish 预检——拦截 `unverified_claim`（自称完成但没跑验证）→ 同 pane RETRY，**不花 GPT-5.6**
2. **gate 通过后、Judge 前**：完整 reflex（含 gate 证据 + Jev）→ enforce 模式下 `RETRY`/`RETRY_WITH_HINT` → 同 pane 模板 hint 后 continue（跳过 Judge）；`ESCALATE` → 落入现有 Judge/升级路径；`CONTINUE` → Judge
3. **gate-fix 循环内**：同一步骤重复失败 → steer hint（确定性，不盲目重试）
4. **finally**：清理 reflex status widget

**新增**：`/dual reflex` 子命令（on/off/observe/enforce/status）；`DgConfig.reflex` 配置段（enabled/mode/backend/jev_deadline_ms）；`reflex-history.json` + `reflex-itN.log` 审计产物；helper `collectIterationState`/`loadReflexHistory`/`persistReflexHistory`/`runReflex`/`gitNameOnly`。

**集成实测**（真实 Jev CLI，模拟 orchestrate 数据流）：
- 证据充分（score=0.8）→ `completed` → `CONTINUE`（不调 Jev，直接进 Judge）
- 证据不足（score=0.4，低于 jev_low_band）→ `needs_fix` → `RETRY`（规则直接判，不调 Jev）
- **模糊带（score=0.6）→ Jev `goal_met` 被调用 → `jev_rejected:insufficient_evidence` → `RETRY`（同一 pane，绕过 GPT-5.6 Judge）** ✅ 核心价值

**测试**：`tests/reflex.test.ts` 18/18 绿（+`jev band retry flow`：rule-only / Jev-reject / Jev-confirm 三态）。`tests/core.test.ts` 68/68。`extension/` 三个文件 syntax + load 全部 OK。

---

## 2026-09-19

### Reflex Layer v0.2：接入 Jev System One（Jev 优先，规则兑底）

确认本机 `~/.local/bin/jev` 可用（TypeSafe Jev-1.13，走 OpenRouter Decisions API + `~/.pi/agent/auth.json` openrouter key），实测 **~0.5s / $0.00002 每次**。按用户选择接入：**Jev 优先，规则兑底**，目标是**分流 GPT-5.6 调用次数**（不是降单次思考档——Jev 不能加速 LLM 推理，只能把普通判断前置到 0.5s）。

**关键架构**：`S1Backend` 接口（borrow Bicameral `s1-runtime/src/types.ts`）：
- `JevBackend`（新）— 调本地 `jev` CLI（`--json`），无新增运行时依赖；超时/失败抛错
- `RuleBackend` — 确定性信号作为伪答案
- policy `backend: rule|jev|hybrid`（默认 hybrid = Jev 优先规则兑底，borrow Bicameral degraded fallback）

**接入点（执行结果返回后，进 GPT-5.6 Judge 前）**：
- `finish.ts: decideFinishWithJev` — 模糊带（score 在 jev_low_band=0.6 ~ complete_threshold=0.8，或 evidence-complete-but-flagged）问 Jev `goal_met` noul；Jev 确认 → completed，Jev 拒绝 → needs_fix，超时 → 规则判定
- `progress.ts: decideStuckWithJev` — NO_PROGRESS 处于 watch zone（internal streak >= jev_after=2 且 < no_progress_stuck_after=3）问 Jev `no_progress`；Jev ≥0.7 → STUCK
- `index.ts: runReflexLayer` 改为 async，注入 `JevClient`（`makeJevClient`），输出 `jevConsulted` 审计字段

**真实端到端实测**（非 fake）：
- 证据不足 → `finish=needs_fix(jev_rejected:insufficient_evidence) score=0.60 → loop=RETRY`（省掉一次 GPT-5.6 Judge）✓
- 证据充分 → `finish=completed(evidence_satisfied) score=1.00 → loop=CONTINUE` ✓

**测试**：`tests/reflex.test.ts` 17/17 绿（新增：policy backend 字段、Jev finish 模糊带三种情况、Jev stuck watch-zone）。`tests/core.test.ts` 68/68 仍绿。

**未接线**：orchestrate() 的 6 个插入点仍留待接线（Reflex 层本身已具备 Jev 能力，等接入循环后以 observe 模式灰度）。

---

## 2026-09-19

### Reflex Layer v0.1（纯函数实现，未接线）

对 [AbdelStark/bicameral](https://github.com/AbdelStark/bicameral) 做了源码级分析（`research/bicameral-herdr-integration.md`，725 行），提取 Gate / Honest Finish / Stuck / Policy 模式，按 dual-gate 架构重写为**零 token 确定性 Reflex Layer**。

**关键架构判断**：Bicameral 的 hook（`tool_call`/`tool_result`/`turn_end`）都在主 Pi 会话，而我们的 Executor 跑在独立 Herdr pane，主会话 hook 触发不到 → 不能照搬接线；Reflex 必须是 orchestrate() 循环内的显式调用（纯函数层）。

**新增 `extension/reflex/`（纯函数，无模型调用，无 I/O）**：
- `types.ts` — 共享类型 + `DEFAULT_REFLEX_POLICY` + `mergeReflexPolicy`/`normalizeReflexPolicy`（JSON overlay，`mode: observe|enforce`）
- `risk-tier.ts` — Tool Risk Gate：borrow Bicameral `isHighRiskByPattern`/`isOutsideCwd`，扩展为 LOW/MEDIUM/HIGH/CRITICAL tier（只读→LOW 自动；rm -rf/git reset --hard/force push→CRITICAL；网络/sudo/credential→HIGH；包安装→MEDIUM）
- `finish.ts` — Honest Finish：evidence checklist（gate 实际跑过且通过 / build 非 not_run / tests 0 失败 / files 有变更 / acceptance 全 pass）+ 红旗启发式（stub/test 弱化/scope escape/unverified claim/silent failure）→ 完成度评分 → completed/needs_fix/escalate
- `progress.ts` — Progress/Stuck：`compareState`（tests 8→5→2 = PROGRESS，error signature 变化 = PROGRESS，连续相同 = NO_PROGRESS，build pass→fail = REGRESSION）+ `preSignals`（borrow Bicameral StuckTracker：同命令同错误 / 同文件两 hunk 振荡）
- `policy.ts` — Escalation Policy：CONTINUE / RETRY / RETRY_WITH_HINT / ESCALATE（只有 ESCALATE 才进 GPT-5.6 Judge / 用户）
- `index.ts` — `runReflexLayer()` 编排 + `formatReflexResult` 审计

**测试**：`tests/reflex.test.ts` 14 项全绿（risk tier 分类、test 弱化/stub/scope 检测、完成判断边界、progress 比较、stuck 判定、escalation 映射）。`tests/core.test.ts` 68 项仍全绿。

**未接线**（v0.1 只做纯函数层，符合研究结论）：orchestrate() 的 6 个插入点（loop 顶部收集 IterationState、waitForExecutorCompletion 后 Honest Finish 预检查、gate 结果后合并证据、gate-fix 循环内 stuck 干预、trackConvergence 后 escalation、TaskRecord 持久化 reflex 字段）留待 v0.2 接线。

---

## 2026-09-15

### 实测：跨重启恢复 + Repo Memory（DeepSeek 全家）

**跨重启恢复**：
- `TaskManager.loadFromDisk` + `loadProjectsFromDisk` 从磁盘恢复中断的任务/项目；`session_start` 自动扫描并提示。
- `/dual resume <taskId>` 从持久化 spec 续跑任务；`/dual resume project <id> [repo=<path>]` 重进停滞项目。
- 实测：运行中杀主控 pane → 重启 → resume → 跳过已 CONVERGED 里程碑、自动重建 PM pane、M1/M2 并行续跑 → 全部收敛 → PM+Controller 双验收 ACCEPTED（16 测试全绿）。
- 修复 3 个 bug：CONVERGED 里程碑的历史 unresolved 备注不再阻塞最终复核；final_acceptance 纯 YAML（含 prompt 示例 fenced 尾巴）解析修复；resume 后旧响应文件误读（请求前删除旧 response.yaml）。

**Repo Memory**：
- 每个收敛里程碑把摘要/变更文件/实现要点追加到 `repo-memory.md`，后续里程碑经 Executor prompt 的 `## REPO MEMORY` 段接收。
- 实测 M3 明确参考了 memory 中的跨里程碑上下文（清理无关残留、保持导出面一致）。

### 实测：市场调研先行（Product Manager 联网调研）

给 PM pane 新增只读 `pm_search` 工具（`pm-search.ts`，走 Tavily/Exa，来自 `~/.pi/web-search.json`），规划 prompt 强制「先调研 → 复用/借鉴/自研决策 → 再写 WBS」。

用 DeepSeek 全家实测 markdown 渲染项目：PM 调研到 markdown-it/marked/nano-markdown 三个方案（带下载量/评估），决策 `reuse` 选 markdown-it，里程碑全部围绕「复用」展开；实现用 markdown-it + `enableOnly` 限制规则集，25 测试全绿，6 里程碑收敛，项目 ACCEPTED。

**本次配套修复**：
1. `>`/`|` 折叠块支持 chomping（`>-`/`|-`/`>+`/`|+`）且 `>` 折叠为空格、`|` 保留换行（此前 `summary: >-` 被解析成空对象 → Judge 看到 `[object Object]`）。
2. 里程碑无 id 时用 title 生成 slug id；`depends_on` 用名称引用时按 title slug 归一化解析。
3. PM 退化输出（milestones 为纯字符串列表）时降级为单里程碑（scope=列表项），保留 research 决策。
4. `ProjectPlan.research` 可选字段 + 解析 + 计划展示。
5. Executor 报告读取改为轮询等待实质内容（最长 60s），解决大报告写入慢导致读空。
6. 里程碑收敛以 Judge verdict 为准，Executor 的 unresolved 备注不再独立阻塞（避免误判 FAILED）。

### 实测：并行里程碑端到端（DeepSeek 全家）

用 DeepSeek 同时作主控/Controller/Judge、PM、Executor，对三里程碑项目（M1/M2 无依赖、M3 依赖两者）完成真实并行验证：

```
批准后 M1/M2 同时 RUNNING（各自独立 worktree + Executor pane）
→ M2 先收敛自动 merge 回主 checkout，M1 仍在跑
→ M1 收敛自动 merge（无冲突，git 历史含两条 Merge branch）
→ M3（依赖 M1+M2）串行执行 → 收敛
→ 最终 Gate（15 测试全绿）→ PM 验收 accepted → Controller ratification → ACCEPTED
```

**本次配套增强**：
1. `scheduleMilestoneBatches` 按依赖把里程碑分成可并行批次（纯逻辑 + 测试）。
2. 并行里程碑各用独立 worktree + 自动合并（`commitWorktree` + `mergeWorktreeBack`），测试文件冲突按可累加原则自动解决（`resolveTestFileConflict`），其他冲突 fail-closed 保留 worktree。
3. `normalizeReport` 清洗 `None`/`null` 等空占位符（DeepSeek 常写 `unresolved: [None]`，否则误判未收敛）。
4. 宽容 YAML 解析器支持 flow-style `{...}`/`[...]`（DeepSeek 常输出单行流式 map/list），及 `name`/`objective`/`files`/`files_touched`/`dependencies`/`verification`/`deliverables`/`done_when`/`exit_criteria`/`acceptance` 等别名。
5. `/dual project repo=<path>` 支持对非 pane-cwd 的 Git 仓库跑项目（规避 Herdr 对 git cwd pane 的回收）；任务产物用 `beginFor(repoPath)` 落到仓库内。
6. 读取 Executor 报告在 agent idle 后加延迟/重试，避免 alternate-screen 未刷新导致空报告。

### 实测：三 pane 端到端跑通（DeepSeek 全家）

用 `new-api/deepseek-v4-pro` 同时作主控/Controller/Judge、PM 与 Executor 完成真实端到端：
PM 生成 WBS → 主控校验并展示 → 用户批准 → M1 实现（Executor pane）→ 收敛 → PM 里程碑反馈 → M2 → 最终 Gate → PM 产品验收 `accepted` → Controller ratification `accepted` → 项目 `ACCEPTED`，全部产物归档（`plan.yaml`、`milestone-<M>-feedback.yaml`、`product-acceptance.yaml`、`controller-ratification.yaml` 等）。

**实测修复**：
1. **PM IPC 改为产物文件**：Pi 的 alternate-screen 转录常截断 PM 输出，改为 PM 用被守卫的 `write` 工具把响应写入 `<prefix>-response.yaml`，主控以文件为准（`pm-write-guard.ts` 只允许写 PM 产物目录）。
2. **宽容解析器支持同缩进块序列**：合法 YAML 的 `key:` 下顶层列表可与键同缩进，此前会被丢字段；现支持 `name`/`work_items`/`done_when`/`deliverables`/`exit_criteria` 等真实模型别名，依赖引用大小写归一化。
3. **`parseJudgeOutput` 支持 JSON 产物**：judge 持久化为 JSON，宽容解析器读不出，导致项目端把已收敛里程碑误判 FAILED；补 JSON 兜底。
4. **`waitForProductManagerResponse` 以产物文件为完成信号**，不再依赖易误报的 agent state。
5. **Herdr pane cwd 用稳定非仓库目录**，避免 Git 检出 cwd 下 pane 被回收。

新增 `extension/pm-write-guard.ts`；核心测试增至 60 项。

### 决定：大型项目的里程碑式分层规划（Milestone-driven）

**背景**：当前 Dual-Gate 对大型项目只有一个"契约 → 一次 Executor → 一次 Judge"的闭环。
大任务的上下文窗口、遗忘、全仓测试慢、无法中途验收会显著放大，单会话啃完整项目不可靠。

**方向**：把现有闭环机制原样复用，只把"一个契约"升级为"项目计划 + 里程碑序列"。

```
Controller 规划
  ├─ 项目级契约（总目标/约束/整体验证）
  └─ 里程碑分解 WBS：M1..Mn（含依赖边）
       每个里程碑 = 作用域文件 + 预期结果 + 验收标准 + 验证命令 + 风险
                    │
                    ▼
       里程碑循环（串行，按依赖拓扑序）
         每个里程碑复用现有闭环：
         Executor(该里程碑切片) → 作用域 Gate → Judge → delta 修复 → 收敛
                    │
                    ▼
        进度持久化：milestone i/N、产物按里程碑归档
```

**四个关键优化（按性价比排序）**：

| # | 优化 | 解决的问题 |
|---|------|-----------|
| 1 | 里程碑分解 + 逐个执行 | 上下文不溢出、进度可见、每步可验收、失败隔离在单个里程碑 |
| 2 | 项目知识复用（Repo Memory） | Executor 冷启动重复学仓库；共享记忆文件跨里程碑复用 |
| 3 | 作用域化 Gate | 全仓测试每步都跑太慢；只跑受影响模块 |
| 4 | 并行里程碑（后续） | 无依赖里程碑用独立 worktree + 多 Executor pane 并行（worktree 隔离已有基础） |

**附加建议**：
- 计划先给用户审：大项目拆解后先展示确认/修改里程碑再执行（沿用高风险确认机制思路）
- Controller 只做架构不做实现：保持"指定结果不指定实现"，避免 Token 浪费

**实现路径**：
- Stage 1（核心）：plan.yaml + WBS 拆解 + 里程碑循环 + 按里程碑归档产物 + 进度展示
- Stage 2：Repo Memory 共享知识积累
- Stage 3：并行里程碑（worktree + 多 pane）

**状态**：项目模式现为三 pane：`/dual project <request>` 在 WBS 前创建持久、只读的 Product Manager Herdr pane；主 Pi 校验/展示 WBS 并取得显式确认。里程碑按依赖有序批次调度：**同批无依赖里程碑并行**（各自独立 worktree + Executor pane），收敛后自动合并回主 checkout（Executor 改动先提交到分支再 merge；测试文件冲突按可累加原则自动解决，其他冲突 fail-closed 并保留 worktree）；依赖的里程碑进入后续批次。每个收敛里程碑会向同一 PM 写入有界完成交接；最终 PM 产品验收是 Controller ratification 的强制输入。PM 只允许 `read,grep,find,ls` + 产物目录受限的 `write`，所有 IPC 和结果均由主 Pi 持久化于 `.pi/dual-gate/projects/`。PM 丢失仅可 L1 恢复一次，失败 fail closed；无跨重启 in-flight resume、作用域 Gate。`worktree.mode: isolated` 仍在项目入口被拒绝。

---

### 决定：执行阶段支持暂停 → 控制端再分析 → 重新分派

**需求**：执行阶段用户可能有需求变动，需要：
1. 在控制端暂停当前执行（挂起 Executor，不丢失已做工作）
2. 用户在控制端进行再分析（结合新需求）
3. 控制端重新分派给执行端（增量继续，而非从头重来）

**设计要点**：
- `/dual pause`：暂停当前任务（设置暂停标志；等待循环在检查点感知）
- 暂停时保持 Executor pane 存活、任务上下文/产物不丢
- `/dual resume <新需求说明>`：把新需求合并进契约（Spec Update），增量分派给同一 Executor
- 状态机新增 `PAUSED` 状态（从 EXECUTING/GATING/JUDGING/FIXING_* 可进入，可恢复回原状态）
- 与现有 `/dual cancel`（终止任务）区分

**状态**：已实现基础暂停/恢复：轮询中的执行可在下一次轮询暂停，`/dual resume` 支持无参数恢复或带新需求恢复。跨 Pi 重启的任务恢复仍未实现。
