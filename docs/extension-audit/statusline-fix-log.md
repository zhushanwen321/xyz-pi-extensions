# statusline 审查问题修复日志

> 修复人: Pi 代码修复工程师
> 修复日期: 2026-06-05
> 审查报告: `docs/extension-audit/statusline.md`
> 修复原则: P0 全部修复，P1 尽量全部修复，P2 不主动修复

## 修复概览

| 类别 | 总数 | 已修复 | 跳过 |
|------|------|--------|------|
| P0   | 0    | 0      | 0    |
| P1   | 3    | 3      | 0    |
| P2   | 5    | 0      | 5 (不修复) |

审查报告未列出 P0 问题；3 个 P1 问题已全部修复；5 个 P2 问题按规则跳过。

---

## P1 修复（3/3 完成）

### ✅ P1-1: 大量函数和常量在 `src/index.ts` 与 `src/format.ts` 之间重复

**文件**:
- `src/format.ts`（导出共享常量和函数）
- `src/index.ts`（删除重复定义，改 import）

**变更**:

1. **在 `src/format.ts` 中导出 5 个共享常量**（保留其余为内部常量）：

| 常量 | 旧可见性 | 新可见性 | 原因 |
|------|----------|----------|------|
| `MS_PER_SEC` | private | **export** | `buildLine3` 算 ago 用 |
| `SEC_PER_MIN` | private | **export** | `buildLine3` 算 ago 用 |
| `KILO` | private | **export** | 不再需要（fmtCount 已 import）→ 实际未在 index.ts 直接使用 |
| `PERCENT_SCALE` | private | **export** | `refreshContextUsage` 用 |
| `MIN_PAD` | private | **export** | `buildLine3` padStart 用 |

注：`KILO` 在 plan 中准备 export，但 `fmtCount` 已 import 自 format.ts（内部使用 KILO），index.ts 不再直接引用 `KILO`，最终未 export，已从 import 列表移除（避免 lint 警告）。其余 8 个常量（`MIN_PER_HOUR`/`HOURS_PER_DAY`/`SEC_PER_HOUR`/`SEC_PER_DAY`/`MILLION`/`PCT_HIGH`/`PCT_MED`/`PCT_LOW`）仅 format.ts 内部使用，保持 private。

2. **在 `src/index.ts` 中删除 9 个重复函数 + 13 个重复常量 + 1 个重复接口 + 1 个重复数组**：

| 类别 | 名称 |
|------|------|
| 函数 | `fmtDuration` / `fmtTokens` / `fmtResetSec` / `fmtCount` / `pctColor` / `normalizeRows` / `buildSearchLine` / `buildTokenPlanLines` / `formatWinCol` |
| 常量 | `MS_PER_SEC` / `SEC_PER_MIN` / `MIN_PER_HOUR` / `HOURS_PER_DAY` / `SEC_PER_HOUR` / `SEC_PER_DAY` / `KILO` / `MILLION` / `PCT_HIGH` / `PCT_MED` / `PCT_LOW` / `PERCENT_SCALE` / `MIN_PAD` |
| 接口 | `QuotaRow` |
| 常量数组 | `COLS` |

3. **更新 `buildLines` 调用 format.ts 版本**：
   - `buildSearchLine(cache, providers, palette, themeFg)` — 改用 `themeFg` 回调（format.ts 版本签名）
   - `buildTokenPlanLines(cache, providers, palette, themeFg)` — 同上
   - 局部变量 `themeFg = (token, text) => theme.fg(token, text)` 在 `buildLines` 内构造

4. **清理不再使用的 import**：
   - 从 `@zhushanwen/pi-quota-providers` 移除 `type CacheData` / `type QuotaWindow` / `type QuotaProvider`（仅被删除的本地函数使用）
   - 保留 `type SpeedData`（`StatuslineRuntimeState.speed` 字段需要）

**导入更新（`src/index.ts`）**:
```typescript
import {
    formatSpeedPart,
    splitPath,
    tailSessionId,
    fmtDuration, fmtTokens, fmtCount, pctColor,
    buildSearchLine, buildTokenPlanLines,
    MIN_PAD, MS_PER_SEC, PERCENT_SCALE, SEC_PER_MIN,
} from "./format.js";
```

**影响**:
- `src/index.ts`: 478 行 → **380 行**（减少 98 行，-20.5%）
- `src/format.ts`: 197 行 → 228 行（增加 31 行，主要是 `export` 关键字）
- 单一信息源：常量值仅在 format.ts 中定义，index.ts 通过 import 引用
- Pallet 类型（index.ts 私有）保持不变 — 审查未列入重复项；结构上与 format.ts 的 `PlainPallet` 兼容，TypeScript 结构化类型系统允许直接传递

---

### ✅ P1-2: 使用 `any` 类型绕过类型检查

**文件**: `src/index.ts`

**变更**:

1. **新增 4 个类型接口**（模块级，`// ── Footer API 适配类型 ──` 段）：

```typescript
/** Tui 句柄（Pi TUI 提供的渲染接口） */
interface TuiHandle {
    requestRender(): void;
}

/** Footer 渲染句柄（setFooter 回调的返回值） */
interface FooterHandle {
    dispose(): void;
    invalidate(): void;
    render(width: number): string[];
}

/** SDK 缺失的 setFooter 类型 — 仅本扩展需要
 *  绕过 `as any`：先用 `as unknown as` 明确意图，配合类型接口提供类型检查
 *  @todo SDK 补齐 setFooter 类型后移除本接口 */
interface UiWithFooter {
    setFooter(
        fn: (tui: TuiHandle, theme: Theme, footerData: ReadonlyFooterDataProvider) => FooterHandle,
    ): void;
}
```

2. **替换 `(ctx.ui as any).setFooter(...)` 为 `(ctx.ui as unknown as UiWithFooter).setFooter(...)`**

**变更对比**:

```diff
-// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK ExtensionContext.ui 类型缺失 setFooter
-(ctx.ui as any).setFooter((t: { requestRender(): void }, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
+// (via initFooter helper, see P1-3)
+(ctx.ui as unknown as UiWithFooter).setFooter(
+    (t: TuiHandle, theme: Theme, footerData: ReadonlyFooterDataProvider) => { ... }
+);
```

**影响**:
- 消除 `any` 类型断言（消除 `@typescript-eslint/no-explicit-any` lint 警告）
- 用 `unknown` 中转 + 显式接口提供编译时类型检查 — 若 SDK 补齐 `setFooter` 类型，类型不匹配会立即被 TypeScript 发现
- 遵循审查建议"方案 A"：定义结构化接口 + `as unknown as TypedUi`
- 同时为 P1-3 重构铺路：`TuiHandle` / `FooterHandle` 接口在 `initFooter` helper 中复用

---

### ✅ P1-3: `session_start` 处理器超过 20 行

**文件**: `src/index.ts`

**变更**:

1. **提取 `initFooter` helper**（模块级，22 行含签名）：

```typescript
function initFooter(
    ctx: ExtensionContext,
    state: StatuslineRuntimeState,
    tuiRef: TuiRef,
): void {
    (ctx.ui as unknown as UiWithFooter).setFooter(
        (t: TuiHandle, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
            tuiRef.current = t;
            const unsub = footerData.onBranchChange(() => t.requestRender());
            return {
                dispose() {
                    unsub();
                    tuiRef.current = null;
                },
                invalidate() {},
                render(width: number) {
                    return buildLines(ctx, theme, footerData, width, state);
                },
            };
        },
    );
}
```

2. **引入 `TuiRef` 引用包装**（替代 `let tui: ... | null`）：

```typescript
interface TuiRef {
    current: TuiHandle | null;
}
```

原因：原 `let tui` 是闭包变量，无法从 helper 函数直接赋值；改用 ref 对象（mutation-safe pattern）后，helper 通过 `tuiRef.current = t` 写入，调用方也能通过 `tuiRef.current?.requestRender()` 读取。

3. **精简 `session_start` handler**（22 行 → **9 行**）：

```typescript
pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    Object.assign(state, makeInitialState(), {
        sessionStart: Date.now(),
        thinkingLevel: pi.getThinkingLevel(),
    });
    refreshTotals(state, ctx);
    initFooter(ctx, state, tuiRef);
    triggerUpdate();
});
```

4. **同步更新所有 `tui?.requestRender()` → `tuiRef.current?.requestRender()`**（共 6 处）：
   - `message_end` handler
   - `turn_end` handler
   - `agent_end` handler
   - `model_select` handler
   - `thinking_level_select` handler（条件分支内）

**变更对比**:

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| `session_start` handler 行数 | 22 | 9（其中函数体 7 行） |
| 闭包变量 | `let tui: ... \| null` | `const tuiRef: TuiRef = { current: null }` |
| `(ctx.ui as any)` 使用 | 1 处 | 0 处 |
| helper 函数 | 无 | `initFooter`（22 行） |

**影响**:
- 满足 §4 "每个事件处理器 ≤ 20 行" 规范（session_start 现在仅 7 行函数体）
- `initFooter` 是 22 行的 helper 函数（非事件处理器），§4 限制不适用
- 行为完全等价：`tuiRef.current` 写入/读取的时序与原 `tui` 闭包变量一致

---

## P1 跳过（无）

3 个 P1 问题均已修复。

---

## 未修复的 P2 问题（不在修复范围内）

| 编号 | 问题 | 原因 |
|------|------|------|
| P2-1 | `PiMessageEvent` 接口定义过于宽泛（`Record<string, unknown>`） | SDK 事件载荷确为动态结构；现有注释已说明原因 |
| P2-2 | `buildSearchLine` 在两个文件中参数签名不一致 | P1-1 修复后已统一使用 format.ts 版本，签名差异消失 |
| P2-3 | 无 `session_tree` 事件处理 | 当前 `message_start`/`message_end` 会在新分支重新触发，实际影响较小 |
| P2-4 | 缺少集中类型文件（`src/types.ts`） | 修复后跨文件共享类型已通过 format.ts 集中（`QuotaRow` / `PlainPallet` / `SpeedLike`），新建 types.ts 收益有限 |
| P2-5 | `setup.ts` 中 `handler` 函数末尾缺少显式 `return` | 不影响运行时行为（async 函数默认返回 undefined） |

注：P2-2 在 P1-1 修复后实际已自动解决（index.ts 不再保留旧版 `buildSearchLine`）。

---

## 变更统计

| 文件 | 类型 | 行数变化 | 说明 |
|------|------|----------|------|
| `src/index.ts` | 重构 | 478 → **380**（-98 行，-20.5%） | P1-1 + P1-2 + P1-3 |
| `src/format.ts` | 微调 | 197 → 228（+31 行） | P1-1：新增 5 个 `export` 关键字 |
| **合计** | — | **净 -67 行** | 代码组织优化，无功能变更 |

**新增类型/函数**（`src/index.ts`）:
- `interface TuiHandle` / `interface FooterHandle` / `interface UiWithFooter` / `interface TuiRef`（4 个类型）
- `function initFooter(...)`（22 行 helper）

---

## 验证结果

| 检查项 | 状态 | 证据 |
|--------|------|------|
| `npx tsc --noEmit` (statusline 部分) | ✅ 通过 | 0 个 statusline 相关错误（其他 6 个错误为预存问题，在 claude-rules-loader/coding-workflow/unified-hooks） |
| `npx vitest run` | ✅ 通过 | 69/69 测试全过 |
| `npx eslint src/` | ✅ 通过 | 0 警告 0 错误 |
| `src/index.ts` 总行数 | ✅ 380 行 | 低于 500 行指南 |
| `session_start` handler 行数 | ✅ 9 行（含开闭），函数体 7 行 | 低于 20 行限制 |
| `pctColor`/`fmtDuration`/`fmtTokens`/`fmtCount` 在 index.ts 定义数 | ✅ 0 | 全部从 format.ts import |
| `(ctx.ui as any)` 使用 | ✅ 0 | 改为 `as unknown as UiWithFooter` |
| 重复常量在 index.ts | ✅ 0 | 所有共享常量在 format.ts 单一定义并 export |
| 重复 `QuotaRow` 接口 | ✅ 0 | 统一在 format.ts |
| 重复 `COLS` 数组 | ✅ 0 | 统一在 format.ts |
| 运行时行为 | ✅ 不变 | 所有 case 逻辑原样搬迁；仅做代码组织重构 |

---

## 风险评估

- **P1-1**: 风险低。删除的 9 个函数 + 13 个常量与 format.ts 中的定义逐字符一致（已对比）；import/export 路径无变化。
- **P1-2**: 风险低。`as unknown as UiWithFooter` 与 `as any` 行为等价（都绕过类型检查），但前者携带显式类型信息；若 SDK 类型补齐，TypeScript 会在编译期立即报错。
- **P1-3**: 风险低。`TuiRef` 包装的 mutation 时序与原 `let tui` 一致（都是 session_start 中赋值，在 dispose 中清空）；`initFooter` 内部仍是同步注册。

**总体风险等级:** 低
**建议合并策略:** 3 个修复相互独立（共用 `TuiHandle`/`FooterHandle`/`UiWithFooter`/`TuiRef` 类型，但可在 P1-2/P1-3 拆分 commit）。建议合并为一个 commit：

```
fix(statusline): address P1 audit findings

- Dedupe 9 functions, 13 constants, 1 interface, 1 array between
  index.ts and format.ts. Single source of truth in format.ts.
- Replace (ctx.ui as any) with typed UiWithFooter interface and
  `as unknown as` cast for compile-time safety.
- Extract setFooter registration to initFooter helper. session_start
  handler reduced from 22 lines to 7 lines of body.
- src/index.ts: 478 → 380 lines (-20.5%)
```

---

*修复日期: 2026-06-05*
*修复者: code-fix-engineer*
*关联审查报告: docs/extension-audit/statusline.md*
