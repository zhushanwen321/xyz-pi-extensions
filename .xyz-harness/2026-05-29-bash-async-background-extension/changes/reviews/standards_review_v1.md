---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T12:00:00"
  target: "bash-async/src/"
  verdict: fail
  summary: "编码规范审查，第1轮，2条MUST FIX（模块导入scope错误 + import位置错误），需修改后重审"

statistics:
  total_issues: 6
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/index.ts:15"
    title: "pi-tui 使用 @earendil-works scope 而非 @mariozechner scope"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:44"
    title: "fs import 放在函数体中间而非文件顶部"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "bash-async/src/index.ts:201"
    title: "createJobMap import 放在文件末尾而非与顶部 imports 合并"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "bash-async/src/index.ts:148,151,154,157,176"
    title: "ESLint no-magic-numbers 警告（12, 60, 2 等截断/行数常量）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "bash-async/src/jobs.ts:16,17,110"
    title: "ESLint no-magic-numbers 警告（36, 2, 5000）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "bash-async/src/index.ts:14"
    title: "残留注释 '// StringEnum available from @earendil-works/pi-ai if needed' 应清理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 编码规范审查（Standards Review）v1

## 评审记录
- 评审时间：2026-05-30 12:00
- 评审类型：编码规范审查（对比 CLAUDE.md）
- 评审对象：`bash-async/src/` 全部源代码

## Phase A: 自动化工具检查

### TypeScript 类型检查 (`npx tsc --noEmit`)

**结果：✅ PASS** — 零错误。

### ESLint 品味检查 (`npx eslint bash-async/src/`)

**结果：✅ PASS（0 errors, 14 warnings）**

全部为 `no-magic-numbers` 警告（12 处）和 1 处 `taste/no-silent-catch` 警告。无 error 级问题。

| 文件 | warnings |
|------|----------|
| `src/index.ts` | 5 (magic numbers: 12, 12, 60, 60, 2) |
| `src/jobs.ts` | 3 (magic numbers: 36, 2, 5000) |
| `src/spawn.ts` | 6 (magic numbers: 1000×3, 6000 + 1 silent-catch) |

## Phase B: CLAUDE.md 编码规范逐项检查

### 1. 模块导入 scope

| 文件 | import | scope | 合规 |
|------|--------|-------|------|
| `index.ts:13` | `ExtensionAPI` from `@mariozechner/pi-coding-agent` | `@mariozechner` | ✅ |
| `index.ts:15` | `Text` from `@earendil-works/pi-tui` | `@earendil-works` | ❌ |
| `shell.ts:4,11` | `getShellConfig` from `@mariozechner/pi-coding-agent` | `@mariozechner` | ✅ |
| `spawn.ts:2-3` | `ExtensionAPI`, `truncateTail` from `@mariozechner/pi-coding-agent` | `@mariozechner` | ✅ |

**CLAUDE.md 规定**：统一使用 `@mariozechner/*`（两个 pi 都认识的公约数）。`@earendil-works/pi-tui` 违反此规范。

### 2. `any` 类型

**结果：✅ PASS** — 全项目零 `any` 使用。`grep -n '\bany\b'` 无匹配。

### 3. 函数行数（≤ 80 行）

**结果：✅ PASS** — 最长函数为 `executeSync`（62 行），所有函数均在 80 行以内。

### 4. 文件行数（≤ 1000 行）

**结果：✅ PASS**

| 文件 | 行数 | 上限 |
|------|------|------|
| `src/types.ts` | 63 | 1000 ✅ |
| `src/shell.ts` | 74 | 1000 ✅ |
| `src/jobs.ts` | 184 | 1000 ✅ |
| `src/spawn.ts` | 402 | 1000 ✅ |
| `src/index.ts` | 201 | 1000 ✅ |
| `index.ts` | 1 | 1000 ✅ |

### 5. 命名规范

| 规范要求 | 实际 | 合规 |
|----------|------|------|
| 扩展入口 `export default function xxxExtension` | `export default function bashAsyncExtension` | ✅ |
| 状态接口 `XxxRuntimeState` | N/A（无独立状态接口） | ✅ |
| 工具参数 `XxxParams` | `BashAsyncParams` | ✅ |
| 工具详情 `XxxDetails` | `BashAsyncToolDetails` | ✅ |

### 6. TUI 渲染 — 语义 theme token

**结果：✅ PASS** — 所有颜色使用语义 token：

| Token | 用途 |
|-------|------|
| `"toolTitle"` | bash 工具名 |
| `"error"` | 错误标题 |
| `"success"` | 成功标题 |
| `"dim"` | 元数据行 |
| `"warning"` | 截断提示 |

无硬编码 ANSI 转义码。

### 7. import 顺序（Node 内置 → npm 包 → 项目内部）

**结果：❌ 有问题**

- `spawn.ts:44` — `import * as fs from "node:fs"` 出现在函数体中间（第 44 行），而非与顶部 Node 内置 imports 合并。注释 `// Need fs import at top — add it` 自我标注了这是遗留问题但未修复。
- `index.ts:201` — `import { createJobMap } from "./jobs.js"` 出现在文件最后一行（工厂函数结束后），而非顶部 import 区域。

### 8. Session 隔离

**结果：✅ PASS** — `jobs` map 在 `session_start` 闭包中通过 `createJobMap()` 重建，`config` 和 `shellCtx` 同样。无模块级可变共享状态。

### 9. child_process 使用

**结果：✅ PASS** — bash-async 使用 `child_process.spawn` 进行进程管理，这与 CLAUDE.md 中记录的 subagent 例外模式一致（"subagent 和 evolution-engine 是已知例外"）。bash-async 是类似场景（进程管理），属于合理例外。

### 10. Tool 设计规范

| 规范 | 实际 | 合规 |
|------|------|------|
| 参数用 typebox `Type.Object()` | ✅ `bashAsyncSchema` | ✅ |
| `execute` 返回 `{ content, details }` | ✅ `ToolResult` 接口 | ✅ |
| 错误用 `throw new Error()` | ✅ 全部使用 throw | ✅ |
| 不返回错误成功模式 | ✅ `isError` 字段仅在 `makeErrorResult` 中使用 | ✅ |

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | `bash-async/src/index.ts:15` | `import { Text } from "@earendil-works/pi-tui"` 使用了 `@earendil-works` scope。CLAUDE.md 明确规定统一使用 `@mariozechner/*` 作为两版 Pi 的公约数 | 改为 `import { Text } from "@mariozechner/pi-tui"` |
| 2 | MUST FIX | `bash-async/src/spawn.ts:44` | `import * as fs from "node:fs"` 放在函数定义之间（L44），违反 import 应在文件顶部的规范。且注释 `// Need fs import at top — add it` 自我标注未完成 | 将 fs import 移到文件顶部，与其他 Node 内置 imports（L1 `child_process`）合并 |
| 3 | LOW | `bash-async/src/index.ts:201` | `import { createJobMap } from "./jobs.js"` 放在文件最末尾，属于 import 顺序问题 | 移到文件顶部 import 区域 |
| 4 | LOW | `bash-async/src/index.ts` | ESLint 5 个 no-magic-numbers 警告（12, 12, 60, 60, 2）— 截断长度和显示行数未语义化命名 | 提取为命名常量如 `JOB_ID_DISPLAY_LEN = 12`, `CMD_PREVIEW_LEN = 60`, `COLLAPSED_LINES = 2` |
| 5 | LOW | `bash-async/src/jobs.ts` | ESLint 3 个 no-magic-numbers 警告（36, 2, 5000）— 时间戳基数、随机字节、等待毫秒 | 提取为 `TIMESTAMP_RADIX = 36`, `RANDOM_BYTES = 2`, `SIGTERM_WAIT_MS = 5000` |
| 6 | INFO | `bash-async/src/index.ts:14` | 残留注释 `// StringEnum available from @earendil-works/pi-ai if needed` — 未使用的 import 提示，应清理 | 删除该行注释 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 结论

需修改后重审。2 条 MUST FIX 均为 import 规范问题，修复简单。

### Summary

编码规范审查完成，第1轮，2条MUST FIX（@earendil-works scope + import 位置），需修改后重审。
