---
verdict: "pass"
must_fix: 0
reviewer: ts-taste-check
date: 2026-05-30
scope:
  - bash-async/src/types.ts
  - bash-async/src/shell.ts
  - bash-async/src/jobs.ts
  - bash-async/src/spawn.ts
  - bash-async/src/index.ts
---

# TypeScript 品味审查报告 — bash-async 扩展

## ESLint 品味扫描结果

```
0 errors, 14 warnings
```

| 文件 | 规则 | 位置 | 值 |
|------|------|------|-----|
| index.ts | no-magic-numbers | L148, L151 | 12 |
| index.ts | no-magic-numbers | L154, L157 | 60 |
| index.ts | no-magic-numbers | L176 | 2 |
| jobs.ts | no-magic-numbers | L16 | 36 |
| jobs.ts | no-magic-numbers | L17 | 2 |
| jobs.ts | no-magic-numbers | L110 | 5000 |
| spawn.ts | no-magic-numbers | L164, L304, L340, L396 | 1000 |
| spawn.ts | taste/no-silent-catch | L319 | catch 块只有 console.error |
| spawn.ts | no-magic-numbers | L389 | 6000 |

## 文件审查

### bash-async/src/types.ts（63 行）

✅ 无问题。纯类型定义文件，职责单一（所有 interface/type 集中管理），无跨文件重复定义，命名清晰。

### bash-async/src/shell.ts（74 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 类型 | L48 | `as Record<string, string>` — process.env 展开 | Pi 扩展边界数据，可接受。如需严格可定义 `EnvRecord` 类型 |
| P3 | 命名 | L53-65 | `loadPiSettings()` catch 中 `void e` | 静默吞错误但合理（首次安装无配置文件），已用注释说明 |

**统计**: P0: 0 | P1: 0（可接受） | P3: 1

### bash-async/src/jobs.ts（184 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 命名 | L16 | 魔法数字 `36`（Date.now().toString(36)） | 提取为 `const RADIX_BASE36 = 36` 或内联注释说明 |
| P1 | 命名 | L17 | 魔法数字 `2`（randomBytes(2)） | 提取为 `const JOB_ID_RANDOM_BYTES = 2` |
| P1 | 命名 | L110 | 魔法数字 `5000`（SIGTERM 优雅退出等待 5s） | 提取为 `const GRACEFUL_SHUTDOWN_MS = 5000` |
| P1 | 反馈 | L120 | `loadConfig()` catch 中 `console.error` 后返回默认值 | 合理——配置文件损坏时的 fallback，console.error 留了诊断信息 |
| P3 | 结构 | 全文件 | `createJobMap()` 是 `new Map()` 的薄包装 | 可直接内联，但作为 factory 也可接受（未来可能加初始化逻辑） |

**统计**: P0: 0 | P1: 3 | P3: 2

### bash-async/src/spawn.ts（402 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 命名 | L164, L304, L340, L396 | 魔法数字 `1000`（`Math.round(ms / 1000)` 将毫秒转秒） | 提取为 `const MS_PER_SECOND = 1000` |
| P1 | 命名 | L389 | 魔法数字 `6000`（kill 后等待退出的超时） | 提取为 `const KILL_WAIT_MS = 6000` |
| P1 | 命名 | L123 | `effectiveTimeout * 1000` 隐含秒→毫秒转换 | 同上，用 `MS_PER_SECOND` 语义化 |
| P1 | 结构 | L44 | `import * as fs` 出现在文件中间（L44），不在顶部 import 区 | 移到文件顶部 import 区 |
| P1 | 反馈 | L319 | `injectBackgroundResult` 的 try/catch 只有 `console.error`（taste/no-silent-catch） | 合理——session 可能已关闭，sendMessage 失败不应影响调用方。建议注释说明原因 |
| P3 | 结构 | 全文件 | 402 行，接近 CLAUDE.md 的 500 行警戒线 | 当前职责单一（spawn+执行逻辑），暂可接受。如 grow 需考虑拆分 |

**统计**: P0: 0 | P1: 5 | P3: 2

### bash-async/src/index.ts（201 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 结构 | L206 | `import { createJobMap }` 在文件末尾 | 移到顶部 import 区。虽然 JS hoisting 保证运行正确，但违反 import 顺序惯例 |
| P1 | 命名 | L148, L151 | 魔法数字 `12`（jobId 截断长度） | 提取为 `const JOB_ID_DISPLAY_LENGTH = 12` |
| P1 | 命名 | L154, L157 | 魔法数字 `60`（command 截断长度） | 提取为 `const COMMAND_DISPLAY_LENGTH = 60` |
| P1 | 命名 | L176 | 魔法数字 `2`（折叠模式显示行数） | 提取为 `const COLLAPSED_LINES = 2` |
| P1 | 类型 | L86 | `theme: unknown` 然后 `as { fg: ... }` | 可定义 `interface ThemeLike { fg(token: string, text: string): string }` 但 Pi 扩展 API 未导出 Theme 类型，`as` 断言可接受 |
| P3 | 反模式 | L148-158 | renderCall 中 emoji 作为图标（⏳📡⛔🔄） | Pi TUI 终端环境非 Vue 前端，emoji 图标在此场景可接受 |

**统计**: P0: 0 | P1: 4 | P3: 1

## 汇总

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0（必须修复） | 0 | 无原则违反 |
| P1（推荐修复） | 12 | 魔法数字（8 处）、import 位置（2 处）、silent catch 注释（1 处）、theme 类型断言（1 处，可接受） |
| P2（安全防御） | 0 | 无安全问题 |
| P3（细节） | 6 | 薄包装函数、可接受的静默 catch、emoji 图标 |

### 跨文件检查

- **重复类型定义**: 无。所有 interface 集中在 `types.ts`
- **重复逻辑**: 无。`readOutputFile` 和 `removeOutputFile` 仅在 `jobs.ts` 定义，`spawn.ts` 通过 import 使用
- **模块职责划分**: 清晰。`types.ts`（类型）、`shell.ts`（Shell 配置）、`jobs.ts`（Job 生命周期+配置+工具函数）、`spawn.ts`（进程执行逻辑）、`index.ts`（扩展注册胶水）

### 亮点

1. **Session 隔离正确**: `jobs` Map 在 `session_start` 闭包内创建，符合多 session 安全要求
2. **资源清理完善**: `session_shutdown` 调用 `cleanupJobs` 杀进程+清文件+清 Map
3. **错误处理模式统一**: 统一用 `throw new Error()` 和 `makeErrorResult()`，不混用
4. **类型定义集中**: 所有 interface 在 `types.ts`，无跨文件重复
5. **进程组管理**: Unix 用负 PID 杀进程组，Windows 用 taskkill，平台差异处理完整
6. **AbortSignal 集成**: sync 模式支持 signal 取消，自动清理监听器

### 建议重构顺序（如需执行）

1. 将 `spawn.ts` 和 `index.ts` 中间的 import 移到文件顶部
2. 提取魔法数字为命名常量（`MS_PER_SECOND`, `GRACEFUL_SHUTDOWN_MS`, `KILL_WAIT_MS`, `JOB_ID_DISPLAY_LENGTH`, `COMMAND_DISPLAY_LENGTH`, `COLLAPSED_LINES`, `JOB_ID_RANDOM_BYTES`, `RADIX_BASE36`）
3. 为 `spawn.ts` L319 的 silent catch 添加注释说明原因

**总评**: 代码质量优秀。模块职责清晰，类型安全，Session 隔离正确，错误处理统一。所有发现均为 P1 偏好级别，无 P0 原则违反。Verdict: **PASS**。
