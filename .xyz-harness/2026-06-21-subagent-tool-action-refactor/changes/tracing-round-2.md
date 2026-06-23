# Tracing Round 2

## 追踪范围
- spec 初稿版本：`spec.md`（verdict: pass）+ `clarification.md`（D1-D12）— tool action 化（start/list/cancel）+ 废 poll + spinner mode 修复 + sessionFile 窗口期 + command 精简 + cancel 三处一致修复
- 追踪的视角（完整重跑，非增量）：
  - P1 User Journey（适用）
  - P2 Data Lifecycle（降级：接口重构不改数据模型，但追踪 sessionFile/mode 数据流 + cancel 签名变更对现有调用方的影响 — 发现实质 gap，部分追踪）
  - P3 API Contract（适用，重点）
  - P4 State Machine（降级：状态机不变，但追踪 cancel throw 化对现有 cancel 调用方的副作用 — 发现实质 gap，部分追踪）
  - P5 Failure Path（适用，重点）

---

## 判定：**有新 gap**（未收敛）

上轮 gap（G-001 ~ G-021）已在 spec 中处理，处理方向正确且基本自洽。但从零重跑 5 视角发现 **Round 1 未覆盖的新 gap**，集中在三处：
1. **cancel 签名变更对「声明为 Out of Scope 的 list-view 调用方」的连带影响**（spec 自相矛盾：声明不动但改了其依赖的契约）
2. **SubagentToolDetails 重构后 project()/onUpdate/adapter 的职责边界未定义**（FR-8 加 mode 与 FR-9 分组化之间的结构冲突）
3. **sessionFile 投影遗漏 `snapshot()` 生产者**（FR-7 列了 project/recordToSubagent/toPersisted，漏了 snapshot）

---

## 新 Gap 列表

### 高优先级（实现阻塞 / spec 内部矛盾）

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G2-001 | D | Failure Path / State Machine | P5/cancel + FR-5/D6 vs Out of Scope | FR-5/D6 要求 `service.cancel` 区分三种错误并 **throw**（id 不存在 / mode≠background / 已终态）。但 `tui/list-view.ts:873` 的 `handleCancel` 仍按 boolean 返回值调用：`const ok = service.cancel(record.id); notify?.(ok ? ... : ...)`。spec Out of Scope 明确写「TUI list view（`/subagents` 命令的 overlay）—— 只改命令入口，list view 渲染不动」——但 cancel 签名从 boolean 改 throw 不是渲染问题，是**行为契约变更**。实现者若遵循「list view 不动」会漏改 handleCancel，导致 list view 里按 `x` 取消 background record 时若发生竞态（record 在 pre-check 后、cancel 调用前变终态），service.cancel throw 会让未 catch 的异常逃逸到 overlay。**决策**：(a) `service.cancel` 保持 boolean 返回，tool 层 cancelHandler 自行 getMutable + 判 mode + 翻译 throw（service 层不改）；(b) service.cancel 改 throw，list-view 的 handleCancel 包 try/catch 并更新 notify 文案。spec 未决策。 |
| G2-002 | D | API Contract / User Journey | P3/OP-A:start + FR-8 vs FR-9 + D11 | `SubagentToolDetails` 被 FR-9 重组为分组结构（FR-3 形态 + `action` 字段），但 **`project()` 的职责未重新定义**。现状 `project(record)` 被 4 处调用（`subagent-service.ts:188/193/434/488`）：sync execute return、bg execute return、onUpdate streaming 回流、recordToQueryResult（将删）。重组后：(a) `project()` 返回内层 syncResponse 字段（status/agent/model/turns/...），由 tool 层 startHandler + onUpdate wrapper 负责包成外层分组对象？还是 (b) `project()` 直接返回完整分组对象？若 (b)，project 需要知道 action/subagentId/sessionFile —— 这些是 tool 层上下文，Core 层 project 不该感知。D11 只说「onUpdate 回流也走 adapter」，未划分 project() 产出 vs adapter 包裹的边界。`ExecutionHandle.details: SubagentToolDetails`（types.ts:201-202）也受牵连——它是 service 层返回值，不该带 `action` 字段（tool 层概念）。**决策**：project() 继续返回内层字段（syncResponse 载荷），adapter（tool 层唯一）负责 lift 成分组结构？需明确。 |
| G2-003 | F | Data Lifecycle | P2/mode 字段归属 + FR-8 vs FR-3/FR-9 | FR-8 写「`SubagentToolDetails` 加 `mode: ExecutionMode` 字段，`project()` 返回时带上」——这是基于**旧的扁平结构**写的。FR-9 把 SubagentToolDetails 重组为分组（FR-3 形态 + action）。但 FR-3 的结构定义里：外层 `{ subagentId, sessionFile, syncResponse?, bgResponse?, listResponse?, cancelResponse? }` **没有 mode 字段**；内层 `syncResponse`/`bgResponse` 字段列表里**也没有 mode**。FR-8 的 spinner 修复依赖 `this.details.mode === "sync"`（tool-render.ts）—— mode 必须在 details 上可达。**spec 内部矛盾**：FR-8 说加 mode，FR-3 的结构里没地方放。需明确 mode 挂在外层（与 action 同级，list/cancel 时 undefined）、还是内层 syncResponse/bgResponse 各自带、还是从 `action==="start" && syncResponse 存在` 推导（不显式存）。 |

### 中优先级（投影遗漏 / 边界未定义）

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G2-004 | F | Data Lifecycle | P2/sessionFile 投影 + FR-7 | FR-7 列「`project()` / `recordToSubagent` / `toPersisted` 输出新字段」，但**遗漏 `snapshot()`**。FR-7 同时说「`RecordSnapshot` 新增 `sessionFile?: string` 字段」——而 `snapshot()`（execution-record.ts:413）是 RecordSnapshot 的唯一生产者。sessionFile 是 optional，tsc 不会强制 `snapshot()` 填充——若实现者只改 spec 列的三个函数，`snapshot()` 返回的 RecordSnapshot.sessionFile 恒为 undefined。直接影响：sync execute 返回 `{ record: snapshot(record), details }`（subagent-service.ts:188），startHandler 从 `handle.record.sessionFile` 取值放外层 → 恒 undefined → **AC-5「sync 执行完成 → syncResponse 同级有 sessionFile」不可达成**。需补 `snapshot()` 到 FR-7 更新清单。 |
| G2-005 | K/D | API Contract | P3/OP-A:list + FR-6 | list action 的 **session 作用域**未定义。`collectRecords(limit, sessionId?)`（record-store.ts:146）支持按 sessionId 过滤 history。现状 `/subagents` TUI 命令调 `collectRecords(LIST_LIMIT)` **不传 sessionId**（跨 session 全量）。tool 层 `action:"list"` 是给 AI 用的——AI 应只看到**当前 session** 启动的 subagent（其他 session 的 record 对当前任务是噪音），还是看到全局？spec FR-6 只说「collectRecords 过滤 running」，未提 sessionId。若不传 sessionId，AI list 会混入历史 session 的 record（尤其是 includeFinished:true 时）。**决策**：listHandler 是否传 `service.modelService.sessionId` 限定当前 session？ |
| G2-006 | D | API Contract | P3/OP-A:list + FR-3 | `listResponse.running: number` 的语义未定义。FR-3 写 `{ running: number, items: SubagentListItem[] }`。默认模式（仅 running）下 items 全是 running，`running` 似乎 = items.length。但 `includeFinished:true` 时 items 含终态 record——此时 `running` 是：(a) items 中 status==="running" 的子集计数？(b) 不受 limit 截断的「真实 running 总数」？(c) items.length（含 finished，命名误导）？三种对 AI 的信号不同：(a)/(b) 让 AI 知道「还有 N 个在跑」，(c) 等于 items.length 无信息增量。另：若 limit=5 但实际有 10 个 running，items 只含 5 个，`running` 报 5 还是 10？影响 AI 判断「是否还有未列出的 running」。 |
| G2-007 | F | User Journey | P1/renderResult 防御 guard + FR-9 | `renderSubagentResult`（tool-render.ts:140）现有防御 guard：`if (!details \|\| typeof details.status !== "string" \|\| typeof details.agent !== "string") → 返回 "(subagent execution failed — no details available)"`。重组后 action="list" 的 details 是 `{ action:"list", subagentId:null, sessionFile:null, listResponse:{...} }`——**无顶层 status/agent 字段**。若不更新此 guard，**每次 list/cancel 调用都会渲染成「execution failed」错误行**。FR-9 说「renderResult 按 action 分支渲染」暗示了重写，但未显式提到要改这个前置 guard。实现者若只加 switch(action) 分支而忘了改入口 guard，list/cancel 的 TUI 展示直接废掉。 |

### 低优先级（可推断但未显式声明）

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G2-008 | F | API Contract | P3/startParam.task + D12/G-008 | D12/G-008 给 `startParam.task` 加了 `.trim()` + 空白 throw。但 `cancelParam.subagentId`（必填 string）未做同等校验——传 `subagentId: ""` 或 `"  "` 会进 service 层 getMutable("") → undefined → throw「No subagent record」。错误信息可读但未在 spec 声明「subagentId 也 trim」。边界一致性：要么都 trim，要么声明 subagentId 不 trim（空串当合法查询失败）。小问题。 |
| G2-009 | D | User Journey | P1/renderCall 标题行 + FR-9 | `renderSubagentCall`（tool-render.ts）从 args 提取 agent 名做标题行「subagent worker · model」。action="list"/"cancel" 的 args 无 `agent` 字段，`extractAgentName` 降级返回 "default"——标题行显示「subagent default」对 list/cancel 语义误导（AI 看到的 tool call 标题不像是在 list/cancel）。FR-9 只提 renderResult 按 action 分支，未提 renderCall。纯展示问题，非阻塞。 |

---

## 上轮 gap 修复复核（验证完整性 + 自洽性）

| 上轮 Gap | spec 修复 | 复核结论 |
|----------|----------|---------|
| G-001（listRunning 无 sessionFile） | FR-6 改用 collectRecords 过滤 running | ✅ 自洽。collectRecords → SubagentRecord（已有 sessionFile 字段，types.ts:240）。但 **G2-004** 发现 recordToSubagent 现读 `r.agentResult?.sessionFile`，FR-7 要求改读 `r.sessionFile`（新字段），spec 列了 recordToSubagent 需改。 |
| G-002（sessionFile 窗口期） | FR-7/D9 接受窗口期 undefined | ✅ 自洽。窗口期描述准确（pool 满 → 几秒~几十秒）。AC-5 覆盖三种情况（成功/排队/失败）。 |
| G-003（ExecutionRecord 加 sessionFile） | FR-7 列了字段新增 + 回填点 | ✅ 基本自洽，但 **G2-004** 发现漏了 `snapshot()` 生产者。 |
| G-004（cancelResponse 死值 false） | FR-5/D6 改 `cancelled: true` 字面量 | ✅ 自洽。 |
| G-005（cancel sync record bug） | FR-5/D6 cancel 检测 mode throw | ✅ bug 分析准确（controller undefined → abort no-op → tryTransition 成功 → 误发 followUp）。修复方向正确。但 **G2-001** 发现 throw 化影响 list-view 现有调用方。 |
| G-006（list 不带 mode） | FR-3/FR-6 item 带 mode | ✅ 自洽。 |
| G-007~G-012, G-015~G-016 | D12 逐条处理 | ✅ 自洽。 |
| G-013（session 创建失败 sessionFile） | FR-7 sessionFile=undefined，item 保留 | ✅ 自洽。 |
| G-014（running 进度查看路径） | D5 声称 jsonl 实时 flush + AI 可解析 | ⚠ 未在 spec 正文展开验证细节（claim 在 clarification D5），但属设计决策非 gap。 |
| G-017~G-018（死代码清理） | FR-4/FR-10 列了清理项 | ✅ 自洽。grep 确认 saveGlobalConfig 仅 config-wizard 调用。 |
| G-019（cancel 错误信息） | FR-5/D6 三种 throw 文案 | ✅ 自洽。但 **G2-001** 发现实现路径（service 改 vs tool 层翻译）未定。 |
| G-020（测试） | AC-10 覆盖 | ✅ 自洽。 |
| G-021（duration 单位/位置） | FR-6 秒 + handler 算 | ✅ 自洽。listHandler 从 startedAt/endedAt 算。 |

**上轮修复整体质量高**，无引入新矛盾。新 gap 均为 Round 1 视角未触达的**连带到 Out-of-Scope 代码**（G2-001）、**重构后类型结构内部一致性**（G2-002/G2-003）、**投影生产者遗漏**（G2-004）。

---

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（完全降级） | 本需求是 tool 接口重构，不改数据模型（ExecutionRecord/PersistedAgentRecord/SubagentRecord 字段语义不变，仅加 optional sessionFile） | spec Out of Scope：「history.jsonl 持久化格式重构 — 仅向后兼容加字段」「执行引擎不动」 |
| Data Lifecycle（部分追踪：sessionFile + mode 数据流 + cancel 签名） | FR-7 改 sessionFile 填充时机 + FR-8 加 mode 字段 + FR-5 改 cancel 签名，虽不改数据模型但改数据流与投影/契约——发现 G2-002/G2-003/G2-004，故部分追踪 | FR-7/FR-8/FR-5 + AC-5/AC-9 明确要求 |
| State Machine（完全降级） | 本需求不变更执行状态机（running→done/failed/cancelled，tryTransition CAS 不动） | spec 未引入状态转换变更 |
| State Machine（部分追踪：cancel throw 化对调用方的副作用） | FR-5 把 cancel 从 boolean 改 throw，虽不改状态机定义，但改变了 cancel 操作的契约——影响现有调用方 list-view（G2-001），故部分追踪 | FR-5/D6 + list-view.ts:873 现有 boolean 消费 |

---

## 追踪小结

**最阻塞的 3 个新 gap（建议主 agent 先决策）：**

1. **G2-001（cancel 签名变更连带 list-view）**：spec 声明 list-view Out of Scope，但 FR-5 改了 list-view 依赖的 `service.cancel` 契约。必须决策：service 层改还是 tool 层翻译。这决定了 service.cancel 的公开 API 形状。

2. **G2-002 + G2-003（SubagentToolDetails 重构的结构一致性）**：FR-8（加 mode，基于旧扁平结构）与 FR-9（分组化）之间的矛盾未消解。project() 的职责、mode 的归属、ExecutionHandle.details 的形态，三者纠缠。不解决则 implementer 各做各的，sync streaming onUpdate 回流与 start 返回路径可能不一致。

3. **G2-004（snapshot() 遗漏）**：FR-7 列投影更新时漏了 `snapshot()` 生产者。sessionFile 是 optional，tsc 不报错，但 AC-5「sync 完成 → sessionFile 有值」静默失败。低成本的文档补全即可修复，但不补会出运行时 bug。

**其余 gap（G2-005 ~ G2-009）为边界声明/展示类，可在实现中处理，但 G2-005（list session 作用域）影响 AI 信息可见性，值得主 agent 明确。**

Round 2 完成，**未收敛**（9 个新 gap）。
