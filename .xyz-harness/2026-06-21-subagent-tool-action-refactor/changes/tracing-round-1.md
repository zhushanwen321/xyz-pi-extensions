# Tracing Round 1

## 追踪范围
- spec 初稿版本：`spec.md`（verdict: pass）— tool action 化（start/list/cancel）+ 废 poll + spinner mode 修复 + sessionFile 提前填 + command 精简
- 追踪的视角：
  - P1 User Journey（适用）
  - P2 Data Lifecycle（降级：接口重构不改数据模型，但追踪 sessionFile 数据流变更对 record 字段/投影的影响 — 发现实质 gap，部分追踪）
  - P3 API Contract（适用，重点）
  - P4 State Machine（降级：状态机不变，但追踪 cancel 对 sync record 的副作用 — 发现实质 gap，部分追踪）
  - P5 Failure Path（适用，重点）

---

## Gap 列表

### 高优先级（逻辑矛盾 / 阻塞实现）

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-001 | F | API Contract | P3/OP-A:list + FR-6 vs AC-5/AC-6 | FR-6 写「默认仅 running（`store.listRunning()`）」，但 `listRunning()` 返回 `RecordSnapshot[]`（`types.ts:195-209`），**RecordSnapshot 无 sessionFile 字段**。而 AC-5/AC-6 要求 list item 含 sessionFile（7 字段之一）。默认 list 路径拿不到 sessionFile。决策：默认 list 改用 `collectRecords` 过滤 running？还是给 `RecordSnapshot`/`listRunning` 加 sessionFile？spec 当前方案不可实现。 |
| G-002 | F | Data Lifecycle | P2/E:sessionFile 时序 + FR-7/D9 vs AC-5 | sessionFile 在 `run()` 内部 `createAndConfigureSession`（`session-runner.ts:255`）才产生，但 record 在 `run()` 外部 `createRecordForMode`（`subagent-service.ts`）创建——**「record 创建后立即填」时序不可能**，只能 session 创建后回填。中间存在窗口：record 已进 `store.live`（listRunning 可见），但 session 尚未创建（pool 排队 `acquire` 阻塞 / 首次 `getSdk` IO）。窗口内 AI 调 list → item.sessionFile = undefined，与 AC-5「background 启动后立即 list → sessionFile 有值」矛盾。pool 满时窗口可能很长。 |
| G-003 | F | Data Lifecycle | P2/E:ExecutionRecord 类型 + FR-7 | 要支撑 FR-7（running 态 list 返回 sessionFile），`ExecutionRecord`（`types.ts:48-94`）需新增 `sessionFile?: string` 字段，`createRecord` 不填、`createAndConfigureSession` 成功后回填；`recordToSubagent`（`record-store.ts:240`）改读 `record.sessionFile` 而非 `r.agentResult?.sessionFile`；`project()`（`execution-record.ts`）是否输出 sessionFile 到 `SubagentToolDetails` 也需明确。spec FR-7/D9 完全未列这些类型/投影变更。 |
| G-004 | D | Failure Path | P5/cancel + FR-3 vs FR-5/AC-9 | FR-3 定义 `cancelResponse?: { cancelled: boolean }`（true/false）。但 FR-5 + AC-9 规定 cancel 失败（id 不存在 / 已终态）**throw Error**。若失败都 throw，则 `cancelled: false` 永远不会出现在响应里——**false 分支是死值**，类型自相矛盾。决策：(a) 类型改 `cancelled: true` 字面量（失败 throw）；(b) 改语义为失败不 throw 而 return `{ cancelled: false }`（让 AI 软失败重试）。两者对 AI 行为影响不同，spec 未决策。 |
| G-005 | K | State Machine | P4/cancel sync record + FR-5 | `service.cancel` → `cancelBackground`（`subagent-service.ts`）：对 sync running record，`record.controller?.abort()` 是 no-op（sync 的 controller 为 undefined），但 `tryTransition(record, "cancelled")` **会成功**（status running→cancelled），随后 `completeRecord`（写空 result）+ `archive` + `notifyComplete`（发 followUp！）。而 sync 调用方仍在 `await run()`，session 实际跑完后 `tryTransition(done)` 失败、跳过 `finalizeRecord`，最终 execute 返回 `{status:cancelled, result:""}` 但 session 真完成了——**双重混乱 + 误发 followUp**。spec 未规定 cancel 是否拒绝 sync record。决策：cancel 检测 `record.mode !== "background"` 时 throw？ |
| G-006 | D | User Journey | P1/OP-U:list + FR-6 | `listRunning()`（`record-store.ts:106`）**不过滤 mode**，返回所有 running record（sync + background）。UC-2 场景（并行 fan-out 监控）下，若主 agent 同时起了 sync subagent（或 background subagent 内部嵌套起了 sync），list 会混入 sync record。结合 G-005，AI 拿到 sync record id 后 cancel 会触发状态混乱。决策：list 默认是否过滤 `mode === "background"`？或 list item 显式带 mode 字段让 AI 自行判断？ |

### 中优先级（边界未定义 / 数据流缺口）

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-007 | D | API Contract | P3/OP-A:校验 + FR-1 | FR-1 只规定「action 与对应 param 不匹配 throw」两个明确案例（start 无 startParam / cancel 无 subagentId）。未覆盖：(a) `action:"start"` 同时传了 `startParam` 和 `listParam`（多余 param 忽略 / throw？）；(b) `action:"list"` 传了 `startParam`；(c) `action:"cancel"` 传了 `startParam`。typebox schema 层三个 param 都是 Optional，无法靠 schema 拦截跨 param 组合。需要明确「多余 param 静默忽略」还是「严格 throw」。 |
| G-008 | F | API Contract | P3/OP-A:start + FR-1 | `startParam` 整体是 `Type.Optional`，其内部 `task` 也是 `Type.Optional(Type.String())`（因为整个 startParam 缺失时 task 自然不存在）。schema 层无法表达「startParam 存在时 task 必填」。运行时校验未明确：`task` 缺失 / `task:""` 空字符串 / `task:"   "` 纯空白，分别怎么处理？现实现（`subagent-tool.ts`）只校验 `!params.task`（空字符串会被放过）。 |
| G-009 | D | API Contract | P3/OP-A:list + FR-6 | `listParam.limit` 边界未定义：(a) `limit:0` → `slice(0,0)=[]` 返回空还是 fallback 默认 20？(b) `limit:-1` → `slice(0,-1)` 返回除末尾外全部（怪异）；(c) `limit:1.5` 非整数 → typebox `Type.Number()` 允许小数？(d) `limit:100000` 超大 → `collectRecords` 全量 + history merge 开销。spec 未提校验/夹紧（如 `Math.max(1, Math.min(limit, 100))`）。 |
| G-010 | F | API Contract | P3/OP-A:list + FR-6 | list 的排序规则未明确。`collectRecords`（`record-store.ts:146`）排序是 `status priority（running<failed<cancelled<done）+ startedAt desc`。默认仅 running 时排序退化为 `startedAt desc`。spec 未说明默认 list 是否按启动时间倒序（最新的在前）——影响 AI 找「刚启动的那个」。另外 `includeFinished:true` 时 running 与终态混合排序，AI 可能需要区分。 |
| G-011 | F | User Journey | P1/OP-U:start(sync) onUpdate + FR-9 | sync 执行中 `onEventThrottled` → `onUpdate(project(record))` 回流（`subagent-service.ts`），tool 层 `onUpdate` handler（`subagent-tool.ts`）把 details 包成 `{content, details}`。FR-9 重组 details 后，`project()` 返回的 `SubagentToolDetails` 结构变（分组 + action 字段），onUpdate 回流的 details 也变。spec 只提 `renderResult` 按 action 分支，**未提 onUpdate 回流路径与新 details 结构的适配**（sync streaming 中的 tool block 更新会断）。 |
| G-012 | D | User Journey | P1/OP-U:start(bg) 渲染 + FR-9 | 现有 `renderCompact`（`tool-render.ts:249`）对 background 占位 block 渲染 `background: {id} · running detached · poll to check`。废 poll 后「poll to check」失效。FR-9 说 start → 从 `bgResponse` 取字段，但 **bgResponse 的 TUI 渲染文案未定义**（改「list to check」？「detached, will notify on completion」？）。这影响 AC-1 的「running 态 list 返回的 tool block 不启动 spinner」可读性。 |
| G-013 | F | Failure Path | P5/session 创建失败 + FR-7/AC-5 | `createAndConfigureSession` 失败（`session-factory.ts` post-creation catch 或 SDK `createAgentSession` 抛错）时，`run()` catch → `finalizeFailed` → record 转 failed，**sessionFile 永远 undefined**（session 没建成功）。这种 failed record 的 list item.sessionFile = undefined。AC-5 只覆盖「启动成功」场景，未定义 failed record 的 sessionFile 降级（undefined 是否可接受？还是 list 应过滤掉无 sessionFile 的 record？）。 |
| G-014 | K | User Journey | P1/OP-U:进度查看 + FR-4 | 废 poll 后，AI 看 running subagent 的实时进度（eventLog / currentActivity）的唯一途径是 `list` 拿 sessionFile → `read` jsonl。但：(a) running 态 jsonl 是否实时 flush？（Pi session 持久化时机未知）；(b) jsonl 是 Pi session 格式（含 meta/usage 行），AI 直接 read 能解析出进度吗？(c) list item（FR-3 的 7 字段）**不含 eventLog/currentActivity**，AI 在 tool 内完全看不到 running 进度详情。spec 未验证这条替代路径可行。 |
| G-015 | F | API Contract | P3/OP-A:content JSON + FR-3/AC-3 | content 改为 `JSON.stringify(领域对象)` 后，schema 模式下 `syncResponse.parsedOutput`（`unknown` 类型）会被 JSON.stringify 二次序列化——外层 content 是 JSON 字符串，parsedOutput 在其中是嵌套 JSON 值（对象/数组）。现实现（`subagent-tool.ts`）schema 模式直接输出 `JSON.stringify(parsedOutput)` 作为 content。重构后调用方（其他 agent/workflow）解析 content 取 parsedOutput 的方式变了。spec 未说明这种嵌套是否可接受。 |
| G-016 | D | Failure Path | P5/content 风格一致性 + FR-3 vs notifier | tool 返回的 content 改 JSON 字符串（FR-3），但 background 完成的 followUp 通知 content（`notifier.ts:buildLlmContent`）仍是人类可读文本（`Subagent "X" completed. Result:\n...`）。**两种 content 风格并存**（tool action 返回 JSON / followUp 返回自然语言），LLM 在同一会话里要适应两种解析。决策：followUp content 是否也 JSON 化以保持一致？（FR-11/D10 说 followUp 不变，但未评估一致性代价） |

### 低优先级（清理 / 错误信息 / 测试）

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-017 | F | Data Lifecycle | P2/删 query 残留 + FR-4 | FR-4 列了删 `service.query` + `QueryResult` + poll 分支 + `backgroundId` 字段，但**未列**：(a) `subagent-service.ts:31` 的 `QueryResult` import；(b) `subagent-service.ts` 底部的私有方法 `recordToQueryResult`（只被 query 调用）；(c) `SubagentToolDetails.backgroundId?` 字段（`types.ts`，FR-8 加 mode 后是否同时删 backgroundId？还是保留兼容？）。AC-4 的 grep 会漏掉 `recordToQueryResult`。 |
| G-018 | F | Data Lifecycle | P2/死代码 + FR-10/Out of Scope | 删 `config-wizard.ts` + `format-helpers.ts` 后，`config.ts:116 saveGlobalConfig`（注释「config-wizard 调用」）和 `model-config-service.ts:174 updateGlobalConfig` 可能变死代码（无其他调用方）。spec Out of Scope 说「不动配置域」，但遗留死代码与项目「不加推测性功能 / 失败要出声」原则冲突。决策：是否一并清理？还是留待后续？ |
| G-019 | D | Failure Path | P5/cancel 错误信息 + FR-5/AC-9 | cancel 失败 throw，但错误信息未区分场景：(a) id 不存在（`getMutable` 返回 undefined → `cancel` 返回 false）；(b) 已终态（`tryTransition` 失败 → false）；(c) 并发 cancel（两个 cancel 同时调，第二个 `tryTransition` 失败）。三者都 return false → tool 层 throw 同一个 Error。AI 无法区分「id 写错」vs「已被取消」vs「已完成」。是否需要 service 层返回更细的错误类型？ |
| G-020 | F | User Journey | P1/测试覆盖 + AC | spec AC 未覆盖测试改动。现有 `__tests__/` 有 `subagent-service.test.ts`（测 query/cancel/execute）、`sdk-contract.test.ts`、`execution-record.test.ts`（测 project/snapshot/toPersisted）。重构后：query 测试要删、details 结构变了 project 测试要改、tool action 路由要新增测试。spec 未列测试更新范围，可能导致 AC 通过但测试套件破坏。 |
| G-021 | D | API Contract | P3/OP-A:list duration + FR-3/AC-6 | FR-3 item 含 `duration`，但 `SubagentRecord`（`types.ts:230`）**无 duration 字段**，只有 `startedAt/endedAt`。FR-6 说「running 态用 `Date.now()-startedAt`，终态用 `endedAt-startedAt`」，但**单位未定义**（秒？毫秒？）。现有 TUI 用 `formatElapsedSeconds`（秒）。list handler 算 duration 放哪（handler 内联 / `SubagentRecord` 加字段 / 复用 `project` 的 `elapsedSeconds`）？ |

---

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（完全降级） | 本需求是 tool 接口重构，不改数据模型（`ExecutionRecord`/`PersistedAgentRecord`/`SubagentRecord` 的字段语义不变） | spec Out of Scope：「history.jsonl 持久化格式重构 — 仅向后兼容加字段」「subagent 执行引擎不动」 |
| Data Lifecycle（部分追踪：sessionFile 数据流） | FR-7 改 sessionFile 填充时机，虽不改数据模型但改数据流（session 创建 → record 回填），且 necessitate `ExecutionRecord` 加字段——影响 `listRunning`/`collectRecords`/`project` 的投影。发现 G-001/G-002/G-003，故部分追踪 | FR-7/D9 + AC-5 明确要求 running 态 list 返回 sessionFile |
| State Machine（完全降级） | 本需求不变更执行状态机（`running→done/failed/cancelled`，`tryTransition` CAS 不动） | spec 未引入任何状态转换变更；FR 只动 tool 接口层 + 投影层 |
| State Machine（部分追踪：cancel 对 sync record 的副作用） | FR-5 新增 cancel 入口，虽不改状态机定义，但 cancel 操作对 sync running record 的 `tryTransition` 行为未被 spec 约束——发现 G-005（cancel sync record 导致状态混乱 + 误发 followUp），故部分追踪 | FR-5/AC-9 只描述 cancel background 的预期，未提 sync record 的边界 |

---

## 追踪小结

**最阻塞的 3 个 gap（主 agent 必须先决策才能进入实现）：**

1. **G-001 + G-002 + G-003（sessionFile 三连）**：FR-6 的 `listRunning()` 路径拿不到 sessionFile（类型缺字段），FR-7 的「record 创建后立即填」时序不可能（session 在 run 内部才建），两者叠加导致 AC-5「立即 list → sessionFile 有值」在 pool 排队场景下不可达成。需要重新设计 sessionFile 回填机制 + list 数据源。

2. **G-004（cancelResponse.cancelled 死值）**：FR-3 的类型定义与 FR-5/AC-9 的 throw 语义直接冲突，必须二选一。

3. **G-005 + G-006（cancel sync record）**：cancel 不区分 mode 会导致 sync running record 被误取消，引发状态混乱 + 误发 followUp。list 不暴露 mode 让 AI 无法自行规避。

**其余 gap 多为边界值/错误信息/清理类，可在实现中逐个处理，但 G-014（废 poll 后 running 进度查看路径未验证）值得主 agent 评估是否影响核心用户体验。**

Round 1 完成，未做 CONVERGED 判定（按指令）。
