---
verdict: fail
must_fix: 3
review_metrics:
  files_reviewed: 10
  issues_found: 8
  must_fix_count: 3
  low_count: 4
  info_count: 1
created: 2026-05-27
---

# Standards Review — evolution-engine Extension

## Overview

审查 evolution-engine 扩展的全部 9 个源文件 + package.json，对照 CLAUDE.md 中的项目编码规范、架构约束和品味规则。

## Files Reviewed

| # | File | Lines | Status |
|---|------|-------|--------|
| 1 | evolution-engine/src/types.ts | 144 | ✅ |
| 2 | evolution-engine/src/state.ts | 94 | ✅ |
| 3 | evolution-engine/src/judge.ts | 316 | ✅ |
| 4 | evolution-engine/src/applier.ts | 242 | ✅ |
| 5 | evolution-engine/src/monitor.ts | 320 | ✅ |
| 6 | evolution-engine/src/commands.ts | 443 | ⚠️ |
| 7 | evolution-engine/src/index.ts | 421 | ⚠️ |
| 8 | evolution-engine/src/widget.ts | 146 | ⚠️ |
| 9 | evolution-engine/index.ts | 1 | ✅ |
| 10 | evolution-engine/package.json | 8 | ✅ |

---

## Issue 1: Import 使用 @earendil-works/* 而非 @mariozechner/*

**Severity: MUST_FIX** — 违反 CLAUDE.md 导入规范

**CLAUDE.md 规定：**
> "扩展 import 统一使用 @mariozechner/*（两个 pi 都认识的公约数）"
> "错误 — 原版 pi 不支持 import { ExtensionAPI } from "@earendil-works/pi-coding-agent""

**受影响的文件：**

| 文件 | 行 | 错误代码 |
|------|-----|---------|
| `src/index.ts` | 18 | `import { Text } from "@earendil-works/pi-tui"` |
| `src/index.ts` | 20 | `import { StringEnum } from "@earendil-works/pi-ai"` |
| `src/widget.ts` | 8 | `import { Text } from "@earendil-works/pi-tui"` |

**修复方案：** 将上述三处 `@earendil-works/*` 替换为 `@mariozechner/*`。同时保持 `@mariozechner/pi-coding-agent`（index.ts 第 17 行已正确引用）。

**注意：** `@mariozechner/pi-tui` 和 `@mariozechner/pi-ai` 由 Pi runtime 注册别名，与 `@earendil-works/*` 指向同一实现，但为了兼容原版 pi，必须使用 `@mariozechner/*`。

---

## Issue 2: 错误作为成功消息返回而非 throw

**Severity: MUST_FIX** — 违反 CLAUDE.md Tool 设计规范

**CLAUDE.md 规定：**
> "错误用 throw new Error()，不要返回 { content: [{ text: "错误: ..." }] } 的错误成功模式"

**问题描述：** `src/commands.ts` 定义了一个 `errorResult()` 函数，将错误包装为 `CommandResult` 返回，而不是 `throw`。所有 4 个 handler（`handleEvolve`、`handleEvolveApply`、`handleEvolveStats`、`handleEvolveRollback`）均使用此模式。

```typescript
function errorResult(message: string): CommandResult {
    return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        details: { error: true, message },
    };
}
```

**受影响的调用点（共 14 处）：**

| 函数 | 行号 | 场景 |
|------|------|------|
| handleEvolve | 128 | analyzer 执行失败 |
| handleEvolve | 141 | 报告读取失败 |
| handleEvolve | 160 | LLM Judge 失败 |
| handleEvolve | 190 | 外层 catch |
| handleEvolveApply | 207 | 无 pending 建议 |
| handleEvolveApply | 270 | 外层 catch |
| handleEvolveStats | 372 | 统计读取失败 |
| handleEvolveRollback | 392 | 无历史记录 |
| handleEvolveRollback | 397 | 无效索引 |
| handleEvolveRollback | 405 | 无历史条目 |
| handleEvolveRollback | 409 | 非 apply 操作 |
| handleEvolveRollback | 438 | rollback 执行失败 |
| handleEvolveRollback | 441 | 外层 catch |

**修复方案：** 将 `errorResult()` 调用替换为 `throw new Error(...)`，移除 `errorResult` 函数。Tool `execute` 和 command `handler` 都不需要自己处理错误——Pi 框架会自动捕获 throw 并展示。

---

## Issue 3: 魔数 86_400_000 未定义命名常量

**Severity: LOW** — 违反 taste-lint `no-magic-numbers` 品味规则

**CLAUDE.md 规定：**
> "no-magic-numbers — 语义化命名（0/1/-1 豁免）"

**问题描述：** `monitor.ts` 已将 `MS_PER_DAY = 86_400_000` 定义为命名常量（第 13 行），但 `commands.ts` 中有 2 处使用了内联魔数：

| 位置 | 行 | 代码 |
|------|-----|------|
| `findRecentReport` | 54 | `const cutoff = Date.now() - sinceDays * 86_400_000;` |
| `handleEvolveStats` | 293 | `const cutoff = Date.now() - 7 * 86_400_000;` |

**修复方案：** 在 `commands.ts` 中定义 `const MS_PER_DAY = 86_400_000;`（或导入），替换两处内联数值。

---

## Issue 4: handleEvolveStats 函数超 80 行

**Severity: LOW** — 违反函数长度约束

**CLAUDE.md 规定：**
> "函数不超过 80 行"

| 文件 | 函数 | 行数 | 状态 |
|------|------|------|------|
| `src/commands.ts` | `handleEvolveStats` | **95 行** | ❌ 超限 |

**分析：** 该函数包含大量数据聚合逻辑（遍历 daily/ 目录、累加 tool calls / tokens、排序 top skills / top failures）。建议拆分为：
- `aggregateDailyData(dailyDir, cutoff)` — 返回聚合数据（减少局部变量数量）
- `computeTopSkills(skillCounts)` / `computeTopFailures(toolFailures)` — 排序逻辑独立

---

## Issue 5: evolutionEngineExtension 工厂函数超 80 行

**Severity: LOW** — 违反函数长度约束

| 文件 | 函数 | 行数 | 状态 |
|------|------|------|------|
| `src/index.ts` | `evolutionEngineExtension` | **322 行** | ❌ 超限 |

**分析：** 这是 Pi 扩展的标准工厂函数，需要注册 4 个 tool + 3 个 command + 1 个事件处理器。每个 tool 包含 execute/renderCall/renderResult 回调，加上 promptSnippet/parameters 等配置字段。工具注册模式本身会占据大量行数。

**建议：** 将每个 tool 的配置提取为独立函数/变量（如 `makeEvolveTool(dirs)`、`makeEvolveApplyTool(dirs)`），使工厂函数仅做注册调用。例如：

```typescript
pi.registerTool(createEvolveTool(dirs));
pi.registerTool(createEvolveApplyTool(dirs));
pi.registerTool(createEvolveStatsTool(dirs));
pi.registerTool(createEvolveRollbackTool(dirs));
```

**注意：** 如果提取到单独的文件（如 `tools.ts`），需注意目录职责划分。CLAUDE.md 的架构定义覆盖了 `commands.ts` 和 `widget.ts`，但未定义 tools 配置文件。建议在 `src/` 下新增 `tools.ts`，或者保持 `commands.ts` 只做 handler 逻辑，tool 注册配置留在 `index.ts` 但拆分为 `create*Tool` 函数。

---

## Issue 6: JSDoc 注释偏"是什么"而非"为什么"

**Severity: INFO** — 不符合注释习惯

**CLAUDE.md 规定：**
> "尽量对"为什么"进行注释，而不是对"是什么"进行注释"

**问题描述：** `types.ts` 中的字段 JSDoc 注释全是"是什么"类型（`/** UUID */`、`/** 0-1 置信度 */`）。虽然 type 定义天然需要"是什么"文档，但部分业务逻辑注释也可优化：

```typescript
// 当前（什么是不会做的）：
// 跳过文件头行

// 建议（为什么要跳）：
// 跳过 --- a/xxx +++ b/xxx 行，只解析 @@ ... @@ hunk
```

**典型可改进位置：**

| 文件 | 注释内容 | 建议 |
|------|---------|------|
| `applier.ts` | `// 跳过文件头行` | 说明为何只关心 hunk |
| `commands.ts` | `// 1. 查找近期报告` | 去掉编号，改为"先查缓存，没有则生成" |

---

## Issue 7: history.jsonl 无 GC 机制

**Severity: LOW** — 违反状态持久化约束

**CLAUDE.md 规定：**
> "自行实现 GC（splice 旧 entries），防止长 session 中 entries 无限积累"

`state.ts` 的 `appendHistory` 会持续追加行到 history.jsonl，没有清理旧数据的逻辑。虽然 `loadHistory` 通过 `limit` 参数只读取尾部 N 条，但文件本身会无限增长。在长周期使用后（数月），history.jsonl 可能积累大量无用的历史记录。

**建议：** 给 `state.ts` 添加 `gcHistory(dir, maxLines)` 函数，在每次 `appendHistory` 或 `loadHistory` 时触发检查——当文件超过阈值（如 5000 行）时，截断保留最近 N 条。

---

## Issue 8: typebox 参数未使用 StringEnum 枚举值

**Severity: LOW** — 偏离项目常用模式

**CLAUDE.md 规定：**
> "参数用 typebox Type.Object() + StringEnum() 定义 schema"

**问题描述：** 项目中其他扩展（如 `/goal`）在定义 tool 参数时使用 `StringEnum` 配合枚举，但 `commands.ts` 内部使用了内联 `"all" | "claude-md" | "skills"` 联合类型。虽然这不是严格违规（index.ts 中的 tool parameters 正确使用了 `StringEnum`），但存在类型双重定义维护风险：

```typescript
// index.ts — ✅ 使用了 StringEnum
const EvolveParams = Type.Object({
    target: StringEnum(["all", "claude-md", "skills"], {...}),
});

// commands.ts — ⚠️ 重复定义了同样的联合类型
params.target as "all" | "claude-md" | "skills"
```

**建议：** 从 `types.ts` 的 `EvolveCommandParams` 类型导出 `"all" | "claude-md" | "skills"` 作为命名类型别名，单点定义。或使用 TypeScript `satisfies` 验证一致性。

---

## 通过项（符合规范）

| 检查维度 | 结果 |
|---------|------|
| `any` 类型 | ✅ 零使用。所有位置均使用 `unknown`、`Record<string, unknown>` 或具体类型 |
| child_process 声明 | ✅ 在 `judge.ts`（spawn）和 `applier.ts`/`commands.ts`（execSync）中使用了 child_process，属于已知例外（evolution-engine for LLM Judge + git 操作） |
| 单文件 ≤ 1000 行 | ✅ 最长的 `commands.ts` 为 443 行 |
| Vue 行数上限 | ✅ 不涉及（无 .vue 文件） |
| 硬编码 ANSI 颜色 | ✅ 全部使用 `theme.fg("token", ...)` 语义 token |
| TUI renderCall/renderResult | ✅ 统一 `new Text(string, 0, 0)` |
| Tool execute 返回结构 | ✅ `{ content: [...], details: {...} }` 格式 |
| Details 作为渲染数据源 | ✅ renderResult 使用 result.details |
| `errorResult` 非 throw 以外* | ✅ `applier.ts` 正确抛出异常 |
| 模块级 `let` 变量 | ✅ 无共享可变状态 |
| import 顺序 | ✅ Node 内置 → npm → 项目内部 |
| `(entry as any).customType` 模式 | ✅ 未出现 |
| node_modules | ✅ 无依赖，package.json 无 dependencies |
| ESM import 扩展名 | ✅ 全部使用 `.js` 后缀 |

---

## 统计汇总

| Metric | Count |
|--------|-------|
| 审查文件数 | 10 |
| 发现问题数 | 8 |
| MUST_FIX | 3 |
| LOW | 4 |
| INFO | 1 |
| **Verdict** | **fail** |

## 批次修复建议

### 第一批：MUST_FIX（阻塞合入）

1. **`src/index.ts` + `src/widget.ts`** — 修复 import scope（`@earendil-works/*` → `@mariozechner/*`）。3 处改动，零风险。
2. **`src/commands.ts`** — `errorResult()` 替换为 `throw new Error()`。涉及 14 处调用点和 `errorResult` 函数定义。需要同步修改 `successResult` 使用方式。

### 第二批：LOW（建议合入前修复）

3. **`src/commands.ts`** — 定义 `MS_PER_DAY` 常量替换魔数（2 处）
4. **`src/commands.ts`** — 拆分 `handleEvolveStats`（95 行 → ≤80 行）
5. **`src/index.ts`** — 拆分 `evolutionEngineExtension` 工厂函数（322 行）
6. **`src/state.ts`** — 添加 history.jsonl GC
7. **`src/types.ts`** — 为 target 联合类型定义命名别名

### 第三批：INFO（后续优化）

8. **通用** — 优化 "为什么" 注释质量
