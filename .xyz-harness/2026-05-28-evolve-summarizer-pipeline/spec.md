---
verdict: pass
---

# Evolve Summarizer Pipeline

## Background

Evolution engine 的 `/evolve` 命令在分析用户 session 数据时，将 Python analyzer 产出的原始报告（745KB，673 sessions）直接作为 prompt 传给 LLM Judge。这导致：

1. **LLM Judge 空输出**：prompt 过大，`pi --mode json` 子进程返回空 stdout，parseJudgeOutput 在第一行就 throw "Empty Judge output"
2. **线性膨胀**：analyzer 报告大小与 session 数量线性增长，`duplicate_reads`（990 条 185KB）、`repeated_requests`（50 条 152KB）等大列表占 60%+ 体积
3. **职责错位**：LLM 被用来做统计分析（代码更擅长），而不是语义推理（LLM 擅长）
4. **无趋势对比**：每次 evolve 独立分析，无法对比历史变化
5. **无效果追踪**：apply 了 suggestion 后，不知道指标是否改善

根因：analyzer 和 Judge 之间缺少一个 summarizer 层，将原始统计数据压缩为 LLM 可消费的信号摘要。

## Functional Requirements

### FR-1: Signal Summarizer（核心新增模块）

在 analyzer 和 LLM Judge 之间插入 TypeScript summarizer，将原始报告压缩为 ~5KB 信号摘要。

**FR-1.1 聚合压缩规则**

| 数据类型 | 处理策略 | 具体参数 |
|----------|----------|----------|
| 已聚合指标（`by_tool` count/rate、`bash_command_types`） | 原样保留 | — |
| `duplicate_reads` | top 10 截断 | 按重复次数降序，每条保留 `{file, count, example: 一句描述}` |
| `repeated_requests` | top 5 截断 | 按频率降序，每条保留 `{pattern, count, example: 一句描述}` |
| `common_tool_sequences` | top 10 截断 | 按频率降序，每条保留 `{sequence, count}` |
| Per-project 明细（`by_project` 数组） | top 5 + other 聚合 | 按对应维度降序，其余合并为 `{name: "other", ...}` |
| 异常检测结论（`actionable_issues`、`skill_health`） | 原样保留 | — |

**FR-1.2 异常检测**

对关键指标做阈值检测，标记异常项：

- 工具失败率 > 10%（含 bash、edit）
- Skill 从未触发（dormant skills）
- 用户纠正率 > 20%
- Token 热点（单项目消耗 > 总量 30%）

**FR-1.3 趋势对比**

读取 `metrics-history.json`，与上一个快照做差值，只保留变化率超过 ±20% 的趋势项。

### FR-2: Metrics History（趋势数据持久化）

**FR-2.1 数据模型**

每次 summarize 产出一个 `MetricsSnapshot`，追加到 `metrics-history.json`。字段覆盖 4 个维度：

- 工具健康：totalToolCalls、toolFailureRates（仅 < 0.95 的）、editRetryRate、bashFailureRate
- Agent 效率：singleTurnCompletionRate、avgTurnsPerSession、avgToolCallsPerSession、selfCorrectionRate
- Token 与成本：totalInputTokens、totalOutputTokens、totalCost、avgInputPerSession、avgOutputPerSession
- 用户满意度代理：userCorrectionRate、repeatedRequestCount、medianSessionMinutes
- Skill 健康：activeSkillCount、dormantSkillCount、totalSkillFileSize

**FR-2.2 滑动窗口**

最多保留 30 个快照。超出时删除最老的。固定大小，不随时间膨胀。

### FR-3: Effect Tracker（效果追踪闭环）

**FR-3.1 Apply 记录快照关联**

`history.jsonl` 的 apply 记录增加 `metricsSnapshotDate` 字段，关联 apply 时刻的最新快照日期。

**FR-3.2 Evolve 时回溯**

下次 evolve 时，如果 history 中有"最近 7 天内的 apply 记录"，summarizer 读取 apply 前后的 metrics snapshot 做对比，将效果数据写入信号摘要的 `effectReview` 字段。LLM Judge 据此判断建议是否有效。

### FR-4: 数据 GC

**FR-4.1 保留策略**

| 数据 | 保留 | 理由 |
|------|------|------|
| `daily/*.json` | 90 天 | 趋势对比需要足够长的时间窗口 |
| `reports/*.json`（原始） | 最近 3 份 | 信号摘要已是永久记录，原始报告只做 drill-down 备份 |
| `signals/*.json`（摘要） | 最近 30 份 | 用于趋势对比 + 审计追溯 |
| `metrics-history.json` | 30 个数据点（滚动覆盖） | 趋势计算源 |
| `pending.json` | 当前 pending | 不累积 |
| `history.jsonl` | 全量 | 审计 + effect tracking（每条 < 1KB） |

**FR-4.2 GC 触发时机**

每次 `handleEvolve` 执行时顺带触发 GC（lazy GC），不设独立定时器。

### FR-5: Judge 调用方式修复

**FR-5.1 stdin 传 prompt**

将 `userMessage` 从 spawn 的 args 参数改为通过 stdin 传入 pi 子进程，避免命令行参数过长。

**FR-5.2 信号摘要作为输入**

Judge 不再读取原始报告路径，改为读取 `signals/signal-{timestamp}.json`。

### FR-6: Judge 输出健壮性增强

**FR-6.1 空 stderr 诊断**

当 Judge 子进程返回空输出时，将 stderr 内容写入日志，方便排查。

**FR-6.2 重试机制**

Judge 空 JSON 输出时，最多重试 1 次（使用更短的 prompt 提示 LLM 只输出 JSON）。

## Acceptance Criteria

- AC-1: 673 session 的原始报告（745KB）经 summarizer 后产物 <= 10KB
- AC-2: `/evolve` 命令不再报 "Empty Judge output" 错误
- AC-3: `metrics-history.json` 正确记录每次快照，最多 30 条，超出时删除最老
- AC-4: 趋势对比能正确计算变化率，只有 ±20% 以上的变化才写入信号摘要
- AC-5: Apply suggestion 后，下次 evolve 能在信号摘要中看到 `effectReview` 数据
- AC-6: `reports/` 目录保留不超过 3 份文件，`signals/` 不超过 30 份
- AC-7: Judge 子进程通过 stdin 接收 prompt，不再通过命令行参数传递
- AC-8: 类型检查 `npx tsc --noEmit` 通过
- AC-9: ESLint `npm run lint` 0 error

## Constraints

- **Python analyzer 不改**：analyzer 的职责和输出格式保持不变
- **LLM Judge 核心解析逻辑不改**：parseJudgeOutput 和 JSONL 提取逻辑保持不变。允许修改 spawn 调用方式（stdin 替代 args）和增加重试/诊断逻辑（FR-5、FR-6），这些属于调用编排而非 Judge 推理逻辑
- **模块导入规范**：使用 `@mariozechner/*` scope（项目 CLAUDE.md 约束）
- **单文件 <= 1000 行**：summarizer 如超过需拆分
- **函数 <= 80 行**：项目代码规范
- **禁止 any**：使用具体类型
- **与 usage-tracker 解耦**：summarizer 只读取文件系统数据，不直接依赖 usage-tracker 的运行时状态

## 业务用例

### UC-1: 用户运行 /evolve 分析改进建议
- **Actor**: Pi Agent 用户（通过 AI 助手调用）
- **场景**: 用户积累了大量 session 数据，想看看系统哪里可以改进
- **预期结果**: /evolve 成功返回 0-N 条改进建议（不再是 "Empty Judge output" 错误），建议基于聚合信号而非原始明细

### UC-2: 用户 apply 建议后观察效果
- **Actor**: Pi Agent 用户
- **场景**: 用户 apply 了一条 suggestion（如"减少 bash 失败率"），一段时间后再次运行 /evolve
- **预期结果**: 新的 evolve 输出中包含上条建议的效果数据（如 "bash_failure_rate: 0.10 → 0.08, -20%"）

## Task Breakdown

实现可分解为以下独立可验证的子任务：

1. **summarizer.ts** — 新增信号压缩模块（FR-1.1 聚合 + FR-1.2 异常检测）。独立可测试：输入原始 JSON → 输出信号摘要 JSON
2. **metrics-history** — 在 state.ts 中新增 MetricsSnapshot 读写 + 滑动窗口逻辑（FR-2）。独立可测试：写入 31 条 → 验证只保留 30 条
3. **趋势对比** — 在 summarizer.ts 中实现趋势计算（FR-1.3）。依赖 #2，可测试：给定两个 snapshot → 输出 trend delta
4. **effect-tracker.ts** — 新增效果追踪模块（FR-3）。依赖 #2 和 #3，可测试：给定 history + metrics → 输出 effectReview
5. **GC 逻辑** — 新增 gc.ts，实现 reports/signals/daily 的清理（FR-4）。独立可测试
6. **judge.ts 修改** — stdin 传 prompt + 信号摘要作为输入 + 重试/诊断（FR-5、FR-6）。修改现有文件
7. **commands.ts 修改** — handleEvolve 中插入 summarize 调用 + GC 触发（胶水层）。修改现有文件

依赖关系：#1 → #3（依赖 metrics-history 数据模型定义，但代码层面 #1 可独立开发）

## Complexity Assessment

- **规模**: 中等（新增 ~400 行 TS，修改 ~50 行）
- **核心难点**: summarizer 的压缩策略需要平衡"信息量"和"体积"，避免丢失关键信号
- **风险**: LLM Judge 对新格式信号摘要的响应质量需要验证
- **依赖**: 无外部依赖变更，纯内部重构
