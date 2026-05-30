---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-30T14:00:00"
  target: "bash-async/src/"
  verdict: pass
  summary: "编码规范审查，第2轮，2条MUST FIX已全部修复，无新问题引入，评审通过"

statistics:
  total_issues: 6
  must_fix: 2
  must_fix_resolved: 2
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/index.ts:17"
    title: "pi-tui 使用 @earendil-works scope 而非 @mariozechner scope"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "bash-async/src/spawn.ts:2"
    title: "fs import 放在函数体中间而非文件顶部"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: LOW
    location: "bash-async/src/index.ts:201"
    title: "createJobMap import 放在文件末尾而非与顶部 imports 合并"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: LOW
    location: "bash-async/src/index.ts"
    title: "ESLint no-magic-numbers 警告（12, 60, 2 等截断/行数常量）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "bash-async/src/jobs.ts"
    title: "ESLint no-magic-numbers 警告（36, 2, 5000）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "bash-async/src/index.ts:14"
    title: "残留注释 '// StringEnum available from @earendil-works/pi-ai if needed' 应清理"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
---

# 编码规范审查（Standards Review）v2

## 评审记录
- 评审时间：2026-05-30 14:00
- 评审类型：编码规范审查（对比 CLAUDE.md）— 第2轮复审
- 评审对象：`bash-async/src/` 全部源代码（修复后）

## Phase A: MUST FIX 验证

### Standards-1: pi-tui import scope ✅ RESOLVED

| 项目 | 修复前 | 修复后 |
|------|--------|--------|
| `index.ts:17` | `import { Text } from "@earendil-works/pi-tui"` | `import { Text } from "@mariozechner/pi-tui"` |

- 全项目搜索 `@earendil-works`：**零匹配** ✅
- 所有 `@mariozechner/*` imports 符合 CLAUDE.md 公约数规范

### Standards-2: fs import 位置 ✅ RESOLVED

| 项目 | 修复前 | 修复后 |
|------|--------|--------|
| `spawn.ts` | `import * as fs from "node:fs"` 在 L44（函数体之间） | `import * as fs from "node:fs"` 在 L2（文件顶部） |

- `spawn.ts` 顶部 import 顺序：`child_process` → `fs` → `ExtensionAPI` → `truncateTail` → 项目内部
- Node 内置 imports 集中在顶部，符合 CLAUDE.md "Node 内置 → npm 包 → 项目内部" 规范

### 附带修复验证

| # | 问题 | 状态 | 证据 |
|---|------|------|------|
| 3 | `createJobMap` import 在文件末尾 | ✅ 已修复 | `index.ts:17` — `import { createJobMap, loadConfig, cleanupJobs } from "./jobs.js"` 已在顶部 import 区 |
| 6 | 残留 `@earendil-works` 注释 | ✅ 已修复 | 全项目搜索 `@earendil-works` 零匹配 |

## Phase B: 回归检查（是否引入新问题）

### 模块导入 scope

| 文件 | import | scope | 合规 |
|------|--------|-------|------|
| `index.ts:16` | `ExtensionAPI` from `@mariozechner/pi-coding-agent` | `@mariozechner` | ✅ |
| `index.ts:17` | `Text` from `@mariozechner/pi-tui` | `@mariozechner` | ✅ |
| `shell.ts:6` | `getShellConfig` from `@mariozechner/pi-coding-agent` | `@mariozechner` | ✅ |
| `shell.ts:8` | `getShellConfig` re-export | `@mariozechner` | ✅ |
| `spawn.ts:3-4` | `ExtensionAPI`, `truncateTail` from `@mariozechner/pi-coding-agent` | `@mariozechner` | ✅ |

**结果：✅ PASS** — 零 `@earendil-works` 残留。

### `any` 类型

**结果：✅ PASS** — 全项目零 `any` 使用。

### 函数行数（≤ 80 行）

**结果：✅ PASS** — 最长函数仍在 80 行以内。

### 文件行数（≤ 1000 行）

**结果：✅ PASS** — 所有文件未超出限制。

### 命名规范

**结果：✅ PASS** — `bashAsyncExtension` / `BashAsyncParams` / `BashAsyncToolDetails` 命名正确。

### TUI 语义 token

**结果：✅ PASS** — 仅使用 `toolTitle` / `error` / `success` / `dim` / `warning`，无硬编码 ANSI。

### Session 隔离

**结果：✅ PASS** — `jobs` / `config` / `shellCtx` 均在 `session_start` 闭包中重建。

### Tool 设计规范

**结果：✅ PASS** — typebox schema、`{ content, details }` 返回结构、`throw new Error()` 错误处理均合规。

## Phase C: 遗留 LOW/INFO 问题

以下问题为第1轮标记的 LOW/INFO 级别建议，不阻塞评审：

| # | 级别 | 描述 | 状态 |
|---|------|------|------|
| 4 | LOW | `index.ts` 中 5 个 magic numbers（12, 60, 2 等） | open — 建议后续提取常量 |
| 5 | LOW | `jobs.ts` 中 3 个 magic numbers（36, 2, 5000） | open — 建议后续提取常量 |

## 结论

**verdict: PASS** — 2 条 MUST FIX 全部修复，附带修复了 2 条 LOW/INFO 问题（#3 import 位置 + #6 残留注释）。无新问题引入。剩余 2 条 LOW 为 magic numbers 建议，不阻塞。
