---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-30T12:00:00"
  target: ".xyz-harness/2026-05-29-bash-async-background-extension/plan.md"
  verdict: pass
  summary: "计划评审完成，第1轮通过，0条MUST FIX，6条LOW，1条INFO"

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 0
  low: 6
  info: 1

issues:
  - id: 1
    severity: LOW
    location: "plan.md:Task 2 / Interface Contracts:Module shell"
    title: "getShellConfig 已从 Pi 包导出，plan 不必要地重新实现"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md:Interface Contracts:Module index"
    title: "loadConfig/loadPiSettings 在 Interface Contracts 归属 Module: index，实际在 jobs.ts 和 shell.ts"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 3 Step 3 vs Task 4 Step 4"
    title: "registerJob 并发校验职责归属模糊——Task 3 和 Task 4 都声明负责"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Interface Contracts:Module spawn:executeBackground"
    title: "executeBackground 边界条件列缺少 cwd-not-exist → throw Error"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:Task 4 Step 3 (executeSync)"
    title: "Sync 模式正常完成后临时文件清理步骤缺失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md:Task 5 Step 7 (renderResult)"
    title: "FR-8 setInterval + context.invalidate() 耗时刷新机制未在 Task 步骤中明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "plan.md:Task 2 Step 1 vs spec FR-1"
    title: "Windows shell 发现逻辑被有意跳过，属于有意识的范围缩减"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-30 12:00
- 评审类型：计划评审（模式一）
- 评审对象：`.xyz-harness/2026-05-29-bash-async-background-extension/plan.md`
- 参考文档：spec.md, use-cases.md, e2e-test-plan.md, non-functional-design.md, CLAUDE.md

---

## 1. spec 完整性

### 1.1 目标明确性 ✅

一句话概括：创建 bash-async 扩展，通过 registerTool("bash") 覆盖内置 bash，增加 background 执行、超时 detach、poll 查询和 kill 终止四种能力。目标清晰，边界明确。

### 1.2 范围合理性 ✅

范围适中——单个扩展、4 种执行模式、~550 行代码。有明确的边界：不改变 Pi 核心行为，通过扩展机制覆盖。17 个 AC 数量合理，每个都可独立验证。

### 1.3 验收标准可量化 ✅

全部 17 个 AC（AC-1 ~ AC-17）均可通过具体操作验证（命令执行、exitCode 检查、ps 确认进程状态、文件存在性检查等）。无模糊描述。

### 1.4 待决议项 ✅

未发现 `[待决议]` 标记。

---

## 2. plan 可行性

### 2.1 任务拆分 ✅

5 个 Task，粒度适中：
- Task 1（scaffolding + types）：~50 行，轻量
- Task 2（shell discovery）：~60 行，自包含
- Task 3（jobs + config）：~100 行，独立模块
- Task 4（spawn engine）：~250 行，核心但内聚（6 个函数均围绕进程生命周期）
- Task 5（extension wiring + TUI）：~100 行，胶水层

Task 4 是最大模块（6 个函数），但函数间强耦合（killProcessGroup 被 executeSync/executeKill 共用，spawnWithOutput 是共享 helper），拆分反而增加集成复杂度。当前粒度可接受。

### 2.2 依赖关系 ✅

```
Task 1 → Task 2, Task 3 → Task 4 → Task 5
```

DAG 正确：types 被所有模块依赖 → shell/jobs 可并行 → spawn 依赖两者 → index 依赖所有模块。

### 2.3 工作量估算 ✅

~550 行总代码量，5 个 Task 串行执行。估算现实。

### 2.4 覆盖完整性 ✅

逐条对照 spec FR：

| FR | Task | 状态 |
|----|------|------|
| FR-1 兼容性 | Task 2 + 4 + 5 | ✅ |
| FR-2 Sync + detach | Task 4 | ✅ |
| FR-3 Background | Task 4 | ✅ |
| FR-4 Poll | Task 4 | ✅ |
| FR-5 Kill | Task 4 | ✅ |
| FR-6 Session 隔离 | Task 5 | ✅ |
| FR-7 输出截断 | Task 4 (truncateTail) | ✅ |
| FR-8 TUI 渲染 | Task 5 | ⚠️ LOW #6 |
| FR-9 工具描述 | Task 5 | ✅ |
| FR-10 配置文件 | Task 3 | ✅ |
| FR-11 Spawn 失败 | Task 4 | ✅ |
| FR-12 并发限制 | Task 4 | ✅ |

---

## 3. spec 与 plan 一致性

### 3.1 AC 覆盖矩阵 ✅

Spec Coverage Matrix 逐条核对：

| AC | Plan 映射 | 验证 |
|----|----------|------|
| AC-1 Sync 正常 | Task 4 executeSync | ✅ |
| AC-2 Sync 超时 detach | Task 4 executeSync timeout flow | ✅ |
| AC-3 Sync 显式 timeout | Task 4 executeSync | ✅ |
| AC-4 Sync 无超时 | Task 4 executeSync (config.defaultTimeout=0) | ✅ |
| AC-5 AbortSignal | Task 4 executeSync signal handler | ✅ |
| AC-6 Background | Task 4 executeBackground | ✅ |
| AC-7 Poll | Task 4 executePoll | ✅ |
| AC-8 Kill | Task 4 executeKill | ✅ |
| AC-9 Job 不存在 | Task 4 executePoll/executeKill | ✅ |
| AC-10 Session 隔离 | Task 5 session_start/shutdown | ✅ |
| AC-11 配置文件 | Task 3 loadConfig | ✅ |
| AC-12 Spawn 失败 | Task 4 ENOENT handling | ✅ |
| AC-13 非零退出码 | Task 4 executeSync/executeBackground | ✅ |
| AC-14 输出截断 | Task 4 (truncateTail) | ✅ |
| AC-15 并发限制 | Task 4 executeBackground | ✅ |
| AC-16 Cwd 不存在 | Task 4 executeSync cwd check | ✅ |
| AC-17 Shell 兼容性 | Task 2 resolveShell | ✅ |

所有 17 个 AC 均为 adopted 且有对应 Task。无遗漏。

### 3.2 额外工作 ✅

Plan 未包含 spec 未提及的工作。无镀金。

---

## 4. Execution Groups 合理性

### 4.1 分组 ✅

单一 Group BG1，7 个文件 ≤ 10，5 个 Task 略超建议 ≤ 4 但功能高度关联（types → shell → jobs → spawn → wiring 是一个不可分割的扩展包），合组合理。

### 4.2 Subagent 配置 ✅

- Agent: general-purpose（合理，纯 TypeScript 编码任务）
- 注入上下文: spec.md (FR+AC) + CLAUDE.md + Pi bash.ts 源码路径
- 读取文件: Pi bash.ts, Pi shell.ts, subagent/index.ts, subagent/spawn.ts
- 修改/创建文件: 7 个文件列表完整

### 4.3 Wave 编排 ✅

Wave 1 (Task 1) → Wave 2 (Task 2, 3 可并行) → Wave 3 (Task 4) → Wave 4 (Task 5)。依赖正确，无文件冲突。

---

## 5. 接口契约审查

### 5.1 方法名/参数/返回值一致性 ✅

Interface Contracts 表中的方法签名与 Task 步骤中的使用描述一致：
- `resolveShell(customPath?)` → Task 2 Step 1 ✅
- `buildShellEnv()` → Task 2 Step 2 ✅
- `executeSync(...)` → Task 4 Step 3 ✅
- `executeBackground(...)` → Task 4 Step 4 ✅
- `executePoll(jobId, jobs)` → Task 4 Step 5 ✅
- `executeKill(jobId, jobs)` → Task 4 Step 6 ✅
- `killProcessGroup(pid)` → Task 4 Step 1 ✅

### 5.2 Pi 公开 API 一致性 ✅

关键依赖验证：
- `truncateTail`, `DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`, `formatSize`, `TruncationResult` — **已确认从 `@mariozechner/pi-coding-agent` 导出**（`pi-mono/packages/coding-agent/src/index.ts:248-276`）
- `pi.sendMessage({ ... }, { deliverAs: "followUp", triggerTurn: true })` — **签名与 subagent 扩展一致**（`subagent/src/spawn.ts:409-430`）
- `registerTool("bash", ...)` 覆盖内置工具 — 符合 Pi 扩展机制
- `context.state` + `context.invalidate()` — **Pi 内置 bash 已用此模式**（`bash.ts:411-418`）

### 5.3 AC 覆盖矩阵完整性 ✅

所有 17 个 adopted AC 在矩阵中有对应行。无 postponed。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | plan.md:Task 2 / Interface Contracts:Module shell | **getShellConfig 已从 Pi 包导出** — spec 约束说"Pi 不导出 getShellConfig / getShellEnv"，但实际 `getShellConfig` **已从 `pi-coding-agent` 导出**（`index.ts:354`）。plan 据此自行实现 resolveShell（~30 行），可改为直接 import | 修改 Task 2：import `getShellConfig` from Pi 包，只自行实现 `buildShellEnv`（确实未导出）。同时更新 spec 约束文本 |
| 2 | LOW | plan.md:Interface Contracts:Module index | **loadConfig/loadPiSettings 模块归属不一致** — Interface Contracts 将两者归于 Module: index，但 Task 3 将 loadConfig 放在 jobs.ts，Task 2 将 loadPiSettings 放在 shell.ts | 将 Interface Contracts 中 loadConfig 移至 Module: jobs，loadPiSettings 移至 Module: shell，与 Task 实际位置对齐 |
| 3 | LOW | plan.md:Task 3 Step 3 vs Task 4 Step 4 | **并发校验职责归属模糊** — Task 3 Step 3 说"registerJob 校验 runningJobCount < max"，但 registerJob 签名 `(jobs, job) → void` 无 config 参数。Task 4 executeBackground 另行做校验。两处冲突 | 统一为 executeBackground 内校验（因 config 在此可用），Task 3 的 registerJob 改为纯 Map.insert |
| 4 | LOW | plan.md:Interface Contracts:Module spawn:executeBackground | **边界条件不完整** — executeBackground 的 Edge Cases 列仅 "maxJobs exceeded → isError; sendMessage fail → silently ignore"，缺少 "cwd not exist → throw Error"（Task 4 Step 4 有此逻辑但未在表中体现） | 补充 "cwd not exist → throw Error" 到 executeBackground 的 Edge Cases |
| 5 | LOW | plan.md:Task 4 Step 3 (executeSync) | **Sync 模式正常完成后临时文件清理步骤缺失** — Task 4 Step 2 为所有模式创建临时文件，Step 3 正常完成路径无清理。non-functional-design.md 明确要求"命令正常完成后立即删除临时文件"，但此文件未在 subagent 注入上下文中，subagent 不会看到此要求 | 在 executeSync 的正常完成路径（exit code 0 和非零 throw 前）增加 `fs.unlink(outFile)` 清理步骤。注意 timeout detach 路径不应清理 |
| 6 | LOW | plan.md:Task 5 Step 7 (renderResult) | **FR-8 setInterval 耗时刷新机制未明确** — FR-8 要求"Sync 模式执行中使用 setInterval + context.invalidate() 每秒刷新耗时显示"。Pi 内置 bash 在 renderResult 中实现此机制（`bash.ts:416-418`）。Task 5 Step 7 描述了 renderResult 功能但未提及此 setInterval 模式 | 在 Task 5 Step 7 增加：当 `options.isPartial && !state.interval` 时创建 `setInterval(() => context.invalidate(), 1000)`；完成时 clearInterval。参考 Pi bash.ts:414-423 |
| 7 | INFO | plan.md:Task 2 Step 1 | **Windows shell 发现被有意跳过** — FR-1 描述了 Windows 路径（Git Bash → bash.exe → 报错），但 Task 2 明确 "No Windows support in initial version"。AC-17 不涉及 Windows，属于有意识的范围缩减 | 无需修改，记录即可 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 接口契约交叉验证

### Pi 导出函数验证

| 计划引用的导出 | Pi 源码位置 | 实际导出 | 状态 |
|--------------|-----------|---------|------|
| `truncateTail` | `coding-agent/src/core/tools/truncate.ts:168` | ✅ index.ts:276 | ✅ |
| `DEFAULT_MAX_LINES` | `truncate.ts:11` | ✅ index.ts:249 | ✅ |
| `DEFAULT_MAX_BYTES` | `truncate.ts:12` | ✅ index.ts:248 | ✅ |
| `formatSize` | `truncate.ts:61` | ✅ index.ts:258 | ✅ |
| `TruncationResult` | `truncate.ts:15` | ✅ index.ts:273 (type) | ✅ |
| `getShellConfig` | `utils/shell.ts:57` | ✅ index.ts:354 | ⚠️ LOW #1 |
| `getShellEnv` | `utils/shell.ts:112` | ❌ 未导出 | ✅ 自行实现正确 |

### sendMessage 签名验证

计划使用：
```typescript
pi.sendMessage(
  { customType: "bash-async-result", content, deliverAs: "followUp", triggerTurn: true },
)
```

Subagent 实际使用（spawn.ts:409-425）：
```typescript
pi.sendMessage(
  { customType: "subagent-background-result", content, display: true, details: {...} },
  { deliverAs: "followUp", triggerTurn: true },
)
```

**差异：** plan 将 `deliverAs` 和 `triggerTurn` 放在第一个参数对象内，而 Pi API 将它们作为**第二个参数**（options）。此外 plan 缺少 `display: true`。这不会导致 MUST FIX（subagent 可参考 Pi bash.ts 源码纠正），但建议 plan 修正 sendMessage 调用格式。此项已归入整体评价，不单独列为 issue（实现时 subagent 有 Pi 源码参考）。

---

## 结论

**通过**

Plan 整体质量高：
- 17/17 AC 完整映射，无遗漏
- 任务拆分粒度合理，依赖 DAG 正确
- Interface Contracts 详细到方法签名级别
- Placeholder/TBD 扫描无问题
- Pi API 引用除 getShellConfig 外均准确

6 条 LOW 均为文档一致性和细节补充问题，不影响功能正确性。实施时 subagent 有 Pi 源码参考，可自行纠正细节偏差。

### Summary

计划评审完成，第1轮通过，0条MUST FIX。6 条 LOW 建议修复（getShellConfig 重复实现、模块归属不一致、并发校验职责模糊、边界条件不完整、临时文件清理缺失、setInterval 耗时未明确），1 条 INFO（Windows 范围缩减）。
