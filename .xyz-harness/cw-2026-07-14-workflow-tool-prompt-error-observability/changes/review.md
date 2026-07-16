# Code Review — workflow-tool-prompt-error-observability

## 审查范围
- commits: `17a224e77~1..09b9e71d4`（3 个 commit）
- 文件：`tool-workflow.ts`, `tool-workflow-script.ts`, `chain.js`, `parallel.js`, `scatter-gather.js`, `map-reduce.js`, `error-recovery.ts`, `agent-call-catch-fallback.test.ts`, `workflow-tool-prompt.test.ts`
- 7 个新增测试全部通过（`vitest run` 验证）。

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| 业务逻辑（W3） | catch 块未调 `run.state.trace.update(msg.callId, {status:"failed", result, completedAt})`，与 `resolveAgentOpts` 失败路径（L270-274）和 `.then()` 分支不对称。结果：trace node 永远停在 `status:"running"`，TUI 显示一个永不结束的幽灵 call；该次失败也不会被持久化到磁盘（见下一行）。 | should_fix | error-recovery.ts L361-368（缺 trace.update） |
| 业务逻辑（W3） | catch 块未调 `node.live = undefined`。`dispatchAgentCall` 在 L238 把 `liveRecord` 挂到 node.live，正常路径（`.then` L320 / resolveAgentOpts 失败 L269）都会清除。catch 漏清 → live ExecutionRecord 泄漏在 trace 中（含可变状态），违反文件自身注释「live 不再需要…避免内存泄漏」的不变式。 | should_fix | error-recovery.ts L361-368（缺 node.live 清除） |
| 业务逻辑（W3） | catch 块未调 `void deps.store.save(run)`。两个对等的失败分支（resolveAgentOpts L276、`.then` L325）都 save。catch 路径产出的 failed call result 只活在内存，进程崩溃即丢失——讽刺的是这条路径正是为「runner 异常」兜底，恰恰是最需要持久化留证的场景。 | should_fix | error-recovery.ts L361-368（缺 store.save） |
| 业务逻辑（W3） | stale completion 下 `run.runtime` 为 undefined 时 `postAgentResult` 用 optional chaining 静默跳过（L421），但此时 worker 已随 runtime 一起被 terminate（`replaceRuntime`/pause 重建会 SIGKILL 旧 worker）。回发对 dead worker 是 no-op，逻辑无害；但 catch 块照旧执行 `call.markRunning/markDone` 改内存 call 状态——这本可做，只是注释 L359-360「安全跳过」的措辞暗示「回发被正确处理」，实际是「回发被丢弃」，注释有误导性。 | nit | error-recovery.ts L359-360 注释 |
| 类型安全（W3） | `AgentResult`（`models/types.ts` L163-186）仅 `content` 必填，`error`/`parsedOutput`/`usage`/`durationMs`/`sessionId`/`toolCalls` 均可选。`{ content: "", error: message }` 满足接口，tsc 无错。✅ 但注意：此 `AgentResult` 与 `execution/types.ts` L201 的同名接口（`text/turns/durationMs/success/sessionId/toolCalls` 必填）字段完全不同——本文件 import 的是前者（L39 `from "./models/types.ts"`），用对了。 | ✅ 无问题 | error-recovery.ts L39, L361 |
| 类型安全（W3） | `call.status` 检查不穷尽。`AgentCallStatus = "pending" \| "running" \| "done"`（agent-call.ts L20）。catch 块处理了 `pending`（→markRunning）、`done`（跳过），但 `running` 态命中外层 `if (call.status !== "done")` 后直接 `markDone`——正确。理论上无第四态，但若未来加状态（如 `queued`），`if (call.status === "pending")` 不会兜住新态，会直接走到 markDone 抛「must be running」异常，把 catch 自己吞掉。当前安全，未来脆弱。 | nit | error-recovery.ts L362-366 |
| 边界条件（W3） | 「markRunning 后、markDone 前抛异常」覆盖分析：`executeAgentCall` 在 L130 markRunning，runner.run（L132）若 reject 异常会沿 `withSlot` → 外层 `.catch` 到达。此时 `call.status === "running"`，catch 块 `if (call.status !== "done")` 为真，跳过 `markRunning`（已 running），直接 `markDone(errorResult)`——✅ 正确。但「withSlot 在 markRunning 前 reject」（注释 L363-364 假设的场景）实际不可能：gate.withSlot 是在 L304 调用，executeAgentCall（含 markRunning）是 L308 在 withSlot 回调内部，markRunning 必先于任何 withSlot reject。注释描述的「call 仍 pending → 先 markRunning」防御分支是 dead code（不会被触发）。 | nit | error-recovery.ts L363-365（dead defensive branch） |
| 边界条件（W2） | `final?.summary ?? "(综合无结果)"`（chain.js L95）：若 agent() 返回 schema 校验对象但 `summary` 字段值是空字符串 `""`，空串非 nullish，不触发 `??`，outcome.final.summary 为 `""`。`parallel.js` 的 `overallScore: number` 同理——schema 是 number，agent 返回 0 是合法值，`0 ?? fallback` 不会 fallback（但 0 不是 nullish，行为正确，只是「无结果」语义被 0 覆盖）。对 prompt 质量的实际影响：这些字段是 outcome 终态展示，不喂回下游 agent prompt（chain 的 transform 段读的是 `analysis`，不是 `final`），所以不会污染下游。 | nit | chain.js L95, parallel.js L116 |
| 边界条件（W2） | `JSON.stringify(analysis?.keyPoints ?? [])`（chain.js L58）：若 keyPoints 为 `undefined` → `[]` → `"[]"`，喂给 transform 段 agent prompt。prompt 里出现字面量 `[]` 会让 LLM 困惑（「关键点为空」vs「分析失败」语义混淆）。fallback 值建议用 `["(分析无结果)"]` 或人类可读串，而非空数组序列化。 | nit | chain.js L58, L80 |
| 测试覆盖（W1） | 源码断言（readFileSync + toContain/toMatch）脆弱：重构把 description 提取成 const 常量、或换行/空格微调，断言即失效。例如 `expect(TOOL_WORKFLOW_SRC).toMatch(/workflow run .+--args/i)` 依赖字面「workflow run …--args」顺序，若改写成「run a workflow with --args」会假阳失败。但鉴于 prompt 文本就是契约本身（LLM 直接消费），用源码断言比运行时 mock 更合理，可接受。注释里也说明了「避免 import 重 mock 链」的理由。 | nit | workflow-tool-prompt.test.ts L36-50 |
| 测试覆盖（W3） | 未覆盖关键回归场景：**call 已 markDone 后 catch 触发**。`executeAgentCall` 内 finalizeCall 已 markDone 后，若 `withSlot` 的后续逻辑（如 budget.isExceeded 分支 L331-346 的 transition）抛异常，会进 catch。此时 `call.status === "done"`，catch 走 `if (call.status !== "done")` 假分支跳过 markDone（✅ 不重复 markDone），但仍执行 `postAgentResult(run, msg.callId, errorResult, false)`——会用 errorResult 覆盖真实 result 二次回发。测试未覆盖此分支。 | should_fix | agent-call-catch-fallback.test.ts（缺 call.status==="done" case） |
| 测试覆盖（W3） | 未断言 trace node 最终 status / node.live 清除 / store.save 调用。测试只验证了 postMessage 回发内容（L138-146），未验证 state 一致性——正好掩护了上面 3 个 should_fix（trace.update / node.live / store.save 缺失）。建议补断言：`expect(run.state.trace.find(2)?.status).toBe("failed")`、`expect(run.state.trace.find(2)?.live).toBeUndefined()`、`expect(deps.store.save).toHaveBeenCalled()`。 | should_fix | agent-call-catch-fallback.test.ts |
| 测试覆盖（W3） | AbortError 不回发的断言用 `for (let i=0;i<5;i++) await Promise.resolve()`（L188-191）手动 flush 微任务。脆弱——若 withSlot 内部多一层 async（未来重构），5 次 tick 可能不够，测试会偶发假阳（「断言期内无 agent-result」过早 pass）。注释 L185-187 也承认了 vi.waitFor 反向断言的缺陷。更稳的做法：用 `vi.waitFor(() => { expect(...).toBeUndefined() })` 配合超时，或断言 postMessage 总调用次数为 0（正向断言）。 | nit | agent-call-catch-fallback.test.ts L185-193 |
| 测试覆盖（W2） | 无 inline 测试（.js 脚本不在 vitest 范围），plan 称 U2 用源码断言验证。仅靠 null guard 存在性断言无法验证「fallback 值合理性」（如空数组 stringify 问题、0 vs fallback 问题）。覆盖偏弱但鉴于 .js 脚本测试成本高，可接受。 | nit | （plan U2） |
| 代码规范（W2） | `(gathered?.mergedResult ?? "(合并无结果)")` 外层括号多余：JS 中 `??` 优先级低于属性访问，在对象字面量值位置 `{ key: a?.b ?? c }` 无歧义，无需括号。`parallel.js L116-118`、`scatter-gather.js L132-133`、`map-reduce.js L130`、`chain.js L95` 同样多余。统一去掉更简洁。 | nit | 4 个 .js 文件多处 |
| 代码规范（W3） | catch 块注释密度偏高：22 行中 10 行注释（~45%），高于 sibling catch（L343-346 仅 1 行注释 / L483-485 两行）。注释本身信息密度高且解释了「为什么」（worker 挂死根因），可接受；但 L363-365 的 dead branch 解释（见上）应删除或改为「防御性：status 理论上必为 running，markRunning 分支为冗余保护」。 | nit | error-recovery.ts L354-367 |
| 代码规范（W1） | BUILT-IN 条目（L230-235）单条约 5 行、300+ 字符，是同数组其他条目（L239「run: discover…」1 行）的 5 倍长。promptGuidelines 是拼进 LLM context 的，过长条目挤占其他 guideline 注意力。可拆成「BUILT-IN 清单（一行）」+「DISCOVERY 路径（已有）」两条，参数细节留给 workflow-script list 返回。但考虑 LLM 需参数才能正确调用，当前详尽可接受。 | nit | tool-workflow.ts L230-235 |
| 业务逻辑（W1） | prompt 参数描述准确性核对：chain=`task` ✅、parallel=`target, optional perspectives` ✅（parallel.js L24-30 确认）、scatter-gather=`task` ✅、map-reduce=`items/itemsJson + operation` ✅（map-reduce.js L25, L33-44 确认）。全部准确，无误导。 | ✅ 无问题 | tool-workflow.ts L230-235 |

## plan 覆盖核对

- [x] **W1 changes[0]** — `tool-workflow.ts` description 补充内置 workflow 清单及必需参数；promptGuidelines 增加正例和发现指引。✅ 完全实现（L230-238），参数描述与 .js 脚本实际入参逐一核对一致。
- [x] **W1 changes[1]** — `tool-workflow-script.ts` promptGuidelines 增加 list 与 workflow run 的交叉引用。✅ 实现（L175-178），反向引用「start a script via the workflow tool with action:run」。
- [x] **W2 chain.js** — analysis/plan/final 属性访问加 null guard。✅ 实现（L57-58, L79-80, L95）。
- [✗] **W2 parallel.js** — plan 称「perPerspective 元素和 aggregate 属性访问加 null guard」。实际仅 aggregate 3 字段加 guard（L116-118），perPerspective 循环内的 `r.error` 访问（L71）未加 guard（但 L71 的 `if (!r || r.error)` 已先判 `!r`，故 `r.error` 安全）。**plan 描述与实现不符**（plan 暗示 perPerspective 元素也改了，实际没改也无必要）。
- [x] **W2 scatter-gather.js** — split/processed 元素和 gathered 属性访问加 null guard。✅ split.subtasks（L61）、gathered.mergedResult/completeness（L132-133）加 guard。注：processed 元素（L92 `r.error`）未显式加 `r?.`，但 L92 `if (!r || r.error)` 已先判空，安全。
- [✗] **W2 map-reduce.js** — plan 称「mapped 元素和 reduced 属性访问加 null guard」。实际仅 reduced.reduced/reduced.stats（L130）加 guard，**mapped 元素 `r.mapped`（L98）未加 guard**。L85 `if (!r || r.error)` 已先判 `!r`，故 `r.mapped` 在 else 分支安全（r 非 null），但仍与 plan 描述不符。
- [x] **W3 error-recovery.ts** — dispatchAgentCall 的 .catch 块补充兜底，构造 failed AgentResult 并 postAgentResult 回发 worker。✅ 实现（L361-368），AgentResult 形状正确，兼容 worker-script-builder.ts L122 的 `parsedOutput ?? content` 消费（parsedOutput 缺失→回退 content=""→agent() resolve 空串，脚本容错循环接管）。
- [x] **W3 agent-call-catch-fallback.test.ts** — 新增测试验证 catch 分支回发。✅ 实现（3 个 case：Error reject / 非 Error 字符串 / AbortError 不回发），全部通过。但缺 call.status==="done" 场景和 trace/store 一致性断言（见上表）。

## 结论

- **must_fix：0**
- **should_fix：5**（全部集中在 W3 catch 块的 state 一致性——trace.update / node.live / store.save 三件套缺失，外加 2 个测试覆盖缺口）
- **nit：9**
- **plan 覆盖偏差：2**（W2 parallel/map-reduce 的 plan 描述比实际实现多声称了 perPerspective/mapped 元素 guard，实际未加但也不需要——属 plan 措辞不准，非代码缺陷）

**是否可进入 test：可进入，但建议先修 W3 的 3 个 should_fix（trace.update + node.live 清除 + store.save）**。这 3 个问题本质是 catch 块与两个对等失败分支（resolveAgentOpts L262-277、`.then` L317-325）的对称性缺失，修复成本低（各加 1-3 行），但影响可观测性：不修则 catch 路径产生的 failed call 在 TUI 显示为永久 running 的幽灵节点，且不落盘。W3 这次改动正是为「agent call 失败可观测」兜底，却在 trace/持久化层留了盲区，与本次 topic「error observability」目标相悖，建议在 test 前补齐。

W1/W2 实现质量良好，参数描述准确、null guard 覆盖到位，仅 nit 级别问题，不阻塞。
