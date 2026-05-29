---
verdict: "FAIL"
must_fix:
  - "import scope: recall-tool.ts 和 index.ts 使用 @earendil-works/* 而非 @mariozechner/*"
  - "函数长度: index.ts 中 infiniteContextExtension 函数超过 80 行限制"
review_metrics:
  files_checked: 7
  violations_total: 4
  violations_critical: 2
  violations_minor: 2
  lines_of_code_reviewed: 1933
  checks:
    no_any_type: PASS
    import_order: PASS
    import_scope: FAIL
    max_file_lines_1000: PASS
    max_function_lines_80: FAIL
    naming_convention: PASS
    no_promise_all: PASS
    no_silent_catch: PASS
    no_unbounded_while_true: PASS
---

# 规范审查报告 — infinite-context 引擎

> 审查日期: 2026-05-29
> 审查类型: Phase B — AI 规范对比（跳过 Phase A ESLint）
> 审查文件数: 7 个源文件（1933 行 TS）

---

## 1. `any` 类型（禁止）

**结果: ✅ PASS**

所有 7 个文件均未出现显式 `any` 类型。`unknown` 和具名类型使用正确：

- `extractUserText(message: unknown)` — 使用 `unknown`，函数体内用 `Record<string, unknown>` 断言
- `extractToolCalls(toolResults: unknown[])` — 同上
- `(entry as CustomEntry).customType` — 虽然是断言模式，但属于**具名类型断言**而非 `any`，CLAUDE.md 禁止的是 `(entry as any).customType`

**结论**: 类型安全达标。

---

## 2. import 顺序（Node 内置 → npm 包 → 项目内部）

**结果: ✅ PASS**

各文件 import 顺序如下：

| 文件 | 顺序 | 判定 |
|------|------|------|
| `types.ts` | 无 import | N/A |
| `segment-tracker.ts` | npm (`@mariozechner/*`) → 内部 (`./types`) | ✅ |
| `tree-compactor.ts` | Node (`node:child_process`) → npm → 内部 | ✅ |
| `context-handler.ts` | 内部 (`./types`, `./token-estimator`) | ✅ |
| `recall-tool.ts` | Node (`node:fs`, `node:path`) → npm → 内部 | ✅ |
| `commands.ts` | npm → 内部 | ✅ |
| `index.ts` | npm → 内部 | ✅ |

**结论**: 分组顺序完全符合规范。

---

## 3. import scope（模块导入规范）

**结果: ❌ FAIL — 关键违规**

CLAUDE.md 明确要求：

> 扩展 import 统一使用 `@mariozechner/*`（两个 pi 都认识的公约数）

以下文件使用了 `@earendil-works/*` scope：

### recall-tool.ts（第 6-7 行）
```typescript
import { Text } from "@earendil-works/pi-tui";          // ❌ 应为 @mariozechner/pi-tui
import { StringEnum } from "@earendil-works/pi-ai";     // ❌ 应为 @mariozechner/pi-ai
```

### index.ts（第 16 行）
```typescript
import { Text } from "@earendil-works/pi-tui";          // ❌ 应为 @mariozechner/pi-tui
```

**严重程度**: **高** — 如果部署在原版 pi 上，这些 import 会导致运行时加载失败。虽然是"两个 scope 指向同一实现"，但规范明确要求用 `@mariozechner/*` 保证兼容性。

**修复建议**: 将所有 `@earendil-works/*` 替换为 `@mariozechner/*`：
- `@earendil-works/pi-tui` → `@mariozechner/pi-tui`
- `@earendil-works/pi-ai` → `@mariozechner/pi-ai`

---

## 4. 文件行数（不超过 1000 行）

**结果: ✅ PASS**

| 文件 | 实际行数 | 上限 | 判定 |
|------|---------|------|------|
| `types.ts` | 82 | 1000 | ✅ |
| `segment-tracker.ts` | 261 | 1000 | ✅ |
| `tree-compactor.ts` | 578 | 1000 | ✅ |
| `context-handler.ts` | 359 | 1000 | ✅ |
| `recall-tool.ts` | 310 | 1000 | ✅ |
| `commands.ts` | 160 | 1000 | ✅ |
| `index.ts` | 169 | 1000 | ✅ |
| `token-estimator.ts` | 14 | 1000 | ✅ |

**结论**: 全部合规，最长的 `tree-compactor.ts`（578 行）也在安全范围内。

---

## 5. 函数行数（不超过 80 行）

**结果: ❌ FAIL**

CLAUDE.md "行数"章节（非 taste-lint 的 `max-lines-per-function: 300`）要求函数不超过 **80 行**。

### 违规: `index.ts` — `infiniteContextExtension`（约 95 行）

```typescript
export default function infiniteContextExtension(pi: ExtensionAPI): void {
```

该函数从文件第 ~74 行开始到第 ~169 行结束，约 95 行，超出 80 行限制 15 行。

原因：该工厂函数内联注册了 4 个事件处理器（`session_start`, `turn_end`, `context`, `session_before_compact`）、2 个命令、1 个工具和 2 个消息渲染器。虽然职责单一（注册），但代码行数超限。

**严重程度**: **中** — 不影响运行时正确性，但违反编码规范的篇幅限制。

**修复建议**: 
- 将 `pi.on()` 事件处理器的回调提取为命名函数（如 `onSessionStart`, `onTurnEnd`, `onContext`），放在工厂函数外部
- 这将把 `infiniteContextExtension` 降回 20-30 行左右

```typescript
function onSessionStart(_event: unknown, ctx: ExtensionContext, tracker: SegmentTracker, compactor: TreeCompactor): void {
  const entries = ctx.sessionManager.getEntries();
  tracker.restoreState(entries);
  compactor.restoreState(entries);
}

export default function infiniteContextExtension(pi: ExtensionAPI): void {
  const tracker = new SegmentTracker();
  const compactor = new TreeCompactor();
  // ...
  pi.on("session_start", (event, ctx) => onSessionStart(event, ctx, tracker, compactor));
  // ...
}
```

---

## 6. 命名规范

**结果: ✅ PASS**

| 检查项 | 规范要求 | 实际 | 判定 |
|--------|---------|------|------|
| 扩展入口 | `xxxExtension(pi)` | `infiniteContextExtension(pi)` | ✅ |
| 工具参数 | `XxxParams` | `RecallParams` | ✅ |
| 工具详情 | `XxxDetails` | `RecallDetails` | ✅ |

未找到违反命名规范的代码。无 `XxxRuntimeState` 类型（无限上下文扩展使用 `SegmentTracker`/`TreeCompactor` 类替代状态接口，这是合法的设计选择，不违反规范）。

---

## 7. `Promise.all` vs `Promise.allSettled`

**结果: ✅ PASS**

对 7 个源文件进行全局搜索，未发现 `Promise.all` 的使用。所有异步操作均使用 `Promise.allSettled` 或单独 await。

---

## 8. 静默 catch（`no-silent-catch`）

**结果: ✅ PASS**

### 审查记录

`recall-tool.ts` 第 111 行：

```typescript
try {
  const raw = readFileSync(segPath, "utf-8");
  return raw;
} catch {
  return undefined;
}
```

`catch` 块执行了 `return undefined`，有实际返回行为（非空实现），不属于 `no-silent-catch` 规则禁止的"空 catch 或只有 console"。此模式是"optional file read"的惯用写法，行为是可预期的。但仍建议加注释说明异常场景。

**认定**: 合规。规则禁止的是 `catch {}` 或 `catch { console.log(e) }`，此处有显式行为逻辑。

---

## 9. `while(true)` 无迭代上限

**结果: ✅ PASS**

`commands.ts` 中的等待循环：

```typescript
while (compactor.isCompressing() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
```

此循环有明确的条件终止（`Date.now() < deadline` 上限 35 秒），不属于 `no-unbounded-while-true` 违规。

---

## 10. 其他发现

### 10.1 `catch {}` 用于 `readSegmentFile` 之间接性

虽已判定合规，但 `readSegmentFile` 的 silent catch 阻塞了错误传播（文件读取失败默默的进 undefined）。建议至少加内联注释说明预期失败场景：

```typescript
} catch {
  // seg_N.json 可能尚未写入，非异常场景
  return undefined;
}
```

### 10.2 `token-estimator.ts` 单函数文件

14 行，仅导出 `estimateTokens` 函数，可考虑内联到 `context-handler.ts`，但独立文件更清晰。不违规，仅风格建议。

---

## 汇总

| 检查项 | 判定 | 违规数 |
|--------|------|--------|
| 禁止 `any` | ✅ PASS | 0 |
| import 顺序 | ✅ PASS | 0 |
| **import scope (`@mariozechner/*`)** | ❌ **FAIL** | **3 处** |
| 文件 ≤ 1000 行 | ✅ PASS | 0 |
| **函数 ≤ 80 行** | ❌ **FAIL** | **1 处** |
| 命名规范 | ✅ PASS | 0 |
| 无 `Promise.all` | ✅ PASS | 0 |
| 无静默 catch | ✅ PASS | 0 |
| 无无上限 `while(true)` | ✅ PASS | 0 |

### 必须修复项（must_fix）

1. **P0 — import scope 错误**: `recall-tool.ts`（2 处）和 `index.ts`（1 处）使用 `@earendil-works/*` 而非 `@mariozechner/*`。违反模块导入规范，在原版 pi 上可能加载失败。
2. **P1 — 函数超长**: `index.ts` 中 `infiniteContextExtension` 函数约 95 行，超出 80 行限制。建议提取事件处理回调函数。

### 建议修复项（nice_to_have）

3. `readSegmentFile()` 的 `catch` 块添加注释说明预期行为（非必要，合规）

---

*报告完毕* | Phase B AI 规范对比 | 审查工具: MANUAL REVIEW
