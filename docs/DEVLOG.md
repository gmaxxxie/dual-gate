# 研发日志（Dual-Gate Orchestrator）

> 记录功能演进、决策与待办。按日期倒序。

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
