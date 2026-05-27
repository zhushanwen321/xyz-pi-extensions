---
verdict: fail
must_fix: 1
review_metrics:
  files_reviewed: 8
  issues_found: 9
  must_fix_count: 1
  low_count: 3
  info_count: 5
---

# evolution-engine Extension — TypeScript 代码品味审查报告

> 审查日期: 2026-05-27
> 审查依据: essence.md（四条根本原则）+ taste.md（原则/偏好/反模式三级分类）
> 自动化检查: 项目未配置 taste-lint，跳过自动化 lint 阶段

---

## 审查文件清单

| # | 文件 | 行数 | 职责 |
|---|------|------|------|
| 1 | `src/types.ts` | 144 | 类型定义 |
| 2 | `src/state.ts` | 94 | 状态持久化 |
| 3 | `src/judge.ts` | 316 | LLM Judge 子进程编排 |
| 4 | `src/applier.ts` | 242 | 建议应用引擎（apply/rollback） |
| 5 | `src/monitor.ts` | 320 | 自动触发规则监控 |
| 6 | `src/commands.ts` | 443 | Command handler 函数 |
| 7 | `src/index.ts` | 421 | Extension 工厂 + tool/command 注册 |
| 8 | `src/widget.ts` | 146 | TUI 渲染函数 |
| | **合计** | **2126** | |

---

## 各文件审查结果

### 1. `src/types.ts`（144 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| INFO | 一致性 | L113 | `CommandResult.details: Record<string, unknown>` 是合理的边界类型（API 返回值），无需消除 | 在白名单中登记 |

**评价**：类型定义清晰，所有字段使用联合字面量而非 enum，命名一致，接口职责单一。无问题。

---

### 2. `src/state.ts`（94 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| INFO | 反馈 | L75-77 | `loadHistory` 内层 catch `catch { // 损坏行跳过 }` 没有日志，损坏行静默忽略 | 添加 `console.warn` 记录损坏行 |

**评价**：函数短小、职责单一、边界校验充分。`loadPending` 和 `loadHistory` 的 graceful degradation 做得很好。

---

### 3. `src/judge.ts`（316 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| LOW | 重复/死代码 | L86-91 | `buildJudgeInput` 写入 `promptFilePath`（含格式化后的用户消息），但 `runJudge` 并不读取该文件——它自己重新构造了相同内容的 `userMessage`。`promptFilePath` 写入是无用 I/O | 删除 `promptFilePath` 写入逻辑，或让 `runJudge` 统一从 `JudgeInput.promptFilePath` 读取 |
| LOW | 重复 | L88 vs L153 | 用户消息模板 `分析以下信号数据，生成进化建议：\n\n${data}` 在两个函数中各构造一次 | 提取为共享常量或工具函数 |
| INFO | 反馈 | L119-120 | `proc.on("close", ...)` 中 parse 失败时保存原始输出到磁盘，这是好的防御模式 | 保持 |
| INFO | 类型 | L40-43 | `Phase2Report` 使用 `[key: string]: unknown` 索引签名，属于外部 JSON 边界，合理 | 在白名单中登记 |

**评价**：结构基本清晰。`extractAssistantText` 和 `parseJudgeOutput` 的边界校验逻辑很扎实。

---

### 4. `src/applier.ts`（242 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| LOW | 安全 | L193-196 | `execSync` 字符串命令插值 `suggestion.title` 仅转义 `"`，未转义 `$` 、`` ` ``、`;` 等 shell 元字符。`applySuggestion` 和 `rollbackSuggestion` 两处都有此问题 | 使用 `spawn(args[])` 代替 `execSync` 字符串，或使用 `execa` 安全参数模式 |
| LOW | 反馈 | L201-203 | git commit 操作使用空 `catch {}` 吞噬错误，仅有注释说明 | 至少添加 `console.warn` 记录 git 失败原因 |

**评价**：模块边界清晰。`parseUnifiedDiff` 是纯函数，`applySuggestion` 和 `rollbackSuggestion` 职责明确。安全问题是主要扣分项。

---

### 5. `src/monitor.ts`（320 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| MUST_FIX | 类型 | L44 vs commands.ts L313 | `DailyFile.toolCalls.failures` 在本文件定义为 `number`，但在 `commands.ts` 的 `handleEvolveStats` 中作为 `Record<string, number>` 使用（`Object.entries(day.toolCalls.failures)`）。两处类型定义不一致，运行时必抛异常 | 统一类型定义。查看实际 JSON 格式，确定是 `number` 还是 `Record<string, number>`，提取到共享的 `types.ts` 中 |
| INFO | 结构 | L18-49 | `DailyFile` 类型定义在 `monitor.ts` 内部，但 `commands.ts` 有独立的 inline 类型定义与之冲突——这正是共享类型缺失导致的 | 将 `DailyFile`、`SkillTriggerEntry` 等数据接口提取到共享 `types.ts` |
| INFO | 反馈 | L299-303 | `listFlagFiles` 和 `cleanExpiredFlags` 的 empty catch 处理文件竞争条件，可接受 | 保持，但可加 `console.debug` |

**评价**：规则检查逻辑清晰，常量命名规范（`MS_PER_DAY`、`DORMANT_THRESHOLD_DAYS` 等）。MUST_FIX 类型不一致是最严重的问题。

---

### 6. `src/commands.ts`（443 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| LOW | 安全 | L121-123 | `execSync(\`python3 "${ANALYZER_SCRIPT}" --since ${params.since} ...\`)` 中 `params.since` 未经 shell 安全转义直接插值。尽管 tool 参数通常由 AI 控制，防御性原则要求边界校验 | 用 `parseSinceDays` 提取数字后，用纯数字参数构造命令 |
| INFO | 结构 | 全文件 | 443 行，接近 500 行阈值。虽然 4 个 handler 职责清晰，但 `handleEvolve` >80 行（约 70 行纯步进代码，含 try-catch 缩进） | 可考虑将 `handleEvolve` 中的"查找报告+运行 analyzer"步骤提取为独立函数 |
| INFO | 类型 | L313 | `JSON.parse(raw) as { toolCalls?: {...} }` 的 inline 类型与 `monitor.ts` 的 `DailyFile` 接口不一致（见 monitor.ts MUST_FIX） | 提取共享类型 |

**评价**：统一的 `errorResult`/`successResult` 工厂函数是好的模式。`handleEvolveStats` 的聚合逻辑完整。类型不一致是上游问题，在此文件中是症状。

---

### 7. `src/index.ts`（421 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| INFO | 健壮性 | L33-37 | `TEMPLATE_DIR` 的 fallback 使用 `process.cwd()`，这在运行时不确定 cwd 时不可靠。注释自称"理论上不会执行"说明此 path 未经充分验证 | 考虑运行时检测模板目录缺失时抛错而非 fallback |

**评价**：工厂函数模式干净，事件/tool/command 注册分离清晰。`makeDirs()` 被正确抽取。`renderCall`/`renderResult` 都是轻量实现。

---

### 8. `src/widget.ts`（146 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| — | — | — | 无问题 | — |

**评价**：纯渲染函数，没有 I/O 和副作用，职责单一，格式化整洁。

---

## 跨文件问题汇总

### 1. 类型定义不一致（MUST_FIX）

**涉及文件**：`monitor.ts` vs `commands.ts`

```typescript
// monitor.ts L44 — 定义为 number
toolCalls: {
  failures: number;  // ← 1: total failures as a number
}

// commands.ts L313 — 使用为 Record<string, number>
const day = JSON.parse(raw) as {
  toolCalls?: { failures?: Record<string, number>; ... };  // ← per-tool failures as a map
};
```

`monitor.ts` 读 `failures` 做数值计算（`reduce((s, d) => s + d.toolCalls.failures, 0)`）。
`commands.ts` 迭代 `failures` 做 per-tool 统计（`Object.entries(day.toolCalls.failures)`）。

两者不可能同时正确。这是 **"类型定义与实际数据不一致"**（taste.md 反模式），违反 **"一个关注点一条路径"** 和 **"类型即契约"** 两条根本原则。

### 2. `buildJudgeInput` 死代码（LOW）

`promptFilePath` 被写入磁盘但永远不会被读取，因为 `runJudge` 从 `input.reportPath` 读取原始数据后自己构造 user message。

### 3. `execSync` shell 注入面（LOW）

`applier.ts` 和 `commands.ts` 共 4 处 `execSync` 字符串命令拼接。`applier.ts` 的 title 转义不完整，`commands.ts` 的 `since` 参数未经 shell 转义。尽管输入源受控（AI tool 参数或 LLM 输出），防御性编码要求边界处做完整逃逸或改用安全 API。

---

## 按原则汇总

| 原则 | 评估 | 说明 |
|------|------|------|
| 显式优于隐式 | ✅ 总体好 | 无 `any`，类型精确，常量命名规范。唯一例外：`DailyFile` 类型定义不一致 |
| 一条关注点一条路径 | ⚠️ 轻微违规 | `buildJudgeInput` 的用户消息构造路径有两处；`DailyFile` 类型在两个文件中有不同的表述 |
| 信任止于边界 | ✅ 好 | 外部 JSON 统一在入口解析校验；`isPathAllowed` 白名单校验 |
| 反馈不断裂 | ⚠️ 轻微违规 | git 操作的 empty catch 无日志；`state.ts` 损坏行跳过无日志 |

---

## 建议重构顺序

1. **MUST_FIX**: 修复 `DailyFile` 类型定义不一致——确认实际 JSON 格式，统一类型，提到 `types.ts`
2. **LOW**: 清理 `buildJudgeInput` 的 `promptFilePath` 死代码
3. **LOW**: 加固 `execSync` 调用的 shell 安全——改用 `spawn` 参数数组或增加 escaping
4. **LOW**: 为 silent catch 块添加日志
5. **INFO**: 将 `DailyFile`、`SkillTriggerEntry` 等数据结构提取到共享 `types.ts`
6. **INFO**: 重构 `TEMPLATE_DIR` fallback 逻辑
