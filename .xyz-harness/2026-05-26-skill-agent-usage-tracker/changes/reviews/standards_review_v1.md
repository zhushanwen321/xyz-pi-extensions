---
verdict: fail
must_fix: 1
linter_passed: true
typecheck_passed: true
review_metrics:
  files_reviewed: 1
  issues_found: 3
  must_fix_count: 1
  low_count: 2
  info_count: 0
  duration_estimate: "3"
---

# Standards Review v1

## 审查记录
- 审查时间：2026-05-27 18:00
- 项目路径：/Users/zhushanwen/Code/xyz-pi-extensions-workspace/main
- 审查范围：usage-tracker/src/index.ts
- Phase A（自动检查）：已执行
- Phase B（AI 规范对比）：已执行

## Phase A: 自动化检查结果

### Lint

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx eslint "usage-tracker/src/**/*.ts"` |
| 退出码 | 0 |
| Errors | 0 |
| Warnings | 2 |
| 状态 | ✅ 通过（0 error, 2 warning） |

#### Lint Warnings 明细

| # | 规则 | 位置 | 说明 |
|---|------|------|------|
| W1 | `no-magic-numbers` | usage-tracker/src/index.ts:60 | `JSON.stringify(stats, null, 2)` — 缩进参数 2 为魔法数字 |
| W2 | `taste/no-silent-catch` | usage-tracker/src/index.ts:61 | `incrementAndPersist` 的 catch 块仅输出 console.error，未传播错误 |

### Typecheck

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx tsc --noEmit` |
| 退出码 | 1 |
| State | ✅ 通用于 usage-tracker（0 类型错误来自 usage-tracker 文件） |

**说明：** 项目的 tsc --noEmit 报告的错误均来自 goal/ 和 subagent/ 扩展（缺失 `@types/node`、`@mariozechner/*` 包类型声明）。usage-tracker/src/index.ts 本身无类型错误。该问题为已知基础设施限制（CLAUDE.md 已注明"扩展没有自己的 node_modules，本地开发时 tsc --noEmit 通过 paths 映射到全局安装的 Pi 包获取类型"），不属于 usage-tracker 代码规范问题。故 typecheck 针对审查范围判定为通过。

## Phase B: CLAUDE.md 规范对比

### 规范检查矩阵

| # | 规范条目 | 来源（CLAUDE.md 章节） | 适用范围 | 检查结果 | 违规位置 |
|---|---------|------------------------|---------|---------|---------|
| 1 | 禁止 `any`，用 `unknown` 或具体类型 | TypeScript | usage-tracker/src/index.ts | ✅ 符合 | — |
| 2 | `(entry as any).customType` 改为类型守卫函数 | TypeScript | usage-tracker/src/index.ts | ✅ 符合（无此模式） | — |
| 3 | import 顺序：Node 内置 → npm 包 → 项目内部 | TypeScript | usage-tracker/src/index.ts:1-7 | ❌ 不符合 | index.ts:1-4 |
| 4 | 单文件不超过 1000 行 | 行数 | usage-tracker/src/index.ts (~130 行) | ✅ 符合 | — |
| 5 | 函数不超过 80 行 | 行数 | usage-tracker/src/index.ts | ✅ 符合 | — |
| 6 | 扩展入口命名：`export default function xxxExtension` | 命名 | usage-tracker/src/index.ts:103 | ✅ 符合（usageTrackerExtension） | — |
| 7 | Session 隔离：状态存储在 `session_start` 闭包内 | Session 隔离 | usage-tracker/src/index.ts | ✅ 符合（skillMap/initialized 在闭包内） | — |
| 8 | 错误用 `throw new Error()`，不用错误成功模式 | Tool 设计 | usage-tracker/src/index.ts | ➖ 不适用（无 tool execute） | — |
| 9 | 禁止依赖 `fs` 之外的原生模块 | 运行环境 | usage-tracker/src/index.ts | ✅ 符合（仅用 fs/os/path） | — |
| 10 | `no-silent-catch` — catch 不能为空或只有 console | 品味规则 | usage-tracker/src/index.ts:61 | ❌ 不符合 | index.ts:61-63 |
| 11 | `no-magic-numbers` — 语义化命名（0/1/-1 豁免） | 品味规则 | usage-tracker/src/index.ts:60 | ❌ 不符合 | index.ts:60 |

### 逐条说明

#### 问题 B1 — import 顺序错误

**规则：** import 顺序必须为 "Node 内置 → npm 包 → 项目内部"

**代码：**
```typescript
// 第 1 行（npm 包）
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// 第 3-7 行（Node 内置）
import { existsSync, readFileSync, writeFileSync } from "node:fs";
```

**判定：** 违反规范。npm 包应排在 Node 内置之后。

**严重度：** LOW — 风格问题，不影响功能

---

#### 问题 B2 — `taste/no-silent-catch`（W2 升级）

**规则：** `catch` 块不能为空或只有 `console`，底层错误应传播给调用方

**代码（index.ts:57-63）：**
```typescript
function incrementAndPersist(category: "skills" | "agents", name: string): void {
	try {
		// ...
		writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8");
	} catch (err) {
		console.error(`${LOG_PREFIX} Failed to write stats: ${err}`, STATS_FILE);
	}
}
```

**问题：** `incrementAndPersist` 返回 `void`，catch 仅做日志记录，调用方无法感知写入失败。函数名为 "persist" 却不能保证持久化成功，存在隐式数据丢失风险。

**严重度：** MUST_FIX — 由 Phase A warning 升级（CLAUDE.md 中 `no-silent-catch` 列为品味规则，按约定升级为 MUST_FIX）

**修改建议：** 至少让调用方能感知失败（二选一）：
- 将函数改为返回 `boolean`：`try { ... return true } catch { ... return false }` 
- 或由调用方传入错误回调

---

#### 问题 B3 — 魔法数字 `2`（W1）

**规则：** `no-magic-numbers` — 语义化命名（0/1/-1 豁免）

**代码（index.ts:60）：**
```typescript
writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8");
```

**问题：** `JSON.stringify` 的缩进参数 `2` 为魔法数字。虽然 2 是常见缩进值，但 0/1/-1 是豁免的，2 不在豁免范围内。

**严重度：** LOW — 建议修复

**修改建议：** 提取为常量（可与 STATS_FILE 等常量放在一起）：
```typescript
const JSON_INDENT = 2;
```

---

## 问题清单

| # | 严重度 | Phase | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-------|------|------|------|---------|
| 1 | MUST_FIX | B | `incrementAndPersist` 的 catch 块仅 console，未传播错误（taste/no-silent-catch） | usage-tracker/src/index.ts | 61-63 | 返回 boolean 或传入错误回调 |
| 2 | LOW | A | 魔法数字 `2`（no-magic-numbers） | usage-tracker/src/index.ts | 60 | 提取为 `JSON_INDENT` 常量 |
| 3 | LOW | B | import 顺序违反规范（npm 包在 Node 内置前） | usage-tracker/src/index.ts | 1-4 | 调整 import 顺序 |

## 结论

**verdict: fail** — 存在 1 项 MUST_FIX 问题。

**需修改：**
1. **MUST_FIX**: 修复 `incrementAndPersist` 的静默 catch，让调用方能感知写入失败
2. **LOW**: 提取魔法数字 `2` 为常量
3. **LOW**: 调整 import 顺序

修复后需第 2 轮重审确认问题已关闭。
