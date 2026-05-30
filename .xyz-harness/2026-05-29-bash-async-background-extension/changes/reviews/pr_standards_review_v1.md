---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T12:00:00"
  target: "bash-async/"
  verdict: fail
  summary: "编码规范审查完成，第1轮，3条MUST FIX，需修改后重审"

statistics:
  total_issues: 10
  must_fix: 3
  low: 4
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "bash-async/src/index.ts:70"
    title: "行内 import type 违反 no-inline-import-type 规则"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "bash-async/src/index.ts:68-70"
    title: "闭包变量在 session_start 前可能未初始化"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "bash-async/src/index.ts:79"
    title: "session_shutdown 检查 jobs 真值性不够，config/shellCtx 同样未检查"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "bash-async/src/spawn.ts:378"
    title: "taste/no-silent-catch: catch 块只有 console 调用"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "bash-async/src/index.ts:140-161"
    title: "renderCall/theme 和 renderResult/theme 使用 as unknown 强转"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "bash-async/src/shell.ts:29"
    title: "buildShellEnv 返回值 as Record<string, string> 不安全"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "bash-async/src/jobs.ts:36-42"
    title: "updateJobStatus 静默忽略不存在的 jobId"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "bash-async/src/spawn.ts:231"
    title: "NEVER_RESOLVES 悬空 Promise 无法被 GC"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "bash-async/tests/integration.test.ts:1-528"
    title: "测试内联重实现而非导入源模块"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "docs/adr/010-bash-override-vs-independent-tool.md:25"
    title: "ADR 称 Pi 不导出 getShellConfig，但 shell.ts 实际导入了它"
    status: open
    raised_in_round: 1
    resolved_in_round: null

---

# 编码规范审查 v1

## 评审记录
- 评审时间：2026-05-30 12:00
- 评审类型：编码评审（dev 模式）
- 评审对象：bash-async 扩展全部新增文件（9 文件）

## Phase A: 自动化检查结果

### TypeScript 类型检查 (`tsc --noEmit`)

✅ **通过** — 0 errors。bash-async 所有文件类型检查通过。

### ESLint 品味检查 (`eslint "bash-async/src/**/*.ts"`)

✅ **0 errors, 14 warnings**（全部为 `no-magic-numbers` warning + 1 个 `taste/no-silent-catch`）。

未发现 `no-explicit-any`、`prefer-allsettled`、`no-unbounded-while-true` 等 error 级别问题。

### 总结

自动化检查全部通过。下面逐条对照 CLAUDE.md 规范进行人工审查。

---

## Phase B: CLAUDE.md 规范逐条对比

### 1. 架构约束

| 规范条目 | 结论 | 说明 |
|---------|------|------|
| 入口 `index.ts` re-export `src/index.ts` | ✅ | `bash-async/index.ts` → `export { default } from "./src/index.js"` |
| `package.json` name + main | ✅ | `"main": "index.ts"` |
| 工厂函数 `export default function xxxExtension(pi)` | ✅ | L66: `bashAsyncExtension(pi: ExtensionAPI)` |
| 状态在 `session_start` 闭包重建 | ⚠️ | L68-70: 闭包变量正确，但见 MUST_FIX #2 |
| 单文件 ≤ 1000 行 | ✅ | 最大 spawn.ts 469 行 |
| 函数 ≤ 80 行 | ✅ | 所有函数在限制内 |
| 无 `any`，用 `unknown` 或具体类型 | ✅ | 未发现 `any` 使用 |

### 2. 模块导入规范

| 规范条目 | 结论 | 说明 |
|---------|------|------|
| 使用 `@mariozechner/*` 导入 | ✅ | 所有 Pi 包导入正确 |
| 禁止 `@earendil-works/*` | ✅ | 无此类导入 |
| 禁止 `xyz-pi` | ✅ | 无此类导入 |

### 3. 代码规范

| 规范条目 | 结论 | 说明 |
|---------|------|------|
| 禁止 `any` | ✅ | 未使用 |
| 禁止行内 `import(...)` 类型 | ❌ | 见 MUST_FIX #1 |
| import 顺序：Node 内置 → npm → 项目内部 | ✅ | 所有文件遵循 |
| 命名：`XxxParams` / `XxxDetails` | ✅ | `BashAsyncParams`、`BashAsyncToolDetails` |

### 4. Tool 设计

| 规范条目 | 结论 | 说明 |
|---------|------|------|
| 参数用 typebox `Type.Object()` | ✅ | L46-62 |
| `execute` 返回 `{ content, details }` | ✅ | 所有路径 |
| 错误用 `throw new Error()` | ✅ | L107/114/120/207/221 等均使用 throw |
| 不返回错误成功模式 | ✅ | `makeErrorResult` 仅用于非异常的错误反馈 |

### 5. TUI 渲染

| 规范条目 | 结论 | 说明 |
|---------|------|------|
| `renderCall`/`renderResult` 返回 `new Text(string, 0, 0)` | ✅ | |
| 颜色通过 `theme.fg("token", text)` | ✅ | 使用 `toolTitle`/`error`/`success`/`dim`/`warning` |
| 不硬编码 ANSI | ✅ | |

### 6. Session 隔离

| 规范条目 | 结论 | 说明 |
|---------|------|------|
| 状态存于 `session_start` 闭包 | ✅ | `config`/`shellCtx`/`jobs` 均在闭包内 |
| `session_shutdown` 清理 | ✅ | L78-82 |

### 7. 运行环境

| 规范条目 | 结论 | 说明 |
|---------|------|------|
| 扩展不依赖 fs 之外的 Node 原生模块 | ❌ | 使用了 `child_process.spawn` — 但 CLAUDE.md 明确声明 subagent 是已知例外 |
| child_process 使用理由 | ✅ | ADR-010 记录了理由：`BashOperations.exec()` 的 kill-on-timeout 与 detach 需求冲突 |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | bash-async/src/index.ts:70 | **行内 `import(...)` 类型违反 `no-inline-import-type` 规则**。`Map<import("./types.js").Job["jobId"], import("./types.js").Job>` 使用了行内 import type，CLAUDE.md 明确禁止 `as import(...).Type` 模式。taste-lint 的 `no-inline-import-type` 规则禁止此模式。 | 改为顶部 `import type { Job } from "./types.js"`，然后用 `Map<Job["jobId"], Job>`。类型已在 L16 导入但使用的是 `BashAsyncParams` 等，需额外导入 `Job`。 |
| 2 | MUST FIX | bash-async/src/index.ts:68-70 | **闭包变量在 `session_start` 之前未初始化**。`let config`/`let shellCtx`/`let jobs` 声明后无初始值。如果 Pi 在 `session_start` 之前调用 `execute`（例如工具注册后立即有事件），这些变量为 `undefined`。CLAUDE.md "Session 隔离" 约束要求状态在 `session_start` 重建。虽然实际运行中 Pi 保证了 `session_start` 先于 `execute`，但 TypeScript 层面这些变量是 possibly-undefined，且 L79 的 `if (jobs)` 守卫只检查了 `jobs` 而非 `config`/`shellCtx`。 | 方案一：给初始值（`let config: BashAsyncConfig = loadConfig()`），与 session_start 逻辑一致。方案二：将 config/shellCtx/jobs 放入一个统一的 `SessionState | null` 变量，在 execute 中统一 null 检查。 |
| 3 | MUST FIX | bash-async/src/index.ts:79 | **`session_shutdown` 仅检查 `jobs` 的真值性，但 `config` 和 `shellCtx` 同样是未初始化的闭包变量**。如果 `session_shutdown` 在 `session_start` 之前被触发（异常场景），`jobs` 为 `undefined`，`if (jobs)` 通过，但 `cleanupJobs` 不会执行（正确）。然而代码意图不明确——应该统一守卫所有状态变量。 | 使用统一的 `state` 对象：`let state: SessionState | null = null`，在 session_start 中赋值，在 session_shutdown 中 `if (state) { await cleanupJobs(state.jobs); state = null; }`。 |
| 4 | LOW | bash-async/src/spawn.ts:378 | **`taste/no-silent-catch`: catch 块只有 `console.error` 调用**。`injectBackgroundResult` 的 catch 只记录日志。CLAUDE.md 的 `no-silent-catch` 规则要求 "至少设置错误状态 / toast 提示 / 重抛"。但此处的上下文是 `pi.sendMessage` 失败（session 可能已关闭），静默处理有合理理由。 | 这是边界情况（session 关闭时 sendMessage 失败是预期行为），标记为 LOW。可考虑加注释说明为何静默。 |
| 5 | LOW | bash-async/src/index.ts:140,164 | **`renderCall` 和 `renderResult` 的 `theme` 参数声明为 `unknown` 后用 `as` 强转**。`const t = theme as { fg: ...; bold: ... }`。这虽然避免了 `any`，但绕过了类型安全。 | 建议定义 `interface ThemeLike { fg(token: string, text: string): string; bold(text: string): string; }` 然后用 `theme as ThemeLike`，语义更清晰。低优先级因为其他扩展也是同样模式。 |
| 6 | LOW | bash-async/src/shell.ts:29 | **`buildShellEnv` 返回 `{ ...process.env, [pathKey]: updatedPath } as Record<string, string>`**。`process.env` 的值类型是 `string | undefined`，展开后可能有 `undefined` 值被断言为 `string`。 | 使用 `Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined))` 过滤 undefined。或使用更安全的 `{ ...process.env as Record<string, string>, ... }` 承认不完美。 |
| 7 | LOW | bash-async/src/jobs.ts:38 | **`updateJobStatus` 对不存在的 jobId 静默忽略**（`if (!job) return`）。如果调用方传了错误 ID，不会有任何反馈。 | 考虑返回 boolean 表示是否更新成功，或在调用方添加断言。不过当前所有调用方都是从已知 job 来的，风险低。 |
| 8 | INFO | bash-async/src/spawn.ts:231 | **`NEVER_RESOLVES: Promise<null> = new Promise(() => {})` 永远不 resolve**。这个 Promise 及其闭包永远不会被 GC 回收（虽然 `.unref()` 的 setTimeout 不会阻止进程退出）。 | 实际影响极小（每次 timeout=0 的 sync 调用只创建一个），但理论上可改为在 timeout=0 时不参与 race，直接 await exitPromise。 |
| 9 | INFO | bash-async/tests/integration.test.ts:1-528 | **测试内联重实现了核心函数（spawnCommand、killProcessGroup 等）而非导入源模块**。测试文件顶部注释说 "avoids Pi runtime dependency"，但这也意味着测试验证的不是实际运行的代码。 | 这是已知权衡（Pi 运行时依赖问题），但应记录在测试文件注释中：哪些行为被真正验证，哪些是逻辑推论。 |
| 10 | INFO | docs/adr/010-bash-override-vs-independent-tool.md:25 | **ADR 声称 "Pi 不导出 getShellConfig/getShellEnv"**，但 `bash-async/src/shell.ts:4` 实际导入了 `getShellConfig`。说明 Pi 实际上已导出此函数。 | 更新 ADR-010 的 Trade-off 部分：删除 "Pi 不导出 getShellConfig" 的说法，改为 "Pi 导出 getShellConfig 但不导出 getShellEnv，需自行实现环境构建"。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 结论

需修改后重审。3 条 MUST FIX 需要处理：

1. **#1 行内 import type** → 移至顶部 import
2. **#2 闭包变量未初始化** → 给初始值或统一状态对象
3. **#3 session_shutdown 守卫不完整** → 与 #2 合并修复

### Summary

编码规范审查完成，第1轮，3条MUST FIX（行内import type、闭包变量未初始化、session_shutdown守卫不完整），需修改后重审。
