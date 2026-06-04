---
verdict: pass
must_fix: 0
---

# TypeScript 代码品味审查报告

**审查范围**: `extensions/workflow/src/` (5 文件，2429 行)
**变更范围**: git diff 5208e76..HEAD — 新增外部 JSONL 持久化、session approval gate、soft-limit warning、`state_lost` 状态、`verifyStrategy` 字段
**品味文档**: `~/.codetaste/essence.md` + `~/.codetaste/ts/taste.md`
**Lint**: taste-lint 已配置，51 warnings（0 errors），大部分为存量问题

---

## state.ts（275 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P1 | 跨文件同名类型 | L41 `WorkflowBudget` vs agent-pool.ts L99 | 两个文件各定义了同名 `WorkflowBudget` 但结构完全不同（state 版有 maxTokens/maxCost/usedTokens/usedCost；agent-pool 版有 total/used/remaining/isExhausted）。结构不同说明用途不同，但同名会造成 import 歧义 | 重命名 agent-pool 版为 `SoftLimitBudget` 或 `BudgetSnapshot`，语义更准确 |
| P1 | 跨文件同名类型 | L51 `AgentResult` vs agent-pool.ts L45 | 两文件各定义 `AgentResult`，字段不完全一致（state 版无 callId/success，agent-pool 版有）。orchestrator.ts 通过 `import type { AgentResult as StateAgentResult }` 手动消歧义，说明已有冲突 | agent-pool 版重命名为 `PoolAgentResult`，或 state 版改为 `WorkflowAgentResult`。消除手动 as 别名 |
| P3 | 遗留代码 | L220-225 `serializeState` / L230-248 `deserializeState` | 新增 `serializeInstance`/`deserializeInstance` 后，旧的批量序列化函数已不再被 import 使用（index.ts 和 orchestrator.ts 都改用新函数），但未删除 | 确认无外部引用后删除，避免混淆 |

**统计**: P0: 0 | P1: 2 | P2: 0 | P3: 1

---

## agent-pool.ts（466 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P1 | 同名类型冲突 | L99 `WorkflowBudget` | 与 state.ts L41 同名但结构完全不同。见 state.ts 审查项 | 重命名为 `SoftLimitBudget` |
| P2 | 静默吞错 | L232 `catch {}` | `maybeEmitSoftWarning` 中回调错误被完全吞掉。注释解释了原因（"callback errors must not affect dispatch"），但品味文档要求至少记录日志 | 加 `/* callback error intentionally swallowed — must not affect dispatch */` 注释解释为什么不需要日志，或用 `this.onSoftLimitReached?.(...)` 的 `?.` 让 TS 保证安全后去掉 try-catch |
| P2 | 死缓存逻辑 | L197-200 `_callCache.get(callId)` | `callId` 在 `enqueue()` 中每次生成 `agent-${randomUUID()}`，是唯一值。`_callCache` 只在 `run()` 内部 set，但 key 是这个随机 callId，永远不会 hit（除非外部 somehow 传入相同 callId，但 QueueEntry 不暴露 callId） | 如果缓存意图是 orchestrator 级别的 callCache（按 stepIndex 缓存），当前实现无法达成。移除此缓存或在 enqueue 参数中支持外部 callId |
| P2 | 硬编码 budget 值 | L202-206 `budget: { total: 0, used: 0, remaining: 0, isExhausted: false }` | `maybeEmitSoftWarning` 总是传入全零 budget。warning 消息说 "Budget: 0/unlimited tokens" 误导用户 | 从 orchestrator 传入实际 budget 信息，或移除 budget 参数直到有真实数据 |
| P3 | 构造函数签名兼容 | L120 `opts: AgentPoolOptions \| number = {}` | 支持 `number` 参数是为了向后兼容旧的 `new AgentPool(4)` 调用方式，合理但增加了认知负担 | 加 JSDoc 说明为什么支持 number 重载 |

**统计**: P0: 0 | P1: 1 | P2: 3 | P3: 1

---

## orchestrator.ts（761 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P1 | `as unknown as` 绕过类型 | L130 `(this.pi as unknown as { sendUserMessage: ... }).sendUserMessage(...)` | 用 `as unknown as` 访问 `pi.sendUserMessage`。品味文档明确反对用 `as` 绕过类型检查 | `ExtensionAPI` 类型应包含 `sendUserMessage`，如果确实缺失应在 shared/types stub 中补充声明 |
| P2 | fire-and-forget async | L528 `this.agentPool.enqueue(opts).then(async (poolResult) => { ... })` | `executeWithRetry` 是 async 函数但内部 `.then()` 而非 `await`。函数签名返回 `Promise<void>` 但调用方不 await 返回值（handleAgentCall L494 不 await executeWithRetry 的返回）。错误只会在 `.then()` 内部被吞掉 | 改为 `await this.agentPool.enqueue(opts)` 或明确文档化 fire-and-forget 意图 |
| P2 | 静默吞错 | L338 `catch {}` | `skipNode` 中 `postMessage` 失败被完全吞掉，无日志无注释 | 至少加注释说明为什么忽略（"Worker may have exited between has() and postMessage()"）——注释已有，可接受 |
| P2 | N+1 文件 I/O | L742-751 `persistState()` | 每次 persist 遍历所有实例，每个实例一次 `mkdir` + 一次 `appendFile` + 一次 `appendEntry`。如果实例数多且 persist 被高频调用（每次 agent call 完成都调），I/O 压力显著 | 考虑只写入状态变更的实例（dirty tracking），或在 append 模式下跳过 mkdir（只在首次创建） |
| P3 | 遗留 import | L30 `import { ... serializeInstance ... } from "./state.js"` | 旧的 `serializeState` 已从 import 移除（正确），但 `serializeInstance` 在 L749 使用。确认无遗漏 | 无问题，仅确认 |

**统计**: P0: 0 | P1: 1 | P2: 3 | P3: 1

---

## index.ts（762 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P0 | 函数过长 | L79 `workflowExtension` 566 行 | 品味文档 P0 规则：函数 >150 行必须拆分，>300 行几乎一定需要。当前 566 行严重超标 | 将 workflow-run tool 的 execute 拆分到独立文件 `tool-run.ts`（参照 `tool-generate.ts` 已有的模式），将 reconstructState 拆到 `state-io.ts` |
| P1 | 空 catch 吞错 | L120 `catch {}` reconstructState 内 | JSON parse 失败时跳过 malformed lines。品味文档要求至少日志 | 外层 catch L128 有 `ctx.ui.notify`，但内层 parse 失败完全静默。至少 `console.debug` |
| P1 | 空 catch 吞错 | L128 `catch {}` | 文件读取失败只 notify 但返回空 map。外层 L132 `catch {}` 连 notify 都没有 | 外层 catch 应该记录 getEntries 失败原因 |
| P1 | 类型断言无边界验证 | L112 `const data = custom.data as { runId?: string; path?: string } \| undefined` | 从 session entries 读取的 data 直接 `as` 断言。品味文档要求边界处验证 | `data?.runId && data?.path` 是运行时检查，可接受。但 `as` 断言本身无编译期安全保障——如果 entry 格式变更，不会报错 |
| P2 | import 冗余 | L20 `import { readFileSync } from "node:fs"` + L21 `import * as fs from "node:fs"` | 两个 fs import 存在于同一文件。`readFileSync` 用于 L705 读 SKILL.md，`fs.promises` 用于 reconstructState | 统一为 `import * as fs from "node:fs"` + `fs.readFileSync` |
| P2 | 空 catch 吞错 | L172-175 `entry.customType === "workflow-approval-memory"` | 遍历 entries 时 `entry` 类型未检查 `type === "custom"` 就访问 `entry.customType`，依赖隐式类型假设 | 与 L112 的处理模式不一致——那里检查了 `entry.type !== "custom"`，这里没有。保持一致 |
| P3 | `as` 类型断言散落 | 多处 `params.name as string`, `params.mode as string \| undefined` | TypeBox `Static<typeof Schema>` 已经提供具体类型，不需要 `as string` 断言 | 移除冗余 `as` 断言，直接使用 `params.name` |
| P3 | 未使用 import | L25 `deserializeInstance` 被 import 但 `ENTRY_TYPE` 被移除后留下了空行 | L26 有空行，不影响功能但影响可读性 | 清理空行 |

**统计**: P0: 1 | P1: 3 | P2: 2 | P3: 3

---

## tool-generate.ts（165 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P2 | 新增 promptGuideline 缺少对应代码执行 | L48 "Each agent() call should be verifiable..." | 新增了 verification 策略的指导，但 `verifyStrategy` 字段只在 state.ts `ExecutionTraceNode` 中定义，没有使用它的运行时逻辑。generate tool 不检查脚本是否真的包含 verification | 可接受——这是 steering guideline 而非代码约束。但 `verifyStrategy` 字段目前是纯声明性的，无运行时效果 |
| P3 | any 参数签名 | L50 `execute(_toolCallId: string, params: ..., _signal: ..., _onUpdate: any, _ctx: any)` | `_onUpdate` 和 `_ctx` 参数类型为 `any`。这是 Pi Extension API 的约束，扩展无法控制 | 在 `shared/types/mariozechner/index.d.ts` 补充更精确的类型桩 |

**统计**: P0: 0 | P1: 0 | P2: 1 | P3: 1

---

## 跨文件交叉分析

### 重复类型定义（P1）

| 类型 | 文件 1 | 文件 2 | 重叠度 | 建议 |
|------|--------|--------|--------|------|
| `WorkflowBudget` | state.ts L41（预算模型） | agent-pool.ts L99（快照视图） | 0% 字段重叠，仅同名 | agent-pool 版重命名为 `BudgetSnapshot` |
| `AgentResult` | state.ts L51（不含 callId/success） | agent-pool.ts L45（含 callId/success） | ~60% 字段重叠 | 一个重命名消除歧义 |

### 新增变更质量总结

| 变更 | 质量 | 说明 |
|------|------|------|
| 外部 JSONL 持久化 | 良好 | persistState 改为 async + 外部文件，reconstructState 改为读取指针+加载文件，逻辑清晰 |
| Session approval gate | 良好 | 用 Set + appendEntry 实现会话内确认记忆，避免重复确认。hasUI=false 有降级处理 |
| Soft-limit warning | 一般 | 实现正确但传入全零 budget 数据，warning 消息误导 |
| `state_lost` 状态 | 良好 | 状态机完整：加入 ALL_STATUSES、TERMINAL_STATUSES、VALID_TRANSITIONS（空数组=终端） |
| `verifyStrategy` 字段 | 仅声明 | state.ts 类型定义完整，但无运行时逻辑消费此字段 |

---

## 汇总

| 优先级 | 总数 | 分布 |
|--------|------|------|
| P0（结构问题） | 1 | index.ts 函数 566 行 |
| P1（类型/重复） | 6 | 同名类型冲突 3 处、空 catch 2 处、as unknown as 1 处 |
| P2（偏好/安全） | 9 | 死缓存逻辑、硬编码零值、fire-and-forget、N+1 I/O、import 冗余等 |
| P3（细节） | 6 | 遗留代码、冗余断言、空行等 |

### 建议重构顺序

1. **[P0]** 将 `workflowExtension` 中 workflow-run tool 拆到 `tool-run.ts`（收益最大，减少 ~200 行）
2. **[P1]** 重命名 agent-pool.ts 的 `WorkflowBudget` → `BudgetSnapshot`，`AgentResult` → `PoolAgentResult`
3. **[P1]** 补充 `ExtensionAPI` 类型桩中的 `sendUserMessage` 声明，消除 `as unknown as`
4. **[P2]** 移除 agent-pool.ts 中 `_callCache` 死代码，或重构使其生效
5. **[P3]** 删除 state.ts 中未使用的 `serializeState`/`deserializeState`

### Lint 状态

ESLint 51 warnings（0 errors）。增量变更未引入新的 lint error。warnings 多为存量的 `any`、magic numbers 和空 catch，与本次变更范围交叉的有：
- agent-pool.ts L232 空 catch（新增代码）
- orchestrator.ts L130 `as unknown as`（新增代码）
- index.ts L120/L128 空 catch（重构代码）
