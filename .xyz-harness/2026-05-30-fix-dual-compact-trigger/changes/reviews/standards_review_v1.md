---
verdict: pass
must_fix: 0
---

# Standards Review v1 — fix-dual-compact-trigger

**审查范围**: `infinite-context/src/index.ts`, `infinite-context/src/compression-runner.ts`
**审查基准**: CLAUDE.md 编码规范 + 品味规则 (taste-lint)

## Phase A: 自动检查（已确认通过）

| 检查项 | 结果 |
|--------|------|
| TypeScript typecheck | 0 errors |
| ESLint | 0 errors, 4 warnings (pre-existing) |

## Phase B: AI 规范对比

### 1. Import 顺序

**规范**: Node 内置 → npm 包 → 项目内部

| 文件 | 结果 |
|------|------|
| `index.ts` | `@mariozechner/pi-coding-agent` → `@mariozechner/pi-tui` → `./segment-tracker` 等。**符合** |
| `compression-runner.ts` | `@mariozechner/pi-coding-agent` → `./tree-compactor` → `./types`。**符合** |

### 2. 模块导入 scope

**规范**: 统一使用 `@mariozechner/*`，禁止 `@earendil-works/*` 或 `xyz-pi`

- 两个文件所有 import 均使用 `@mariozechner/pi-coding-agent` 和 `@mariozechner/pi-tui`。**符合**

### 3. `any` 类型检查

**规范**: 禁止 `any`，用 `unknown` 或具体类型

- 两个文件中无 `any` 使用。所有类型标注使用具体类型（`ContextEvent`, `SessionBeforeCompactEvent`, `CompactResult` 等）或 `unknown`（事件参数的宽类型）。**符合**

### 4. 错误处理

**规范**: 错误用 `throw new Error()`，不返回错误成功模式；catch 块不能为空或只有 console

- `createBeforeCompactHandler`: catch 块中 `console.error` + 返回 fallback `{ cancel: false }`。**符合** — catch 既有日志也有控制流返回。
- `createSessionStartHandler`, `createTurnEndHandler`, `createContextHandler`: catch 块均有 `console.error`。**符合**
- taste-lint `no-silent-catch`: 所有 catch 块有实质性操作。**符合**

### 5. `console.log` 使用

**规范**: infinite-context 扩展禁止 `console.log`，改用 `console.error`

- 两个文件中无 `console.log`。所有日志使用 `console.error`。**符合**

### 6. 函数长度

**规范**: 函数不超过 80 行（taste-lint max-lines-per-function: 300）

| 函数 | 行数 | 结果 |
|------|------|------|
| `createBeforeCompactHandler` | 42 | **符合** |
| `createContextHandler` | 30 | **符合** |
| `beforeCompressionUI` | 20 | **符合** |
| `afterCompressionUI` | 21 | **符合** |
| `compressSync` | 15 | **符合** |
| 其余函数 | < 20 | **符合** |

### 7. 文件长度

**规范**: 单文件不超过 1000 行

| 文件 | 行数 | 结果 |
|------|------|------|
| `index.ts` | 171 | **符合** |
| `compression-runner.ts` | 104 | **符合** |

### 8. 命名规范

**规范**: 状态接口 `XxxRuntimeState`, 工具参数 `XxxParams`, 工具详情 `XxxDetails`, 扩展入口 `export default function xxxExtension`

- 入口函数: `export default function infiniteContextExtension`。**符合**
- 新增函数命名: `compressForCompaction`, `buildTreeSummary`, `createBeforeCompactHandler` — 均为语义化 camelCase。**符合**

### 9. Handler 注册 / Pi Extension API 规范

**规范**: `pi.on()` 事件处理器保持简短，复杂逻辑提取到命名函数

- `session_before_compact` handler 由工厂函数 `createBeforeCompactHandler` 创建，逻辑清晰分段（guard → try/catch → fallback → build summary → return compaction）。**符合**
- `turn_end` handler 不再触发压缩（移除 `needsCompressionRef`），仅做 tracker 同步。**符合**
- `context` handler 同理，移除了压缩触发逻辑。**符合**
- Handler 内部 `compressForCompaction` 返回结构化 `CompactResult | null`，调用方基于返回值做决策。**符合**

### 10. Session 隔离

**规范**: 状态必须存储在闭包变量或 `ctx.sessionManager` entries 中

- `tracker`, `compactor`, `assembler` 在工厂函数闭包内创建。`needsCompressionRef` 已移除（不再需要共享可变状态）。**符合** — 比重构前更好，消除了一个跨 handler 的可变引用。

### 11. 未使用参数标记

- `createTurnEndHandler` 中 `_compactor` 和 `_assembler` 使用下划线前缀标记未使用参数。**合理** — TypeScript 的标准惯例，参数保留以备将来需要。

## 变更摘要

核心改动是将压缩触发点从 `turn_end` + `context` 双触发（通过 `needsCompressionRef` 共享标志）统一为 `session_before_compact` 单触发。具体：

1. **index.ts**: 移除 `needsCompressionRef`，新增 `createBeforeCompactHandler`（从 `_tracker` stub 升级为完整实现），新增 `buildTreeSummary` 辅助函数，`turn_end`/`context` handler 不再触发压缩。
2. **compression-runner.ts**: 新增 `compressForCompaction` 导出（返回 `CompactResult | null`），原 `compressAsync` 改为委托给 `compressForCompaction`。

## 结论

**verdict: pass**

所有规范检查项均通过。变更逻辑清晰，消除了跨 handler 的可变状态（`needsCompressionRef`），将压缩触发统一到 Pi 的 `session_before_compact` 生命周期钩子，架构上更合理。
