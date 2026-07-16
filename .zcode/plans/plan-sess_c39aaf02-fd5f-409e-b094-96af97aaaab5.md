# pi-subagent-workflow: slug 字段 + 废弃标记

## 任务总览

两件事：
1. **文档**：README + AGENTS.md 标记 `pi-subagents` / `pi-workflow` 已废弃
2. **功能**：subagent 和 workflow 创建时增加必填 `slug`（≤20 字符，简述用途），TUI 渲染时展示

## 一、废弃标记（文档）

### 1. 根 `README.md`
- 自研扩展表把 `workflow` 行改为 `subagent-workflow`（合并包），`workflow` 标记 ⚠️ deprecated
- 新增 `subagent-workflow` 行
- 第三方推荐插件表的 `pi-subagents` 行标注「已被 `@zhushanwen/pi-subagent-workflow` 取代」

### 2. 根 `AGENTS.md`
- 目录结构里 `workflow/` 和 `subagents/` 的 deprecated 标记**已存在**（line 24, 29），无需改动
- 包清单表（line 784, 789）的 deprecated 标记**已存在**，无需改动
- 结论：AGENTS.md 无需修改

### 3. `extensions/workflow/README.md`
- 顶部加废弃横幅：`> ⚠️ DEPRECATED — superseded by @zhushanwen/pi-subagent-workflow (ADR-030)。新项目请用 pi-subagent-workflow。`

### 4. `extensions/subagents/` 无 README，跳过

---

## 二、slug 字段 — 数据模型设计

**语义**：slug 是人类可读的短标签（≤20 字符），简述本次 subagent/workflow run「在做什么」。区别于：
- `agent`（agent 类型名，如 worker/researcher）
- `task`（完整 prompt，可能很长）
- `scriptName`（workflow 脚本身份名）

**持久化兼容**：旧 session.jsonl 的 record/run 无 slug 字段 → 反序列化兜底空串 `""`，渲染时空串不显示 slug 段。

---

## 三、Subagent slug 链路（全链路穿透）

### 3.1 类型层（`src/execution/types.ts`）

| 类型 | 改动 |
|------|------|
| `ExecuteOptions` | 加 `slug: string`（必填，调用方必须传） |
| `ExecutionRecord` | 加 `readonly slug: string`（身份字段，创建时确定不可变） |
| `SubagentToolDetails` | 加 `slug: string` |
| `SubagentListItem` | 加 `slug: string` |
| `SubagentRecord` | 加 `slug: string` |
| `RecordSnapshot` | 加 `readonly slug: string` |

### 3.2 Record 创建 + 投影（`src/execution/execution-record.ts`）

- `createRecord` 的 `identity` 入参加 `slug: string`
- 创建的 record 对象加 `slug: identity.slug`
- `project()` 返回加 `slug: record.slug`
- `snapshot()` 返回加 `slug: record.slug`

### 3.3 Service 层（`src/execution/subagent-service.ts`）

- `createRecordForMode` 调 `createRecord` 时传 `slug: opts.slug`
- `resolveIdentity` 返回值不变（slug 不从 agentConfig 来，直接从 opts 透传）

### 3.4 Tool 参数 schema（`src/interface/subagent-tool.ts`）

`SubagentParams.startParam` 新增必填字段：
```typescript
slug: Type.String({
  description: "Short label (≤20 chars) describing what this subagent does. Shown in TUI. Required.",
  maxLength: 20,
})
```
`StartParam` interface 同步加 `slug: string`。

### 3.5 Handler 层（`src/interface/subagent-actions.ts`）

- `StartHandlerInput` 加 `slug?: string`
- `startHandler` 校验：`slug` 必填且 trim 后非空（与 task 同样的空白校验），然后透传 `slug: input.slug` 到 `service.execute()`
- `recordToListItem`（`subagent-actions.ts:107`）加 `slug: r.slug`
- `adapter` 的 `buildGuiComponent`（start 分支）的 subagent-trace 加 slug 字段

### 3.6 持久化兼容（`src/execution/session-runner.ts` + `session-reconstructor.ts`）

**写入**（`session-runner.ts:665`）：
- `SubagentIdentityData` 加 `slug: string`
- identity 对象加 `slug: record.slug`

**读取**（`session-reconstructor.ts`）：
- `SubagentIdentityData` 加 `slug?: string`（可选，旧文件兼容）
- `ReconstructedRecord` 加 `slug: string`
- `isIdentityData` **不**校验 slug（旧文件通过校验）
- `reconstructFromFile` 返回处：`slug: identity.slug ?? ""`（兜底空串）
- `...identity` 展开后显式覆盖 `slug`（与 rootSessionId 的兜底模式一致）

### 3.7 RecordStore 投影（`src/execution/record-store.ts`）

- `recordToSubagent`（line 326）加 `slug: r.slug`

### 3.8 Subagent tool 测试更新

- `execute-options-mapper.test.ts` / `subagent-service.test.ts` 等凡构造 `ExecuteOptions` 的测试，补 `slug`
- `session-reconstructor.test.ts` 加旧文件（无 slug）兜底空串的用例

---

## 四、Workflow slug 链路

### 4.1 关键发现：workflow 内 agent() 的 slug 来源已存在

`AgentCallOpts.description`（`orchestration/models/types.ts:106`，注释"Human-readable description for logging"）目前被 `execute-options-mapper.ts:30` 丢弃。这是 workflow 内每个 agent() 调用的天然 slug 来源。

**改动**：`mapToExecuteOptions` 把 `opts.description` 映射到 `ExecuteOptions.slug`（不再丢弃）。

这样 workflow 脚本里 `agent({ prompt, description: "extract-url" })` 的 description 自动成为该 subagent 的 slug，无需 workflow 脚本作者改写法。

### 4.2 Workflow run 顶层 slug（RunSpec）

`RunSpec`（`orchestration/models/run-spec.ts`）新增：
```typescript
/** Run 级简短标签（≤20 字符），区别于 scriptName（脚本身份名）。旧持久化 run 缺失时为 undefined。 */
readonly slug?: string;
```
设为可选（旧 run 兼容，JSON 反序列化时缺失 → undefined）。

### 4.3 Workflow tool 参数（`src/interface/tool-workflow.ts`）

`WorkflowParams` 的 run action 参数新增可选 `slug`：
```typescript
slug: Type.Optional(Type.String({
  description: "Short label (≤20 chars) for this run. Shown in TUI. If omitted, defaults to script name.",
  maxLength: 20,
})),
```
`actionRun` 把 `params.slug` 传入 `runWorkflow` 的 RunSpec。

> **设计决策**：workflow run 的 slug 设为**可选**（默认回落 scriptName），因为 workflow 已有 scriptName 作为标识，slug 是锦上添花。而 subagent 的 slug 设为**必填**，因为 subagent 除 agent 类型名外没有任何人类可读标识。

### 4.4 持久化兼容（`src/orchestration/jsonl-run-store.ts`）

- `RunSnapshot.spec` 直接 JSON 序列化/反序列化，`deserializeRun` 把 `snapshot.spec` 原样传给 `WorkflowRun.reconstruct`
- RunSpec.slug 可选 → 旧 run 读出 undefined，无需特殊兜底代码

### 4.5 Workflow 内嵌套 workflow()

`launcher.ts` 的 `executeNestedWorkflow` 构造子 RunSpec 时，透传 slug（若有）。

---

## 五、TUI 渲染

### 5.1 ASCII Demo — 目标形态

**Subagent 对话流 block（renderCall 标题行）**：
```
subagent worker · extract-github-url (zai/glm-5.2 · thinking high)
  校验以下 chain 输出是否完整...
```
slug 用 accent 色显示在 agent 名后（`·` 分隔）。

**Subagent list（/subagents 命令，左列）**：
```
╭─ Subagents ──────────────────────────────────────╮
│ → ● bg-f6f731-1 worker · extract-github-url bg 12s │
│   ✓ bg-f6f731-2 researcher · scan-docs bg 45s      │
│   ✗ bg-f6f731-3 oracle · validate-config bg 8s     │
╰───────────────────────────────────────────────────╯
```
slug 显示在 agent 名后（`·` 分隔），空 slug 时整个 `· slug` 段省略。

**Subagent list（内联 tool result，compact）**：
```
● background: bg-f6f731-1 · extract-github-url · running detached · will notify on completion
```

**Workflow run（/workflows 视图 header）**：
```
╭───────────────────────────────────────────────────╮
│ daily-sync · migrate-user-tables                   │
│ Cron daily data sync ─── ● running · 2/3 agents · 1m12s · 12k/50k tok · $0.0231 │
├───────────────────────────────────────────────────┤
```
第一行：scriptName（bold）`·` slug（dim）。slug 缺失时只显 scriptName。

### 5.2 渲染实现改动点

| 文件 | 改动 |
|------|------|
| `src/interface/tool-render.ts` `renderSubagentCall` | 标题行 agent 后追加 ` · {slug}`（slug 非空时） |
| `src/interface/tool-render.ts` `buildCompactLines` (start 分支) | background 行追加 slug |
| `src/interface/tool-render.ts` `renderListCompact` | 每个 item 行追加 `· {slug}` |
| `src/interface/list-component.ts` `renderLeftColumn` | 左列每行 agent 后追加 slug |
| `src/interface/views/WorkflowsView.ts` `renderHeader` | nameLine 追加 ` · {slug}` |

slug 渲染统一规则：`slug` 非空（trim 后 length>0）才显示，用 ` · ` 分隔，颜色用 `accent`（与 agent 同色，保持视觉权重）或 `dim`（次要信息）。建议 **accent**——slug 是人类主动起的标签，比 agent 类型名更有信息量。

---

## 六、实现顺序

1. **类型层**：`types.ts` 加 slug 到 6 个类型
2. **Core**：`execution-record.ts` 的 createRecord/project/snapshot
3. **持久化**：session-runner 写入 + reconstructor 兜底
4. **Service**：subagent-service 透传 + record-store 投影
5. **Tool schema**：subagent-tool.ts 加必填 slug + startHandler 校验
6. **Workflow mapper**：execute-options-mapper 透传 description→slug
7. **Workflow run slug**：RunSpec + tool-workflow.ts + WorkflowsView
8. **渲染**：tool-render + list-component + WorkflowsView header
9. **文档**：README + workflow/README.md 废弃标记
10. **测试**：补全受影响测试 + 兼容性用例

## 七、影响范围

约 15 个文件。核心风险点：
- `ExecuteOptions.slug` 必填会导致所有构造该类型的地方编译报错（包括测试）——这是有意为之，强制全链路覆盖
- 持久化向后兼容靠「读取兜底空串 + isIdentityData 不校验 slug」双保险

## 八、不做的事

- 不改 `AgentCallOpts` 加新字段（复用已有 description）
- 不给 workflow tool 的 run action slug 加必填约束（可选，默认 scriptName）
- 不改 GUI `__gui__` 协议的 RenderDescriptor（那是已废弃的旧协议；workflow/subagent 走新的 `__gui__` 字段，slug 附加到现有 guiComponent data 即可）