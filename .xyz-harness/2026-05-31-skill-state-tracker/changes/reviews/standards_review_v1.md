---
verdict: fail
must_fix: 5
typecheck_passed: false
review_metrics:
  files_reviewed: 4
  issues_found: 7
  must_fix_count: 5
  low_count: 1
  info_count: 1
  duration_estimate: "5"
---

# Standards Review v1

## 审查记录
- 审查时间：2026-05-31 16:00
- 项目路径：/Users/zhushanwen/Code/xyz-pi-extensions-workspace/main
- Phase A（自动检查）：已执行
- Phase B（AI 规范对比）：已执行

## Phase A: 自动化检查结果

### Lint

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx eslint "skill-state/src/**/*.ts" "skill-state/index.ts"` |
| 退出码 | 0 |
| Errors | 0 |
| Warnings | 0 |
| 状态 | ✅ 通过 |

**注意**：项目 `package.json` 的 `scripts.lint` 未包含 `skill-state/` 路径（只覆盖 goal/todo/subagent/workflow/context-engineering）。ESLint 是手动指定路径运行的。

### Typecheck

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx tsc --noEmit --project /tmp/tsconfig-skill-state.json` |
| 退出码 | 2 |
| Errors | 10 |
| 状态 | ❌ 未通过 |

**注意**：项目 `tsconfig.json` 的 `include` 未包含 `skill-state/**/*.ts`，导致 `npm run typecheck` 不会检查 skill-state。需使用独立 tsconfig 运行。

**10 个类型错误详情：**

```
skill-state/src/index.ts(52,22):  TS2339: 'appendEntry' does not exist on 'ReadonlySessionManager'
skill-state/src/index.ts(59,15):  TS2339: 'customType' does not exist on 'SessionEntry'
skill-state/src/index.ts(80,20):  TS2339: 'customType' does not exist on 'SessionEntry'
skill-state/src/index.ts(81,31):  TS2339: 'data' does not exist on 'SessionEntry'
skill-state/src/index.ts(93,15):  TS2339: 'customType' does not exist on 'SessionEntry'
skill-state/src/index.ts(231,9):  TS2769: 'tool_call' overload mismatch
skill-state/src/index.ts(268,9):  TS2769: 'turn_end' overload mismatch
skill-state/src/index.ts(317,44): TS2345: MessageRenderer parameter type mismatch
skill-state/src/index.ts(353,27): TS2345: AgentToolResult details type mismatch
```

## Phase B: CLAUDE.md 规范对比

### 规范检查矩阵

| # | 规范条目 | 适用范围 | 检查结果 | 违规位置 |
|---|---------|---------|---------|---------|
| 1 | 禁止 any 类型 | TypeScript 文件 | ✅ 符合 | — |
| 2 | (entry as any).customType 模式禁止，用类型守卫 | 全部 TS | ❌ 不符合 | index.ts:L59,L80,L81,L93 |
| 3 | 状态持久化用 pi.appendEntry() 写入 | 扩展 | ❌ 不符合 | index.ts:L52 |
| 4 | 错误用 throw new Error()，不用错误成功模式 | 扩展 | ✅ 符合 | — |
| 5 | TUI 渲染用 theme.fg() 语义 token | 扩展 | ✅ 符合 | — |
| 6 | 工具参数用 typebox + StringEnum | 扩展 | ✅ 符合 | — |
| 7 | deserializeState 向后兼容 | 扩展 | ✅ 符合 | — |
| 8 | 命名：XxxRuntimeState / XxxParams / XxxDetails | 扩展 | ✅ 符合 | — |
| 9 | 文件不超过 1000 行，函数不超过 80 行 | 全部 TS | ❌ 不符合 | index.ts:L210-L356 |
| 10 | Session 隔离：闭包或 session_start 重建 | 扩展 | ✅ 符合 | — |
| 11 | import 顺序：Node → npm → 项目内部 | 全部 TS | ✅ 符合 | — |
| 12 | 模块级 let 多 session 共享风险 | 扩展 | ➖ 不适用 | index.ts 闭包内，OK |
| 13 | 自行实现 GC（splice 旧 entries） | 扩展 | ✅ 符合 | — |
| 14 | 架构：index.ts 胶水，state.ts 数据，templates.ts 模板 | 扩展 | ✅ 符合 | — |

## 问题清单

| # | 严重度 | Phase | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-------|------|------|------|---------|
| 1 | MUST_FIX | A+B | `ctx.sessionManager.appendEntry` 不存在，ReadonlySessionManager 无此方法 | index.ts | L52 | 改为 `pi.appendEntry(ENTRY_TYPE, serializeState(state))`，参考 goal 扩展 |
| 2 | MUST_FIX | A+B | SessionEntry 联合类型直接访问 `.customType` / `.data`，无类型守卫 | index.ts | L59,L80,L81,L93 | 添加 `isCustomEntry` 类型守卫：`entry.type === "custom" && (entry as CustomEntry).customType === ENTRY_TYPE`，参考 goal/src/index.ts:L132 |
| 3 | MUST_FIX | A | `pi.on("tool_call")` handler 参数类型 `Record<string, unknown>` 与 overload 不匹配 | index.ts | L231 | 使用 `ToolCallEvent` 类型或删除显式注解让 TS 推断 |
| 4 | MUST_FIX | A | `pi.on("turn_end")` handler 参数类型不匹配 | index.ts | L268 | 使用 `TurnEndEvent` 类型或删除显式注解让 TS 推断 |
| 5 | MUST_FIX | A | `registerMessageRenderer` 回调参数类型 `Record<string, unknown>` 与 `CustomMessage<unknown>` 不兼容 | index.ts | L317 | 参数类型改为 `CustomMessage<unknown>` 或从 Pi 类型导入 |
| 6 | LOW | A | `execute` 返回值 `details` 类型 `SkillStateDetails` 与 `AgentToolResult<unknown>.details` (unknown) 不兼容 | index.ts | L353 | 添加类型断言或调整 tool 注册时的泛型参数 |
| 7 | LOW | B | 工厂函数 `skillStateExtension` 约 146 行，超过 80 行上限 | index.ts | L210-356 | 将事件处理器提取为命名函数（如 `handleToolCall`、`handleTurnEnd`），工厂函数只做注册胶水 |
| 8 | INFO | A | skill-state 不在 tsconfig.json include 和 lint scripts 中，`npm run typecheck` / `npm run lint` 不会检查它 | tsconfig.json, package.json | — | 将 `"skill-state/**/*.ts"` 加入 tsconfig include，将 `"skill-state/src/**/*.ts"` 加入 lint script |

## 结论

❌ 需修改。5 条 MUST_FIX：

1. **API 调用错误**（#1）：`ctx.sessionManager.appendEntry` 运行时必然崩溃（方法不存在），必须改为 `pi.appendEntry()`。这是最严重的问题。
2. **类型不安全**（#2）：在 `SessionEntry` 联合类型上直接访问 `customType`/`data`，CLAUDE.md 明确禁止此模式。
3. **事件 handler 类型**（#3, #4）：使用 `Record<string, unknown>` 代替具体事件类型，导致 overload resolution 失败。
4. **MessageRenderer 类型**（#5）：参数类型不匹配 Pi 定义的 `CustomMessage<unknown>`。

建议修复顺序：#1 → #2 → #3/#4 → #5 → #6 → #7 → #8。#1 和 #2 是运行时崩溃级问题。
