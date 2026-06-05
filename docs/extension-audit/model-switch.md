# Extension 审查报告: model-switch

## 基本信息

| 项目 | 值 |
|------|-----|
| 包名 | `@zhushanwen/pi-model-switch` |
| 版本 | 0.2.5 |
| 文件数 | 8（含 index.ts 入口 + 6 个 src 文件 + 1 个测试） |
| 总行数 | 1 593（src 6 文件）+ 2（index.ts）+ 198（test）= 1 793 |
| 入口 | `index.ts` → `src/index.ts` |

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | 2 | re-export 入口 |
| `src/index.ts` | 342 | 工厂函数、Tool 注册、Action Handler |
| `src/types.ts` | 143 | 共享类型、常量、工具函数 |
| `src/config.ts` | 201 | 配置文件加载、v1→v2 迁移 |
| `src/advisor.ts` | 347 | 用量快照计算、粘性计算、Peak 推荐、Scene 模型解析 |
| `src/prompt.ts` | 227 | 上下文注入 prompt 格式化 |
| `src/setup.ts` | 333 | 配置自动生成、文件 CRUD 操作 |
| `tests/resolveModelForScene.test.ts` | 198 | resolveModelForScene 单元测试 |

## 审查结果概览

| # | 规范项 | 状态 | 严重程度 | 说明 |
|---|--------|------|----------|------|
| 1 | 包结构与命名 | ⚠️ 部分合规 | P1 | import 与 package.json 声明的包名不匹配；虽经 tsconfig paths 可解析，但元数据不一致 |
| 2 | 入口与工厂模式 | ✅ 合规 | — | `export default function(pi)` 形式正确；工厂 ~35 行；无模块级 let |
| 3 | Tool 注册与设计 | ⚠️ 部分合规 | P1/P2 | `details` 类型 `Record<string, never>` 不符合规范 `Record<string, unknown>`；signal 未透传 |
| 4 | 事件生命周期管理 | ⚠️ 轻微偏差 | P2 | `before_agent_start` 处理器 ~37 行，超出 20 行上限 |
| 5 | 状态与会话管理 | ✅ 合规 | — | 状态在闭包内；v1→v2 反序列化向后兼容 |
| 6 | 错误处理与弹性 | ✅ 合规 | — | 无 throw、无 process.exit、所有路径有显式 return |
| 7 | 类型安全 | ✅ 合规 | — | 无 `any`；类型集中到 types.ts |
| 8 | 路径与配置 | ✅ 合规 | — | 使用 `path.join()` + `homedir()` |
| 9 | 依赖管理 | ⚠️ 部分合规 | P1 | CONFIG_PATH 在 config.ts 与 setup.ts 中重复定义；import 来源与 peerDep 声明不一致 |
| 10 | 健壮性 | ✅ 合规 | — | 无未捕获异常、无 process.exit、无无限循环 |
| 11 | 代码风格 | ⚠️ 轻微偏差 | P2 | 事件处理器超 20 行；import 顺序不完全规范 |
| 12 | Monorepo 约定 | ✅ 合规 | — | index.ts re-export；单文件均 ≤500 行 ≤1000 行 |

## 详细问题清单

### P0 问题

无 🎉

---

### P1 问题

#### P1-1: import 包名与 package.json peerDependencies 声明不匹配

**文件:** `src/index.ts` 第 15–16 行  
**规范:** §1 包结构与命名 + §9 依赖管理

```typescript
// src/index.ts:15-16 — 实际 import
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
```

```jsonc
// package.json — peerDependencies 声明
"peerDependencies": {
    "@sinclair/typebox": "*",       // ← 声明的是 "@sinclair/typebox"，import 用的是 "typebox"
    "@earendil-works/pi-ai": "*",  // ← 声明的是 "@earendil-works/pi-ai"，import 用的是 "@mariozechner/pi-ai"
}
```

**分析:** 根 tsconfig `paths` 别名将 `"typebox"` → `@earendil-works/pi-coding-agent/node_modules/typebox`、`"@mariozechner/pi-ai"` → `@earendil-works/pi-ai`，编译和运行时可正常解析。但 package.json 元数据与实际 import 来源不一致，会误导开发者：

- 执行 `npm install` 时，根据 package.json 安装的是 `@sinclair/typebox`，但代码 import `"typebox"`；
- 若脱离当前 monorepo 的 tsconfig paths 使用（如独立发布），import 将直接失败。

**建议:** 统一 import 名与 package.json 声明。二选一：
- **方案 A（推荐）:** 修改 import 为 `"@sinclair/typebox"` 和 `"@earendil-works/pi-ai"`；
- **方案 B:** 在 package.json 中增加 `"typebox": "*"` 和 `"@mariozechner/pi-ai": "*"` 声明，并说明依赖 tsconfig paths。

---

#### P1-2: CONFIG_PATH 在 config.ts 和 setup.ts 中重复定义

**文件:** `src/config.ts` 第 14–15 行, `src/setup.ts` 第 270–271 行  
**规范:** §9 依赖管理 + §12 Monorepo 约定（DRY）

```typescript
// src/config.ts:14-15
const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "model-policy.json");
export { CONFIG_PATH };
```

```typescript
// src/setup.ts:270-271 — 完全相同的定义
const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "model-policy.json");
```

**分析:** `config.ts` 已经 export 了 `CONFIG_PATH`，`setup.ts` 不需要重新定义。若未来路径变更，需同步修改两处，极易遗漏导致不一致。

**建议:** 在 `setup.ts` 中 import `CONFIG_PATH`（及 `CONFIG_DIR`，如需要）from `./config`：

```typescript
// setup.ts
import { CONFIG_PATH } from "./config";
```

若 setup.ts 还需要 `CONFIG_DIR`（用于 `settings.json` 路径），可将其也从 `config.ts` 中 export。

---

#### P1-3: `details` 字段类型不符合规范

**文件:** `src/index.ts` 第 44–48 行  
**规范:** §3 Tool 注册与设计 — "execute 返回 `{ ..., details?: Record<string, unknown> }`"

```typescript
// src/index.ts:44-48
interface ToolRes {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, never>;  // ← 使用了 never，且非 optional
    isError?: boolean;
}
```

**分析:** 
- 规范要求 `details` 类型为 `Record<string, unknown>`，当前使用 `Record<string, never>` 是最严格的形式（不允许任何属性）。
- 规范要求 `details` 是 **optional** (`details?`)，当前为 **必填**。
- 虽然当前所有 handler 均返回空 `details: {}` 不影响运行，但类型定义与规范不一致，且将来若需添加 details 数据会被类型系统阻止。

**建议:** 
```typescript
interface ToolRes {
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
}
```

---

### P2 问题

#### P2-1: `before_agent_start` 事件处理器超出 20 行上限

**文件:** `src/index.ts` 第 68–93 行（约 25 行，含空行 ~37 行）  
**规范:** §4 事件生命周期管理 — "每个事件处理器不超过20行"

```typescript
pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (!state.config) return;
    try {
        const currentModel = getCurrentModelId(ctx);                    // 1
        const entries = asSessionEntries(ctx.sessionManager.getBranch()); // 2
        const cache = readCache();                                       // 3
        const config = state.config;                                     // 4
        const snapshot = computeQuotaSnapshot(cache, config);            // 5
        const stickiness = computeStickiness(entries, config);           // 6
        const recommend = computePeakRecommend(new Date(), config, snapshot); // 7
        const injection = formatContextPrompt({...});                     // 8-14
        let modelTable = "";                                             // 15
        if (!state.injectedModelTable) {                                 // 16
            modelTable = "\n" + formatSessionModels(config);             // 17
            state.injectedModelTable = true;                             // 18
        }                                                               // 19
        return { systemPrompt: `\n${injection}${modelTable}` };         // 20
    } catch (err) {
        console.warn("[model-switch] context injection failed:", err);
        return;
    }
});
```

**建议:** 将数据准备逻辑提取为独立函数：

```typescript
function buildInjection(state: SessionState, ctx: ExtensionContext): string | null {
    if (!state.config) return null;
    const snapshot = computeQuotaSnapshot(readCache(), state.config);
    // ... 其余逻辑
    return injection;
}

pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    try {
        const injection = buildInjection(state, ctx);
        if (!injection) return;
        return { systemPrompt: `\n${injection}` };
    } catch (err) {
        console.warn("[model-switch] context injection failed:", err);
    }
});
```

---

#### P2-2: signal 参数接收但未透传给异步操作

**文件:** `src/index.ts` 第 137 行  
**规范:** §3 Tool 注册与设计 — "异步操作必须透传 signal 参数" + §10 健壮性

```typescript
async execute(
    _toolCallId: string,
    params: { action: string; query?: string },
    _signal: AbortSignal | undefined,   // ← 接收但未使用
    _onUpdate: unknown,
    ctx: ExtensionContext,
): Promise<ToolRes> {
```

**分析:** 当前所有 action handler 均为同步或轻量异步操作（`readCache()`, `loadConfig()` 等均为同步），实际不涉及长耗时 I/O。`handleSwitch` 调用 `switchToModel` 虽是 `async`，内部操作也为同步。因此 signal 不透传在当前实现下影响有限。

**建议:** 若未来引入真正的异步操作（如网络请求），需透传 signal。当前可保留 `_signal` 前缀标记为暂未使用，并在函数注释中说明。

---

#### P2-3: import 顺序不完全遵循规范

**文件:** `src/index.ts` 第 14–24 行  
**规范:** §12 Monorepo 约定 — "Import 顺序: Node内置 → npm → Pi SDK → 内部包 → 当前包"

```typescript
// 实际顺序:
import type { ... } from "@mariozechner/pi-coding-agent";  // Pi SDK
import { Type } from "typebox";                             // npm（应在 Pi SDK 前）
import { StringEnum } from "@mariozechner/pi-ai";           // Pi SDK
import { readCache } from "@zhushanwen/pi-quota-providers"; // 内部包
import { loadConfig } from "./config";                      // 当前包
```

**建议:** 调整为 Node → npm → Pi SDK → 内部 → 当前：

```typescript
import { Type } from "typebox";                             // npm
import type { ... } from "@mariozechner/pi-coding-agent";  // Pi SDK
import { StringEnum } from "@mariozechner/pi-ai";           // Pi SDK
import { readCache } from "@zhushanwen/pi-quota-providers"; // 内部包
import { loadConfig } from "./config";                      // 当前包
```

---

#### P2-4: `@earendil-works/pi-ai` 标记 optional 但代码中无条件使用

**文件:** `package.json` 第 25–29 行  
**规范:** §1 包结构与命名

```json
"peerDependenciesMeta": {
    "@earendil-works/pi-ai": {
        "optional": true
    }
}
```

代码 `src/index.ts` 第 16 行无条件 import：
```typescript
import { StringEnum } from "@mariozechner/pi-ai";
```

**分析:** `optional: true` 表示该依赖缺失时不应导致加载失败，但 `StringEnum` 在 Tool 参数定义中直接使用（非条件导入）。若该包确实可选，应增加条件导入保护；若必需，应移除 optional 标记。

经查根 tsconfig paths 中 `@mariozechner/pi-ai` 映射到 `@earendil-works/pi-ai`，实际由 `@mariozechner/pi-coding-agent` 间接提供，因此运行时不会缺失。但 `optional` 标记语义不准确。

**建议:** 移除 `peerDependenciesMeta` 中对 `@earendil-works/pi-ai` 的 optional 标记。

---

## 优点

### 1. 架构设计清晰
- 6 个源文件各司其职：`types.ts`（类型）、`config.ts`（加载/迁移）、`advisor.ts`（计算逻辑）、`prompt.ts`（格式化）、`setup.ts`（生成/CRUD）、`index.ts`（工厂+注册），职责分明。
- 工厂函数仅 ~35 行，通过 `registerSwitchTool()` 委托，符合"超过100行委托到子模块"的精神。

### 2. 类型安全扎实
- **零 `any` 使用**：所有文件 grep `any` 无结果。
- 使用 TypeBox `Type.Object()` + `StringEnum()` 定义 Tool 参数，每个字段带 `description`。
- 跨文件类型集中到 `types.ts`。

### 3. 向后兼容处理完善
- `config.ts` 的 `migrateV1()` 将旧格式自动迁移为 v2 内存结构，并 `applyDefaults()` 为缺失字段填充默认值。
- 对配置文件不存在、JSON 解析失败、版本不兼容等情况均有降级处理（返回 `null` + `console.warn`）。

### 4. 错误处理规范
- 所有 Tool handler 均通过 `res(text, { error: true })` 返回 `{ isError: true }`，**无 throw**。
- `before_agent_start` 的 `try/catch` 确保注入失败不阻塞 agent 运行。
- 所有控制流路径均有显式 return（noImplicitReturns 已在 tsconfig 开启）。

### 5. 路径处理规范
- 配置路径全部使用 `path.join(homedir(), ".pi", "agent")` 构建，无硬编码路径。
- tsconfig `include` 正确限定为 `src/**/*.ts` + `index.ts`。

### 6. 测试覆盖
- `resolveModelForScene()` 有 7 个测试用例（正常场景、peak avoid、scene 不存在、无配置、全 avoid、优先级反转、providerKey≠planName），覆盖了核心分支逻辑。
- 使用 vi.hoisted() + vi.mock() 正确隔离外部依赖。

### 7. 代码可读性高
- 每个文件带 JSDoc 头部注释说明职责。
- 清晰的 `// ── Section ──` 分隔符组织代码块。
- 常量有命名含义（如 `ZAI_SAFETY_VALVE`、`PEAK_WINDOW_THRESHOLD`）。

## 改进建议

### 优先级高

| # | 建议 | 对应问题 |
|---|------|----------|
| 1 | 统一 import 包名与 package.json 声明：将 `"typebox"` → `"@sinclair/typebox"`、`"@mariozechner/pi-ai"` → `"@earendil-works/pi-ai"`（或反向调整 package.json） | P1-1 |
| 2 | 消除 `setup.ts` 中重复的 `CONFIG_DIR`/`CONFIG_PATH`，改为从 `config.ts` import | P1-2 |
| 3 | 将 `ToolRes.details` 类型改为 `Record<string, unknown>` 并标记 optional | P1-3 |

### 优先级中

| # | 建议 | 对应问题 |
|---|------|----------|
| 4 | 将 `before_agent_start` 处理器拆分为 `buildInjection()` 辅助函数，使处理器本体 ≤20 行 | P2-1 |
| 5 | 移除 `peerDependenciesMeta` 中 `@earendil-works/pi-ai` 的 optional 标记 | P2-4 |

### 优先级低

| # | 建议 | 对应问题 |
|---|------|----------|
| 6 | 调整 `src/index.ts` import 顺序为 Node → npm → Pi SDK → 内部 → 当前 | P2-3 |
| 7 | 考虑为 `handleSetup` 的 `'edit'` 分支增加 JSON schema 校验后再展示 | 健壮性增强 |
| 8 | `advisor.ts` 的 `resolveModelForScene` 每次调用都 `loadConfig()` + `readCache()`，若高频调用可考虑缓存 | 性能优化 |

---

*审查日期: 2025-07-14*  
*审查范围: extensions/model-switch 全部源码（src/*.ts + index.ts + package.json + tsconfig.json）*
