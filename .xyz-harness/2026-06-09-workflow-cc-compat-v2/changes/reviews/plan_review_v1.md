---
verdict: pass
must_fix: 0
---

# Plan Review V1 — workflow-cc-compat-v2

**审查模式**: Mode 1 — Plan 可行性审查
**审查日期**: 2026-06-09
**审查范围**: plan.md, e2e-test-plan.md, test_cases_template.json, use-cases.md, non-functional-design.md
**交叉参照**: spec.md, 源码 agent-pool.ts, orchestrator.ts, worker-script.ts, config-loader.ts, state.ts

---

## 总体评价

计划质量较高，所有 spec AC 均有对应 task 和 interface contract 覆盖，AC traceability matrix 完整。Task 拆分粒度合理，每个 task 有明确的文件、行号范围、步骤和 commit 边界。执行分组（BG1/BG2）的依赖关系正确。以下按维度逐项审查。

---

## 1. Spec 覆盖度

| Spec AC | Plan 覆盖 | 状态 |
|---------|----------|------|
| AC-1.1 | Task 1 (buildArgs → --append-system-prompt) | ✅ 完整 |
| AC-1.2 | Task 1 (schema JSON 写临时文件) | ✅ 完整 |
| AC-1.3 | Task 2 (spawnAndParse 重试) | ✅ 完整 |
| AC-1.4 | Task 2 (hasToolCall + exit=0 盲区) | ✅ 完整 |
| AC-2.1 | Task 3 (phases 联合类型) | ✅ 完整 |
| AC-2.2 | Task 4 (args 别名) | ✅ 完整 |
| AC-2.3 | Task 5 (phase → trace node) | ✅ 完整 |
| AC-2.4 | Task 6 (parallel thunk) | ✅ 完整 |
| AC-2.5 | Task 7 (pipeline 笛卡尔积) | ✅ 完整 |
| AC-2.6 | Task 4+5 (显式 phase 覆盖) | ✅ 完整 |
| AC-2.7 | Task 8 (budget.spent) | ✅ 完整 |
| AC-2.8 | Task 8 (budget.remaining) | ✅ 完整 |
| AC-2.9 | Task 7 (pipeline 错误隔离) | ✅ 完整 |
| AC-3.1~3.5 | postponed (一致) | ✅ 正确延后 |

**结论**: 所有 AC 均有 task 对应，无遗漏。

---

## 2. 源码可行性验证

### Task 1: Schema 注入改为临时文件

**当前源码**（agent-pool.ts:314-328）：`buildArgs()` 在 `opts.schema` 存在时将 schema 指令拼接进 prompt 字符串。计划改为依赖 `opts.systemPromptFile`，由 orchestrator 预先写入。

**可行性**: ✅ `buildArgs()` 已有 `if (opts.systemPromptFile) { args.push("--append-system-prompt", opts.systemPromptFile) }` 分支（行 308-310）。Orchestrator 的 `resolveAgentOpts()` 已有临时文件写入逻辑（行 648-665），可作为 Task 1 的参考模板。`--append-system-prompt` 已通过 `resolvePromptInput` 支持文件路径（spec assumption #7 已验证）。

**潜在问题**: plan Step 3 说"当前 agent-call 消息不传 callId"——这是**不准确的**。实际源码 worker-script.ts:184 已经传递 `callId`: `parentPort.postMessage({ type: "agent-call", callId, opts })`，且 orchestrator.ts:620 `this.handleAgentCall(runId, instance, msg.callId, msg.opts)` 已接收。此步骤应简化为"确认 orchestrator 已能获取 callId"即可，不需要额外修改。

**严重度**: LOW（不影响正确性，只是多了一步不必要的确认）

### Task 2: 重试 + 盲区修复

**当前源码**（agent-pool.ts:396-404）：`spawnAndParse` 仅在 `opts.schema && !parsedOutput && !hasToolCall` 时报错。需要扩展到 `hasToolCall && exitCode === 0` 的盲区。

**可行性**: ✅ 逻辑清晰，改动量小（< 20 行）。重试逻辑需要重新调用 `runPiProcess`，当前 `spawnAndParse` 内部有完整的 pipeline 流程，重试需要：
1. 重新生成加强版临时文件
2. 重新调用 `resolveInvocation` + `runPiProcess`

**关注点**: Task 2 的重试在 `agent-pool.ts` 的 `spawnAndParse` 中实现，而 orchestrator 已有 `executeWithRetry`（行 726-845）做通用重试（exponential backoff，MAX_AGENT_RETRIES=3）。两者形成**双层重试**。Plan 中未明确说明 SO 重试（Task 2）与通用重试（executeWithRetry）的关系。

**建议**: Task 2 的 SO 重试应设为仅执行 1 次（第二次仍失败则返回 error），通用重试不应重复 SO 重试的场景。plan 中已写明"第二次仍失败则返回错误"，逻辑正确，但应在 Task 2 描述中显式标注"此重试独立于 orchestrator 的 executeWithRetry 通用重试，两者不冲突"。

**严重度**: LOW（逻辑正确但关系未显式化，开发时可能困惑）

### Task 3: phases 类型扩展

**当前源码**（config-loader.ts:164）：`metaObj.phases.filter((p: unknown) => typeof p === "string") as string[]` 硬编码只接受 string。

**可行性**: ✅ 计划中的 filter 改动直接且正确。`CachedWorkflowMeta extends WorkflowMeta` 会自动继承。

### Task 4: args 别名 + phase 提取

**当前源码**（worker-script.ts:94）：`const $ARGS = ...` 已定义。只需在其后加 `const args = $ARGS`。

**可行性**: ✅ 一行改动。phase 提取在 worker-script.ts:140-167 的 `agent()` 函数中处理 secondArg，增加 `phase` 字段提取合理。需将 `"phase"` 加入 `_knownFields`（当前为行 169 的 Set）。

### Task 5: phase 传递到 trace node

**当前源码**（state.ts:68）：`ExecutionTraceNode` 接口需增加 `phase?: string`。

**可行性**: ✅ orchestrator.ts:700-712 构造 trace node 时可直接从 `msg.opts.phase` 读取。注意 `handleAgentCall` 的参数签名已有 `opts: AgentCallOpts`，plan 需要在此处增加 `phase` 字段传递到 node 构造。

### Task 6: parallel thunk

**当前源码**（worker-script.ts:191-196）：`parallel()` 当前仅 `calls.map(c => agent(c))`，不支持 thunk。

**可行性**: ✅ 改动清晰，< 10 行。

### Task 7: pipeline 笛卡尔积

**当前源码**（worker-script.ts:196-202）：仅支持 `pipeline(stages)` 单参数。

**可行性**: ✅ plan 中的实现伪代码逻辑正确。错误隔离（try-catch → null）与 spec AC-2.9 对齐。

### Task 8: budget 动态

**当前源码**（worker-script.ts:94）：`$BUDGET` 是静态对象。

**可行性**: ✅ 改为带 getter 的 proxy 对象，通过 `parentPort.on("message")` 接收 `budget-update` 消息更新缓存。orchestrator 在 agent 完成后推送（行 833-836 已有 budget 累积逻辑）。

**关注点**: plan 说增加 `budget-update` 消息类型，但当前 worker 的 message handler 已有对 `budget-warning` 的处理注释。需确保新的 `budget-update` 类型不与现有的混淆。

---

## 3. 依赖图和执行顺序

**BG1 内部**: Task 1 → Task 2（串行，正确，Task 2 的重试依赖 Task 1 的新 buildArgs 逻辑）

**BG2 内部**: Task 3, 4, 6, 7, 8 无互相依赖，Task 5 依赖 Task 4。Plan 中标注了执行顺序。

**BG1 vs BG2**: 无依赖，可并行。但两者都改 orchestrator.ts——BG1 Task 1 改临时文件写入，BG2 Task 5/8 改 phase 传递和 budget 推送。Plan 已识别此冲突，在"并行约束"段落中讨论了合并方案。

**结论**: ✅ 依赖关系正确。

---

## 4. 测试计划质量

### e2e-test-plan.md

三个场景（TS-1 SO 可靠性, TS-2 CC 兼容, TS-3 向后兼容）覆盖了所有 AC。测试环境说明具体（模型选择、前置条件）。场景描述偏高层，对于 E2E 测试这是合理的。

### test_cases_template.json

14 个测试用例，类型分布：unit 6 个 + integration 8 个。每个用例有明确的 steps。

**关注点**: TC-1-03 和 TC-1-04 使用 mock `runPiProcess`，但 mock 策略未详细说明（如何 mock 模块级函数）。这不阻塞实施（开发时确定），但建议在实施时统一 mock 方案。

---

## 5. 非功能性设计

**稳定性**: ✅ 正确识别了重试增加进程生命周期复杂度，缓解措施合理。

**数据一致性**: ✅ 临时文件命名用 callId（已含计数器），冲突概率低。向后兼容通过可选字段和联合类型保证。

**性能**: ✅ 临时文件写入 < 2KB，延迟可忽略。budget-update 频率低。

**安全**: ✅ 不涉及敏感数据，临时文件存放于 session 目录。

---

## 6. 改进建议（非阻塞）

| # | 文件 | 建议 | 严重度 |
|---|------|------|--------|
| SUG-1 | plan.md Task 1 Step 3 | "增加 agent-call 消息中传递 callId" 描述不准确——callId 已在传递。改为"确认 orchestrator 已获取 callId" | LOW |
| SUG-2 | plan.md Task 2 | 显式标注 SO 重试与 orchestrator executeWithRetry 的关系（独立，不冲突） | LOW |
| SUG-3 | plan.md 临时文件清理 | 清理方案描述有矛盾——先说按 runId 清理，后说"更简单的方案是按时间清理"。应在 plan 中确定唯一方案而非留两个选项 | LOW |
| SUG-4 | plan.md Interface Contracts | `AgentCallOpts` 扩展字段 `phase?` 应注明在哪个 task 中添加到 TypeScript 接口定义（当前 AgentCallOpts 接口在 agent-pool.ts:27） | LOW |

---

## 7. Verdict

**PASS**

计划整体可行，spec 覆盖完整，任务拆分合理，依赖关系正确。源码交叉验证确认所有计划改动点都有对应的代码位置且实现路径清晰。4 个改进建议均为非阻塞级别，可在实施阶段处理。
