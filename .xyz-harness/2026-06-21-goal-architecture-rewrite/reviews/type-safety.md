---
verdict: pass
must_fix: 0
---

# 类型安全审查报告

## Summary
0 个必须修复的问题，3 个建议，4 个提示。`tsc --noEmit`（基于生产环境 `tsconfig.json`，该文件排除了 `__tests__/`）**通过，无错误**。66 个变更文件中新增 TS 代码全部带有完整类型标注，无任何 `any`（`: any` / `as any` / `<any>` / `Record<string, any>`），无隐式 `any`，无 TS7006 错误。引擎层零 Pi 依赖已通过 `import` 链验证（engine/ 仅 `import type` 自 ./types, ./task）。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| SUGGESTION | extensions/goal/src/persistence.ts | 39-93 | unsafe-cast | `deserializeState` 内部 `<T>` 泛型辅助 + 多处 `as T`（`as number`/`as string`/`as TaskStatus`/`as GoalTask`）从 `unknown` 直接断言。虽有 "Missing required field" 守卫保证存在性，但**值类型未校验**（如 `tokensUsed` 可能是 string，`status` 可能是非枚举字符串）。FR-5 已声明"字段缺失即抛错"，但未声明"类型错误即抛错"。 | 对 status 等枚举字段加 `TASK_STATUSES.includes(...)` 运行时类型守卫；或对数值字段加 `typeof x === "number"` 校验。当前行为兼容运行时，属低风险但非"类型安全"。 |
| SUGGESTION | extensions/goal/src/projection/widget.ts | 267-269 | unsafe-cast | `asTheme(uiPort): ThemeLike { return uiPort as unknown as ThemeLike; }` 是 `as unknown as X` 链式断言。注释说明：adapter 层构造的 UiPort 实现满足 UiPort & ThemeLike 形状，运行时安全。坏味道来源：UiPort 接口未声明 fg/bold（D-22 故意），靠运行时多挂字段 + 双重断言打通。 | 可让 adapter 层显式导出一个 `UiPortWithTheme = UiPort & ThemeLike` 类型，`buildPorts` 返回此类型，`asTheme` 改为单步 `as`。当前实现可工作，但 `as unknown as` 绕过了编译器校验。 |
| SUGGESTION | extensions/goal/src/service.ts | 236, 247, 359, 395, 415, 436, 441, 465, 467, 503, 537, 539 | unsafe-cast | `applyToolAction` 内部对 `params.tasks as string[]`、`params.verifications as TaskVerification[]` 等 13 处从 `Record<string, unknown>` 子字段直接断言目标类型，无运行时校验。注释（actions.ts:24-33）说明：用 `Record<string, unknown>` 打破 `actions.ts ↔ tool-adapter.ts` 循环依赖。安全性依赖上游 `tool-adapter.executeGoalAction` 的 `params: Static<typeof GoalManagerParams>` 已通过 schema 校验——但 `applyToolAction` 是 `export` 函数，外部其他模块可直接调它绕过 schema。 | 将 `applyToolAction` 改为非导出（internal），或加 `params: GoalToolParams & Partial<Static<typeof GoalManagerParams>>` 联合签名。当前实际调用路径安全（schema 已校验），仅理论风险。 |
| INFO | extensions/goal/src/adapters/tool-adapter.ts | 148 | unsafe-cast | `ctx.ui.theme.fg(color as never, text)` —— `color as never` 把 `string` 断言为 `ThemeColor`。注释说明 ThemeColor 是 string 子集，运行时安全。 | 可替换为 `themeColors.includes(color) ? color : "text"` 守卫。单步 `as never` 比 `as unknown as X` 轻微，属常见 theme bridge 模式。 |
| INFO | extensions/goal/src/index.ts | 309 | unsafe-cast | `const api = pi as unknown as Record<string, unknown>` 用于挂载 `api.__goalInit`。Pi 的 ExtensionAPI 未声明扩展挂载点，跨扩展通信只能如此。 | 无法避免，属 Pi 框架限制。可加 `__goalInit` 到 ExtensionAPI ambient 声明消除断言，但跨包污染类型，取舍后保留现状合理。 |
| INFO | extensions/goal/src/session.ts | 75, 107 | unsafe-cast | L75 `entries[...]!.data as Record<string, unknown> | undefined`（SessionEntryLike.data 是 `unknown`，断言为 Record 后传给 `deserializeState`）。L107 `(entries[i] as { customType?: string }).customType` 用于 history entry 识别。L107 可用已有的 `SessionEntryLike` 类型直接读 `entry.customType`（该类型已声明 `customType?: string`），不必 inline cast。 | L107 改为 `entries[i]!.customType === HISTORY_ENTRY_TYPE`（SessionEntryLike 已有此字段）。L75 的断言与 persistence 协同，可接受。 |
| INFO | extensions/goal/src/service.ts | 150-154 | unsafe-cast | `toDescriptions` 通过 `typeof first === "string"` 类型守卫后，`tasks as string[]` 和 `tasks as GoalTask[]` 仍是断言而非 narrowing。 | 改为：`if (typeof first === "string") return tasks as unknown as string[];` 或用 `Array.isArray` + 泛型重载签名。当前 `typeof first` 判定后 TypeScript 不能自动 narrow 整个数组类型，断言是合理选择。 |

## `tsc` 结果
- 命令：`cd <repo-root> && npx tsc --noEmit`（生产环境 `tsconfig.json`，包含 `extensions/**/*.ts`，排除 `__tests__/`）
- 结果：**0 errors, exit 0**（无任何输出）
- 严格模式：`strict: true` 已启用（含 noImplicitAny, strictNullChecks 等）

## 关键正面发现
1. **零 `any`**：生产代码全量搜索 `: any|as any|<any>|Record<string, any>|any[]` **无任何匹配**。
2. **engine 层隔离**：`engine/types.ts`、`engine/task.ts`、`engine/budget.ts`、`engine/goal.ts` 仅 `import type` 自内部，零 Pi 依赖。
3. **Like*Event 防御性类型**（`index.ts:46-91`）：为 Pi 回调签名定义本地接口，避免 `any`。
4. **GoalInitFn 单一签名源**（`index.ts:351-356`）：跨扩展 API 类型导出供消费者 import。
5. **EventEffect discriminated union**（`service.ts:50-55`）：5 种 effect 用 `kind` 字面量联合。
6. **ProgressCheck / BudgetCheckResult**（`engine/budget.ts:42-56`）：结果对象完整类型化。
