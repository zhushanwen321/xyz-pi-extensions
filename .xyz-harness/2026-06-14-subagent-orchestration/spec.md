---
verdict: pass
---

# Subagent Background 回注 + 编排模式

> 本 spec 扩展 `2026-06-13-agent-runtime-workflow/spec.md` 的 D4（background fire-and-forget），回应 4 个核心问题：
> 1. subagent 默认 background 是否更优？
> 2. background 完成后是否回注到主进程？
> 3. 编排模式（chain/parallel/wave/fanout）。
> 4. 编排 × background 的组合关系。
>
> 参考实现：`tintinweb/pi-subagents`（spawn 子进程模型）。本 spec 保持 ADR-022 的 in-process 架构不变。
>
> **追踪状态**：经 2 轮独立 subagent 5 视角追踪（Round 1: 27 gaps，Round 2: 8 gaps），全部处理。详见 `changes/tracing-round-1.md` 和 `changes/tracing-round-2.md`。

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
    customType: "subagent-bg-notify",  // G-008 修正：统一命名（不与参考实现的 "subagent-notify" 混淆）
    content: this.formatBgCompletionMessage(record),
    display: true,
  },
  { triggerTurn: true },
);
```

**FR-O1.2** `formatBgCompletionMessage(record: BgRecord): string` 格式化通知文本，主 agent 能基于它续接工作（G-009 修正：补全参考实现 notify.ts:87-95 的字段）：
- 标题行：`Background task {status}: **{agent}**{taskInfo}`
  - 状态映射：done→"completed"、failed→"failed"、cancelled→"cancelled"
  - taskInfo：编排进度（如 ` (2/4)`），单个 background 无此项
- 正文：结果摘要（`record.result.text` 截断或 `record.error`）
- 标识：backgroundId（供主 agent 必要时调用 `getBackground` 取完整结果）
- sessionFile 引用：`Session file: {path}`（若存在 record.result.sessionFile，主 agent 续接时可能需要读 session 文件取完整上下文）

**FR-O1.3 去重（G-024 修正：采用参考实现的 TTL 机制）**：防止 background cancel 路径（`runtime.ts:503 cancelBackground`）和 `runAgent` 的 abort catch 双重 sendMessage。移植参考实现的 `completion-dedupe.ts`：
- 全局 `Map<string, number>`（key→过期时间戳），`buildCompletionKey(data, scope)` 构造去重 key
- `markSeenWithTtl(seen, key, now, ttlMs)`：key 已存在且未过期 → 返回 true（跳过发送）；否则记录 key + now+ttl → 返回 false（允许发送）
- TTL = 10 分钟（移植自 notify.ts:56）
- **G-004 关联**：此去重机制只解决 sendMessage 双发。history.jsonl 的双写（cancelBackground 写 cancelled + runAgent catch 写 failed）需单独处理——见 FR-O1.6。

**FR-O1.4 promptGuidelines 更新**：`subagent-tool.ts:77` 现有的 "poll with backgroundId later" 指引改为：
- "Pass `wait: false` for long-running tasks. After starting a background subagent, **end your turn**—the result will arrive automatically as a notification when it completes."
- "Do NOT run sleep loops or repeated polling calls."
- 保留 "Use backgroundId to check status/result of a specific prior background subagent when needed."

**FR-O1.5 多 background 合并窗口（G-015 用户决策：合并窗口）**：多个 background 在短时间窗口内完成时，合并为一条通知（防止 N 个 turn 刷屏）：
- runtime 维护一个 pending 通知队列 + flush 定时器（窗口默认 2000ms，参考 completion-dedupe 的批处理思路）
- 窗口内的完成事件先入队，定时器到期时合并成一条 `subagent-bg-notify` 消息（content 含所有完成记录的摘要列表），一次 sendMessage + triggerTurn
- **编排模式不受影响**：编排内部本就在 runtime 内同步汇总（Promise.all），完成时已是一次性 sendMessage（FR-O5.4）
- **G-028 决策（单个 background 零延迟）**：首个完成事件**立即发送**（不延迟），同时启动 2000ms 合并窗口；窗口内的后续完成事件入队，窗口到期合并发送一条。这样单个 background 零延迟，多个几乎同时完成的 background 被合并。
- **G-029 定时器清理**：合并窗口的 flush 定时器用 `setTimeout(...).unref()`（不阻止进程退出）；runtime 新增 `dispose()` 方法，在 session 结束时调用，清理所有 pending 定时器并 flush 残留通知（best-effort，ADR-024 不做跨进程恢复）
- [GAP G-016 仍开放：triggerTurn 在主 agent 正在执行时的排队/注入行为，需在实现时验证 Pi SDK 行为]

**FR-O1.6 history 双写去重（G-004 补充）**：`cancelBackground`（runtime.ts:513）写一条 "cancelled"，`runAgent` 的 abort catch（runtime.ts:377）会再写一条 "failed"。spec 初稿提的"去重由 list 视图的 id + 最新时间戳处理"需要确认 `listHistory` 的合并逻辑：
- **方案**：`listHistory` 按 id 合并，同 id 取最新 endedAt 的记录（cancelled 优先于 failed，因 cancelBackground 先设 status）。`commands/` 下的 `/subagents list` 视图实现需验证此合并逻辑是否已存在，不存在则补充
- **长期**：`cancelBackground` 不写 history，让 `runAgent` catch 路径检查 `signal.aborted` → 写 cancelled 一条（需 runAgent catch 能区分 abort 和真实错误）

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

**FR-O3.1 编排工具入口**：注册独立的 `orchestrate` 工具（用户决策，闭合 G-013），与现有 `subagent` 工具职责分离：
- `subagent` 工具保持不变：single sync / single background（wait:false）/ query（backgroundId）三模式
- `orchestrate` 工具处理 tasks（parallel）/ chain（sequential）/ fanout，可选 `async: true` 整体后台化

```typescript
// orchestrate 工具 params（独立工具，不污染 subagent 工具）
const OrchestrateParams = Type.Object({
  // ── 并行编排 ──
  tasks: Type.Optional(Type.Array(SubagentTaskItem)),   // parallel 模式
  concurrency: Type.Optional(Type.Number()),            // 并行度上限
  failFast: Type.Optional(Type.Boolean()),              // 任一失败立即终止（chain 默认 true，见 FR-O5.6）

  // ── 链式编排 ──
  chain: Type.Optional(Type.Array(ChainStep)),          // chain 模式

  // ── 整链 async ──
  async: Type.Optional(Type.Boolean()),                 // 编排整体后台化
});
```

### FR-O3.1a: 参数前置校验（P0，所有模式强制）—— G 补充

**问题**：当前参数校验是惰性的（执行到某个 step 时在 `runAgent` 内部才校验，`core/run-agent.ts` 步骤 1）。编排模式下，参数错误可能要执行完前序 step（耗时 + 烧 token）才暴露：

```
错误时序（当前）:
  orchestrate({chain:[scout, planner(badModel), worker]})
    → 执行 scout（30s + token）
    → 执行 planner → runAgent 内部才发现 badModel 不存在 → 报错
    → scout 的 30s + token 全浪费
```

**FR-O3.1a.1 校验时机**：`orchestrate` 和 `subagent` 工具的 `execute()` 入口，**在任何执行启动之前**，遍历所有 step 做全量参数校验。任何一项失败立即返回 tool error（不启动任何 subagent）。

**FR-O3.1a.2 校验函数** `validateSubagentParams(params, rt): string | null`（返回 null=通过，string=错误描述）：

| 校验项 | 校验内容 | 校验方式 | 失败行为 |
|--------|---------|----------|----------|
| `agent` | AgentRegistry 中是否存在（project/user/builtin）？ | `rt.agentRegistry.get(name)`（discover 后），不存在则报 "Unknown agent '{name}'. Available: {列表}" | 返回 tool error |
| `model`（显式传） | `"provider/modelId"` 能否 `modelRegistry.find` 到？`hasConfiguredAuth`？ | `rt.modelRegistry.find(provider, modelId)`，null 或 !hasConfiguredAuth → 报错，列出该 provider 可用 model | 返回 tool error |
| `thinkingLevel` | 合法枚举（`"off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"`）？该 model 的 `thinkingLevelMap` 是否支持（非 null）？ | 枚举检查 + `model.thinkingLevelMap[level] !== null` | 返回 tool error |
| `task` | 非空字符串？ | 已有（subagent-tool.ts:162），orchestrate 工具同样强制 | 返回 tool error |
| `maxTurns` | 正整数？（若传） | `Number.isInteger && > 0` | 返回 tool error |
| `graceTurns`（G-034 补充） | 正整数？（若传） | `Number.isInteger && > 0` | 返回 tool error |
| `concurrency` | 正整数？（若传） | `Number.isInteger && > 0` | 返回 tool error |
| `skillPath`（若传） | 文件存在？ | `fs.existsSync` | 返回 tool error |
| `schema`（G-034 补充） | 合法 JSON Schema 对象？（若传） | `typeof === "object" && !Array.isArray && typeof schema.type === "string"`，更深层校验交给 structured-output tool 运行时 | 返回 tool error |
| `appendSystemPrompt`（G-034 补充） | 字符串数组？（若传） | `Array.isArray && every(i => typeof i === "string")` | 返回 tool error |
| `output`（G-034 补充） | 合法文件路径？（若传） | 路径非空、父目录可写（`fs.access(dir, W_OK)`）；`output: false` 合法（禁用输出） | 返回 tool error |
| `outputMode`（G-034 补充） | 枚举值？（若传） | `["inline", "file-only"].includes(v)` | 返回 tool error |

**FR-O3.1a.3 编排结构校验**（编排模式额外校验，在执行前全量检查）：

| 校验项 | 校验内容 | 来源 |
|--------|---------|------|
| chain `{outputs.name}` 引用完整性 | 引用的 name 是否都已定义在前序 step？name 格式合法（`/^[A-Za-z_][A-Za-z0-9_]*$/`）？无重复 name？ | 移植 `validateChainOutputBindings`（chain-outputs.ts:24） |
| fanout `expand.from.output` | 指向已定义的 named output？该 output 有 `outputSchema`？ | 移植 `validateDynamicStepShape`（dynamic-fanout.ts:181） |
| fanout `expand.from.path` | 合法 JSON Pointer（`/` 开头）？ | 移植 `assertJsonPointer`（dynamic-fanout.ts:60） |
| fanout `maxItems` | 必须显式配置（step 级或 config 级）？正整数？**G-002 修正：无默认值，未配置则报错**（dynamic-fanout.ts:192-194） | 移植 |
| fanout `expand.key` | 若配置，去重 key 无重复？ | 移植（dynamic-fanout.ts:229-235，闭合 G-021） |
| fanout `collect.as` | 合法 name？无重复？ | 移植 |

**FR-O3.1a.4 错误聚合**：编排有多个 step 时，**收集所有错误一次性返回**（不是遇到第一个就停），格式：

```
Validation failed (3 errors):
  - Step 2 (planner): Unknown model 'badProvider/badModel'. Available: [list]
  - Step 3 (worker): thinkingLevel 'high' not supported by model 'mimo-v2.5' (supports: low, medium)
  - Step 4: chain output reference '{outputs.scan}' is undefined
```

LLM 看到全部错误后可一次性修正所有参数重试，避免"修一个错跑一遍又遇下一个错"的多次浪费。

**FR-O3.1a.5 single 模式同样适用**：`subagent` 工具（single sync/bg）的 `execute()` 入口也调用 `validateSubagentParams`。当前 `task` 缺失已在入口检查（subagent-tool.ts:162），扩展到 agent/model/thinkingLevel 全量校验。

**注意**：前置校验只校验**静态可验证**的参数。运行时才能确定的错误（如 LLM API rate limit、agent 执行中 tool 报错）仍走正常失败路径，不在前置校验范围内。

> **G-048 修正**：FR-O3.1 已决策独立 `orchestrate` 工具（G-013 闭合），`subagent` 工具保持不变（single sync/bg/query 三模式）。前置校验函数 `validateSubagentParams` **被两个工具共用**：
> - `orchestrate` 工具的 `execute()` 入口：校验 OrchestrateParams 中每个 step 的 agent/model/thinkingLevel + 编排结构（chain 引用、fanout expand）
> - `subagent` 工具的 `execute()` 入口：校验 SubagentParams（task/agent/model/thinkingLevel，无 tasks/chain 字段）
>
> 两个工具的 params 互不污染（OrchestrateParams 见 FR-O3.1 :140，SubagentParams 见 subagent-tool.ts:35 现有定义不变）。

**FR-O3.2 parallel 模式（wave / fan-out）**：`tasks: [...]` 时：
- runtime 用 `mapConcurrent`（移植自 `pi-subagents/src/runs/shared/parallel-utils.ts:76`）按 `concurrency` 上限并发执行每个 task
- 全部完成后（`Promise.all`）汇总结果，按 task 顺序拼接（`aggregateParallelOutputs`，移植自同文件 :110）
- 汇总结果作为工具返回值注入主对话（sync 模式）或 sendMessage 回注（async 模式，见 FR-O5）
- `failFast: true`（parallel 默认）时任一 task 失败立即 abort 其余并返回部分结果 + 错误
- **wave = 多个 parallel 顺序执行**：`chain: [{parallel:[...]}, {parallel:[...]}]`
- **G-019 补充**：parallel step 的每个 task 默认模板 = `"{previous}"`（继承上一步输出，移植自 parallel-utils.ts:19）。parallel.task 模板里 `{outputs.name}` 同样生效（引用前序 named output）。

**FR-O3.3 chain 模式（顺序传递）**：`chain: [step1, step2, ...]` 时：
- runtime 维护 `ChainOutputMap: Record<string, {text, structured?, agent, stepIndex}>`（移植自 `pi-subagents/src/runs/shared/chain-outputs.ts`）
- 每步 task 模板中的 `{outputs.name}` 占位符被 `resolveOutputReferences`（同文件 :70）替换为前序步骤的结果文本
- **G-003 修正（Q-D 闭合）**：`{outputs.name}` **只支持整体文本替换，不支持 JSON 路径**（`{outputs.scan.files}` 无效）。代码事实：`resolveOutputReferences` 返回 `entry.text`（chain-outputs.ts:77）。JSON 路径能力仅存在于 dynamic-fanout 的 `expand.from.path` 和 `{item.path}`（dynamic-fanout.ts:130-134），属于不同机制。若需 JSON 路径，需新增代码（不在移植范围）。
- 每步可选 `as: "name"` 命名输出，供后续步骤引用
- 默认 task 模板：首步 `{task}`（用户初始任务），其余 `{previous}`（上一步结果）
- 严格顺序，无并发
- **校验**（移植自 `validateChainOutputBindings`，同文件 :24，已在 FR-O3.1a 前置校验中调用）：引用未定义的 name、重复 name、非法 name 格式均报错

**FR-O3.4 dynamic fanout（运行时展开）**：chain 的某步是 `{expand, parallel, collect}` 结构时：
- `expand.from: {output, path}` 引用前序步骤 named output 的 JSON Pointer 路径
- runtime 用 `resolveDynamicFanoutItems`（移植自 `pi-subagents/src/runs/shared/dynamic-fanout.ts:215`）解析为 N 个 items
- 每个 item 按 `parallel.task` 模板 + `expand.item` 名替换 `{item.path}` 占位符
- 并发执行（受 `concurrency` 限制）
- 完成后 `collect.as: "name"` 收集成数组，注入 ChainOutputMap
- **G-002 修正 maxItems**：maxItems **无默认值**，必须显式配置（step 级 `expand.maxItems` 或 config 级 `dynamicFanout.maxItems`），两者都未配置则抛错（dynamic-fanout.ts:192-194）。`MAX_PARALLEL_CONCURRENCY=4`（parallel-utils.ts:137）是**并发度上限**，不是 fanout 的 maxItems。spec 推荐 config 级默认 `dynamicFanout.maxItems: 12`（在 global-config.ts 配置），避免每个 step 都要写。
- **G-020 补充 expand.onEmpty**：源数组展开为空时，`onEmpty: "skip"`（默认）返回空 collected（后续 step 拿到空数组），`onEmpty: "fail"` 抛错（dynamic-fanout.ts:244）。
- **G-021 补充 expand.key 去重**：若配置 `expand.key`（JSON Pointer 提取 item 的 key），重复 key 抛错（dynamic-fanout.ts:229-235）。已在 FR-O3.1a 前置校验。
- **G-022 补充 collect.outputSchema**：`collect` 可选 `outputSchema`，对收集结果做 schema 校验，失败抛 DynamicFanoutError（dynamic-fanout.ts:287）。
- **structured output 前置约束**：expand 引用的 named output 必须有 `outputSchema`（强约束形状才能可靠展开，dynamic-fanout.ts:220）

**FR-O3.5 file-only output（M3）**：单个 task 或编排步骤支持 `output: "reports/x.md", outputMode: "file-only"`：
- 结果只落盘到指定文件，不返回给调用方
- 主 agent 不消耗 context window 处理大输出
- 移植自 `pi-subagents/src/runs/shared/single-output.ts`

**FR-O3.6 大输出自动落盘（G-012 用户决策：超阈值自动落盘）**：chain 步骤间结果注入时，上一步输出超过阈值自动落盘，防止 context 撑爆：
- 阈值：单步结果文本超过 `CHAIN_OUTPUT_INLINE_MAX_TOKENS`（默认 4000 tokens，约 12000 中文字符，与 fork-context 的 maxTokens 对齐）时触发
- 行为：结果落盘到临时文件（`{tmpdir}/chain-{runId}/step-{n}-output.md`），下一步 task 中 `{outputs.name}` 替换为 `"[Large output saved to {path}. Summary: {前500字符}...]"`
- step 可显式配置 `output: "reports/x.md"` + `outputMode: "file-only"` 完全跳过注入（FR-O3.5）
- 这是安全网，step 级显式配置优先
- **G-035 落盘失败兜底**：落盘失败（磁盘满/权限拒绝/路径非法）时，回退到内联注入（截断到阈值，记录 warning 日志）。不终止 chain——大输出截断好过 chain 中断。
- **G-031 临时文件清理**：chain 编排完成（成功/失败/取消）后，runtime 清理 `{tmpdir}/chain-{runId}/` 目录（best-effort，`fs.rmSync(recursive)`）。同时在 runtime `dispose()` 时清理所有残留的 chain 临时目录（进程退出兜底）。

**FR-O3.7 ChainOutputMap 清理（G-032）**：chain 编排完成后，runtime 清理该编排的 ChainOutputMap（释放内存）。整链 async 的 ChainOutputMap 在 BgRecord 完成回注后清理。与 FR-O5.9 的 _bgRecords 清理独立（BgRecord 保留供查询，ChainOutputMap 是执行期中间数据无需保留）。

### FR-O4: 优先级与并发池（前置依赖，来自 handoff B2）

> 此 FR 来自 background-mode handoff 的 B2 问题，是编排正确性的前提。**编排会放大并发池饥饿问题**（10 个 parallel task + 4 个 background 会占满全局池）。

**G-001 修正**：spec 初稿的 priority 方向写反了。代码事实（concurrency-pool.ts:33-38 + 测试 :45-46）：**priority 数值小 = 优先级高**（0 最优先，Infinity 最低）。spec 初稿写"background 传 10，sync 保持 Infinity（优先）"——实际 10 < Infinity，background 反而更优先，与意图相反。

**FR-O4.1（用户决策：修正 priority 方向，单池）**：
- sync 调用传 `priority: 0`（最高优先级，保证响应）
- background 调用传 `priority: 1000`（低优先级，不抢占 sync）
- 编排（orchestrate 工具）的内部 step：sync 编排的 step 传 `priority: 0`；async 编排的 step 传 `priority: 1000`
- 调用方不传 priority 时，默认 `Infinity`（最低，FIFO）——保持现有行为不变
- 改动点：`subagent-tool.ts` sync 分支（:222）传 `priority: 0`；background 分支 + `startBackground` 传 `priority: 1000`；orchestrate 工具按 async 标志传递
- **不拆池**（用户决策），复用现有 `globalPool`

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

**FR-O5.3 chain 模式（顺序 + output 注入）**：见 FR-O3.3。每步结果存入 ChainOutputMap，下一步 task 模板的 `{outputs.name}` 被替换（FR-O3.6 超阈值自动落盘保护 context）。

**FR-O5.4 整链 async + 单 BgRecord 聚合（G-017 用户决策：单 BgRecord 聚合）**：`chain: [...], async: true` 时：
- runtime 立即返回 `{ runId, status: "running" }`
- **runId 对应一个 BgRecord**（id=runId），编排内部的多个 subagent 是实现细节，不暴露为独立 BgRecord
- `BgRecord.result` 存**汇总结果**（末步输出，或 parallel 的 aggregateParallelOutputs）
- `BgRecord.status` 从内部 step 推导：全部 done → done；任一 failed 且 failFast → failed；被 cancel → cancelled（FR-O5.5）
- chain 在后台顺序执行所有步骤（每步可能是 sync 或 parallel）
- 最后一步完成时，`sendMessage + triggerTurn` 一次（整链结果汇总，经 FR-O1.5 合并窗口）
- `getBackground(runId)` 返回该 BgRecord（汇总状态 + 汇总结果）
- 主 agent 可继续其他工作，结果到了自动续上

**FR-O5.5 cancel 编排 = abort 整个 DAG（G-011 用户决策：abort 整个 DAG）**：
- `cancelBackground(runId)` 时，runtime 遍历该编排所有正在执行的内部 subagent，逐个 abort（级联 AbortController）
- 未启动的 step 标 `skipped`（不执行）
- **已完成的 step 结果保留在 ChainOutputMap**（不丢弃，便于事后排查）
- BgRecord.status → cancelled，result 存已完成 step 的部分汇总
- 实现方式：编排持有 `AbortController` 树（根 controller → 各 step controller），cancel 根 controller 通过 `signal.addEventListener("abort")` 级联 abort 所有子 controller
- **G-030 监听器清理**：abort 监听器用 `{ once: true }` 选项注册（触发后自动移除）；编排完成（正常/取消）时显式 `removeEventListener` 残留监听器 + dispose 所有 step controller，防止内存泄漏

**FR-O5.6 chain failFast（G-014 用户决策：failFast 默认开）**：
- chain 模式 `failFast` 默认 `true`：某步失败 → abort 后续所有 step（标 skipped），返回已完成 step 结果 + 失败点
- parallel 模式 `failFast` 默认 `true`（已有，FR-O3.2）
- 编排级可选 `failFast: false` 覆盖（chain 和 parallel 统一语义）：失败 step 的输出用错误文本注入下一步，后续 step 继续
- 整链 async 的"全部完成"语义：failFast=true 时遇到首个失败即视为完成（status=failed）；failFast=false 时所有 step 执行完才完成

**FR-O5.7 编排中 steer（G-010 用户决策：支持中间 steer）**：
- 编排内部的 step 改用 `ManagedSession`（而非一次性 `runAgent`），以支持 steer
- 每个 step 创建一个 ManagedSession，执行完后 dispose（除非配置 `keepAlive`）
- 用户可通过 `steerBackground(runId, stepIndex, message)` 向指定 step 注入 steer 消息
- steer 路由：runId → 编排上下文 → stepIndex → 对应 ManagedSession.steer(message)
- **约束**：steer 只对"当前正在执行的 step"有效；已完成的 step 不可 steer；未启动的 step 的 steer 消息缓存，待其启动时注入
- 与 failFast 的交互：steer 不改变 failFast 语义（steer 是引导方向，不是失败）
- **G-033 触发入口（P2 阶段定义）**：`steerBackground` 的触发入口在 P2 阶段实现时确定，候选方案：(a) 新增 LLM 工具 `steer_subagent`（主 agent 可主动 steer）；(b) slash command `/subagents steer <runId> <step> <message>`（用户手动 steer）；(c) TUI 快捷键（在 `/subagents list` 详情视图按 `s` 输入 steer 消息）。**推荐 (b) slash command**（与 cancel 的交互模式一致，用户可控），P2 时最终确认。
- **复杂度提示**：此 FR 增加 ManagedSession 生命周期管理复杂度，建议在 P2 阶段实现（与 dynamic fanout 同期），P0/P1 阶段编排先用 runAgent（不支持 steer）

**FR-O5.8 单个 background 与编排 background 的区别**：
- **单个 background**（现有 `wait: false`）：一个 subagent fire-and-forget，完成回注
- **编排 background**（`async: true`）：整个 DAG 后台化，单 BgRecord 聚合，全部完成后回注一次（不是每个 subagent 各回注一次）

**FR-O5.9 BgRecord 清理（G-018）**：`_bgRecords` Map 新增清理策略，防止内存无限增长：
- 上限 `BG_RECORDS_MAX = 50`（类比 COMPLETED_AGENTS_MAX），FIFO 淘汰最旧
- 已完成（done/failed/cancelled）的 record 保留供 `/subagents list` 查看，超上限时移除最旧
- 单个 background 完成后 record 不立即删除（保留供查询）

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
- **events.on 可选**（G-007）：`pi.events.on` 是可选方法（index.d.ts:142 `on?`）。本 spec 的回注用 sendMessage（不依赖 events 订阅），但若未来需要 events 做内部聚合需确认 on 存在
- **编排移植范围**：本 spec 移植 `pi-subagents/src/runs/shared/` 的编排逻辑（chain-outputs / parallel-utils / dynamic-fanout），**不移植** spawn/intercom/result-watcher（那是子进程模型的 IPC 机制）
- **并发池**：编排会放大并发池饥饿，FR-O4 是前置依赖
- **结构化输出强约束**：dynamic fanout 的 expand 依赖前序步骤的 structured output，必须有 `outputSchema` 约束形状
- **资源清理**（G-029/030/031/032）：合并窗口定时器、AbortController 监听器、临时落盘文件、ChainOutputMap 都需在编排完成/runtime dispose 时清理，防止内存/磁盘泄漏
- **前置依赖 bug**（G-005/G-027）：runtime.ts:431/467 的 eventLog 竞态（`startsWith("run-")` 匹配错误 widget）需在编排实现前修复——编排会放大此竞态（更多并发 background）。此 bug 来自 `/tmp/background-mode-handoff-2026-06-14.md` 的 B1（非仓库文件，会话产出）
- **TUI 展示**（G-023 已闭合）：编排的并发 agent 在对话流/list 视图的展示见 FR-O6（1 个聚合 block + DAG 内嵌 + phase 进度），与 `2026-06-14-subagent-tui` spec 的单个 subagent 渲染基础设施联动

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

### UC-O5: 开发者观察编排执行进度（FR-O6 压缩视图）

- **Actor**: 开发者
- **场景**: 开发者发起 parallel 编排（3 个 worker 并发实现不同模块），想在对话流观察整体进度，不需要逐个查看
- **预期结果**: 对话流出现 1 个聚合 block（黄背景）：第 1 行 spinner + "orchestrate │ parallel │ 1/3 done │ 2 running"；第 2 行 phase 进度条 `[███░░░░░░░]`；第 3-5 行各 step 概要（✓ worker-A done / ⟳ worker-B running / ⟳ worker-C running）。开发者一眼看到全局进度

### UC-O6: 开发者排查编排中失败的 step（FR-O6 展开 + list）

- **Actor**: 开发者
- **场景**: 一个 chain 编排（scout→planner→worker→reviewer）在 reviewer 步骤失败，开发者想知道哪一步出错
- **预期结果**: 对话流 block 背景变红，压缩视图显示 reviewer 的 ✗ + error 摘要。开发者按 ctrl+o 展开，看到 reviewer 的 eventLog（哪个 toolcall 失败）。或进入 `/subagents list` → 选中 orch 编排行 → Enter 进入 DAG 详情 → j/k 滚动到 reviewer step 看完整 eventLog + error

---

## 实现优先级

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **P0** | FR-O1（回注）+ FR-O4（并发池优先级） | 当前架构即可 |
| **P0** | FR-O2（per-agent defaultBackground） | 依赖 P0-O1 |
| **P1** | FR-O3.2 parallel + FR-O3.3 chain + FR-O3.1a（前置校验） | 移植 parallel-utils / chain-outputs |
| **P1** | FR-O6（编排 TUI）—— 含 FR-O6.6 照搬 WorkflowsView 三级模型 | 依赖 FR-O3 + subagent-tui FR-2 + WorkflowsView.ts 移植 |
| **P2** | FR-O3.4 dynamic fanout + FR-O5.4 整链 async + FR-O3.5 file-only + FR-O5.7 steer | 移植 dynamic-fanout |

---

## FR-O6: 编排执行 TUI 展示（G-023 闭合，与 subagent-tui spec 联动）

> 本 FR 回答"编排的多个并发 subagent 在 TUI 如何展示"（G-023）。
> **联动关系**：`2026-06-14-subagent-tui/spec.md` 的 FR-1~FR-4 针对**单个 subagent**。本 FR 针对**编排（parallel/chain/fanout）**，复用 subagent-tui 的渲染基础设施（SubagentResultComponent、theme token、ctrl+o 展开、spinner 定时器），但数据模型和布局独立。

### FR-O6.1: 设计决策（已与用户确认）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 对话流 block 归属 | **1 个聚合 block**（DAG 内嵌） | orchestrate 是一个 tool call → 一个 block；与 FR-O5.4"单 BgRecord 聚合"一致 |
| 压缩视图布局 | **骨架 + phase 进度** | 压缩视图极简（总进度条），ctrl+o 展开看各 step eventLog；适合大编排（5+ step） |
| list 视图编排展示 | 1 行聚合 + 可下钻 | 编排在列表中是 1 行（runId 聚合状态），Enter 进入看 DAG 子节点 |

### FR-O6.2: OrchestrationToolDetails 类型（编排 block 数据载体）

扩展 `SubagentToolDetails`（subagent-tui FR-1.2），新增编排专用 details 类型。`renderResult` 根据 details 类型路由到不同渲染逻辑：

```typescript
/** 单个 subagent 的 details（subagent-tui spec 已定义） */
interface SubagentToolDetails {
  eventLog: AgentEventLogEntry[];
  status: "running" | "done" | "failed" | "cancelled";
  agent: string;
  turns: number; totalTokens: number; elapsedSeconds: number;
  result?: string; error?: string;
  backgroundId?: string;
  model?: string; thinkingLevel?: string;
}

/** 编排的 details（本 FR 新增） */
interface OrchestrationToolDetails {
  kind: "orchestration";                    // 区分单个 subagent（G-038：SubagentToolDetails 也需加 kind: "single"）
  mode: "parallel" | "chain" | "fanout";    // 编排类型
  status: "running" | "done" | "failed" | "cancelled";  // 聚合状态（FR-O5.4 推导）
  runId: string;                            // 整链 async 时供查询
  totalSteps: number; completedSteps: number; failedSteps: number;
  elapsedSeconds: number; totalTokens: number;
  /** DAG 快照——各 step 的实时状态 */
  graph: OrchestrationGraphNode[];
  /** 聚合结果（编排完成后） */
  result?: string; error?: string;
}

/**
 * DAG 节点（G-036/037/039/040/041 修正）。
 *
 * 参考实现 WorkflowGraphNode（pi-subagents types.ts:35-57）只有 id/kind/agent/label/phase/
 * status/stepIndex/outputName/error/acceptanceStatus/children。本类型在其基础上**扩展**了
 * in-process 执行所需的渲染字段（model/startedAt/completedAt/result/recentEvents），
 * 并新增 skipped 状态（G-041）。不是纯移植——是适配 subagents 数据模型的改造版。
 */
interface OrchestrationGraphNode {
  id: string;                               // "step-0", "step-1-agent-2"（fanout 含 sanitize 后的 itemKey）
  /** G-037 修正：补全 dynamic-parallel-group（fanout 展开的容器） */
  kind: "step" | "parallel-group" | "dynamic-parallel-group" | "agent";
  agent: string;                            // 子 agent 名（parallel-group/dynamic-parallel-group 容器可为空）
  label: string;                            // 展示名（step.label 或 agent 名）
  phase?: string;                           // 可选阶段分组（如 "Context", "Implement"）
  /**
   * G-041 修正：skipped 是 subagents 自创状态（参考实现 WorkflowNodeStatus 无此值）。
   * normalizeStatus / summarizeParallelStatuses 移植时需新增 skipped 处理：
   *   - skipped 不影响 group 聚合（视为"已结束的非失败"）
   *   - group 聚合：任一 failed → failed；任一 running → running；全 completed+skipped → completed
   */
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  stepIndex: number;
  outputName?: string;                      // as 命名的输出名
  error?: string;

  // ── G-039 修正：Level 1 右栏 formatAgentOneLiner 需要的渲染字段 ──
  model?: string;                           // "provider/modelId"（step 执行时从 ResolvedModel 填充）
  startedAt?: number;                       // step 开始时间（ms epoch）
  completedAt?: number;                     // step 完成时间（ms epoch）
  /** G-039 修正：step 的 usage（tokens），从 AgentResult.usage 填充，供 Level 1 右栏展示 */
  usage?: { input: number; output: number; totalTokens: number };
  /** G-040 修正：step 的完整结果（AgentResult.text），编排完成后从 ChainOutputMap 填充，供 Level 2 详情展示 */
  result?: string;
  /** G-036 修正：step 执行期间的最近事件流（ring buffer 20 条），从 onEvent 回调累积 */
  recentEvents?: AgentEventLogEntry[];
  /** parallel-group / dynamic-parallel-group 的子节点 */
  children?: OrchestrationGraphNode[];
}

/**
 * G-038 修正：SubagentToolDetails 需新增判别字段 kind: "single"。
 * 这是跨 spec 修改——subagent-tui FR-1.2 的 SubagentToolDetails 定义需同步加 kind。
 * 改动点：
 *   1. subagent-render.ts:16 SubagentToolDetails 加 `kind: "single"`（默认值或必填）
 *   2. subagent-tool.ts:97/206/268 构建 details 处补 kind: "single"
 *   3. SubagentResultComponent 构造函数参数类型改为 AnyToolDetails + narrowing
 *   4. subagent-tui spec FR-1.2 同步更新
 */
type AnyToolDetails = SubagentToolDetails | OrchestrationToolDetails;
```

`renderResult`（subagent-render.ts）的 details 类型从 `SubagentToolDetails` 扩展为 `AnyToolDetails`，按 `kind` 字段路由：
- `kind === "orchestration"` → `buildOrchestrationRenderLines`（本 FR）
- `kind === "single"`（或无 kind，向后兼容）→ `buildRenderLines`（subagent-tui FR-2.1，单个 subagent，不变）

### FR-O6.3: 对话流 block 压缩视图（骨架 + phase 进度）

orchestrate 工具的 `renderResult` 对 `OrchestrationToolDetails` 渲染压缩视图，固定行数（受终端高度约束，参考 subagent-tui 的 6 行模式扩展为 8 行）：

```
⠹ orchestrate │ parallel │ 2/4 done │ 1 running │ 8.2k │ 23s   ← 第1行 status（黄背景）
phase: Implement [████░░] 2/4                                      ← 第2行 phase 进度条
├─ ✓ worker-A: implement auth (done, 5 turns)                     ← 第3行 step 概要
├─ ✓ worker-B: implement API (done, 3 turns)                      ← 第4行
├─ ⟳ reviewer: review auth+API (running, 2 turns)                 ← 第5行（当前 active）
├─ ○ planner: plan integration (pending)                          ← 第6行（待执行）
```

**第 1 行 — orchestrate status summary**：
```
{glyph} orchestrate │ {mode} │ {completed}/{total} done │ {running} running │ {tokens} │ {elapsed}s
```
- `glyph`：running → spinner（复用 subagent-tui FR-2.3 种子帧）；done → ✓；failed → ✗；cancelled → ■
- `mode`：parallel / chain / fanout
- `completed/total`：已完成 step 数 / 总 step 数
- `running`：当前正在执行的 step 数（parallel 可能有多个并发）

**第 2 行 — 进度指示**（chain 简化，不用进度条）：
- **parallel 模式**：进度条 `phase: {phase名} [████░░] {done}/{total}`（█ 完成，░ 未完成，宽度 = totalSteps）
  - phase 名取自当前 active step 的 phase（若配置）；无 phase 时仅显示进度条
- **chain 模式**（简化，顺序执行进度条不直观）：`step {current}/{total}: {当前 step 的 agent 名}`
  - 如 `step 2/4: planner`
  - 若有显式 phase 配置，显示 `phase: {phase名} · step {current}/{total}`
- **fanout 模式**：同 parallel（展开后是并发）

**第 3-N 行 — step 概要列表**：
显示所有 step（或受终端高度限制显示最近的），每行一个 step：
```
├─ {status_glyph} {agent}: {label} ({status_detail})
```
- `status_glyph`：completed → ✓（绿）；running → ⟳；failed → ✗（红）；pending → ○（dim）；skipped → ⊘（dim）
- `agent`：子 agent 名
- `label`：step 的 task 摘要（截断到 ~40 字符）或 step.label
- `status_detail`：`done, 5 turns` / `running, 2 turns` / `pending` / `failed: {error摘要}`

**行数约束（G-046 截断策略）**：压缩视图固定 8 行（2 header + 6 step）。step 数 ≤ 6 时全部显示；> 6 时按模式截断：
- **chain 模式**（顺序）：优先显示 active step + 其前 3 个 completed + 其后 2 个 pending（共 6）。更早的 completed 折叠为 `… +{N} earlier steps`（dim）。这样用户始终看到"当前在哪、刚做完什么、接下来做什么"
- **parallel 模式**（并发）：优先显示所有 running + failed（排查优先），剩余名额按 startedAt 降序给 completed，最后给 pending。无 active 概念（多个并发）
- **fanout 模式**：同 parallel
- 截断时在列表底部显示 `… +{N} more` 提示（dim 色），引导用户展开（ctrl+o）或进 list 视图看全部

### FR-O6.4: ctrl+o 展开视图（各 step eventLog）

`expanded: true` 时，orchestrate block 切换为完整视图，展示每个 step 的完整 eventLog（复用 subagent-tui FR-2.2 的展开机制）：

```
⠹ orchestrate │ parallel │ 2/4 done │ 8.2k │ 23s              ← header（同压缩视图第1行）
═══════════════════════════════════════════════════════════════
▶ worker-A: implement auth (done, 5 turns)                       ← step 标题（▶ 可折叠）
  ├─ read auth.ts ✓
  ├─ edit auth.ts ✓
  ├─ I'll implement JWT validation...
  └─ turn 5: "Authentication module complete..."
▶ worker-B: implement API (done, 3 turns)
  ├─ read api/routes.ts ✓
  └─ turn 3: "API endpoints added..."
▼ reviewer: review auth+API (running, 2 turns)                   ← 当前 active（▼ 展开）
  ├─ read auth.ts ✓
  ├─ read api/routes.ts ✓
  ├─ bash npm test ✗
  └─ analyzing test failures...
○ planner: plan integration (pending)
═══════════════════════════════════════════════════════════════
Result (when done): {聚合结果摘要}
```

- **step 折叠**：每个 step 标题用 `▶`/`▼` 标记折叠状态。默认 active step 展开（▼），已完成/待执行折叠（▶）
- **eventLog**：展开的 step 显示其完整 eventLog（toolcall + text_output + thinking，复用 subagent-tui 的滚动区格式），树形 `├─` 连接线
- **超出终端高度**：j/k 滚动（但这受限于 Pi 对话流 block 的渲染能力——若 Pi 不支持 block 内滚动，则截断显示最近的 step）

**关键约束**（G-047 已验证）：Pi 对话流 block 的 ctrl+o 展开**不支持** block 内 j/k 滚动（ToolExecutionComponent 不实现 handleInput，focus 永远在 editor）。展开 = 全量 inline 渲染，超出终端高度进入终端原生 scrollback。展开键是 **Ctrl+O**（keybindings.ts:85 app.tools.expand），全局切换。因此：
- 展开视图按终端高度截断（显示 header + 最近 N 个 step 的 eventLog 摘要，每 step 限 3-5 行）
- 完整详情引导用户去 `/subagents list` → Level 2（全屏视图支持 j/k 滚动）
- UC-O6（排查失败）不依赖对话流展开——list Level 2 是完整排查路径，对话流展开只是快捷预览

**G-049 step 折叠状态存储**：展开视图的 step ▶/▼ 折叠状态存 `ToolRenderContext.state`（orchestrate 工具的独立 TState，见 FR-O6.5 spinner）：
```typescript
type OrchestrateToolState = {
  timer?: ReturnType<typeof setInterval>;  // spinner 定时器
  frame: number;                            // spinner 当前帧
  expandedSteps: Set<string>;              // 用户手动展开的 step id 集合
};
```
默认规则：active step 自动展开（加入 expandedSteps），其余折叠。用户按 Enter 切换某 step 的 expandedSteps 成员资格。刷新时从 expandedSteps 读取，不会丢失用户交互。

### FR-O6.5: onUpdate 回流（编排实时刷新，G-042/G-043/G-045 修正）

#### G-043 修正：sync 模式 stepId 路由机制

orchestrate 工具的 `execute()` 在 sync 模式下维护 `OrchestrationToolDetails`。编排执行时，runtime 为**每个 step 的 runAgent 调用包装 onEvent 闭包**，捕获 stepId：

```typescript
// orchestrate execute() 内（sync 模式）
const details: OrchestrationToolDetails = { kind: "orchestration", mode, status: "running", graph: [...], ... };
const pushUpdate = () => onUpdate?.({ content: [...], details });

// runtime 执行编排时，为每个 step 创建 onEvent 闭包（捕获 stepId）：
function executeStep(node: OrchestrationGraphNode, opts: RunAgentOptions): Promise<AgentResult> {
  return runAgent({
    ...opts,
    onEvent: (event: AgentEvent) => {
      // 闭包捕获 node（含 id），事件路由到正确 graph 节点
      updateNodeFromEvent(node, event);  // 更新 node.status/recentEvents/usage
      pushUpdate();                       // 触发 block 重绘
    },
  });
}
```

- **parallel 模式**：多个 executeStep 并发，各自的 onEvent 闭包独立捕获各自的 node。JS 单线程保证不会有 stepId 串错（闭包变量隔离）。pushUpdate 是幂等的（details 是共享引用，多闭包更新各自的 node 后统一刷新）
- **chain 模式**：顺序执行 executeStep，当前 active step 接收事件
- **stepId 生成**：graph 节点 id 在编排构建时确定（`step-{i}` / `step-{i}-agent-{j}` / fanout 含 sanitize itemKey），executeStep 直接传 node 引用（不需字符串 id 查找）

#### G-042 修正：async 模式 onUpdate 聚合层

`startBackground`（runtime.ts:408）是为单个 runAgent 设计的，不支持编排。async 编排**不走 startBackground**，而是编排自己管理 detached promise + onUpdate 聚合：

```typescript
// orchestrate execute() 内（async 模式）
if (params.async) {
  const runId = `orch-${++seq}-${Date.now().toString(36)}`;
  const details: OrchestrationToolDetails = { kind: "orchestration", ..., runId, status: "running" };

  // detached 执行编排 DAG（不 await）
  runtime.runOrchestrationDetached({
    details,           // 共享引用，step onEvent 更新此对象
    onStepEvent: (node, event) => {
      updateNodeFromEvent(node, event);
      onUpdate?.({ content: [...], details });  // 回流到启动 block
    },
    onComplete: (result) => {
      // 回填 BgRecord（FR-O5.4 单 BgRecord 聚合）
      const record = registerBgRecord(runId, { type: "orchestration", result, ... });
      sendMessage(...);  // FR-O1 回注
    },
    signal,            // AbortController 根（FR-O5.5 cancel 级联）
  });

  return { runId, status: "running" };  // 立即返回
}
```

- runtime 新增 `runOrchestrationDetached()` 方法（不走 startBackground），内部管理 DAG 执行 + 多 step onEvent 聚合 + AbortController 树
- onUpdate 回调 try/catch（best-effort，block 销毁后回调异常不影响编排执行）
- **与 startBackground 的关系**：startBackground 仍用于单个 background subagent（不变）；编排用独立的 runOrchestrationDetached

#### G-045 修正：spinner 定时器独立 TState

orchestrate 是独立工具，有自己的 `ToolDefinition` 和 `TState`。复用 RUNNING_FRAMES 常量 + 在 orchestrate 的 renderResult 内独立实现定时器逻辑：

```typescript
// orchestrate 工具的 ToolDefinition
type OrchestrateToolState = {
  timer?: ReturnType<typeof setInterval>;
  frame: number;
  expandedSteps: Set<string>;  // G-049 step 折叠状态
};

// renderResult 内（与 subagent-tui FR-2.3 逻辑一致，但独立 TState）
renderResult(result, options, theme, context) {
  const state = context.state;  // OrchestrateToolState（per-execution）
  if (details.status === "running") {
    if (!state.timer) {
      state.timer = setInterval(() => {
        state.frame = (state.frame + 1) % RUNNING_FRAMES.length;
        context.invalidate();
      }, 250);
      state.timer.unref?.();
    }
  } else {
    if (state.timer) { clearInterval(state.timer); state.timer = undefined; }
  }
  return new OrchestrationResultComponent(details, theme, state);
}
```

- RUNNING_FRAMES 常量从 subagent-tui 的 subagent-render.ts 导出共享（不是共享定时器实例——per-execution state 隔离）

### FR-O6.6: /subagents list 编排展示（三级视图，照搬 WorkflowsView 模型）

> **用户决策**：参考 `extensions/workflow/src/interface/views/WorkflowsView.ts` 的三级导航模型照搬，适配到 subagents 的数据结构。

#### 复用关系（从 WorkflowsView 移植，G-039/040 字段映射修正）

| WorkflowsView 概念 | subagents 编排对应 | 字段映射（G-039/040 修正） |
|-------------------|-------------------|--------------------------|
| `WorkflowInstance` | `OrchestrationToolDetails` | 数据源替换 |
| `ExecutionTraceNode` | `OrchestrationGraphNode` | `node.task` → `node.label`；`node.model` → `node.model`（已补，G-039）；`node.startedAt/completedAt` → 同名（已补，G-039）；`node.result.usage` → `node.usage`（已补，G-039）；`node.result.toolCalls` → `node.recentEvents`（**结构不同**：toolCalls 是 ToolCallEntry[]，recentEvents 是 AgentEventLogEntry[]——formatAgentOneLiner 的 `tcCount` 改为 `recentEvents.length`）；`node.result.text` → `node.result`（已补，G-040） |
| `buildPhaseGroups` | 同名函数，入参改为 `OrchestrationGraphNode[]` | 直接移植；**G-046 修正**：无 phase 的节点归 unnamed 组，左栏显示 `(default)` |
| `PhaseGroup` | 同结构（name/nodes/doneCount） | 直接复用 |
| 三级 ViewState `level: 0\|1\|2` | 同结构 | 直接复用 |
| `renderLevel0/1/2` + 左右分栏（SIDEBAR_WIDTH=24） | 同布局 | 移植；formatAgentOneLiner 适配字段映射 |
| `processNavigation`（j/k/Enter/Esc） | 同交互 | 直接移植 |
| `ctx.ui.custom()` overlay + requestRender | 同机制（subagent-tui FR-3.4 已有 onChange 总线） | 复用 |
| `summarizeParallelStatuses` | 移植 + 新增 skipped 处理（G-041） | skipped 视为"已结束非失败"，group 聚合：任一 failed→failed；任一 running→running；全 completed+skipped→completed |

**不移植**：workflow 特有的 saveMode（保存 trace 到文件）、handleRestart、orchestrator.pause/resume（subagents 用 cancelBackground 替代）。

#### Level 0 — 记录列表（single + orchestration 混合）

与 subagent-tui FR-3.2 一致，但新增编排行：

```
┌─ Subagents ─────────────────────────────────────────────────┐
│  ID              Type           Agent/Mode    Status         │
│  run-3           single         worker        ✓ done         │
│  orch-1-xyz      orchestration  parallel      ⟳ running 2/4  │  ← 编排行
│  bg-2-abc        single         researcher    ✓ done         │
│                                                              │
│  j/k 导航 · Enter 详情 · x 取消 · q 退出                     │
└──────────────────────────────────────────────────────────────┘
```

- 新增 "Type" 列：`single` / `orchestration`
- **G-044 修正 BgRecord type 字段**：`BgRecord`（runtime.ts:50）新增 `type: "single" | "orchestration"` 字段（默认 "single"，编排用 runOrchestrationDetached 时设 "orchestration"）。list 视图按 type 路由：single → 现有两级 subagents-view；orchestration → 新三级 orchestration-view
- 编排行 Status 显示聚合状态 + 进度：`⟳ running 2/4` / `✓ done` / `✗ failed (step 3)`
- **single 记录 Enter** → Level 1 单 agent 详情（subagent-tui FR-3.3，不变）
- **orchestration 记录 Enter** → Level 1 DAG 概要（本 FR 新增）

#### Level 1 — DAG 概要（编排行进入，左右分栏，照搬 WorkflowsView Level 0/1 布局）

编排行 Enter 进入左右分栏视图（左 = phase 列表 SIDEBAR_WIDTH=24，右 = 当前 phase 的 step 列表）：

```
╭─ orch-1-xyz parallel (running 2/4) ─────────────────────────╮
│  Phases              │ Context · 2 agents                     │
│  ────────────────    │ ──────────────────────────────────     │
│  ❯ ● Context  1/2   │   ● worker-A    deepseek/ds-flash       │
│    ● Implement 1/2   │      12k tok · 4 tools · 45s ✓         │
│    ○ Review    0/1   │   ● worker-B    deepseek/ds-flash       │
│                      │      8k tok · 3 tools · 32s ✓          │
│                      │                                        │
│  ↑↓ phases · ⏎ agents│ ↑↓ · ⏎ detail · x cancel · esc back   │
╰──────────────────────────────────────────────────────────────╯
```

- **左栏（Phases）**：`buildPhaseGroups(graph.nodes)` 按节点 `phase` 字段分组（无 phase 的归入 unnamed 组）。每行 `❯ {dot} {phase名} {done}/{total}`
- **右栏（当前 phase 的 step 列表）**：每个 step 一行 `{dot} {agent} {model} {tokens} · {tools} · {elapsed} {status_glyph}`，照搬 `formatAgentOneLiner`
- **j/k 导航**：Level 1 内左右栏联动——j/k 在右栏 step 列表导航；切换左栏 phase 用特定键（照搬 WorkflowsView 的导航模型）
- **x 取消编排**：调用 `cancelBackground(runId)`（FR-O5.5 abort 整个 DAG）
- **step Enter** → Level 2（该 step 的完整 eventLog）

#### Level 2 — Step 详情（单 step 完整 eventLog）

step Enter 进入 Level 2，展示该 step 的完整 eventLog（复用 subagent-tui FR-3.3 的单 agent 详情渲染）：

```
╭─ worker-A: implement auth (done) ───────────────────────────╮
│  5 turns │ 12k tok │ 45s │ deepseek/ds-flash                 │
│                                                              │
│  Task: Implement JWT validation in auth module               │
│                                                              │
│  Event log:                                                  │
│  ├─ read auth.ts ✓                                           │
│  ├─ edit auth.ts ✓                                           │
│  ├─ I'll implement JWT validation...                         │
│  ├─ bash npm test ✓                                          │
│  └─ turn 5: "Authentication module complete..."              │
│                                                              │
│  Result: Authentication module complete. JWT validation      │
│  added to auth.ts. All tests passing.                        │
│                                                              │
│  esc back to step list                                       │
╰──────────────────────────────────────────────────────────────╯
```

- **数据源**：该 step 的 `recentEvents`（完整 eventLog）+ `result.text`（step 输出）
- **j/k 滚动**：eventLog 超出终端高度时滚动（照搬 WorkflowsView Level 2 的滚动）
- **Esc**：返回 Level 1（step 列表）
- 这与 single 记录的 Level 1 详情（subagent-tui FR-3.3）渲染逻辑**完全一致**——只是数据源从 CompletedAgentRecord/BgRecord 变为 OrchestrationGraphNode

#### 实现策略（照搬 + 适配）

新建 `tui/orchestration-view.ts`（不污染现有 `subagents-view.ts`）：
1. 从 `WorkflowsView.ts` 复制 `ViewState`、`processNavigation`、`processKey`、`renderView`、`renderLevel0/1/2`、`renderHeader`、`renderFooter`、`mergeBody` 的结构
2. 从 `format.ts` 复制 `buildPhaseGroups`、`formatPhaseLine`、`formatAgentOneLiner`、`statusDotStr`、`formatElapsed`、`formatTokenStat`、`SIDEBAR_WIDTH`
3. 适配数据源：`ExecutionTraceNode` → `OrchestrationGraphNode`（字段映射：`node.task` → `node.label`、`node.result.toolCalls` → `node.recentEvents` 等）
4. 删除 workflow 特有功能（saveMode、handleRestart、handlePauseResume）
5. `/subagents list` 入口路由：single 记录用现有 `subagents-view.ts`；orchestration 记录用新的 `orchestration-view.ts`（或合并为一个视图按 Type 分支渲染）

**备选**：直接扩展现有 `subagents-view.ts` 从两级升为三级——但改动面大（现有 single 记录的 Level 1 详情要变成 Level 2）。倾向新建文件，保持 single 视图稳定。

### FR-O6.7: 实时刷新（onChange 事件总线）

编排执行期间，graph 节点状态变化时触发 `runtime.notifyChange()`（subagent-tui FR-3.4 已有的事件总线）：
- step 状态变更（pending→running→completed/failed）→ notifyChange → list 视图 overlay requestRender
- 与单个 subagent 的 notifyChange 触达点一致，无需新增机制

### AC-O6: 编排 TUI 验收

1. **压缩视图**：LLM 调 `orchestrate({tasks:[A,B,C]})`，对话流出现 1 个聚合 block（黄背景），显示 status + 进度指示 + step 概要列表
2. **chain 进度简化**：chain 模式第 2 行显示 `step 2/4: planner`（不用进度条）
3. **实时刷新**：parallel 执行时，block 内各 step 的 status_glyph 实时变化（○→⟳→✓），spinner 旋转
4. **ctrl+o 展开**：展开后显示各 step 的 eventLog（toolcall + text_output），active step 默认展开
5. **失败展示**：failFast 时某 step 失败，该 step 显示 ✗ + error 摘要，后续 step 显示 ⊘（skipped），block 背景变红
6. **list Level 0**：`/subagents list` 列出编排行（Type=orchestration），显示聚合状态 + 进度
7. **list Level 1（DAG 概要）**：编排行 Enter 进入左右分栏（左 phase 列表 + 右 step 列表），照搬 WorkflowsView 布局
8. **list Level 2（step 详情）**：step Enter 进入该 step 完整 eventLog（数据源 OrchestrationGraphNode.result + recentEvents），j/k 滚动，Esc 返回
9. **cancel 编排**：Level 1/2 按 x 取消整个编排（abort DAG），照搬 WorkflowsView 的 handleAbort 交互
10. **async 编排 block 刷新（决策 A）**：`async:true` 时启动 block 持续刷新（runOrchestrationDetached + onStepEvent 聚合），用户滚走后状态仍更新，回来能看到最终状态
11. **大编排截断**：step 数 > 6 时，chain 显示 active+前3后2，parallel 显示 running+failed 优先，底部 `… +{N} more` 提示

---

## Open Questions（Step 3 + Step 5 追踪后状态）

| Q | 状态 | 处理 |
|---|------|------|
| Q-A | **仍开放**（G-016） | sendMessage({triggerTurn:true}) 在主 agent 执行时的行为——需实现时验证 Pi SDK。FR-O1.5 已标注为开放 gap |
| Q-B | **已闭合**（G-015） | 用户决策：合并窗口（2000ms）。见 FR-O1.5 |
| Q-C | **已闭合**（G-013） | 用户决策：独立 orchestrate 工具。见 FR-O3.1 |
| Q-D | **已闭合**（G-003） | 代码事实：不支持 JSON 路径，只整体文本替换。见 FR-O3.3 修正 |

### 仍开放的实现期 gap（不阻塞 spec 定稿）

| Gap | 问题 | 处理时机 |
|-----|------|----------|
| G-005 (B1) | eventLog 竞态（runtime.ts:431 startsWith("run-")） | 编排前置依赖，需先修（独立 bug） |

## Pi SDK 验证结果（G-016/025/033/047 已闭合）

> 以下 4 个 gap 经查 `~/Code/pi-mono-fix-workspace/main/packages/` 源码验证，全部闭合。

### G-016（Q-A）闭合：sendMessage({triggerTurn:true}) 时序已明确

**源码证据**：`coding-agent/src/core/agent-session.ts:1313-1333`（sendCustomMessage 分支）

**关键发现——`triggerTurn` 在主 agent 执行时被忽略**：

```ts
// agent-session.ts:1313-1333 分支顺序
if (options?.deliverAs === "nextTurn") {
    this._pendingNextTurnMessages.push(appMessage);     // ① nextTurn 队列（最高优先）
} else if (this.isStreaming) {                           // ② 主 agent 正在跑 → triggerTurn 被旁路
    if (options?.deliverAs === "followUp") agent.followUp(appMessage);
    else agent.steer(appMessage);                        //    默认进 steering 队列
} else if (options?.triggerTurn) {                       // ③ 仅空闲 + triggerTurn 才启新 turn
    await this._runAgentPrompt(appMessage);
} else { /* 仅入历史，不触发 LLM */ }
```

**结论**：
- **空闲态**（`!isStreaming`）：`triggerTurn:true` → 触发新 LLM turn（消息作为 prompt）
- **执行态**（`isStreaming`）：`triggerTurn` **被忽略**，消息进 steering 队列（当前 turn 的下一轮 assistant 响应前注入，同一次 run 内续跑）。**不会打断当前 turn，也不会并发起新 turn**（`Agent` 用 `activeRun` 互斥锁，`agent.ts:452-454`）
- **`customType` 支持且必填**：`sendMessage({customType:"subagent-bg-notify", content, display:true})` 合法（`messages.ts:46-53` CustomMessage）
- **签名**：`sendMessage(message, options?): void`（同步返回 void，底层异步错误被 `bindCore` 的 `.catch` 吞掉，`agent-session.ts:2196-2203`）

**对 FR-O1 的影响**：background 完成时调 `sendMessage({triggerTurn:true})`：
- 若主 agent 空闲 → 触发新 turn（理想，主 agent 续接结果）
- 若主 agent 正在跑 → 消息进 steering 队列，当前 turn 的下一轮注入（可接受——主 agent 会在当前 run 内看到结果）
- **无需额外处理**，两种情况都能让主 agent 最终看到 background 结果

### G-025 闭合：sendMessage 失败兜底已明确

**源码证据**：`extensions/loader.ts:245-248`（assertActive）+ `agent-session.ts:2196-2203`（bindCore .catch）

**关键发现——两种失败路径，行为不同**：

| 失败场景 | 行为 | 扩展能否感知 |
|---------|------|------------|
| **stale runtime**（session 替换/reload 后） | `assertActive()` **同步抛错** → 冒泡到扩展 | ✅ 能（try/catch 可捕获） |
| **异步投递失败**（session 关闭/triggerTurn 失败） | Pi 内部 `.catch` 吞掉 + `emitError` | ❌ 不能（sendMessage 返回 void，扩展以为成功） |
| **队列满** | **不存在**（`_pendingNextTurnMessages` 无界 push，无容量检查） | n/a |

**对 FR-O1 的影响（spec 修正）**：
- **stale runtime 的同步抛错**必须 try/catch——否则在 `startBackground` 的 `.then/.catch` 路径中，sendMessage 抛错会被 `.catch(err)` 捕获 → background 误标 "failed"（实际 agent 已成功完成）。**这是必须修复的**
- **异步投递失败无法感知**——try/catch 接不到（Pi 内部已 catch）。fallback `appendEntry` 也走 `assertActive()`（stale 时同样抛错），但对异步失败无效。**接受这个限制**：异步失败概率低（session 正常运行时不会发生），且 background 结果仍可通过 `getBackground(id)` 查询（不依赖 sendMessage 投递成功）

**FR-O1.7（新增）sendMessage 异常处理**：
```typescript
// startBackground .then/.catch 路径内，sendMessage 调用必须 try/catch
try {
  this.pi?.sendMessage(
    { customType: "subagent-bg-notify", content: this.formatBgCompletionMessage(record), display: true },
    { triggerTurn: true },
  );
} catch (err) {
  // stale runtime 同步抛错——不标记 background failed（agent 已完成）
  // fallback: appendEntry 持久化（best-effort，同样可能 stale）
  try { this.pi?.appendEntry("subagent-bg-record", { id, status: record.status }); } catch {}
  // 异步投递失败无法捕获——接受限制，结果仍可通过 getBackground 查询
}
```

### G-047 闭合：block 内 j/k 滚动不支持

**源码证据**：`tui/src/tui.ts:39-63`（Component 接口）+ `coding-agent/src/modes/interactive/components/tool-execution.ts`（无 handleInput）+ `keybindings.ts:85`（展开键）

**关键发现**：
1. **展开键是 `Ctrl+O` 不是 `Alt+O`**（`keybindings.ts:85`：`"app.tools.expand": { defaultKeys: "ctrl+o" }`）。spec 全文的 `alt+o` 需改为 `ctrl+o`
2. **工具 block 不支持 j/k 滚动**：`ToolExecutionComponent` 不实现 `handleInput`（Component 接口有可选 `handleInput?(data)`，但工具 block 不实现）。展开 = 从 ~20 行预览切为全量 inline 渲染，无 viewport/scrollOffset，超出终端高度进入终端原生 scrollback
3. **展开是全局切换**：`setToolsExpanded`（`interactive-mode.ts:3534-3550`）遍历所有 tool block，非逐块独立
4. **focus 永远在 editor**：interactive mode 的 focus 始终是 `this.editor`（`interactive-mode.ts:692`），从不 focus 工具 block

**对 FR-O6.4 的影响（spec 修正）**：
- `alt+o` 全文改为 `ctrl+o`
- 展开视图**不依赖 block 内滚动**（不存在此能力）。大编排展开时按终端高度截断（每 step 限 3-5 行 eventLog），完整详情走 `/subagents list` Level 2（全屏 overlay 支持 j/k 滚动）
- 这是已确认的降级方案，不再是"待验证"

### G-033 闭合：steer 入口用 slash command（带参数）

**源码证据**：`extensions/types.ts:1075,1151`（registerCommand 签名）+ `agent-session.ts:1142-1146`（参数解析）

**关键发现**：
- `pi.registerCommand(name, { handler: async (args: string, ctx) => {} })`——**args 是原始字符串**（命令名后第一个空格之后的全部内容），Pi 不做 tokenize，扩展自行 split
- 现有模式（`commands/config.ts:20`）：`args.trim().split(/\s+/).filter(Boolean)`
- steer 投递用 `pi.sendUserMessage(message, {deliverAs:"steer"})`（`types.ts:1196`），不是 ctx 上的方法

**FR-O5.7 steer 入口（P2，已确认可行）**：
```typescript
// 注册 /subagents steer <runId> <step> <message>
pi.registerCommand("subagents", {
  handler: async (argsStr: string, ctx) => {
    const args = argsStr.trim().split(/\s+/).filter(Boolean);
    if (args[0] === "steer") {
      const runId = args[1];
      const stepIndex = parseInt(args[2], 10);
      const message = args.slice(3).join(" ");
      runtime.steerBackground(runId, stepIndex, message);  // FR-O5.7 路由到 ManagedSession
    }
    // ... 现有 config/list 分支
  },
});
```
注意：命令名是 `"subagents"`（复用现有命令），`args[0]==="steer"` 是子命令。`getArgumentCompletions` 可提供 Tab 补全 runId。

## Round 3 gap 处理汇总（12 gaps，详见 changes/tracing-round-3.md）

FR-O6（编排 TUI）经独立追踪发现 4 个结构性问题 + 8 个细节 gap，全部处理：

| Gap | Type | 处理 |
|-----|------|------|
| G-036 | F | FR-O6.2 recentEvents 明确为 onEvent 回调累积（非移植字段） |
| G-037 | F | FR-O6.2 kind 补全 `dynamic-parallel-group`（fanout 容器） |
| G-038 | F | FR-O6.2 SubagentToolDetails 加 `kind: "single"` 判别字段（跨 spec 修改，4 处改动点列出） |
| G-039 | F | FR-O6.2/6.6 OrchestrationGraphNode 补 model/startedAt/completedAt/usage 字段 + formatAgentOneLiner 字段映射 |
| G-040 | F | FR-O6.2/6.6 节点补 `result: string`（从 ChainOutputMap 填充），Level 2 数据源明确 |
| G-041 | F | FR-O6.2 skipped 灯自定义状态明确 + summarizeParallelStatuses 移植时新增 skipped 处理规则 |
| G-042 | F | FR-O6.5 async 模式不走 startBackground，新增 runOrchestrationDetached + onStepEvent 聚合 |
| G-043 | F | FR-O6.5 sync 模式 executeStep 包装 onEvent 闭包捕获 node 引用（JS 单线程保证不串） |
| G-044 | F | FR-O6.6 BgRecord 新增 `type: "single"\|"orchestration"` 字段 |
| G-045 | F | FR-O6.5 spinner 独立 OrchestrateToolState，复用 RUNNING_FRAMES 常量 + 各自实现定时器 |
| G-046 | F | FR-O6.3 截断策略按模式区分（chain: active+前3后2；parallel: running+failed 优先） |
| G-047 | K | 标注为开放（P1 实现前验证 Pi SDK block 内滚动能力） |
| G-048 | D | FR-O3.1a 删除合并 params 代码块，明确两工具共用 validateSubagentParams |
| G-049 | D | FR-O6.4/6.5 step 折叠状态存 OrchestrateToolState.expandedSteps: Set<string> |

| Gap | Type | 处理 |
|-----|------|------|
| G-028 | D | FR-O1.5 决策：首个事件立即发送 + 2000ms 窗口合并后续（单个 background 零延迟） |
| G-029 | F | FR-O1.5 补充：定时器 unref() + runtime dispose() 清理 |
| G-030 | F | FR-O5.5 补充：abort 监听器 { once: true } + 编排完成 removeEventListener |
| G-031 | F | FR-O3.6 补充：临时文件 chain 完成后清理 + dispose 兜底 |
| G-032 | F | FR-O3.7 新增：ChainOutputMap 编排完成后清理 |
| G-033 | K | FR-O5.7 标注：P2 阶段定义触发入口（推荐 slash command） |
| G-034 | F | FR-O3.1a 补全：graceTurns/schema/appendSystemPrompt/output/outputMode 校验 |
| G-035 | F | FR-O3.6 补充：落盘失败回退内联截断 + warning |

## Step 3 追踪 gap 处理汇总（27 gaps）

详见 `changes/tracing-round-1.md`。处理结果分类：

### F 类（16 个，代码事实，全部二次确认成立，已修正到 spec）
- G-001 priority 方向反 → FR-O4.1 修正
- G-002 maxItems 无默认值 → FR-O3.4 修正
- G-003 {outputs.name} 不支持 JSON 路径 → FR-O3.3 修正（Q-D 闭合）
- G-004 history 双写去重 → FR-O1.6 补充
- G-005 eventLog 竞态 → 见 Constraints（handoff B1，编排前置依赖）
- G-006 并发池饥饿 → FR-O4.1 修正后有效
- G-007 events.on 可选 → 不影响（FR-O1 用 sendMessage 不用 events 订阅）
- G-008 customType 命名不一致 → FR-O1.1 统一为 `subagent-bg-notify`
- G-009 formatBgCompletionMessage 字段不全 → FR-O1.2 补全
- G-019 parallel {previous} 语义 → FR-O3.2 补充
- G-020 expand.onEmpty → FR-O3.4 补充
- G-021 expand.key 去重 → FR-O3.4 补充 + FR-O3.1a 前置校验
- G-022 collect.outputSchema → FR-O3.4 补充
- G-024 去重无 TTL → FR-O1.3 修正（采用参考实现 TTL 机制）
- G-026 defaultBackground 查询 API → FR-O2.2 补充（runtime 暴露 getAgentConfig）
- G-027 handoff 文档出处 → 确认在 `/tmp/background-mode-handoff-2026-06-14.md`（不在仓库，是会话产出）

### K 类（6 个，用户决策）
- G-010 编排 steer → **支持**（FR-O5.7，P2 阶段）
- G-011 cancel 编排语义 → **abort 整个 DAG**（FR-O5.5）
- G-012 大输出撑爆 context → **超阈值自动落盘**（FR-O3.6）
- G-023 TUI 编排展示 → **已闭合**（FR-O6：1 个聚合 block + DAG 骨架 + phase 进度，详见 FR-O6 章节）
- G-025 sendMessage 失败兜底 → 标注为开放（实现时加 try/catch + fallback appendEntry）
- G-027 handoff B1/B2/B3 出处 → 已确认（/tmp/，非仓库文件）

### D 类（5 个，用户决策）
- G-013 编排入口 → **独立 orchestrate 工具**（FR-O3.1）
- G-014 chain failFast → **默认开**（FR-O5.6）
- G-015 多 bg 合并 → **合并窗口**（FR-O1.5）
- G-016 triggerTurn 时序 → 仍开放（Q-A）
- G-017 runId 模型 → **单 BgRecord 聚合**（FR-O5.4）
- G-018 BgRecord 清理 → FIFO 上限 50（FR-O5.9）

---

## 实现偏差说明（P0 实施后补充）

P0 实施过程中产生的、与 spec 原文描述的偏差，统一记录于此。每条含决策 + 原因。

| 编号 | 偏差 | 决策 | 原因 |
|------|------|------|------|
| D-P0-01 | FR-O5.9 BgRecord FIFO 淘汰改为**跳过 running record**（spec 原文只说"FIFO 淘汰最旧"） | running record 不淘汰；全是 running 时宁可暂时超限也不淘汰 | 淘汰 running record 会导致 `cancelBackground(id)` 找不到 record 返回 false，正在执行的 agent 无法取消（资源泄漏 + 不可控）。代码审查 S4 发现。 |
| D-P0-02 | FR-O2.1 `defaultBackground: false` frontmatter 值**归一化为 undefined**（与缺失同义） | 解析器仅 `"true"` → `true`，其余（`"false"`/缺失/非法值）→ `undefined` | 避免下游 falsy 判断时 `false` 与 `undefined` 的语义歧义。下游 `agentConfig?.defaultBackground ? false : true` 用 falsy 判断，两者行为一致，归一化消除字段存在性的歧义。代码审查 P4。 |
| D-P0-03 | FR-O1.5 G-029 `dispose()` 实现了**幂等 + `_disposed` 标志**（spec 只说"清理定时器并 flush"） | dispose 设 `_disposed = true`，后续 `notifyBgCompletion` 短路；多次 dispose 幂等 | 防止 dispose 后 detached background 完成时仍调 `sendMessage`（对 stale pi）。代码审查 P2。 |
| D-P0-04 | startBackground 调 runAgent 时传 `_skipWidget: true`（spec 未描述 runAgent 的内部标志） | runAgent 新增可选 `_skipWidget` 字段，background 调用时跳过 widget 注册 + sync history 持久化 | 避免双重记录：background 有自己的 `_bgRecords` + `mode:"background"` history 持久化；runAgent 的 widget（run-N）+ `mode:"sync"` history 会导致同一任务双处显示 + history 双写（id 不同）。代码审查 P1。 |
| D-P0-05 | startBackground 的 `.catch` 区分 abort vs 真实错误（spec FR-O1 未明确要求） | `.catch` 判断 `signal.aborted` → status="cancelled"，否则 "failed" | 修复既存 bug：cancelBackground 先设 cancelled，abort 触发 runAgent 抛错进 `.catch` 会覆盖为 failed，与用户意图矛盾。代码审查 S1。 |
| D-P0-06 | V3 worktree 测试改用**独立 homeDir 子目录**（spec 未涉及测试实现） | `createWorktree` 新增可选 `baseDir` 参数（默认 os.tmpdir()）；run-agent.ts 传 `ctx.homeDir`；V3 测试用独立 `pi-v3-home-*` 目录 | 根治 V3 worktree 测试在全量并行时的 flaky（共享 tmpdir baseline 污染 + git worktree 锁竞争）。移除 vitest 全局 retry。代码审查 P5。 |
