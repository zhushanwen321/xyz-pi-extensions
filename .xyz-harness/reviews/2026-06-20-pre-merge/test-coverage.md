---
verdict: fail
must_fix: true
review_date: 2026-06-20
pr: "#66"
branch: feat-subagent-workflow-enhance
base: main
---

# 测试覆盖审查报告 — PR #66 (subagent-workflow-enhance)

## Summary

本 PR 新增 ~10,500 行代码（subagents 扩展全新落地 + workflow 引擎重构），同时新增 2,836 行测试，
**已测模块的覆盖质量很高**（边缘情况、并发竞态、状态机守卫均有针对性用例），全量 1,063 个测试全部通过。
但 **subagents 扩展的两个核心纯逻辑模块完全没有单测**，而这两个模块的作者在源码注释中明确声明"可独立单测"，
承载的是模型解析和事件累积这类**正确性致命**的逻辑。这是合并前必须补的缺口。

**全量测试结果**（`pnpm -r test`，全部 PASS）：

| 包 | Test Files | Tests |
|----|-----------|-------|
| subagents（新） | 7 | 125 |
| workflow | 21 | 400 |
| ask-user | 7 | 161 |
| statusline | 1 | 73 |
| evolve-daily | 3 | 57 |
| plan | 6 | 50 |
| context-engineering | 3 | 44 |
| todo | 1 | 35 |
| goal | 3 | 30 |
| turn-timing | 1 | 22 |
| unified-hooks（新） | 2 | 11 |
| structured-output | 1 | 18 |
| model-switch（新 config） | 1 | 7 |
| quota-providers | 1 | 7 |
| taste-lint（新） | 1 | 5 |

## Findings

### ❌ must-fix

| # | 类别 | 位置 | 缺口 | 影响 |
|---|------|------|------|------|
| 1 | missing-test | `extensions/subagents/src/core/model-resolver.ts` (206 行) | 5 级 fallback `resolveModelForAgent`、`inferCategory`、`availableThinkingLevels` **零测试**。全部是纯函数，作者注释写明"duck-typed，测试可 mock"。 | 模型解析是整个 subagent 系统的大脑：选错模型 = 成本/质量双输。fallback 顺序、auth 校验失败兜底、thinkingLevel clamp 到 model 可用级别，任一处回归都无测试拦截。`inferCategory` 的 5 条正则规则（cod/research/test/plan/vision）改一个字符就静默错配。 |
| 2 | missing-test | `extensions/subagents/src/core/event-bridge.ts` (193 行) | `isSdkEvent` guard + `createEventBridge` switch 映射 + turn/toolCall/usage 累积器 **零测试**。作者注释原文："唯一依赖 types.ts（leaf）——可独立单测，无需 Pi SDK"。 | 这是 session-factory/output-collector 共享的数据通路内核。`tool_execution_end` 从 pendingTools 回填 args、`message_update` 中 thinking 必须先于 text 判断、`message_end` 的 usage 累加（含 `u.cost?.total ?? 0`）、stopReason=error/aborted 转 lastError——全是注释里点名的"易错点"，全无测试。 |

### ⚠️ should-fix（建议合并前补，非硬性阻断）

| # | 类别 | 位置 | 缺口 | 影响 |
|---|------|------|------|------|
| 3 | missing-test | `extensions/workflow/src/infra/agent-pool.ts` 新增 timeoutMs 逻辑（~35 行） | 新增"合并 AbortController（外部 signal + wall-clock timer）+ `timer.unref()` + 清理"逻辑。`worker-script.test.ts` 只验证字段透传（`timeoutMs: firstArg.timeoutMs`），**未验证 AgentPool 真的会用它触发 abort**。 | 新功能 `agent({timeoutMs:5000})` 若合并逻辑有 bug（signal 已 aborted、timer 未清理、unref 漏掉）会静默失效。代码注释自己点名"Without this, agent({timeoutMs:5000}) silently does nothing"，却没加行为测试。 |
| 4 | missing-test | `extensions/subagents/src/core/agent-registry.ts` (183 行) | `parseAgentFrontmatter`（frontmatter 解析）+ `AgentRegistry` 多目录优先级 + mtime 缓存 **零测试**。 | frontmatter 解析的边缘情况（未闭合 `---`、带引号值、tools CSV 拆分、`_` 前缀文件跳过）回归无拦截；多目录"逆序扫描覆盖"的优先级契约改错会静默选错 agent。纯 fs 逻辑，用 tmpdir 易测。 |
| 5 | missing-test | `extensions/subagents/src/core/path-encoding.ts` (16 行) | `encodeCwd` 纯函数零测试。 | 它是 session-factory 与 history-store 的**编码契约**（同一 cwd 必须落到同一目录），注释明确说"两处需要相同的编码，否则同一 cwd 会落到两个不同目录"。16 行函数，3 个用例即可锁定契约。 |
| 6 | missing-test | `extensions/subagents/src/core/output-collector.ts` (96 行) | `collectResponseText`（倒序找 assistant message）、`toUsageTotal`（全零返回 undefined）、`collectResult` **零测试**。纯函数。 | `toUsageTotal` 的"全零 → undefined"契约是后续 budget 判断的输入，错配会让 usage 误报。 |
| 7 | missing-test | `extensions/subagents/src/runtime/execution/record-store.ts` (280) + `history-store.ts` (198) + `discovery-config.ts` (135) + `config/config.ts` (193) + `session-file-gc.ts` (70) | 持久化/配置层全部零测试。均为 fs 操作，可用 tmpdir + 注入测试。 | history.jsonl 的 append-only + GC（超 MAX 重写保留最近 N）逻辑、discovery.json 缺失/非法字段降级、config 默认值单一真相源——回归会丢数据或启动失败。优先级低于 #1-#6。 |

### ℹ️ info（已覆盖，记录亮点 + 小观察）

| # | 类别 | 位置 | 说明 |
|---|------|------|------|
| 8 | edge-case | `concurrency-pool.test.ts` | ✅ 已覆盖 `maxConcurrent=0` clamp 到 1（C3 fix）、负数 clamp、priority 0 抢占 1000、额外 release 不让 active 变负。质量高。 |
| 9 | edge-case | `turn-limiter.test.ts` | ✅ 已覆盖 `maxTurns=0` 禁用、`graceTurns=0` 同 turn abort、steer 只触发一次。 |
| 10 | edge-case | `execution-record.test.ts` | ✅ 506 行/30+ 用例，覆盖 ring buffer 淘汰、长 summary 截断、text/thinking chunking while 循环、并发 race（first transition wins）、全终态短路。 |
| 11 | edge-case | `orchestrator-budget.test.ts` | ✅ 已覆盖 `maxTokens=0`/`undefined` 守卫（MF3 回归）、90% 警告只发一次、terminal 状态短路。 |
| 12 | edge-case | `orchestrator-stale.test.ts` | ✅ `isStaleContextErrorMsg` 9 个用例（undefined/空/大小写/驼峰/不相关），`executeWithRetry` stale 早返回 + 普通失败 retry 计 budget。但 **`isBudgetExceeded` 纯 helper 无直接单测**（只在 executeWithRetry 间接走过）。 |
| 13 | framework-compliance | 全局 | ✅ 15 个 vitest.config.ts 齐全；零 `node:test` / `tsx --test` 违规；subagents 用 `mocks/`（pi-ai/pi-tui/typebox stub）正确隔离 SDK。 |
| 14 | test-config | `model-switch/vitest.config.ts` | 新增 config 使原本无测试的 model-switch 跑起 7 个测试。`include: ["tests/**/*.test.ts"]` 与多数包的 `src/__tests__/**` 不一致，但属历史约定（statusline 同模式），非本次回归。 |
| 15 | missing-test | `extensions/subagents/src/core/session-factory.ts` (358) + `session-runner.ts` (297) + `runtime/subagent-service.ts` (545) + `tools/subagent-tool.ts` (247) + `commands/subagents.ts` (78) | 编排/集成层，强依赖 child_process + Pi SDK，单测成本高。`sdk-contract.test.ts` 已锁定 SDK 调用契约（command/tool 注册签名、sendMessage triggerTurn）。建议靠 SDK 契约测试 + 后续 e2e 兜底，不强制单测。 |
| 16 | regression-guard | `extensions/workflow/tests/resolveModel.test.ts` | ✅ 旧版 scene→model 解析测试（66 行）被删除，因 scene 解析已移除；新版 `src/__tests__/model-resolver.test.ts` 覆盖"空串→undefined（falsy 契约）"。迁移干净。 |

## 建议补测清单（优先级排序）

1. **`core/model-resolver.test.ts`**（~40 用例）— 5 级 fallback 各级命中/miss、paramOverride 最高优先级、fallback 全不可用抛错、`inferCategory` 5 条正则 + override 优先、`availableThinkingLevels` reasoning=false/map 缺失/clamp 到最高。
2. **`core/event-bridge.test.ts`**（~25 用例）— `isSdkEvent` guard、tool_end args 从 pendingTools 回填、thinking 先于 text、usage 累加含 cost、stopReason=error/aborted → lastError、未知 type 走 default。
3. **`core/path-encoding.test.ts`**（~5 用例）— 锁定 session-factory/history-store 共享编码契约。
4. **`agent-pool` timeoutMs 行为测试**（~3 用例）— mock runPiProcess，验证 `timeoutMs` 触发 abort、外部 signal 已 aborted 时立即 abort、timer 清理。
5. **`core/agent-registry.test.ts`**（~15 用例）— frontmatter 解析边缘 + 多目录优先级 + mtime 缓存命中。

## 结论

框架合规、已测模块的边缘覆盖质量值得肯定（C3 deadlock fix、MF3 budget 守卫、stale context 检测都有专门回归用例）。
但 **#1（model-resolver）和 #2（event-bridge）是合并阻断项**：两者都是作者在源码注释中明示"可独立单测"的纯逻辑内核，
承载模型解析正确性和事件累积正确性——这是 subagent 系统的两条命脉，无测试上线 = 把最易测、最致命的逻辑裸奔。
建议合并前至少补 #1、#2、#5（path-encoding，16 行极低成本），其余可记 issue 后续跟进。
