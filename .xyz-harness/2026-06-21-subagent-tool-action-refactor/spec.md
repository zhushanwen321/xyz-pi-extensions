---
verdict: pass
---

# Subagent Tool Action Refactor

## Background

`@zhushanwen/pi-subagents` 的 `subagent` tool 当前用**参数重载**区分三种语义：sync 执行、background 启动、poll 查询。这导致两个问题：

1. **Bug（锁死）**：background subagent 被 AI 轮询后，页面锁死底部无法滚动。根因是 `SubagentResultComponent.maybeToggleSpinner` 用 `details.backgroundId` 判断是否启动 spinner 定时器，但 poll 返回的 `QueryResult` 无此字段，导致 `setInterval(200ms)` 泄漏，永久 invalidate 把 viewport 钉在底部。
2. **设计债**：参数重载让 tool description 膨胀（大量 anti-pattern 纠正语），缺 cancel 入口（LLM 无法主动取消跑飞任务），poll 返回给 LLM 的信息与给人看的不对称（人看 eventLog，LLM 只看一句 "still running"）。

本次重构同时解决 bug、清设计债、统一信息传递。**废弃 poll**，改为「list 列表 + 详情看 jsonl」，取消和查询都有显式 action。

## Functional Requirements

### FR-1: tool action 化（start/list/cancel）

`subagent` tool 参数改为显式 action + 分组参数：

```typescript
SubagentParams = Type.Object({
  action: StringEnum(["start", "list", "cancel"]),
  startParam:  Type.Optional(Type.Object({ task, agent?, wait?, model?, thinkingLevel?,
                 skillPath?, appendSystemPrompt?, schema?, maxTurns?, graceTurns? })),
  listParam:   Type.Optional(Type.Object({ includeFinished?: boolean, limit?: number })),
  cancelParam: Type.Optional(Type.Object({ subagentId: string })),
})
```

- `action === "start"` → `startParam` 必填，执行子代理（sync/background 由 `wait` 决定）
- `action === "list"` → 查询 subagent 列表，默认仅 running
- `action === "cancel"` → `cancelParam.subagentId` 必填，取消指定 background subagent

**校验**：action 与对应 param 不匹配时 throw（如 `action:"start"` 但无 `startParam`）。

### FR-2: 内部 handler 路由 + adapter 适配出参

execute 分三层（解耦模式）：
1. **入口路由**：`switch(action)` 分发到 `startHandler` / `listHandler` / `cancelHandler`
2. **内部 handler**：各自返回纯领域对象，不碰 `{content, details}`，互不耦合
3. **唯一 adapter**：领域对象 → `{content: [{text: JSON.stringify(领域对象)}], details: 领域对象 + action 标记}`

content（JSON 字符串）给 LLM，details 给 TUI renderResult，同源同处生成。

### FR-3: 出参结构化

```typescript
// 领域对象（adapter 统一包装）
{
  subagentId: string | null,      // start/cancel 有，list 为 null
  sessionFile: string | null,     // 同上（start 的窗口期可能 undefined）
  // 内层按 action 四选一
  syncResponse?:   { status, agent, model, mode, turns, totalTokens, elapsedSeconds,
                     eventLog, currentActivity?, result?, error?, parsedOutput? }
  bgResponse?:     { status: "running", mode: "background", message: string }   // message = "detached, will notify on completion"
  listResponse?:   { running: number, items: SubagentListItem[] }       // running = items 中 status==="running" 的计数
  cancelResponse?: { cancelled: true }                       // 失败一律 throw，false 是死值
}

// list 的 item 结构（8 字段）
SubagentListItem = { subagentId, agent, status, mode, duration(秒), model, totalTokens, sessionFile }
```

- sync 完成 → `syncResponse`（status=done/failed/cancelled）
- background 启动 → `bgResponse`（立即返回，subagentId 给后续 cancel/list 用）
- list → 最外层 subagentId/sessionFile 为 null，每个 item 自带 sessionFile + mode
- cancel → `cancelResponse.cancelled: true`（字面量类型，失败 throw）
- schema 模式 `syncResponse.parsedOutput` 作为 content JSON 嵌套值（可接受）
- **mode 挂在内层** syncResponse/bgResponse（project() 返回，不感知外层 action）；list item 自带 mode；cancelResponse 无 mode（语义无关）

**分层职责**（消解 G2-002/003 + G3-001）：
- `SubagentToolDetails` = **内层**扁平结构（project 产出，含 mode/status/agent/model/turns/...），是 sync 执行字段的投影。`ExecutionHandle.details: SubagentToolDetails` 保持此内层形态
- `SubagentToolResult` = **外层**分组结构（adapter 产出，含 action/subagentId/sessionFile + syncResponse?/bgResponse?/listResponse?/cancelResponse?）。tool return / onUpdate 回流 / renderResult 消费的都是 SubagentToolResult
- `project(record)` 职责不变：返回 SubagentToolDetails（内层），不感知 action/外层分组
- adapter（tool 层唯一）负责把 project 产出 lift 成 SubagentToolResult（加 action/subagentId/sessionFile + 包成 syncResponse）
- onUpdate 回流的 details 是 adapter 包裹后的 SubagentToolResult（renderResult 消费）

### FR-4: 废弃 poll

- 删 `service.query(id)` 方法（`subagent-service.ts:200,486`）
- 删 `QueryResult` 类型（`types.ts:205`）
- 删 `subagent-tool.ts` 的 poll 分支（`executeSubagent` 中 `if (params.backgroundId)` 块）
- 删 `SubagentParams.backgroundId` 字段
- 删 tool description 中所有 poll 相关说明（"Polling (backgroundId)" 段 + anti-pattern 条目）

**详情查看方式**：agent 通过 `action:"list"` 拿到 `sessionFile` 路径后，直接用 `read` tool 读 jsonl。

### FR-5: cancel 入口（三层职责：service 不变，tool 层翻译）

追踪发现两个问题：
1. sync running record bug（controller undefined → abort no-op → tryTransition 误成功 + 误发 followUp）
2. `service.cancel` 被 list-view 的 `handleCancel`（`list-view.ts:873`）用 boolean 消费，list-view 已用 `if (record.mode === "background")` 包裹调用（sync 分支不调）

**方案：service 层保持 boolean 返回不变，tool 层 cancelHandler 翻译 throw**。
- `service.cancel(id): boolean` 契约不变（list-view 零改动）
- **service 新增 `findRecord(id): RecordSnapshot | undefined`**（公开只读查询，封装内部 `getMutable` 的快照版本，G3-002）——cancelHandler 和未来的只读查询都用它
- tool 层 cancelHandler 自己做：
  1. `const rec = service.findRecord(id)`；`!rec` → throw `No subagent record with id "..."`
  2. `rec.mode !== "background"` → throw `Cannot cancel sync subagent (only background can be cancelled)`
  3. `!service.cancel(id)`（tryTransition 失败，已终态）→ throw `Subagent {id} already finished (status: ${rec.status})`
  4. 返回 true → `cancelResponse: { cancelled: true }`
- `cancelResponse.cancelled: true` 字面量（失败 throw，false 是死值）
- list item 带 mode（让 AI 区分可 cancel 的 background record）

### FR-6: list 默认范围与字段

- 默认仅 running record（`collectRecords` 过滤 `status==="running"`）
- **session 作用域**（诚实声明，G3-003）：history 源按当前 sessionId 过滤；内存源（live/completed/bg）天然跨 session（ExecutionRecord 无 sessionId 字段，record-store 不清）。/new /resume /fork 后内存中可能残留前 session 的 record（通常很少，多为刚 cancel 的 background）。不新增 sessionId 到 ExecutionRecord（YAGNI，修 record-store 跨 session 清理是独立问题）
- `listParam.includeFinished === true` → 查全部（含已结束）
- `listParam.limit` 默认 20，夹紧 `Math.max(1, Math.min(limit ?? 20, 100))`
- item 字段（8 个）：subagentId, agent, status, mode, duration（秒）, model, totalTokens, sessionFile
- duration 实时计算：running 态 `Math.floor((Date.now()-startedAt)/1000)`，终态 `Math.floor((endedAt-startedAt)/1000)`
- 排序：默认 `startedAt desc`（最新在前）；`includeFinished:true` 时 running 优先 + startedAt desc
- 无 record 时返回 `{ running: 0, items: [] }`（不 throw）
- `running` 计数语义：items 中 `status==="running"` 的子集计数（受 limit 截断时如实反映 items 内 running 数，非全局总数）

### FR-7: sessionFile 回填（接受窗口期）

追踪发现「record 创建后立即填」时序不可能：session 在 `run()` 内部 `createAndConfigureSession`（`session-runner.ts:255`）才创建，record 在 `service.execute` 创建并 `store.register` 进入 live map（立即可被 list 看到）。两者间存在窗口期。

**方案：接受窗口期 undefined**。
- `ExecutionRecord` + `RecordSnapshot` 新增 `sessionFile?: string` 字段
- `run()` 内 `createAndConfigureSession` 成功后回填 `record.sessionFile`
- list item 的 `sessionFile` 可选，窗口期内为 undefined（通常毫秒级；pool 满 maxConcurrent 时可能几秒~几十秒）
- **投影生产者更新清单**（完整）：`project()` + `snapshot()` + `recordToSubagent` + `toPersisted` 四处（snapshot 漏了会致 sync execute 返回的 sessionFile 恒 undefined）
- session 创建失败（createAndConfigureSession catch）→ sessionFile 永久 undefined，list item 保留（status=failed）

否决：「session 建好前藏住 record」（破坏 list/cancel 可见性）。

### FR-8: spinner 泄漏修复（长期方案）

`SubagentToolResult`（外层分组，adapter 产出）的 sync 子结构 `syncResponse`/`bgResponse` 含 `mode: ExecutionMode` 字段（来自内层 `SubagentToolDetails` 的对应字段）。`project()` 返回时带上 mode。

`SubagentResultComponent.maybeToggleSpinner`（`tui/tool-render.ts`）判断改为：
```typescript
// 只有 sync 模式的 tool block 会持续 onUpdate（需要 spinner）
// background（含已废弃的 poll 场景）都是一次性 block，不启动定时器
if (this.details.status === "running" && this.details.mode === "sync") {
  // 启动 spinner setInterval
}
```

mode 从内层 syncResponse/bgResponse 读取（FR-3 的分层职责）。

### FR-9: details 纯分组 + renderResult/renderCall 按 action 分支

`SubagentToolResult`（外层分组）重组 details 形态（含 `action` 字段）。`renderResult`（`tui/tool-render.ts`）按 action 分支渲染：
- start → 复用现有 spinner/eventLog 逻辑（从 syncResponse/bgResponse 取字段，含 mode）
- list → 表格渲染（每行一个 item）
- cancel → 确认行

**sync streaming 的 onUpdate 回流也走 adapter**（details 分组化），与 renderResult 同源。

**renderResult 防御 guard 更新**（G2-007）：入口 guard 改为按 action 判断——`action==="start"` 检查内层 syncResponse/bgResponse 存在；`action==="list"` 检查 listResponse 存在；`action==="cancel"` 检查 cancelResponse 存在。不再检查顶层 status/agent（list/cancel 无此字段，旧 guard 会误判「execution failed」）。

**renderCall 标题行按 action 显示**（G2-009）：start 显示 agent+model（现状）；list 显示「list」；cancel 显示「cancel {subagentId}」。

**禁止双层冗余**（外层保留扁平字段供旧 renderResult 兼容）—— 违反单数据源原则。

### FR-10: command 精简 — /subagents = list

`/subagents` 命令改为等同原 `/subagents list [<id>]`：
- 删 `config [category]` 分支 + `runConfigWizard` 调用
- 删无参摘要分支 + `formatConfigSummary` 调用
- `args[0]` 直接作为可选 `<id>`（原 `args[1]`）
- description 改为 `Subagents: /subagents [<id>]`

死代码清理（确认无测试、无其他引用）：
- 删 `tui/config-wizard.ts`（253 行）
- 删 `tui/format-helpers.ts`（37 行）
- 连带清理 `config.ts:saveGlobalConfig` + `model-config-service.ts:saveGlobalConfig`（仅 config-wizard 调用，变死代码）

### FR-11: followUp 通知保留

background 完成通知（`notifier.ts` + `bg-notify-render.ts`）逻辑不变：
- `pi.sendMessage({ customType:"subagent-bg-notify", deliverAs:"followUp", triggerTurn:true })`
- content 给完整 result（进 LLM context）
- details 给 renderer（TUI 块展示首行预览）

## Acceptance Criteria

### AC-1: 锁死 bug 修复
- 启动 background subagent + 多次 list（原 poll 路径）后，页面可正常鼠标滚动
- running 态 list 返回的 tool block 不启动 spinner 定时器（`mode !== "sync"`）
- 验证方式：跑一次 background，连续 list 5 次，检查无 `setInterval` 泄漏（可用 `node --inspect` 或行为观察）

### AC-2: tool action 路由正确
- `action:"start"` + `startParam.task` → 执行子代理，返回 `syncResponse` 或 `bgResponse`
- `action:"list"` → 返回 `listResponse.items`（默认仅 running）
- `action:"list"` + `listParam.includeFinished:true` → items 含已结束
- `action:"cancel"` + 有效 `subagentId` → 返回 `cancelResponse.cancelled:true`
- action 与 param 不匹配 → throw（如 `action:"start"` 无 `startParam`）

### AC-3: 出参结构化（content + details 同源）
- content 是合法 JSON 字符串，含 `subagentId` + `sessionFile` + 对应 response 分组
- details 是领域对象本身 + `action` 字段
- LLM 能解析 content JSON（function calling 标准）
- TUI renderResult 按 `details.action` 分支渲染

### AC-4: poll 彻底废弃
- `service.query` 方法不存在
- `QueryResult` 类型不存在
- `SubagentParams` 无 `backgroundId` 字段
- tool description 无 poll 相关说明
- `grep -rn "backgroundId\|QueryResult\|service\.query" extensions/subagents/src/` 无残留（除 history 注释）

### AC-5: sessionFile 可用性（接受窗口期）
- background 启动后 list → session 创建成功后（通常毫秒级）item.sessionFile 有值
- pool 排队窗口期（仅 maxConcurrent 已满时）sessionFile 可能为 undefined，AI 稍后重试 list 即可获取
- session 创建失败的 record（status=failed）→ sessionFile 永久 undefined，item 保留
- sync 执行完成 → `syncResponse` 同级有 `sessionFile`（需 snapshot() 也填，验证不漏）

### AC-6: list 内容正确
- items 每条含 8 字段：subagentId, agent, status, mode, duration, model, totalTokens, sessionFile
- item.mode 值为 "sync" 或 "background"（AI 据此判断可否 cancel）
- running 态 duration（秒）实时增长（两次 list 间隔 2s，duration 差 ≈2）
- limit 生效：默认 20，传 `limit:5` 返回 ≤5 条，传 `limit:0` 夹紧为 1，传 `limit:100000` 夹紧为 100
- 排序：默认 startedAt desc（最新在前）

### AC-7: command 精简
- `/subagents` 直接打开 list view（原 `/subagents list` 行为）
- `/subagents <id>` 聚焦该 id（原 `/subagents list <id>` 行为）
- `/subagents config` 不再触发 wizard（可报「未知参数」或忽略）
- `config-wizard.ts` 和 `format-helpers.ts` 文件不存在
- `config.ts:saveGlobalConfig` + `model-config-service.ts:saveGlobalConfig` 已删（连带死代码）
- `grep -rn "runConfigWizard\|formatConfigSummary\|saveGlobalConfig" extensions/subagents/src/` 无残留

### AC-8: followUp 不变
- background 完成后，主对话流出现完成通知块（customMessageBg）
- 完成通知的 content 含完整 result（不截断，自然语言格式与 tool action 的 JSON 风格并存）
- 完成通知唤醒父 agent 下一 turn（triggerTurn 生效）
- notifier / bg-notify-render 逻辑零改动

### AC-9: cancel 行为（service boolean + tool 翻译 throw）
- cancel running background → record 转 cancelled（`tryTransition` CAS 抢锁成功），后续 list 中该 record status=cancelled
- cancel 不存在的 id → tool 层 throw `No subagent record with id "..."`，AI 收到错误反馈
- cancel sync record（mode=sync）→ tool 层 throw `Cannot cancel sync subagent (only background can be cancelled)`
- cancel 已终态（done/failed/cancelled）record → tool 层 throw `Subagent {id} already finished (status: ...)`
- cancel 成功 → `cancelResponse.cancelled: true`（false 永不出现）
- 并发 cancel（同一 id 两个 cancel 调用）→ 第一个成功，第二个 throw「已终态」（CAS 互斥）
- `service.cancel` 签名不变（boolean），list-view handleCancel 零改动

### AC-10: 测试更新
- 删 query 相关测试（subagent-service.test.ts 中 query/recordToQueryResult 的用例）
- 改 details/project 测试：project() 输出含 mode + sessionFile，details 重组为分组结构
- 新增 action 路由测试：start/list/cancel 三路径各自的成功 + 失败用例
- 新增 cancel sync record 的 throw 测试（G-005 回归）
- 保留 cancel background / execute / notifier 现有测试
- 验证：`pnpm --filter @zhushanwen/pi-subagents test` 全绿

## Out of Scope

- subagent 执行引擎本身（session-runner / event-bridge / output-collector）—— 不动执行逻辑，只改 tool 接口层 + 投影层
- background 并发池（concurrency-pool）—— 不改并发控制
- history.jsonl 持久化格式重构 —— 仅向后兼容加字段，不改存储结构
- TUI list view（`/subagents` 命令的 overlay）—— 只改命令入口，list view 渲染不动
- notifier / bg-notify-render —— followUp 逻辑完全不变
- agent 发现 / 模型解析 / discovery-config —— 不动配置域
- subagent 内部 turn 限制 / schema enforcement —— 不动 session-runner hooks

## Constraints

- TypeScript 零 `any`，用 `unknown` 或具体类型（项目硬性约束）
- 禁止双层冗余（details 扁平字段 + 分组字段并存）—— 单数据源
- 禁止 `SKIP_LINT=1` / `--no-verify` / `eslint-disable`（项目硬性约束）
- 单文件 ≤1000 行，函数 ≤80 行（spec 拆分时遵守）
- 向后兼容：旧 history.jsonl（无 mode/sessionFile 字段）反序列化不崩，缺失字段降级
- `AgentToolResult` 结构是 Pi SDK 硬约束（`{content, details}`），adapter 必须遵守
- subagent 内部仍使用 child_process.spawn（Pi 已知例外），不在本次范围

## 业务用例

### UC-1: fire-and-forget 后续取消
- **Actor**: 主 agent
- **场景**: 启动一个 background subagent 做长任务，几轮后发现方向错了
- **预期结果**: agent 调 `action:"list"` 看到 running，调 `action:"cancel"` 取消，资源释放

### UC-2: 并行 fan-out 进度监控
- **Actor**: 主 agent
- **场景**: 启动 3 个 background subagent 并行调研，想看谁先完成
- **预期结果**: agent 调 `action:"list"` 看到 3 条 running + 各自 sessionFile，按需 read jsonl 看详情，不锁页面

### UC-3: 同步执行拿结构化结果
- **Actor**: 主 agent
- **场景**: 需要一个子任务的结果才能继续，用 sync 模式
- **预期结果**: `action:"start"` + `wait:true`，返回 `syncResponse`（含完整 result + sessionFile），agent 直接用

## Decisions

详见 [clarification.md](./clarification.md)。核心决策：
- D1 spinner 用 mode 修复（非 backgroundId）
- D2 tool action 化（start/list/cancel）
- D3 内部 handler 路由 + adapter 适配（解耦出参）
- D4 出参结构化（外层 subagentId/sessionFile + 内层分组）
- D5 废弃 poll（详情看 jsonl）
- D6 cancel 复用现成 service.cancel
- D7 list 默认 running + includeFinished + limit
- D8 command 精简（删 config wizard + format-helpers）
- D9 sessionFile 提前填充
- D10 followUp 保留原逻辑
- D11 details 纯分组 + 重写 renderResult（方案 B）
