# 代码品味审查报告 v2 — ADR-029（coding-execute 全流程 workflow 接管 + per-call cwd + worktree 隔离）

**审查维度**：review-taste（代码品味 / 可读性 / 一致性 / 命名 / 结构 / 注释质量）
**基准点**：`4f2fb916f^`（ADR-029 第一个 commit 的父提交）
**审查日期**：2026-07-07
**审查范围**：27 个文件，+1284 / -159 行（见末尾 diff stat）

---

## 一、自动检查结果

| 检查项 | 命令 | 结果 |
|--------|------|------|
| ESLint（ADR-029 改动的 14 个 TS 文件） | `npx eslint ... --no-warn-ignored` | **0 errors, 11 warnings** |
| TypeScript 全量 | `npx tsc --noEmit` | **0 errors**（exit 0） |
| 行数上限（≤1000） | `wc -l` | 全部通过（最大 execute-full-workflow.js 586 行） |

### ESLint warnings 分布（11 条）

| 文件 | 行 | 规则 | 严重度 | 归属 |
|------|----|------|--------|------|
| `check-execute.ts` | 26 | `simple-import-sort/imports` | LOW | **pre-existing**（ADR-029 仅加注释块） |
| `check-execute.ts` | 127,189,194,197,210 | `no-magic-numbers`（字面量 `5`） | LOW | **pre-existing** |
| `check-execute.ts` | 287,333 | `no-magic-numbers`（字面量 `2`） | LOW | **pre-existing** |
| `check-execute.ts` | 378 | `taste/no-unsafe-cast`（`as ResultItem`） | LOW | **pre-existing** |
| `store.ts` | 297 | `no-magic-numbers`（`Math.pow(2, ...)`） | **LOW** | **ADR-029 新增** |
| `store.ts` | 298 | `no-magic-numbers`（`SharedArrayBuffer(4)`） | **LOW** | **ADR-029 新增** |

> **归因**：11 条 warning 中 9 条为 pre-existing（check-execute.ts 未改逻辑），**仅 2 条由 ADR-029 引入**（store.ts 的 SQLITE_BUSY 退避代码）。详见人工审查项 #4。

---

## 二、人工审查项逐项结论

| # | 审查项 | 结论 | 证据 |
|---|--------|------|------|
| 1 | 函数长度 ≤80 行 | **PASS** | 所有受检函数均 ≤80 行：`assertAcyclicDeps` 39 行、`transaction` 30 行、`topoSort` 23 行、`buildWaves` 18 行、`buildImplementerPrompt` 35 行、`buildTestRunnerPrompt` 57 行。`ConcurrencyGate.run`(109) / `SubprocessAgentRunner.run`(100) 超 80 行但 **pre-existing**（ADR-029 前分别为 108/100），本次未恶化。 |
| 2 | 参数列表 ≤3 位置参数 | **PASS** | `runPiProcess` 重构为 options object，**2 个调用点全部已迁移**（`subprocess-agent-runner.ts:80` + `concurrency-gate.ts:263`）。`buildArgs(opts)` 单参。`RunPiProcessOptions` 接口定义清晰。 |
| 3 | any / unsafe cast | **PASS** | 改动的 8 个 TS 文件 **零 `any` / 零 `as unknown as` / 零 `as never`**。唯一非空断言 `item!.dependsOn`（plan-parser.ts:249）逻辑安全（前置 `Array.isArray(item?.dependsOn)` 已隐式保证 item 非空），但建议改类型守卫（见 LOW-1）。 |
| 4 | 魔法数字 | **LOW** | 大部分已语义化：`DEFAULT_AGENT_TIMEOUT_MS=1_800_000`、`DEFAULT_MAX_WORKTREES=5`、`GIT_CMD_TIMEOUT_MS=30_000`、`MAX_BUSY_RETRY=3`、`BASE_BACKOFF_MS=200`。残留见 LOW-2/LOW-3。 |
| 5 | 命名 | **PASS** | 函数/变量语义化（`devAborted`、`waveHasFail`、`cleanupFailures`）。布尔变量前缀规范（`is`/`has` 缺位但语义清晰如 `waveOk`/`devAborted`）。接口无 `I` 前缀。`buildSessionRunnerContext`/`resolveIdentity` 表意准确。 |
| 6 | 错误处理 | **PASS** | 无空 catch / 纯 console catch。workflow 脚本所有 catch 要么 log+降级（branch 删除、readReport）、要么 re-throw（plan.json 解析）。`store.ts` 的 `parseJsonField` 空 `catch {}` 是有意 fallback（防御性 parse，注释说明）。错误一律 `throw new Error()` 不返回错误成功模式。 |
| 7 | 结构（行数/import/死代码） | **MUST_FIX** | 见 **MUST_FIX-1**（execSync/execFileSync 导入错配——运行时 ReferenceError）。import 顺序：Node 内置→npm→内部，符合规范。 |
| 8 | while(true) 有界 | **PASS** | 无 `while(true)`。`ConcurrencyGate.drain`/`drainSlots` 用 `while (active < max && queue.length > 0)` 有界条件循环。workflow 脚本 `for` 循环均基于 `devWaves2d.length` 等有界集合。 |
| 9 | Promise.all vs allSettled | **PASS** | workflow 脚本用 `parallel(...)`（Pi workflow 全局并发原语，内部管理失败聚合，非裸 `Promise.all`）。store.ts / plan-parser.ts 无并发聚合场景。 |
| 10 | 注释质量 | **PASS** | 注释普遍解释 **why**（如 store.ts:191-197 解释并发 init 竞态的 TOCTOU、concurrency-gate.ts:170-178 解释 drain vs drainSlots 的 C-3 bug、subagent-service.ts:285-292 解释节流合并）。ADR-029 决策引用清晰（「ADR-029 决策 N」锚点）。无与代码矛盾的过时注释。 |

---

## 三、必须修复（MUST_FIX）

### MUST_FIX-1：workflow 脚本导入 `execSync` 但调用 `execFileSync` —— 运行时 ReferenceError

**文件**：`.pi/workflows/execute-full-workflow.js`
**严重度**：🔴 Critical（功能性 + 品味双重缺陷）

**证据**：

```js
// 第 16 行：导入的是 execSync
const { execSync } = require("child_process");

// 第 172-176 行：gitArgs 实际调用的是 execFileSync（未导入）
// 所有 git 调用走 execFileSync（shell:false），避免路径/ref 含空格或特殊字符的注入风险。
function gitArgs(cwd, verb, args) {
  return execFileSync("git", ["-C", cwd, verb, ...args], {
    encoding: "utf-8", timeout: GIT_CMD_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
```

```bash
$ grep -c "execSync" .pi/workflows/execute-full-workflow.js   # → 仅 1 处（import 行），无任何调用
$ grep -c "execFileSync" .pi/workflows/execute-full-workflow.js # → 2 处（注释 + 调用），无 import
```

**影响**：`gitArgs` 是所有 worktree 管理的底层函数（`addWorktree`/`resetWorktree`/`removeWorktree` 全部依赖它）。首次调用 `addWorktree("dev-pool0")` 即抛 `ReferenceError: execFileSync is not defined`，**整个 Phase 0 worktree-setup 直接崩溃**，workflow 无法运行。

**根因（品味层）**：导入符号与使用符号错配——典型的「写注释/重构时改了实现但忘了改 import」疏漏。注释明确说「走 execFileSync（shell:false）」，但 import 留着 `execSync`（shell:true，正是注释想避免的）。

**修复**：

```js
// 把 execSync 改为 execFileSync
const { execFileSync } = require("child_process");
```

> **注**：此问题同时是 robustness 维度的 MUST_FIX（功能不可用），但表现为代码品味缺陷（dead/wrong import），故在本报告登记。该脚本经 `git add -f` 强制纳入（force-add），CI 的 lint/tsc 不覆盖 `.js` workflow 脚本，导致漏网。

---

## 四、建议改进（LOW）

### LOW-1：`plan-parser.ts:249` 非空断言可改类型守卫

**文件**：`extensions/coding-workflow/src/cw/plan-parser.ts:249`

```ts
const item = items.find((i) => i.id === id);
const deps = Array.isArray(item?.dependsOn) ? item!.dependsOn : [];
//                                                ^^^^ 非空断言
```

**分析**：逻辑安全（`Array.isArray(item?.dependsOn)` 为 true 时 `item` 必非 undefined），但 `item!` 是断言而非守卫。符合项目规范「类型守卫代替断言」的轻量改法：

```ts
const item = items.find((i) => i.id === id);
const deps = item && Array.isArray(item.dependsOn) ? item.dependsOn : [];
```

去掉 `?.` + `!`，用 `item &&` 自然窄化。零运行时成本，纯可读性。

---

### LOW-2：`store.ts` SQLITE_BUSY 退避有两个未命名魔法数字

**文件**：`extensions/coding-workflow/src/cw/store.ts:297-298`（ESLint 已 warn）

```ts
const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);          // 字面量 2
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff);  // 字面量 4
```

**分析**：
- `2`：指数退避底数，语义固定，但建议命名 `BACKOFF_BASE = 2` 或直接注释「指数退避底数」。
- `4`：`SharedArrayBuffer(4)` 的 4 = 4 字节 = 1 个 Int32。这是 `Atomics.wait` 同步睡眠的固定惯用法（4 字节缓冲承载 1 个 int32），可命名 `INT32_BYTES = 4` 并注释「Atomics.wait 需要 1 个 int32 的共享缓冲」。

**严重度**：LOW（行为正确，仅命名）。已在 ESLint warning 中登记。

---

### LOW-3：workflow 脚本 `MAX_WORKTREES - 2` 与 overlap 阈值缺命名

**文件**：`.pi/workflows/execute-full-workflow.js`

```js
// 第 219 行：-2 的语义（预留 test + review 2 个 worktree）仅靠邻近 log 行隐式表达
const devPoolSize = Math.min(maxParallelInWave, Math.max(1, MAX_WORKTREES - 2));

// 第 494 行：0.8 / 0.3 重合度阈值
const overlapLabel = overlapRatio > 0.8 ? "high" : overlapRatio > 0.3 ? "medium" : "low";

// 第 505 行：* 100（百分比换算）
"... = " + Math.round(overlapRatio * 100) + "%"
```

**建议**：

```js
const RESERVED_WORKTREES = 2; // 1 test + 1 review，从 MAX_WORKTREES 预留
const devPoolSize = Math.min(maxParallelInWave, Math.max(1, MAX_WORKTREES - RESERVED_WORKTREES));

const OVERLAP_HIGH_THRESHOLD = 0.8;
const OVERLAP_MEDIUM_THRESHOLD = 0.3;
const PERCENT = 100;
```

**严重度**：LOW（workflow 脚本是 .js，不经 ESLint，纯可读性维护建议）。

---

### LOW-4：`ConcurrencyGate.run` / `SubprocessAgentRunner.run` 超 80 行（pre-existing）

**文件**：`extensions/workflow/src/infra/concurrency-gate.ts:215-323`（109 行）、`extensions/workflow/src/infra/subprocess-agent-runner.ts:38-137`（100 行）

**分析**：两者均超 80 行函数上限，但：
- ADR-029 前 `ConcurrencyGate.run` 为 108 行，本次仅 +1 行（options-object 调用改造），**未恶化**。
- ADR-029 前 `SubprocessAgentRunner.run` 为 100 行，本次仅改 1 行调用，**未恶化**。

**严重度**：LOW（pre-existing 技术债，非本次回归）。两者高度对称（合并 AbortController + env 组装 + schema 校验），可提取 `runAgentSubprocess(opts)` 共享私有方法收口，但超出 ADR-029 范围，建议独立重构任务。

---

## 五、亮点（PASS 项的正面证据）

1. **options-object 重构彻底**：`runPiProcess` 从 6 个位置参数收敛为 `RunPiProcessOptions`，2 个调用点全部同步迁移，无遗漏。后续加 `cwd` 字段零调用点改动——正是 options 模式的收益兑现。

2. **并发初始化竞态注释极佳**（store.ts:204-213）：`BEGIN IMMEDIATE` 的 TOCTOU 分析、幂等 check-then-add 的失败模式、败者 `busy_timeout` 重试路径，全部在注释里讲清 why。这是「注释解释 why 而非 what」的范本。

3. **SQLITE_BUSY 双防线设计清晰**（store.ts:265-305）：第一道 `busy_timeout=5000` + 第二道应用层退避重试，注释明确标注「fn 内不得持锁跨进程 IO」的不变式 + 当前 dev/test handler 违反此不变式的技术债交代。诚实且有指引。

4. **环检测 fail-fast 定位准确**（plan-parser.ts:212-256）：`assertAcyclicDeps` 在 plan/detail gate 阶段（而非 worktree 建好后）拒绝环形依赖，注释解释了「提前到 plan 阶段 fail-fast」的设计意图。DFS 三色标记 + 路径回溯报环，错误信息含完整环路径。

5. **per-call cwd 透传链路完整**：`ExecuteOptions.cwd` → `buildSessionRunnerContext(opts?.cwd ?? this.cwd)` → `SessionRunnerContext.cwd`，4 层透传（tool schema → StartHandlerInput → ExecuteOptions → SessionRunnerContext）类型安全，缺省回退向后兼容。

6. **ADR 决策锚点贯通**：代码注释普遍引用「ADR-029 决策 N」，便于从代码反查决策依据，也便于决策变更时定位受影响代码。

---

## 六、统计汇总

| 维度 | 数量 |
|------|------|
| MUST_FIX | **1**（MUST_FIX-1：execFileSync 未导入，运行时崩溃） |
| LOW | **4**（LOW-1 非空断言、LOW-2/LOW-3 魔法数字、LOW-4 pre-existing 长函数） |
| INFO | 0 |
| PASS 项 | 8 / 10（函数长度、参数列表、any/cast、命名、错误处理、while 有界、allSettled、注释） |
| 自动检查 | ESLint 0 error / 11 warn（9 pre-existing + 2 ADR-029 新增）；tsc 0 error；行数全通过 |

### ADR-029 引入 vs pre-existing 归因

| 类别 | ADR-029 引入 | pre-existing |
|------|-------------|-------------|
| ESLint warnings | 2（store.ts:297,298） | 9（check-execute.ts 全部） |
| MUST_FIX | 1（execFileSync 导入） | 0 |
| LOW | 3（LOW-1, LOW-2, LOW-3） | 1（LOW-4） |

**结论**：ADR-029 的代码品味整体**良好**（零 any、options-object 重构彻底、注释质量高、命名规范）。唯一阻断项是 MUST_FIX-1 的 `execFileSync` 导入错配——这是 force-add 的 `.js` 脚本绕过了 lint/tsc 的后果，**修复成本极低**（改 1 个 import），但**必须在 workflow 上线前修复**（否则 worktree-setup 直接崩溃）。其余 4 个 LOW 均为可读性改进，不阻断。

---

## 附：审查范围 diff stat

```
.pi/workflows/execute-full-workflow.js             | 586 +++++ (force-add)
docs/adr/029-full-workflow-takeover-with-worktree.md |   1 +
extensions/coding-workflow/skills/coding-execute/SKILL.md | 235 +--
.../src/cw/__tests__/plan-parser.test.ts           |  29 +
.../src/cw/__tests__/store.test.ts                 |  63 ++
.../src/cw/checks/check-execute.ts                 |   9 + (仅注释)
.../src/cw/plan-parser.ts                          |  80 +-
.../src/cw/store.ts                                | 111 +-
.../src/cw/types.ts                                |   8 +
extensions/workflow/src/__tests__/execute-integration.test.ts | 113 +-
extensions/workflow/src/engine/error-recovery.ts   |   1 +
extensions/workflow/src/engine/models/types.ts     |   8 +
extensions/workflow/src/infra/concurrency-gate.ts  |   7 +-
extensions/workflow/src/infra/pi-runner.ts         |  20 +-
extensions/workflow/src/infra/subprocess-agent-runner.ts |   2 +-
extensions/workflow/src/infra/worker-script-builder.ts |   3 +-
extensions/subagents/src/runtime/subagent-service.ts |  13 +-
extensions/subagents/src/tools/subagent-actions.ts |   3 +
extensions/subagents/src/tools/subagent-tool.ts    |   8 +
extensions/subagents/src/types.ts                  |   9 +
（+ skills/lite-shared 文档若干）
```
