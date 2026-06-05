# Extension 修复日志: model-switch

## 审查范围

依据 `docs/extension-audit/model-switch.md` 审查报告，对 `extensions/model-switch` 包进行 P0/P1 问题修复。

**修复日期:** 2025-07-14
**审查报告版本:** model-switch.md（2025-07-14）

## 修复概览

| 编号 | 严重度 | 状态 | 修复方式 |
|------|--------|------|----------|
| P0   | —      | —    | 报告无 P0 问题 |
| P1-1 | P1     | ✅ 已修复 | package.json 添加缺失的 peerDependencies |
| P1-2 | P1     | ✅ 已修复 | setup.ts 改为从 config.ts 导入 CONFIG_DIR/CONFIG_PATH |
| P1-3 | P1     | ⚠️ 部分修复 | 类型改为 `Record<string, unknown>`，但保持非 optional（SDK 约束） |
| P2-* | P2     | ⏭️ 跳过 | 按规则不修复 P2 |

## 详细修复记录

### P1-1: import 包名与 package.json peerDependencies 声明不匹配

**修复前问题:**
- `src/index.ts` 中 `import { Type } from "typebox"` 和 `import { StringEnum } from "@mariozechner/pi-ai"`
- `package.json` 的 `peerDependencies` 仅声明 `"@sinclair/typebox"` 和 `"@earendil-works/pi-ai"`
- 元数据与实际 import 来源不一致

**采用方案:** 方案 B（在 package.json 中补齐声明），原因：
- **最小变更原则**：不修改 import 与 tsconfig paths，避免引入连锁配置变更
- 方案 A（修改 import 为 `"@sinclair/typebox"` / `"@earendil-works/pi-ai"`）需要同步在根 `tsconfig.json` 的 `paths` 中新增 `"@sinclair/typebox"` 映射，否则开发环境无法解析
- 当前 import 实际可工作（monorepo tsconfig paths 已正确映射），补齐 peerDeps 是最低风险做法
- 若未来需要脱离 monorepo paths 独立发布，可再切换到方案 A 并同步更新 tsconfig

**修改文件:** `extensions/model-switch/package.json`

```diff
   "peerDependencies": {
     "@mariozechner/pi-coding-agent": "*",
     "@earendil-works/pi-ai": "*",
-    "@sinclair/typebox": "*"
+    "@sinclair/typebox": "*",
+    "typebox": "*",
+    "@mariozechner/pi-ai": "*"
   },
```

**验证:** 修复后 import 来源与 peerDependencies 声明完全对齐。

---

### P1-2: CONFIG_PATH 在 config.ts 和 setup.ts 中重复定义

**修复前问题:**
- `src/config.ts` 定义并 `export { CONFIG_PATH };`
- `src/setup.ts` 重新定义相同的 `CONFIG_DIR` / `CONFIG_PATH` 常量
- 重复定义存在未来漂移风险

**修复方式:** 
1. 在 `config.ts` 中同时 `export { CONFIG_DIR, CONFIG_PATH }`（setup.ts 还需要 `CONFIG_DIR` 用于 `settings.json` 路径和 `mkdirSync`）
2. 在 `setup.ts` 中删除本地 `CONFIG_DIR` / `CONFIG_PATH` 定义，改为从 `./config` 导入

**修改文件:** 
- `src/config.ts`（修改 export 行）
- `src/setup.ts`（删除重复定义 + 调整 import）

`config.ts` 变更:
```diff
-export { CONFIG_PATH };
+export { CONFIG_DIR, CONFIG_PATH };
```

`setup.ts` 变更:
```diff
 import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
-import { homedir } from "node:os";
 import { join } from "node:path";
 import type { SetupResult } from "./types";
+import { CONFIG_DIR, CONFIG_PATH } from "./config";
```

```diff
 // ── 文件操作 ────────────────────────────────────────────

-const CONFIG_DIR = join(homedir(), ".pi", "agent");
-const CONFIG_PATH = join(CONFIG_DIR, "model-policy.json");
-
 export function getConfigPath(): string {
   return CONFIG_PATH;
 }
```

**验证:**
- `npx tsc --noEmit` 通过
- `npx vitest run tests/resolveModelForScene.test.ts` 7 个测试全部通过
- 单一信息源（`config.ts`），未来路径变更仅需修改一处

---

### P1-3: ToolRes.details 类型不符合规范

**修复前问题:**
```typescript
interface ToolRes {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, never>;  // 过于严格
    isError?: boolean;
}
```

**预期修复（来自审查报告）:**
```typescript
interface ToolRes {
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;  // 宽松 + optional
    isError?: boolean;
}
```

**实际修复（部分偏离审查建议）:**
```typescript
interface ToolRes {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;  // 宽松但非 optional（SDK 约束）
    isError?: boolean;
}
```

**偏离审查建议的原因:**

直接采用审查建议（`details?: Record<string, unknown>`）会导致 TypeScript 类型检查失败，错误信息：

```
src/index.ts(134,9): error TS2322: Type 'ToolRes' is not assignable to type
'AgentToolResult<Record<string, unknown> | undefined>'.
  Property 'details' is optional in type 'ToolRes' but required in type
  'AgentToolResult<Record<string, unknown> | undefined>'.
```

**根因分析:**

查看 SDK（`@earendil-works/pi-coding-agent`）中 `AgentToolResult<T>` 的定义：

```typescript
// node_modules/@earendil-works/pi-coding-agent/.../pi-agent-core/dist/types.d.ts
export interface AgentToolResult<T> {
    content: (TextContent | ImageContent)[];
    details: T;             // ← 非 optional
    terminate?: boolean;
}
```

`pi.registerTool()` 的 `execute` 方法签名约束：
```typescript
execute(...): Promise<AgentToolResult<TDetails>>;
```

TypeScript 的结构化类型系统严格区分以下两种情况：
- `details?: T`（optional 属性） — 不允许赋值给 `details: T`（required）
- `details: T | undefined`（required 但可 undefined） — 允许

因此 `ToolRes` 必须保持 `details` 为**非 optional** 才能赋值给 `AgentToolResult<TDetails>`。

**审查建议可能基于过时的 SDK 规范或规范文档与实际 SDK 类型不一致**。本次修复优先满足 SDK 类型约束（代码可工作的硬性要求），并满足审查的核心意图（将过度严格的 `Record<string, never>` 改为可扩展的 `Record<string, unknown>`）。

**修改文件:** `src/index.ts`

```diff
 interface ToolRes {
   content: Array<{ type: "text"; text: string }>;
-  details: Record<string, never>;
+  details: Record<string, unknown>;
   isError?: boolean;
 }
```

**验证:**
- `npx tsc --noEmit` 通过
- `res()` 函数中 `details: {}` 仍正确（空对象是 `Record<string, unknown>` 的合法值）
- 未来如需在 details 中返回结构化数据（如切换结果），可自由扩展

**后续建议（不在本次修复范围）:**
- 提请维护者审视规范文档第 3 节"Tool 注册与设计"中关于 `details?` 的描述是否需要更新
- 或确认 SDK 是否计划在 `AgentToolResult` 中放宽 `details` 为 optional

---

## 已跳过的问题

### P2-1: before_agent_start 事件处理器超出 20 行

**跳过原因:** 按修复原则 P2 不修复。审查报告已建议提取为 `buildInjection()` 函数，可后续单独 PR 处理。

### P2-2: signal 参数接收但未透传给异步操作

**跳过原因:** P2 不修复。当前所有 action handler 均为同步或轻量操作，signal 不透传无实际影响。

### P2-3: import 顺序不完全遵循规范

**跳过原因:** P2 不修复。属于纯代码风格问题，无功能影响。

### P2-4: @earendil-works/pi-ai 标记 optional 但代码中无条件使用

**跳过原因:** P2 不修复。语义偏差但无实际运行时影响（SDK 通过 monorepo 间接提供）。

## 修复验证

| 验证项 | 命令 | 结果 |
|--------|------|------|
| TypeScript 类型检查 | `cd extensions/model-switch && npx tsc --noEmit` | ✅ 通过，无错误 |
| 单元测试 | `cd extensions/model-switch && npx vitest run tests/resolveModelForScene.test.ts` | ✅ 7/7 通过 |
| 代码逻辑 | 手动 review 修改前后行为 | ✅ 行为完全不变 |

## 修改文件清单

| 文件 | 修改类型 |
|------|----------|
| `extensions/model-switch/package.json` | 添加 2 个 peerDependencies 声明 |
| `extensions/model-switch/src/config.ts` | export 增加 `CONFIG_DIR` |
| `extensions/model-switch/src/setup.ts` | 删除重复常量定义 + 调整 import |
| `extensions/model-switch/src/index.ts` | 修改 `ToolRes.details` 类型 |

## 风险评估

- **P1-1**: 风险极低。仅添加声明，未删除任何内容，不影响依赖解析。
- **P1-2**: 风险低。常量值完全相同，仅从两处来源变为单一来源，外部行为零变化。
- **P1-3**: 风险低。类型从最严格 (`Record<string, never>`) 放宽为更通用 (`Record<string, unknown>`)，但 `res()` 仍返回 `details: {}`，所有 handler 行为不变。

**总体风险等级:** 低
**建议合并策略:** 3 个修复相互独立，可分开提交，也可合并为一个 commit。建议 commit message:

```
fix(model-switch): address P1 audit findings

- Add missing peerDependencies for typebox and @mariozechner/pi-ai
- Dedupe CONFIG_DIR/CONFIG_PATH between config.ts and setup.ts
- Loosen ToolRes.details from Record<string, never> to Record<string, unknown>
  (kept non-optional due to SDK AgentToolResult<T> contract)
```

## 未触达的 P2 改进

如未来需要处理 P2 问题，建议优先级：

1. **P2-1** 拆 `before_agent_start` 处理器为 `buildInjection()`（影响代码可读性）
2. **P2-4** 修正 `@earendil-works/pi-ai` 的 `optional: true` 标记（语义准确性）
3. **P2-3** 调整 import 顺序（纯风格）
4. **P2-2** signal 透传（如未来引入真实异步 I/O）

---

*修复日期: 2025-07-14*
*修复者: code-fix-engineer*
*关联审查报告: docs/extension-audit/model-switch.md*
