---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-27T20:00:00"
  target: "evolution-engine/src/ (diff HEAD~1..HEAD for Phase 4 merge-reviewer scope)"
  verdict: fail
  summary: "健壮性评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 6
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 1

review_metrics:
  files_reviewed: 6
  issues_found: 6
  must_fix_count: 2
  low_count: 3
  info_count: 1
  duration_estimate: "30min"

issues:
  - id: 1
    severity: MUST_FIX
    location: "evolution-engine/src/judge.ts:64-79"
    title: "extractReportSubset 未处理 merge-reviewer target，数据语义错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "evolution-engine/src/types.ts:80"
    title: "EvolveCommandParams.target 类型缺少 merge-reviewer，绕过类型安全"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "evolution-engine/src/commands.ts:246-251"
    title: "diffPreview 与 return 语句缩进不一致（3 tab vs 4 tab）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "evolution-engine/src/commands.ts (全域)"
    title: "commands.ts 完全缺失日志设施，含静默错误吞噬"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "evolution-engine/src/monitor.ts:54, 62"
    title: "writeFlag/ensureDir 缺少 try/catch 保护"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "evolution-engine/src/judge.ts:64-79"
    title: "merge-reviewer 目标缺少明确的数据字段提取定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

---

# Robustness Review v1 — Phase 4 evolution-engine 变更

## 评审记录

- **评审时间**：2026-05-27 20:00
- **评审类型**：健壮性编码评审（六维度：错误处理、异常、日志、fail-fast、测试友好、调试友好）
- **评审对象**：`evolution-engine/src/` 下 Phase 4 变更（merge-reviewer target 支持 + ANALYZER_SCRIPT fail-fast + diffPreview + monitor 日志）
- **变更概览**：6 个文件改动，1 个新增模板文件，包含 merge-reviewer target 支持、ANALYZER_SCRIPT 前置检查、evolve-apply 显示 diff 预览、monitor 日志引入、测试路径修复

---

## 检查维度总览

| 维度 | 状态 | 说明 |
|------|------|------|
| 错误处理 | ⚠️  | extractReportSubset 缺乏 merge-reviewer 分支，数据语义错误；writeFlag 无异常保护 |
| 异常 | ⚠️  | 整体 throw Error 模式一致，但类型系统中的 target 枚举缺少 merge-reviewer 可能隐藏运行时异常 |
| 日志 | ⚠️  | monitor.ts 新增了 logger（好），但 commands.ts 完全无日志，2 处 silent catch |
| fail-fast | ✅ | ANALYZER_SCRIPT 前置检查是好实践。其余 fail-fast 模式基本完整 |
| 测试友好 | ⚠️  | extractReportSubset 缺失分支难以测试；execFileSync 内联使 handleEvolve 难以单元测试 |
| 调试友好 | ⚠️  | 新增 monitor 日志是好方向，但 commands.ts 零日志及其 silent catch 严重限制调试能力 |

---

## 发现的问题

### MUST FIX

#### #1 [MUST FIX] extractReportSubset 未处理 merge-reviewer target — 数据语义错误

**文件**: `evolution-engine/src/judge.ts:64-79`
**状态**: open

**问题描述**:
`extractReportSubset` 函数没有为 `"merge-reviewer"` target 定义专用的提取分支。当 `target="merge-reviewer"` 时，函数跳过 `target === "all"` 和 `target === "claude-md"` 两个分支后，直接 fallthrough 到 skills 提取逻辑：

```typescript
// 无 target === "merge-reviewer" 守卫
if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
if (report.skill_health != null) subset.skill_health = report.skill_health;
if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
return subset;
```

后果：merge-reviewer 模板（`merge-reviewer.txt`）期望的输入是「工具调用统计（edit 重试率、read 重复率）」、「错误模式（merge 冲突、test 失败）」、「用户交互模式（代码审查反馈、修改频率）」，但 LLM Judge 实际收到的是 `skill_stats`、`skill_health` 等技能相关数据。分析结果将基于错误的数据子集，可能产生误导性建议。

**判定理由**: 该问题在生产环境会导致数据语义错误 — LLM Judge 基于错误的数据子集产出建议，直接影响 merge-reviewer 功能的分析质量。

**修改方向**: 为 `"merge-reviewer"` 添加专用的数据提取分支，提取 `tool_stats`（含 editRetries）、`error_stats`、`user_patterns` 等合并流程相关字段。参考 `"claude-md"` 分支的模式：

```typescript
if (target === "merge-reviewer") {
  if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
  if (report.error_stats != null) subset.error_stats = report.error_stats;
  if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
  return subset;
}
```

---

#### #2 [MUST FIX] EvolveCommandParams.target 类型缺少 merge-reviewer — 类型安全被绕过

**文件**: `evolution-engine/src/types.ts:80`
**状态**: open

**问题描述**:
`EvolveCommandParams.target` 的类型定义为 `"all" | "claude-md" | "skills"`，但工具参数 schema（`StringEnum(["all", "claude-md", "skills", "merge-reviewer"])`）已包含 `"merge-reviewer"`。

在 `index.ts:131` 中通过类型断言规避了编译错误：
```typescript
target: params.target as "all" | "claude-md" | "skills",
```

这导致在 `handleEvolve` 函数中，`params.target` 的 TypeScript 类型为 `"all" | "claude-md" | "skills"`，但运行时值可能是 `"merge-reviewer"`。如果未来有人在 `handleEvolve` 中添加基于 target 的 `switch`/`if-else`，TypeScript 不会触发 exhaustiveness 检查来覆盖 `"merge-reviewer"` 分支。

**判定理由**: 类型系统被刻意绕过，隐藏分支遗漏风险。虽当前运行时行为正确（值会穿透到 `buildJudgeInput`），但破坏了 TypeScript 作为类型安全工具的价值，是技术债务的积累点。

**修改方向**: 更新 `EvolveCommandParams.target` 类型添加 `"merge-reviewer"`：

```typescript
target: "all" | "claude-md" | "skills" | "merge-reviewer";
```

同时移除 `index.ts` 中的类型断言，并在 `handleEvolve` 中确认所有 target 分支已处理。

---

### LOW

#### #3 [LOW] diffPreview 与 return 语句缩进不一致

**文件**: `evolution-engine/src/commands.ts:246-251`
**状态**: open

**问题描述**:
在 `handleEvolveApply` 的 `pendingItems.map(...)` 回调中，新添加的 `const diffPreview` 和 `return` 语句使用了 3 级 tab 缩进，而同一回调块中的 `const header`、`const desc`、`const rationale`、`const diff` 使用 4 级 tab 缩进。缩进不一致破坏了代码的可读性。

**判定理由**: 代码风格问题，不影响功能。根据项目 CLAUDE.md 品味规则及评审分级收紧规则，归为 LOW。

**修改方向**: 将 `const diffPreview` 和 `return` 的缩进调整为 4 级 tab，与其他局部变量一致。

---

#### #4 [LOW] commands.ts 完全缺失日志设施，含静默错误吞噬

**文件**: `evolution-engine/src/commands.ts`（全域，特别是 `handleEvolve`、`handleEvolveApply`、`handleEvolveStats`、`handleEvolveRollback`）
**状态**: open

**问题描述**:
`commands.ts` 全篇未使用日志设施。`monitor.ts` 已在本次变更中引入 `createLogger`（好方向），但 `commands.ts` 仍然是"黑暗中的代码"：

- 所有 4 个 handler 的 catch 块都只执行 `throw new Error(...)`，原始错误 (`err`) 未记录
- `findRecentReport` 的 catch 块仅有注释 `// 文件读取失败，跳过`，无任何日志，静默吞噬错误
- `handleEvolveStats` 中 daily 文件读取循环的 catch 块仅有注释 `// 损坏文件跳过`，无日志

当生产中出现异常时，运维人员只能看到最终的错误消息，无法追溯到原始错误类型、堆栈和发生时的上下文（target、since 等参数）。

**判定理由**: 不影响功能正确性，但严重限制生产调试能力。属于与本次需求无直接关联的预存代码质量问题。

**修改方向**: 
1. 在 `commands.ts` 中导入 `createLogger`，实例化 logger
2. 每个 catch 块中增加 `log.error(msg, err)` 
3. `findRecentReport` 和 `handleEvolveStats` 的 silent catch 增加 `log.warn`
4. 在关键执行点（analyzer 启动、Judge 完成、suggestion 保存等）增加 info 日志

---

#### #5 [LOW] writeFlag/ensureDir 缺少 try/catch 保护

**文件**: `evolution-engine/src/monitor.ts:54, 62`
**状态**: open

**问题描述**:
`writeFlag` 和 `ensureDir` 分别直接调用 `writeFileSync` 和 `mkdirSync`，没有任何异常保护。相比之下，同一文件中的 `removeFlag` 已有 try/catch 保护（正确处理删除竞争条件）。

若 `writeFlag` 因权限不足或磁盘满而抛出异常，`checkAutoTriggerRules` 将整体失败，进而影响 `session_start` 事件处理器。虽然 Pi 运行时可能保护单个事件处理器不崩溃，但 auto-trigger 检查的功能会失效。

**判定理由**: 极端条件（权限/磁盘）下可能导致自动触发规则失效。当前条件较为罕见，不影响核心功能，归为 LOW。

**修改方向**: 为 `writeFlag` 添加 try/catch，在写入失败时记录日志而不是抛出异常。`ensureDir` 可以保持简单（目录创建失败本就是需要暴露的错误）。

---

### INFO

#### #6 [INFO] merge-reviewer 目标缺少明确的数据字段提取定义

**文件**: `evolution-engine/src/judge.ts:64-79`
**状态**: open

**问题描述**:
除 MUST FIX #1（数据语义错误）之外，更深远的问题是：Phase 2 报告中的哪些字段与合并流程分析相关？当前代码和文档均未定义 merge-reviewer 目标的必要数据字段清单。

`merge-reviewer.txt` 模板期望三类数据（工具调用统计、错误模式、用户交互模式），但 Phase 2 报告是否真的包含 `merge 冲突`、`test 失败` 等合并相关统计？如果报告不包含这些字段，即使修正了 extractReportSubset 的 target 分支，传递给 LLM Judge 的数据仍然不完整。

**判定理由**: 观察记录，不阻塞。在 Phases 2 报告扩展相关字段后需同步更新此数据提取逻辑。

---

## 各维度逐项分析

### 1. 错误处理

| 文件 | 评价 |
|------|------|
| commands.ts | ✅ 所有 handler 有 try/catch + 统一的 throw Error 模式。ANALYZER_SCRIPT 前置检查是好实践。⚠️ findRecentReport silent catch 吞噬 I/O 错误。 |
| monitor.ts | ⚠️ readJsonSafe/removeFlag 有保护，但 writeFlag/ensureDir 无保护。 |
| judge.ts | ⚠️ extractReportSubset 缺失 merge-reviewer 分支。buildJudgeInput/report 路径缺失保护。 |

### 2. 异常

| 文件 | 评价 |
|------|------|
| commands.ts | ✅ 所有 `throw new Error()` 包含可读的上下文。索引越界提前校验。 |
| monitor.ts | ✅ loadRecentDaily 处理目录不存在。removeFlag 带异常保护。 |
| judge.ts | ⚠️ existsSync 检查 templatePath 后 throw。parseJudgeOutput 数组/对象/字段逐步校验。 |

### 3. 日志

| 文件 | 评价 |
|------|------|
| commands.ts | ❌ 全篇零日志。2 处 silent catch（findRecentReport、handleEvolveStats）直接吞错误。 |
| monitor.ts | ✅ 本次新增了 log.info 调用。⚠️ 无 log.error/log.warn 用于异常路径。 |
| judge.ts | ❌ 无日志。spawn 失败/template 缺失/parse 失败均无日志。 |

### 4. fail-fast

| 文件 | 评价 |
|------|------|
| commands.ts | ✅ ANALYZER_SCRIPT 缺失提前报错。handleEvolveApply 校验 pending 是否存在。index 越界校验。 |
| monitor.ts | ✅ 无 fail-fast 需求（监控类代码应优雅降级而非快速失败）。 |
| judge.ts | ✅ template 存在性校验。Judge 超时机制。spawn 失败及时 reject。 |

### 5. 测试友好

| 文件 | 评价 |
|------|------|
| commands.ts | ⚠️ execFileSync 内联使 handleEvolve 难单元测试。handler 返回 CommandResult 利于断言。 |
| monitor.ts | ✅ 纯函数分离（checkTokenDecline、checkErrorSpike 等）易于测试。`loadRecentDaily`、`tailN` 均有明确输入输出。 |
| judge.ts | ⚠️ parseJudgeOutput 纯函数易于测试。但 extractReportSubset 缺失 merge-reviewer 分支增加测试场景。 |
| test | ✅ 测试路径从硬编码改为 `new URL(..., import.meta.url)` — 更健壮。 |

### 6. 调试友好

| 文件 | 评价 |
|------|------|
| commands.ts | ❌ 零日志，silent catch。错误消息含上下文但溯源困难。 |
| monitor.ts | ✅ 本次新增日志（`log.info("Auto-trigger check: ...")` 和 `log.info("Rule ... triggered: ...")`）。 |
| judge.ts | ⚠️ parse 失败保存原始输出到 tmp 文件是好实践。整体无日志。 |

---

## 结论

**需修改后重审**。2 条 MUST FIX 需在下一轮评审前解决：

1. **#1** — `extractReportSubset` 缺少 `merge-reviewer` target 分支，需添加数据提取逻辑
2. **#2** — `EvolveCommandParams.target` 类型定义未包含 `merge-reviewer`，需更新类型定义并移除类型断言

3 条 LOW 问题和 1 条 INFO 记录供参考，不阻塞评审通过。
