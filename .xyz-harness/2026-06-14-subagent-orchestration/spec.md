# Subagent Background 回注 + 编排模式（Draft）

> **状态：Step 2 初稿**。本 spec 扩展 `2026-06-13-agent-runtime-workflow/spec.md` 的 D4（background fire-and-forget），回应 4 个核心问题：
> 1. subagent 默认 background 是否更优？
> 2. background 完成后是否回注到主进程？
> 3. 编排模式（chain/parallel/wave/fanout）。
> 4. 编排 × background 的组合关系。
>
> 参考实现：`tintinweb/pi-subagents`（spawn 子进程模型）。本 spec 保持 ADR-022 的 in-process 架构不变。

---

## Background

### 现状（已实现，spec D4 范围）

`extensions/subagents` 已有 background 模式（`runtime.ts:408 startBackground`），机制：

```
LLM 调 subagent 工具 (wait:false)
  → startBackground() 创建 BgRecord，detached runAgent().then()    [不 await]
    完成时：回填 record.result/status + emit pi.events "subagents:bg:done"
           + appendEntry "subagent-bg-record"
  → 立即返回 { id, status: "running" }
LLM 后续用 backgroundId 再调工具 → getBackground(id) 同步查 Map
```

### 四个核心缺口

**缺口 1：默认 background 的语义问题（Q1）。**
当前 `subagent-tool.ts:88` 是 `executionMode: "sequential"`，LLM 调工具语义是"调用→拿结果→决定下一步"。默认 background 后 LLM 拿到 `backgroundId` 而非结果，被迫 polling——但 LLM 不知道任务多久完成，polling 时机全靠猜。**sync 阻塞的是主 agent 的 LLM loop（必要的），不阻塞用户输入**（Pi TUI 在 agent 执行时用户可正常打字、Esc 中断）。

**缺口 2：background 完成不回注（Q2，最关键）。**
`runtime.ts:435/471` 的 `pi.events.emit("subagents:bg:done")` **没有订阅者**（已 grep 确认），`appendEntry("subagent-bg-record")` 只持久化不触发 turn。结果：background 完成后主 agent **完全不知道**，必须 LLM 猜时机主动 polling。

对比参考实现 `pi-subagents/src/runs/background/notify.ts:97`：用 `pi.sendMessage({customType:"subagent-notify", content, display:true}, {triggerTurn:true})` 完成时**触发新 turn**，零 polling。Pi 的 ExtensionAPI 提供此能力（`shared/types/mariozechner/index.d.ts:129 sendMessage`），当前扩展一次都没用过。

**缺口 3：无编排（Q3）。**
当前 `subagent` 工具只有 single sync / single bg / query 三模式。无 chain（顺序传递结果）、parallel（并发汇总）、wave（分波 barrier）、dynamic fanout（从 structured output 动态展开 N 个任务）。参考实现 `pi-subagents/src/runs/shared/` 有完整 DAG 编排。

**缺口 4：编排 × background 的组合关系未定义（Q4）。**
用户提出：wave 模式每个 wave 的 bg subagent 执行完应汇总 sync 注入主进程再下一 wave；chain 模式第一个 subagent 结果注入第二个。这需要明确定义编排（DAG）与 background（执行时机）是正交组合。

---

## Functional Requirements

### FR-O1: Background 完成回注主进程（Q2，P0，解锁其他）

**FR-O1.1** `startBackground` 的 detached promise 完成（成功/失败/取消）时，通过 `pi.sendMessage` 注入完成通知到主对话，`{ triggerTurn: true }` 触发新一轮 agent turn：

```typescript
// runtime.ts startBackground .then/.catch 路径内，emit 之后追加：
this.pi?.sendMessage(
  {
    customType: "subagent-bg-done",
    content: this.formatBgCompletionMessage(record),
    display: true,
  },
  { triggerTurn: true },
);
```

**FR-O1.2** `formatBgCompletionMessage(record: BgRecord): string` 格式化通知文本，主 agent 能基于它续接工作：
- 标题行：`Background task {status}: **{agent}**`
- 状态映射：done→"completed"、failed→"failed"、cancelled→"cancelled"
- 正文：结果摘要（`record.result.text` 截断或 `record.error`）
- 标识：backgroundId（供主 agent 必要时调用 `getBackground` 取完整结果）

**FR-O1.3 去重**：防止 background cancel 路径（`runtime.ts:503 cancelBackground`）和 `runAgent` 的 abort catch 双重 sendMessage。引入完成去重——每个 BgRecord 完成通知只发一次：
- `cancelBackground` 立即设 `record.status = "cancelled"` + 设标记位 `record.notified = false`
- `.catch` 路径检查 `record.status === "cancelled"` → 若已通知则跳过 sendMessage
- 或者：用一个 `Set<id>` 记录已发送通知的 id，发送前检查

**FR-O1.4 promptGuidelines 更新**：`subagent-tool.ts:77` 现有的 "poll with backgroundId later" 指引改为：
- "Pass `wait: false` for long-running tasks. After starting a background subagent, **end your turn**—the result will arrive automatically as a notification when it completes."
- "Do NOT run sleep loops or repeated polling calls."
- 保留 "Use backgroundId to check status/result of a specific prior background subagent when needed."

### FR-O2: Per-agent 默认 background 配置（Q1）

**FR-O2.1** `AgentConfig`（`types.ts:281`）新增可选字段：
```typescript
/** 该 agent 默认用 background 执行（LLM 未显式传 wait 时生效）。默认 false */
defaultBackground?: boolean;
```

**FR-O2.2** `subagent-tool.ts:170` 的 background 分支判定逻辑改为：
1. 若 params 显式传 `wait` → 用 params.wait（最高优先级）
2. 否则查 agent 配置的 `defaultBackground` → 用它
3. 否则默认 sync（`wait = true`）

**FR-O2.3** 依赖 FR-O1：在 FR-O1 实现前，`defaultBackground: true` 的 agent 仍需 LLM polling（体验差）。**FR-O2 应在 FR-O1 之后实现**，否则默认 background 等于默认让 LLM 猜 polling 时机。

**FR-O2.4** 长任务 agent（`researcher`/`scout`/`auditor` 类）的 frontmatter 示例：
```markdown
---
name: researcher
defaultBackground: true
---
```
builtin agents 默认不设 `defaultBackground`（保持 sync）。

### FR-O3: 编排模式（Q3）

> in-process 化移植自 `pi-subagents/src/runs/shared/`，把 spawn 换成 `runAgent`。

**FR-O3.1 编排工具入口**：扩展 `subagent` 工具的 params schema（`subagent-tool.ts:35`），新增编排字段（与现有 single/parallel 不冲突，按字段存在性路由）：

```typescript
const SubagentParams = Type.Object({
  // 现有字段：task, agent, wait, backgroundId
  task: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  wait: Type.Optional(Type.Boolean()),
  backgroundId: Type.Optional(Type.String()),

  // ── 新增：并行编排 ──
  tasks: Type.Optional(Type.Array(SubagentTaskItem)),   // parallel 模式
  concurrency: Type.Optional(Type.Number()),            // 并行度上限
  failFast: Type.Optional(Type.Boolean()),              // 任一失败立即终止其余

  // ── 新增：链式编排 ──
  chain: Type.Optional(Type.Array(ChainStep)),          // chain 模式

  // ── 新增：整链 async ──
  async: Type.Optional(Type.Boolean()),                 // 编排整体后台化
});
```

**FR-O3.2 parallel 模式（wave / fan-out）**：`tasks: [...]` 时：
- runtime 用 `mapConcurrent`（移植自 `pi-subagents/src/runs/shared/parallel-utils.ts:76`）按 `concurrency` 上限并发执行每个 task
- 全部完成后（`Promise.all`）汇总结果，按 task 顺序拼接（`aggregateParallelOutputs`，移植自同文件 :110）
- 汇总结果作为工具返回值注入主对话（sync 模式）或 sendMessage 回注（async 模式，见 FR-O5）
- `failFast: true` 时任一 task 失败立即 abort 其余并返回部分结果 + 错误
- **wave = 多个 parallel 顺序执行**：`chain: [{parallel:[...]}, {parallel:[...]}]`

**FR-O3.3 chain 模式（顺序传递）**：`chain: [step1, step2, ...]` 时：
- runtime 维护 `ChainOutputMap: Record<string, {text, structured?, agent, stepIndex}>`（移植自 `pi-subagents/src/runs/shared/chain-outputs.ts`）
- 每步 task 模板中的 `{outputs.name}` 占位符被 `resolveOutputReferences`（同文件 :70）替换为前序步骤的结果文本
- 每步可选 `as: "name"` 命名输出，供后续步骤引用
- 默认 task 模板：首步 `{task}`（用户初始任务），其余 `{previous}`（上一步结果）
- 严格顺序，无并发
- **校验**（移植自 `validateChainOutputBindings`，同文件 :24）：引用未定义的 name、重复 name、非法 name 格式均报错

**FR-O3.4 dynamic fanout（运行时展开）**：chain 的某步是 `{expand, parallel, collect}` 结构时：
- `expand.from: {output, path}` 引用前序步骤 named output 的 JSON Pointer 路径
- runtime 用 `resolveDynamicFanoutItems`（移植自 `pi-subagents/src/runs/shared/dynamic-fanout.ts:215`）解析为 N 个 items
- 每个 item 按 `parallel.task` 模板 + `expand.item` 名替换 `{item.path}` 占位符
- 并发执行（受 `concurrency` 限制）
- 完成后 `collect.as: "name"` 收集成数组，注入 ChainOutputMap
- **maxItems 上限**：防止失控展开（默认 12，移植自 `MAX_PARALLEL_CONCURRENCY`）
- **structured output 前置约束**：expand 引用的 named output 必须有 `outputSchema`（强约束形状才能可靠展开）

**FR-O3.5 file-only output（M3）**：单个 task 或编排步骤支持 `output: "reports/x.md", outputMode: "file-only"`：
- 结果只落盘到指定文件，不返回给调用方
- 主 agent 不消耗 context window 处理大输出
- 移植自 `pi-subagents/src/runs/shared/single-output.ts`

### FR-O4: 优先级与并发池（前置依赖，来自 handoff B2）

> 此 FR 来自 background-mode handoff 的 B2 问题，是编排正确性的前提。**编排会放大并发池饥饿问题**（10 个 parallel task + 4 个 background 会占满全局池）。

**FR-O4.1** background 调用传 `priority: 10`（或更大数字），sync 保持默认 `Infinity`（优先）。改动点：`subagent-tool.ts:170` 的 background 分支 + `startBackground` 传递。

**FR-O4.2（可选，需用户决策）** 拆池：`syncPool`（小额度，保证响应）+ `bgPool`（独立额度）。若 FR-O3 编排大量并发，拆池隔离更强。**倾向方案 A（优先级区分），改动小。**

### FR-O5: 编排 × background 的组合（Q4，核心）

**FR-O5.1 正交关系定义**：编排（chain/parallel/fanout）定义 DAG 结构，background（`async: true` 或 `wait: false`）是 DAG 的执行时机开关。两者正交。

```
                    ┌─ sync（阻塞调用者，返回最终汇总结果）
  编排 DAG ─────────┤
  (chain/parallel/  └─ async:true（立即返回 runId，DAG 后台执行，
   fanout)                              全部完成后 sendMessage 回注一次）
```

**FR-O5.2 wave 模式（parallel + sync barrier）**：`chain: [{tasks:[A,B,C]}, {tasks:[D,E]}]` 时：
- wave 1 = `[A,B,C]` 并发执行（受 concurrency 限制），`Promise.all` 同步点
- wave 1 全部完成 → 汇总 → 注入 wave 2 的 task 模板（通过 `{outputs.wave1}`）
- wave 2 = `[D,E]` 并发执行
- **每个 wave 内部不需要 LLM 编排**，由 runtime 用 `Promise.all` 实现同步点
- wave 之间是顺序的（chain 的语义）

**FR-O5.3 chain 模式（顺序 + output 注入）**：见 FR-O3.3。每步结果存入 ChainOutputMap，下一步 task 模板的 `{outputs.name}` 被替换。

**FR-O5.4 整链 async（chain + background）**：`chain: [...], async: true` 时：
- runtime 立即返回 `{ runId, status: "running" }`（复用 BgRecord 机制）
- chain 在后台顺序执行所有步骤（每步可能是 sync 或 parallel）
- 最后一步完成时，`sendMessage + triggerTurn` 一次（整链结果汇总）
- 主 agent 可继续其他工作，结果到了自动续上

**FR-O5.5 单个 background 与编排 background 的区别**：
- **单个 background**（现有 `wait: false`）：一个 subagent fire-and-forget，完成回注
- **编排 background**（`async: true`）：整个 DAG 后台化，全部完成后回注一次（不是每个 subagent 各回注一次）

---

## Acceptance Criteria

### AC-O1: Background 回注

1. 启动一个 background subagent（`wait: false`），主 agent 结束 turn
2. background 完成后，主对话出现 `subagent-bg-done` 类型消息，触发新一轮 turn
3. 主 agent 基于通知文本续接工作（无需 polling）
4. 用户 cancel 一个 running background → 只收到一条 cancelled 通知（不重复）

### AC-O2: Per-agent 默认 background

1. `researcher` agent frontmatter 设 `defaultBackground: true`
2. LLM 调 `subagent({agent:"researcher", task:"..."})`（不传 wait）→ 走 background
3. LLM 调 `subagent({agent:"researcher", task:"...", wait:true})` → 仍走 sync（显式覆盖）
4. completion 自动回注（依赖 AC-O1）

### AC-O3: parallel 编排

1. LLM 调 `subagent({tasks:[{agent:"scout",task:"a"},{agent:"reviewer",task:"b"}]})`
2. 两个 subagent 并发执行（受 concurrency 限制）
3. 工具返回汇总结果（两个 task 的输出拼接）
4. `failFast:true` 时一个失败 → 另一个被 abort → 返回部分结果 + 错误

### AC-O4: chain 编排

1. LLM 调 `subagent({chain:[{agent:"scout",task:"gather",as:"ctx"},{agent:"worker",task:"implement from {outputs.ctx}"}]})`
2. scout 执行完成，结果存入 ChainOutputMap["ctx"]
3. worker 的 task 中 `{outputs.ctx}` 被替换为 scout 的结果文本
4. 引用未定义的 name → 报错（不静默失败）

### AC-O5: 编排 × background 组合

1. wave 模式：`chain:[{tasks:[A,B]},{tasks:[C,D]}]` → A/B 并发→barrier→C/D 并发→barrier→汇总
2. 整链 async：`chain:[...],async:true` → 立即返回 runId → 后台执行 → 完成回注一次
3. 单个 background 与编排 background 区分清晰（前者每 subagent 回注，后者整 DAG 回注一次）

---

## Constraints

- **ADR-022 不变**：in-process 执行（`createAgentSession`），不引入 spawn 子进程。background 是 fire-and-forget Promise，不是 OS 进程
- **ADR-024 不变**：已完成 L1（history.jsonl）+ L2（session 文件）持久化。**不做 L3（跨进程恢复运行中的 background）**
- **Pi ExtensionAPI 能力**：`sendMessage(msg, {triggerTurn:true})` 已确认可用（`shared/types/mariozechner/index.d.ts:129`）。无需 fs watcher（in-process 架构下 detached promise 完成时直接 sendMessage）
- **编排移植范围**：本 spec 移植 `pi-subagents/src/runs/shared/` 的编排逻辑（chain-outputs / parallel-utils / dynamic-fanout），**不移植** spawn/intercom/result-watcher（那是子进程模型的 IPC 机制）
- **并发池**：编排会放大并发池饥饿，FR-O4 是前置依赖
- **结构化输出强约束**：dynamic fanout 的 expand 依赖前序步骤的 structured output，必须有 `outputSchema` 约束形状

---

## 业务用例

### UC-O1: 开发者启动长任务调研并继续其他工作（Q1+Q2）

- **Actor**: 开发者
- **场景**: 开发者让主 agent 调研一个技术方案（`researcher` agent，耗时 5 分钟）。主 agent 启动 background 后结束 turn，开发者继续问主 agent 其他问题
- **预期结果**: researcher 完成后，结果自动注入主对话触发新 turn，主 agent 基于调研结果回答原始问题。开发者无需等待，无需 LLM polling

### UC-O2: 多角度代码审查（Q3 parallel）

- **Actor**: 开发者
- **场景**: 开发者要审查一个 PR，从安全、性能、可读性三个角度并行审查
- **预期结果**: LLM 调 `subagent({tasks:[{agent:"reviewer",task:"security audit"},{agent:"reviewer",task:"perf review"},{agent:"reviewer",task:"readability"}]})`，3 个 reviewer 并发，完成后汇总三份审查报告

### UC-O3: 渐进式重构（Q3 chain）

- **Actor**: 开发者
- **场景**: 大重构需要先侦查代码结构，再规划，再实施，最后审查
- **预期结果**: LLM 调 `chain:[scout→planner→worker→reviewer]`，每步结果注入下一步。scout 的代码地图传给 planner，planner 的计划传给 worker，worker 的 diff 传给 reviewer

### UC-O4: 动态批量审查（Q3 fanout）

- **Actor**: 开发者
- **场景**: 开发者让 scout 扫描出所有需要审查的文件，然后对每个文件并行 review
- **预期结果**: scout 返回 structured output `{items:[{path,reason}]}`，fanout 展开成 N 个 reviewer 任务（受 maxItems 限制），完成后 collect 成 `{reviews:[...]}` 注入 worker 综合修复

---

## 实现优先级

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **P0** | FR-O1（回注）+ FR-O4（并发池优先级） | 当前架构即可 |
| **P0** | FR-O2（per-agent defaultBackground） | 依赖 P0-O1 |
| **P1** | FR-O3.2 parallel + FR-O3.3 chain | 移植 parallel-utils / chain-outputs |
| **P2** | FR-O3.4 dynamic fanout + FR-O5.4 整链 async + FR-O3.5 file-only | 移植 dynamic-fanout |

---

## Open Questions（待 Step 3 追踪后确认）

> 这些是写初稿时发现的待确认点，不阻塞初稿。Step 3 的 5 视角追踪会进一步发现遗漏。

- **Q-A**: `sendMessage({triggerTurn:true})` 在主 agent **正在执行**（用户已发起 turn，agent 还在跑）时的行为？是排队还是立即注入？影响 background 完成时机
- **Q-B**: 多个 background 同时完成时，是否合并成一条通知（防止 N 个 turn 刷屏）？参考实现的 `completion-dedupe.ts` + `parallel-groups.ts` 提供了合并机制
- **Q-C**: 编排工具入口——是扩展现有 `subagent` 工具的 params，还是注册独立 `orchestrate` 工具？前者 LLM 单工具，后者职责分离
- **Q-D**: `{outputs.name}` 模板替换——是否支持 JSON 路径（`{outputs.scan.files}`）还是只支持整体文本替换？参考实现支持 JSON Pointer
