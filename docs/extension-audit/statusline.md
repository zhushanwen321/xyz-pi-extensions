# Extension 审查报告: statusline

## 基本信息

| 项目 | 值 |
|------|------|
| 包名 | `@zhushanwen/pi-statusline` |
| 版本 | 0.4.2 |
| 描述 | Pi statusline extension — shows context usage, token speed, and provider quota in the footer |
| 文件数 | 6（index.ts, src/index.ts, src/setup.ts, src/setup-prompts.ts, src/format.ts, src/\_\_tests\_\_/format.test.ts） |
| 总代码行 | ~951 行 |
| 入口 | `./src/index.ts` |

## 审查结果概览

| 规范项 | 状态 | 严重程度 | 说明 |
|--------|------|----------|------|
| 1. 包结构与命名 | ⚠️ 部分合规 | P1 | npm scope 应为官方 scope 而非个人 scope；`pi.extensions` 字段路径嵌套在 `pi` 对象下可接受；`files` 未直接列出入口 `.ts` 文件而是用目录通配 |
| 2. 入口与工厂模式 | ✅ 合规 | — | `export default function(pi: ExtensionAPI)` 形式正确；状态变量在工厂闭包内 |
| 3. Tool 注册与设计 | N/A | — | 本扩展不注册 tool，仅注册 command |
| 4. 事件生命周期管理 | ⚠️ 部分合规 | P2 | `session_start` 处理器约 22 行，略超 20 行上限；无 `session_tree` 处理器 |
| 5. 状态与会话管理 | ✅ 合规 | — | 状态在 `registerSessionLifecycle` 闭包内，通过 `makeInitialState()` 重置 |
| 6. 错误处理与弹性 | ⚠️ 部分合规 | P1 | 无 `isStaleContextError` 检测（本扩展不发起 LLM 调用，影响有限）；`any` 类型断言存在 |
| 7. 类型安全 | ❌ 不合规 | P1 | 使用 `(ctx.ui as any)` 绕过类型检查；跨文件重复定义 `QuotaRow`、`COLS` 等类型/常量 |
| 8. 路径与配置 | ✅ 合规 | — | 使用 `getConfigDir()` 等函数获取路径，无硬编码路径 |
| 9. 依赖管理 | ✅ 合规 | — | `@zhushanwen/pi-quota-providers` 在 `dependencies` 声明；Pi SDK 包在 `peerDependencies` |
| 10. 健壮性 | ⚠️ 部分合规 | P2 | 无 `process.exit`；无无限循环；`signal` 取消未透传（本扩展无长异步操作） |
| 11. 代码风格 | ❌ 不合规 | P1 | `src/index.ts` 478 行 < 500 行限制；但存在大量重复代码（9 个函数、多个常量在两个文件间重复） |
| 12. Monorepo 约定 | ⚠️ 部分合规 | P1 | Import 顺序基本正确；存在 index.ts ↔ format.ts 大量代码重复（违反 DRY 原则） |

## 详细问题清单

### P0 问题

无 P0 级别问题（崩溃风险）。

---

### P1 问题

#### P1-1: 大量函数和常量在 `src/index.ts` 与 `src/format.ts` 之间重复

- **文件**: `src/index.ts` + `src/format.ts`
- **规范**: #7 类型安全 — 跨文件类型集中到 types.ts; #11 代码风格 — DRY
- **说明**: 以下函数在两个文件中各自独立定义了完全相同的实现：
  - `fmtDuration`, `fmtTokens`, `fmtResetSec`, `fmtCount`, `pctColor`
  - `normalizeRows`, `buildSearchLine`, `buildTokenPlanLines`, `formatWinCol`
  - 常量: `MS_PER_SEC`, `SEC_PER_MIN`, `MIN_PER_HOUR`, `HOURS_PER_DAY`, `SEC_PER_HOUR`, `SEC_PER_DAY`, `KILO`, `MILLION`, `PCT_HIGH`, `PCT_MED`, `PCT_LOW`, `PERCENT_SCALE`, `MIN_PAD`
  - 接口: `QuotaRow`（index.ts 第 277 行, format.ts 第 142 行）
  - 常量数组: `COLS`（index.ts 第 282 行, format.ts 第 42 行）
- **index.ts 仅从 format.ts 导入了 3 个函数** (`formatSpeedPart`, `splitPath`, `tailSessionId`)，但其余 9 个函数却是复制粘贴而非 import。

```typescript
// src/index.ts 仅导入 3 个：
import { formatSpeedPart, splitPath, tailSessionId } from "./format.js";

// 但 src/index.ts 又自己重新定义了 fmtDuration, fmtTokens, fmtResetSec, fmtCount,
// pctColor, normalizeRows, buildSearchLine, buildTokenPlanLines, formatWinCol
// 这些在 format.ts 中均已 export
```

- **建议**: `src/index.ts` 应删除所有重复定义，统一从 `./format.js` import。常量和接口应提取到 `src/constants.ts` 和 `src/types.ts`（或统一到 `format.ts` 后由 `index.ts` re-export）。

---

#### P1-2: 使用 `any` 类型绕过类型检查

- **文件**: `src/index.ts` 第 185-186 行
- **规范**: #7 类型安全 — 禁止 any，必须替换为具体类型或 unknown

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK ExtensionContext.ui 类型缺失 setFooter
(ctx.ui as any).setFooter((t: { requestRender(): void }, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
```

- **说明**: 虽然有 eslint-disable 注释说明原因（SDK 类型缺失），但仍应使用更安全的方式处理：
  - 方案 A: 定义 `interface UiWithFooter { setFooter(fn: ...): void }` 然后 `ctx.ui as unknown as UiWithFooter`
  - 方案 B: 向 SDK 提 PR 补充 `setFooter` 类型定义

---

#### P1-3: `session_start` 处理器超过 20 行

- **文件**: `src/index.ts` 第 183-207 行（~22 行）
- **规范**: #4 事件生命周期管理 — 每个事件处理器不超过 20 行

```typescript
pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    Object.assign(state, makeInitialState(), {
        sessionStart: Date.now(),
        thinkingLevel: pi.getThinkingLevel(),
    });
    refreshTotals(state, ctx);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any ...
    (ctx.ui as any).setFooter((t: ..., theme: Theme, footerData: ReadonlyFooterDataProvider) => {
        tui = t;
        const unsub = footerData.onBranchChange(() => t.requestRender());
        return {
            dispose() { unsub(); tui = null; },
            invalidate() {},
            render(width: number) {
                return buildLines(ctx, theme, footerData, width, state);
            },
        };
    });

    triggerUpdate();
});
```

- **建议**: 将 `setFooter` 注册逻辑提取到独立辅助函数，如 `initFooter(ctx, state, tuiRef)`.

---

### P2 问题

#### P2-1: `PiMessageEvent` 接口定义过于宽泛

- **文件**: `src/index.ts` 第 33-36 行
- **规范**: #7 类型安全

```typescript
interface PiMessageEvent {
    message: { role: string } & Record<string, unknown>;
}
```

- **说明**: `Record<string, unknown>` 是允许的（SDK 事件载荷确实是动态结构），但最好添加注释说明为何使用此模式。当前已有隐含说明（SDK 类型不够精确），可接受。

---

#### P2-2: `buildSearchLine` 在两个文件中参数签名不一致

- **文件**: `src/index.ts` 第 403-422 行 vs `src/format.ts` 第 174-194 行
- **规范**: #7 类型安全

```typescript
// src/index.ts — 接受 CacheData（不透明类型）+ 内部 Palette
function buildSearchLine(cache: CacheData, providers: QuotaProvider[], p: Pallet, theme: Theme): string

// src/format.ts — 接受 Record<string, unknown> + PlainPallet（可测试）
export function buildSearchLine(
    cache: Record<string, unknown>, providers: QuotaProvider[], p: PlainPallet,
    themeFg: (token: string, text: string) => string,
): string
```

- **说明**: `format.ts` 版本为了可测试性将 `Theme` 拆为 `themeFg` 函数参数，这是好的设计。但 `index.ts` 仍保留了使用 `Theme` 的旧版函数，形成了两套并行实现。应统一使用 `format.ts` 版本。

---

#### P2-3: 无 `session_tree` 事件处理

- **文件**: `src/index.ts`
- **规范**: #4 事件生命周期管理 — session_tree 中必须丢弃旧分支的 pending 状态

- **说明**: 当前扩展未注册 `session_tree` 事件处理器。在用户切换分支时，`state.isAgentBusy` 可能保留旧分支的状态。不过由于 `message_start`/`message_end` 会在新分支重新触发，实际影响较小。建议添加空处理器作为防御性编程。

---

#### P2-4: 缺少集中类型文件

- **文件**: 无 `src/types.ts`
- **规范**: #7 类型安全 — 跨文件类型集中到 types.ts

- **说明**: `StatuslineRuntimeState`、`PiMessageEvent`、`PiThinkingLevelEvent`、`Pallet` 等类型散落在 `src/index.ts` 中；`QuotaRow`、`SpeedLike`、`PlainPallet` 散落在 `src/format.ts` 中。建议提取到 `src/types.ts`。

---

#### P2-5: `handler` 函数缺少显式 `return` 在末尾路径

- **文件**: `src/setup.ts` 第 28-68 行
- **规范**: #6 错误处理与弹性 — 函数内所有控制流路径必须有显式 return

```typescript
handler: async (_args: string, ctx: ExtensionCommandContext) => {
    // ... try/catch 路径有 return
    // ... if (hasProviders && hasSecrets) 路径有 return
    // 末尾路径：pi.sendUserMessage(prompt) + ctx.ui.notify(...)
    // ⚠️ 缺少显式 return（虽然 async 函数默认返回 undefined）
},
```

- **说明**: 末尾缺少 `return;` 语句。虽然不影响运行时行为，但不符合"所有控制流路径必须有显式 return"规范。

---

## 优点

1. **✅ 工厂模式正确**: 使用 `export default function statuslineExtension(pi: ExtensionAPI)` 标准入口，状态正确封装在 `registerSessionLifecycle` 闭包内，无模块级 `let` 变量。

2. **✅ 纯函数测试设计优秀**: `src/format.ts` 将渲染逻辑提取为纯函数，不依赖 Pi 运行时（`ExtensionAPI`/`Theme`），配合 `PlainPallet` 和 `plainThemeFg` mock 实现了高度可测试性。测试覆盖了 347 行，包含边界值、对齐验证、快照测试。

3. **✅ 依赖声明规范**: Pi SDK 包（`@mariozechner/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`）均在 `peerDependencies`，且 `@mariozechner/pi-coding-agent` 未标记为 `optional`。第三方依赖 `@zhushanwen/pi-quota-providers` 正确声明在 `dependencies`。

4. **✅ 错误处理思路正确**: `normalizeRows` 和 `buildTokenPlanLines` 中的 try/catch 防止单个 provider 失败拖垮整个状态栏渲染。`setup.ts` 中的 `mkdirSync` 也有 try/catch 保护。

5. **✅ 语义化常量**: 所有魔术数字都提取为命名常量（`MS_PER_SEC`, `BOGUS_OUTPUT_THRESHOLD`, `DEFAULT_CONTEXT_WINDOW` 等），注释清晰。

6. **✅ 防重入保护**: 使用 `isAgentBusy` 标志防止重复状态更新。

7. **✅ i18n 支持**: `setup-prompts.ts` 根据系统 locale 自动切换中英文 prompt。

8. **✅ 无硬编码路径**: 使用 `getConfigDir()` / `getProvidersConfigPath()` / `getSecretsPath()` 获取配置路径。

## 改进建议

### 优先级 P1 — 必须修复

1. **消除代码重复**: 将 `src/index.ts` 中的 9 个重复函数（`fmtDuration`, `fmtTokens`, `fmtResetSec`, `fmtCount`, `pctColor`, `normalizeRows`, `buildSearchLine`, `buildTokenPlanLines`, `formatWinCol`）全部删除，改为从 `./format.js` import。同步删除重复的常量（`MS_PER_SEC` 等 13 个）和接口（`QuotaRow`）。预计可减少 `src/index.ts` 约 150-200 行。

2. **消除 `any` 类型**: 将 `(ctx.ui as any).setFooter(...)` 替换为类型安全的方式，例如：
   ```typescript
   interface UiFooterApi { setFooter(fn: (...) => FooterHandle): void }
   (ctx.ui as unknown as UiFooterApi).setFooter(...)
   ```

### 优先级 P2 — 建议修复

3. **提取集中类型文件**: 创建 `src/types.ts`，将 `StatuslineRuntimeState`、`PiMessageEvent`、`PiThinkingLevelEvent`、`Pallet`、`PlainPallet`、`QuotaRow`、`SpeedLike` 等跨文件共享的类型集中管理。

4. **拆分 `session_start` 处理器**: 将 `setFooter` 注册逻辑提取为独立函数，使处理器 ≤ 20 行。

5. **添加 `session_tree` 处理器**: 防御性处理分支切换场景，重置 `isAgentBusy` 状态。

6. **补充显式 `return`**: 在 `setup.ts` 的 `handler` 函数末尾添加 `return;`。
