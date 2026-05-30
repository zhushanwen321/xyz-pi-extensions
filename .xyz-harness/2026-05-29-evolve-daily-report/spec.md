---
verdict: pass
---

# Evolve Daily Report — 每日自动分析报告

## Background

当前 evolve 系统是"手动触发 + 交互式 apply"模式：

1. 用户手动执行 `/evolve` → analyzer 采集数据 → LLM Judge 生成 suggestions → 存入 pending.json
2. 用户手动执行 `/evolve-apply` → 逐条 review → apply/skip

实际使用中，用户希望的是**被动接收模式**：每天自动跑一次分析，产出一份人类可读的报告，看完报告后决定哪些要改。而不是主动记住要去跑 `/evolve`。

当前架构中缺失的部分：
- **定时触发**：没有自动执行 evolve 的机制（monitor.ts 只检测异常写 flag，不触发分析）
- **报告持久化**：pending.json 是给 /evolve-apply 消费的机器格式，没有人类可读的 Markdown 报告
- **按日期归档**：analyzer 的 JSON 报告用时间戳命名（`phase2-1698765432.json`），没有按日期组织的报告存档
- **人工决策替代自动 apply**：用户希望看完报告后直接跟 AI 说"执行建议 #2"，而不是走 /evolve-apply 的 tool call 流程

## Functional Requirements

### FR-1: 每日自动触发

**FR-1.1 Session Start 异步检查**

在 `session_start` 事件中异步触发每日分析。**fire-and-forget 模式**：`session_start` handler 立即返回，分析流程在后台执行。

判断依据：`daily-reports/YYYY-MM-DD.md` 文件是否存在且非空（文件大小 > 0）。

- 文件存在且非空 → 跳过（当天已分析过）
- 文件不存在或为空 → 触发一次完整的 analyze → summarize → judge → report 生成流程

日期使用 UTC（与现有 `summarizer.ts` 中的 `new Date().toISOString().slice(0, 10)` 一致）。

**FR-1.2 并发保护：lock 文件**

使用 `daily-reports/.daily-report.lock` 文件防止并发执行：
- pipeline 启动前写入 lock 文件（内容为 PID + timestamp）
- 完成后删除 lock 文件
- 检测到 lock 文件时，检查 PID 是否存活：存活则跳过，不存活则清除 stale lock 并继续
- 报告使用 temp-file-rename 模式：先写 `.tmp` 文件，完成后 `rename` 为最终文件名（原子操作）

**FR-1.3 时间范围固定为 1d**

自动触发的分析固定使用 `since=1d`，分析过去 24 小时的数据。不支持自定义范围——自定义范围通过手动 `/evolve` 命令实现。

**FR-1.4 失败处理**

自动触发的分析失败时：
- 不阻塞 session 启动（fire-and-forget）
- 错误写入日志文件
- 失败时清理 lock 文件和临时报告文件
- 写入 `daily-reports/.last-run-status` 文件记录状态（`success` / `failed` + 时间戳 + 错误摘要），供 `/evolve-report --list` 展示健康状态

**FR-1.5 零 session 日**

如果 analyzer 返回 0 session 的报告，仍然生成报告，但各章节显示"无数据"。不跳过生成。

### FR-2: 每日分析报告

**FR-2.1 报告格式**

Markdown 文件，存储在 `~/.pi/agent/evolution-data/daily-reports/YYYY-MM-DD.md`。

报告结构：

```markdown
# Evolution Daily Report — YYYY-MM-DD

## 数据概览
- Session 数量：N
- 工具调用总数：N
- Token 消耗：input N / output N
- 平均每 session 轮次：N

## 异常信号
（列出 anomalies，无异常则显示"无异常"）

## 趋势变化
（列出与上一日的 trend delta，无变化则显示"无显著变化"）

## 改进建议
（列出 suggestions，无建议则显示"系统运行良好，无需调整"）
### #0 [HIGH] 标题
- 描述：...
- 依据：...
- 修改目标：`/path/to/file`
- 修改指令：...

## 效果回顾
（列出最近 apply 的 suggestion 的效果数据，无则省略此节）
```

**FR-2.2 报告内容来源**

复用现有 pipeline 的全部产物：

| 报告章节 | 数据来源 |
|----------|----------|
| 数据概览 | `MetricsSnapshot` |
| 异常信号 | `SignalReport.anomalies` |
| 趋势变化 | `SignalReport.trends` |
| 改进建议 | `EvolutionSuggestion[]`（Judge 输出） |
| 效果回顾 | `EffectReview[]` |

**FR-2.3 报告持久化**

- 路径：`daily-reports/YYYY-MM-DD.md`
- 编码：UTF-8
- 覆盖策略：同一天覆盖（幂等）
- 保留策略：GC 清理超过 30 天的报告

### FR-3: 报告查看命令

**FR-3.1 `/evolve-report` 命令**

新命令，查看每日分析报告。

- `/evolve-report` — 显示今天的报告（如果存在）
- `/evolve-report YYYY-MM-DD` — 显示指定日期的报告
- `/evolve-report --list` — 列出所有可用的报告（按日期降序，最多 10 条）。额外显示：最近一次成功生成日期、今天是否已生成、过去 7 天中缺失的日期

错误处理：
- 指定日期不存在时返回 "YYYY-MM-DD 的报告不存在"
- 今天报告尚未生成时返回 "今天的报告尚未生成，可能正在分析中或分析失败" + `.last-run-status` 中的错误摘要
- 报告文件损坏时返回 "报告文件损坏"

**FR-3.2 与 `/evolve` 命令的关系**

`/evolve` 保持不变，仍然作为手动分析入口（支持自定义 target/since）。自动触发的每日分析走独立的代码路径，不依赖 `/evolve` 命令。

### FR-4: pending.json 同步更新

**FR-4.1 自动更新**

每日自动分析完成后，同步更新 `pending.json`。这样用户看完报告后可以：
- 用 `/evolve-apply` 逐条处理（现有流程不变）
- 或直接跟 AI 说"执行报告里的建议 #0"（AI 会调 evolve-apply tool）

**FR-4.2 增量合并（去重）**

如果 `pending.json` 中有未处理的 pending 状态建议（status === "pending"），新建议追加到末尾而不是覆盖。已有建议的状态不受影响。

去重策略：基于 title 的精确匹配。如果新建议的 title 与已有的 pending 建议完全相同，跳过该建议（不重复追加）。这避免了同一问题连续多天产生重复建议。

容量保护：`pending.json` 中 pending 状态建议不超过 30 条。超出时，标记最早的 pending 建议为 rejected（附带 reason: "auto-evicted: exceeded capacity"）。

### FR-5: GC 扩展

**FR-5.1 daily-reports 目录纳入 GC**

在 `gc.ts` 的 `runGc` 中增加对 `daily-reports/` 目录的清理：

- 保留最近 30 天的 Markdown 报告
- 清理逻辑与现有 `daily/` 的 GC 一致

## Acceptance Criteria

- AC-1: Pi 启动后首次 session 自动检测并生成当日分析报告（`daily-reports/YYYY-MM-DD.md`）
- AC-2: 同一天内多次启动 Pi 不会重复生成报告（幂等）
- AC-3: 报告包含数据概览、异常信号、趋势变化、改进建议四个章节（效果回顾为条件章节，仅有 apply 记录时出现）
- AC-4: 报告中的建议与 `pending.json` 中的数据一致
- AC-5: `/evolve-report` 能正确展示当天和指定日期的报告
- AC-6: `/evolve-report --list` 能列出所有可用报告
- AC-7: 已有 pending 建议不被新分析覆盖（增量合并）
- AC-8: 自动分析失败时不阻塞 session 启动，`.last-run-status` 记录失败信息
- AC-8a: 并发 session_start 不会导致重复执行 pipeline
- AC-8b: 相同 title 的建议不会在 pending.json 中重复出现
- AC-9: `daily-reports/` 目录的旧文件被 GC 正确清理（> 30 天）
- AC-10: 类型检查 `npx tsc --noEmit` 通过
- AC-11: 现有 `/evolve`、`/evolve-apply`、`/evolve-stats`、`/evolve-rollback` 命令行为不受影响

## Constraints

- **不改变现有 pipeline**：analyzer → summarizer → judge 的调用链路保持不变，只在外层包装"自动触发 + 报告生成"
- **不改变现有命令行为**：`/evolve`、`/evolve-apply`、`/evolve-stats`、`/evolve-rollback` 保持现有行为
- **不引入外部定时器**：不用 cron、setInterval。触发点仅限 session_start 事件
- **异步执行**：session_start 中的每日分析必须 fire-and-forget，不 await 返回值。session 初始化不受分析耗时影响
- **模块导入规范**：使用 `@mariozechner/*` scope
- **单文件 <= 1000 行**
- **函数 <= 80 行**
- **禁止 any**

## 与现有 monitor.ts 的关系

monitor.ts 的 auto-trigger 机制（token-decline、skill-dormant、error-spike）与每日报告**共存**：
- monitor.ts 在每次 session_start 运行，做轻量级阈值检测，命中时写 flag + 弹通知。它是**实时异常警报**
- 每日报告做完整的 analyze → summarize → judge 流程，产出深度分析。它是**每日深度体检**
- 两者信号可能重叠（都检测到 error spike），这是合理的——monitor 做实时提醒，报告做趋势分析和建议

## Task Breakdown

1. **report-generator.ts** — 新增报告生成模块，输入 SignalReport + Suggestions + EffectReview → 输出 Markdown 文本。纯函数，独立可测试
2. **daily-trigger.ts** — 新增每日触发逻辑，封装"lock → 检查是否需要运行 → 运行 pipeline → 生成报告 → 更新 pending → 解锁"的完整流程。fire-and-forget
3. **gc.ts 扩展** — 在现有 GC 中增加 daily-reports 目录清理（保留 30 天）
4. **state.ts 扩展** — pending.json 的增量合并逻辑（mergePending），含 title 去重和容量保护
5. **index.ts 修改** — session_start 事件中异步调用 daily-trigger（不 await），注册 `/evolve-report` 命令
6. **types.ts 扩展** — Dirs 增加 dailyReportsDir 字段

依赖关系：#1 和 #2 是核心新模块，#3/#4/#5/#6 是胶水和集成

## Complexity Assessment

- **规模**: 小到中等（新增 ~250 行 TS，修改 ~60 行）
- **核心难点**: 并发安全（lock 机制）和 fire-and-forget 的错误处理
- **风险**: analyzer + judge 合计耗时 30-60s，虽然是异步的，但并发资源消耗需注意。如果用户同时在手动跑 `/evolve`，两个 pipeline 可能竞争
- **依赖**: 依赖现有 pipeline（analyzer、summarizer、judge）正常工作
