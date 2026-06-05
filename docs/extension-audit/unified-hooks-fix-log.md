# unified-hooks 修复日志

**修复日期**: 2025-07-14
**修复人**: 代码修复工程师（自动化）
**审查报告**: `docs/extension-audit/unified-hooks.md`

---

## 修复概览

| 优先级 | 问题数 | 已修复 | 跳过 | 不适用 |
|--------|--------|--------|------|--------|
| P0     | 0      | 0      | 0    | 0      |
| P1     | 1 (3 处) | 1 (3 处) | 0 | 0    |
| P2     | 3      | 0      | 3    | 0      |

> **P0 无问题，P1 全部修复，P2 按要求跳过。**

---

## 详细修复记录

### ✅ P1-1：事件处理器参数使用 `any` 类型

**修复状态**: 全部修复（3/3 处）

**修改文件**:
1. `extensions/unified-hooks/src/hooks/tool-error-handler.ts`
2. `extensions/unified-hooks/src/hooks/test-timeout-guard.ts`
3. `extensions/unified-hooks/src/hooks/network-timeout-guard.ts`

**修复方案**:

审查报告提供了两种方案：
- **Plan A**: 定义具体的事件类型接口
- **Plan B**: 使用 `unknown` + 类型断言

我**采用了 Plan A 与 Plan B 的组合**：在每个 hook 文件中定义一个只包含本 hook 实际使用字段的本地接口（如 `ToolExecutionEndLikeEvent`、`BashToolCallLikeEvent`），并把 `event: any` 改为 `event: unknown`，随后用单次 `as` 断言收敛到本地接口。

```typescript
// 修改前（举例：tool-error-handler.ts）
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi event types are typed as `any` in CI stubs
pi.on("tool_execution_end", async (event: any) => {
  if (!event.isError) return;
  console.log(`[unified-hooks] ${event.toolName} error (callId=${event.toolCallId})`);
});

// 修改后
interface ToolExecutionEndLikeEvent {
  isError: boolean;
  toolName: string;
  toolCallId: string;
}

pi.on("tool_execution_end", async (event: unknown) => {
  const e = event as ToolExecutionEndLikeEvent;
  if (!e.isError) return;
  console.log(`[unified-hooks] ${e.toolName} error (callId=${e.toolCallId})`);
});
```

**为什么不用 SDK 导出的具体类型（如 `BashToolCallEvent`、`ToolExecutionEndEvent`）**？

我最初尝试直接 import SDK 类型，但 `npx tsc --noEmit` 在本仓库配置下报错：
```
error TS2724: '"@mariozechner/pi-coding-agent"' has no exported member named 'BashToolCallEvent'.
error TS2305: Module '"@mariozechner/pi-coding-agent"' has no exported member 'ToolExecutionEndEvent'.
```

**根因**: 本仓库的 `tsconfig.json` 用 `paths` 把 `@mariozechner/pi-coding-agent` 映射到本地 CI 类型存根 `shared/types/mariozechner/index.d.ts`。该存根通过 `declare module` 重新声明了 `@mariozechner/pi-coding-agent`，**只导出** 审查工具需要的一组固定名称（`ExtensionAPI`、`ToolCallEvent = any`、`ToolResultEvent = any` 等）。`BashToolCallEvent` / `ToolExecutionEndEvent` 这类细化类型没有被声明，于是 CI 走存根的 typecheck 看不到。

> 同模式的报错在 `extensions/claude-rules-loader/index.ts`（`BeforeAgentStartEvent`、`BeforeAgentStartEventResult`）已经长期存在 —— 这是项目**已知的预存问题**，与本扩展无关。

**为什么用本地接口而不是 `unknown` 配合内联 cast**：
- 本地接口命名清晰（`BashToolCallLikeEvent`、`ToolExecutionEndLikeEvent`），并在 JSDoc 注释里说明与 SDK 真实类型（`BashToolCallEvent` / `ToolExecutionEndEvent`）的对应关系，便于将来 SDK 暴露后无缝切换。
- `unknown` → 本地接口的单一断言比内联 `as { toolName: string; input: { command: string; ... } }` 读起来更明确，类型守卫边界也更显眼。
- 与审查报告 Plan A 的示例一致；同时吸收了 Plan B 推荐的 `unknown` 入口。

**为什么不动 `shared/types/mariozechner/index.d.ts`**：
- 那是**整个 monorepo 共用的** CI 类型存根，添加 `BashToolCallEvent` / `ToolExecutionEndEvent` 会扩大 monorepo 范围的影响面，超出"保持最小变更、不重构不相关代码"的原则。
- 这属于 P2 范畴的依赖/类型基础设施问题，应在单独 PR 中由架构层面统一处理。

**对运行时行为的影响**:
- 三个 hook 的运行时逻辑（早返回条件、命令检测、block 决策）**完全等价**。
- 类型断言从 `event: any`（绕过所有检查）变为 `event: unknown → 本地接口`（显式声明期望形状），对实际传给 handler 的运行时对象没有新约束。
- 删除了三处 `// eslint-disable-next-line @typescript-eslint/no-explicit-any` 注释（`no-explicit-any` 规则已不再被触发）。

---

## 跳过的 P2 问题

按任务说明 "P2 问题不修复"，以下三项保留原样并跳过：

| 编号 | 问题 | 文件 | 跳过原因 |
|------|------|------|----------|
| P2-1 | `typebox` 在 `peerDependencies` 中声明但未使用 | `package.json` | 任务要求不修复 P2 |
| P2-2 | `README.md` 与 `CLAUDE.md` 引用已删除的 `edit-whitespace-autofix` | `README.md`、`CLAUDE.md` | 任务要求不修复 P2 |
| P2-3 | `package.json` 的 `files` 字段可更精确 | `package.json` | 任务要求不修复 P2；当前不会导致问题 |

---

## 验证

### TypeScript 类型检查

```bash
$ npx tsc --noEmit 2>&1 | grep -i unified-hooks
（无输出 = 无错误）
```

修复前后，`extensions/unified-hooks/` 下的 typecheck 错误数均为 **0**。仓库总错误数 36 条全部为预存问题（`claude-rules-loader`、`statusline`、`todo` 等其他扩展），与本修复无关。

### ESLint

```bash
$ npx eslint extensions/unified-hooks/
（无输出 = 0 警告 0 错误）
```

`@typescript-eslint/no-explicit-any`（warn 级）在三个文件中不再触发。

### 单元测试

`extensions/unified-hooks/` 下不存在测试文件，因此无测试可跑。

### 代码行数变化

| 文件 | 修改前 | 修改后 | 增量 |
|------|--------|--------|------|
| `src/hooks/tool-error-handler.ts` | 15 | 25 | +10 |
| `src/hooks/test-timeout-guard.ts` | 98 | 107 | +9 |
| `src/hooks/network-timeout-guard.ts` | 64 | 73 | +9 |

> 增量全部来自本地接口声明和 JSDoc 注释，无逻辑变更。

---

## 总结

- **P0**: 0 个问题 → 无需修复。
- **P1**: 1 个问题（涉及 3 处 `event: any`）→ 全部修复，采用"本地接口 + `unknown` 入口"模式。
- **P2**: 3 个问题 → 按任务要求跳过。
- **代码逻辑**: 完全保持原状，所有改动仅涉及类型层。
- **验证**: `tsc --noEmit` 与 `eslint` 在 `extensions/unified-hooks/` 下均通过。
