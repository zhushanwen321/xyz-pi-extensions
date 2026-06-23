# Clarification — Subagent Tool Action Refactor

交互澄清记录。spec.md 的决策依据。

## 问题溯源

**起因**：background 模式 subagent 被 AI 轮询（poll）后，页面锁死在底部无法鼠标滚动。

**根因**（代码已验证）：`SubagentResultComponent.maybeToggleSpinner`（`tui/tool-render.ts:236`）用 `details.backgroundId !== undefined` 判断「是否启动 spinner 定时器」。但 poll 路径返回的 `QueryResult`（`types.ts:205`）**没有 backgroundId 字段**，导致：
1. poll 一个 running record → spinner `setInterval(200ms)` 被错误启动
2. poll 的 tool block 一次性（execute return 后无 onUpdate）→ terminal 分支的 `clearInterval` 永不触发
3. 定时器永久泄漏，每 200ms invalidate → viewport 钉底部 → 锁死

## 决策记录

### D1: spinner 修复用 mode 字段（长期方案）

判断信号从 `backgroundId`（只能识别启动占位）改为 `mode === "sync"`（覆盖启动占位 + poll 两类一次性 block）。

改动：
- `SubagentToolDetails` 加 `mode` 字段
- `project()` 返回时带上 mode（`execution-record.ts:390`）
- `maybeToggleSpinner` 改用 `mode === "sync"` 判断

否决方案：poll details 补 backgroundId（短期）—— 与 poll 废弃方向冲突。

### D2: tool action 化 — start/list/cancel

废弃参数重载（有 task / 有 backgroundId / 都无），改用显式 action + 分组参数。

入参结构：
```
action: "start" | "list" | "cancel"
startParam:  { task, agent?, wait?, model?, thinkingLevel?, skillPath?, appendSystemPrompt?, schema?, maxTurns?, graceTurns? }
listParam:   { includeFinished?: boolean, limit?: number }
cancelParam: { subagentId: string }
```

参考：workflow extension 已用 `StringEnum` action（`workflow/src/index.ts:38`），typebox 嵌套 Object 原生支持。

### D3: 内部 handler 路由 + adapter 适配出参

解耦模式（已存入 user-memory 技术偏好）：
1. 入口 `switch(action)` 路由到 3 个内部 handler
2. 每个 handler 返回纯领域对象（不碰 `{content, details}`，互不耦合）
3. 唯一 adapter 把领域对象包成 `{content: [{text: JSON.stringify(领域对象)}], details: 领域对象 + action}`

- content（JSON 字符串）→ LLM 看（function calling 标准）
- details（领域对象 + action）→ TUI renderResult 看
- 两套同源同处生成，非冗余

### D4: 出参结构化

```typescript
// 最外层（所有 action）
{ subagentId: string | null, sessionFile: string | null,
  // 内层按 action 四选一
  syncResponse?:   { status, agent, model, turns, totalTokens, elapsedSeconds, eventLog, currentActivity?, result?, error?, parsedOutput? }
  bgResponse?:     { status, message }
  listResponse?:   { running: number, items: [{ subagentId, agent, status, duration, model, totalTokens, sessionFile }] }
  cancelResponse?: { cancelled: boolean }
}
```

- sync/bg/cancel 单 record → 最外层 subagentId/sessionFile 有值
- list 多 record → 最外层为 null，sessionFile 在每个 item 内部

### D5: 废弃 poll

- 删 `service.query()` + `QueryResult` 类型 + `recordToQueryResult` 私有方法
- 删 `subagent-tool.ts` 的 poll 分支
- 删 `SubagentParams.backgroundId` 字段 + `SubagentToolDetails.backgroundId` 字段
- 删 `subagent-service.ts:31` 的 `QueryResult` import
- **详情查看方式**：agent 通过 `action:"list"` 拿到 `sessionFile` 路径后，直接用 `read` tool 读 jsonl（已验证：Pi session jsonl 是 append-only 实时 flush，格式标准 JSONL，AI 可解析）

### D6: cancel 入口（三处一致修复）

追踪发现 `service.cancel` 对 sync running record 存在真 bug：sync 的 controller 是 undefined（sync 不建 controller），`abort()` 是 no-op，但 `tryTransition(running→cancelled)` 会成功，导致正在 await 的 sync record 被标记 cancelled 并误发 followUp，session 跑完后状态彻底混乱。

三处一致修复：
1. **cancel 检测 mode**：`action:"cancel"` 检测 `record.mode !== "background"` 时 throw（sync record 不可 cancel）
2. **类型收敛**：`cancelResponse.cancelled` 改为 `true` 字面量类型（失败一律 throw，false 是死值）
3. **list item 显式带 mode**：让 AI 知道哪些可 cancel

复用现成 `service.cancel(id)`，但 service 层需区分错误：
- id 不存在（`getMutable` 返回 undefined）→ throw `No subagent record with id "..."`
- record.mode !== background → throw `Cannot cancel sync subagent (only background can be cancelled)`
- 已终态（`tryTransition` 失败，service.cancel 返回 false）→ throw `Subagent {id} already finished (status: done/failed/cancelled)`

### D7: list 默认范围与字段

- 默认仅 running record（`collectRecords` 过滤 status==="running"，含 sync + background，item 带 mode 区分）
- `includeFinished: true` → 查全部（含已结束）
- `limit` 默认 20，夹紧 `Math.max(1, Math.min(limit ?? 20, 100))`
- item 字段（8 个）：subagentId, agent, status, mode, duration（秒）, model, totalTokens, sessionFile
- 排序：默认 `startedAt desc`（最新在前）；`includeFinished:true` 时 running 优先 + startedAt desc

### D8: command 精简 — /subagents = list

- 删 config wizard 分支 + 摘要分支
- 死代码清理：`tui/config-wizard.ts`（253 行）、`tui/format-helpers.ts`（37 行），仅 commands 引用，无测试
- 连带清理：`config.ts:saveGlobalConfig` + `model-config-service.ts:saveGlobalConfig`（仅 config-wizard 调用，变死代码）
- `/subagents` 等同原 `/subagents list [<id>]`

### D9: sessionFile 回填（接受窗口期）

追踪发现「record 创建后立即填」时序不可能：session 在 `run()` 内部 `createAndConfigureSession`（`session-runner.ts:255`）才创建，record 在 `service.execute` 的 `createRecordForMode` 创建并 `store.register` 进入 live map（立即可被 list 看到）。两者间存在窗口期：record 可见但 sessionFile 未生成。

**窗口期**：record 注册（list 可见）→ session 创建成功（sessionFile 回填）之间的时间差。
- pool 有空位（< maxConcurrent）：极短（createAndConfigureSession 异步开销 + 首次 getSdk IO），几十~几百毫秒
- pool 满（已 maxConcurrent 个 background 在跑）：可能几秒~几十秒（等前面释放 slot）

**方案：接受窗口期 undefined**。
- `ExecutionRecord` + `RecordSnapshot` 新增 `sessionFile?: string` 字段
- `run()` 内 `createAndConfigureSession` 成功后回填 `record.sessionFile`（session-factory.ts:236 已有值）
- list item 的 `sessionFile` 可选，窗口期内为 undefined
- `project()` / `recordToSubagent` / `toPersisted` 输出新字段
- AI 遇 sessionFile=undefined 稍后重试 list 即可

否决方案：「session 建好前藏住 record」（破坏 list/cancel 可见性）、「预创建空 jsonl 占位」（语义错乱）。

### D10: followUp 保留原逻辑

background 完成通知（`notifier.ts:148` `pi.sendMessage` + `deliverAs:"followUp"`）不变。content 仍给完整 result。

理由：followUp 是「完成时自动唤醒父 agent」的核心机制，与「列表访问」正交。废 poll 不影响 followUp。

### D11: details 纯分组 + 重写 renderResult（方案 B）

否决双层冗余（A，违反单数据源）。

`SubagentToolDetails` 重组为分组结构（D4），`renderResult` 按 action 分支渲染：
- start → 复用现有 spinner/eventLog 逻辑（从 syncResponse/bgResponse 取字段）
- list → 表格渲染
- cancel → 确认行

**sync streaming 的 onUpdate 回流也走 adapter**（details 分组化），与 renderResult 同源。

### D12: 其余 gap 处理（Round 1 中低优先级）

| Gap | 处理 |
|-----|------|
| G-007 action 与多余 param（如 start 传了 listParam） | 静默忽略（YAGNI，LLM 可能多传） |
| G-008 task 校验 | 加 `.trim()`，空/纯空白 → throw |
| G-012 bgResponse TUI 文案 | 改「detached, will notify on completion」 |
| G-013 session 创建失败的 sessionFile | sessionFile=undefined，list item 保留（status=failed） |
| G-015 content JSON 嵌套 parsedOutput | 可接受，parsedOutput 作为嵌套 JSON 值 |
| G-016 followUp content 风格 | 保持自然语言（通知语义 ≠ tool result，两种风格并存可接受） |
| G-020 测试 | 补 AC：删 query 测试、改 details/project 测试、新增 action 路由测试 |

## 关键事实（代码已验证）

| 事实 | 位置 |
|------|------|
| `AgentResult.text` = 最后一条 assistant message 的 text（即「最后一个 turn 的 output-text」） | `output-collector.ts:78-101` |
| eventLog ring buffer 上限 20 条，每条 label ≤100 字符 | `execution-record.ts:29,34` |
| `service.cancel(id): boolean` 已存在 | `subagent-service.ts:208` |
| `collectRecords` merge 四源（live/completed/bg/history） | `record-store.ts:123` |
| `SubagentRecord` 含 list 所需全字段（除 duration，有 startedAt/endedAt 可算） | `types.ts:230` |
| sessionFile 字段已在 SubagentRecord + PersistedAgentRecord | `types.ts:230,255` |
| config-wizard + format-helpers 无测试、仅 commands 引用 | grep 确认 |
| followUp 注入 content 进 LLM，details 给 TUI | `notifier.ts:51-52` |
| `AgentToolResult = {content: [{type:"text",text}], details: T}` | `shared/types/mariozechner/index.d.ts:85` |
| typebox StringEnum + 嵌套 Object 可用 | `workflow/src/index.ts:38` |
