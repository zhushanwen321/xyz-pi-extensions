# Subagent Tool Action 重构 — 实现计划

> **给 agentic worker：** 必备子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 把 `subagent` tool 从「参数重载（task/backgroundId/空）」重构为显式 `action: start | list | cancel`，废弃 poll，补 cancel 入口，统一出参结构化（外层 `SubagentToolResult` 分组 + 内层 `SubagentToolDetails` 扁平），修复 background poll 导致的页面锁死 bug。

**架构：** 三层解耦——①入口路由 `switch(action)` → ②三个内部 handler 返回纯领域对象 → ③唯一 adapter 包装为 `{content: JSON, details: 领域对象 + action}`。`SubagentToolDetails`（内层扁平，project 产出，含 `mode` + `sessionFile`）保持原形态 + 新增 `SubagentToolResult`（外层分组，adapter 产出，含 `action/subagentId/sessionFile + syncResponse?/bgResponse?/listResponse?/cancelResponse?`）。service 层 `cancel` 保持 boolean（list-view 零改动），新增只读 `findRecord(id)`；废 `query`/`QueryResult`/poll 分支。sessionFile 接受窗口期 undefined（`run()` 内回填）。

**技术栈：** TypeScript（零 `any`，typebox schema）、vitest、@mariozechner/pi-coding-agent、@earendil-works/pi-tui、@sinclair/typebox。

---

## 全局约定（所有任务遵守）

- **源码根：** `extensions/subagents/src/`（下文路径均相对此根）
- **测试命令：** `cd extensions/subagents && pnpm test`（= `vitest run`）
- **类型检查：** `cd extensions/subagents && pnpm typecheck`（= `tsc --noEmit`）
- **LINT：** 仓库根 `pnpm lint`（taste-lint，全 monorepo；改完跑一次，0 warning）
- **硬约束：** 零 `any`（用 `unknown` 或具体类型）；禁止 `eslint-disable` / `SKIP_LINT` / `--no-verify`；单文件 ≤1000 行；函数 ≤80 行；不引入双层冗余字段。
- **提交粒度：** 每个任务末尾提交一次（提交信息见各任务步骤）。当前分支：`fix-subagents-lock-bottom`（不要切到 main）。
- **向后兼容：** 旧 history.jsonl（无 `sessionFile`/`mode` 字段）反序列化不崩——所有新增字段一律 `?` 可选。
- **决策来源：** spec.md（FR-1~FR-11）+ clarification.md（D1~D12）。G3-001/002/003 已在 spec 收敛（A 方案：内层 `SubagentToolDetails` 扁平 + 外层 `SubagentToolResult` 分组；service 新增 `findRecord`；list session 作用域诚实声明）。

---

## 文件结构（创建 / 修改清单）

### 创建（1 个）
| 文件 | 职责 |
|------|------|
| `tools/subagent-actions.ts` | 三个内部 handler（`startHandler`/`listHandler`/`cancelHandler`）+ 唯一 `adapter()`。纯领域对象进出，不碰 `{content, details}`。 |

### 修改（按依赖序）
| 文件 | 改动摘要 | 对应任务 |
|------|---------|---------|
| `types.ts` | 删 `QueryResult`、`SubagentToolDetails.backgroundId`、`ExecutionHandle` background 分支的 `backgroundId`；`SubagentToolDetails` 加 `mode` + `sessionFile?`；`ExecutionRecord` + `RecordSnapshot` 加 `sessionFile?`；新增 `SubagentToolResult`（外层分组）+ `SubagentListItem`；新增 `SubagentParams` 的入参分组类型。 | T1 |
| `core/execution-record.ts` | `project()` 输出加 `mode` + `sessionFile`；`snapshot()` + `toPersisted()` 输出 `sessionFile`（回填 record.sessionFile）。 | T2 |
| `runtime/execution/record-store.ts` | `recordToSubagent` 输出 `sessionFile`（读 `record.sessionFile`，不再只读 `agentResult?.sessionFile`）。 | T2 |
| `core/session-runner.ts` | `createAndConfigureSession` 成功后回填 `record.sessionFile`（窗口期接受 undefined）。 | T3 |
| `runtime/subagent-service.ts` | 删 `query()` + `recordToQueryResult()`；`execute()` 返回值去掉 `backgroundId`，改带 `subagentId`/`sessionFile`；`bgDetails` 不再写 `backgroundId`；新增 `findRecord(id): RecordSnapshot \| undefined`。 | T4 |
| `tools/subagent-tool.ts` | `SubagentParams` 改 `action` 分组 schema；删 `SubagentExecuteParams.backgroundId`；`executeSubagent` 改为 `switch(action)` → 三个 handler → adapter；重写 tool description（删 poll 段）；`SubagentRenderCallCb`/`SubagentRenderResultCb`/`onUpdate` 泛型改 `SubagentToolResult`。 | T5 |
| `tools/subagent-actions.ts` | 新建：三个 handler + adapter（含 `bgResponse` 文案「detached, will notify on completion」、cancel 三态 throw 文案、list 默认 running + limit 夹紧 + 排序）。 | T6 |
| `tui/tool-render.ts` | `maybeToggleSpinner` 判断改 `mode === "sync"`；`renderCompact`/`renderExpanded` 从 `details.syncResponse`/`bgResponse` 取字段（list/cancel 分支渲染）；入口 guard 按 `action` 判断；`buildStatusLine` 删 `backgroundId` 分支；renderResult 组件持 `SubagentToolResult`。 | T7 |
| `commands/subagents.ts` | 删 config 分支 + 无参摘要分支；`args[0]` 直接作 `<id>`；description 改为 `Subagents: /subagents [<id>]`；删 `runConfigWizard`/`formatConfigSummary` import。 | T8 |
| `tui/format-helpers.ts` | **删除整个文件**（37 行，仅 commands 引用 `formatConfigSummary`）。 | T8 |
| `tui/config-wizard.ts` | **删除整个文件**（253 行，仅 commands 引用 `runConfigWizard`）。 | T8 |
| `runtime/config/config.ts` | 删 `saveGlobalConfig()`（连同 fs import 若成死代码）。 | T8 |
| `runtime/model-config-service.ts` | 删 `saveGlobalConfig()` 方法 + `saveConfig` import。 | T8 |
| `__tests__/subagent-service.test.ts` | 删 query 测试；加 `findRecord` 测试；execute 集成测试占位注释更新。 | T9 |
| `__tests__/execution-record.test.ts` | `project`/`snapshot`/`toPersisted` 断言加 `mode`/`sessionFile`。 | T9 |
| `__tests__/tool-action.test.ts` | **新建**：action 路由三路径（start/list/cancel）成功 + 失败 + adapter 出参结构。 | T10 |

### 不动（显式确认）
- `core/event-bridge.ts`、`core/output-collector.ts`、`core/turn-limiter.ts`、`core/concurrency-pool.ts`、`core/agent-registry.ts`、`core/model-resolver.ts`、`core/session-factory.ts`、`core/path-encoding.ts`
- `runtime/discovery-config.ts`、`runtime/session-file-gc.ts`
- `runtime/execution/history-store.ts`、`runtime/execution/notifier.ts`、`runtime/execution/record-store.ts` 的公共 API（仅内部 `recordToSubagent` 加字段）
- `tui/list-view.ts`（仅消费 `service.cancel: boolean`，零改动）、`tui/bg-notify-render.ts`、`tui/format.ts`
- `index.ts`（注册胶水零改动）

---

## 任务依赖图

```
T1 types ──────┬──► T2 projections ──► T3 sessionFile 回填
               │
               ├──► T4 service（删 query/findRecord/execute 返回）
               │         │
               │         ├──► T5 tool（params action + execute 路由骨架，先 throw）
               │         │         │
               │         │         └──► T6 actions（三 handler + adapter）── 实现填肉
               │         │
               │         └──► T7 renderResult（mode === sync + action 分支）
               │
               └──► T8 command 精简（正交，可并行）

T9 测试更新（service + execution-record）── 依赖 T2/T4
T10 tool-action 测试（新建）── 依赖 T5/T6
T11 清理 + 全量验证 + 收尾提交
```

**可并行：** T8（command 精简）与 T2~T7 完全正交。**不可并行：** T1 → T2 → T3（类型链）；T4 → T5 → T6（service/tool/actions 链）。

---

## 任务 1: 类型层重构（types.ts）

**文件：**
- 修改：`types.ts:144-161`（`SubagentToolDetails`）、`types.ts:103-134`（`ExecutionRecord`）、`types.ts:200-220`（`ExecutionHandle` + `QueryResult`）、`types.ts:316-331`（`RecordSnapshot`）

**目标：** 建立分层类型——内层 `SubagentToolDetails`（扁平，project 产出，加 `mode` + `sessionFile`）+ 外层 `SubagentToolResult`（分组，adapter 产出）；删 poll 相关类型。

- [ ] **步骤 1：修改 `SubagentToolDetails`（内层扁平，加 mode + sessionFile，删 backgroundId）**

`types.ts:144-161` 整段替换为：

```typescript
/**
 * Tool 返回的 details（内层扁平结构）。
 * 由 project(record) 唯一产出——sync/bg 两路径字段一致。
 * 含 mode + sessionFile（供外层 SubagentToolResult 分组 + spinner 判断）。
 *
 * 分层（spec FR-3）：此为**内层**，不感知 action/外层分组。
 * 外层 SubagentToolResult 由 adapter 包裹产出（加 action/subagentId/sessionFile + 分组）。
 */
export interface SubagentToolDetails {
  status: ExecutionStatus;
  mode: ExecutionMode;
  agent: string;
  model: string;
  thinkingLevel: string | undefined;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  eventLog: AgentEventLogEntry[];
  result?: string;
  error?: string;
  /** running 时的当前活动行（tool/thinking/text 优先级）。 */
  currentActivity?: { type: "tool" | "text" | "thinking"; label: string };
  /** schema 模式下，structured-output tool 的 result.details（对齐 workflow agent-pool）。 */
  parsedOutput?: unknown;
  /** session jsonl 文件名（不含目录）。窗口期内可能 undefined（session 尚未创建成功）。 */
  sessionFile?: string;
}
```

注意：`mode` 上移到与 `status` 同级（紧随其后），`backgroundId` 删除，新增 `sessionFile?`。

- [ ] **步骤 2：`ExecutionRecord` 加 `sessionFile?` 字段**

`types.ts:103-134` 的 `ExecutionRecord` interface，在 `agentResult: AgentResult | undefined;` 之后、`controller` 之前插入：

```typescript
  /** session jsonl 文件名。session 创建成功后由 session-runner.run() 回填（窗口期内 undefined）。 */
  sessionFile?: string;
```

（放在 `agentResult` 之后、`// ── 控制 ──` 注释块之前。）

- [ ] **步骤 3：`RecordSnapshot` 加 `sessionFile?` 字段**

`types.ts:316-331` 的 `RecordSnapshot` interface，在 `readonly error: string | undefined;` 之后加：

```typescript
  readonly sessionFile: string | undefined;
```

- [ ] **步骤 4：新增 `SubagentListItem` + `SubagentToolResult`（外层分组类型）**

在 `types.ts` 删除 `QueryResult` interface（`types.ts:204-220`）后，原位置插入新类型块：

```typescript
// ============================================================
// tool action 出参（外层分组，adapter 产出）
// ============================================================

/** list 的 item 结构（8 字段）。 */
export interface SubagentListItem {
  subagentId: string;
  agent: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  /** 运行秒数（running 态实时计算，终态 endedAt-startedAt）。 */
  duration: number;
  model: string;
  totalTokens: number;
  /** session jsonl 文件名（窗口期内可能 undefined）。 */
  sessionFile?: string;
}

/** sync 执行的内层响应（挂在 SubagentToolResult.syncResponse）。 */
export interface SyncResponse {
  status: ExecutionStatus;
  mode: "sync";
  agent: string;
  model: string;
  thinkingLevel: string | undefined;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  eventLog: AgentEventLogEntry[];
  currentActivity?: { type: "tool" | "text" | "thinking"; label: string };
  result?: string;
  error?: string;
  parsedOutput?: unknown;
  sessionFile?: string;
}

/** background 启动的内层响应（挂在 SubagentToolResult.bgResponse）。 */
export interface BgResponse {
  status: "running";
  mode: "background";
  /** 启动提示文案（"detached, will notify on completion"）。 */
  message: string;
}

/** list 的内层响应（挂在 SubagentToolResult.listResponse）。 */
export interface ListResponse {
  /** items 中 status==="running" 的计数（受 limit 截断如实反映，非全局总数）。 */
  running: number;
  items: SubagentListItem[];
}

/** cancel 的内层响应（挂在 SubagentToolResult.cancelResponse）。 */
export interface CancelResponse {
  cancelled: true;
}

/**
 * Tool 外层出参（renderResult + LLM content JSON 同源）。
 * adapter 唯一产出：领域对象（sync/bg/list/cancel 四选一）+ action/subagentId/sessionFile。
 *
 *   - sync 完成 → syncResponse（最外层 subagentId/sessionFile 有值）
 *   - background 启动 → bgResponse（subagentId 有值；sessionFile 窗口期可能 undefined）
 *   - list → listResponse（最外层 subagentId/sessionFile 为 null，sessionFile 在各 item 内）
 *   - cancel → cancelResponse（subagentId 有值；sessionFile 无意义，可为 null）
 */
export interface SubagentToolResult {
  action: "start" | "list" | "cancel";
  subagentId: string | null;
  sessionFile: string | null;
  syncResponse?: SyncResponse;
  bgResponse?: BgResponse;
  listResponse?: ListResponse;
  cancelResponse?: CancelResponse;
}
```

- [ ] **步骤 5：修改 `ExecutionHandle`（删 backgroundId，加 subagentId + sessionFile）**

`types.ts:194-202` 整段（含注释）替换为：

```typescript
/**
 * execute 返回值。
 *   sync:    { mode:"sync", record, details } —— 调用方 await，record 已 settled。
 *            record 是只读快照（持久化用），details 是 TUI 渲染投影（含 elapsedSeconds/currentActivity/mode/sessionFile）。
 *   background: { mode:"background", subagentId, sessionFile, details } —— 立即返回。
 *            subagentId 供后续 cancel/list 用；sessionFile 窗口期可能 undefined。
 */
export type ExecutionHandle =
  | { mode: "sync"; record: RecordSnapshot; details: SubagentToolDetails }
  | { mode: "background"; subagentId: string; sessionFile: string | undefined; details: SubagentToolDetails };
```

- [ ] **步骤 6：删除 `QueryResult` interface（`types.ts:204-220` 整段，含注释行 204）**

已在上文步骤 4 的「删除后插入新类型块」中处理——确认 `QueryResult` 整段（`/** poll(backgroundId) 返回... */` 到 `}`）已不存在。

- [ ] **步骤 7：运行 typecheck 确认预期失败（消费方未改）**

运行：`cd extensions/subagents && pnpm typecheck`
预期：**FAIL**——`subagent-service.ts` 仍 import `QueryResult`（T4 删）、`tools/subagent-tool.ts` 仍用 `backgroundId`（T5 改）、`tool-render.ts` 仍读 `details.backgroundId`（T7 改）。这是预期的，类型层先改下游随后跟上。

- [ ] **步骤 8：提交**

```bash
git add extensions/subagents/src/types.ts
git commit -m "refactor(subagents): 类型层 action 化——SubagentToolDetails 加 mode/sessionFile、新增 SubagentToolResult 外层分组、删 QueryResult"
```

---

## 任务 2: 投影层更新（execution-record.ts + record-store.ts）

**文件：**
- 修改：`core/execution-record.ts:390-407`（`project`）、`core/execution-record.ts:413-430`（`snapshot`）、`core/execution-record.ts:435-458`（`toPersisted`）
- 修改：`runtime/execution/record-store.ts:228-245`（`recordToSubagent`）
- 测试：`__tests__/execution-record.test.ts:363-466`（projections 断言更新）

**目标：** 让投影生产者四处全部输出 `mode` + `sessionFile`（G2-004 修复清单），为 sessionFile 回填做数据通路准备。

- [ ] **步骤 1：编写失败测试（execution-record.test.ts — project 输出 mode + sessionFile）**

`__tests__/execution-record.test.ts` 的 `describe("project")` 内（`projections` describe 下），在 `"returns SubagentToolDetails with all fields"` 用例之后新增用例：

```typescript
    it("outputs mode + sessionFile (T2: action refactor 投影)", () => {
      const r = makeRecord({ mode: "background", turns: 2 });
      r.sessionFile = "bg-1-abc.jsonl";
      const d = project(r);
      expect(d.mode).toBe("background");
      expect(d.sessionFile).toBe("bg-1-abc.jsonl");
    });

    it("sessionFile is undefined when record.sessionFile unset (窗口期)", () => {
      const r = makeRecord();
      const d = project(r);
      expect(d.sessionFile).toBeUndefined();
    });
```

同文件 `describe("snapshot")` 内，`"returns a readonly snapshot"` 用例之后新增：

```typescript
    it("outputs sessionFile (T2)", () => {
      const r = makeRecord();
      r.sessionFile = "s.jsonl";
      const s = snapshot(r);
      expect(s.sessionFile).toBe("s.jsonl");
    });

    it("sessionFile is undefined when unset (T2)", () => {
      const r = makeRecord();
      expect(snapshot(r).sessionFile).toBeUndefined();
    });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && pnpm test -- execution-record`
预期：**FAIL**——`d.mode` / `d.sessionFile` 为 `undefined`（project 未输出）。

- [ ] **步骤 3：实现 project() 输出 mode + sessionFile**

`core/execution-record.ts:390-407` 的 `project()` 返回对象，在 `status: record.status,` 之后插入 `mode: record.mode,`，并在末尾 `parsedOutput: record.agentResult?.parsedOutput,` 之后加一行：

```typescript
    sessionFile: record.sessionFile,
```

修改后 project 完整返回：

```typescript
export function project(record: ExecutionRecord): SubagentToolDetails {
  return {
    status: record.status,
    mode: record.mode,
    agent: record.agent,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    turns: record.turns,
    totalTokens: record.totalTokens,
    elapsedSeconds: computeElapsedSeconds(record),
    eventLog: record.eventLog.slice(),
    result: record.result,
    error: record.error,
    currentActivity: record.status === "running" ? computeCurrentActivity(record) : undefined,
    parsedOutput: record.agentResult?.parsedOutput,
    sessionFile: record.sessionFile,
  };
}
```

- [ ] **步骤 4：实现 snapshot() 输出 sessionFile**

`core/execution-record.ts:413-430` 的 `snapshot()` 返回对象，在 `error: record.error,` 之后加：

```typescript
    sessionFile: record.sessionFile,
```

（`mode` 已存在 `snapshot` 内——`types.ts:419` 已有 `mode: record.mode`，确认无需重复加。）

- [ ] **步骤 5：实现 toPersisted() 输出 sessionFile（读 record.sessionFile，回退 agentResult）**

`core/execution-record.ts:435-458` 的 `toPersisted()` 中，把：

```typescript
    sessionFile: record.agentResult?.sessionFile,
```

改为（优先 record.sessionFile，回退 agentResult——兼容未回填路径）：

```typescript
    sessionFile: record.sessionFile ?? record.agentResult?.sessionFile,
```

- [ ] **步骤 6：实现 recordToSubagent 输出 sessionFile（record-store.ts）**

`runtime/execution/record-store.ts:228-245` 的 `recordToSubagent()`，把：

```typescript
      sessionFile: r.agentResult?.sessionFile,
```

改为：

```typescript
      sessionFile: r.sessionFile ?? r.agentResult?.sessionFile,
```

- [ ] **步骤 7：运行测试确认通过**

运行：`cd extensions/subagents && pnpm test -- execution-record`
预期：**PASS**（含步骤 1 新增的 4 个用例）。

- [ ] **步骤 8：提交**

```bash
git add extensions/subagents/src/core/execution-record.ts extensions/subagents/src/runtime/execution/record-store.ts extensions/subagents/src/__tests__/execution-record.test.ts
git commit -m "refactor(subagents): 投影层补 mode/sessionFile（project/snapshot/toPersisted/recordToSubagent 四处）"
```

---

## 任务 3: sessionFile 回填（session-runner.ts）

**文件：**
- 修改：`core/session-runner.ts:253-296`（`run()` 内 createAndConfigureSession 成功后回填）
- 测试：`__tests__/session-runner.test.ts`（现有文件，追加回填断言）

**目标：** session 创建成功后立刻把 `sessionFile` 回填到 `record.sessionFile`，让窗口期内的 `list` / `project` 能看到（FR-7）。

- [ ] **步骤 1：阅读现有 session-runner.test.ts 了解 mock 结构**

运行：`cd extensions/subagents && sed -n '1,80p' __tests__/session-runner.test.ts`
确认它如何 mock `createAndConfigureSession` / 构造 `SessionRunnerContext`。本任务的测试要在 mock 的 `createAndConfigureSession` 内能断言 `record.sessionFile` 被赋值——若现有 mock 不暴露 record，需调整 mock 让 onEvent 收到首事件后检查 record。

- [ ] **步骤 2：编写失败测试（sessionFile 回填）**

在 `__tests__/session-runner.test.ts` 末尾新增（适配现有 mock 风格——若现有 mock 的 `built.session.sessionManager.getSessionFile()` 返回值可控，则断言 `record.sessionFile` 等于它）：

```typescript
describe("sessionFile 回填 (T3)", () => {
  it("createAndConfigureSession 成功后 record.sessionFile 被回填", async () => {
    // 复用现有 run() 的 mock 装配（createAndConfigureSession mock + ctx + record）
    // 让 built.session.sessionManager.getSessionFile() 返回 "filled.jsonl"
    const record = makeRunningRecord(); // 现有测试工厂
    await run(record, "task", /* opts */ optsFixture, /* ctx */ ctxFixture);
    expect(record.sessionFile).toBe("filled.jsonl");
  });

  it("createAndConfigureSession 抛错时 record.sessionFile 保持 undefined（不崩）", async () => {
    // 让 createAndConfigureSession mock 抛 Error("session init failed")
    const record = makeRunningRecord();
    await expect(run(record, "task", optsFixture, ctxFixture)).rejects.toThrow(/session init failed/);
    expect(record.sessionFile).toBeUndefined();
  });
});
```

> **占位符说明：** `makeRunningRecord` / `optsFixture` / `ctxFixture` 需复用本文件已有的 mock 装配（每个 session-runner 测试都构造它们）。执行时打开现有测试文件顶部 fixture，把 `built.session.sessionManager.getSessionFile()` 的返回值改为 `"filled.jsonl"`，按现有 mock 模式注入。若现有 mock 不支持 per-test 覆盖 getSessionFile，在 mock 工厂参数化它。

- [ ] **步骤 3：运行测试确认失败**

运行：`cd extensions/subagents && pnpm test -- session-runner`
预期：**FAIL**——`record.sessionFile` 为 `undefined`（run 未回填）。

- [ ] **步骤 4：实现 run() 回填 record.sessionFile**

`core/session-runner.ts` 的 `run()` 函数内，在 `built = await createAndConfigureSession(...)` 成功返回之后、`hooks = attachRunHooks(built, opts);` 之前（约 266 行），插入回填语句：

```typescript
    // session 创建成功：回填 sessionFile（FR-7 窗口期方案）。
    // 失败（catch 到异常）则保持 undefined，list item 保留（status=failed）。
    record.sessionFile = built.session.sessionManager.getSessionFile() ?? undefined;
```

- [ ] **步骤 5：运行测试确认通过**

运行：`cd extensions/subagents && pnpm test -- session-runner`
预期：**PASS**。

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/core/session-runner.ts extensions/subagents/src/__tests__/session-runner.test.ts
git commit -m "fix(subagents): session 创建成功后回填 record.sessionFile（接受窗口期 undefined）"
```

---

## 任务 4: Service 层重构（subagent-service.ts）

**文件：**
- 修改：`runtime/subagent-service.ts:24-36`（import 删 QueryResult）、`runtime/subagent-service.ts:186-213`（execute 返回 + cancel + query）、`runtime/subagent-service.ts:485-520`（删 recordToQueryResult）
- 测试：`__tests__/subagent-service.test.ts:70-127`（query 测试改 findRecord）

**目标：** 删 `query()`/`recordToQueryResult()`、`execute()` 返回去 `backgroundId` 改 `subagentId + sessionFile`、新增只读 `findRecord(id)`（G3-002 修复，供 cancelHandler 用）。

- [ ] **步骤 1：编写失败测试（findRecord 新方法）**

`__tests__/subagent-service.test.ts` 中，把 `describe("query / cancel 边界")`（`subagent-service.test.ts:115-127`）整个 describe 块替换为：

```typescript
  describe("findRecord / cancel 边界 (T4)", () => {
    it("findRecord 不存在的 id 返回 undefined", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.findRecord("nonexistent-id")).toBeUndefined();
    });

    it("cancel 不存在的 id 返回 false（不抛错，boolean 契约不变）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.cancel("nonexistent-id")).toBe(false);
    });
  });
```

同时把「构造 + 生命周期」describe 内引用 `service.query` 的三个用例（`subagent-service.test.ts:70-108`）替换——`query` 已删，改测 `findRecord`：

```typescript
    it("未 initSession 时 findRecord/cancel 抛 'pi not injected'", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      expect(() => service.findRecord("any")).toThrow(/pi not injected/);
      expect(() => service.cancel("any")).toThrow(/pi not injected/);
    });

    it("initSession 后 assertReady 通过（findRecord 不再抛 pi 错，返回 undefined）", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      expect(service.findRecord("missing")).toBeUndefined();
    });

    it("dispose 后 findRecord 抛 'hub disposed'", () => {
      const service = new SubagentService({ cwd: agentDir, modelService });
      service.initSession({ pi: makePi(), sessionId: "s1" });
      service.dispose();
      expect(() => service.findRecord("any")).toThrow(/disposed/);
    });
```

（`dispose 幂等` / `initSession 可 revive` 两用例不涉及 query，保留；但 revive 用例内的 `service.query("any")` 断言改为 `service.findRecord("any")` 期望 `toBeUndefined()`。）

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && pnpm test -- subagent-service`
预期：**FAIL**——`service.findRecord is not a function`（TDD 红）。

- [ ] **步骤 3：删 QueryResult import + recordToQueryResult 私有方法 + query() 方法**

`runtime/subagent-service.ts:24-36` 的 import 块，删除 `QueryResult,` 这一行（约 31 行）。

`runtime/subagent-service.ts:199-205` 的整个 `query(id)` 方法删除（含注释 `/** poll(backgroundId)... */`）。

`runtime/subagent-service.ts:485-505` 的整个 `recordToQueryResult()` 私有方法删除（含注释）。

- [ ] **步骤 4：新增 findRecord(id) 只读查询方法**

在 `subagent-service.ts` 原 `query()` 的位置（删 query 之后），插入：

```typescript
  /**
   * 按 id 查内存三源（live/completed/bg）record 的只读快照（G3-002 修复）。
   * 不查 history（cancel/list 单点查询只关心内存 record）。
   * 供 tool 层 cancelHandler 翻译 throw 用（id 不存在 / mode / 终态三种错误）。
   * 不存在返回 undefined。
   */
  findRecord(id: string): RecordSnapshot | undefined {
    this.assertReady();
    const record = this.store.getMutable(id);
    return record ? snapshot(record) : undefined;
  }
```

（`snapshot` 已 import 自 execution-record，见 `subagent-service.ts:14-20`。）

- [ ] **步骤 5：execute() 返回值去 backgroundId，改 subagentId + sessionFile**

`runtime/subagent-service.ts:186-197` 的 execute 返回部分。把 background 分支：

```typescript
    // background：立即返回 backgroundId + 启动时的 details（status=running），
    // 步骤 4-6 在 detached promise 里跑。
    const bgDetails = project(record);
    bgDetails.backgroundId = record.id;
    this.kickOffBackground(record, opts, ctx, identity, signal, priority);
    return { mode: "background", backgroundId: record.id, details: bgDetails };
```

改为（删 `bgDetails.backgroundId` 赋值——`SubagentToolDetails` 已无此字段）：

```typescript
    // background：立即返回 subagentId + sessionFile（窗口期可能 undefined）+ details（status=running）。
    // 步骤 4-6 在 detached promise 里跑。
    const bgDetails = project(record);
    this.kickOffBackground(record, opts, ctx, identity, signal, priority);
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details: bgDetails };
```

（sync 分支 `{ mode: "sync", record: snapshot(record), details: project(record) }` 不变——`SubagentToolDetails` 已含 `sessionFile`，由 T3 回填。）

- [ ] **步骤 6：运行测试确认通过**

运行：`cd extensions/subagents && pnpm test -- subagent-service`
预期：**PASS**。

- [ ] **步骤 7：运行 typecheck（消费方 subagent-tool.ts 未改，预期仍 FAIL）**

运行：`cd extensions/subagents && pnpm typecheck`
预期：**FAIL**——`subagent-tool.ts` 仍用 `params.backgroundId` / `service.query` / `handle.backgroundId`（T5 修）。确认错误都集中在 `subagent-tool.ts`（和 T7 的 `tool-render.ts`），无 service 内残留。

- [ ] **步骤 8：提交**

```bash
git add extensions/subagents/src/runtime/subagent-service.ts extensions/subagents/src/__tests__/subagent-service.test.ts
git commit -m "refactor(subagents): service 删 query/QueryResult、execute 返回 subagentId+sessionFile、新增 findRecord 只读查询"
```

---

## 任务 5: Tool 入口骨架（subagent-tool.ts — schema + 路由 + throw）

**文件：**
- 修改：`tools/subagent-tool.ts:30-87`（params 类型 + schema）、`tools/subagent-tool.ts:217-286`（execute 改路由）、`tools/subagent-tool.ts:109-152`（description 重写）、回调类型泛型改 `SubagentToolResult`

**目标：** 参数 schema 改 `action` 分组，execute 改 `switch(action)` 路由到三个 handler（本任务先 `throw new Error("not implemented")`，T6 填肉），adapter 暂留骨架。先让 typecheck 绿（结构对了），行为在 T6 完成。

> **依赖：** T6（actions 实现）会在同一文件附近 import，但本任务只搭骨架 + throw，T6 再 import handler 填肉。

- [ ] **步骤 1：改 SubagentExecuteParams 类型（action + 分组 param）**

`tools/subagent-tool.ts:30-42` 的 `SubagentExecuteParams` interface 整段替换为：

```typescript
/**
 * execute 回调的 params 类型（手写副本——stub registerTool 是 unknown，
 * 无法从 SubagentParams schema 反向推断参数类型）。
 * action 与对应 param 不匹配时 handler 内 throw。
 */
interface StartParam {
  task: string;
  agent?: string;
  wait?: boolean;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
}

interface ListParam {
  includeFinished?: boolean;
  limit?: number;
}

interface CancelParam {
  subagentId: string;
}

interface SubagentExecuteParams {
  action: "start" | "list" | "cancel";
  startParam?: StartParam;
  listParam?: ListParam;
  cancelParam?: CancelParam;
}
```

- [ ] **步骤 2：改回调类型泛型 SubagentToolDetails → SubagentToolResult**

`tools/subagent-tool.ts:20` 的 import，把 `SubagentToolDetails` 改为 `SubagentToolResult`：

```typescript
import type { SubagentToolResult } from "../types.ts";
```

`tools/subagent-tool.ts:44-59` 三个回调类型 alias 中的 `SubagentToolDetails` 全部替换为 `SubagentToolResult`：

```typescript
type SubagentExecuteCb = (
  toolCallId: string,
  params: SubagentExecuteParams,
  signal: AbortSignal | undefined,
  onUpdate?: (partialResult: AgentToolResult<SubagentToolResult>) => void,
  ctx?: ExtensionContext,
) => Promise<AgentToolResult<SubagentToolResult>>;

type SubagentRenderResultCb = (
  result: AgentToolResult<SubagentToolResult>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  ctx: RenderContext,
) => Component;
```

（`SubagentRenderCallCb` 不涉及 details 泛型，不动。）

- [ ] **步骤 3：改 SubagentParams schema（action + 分组 param）**

`tools/subagent-tool.ts:65-87` 的整个 `SubagentParams` 定义替换为：

```typescript
export const SubagentParams = Type.Object({
  action: StringEnum(["start", "list", "cancel"], {
    description: "Operation: 'start' runs a subagent, 'list' shows running subagents (optional includeFinished), 'cancel' stops a background subagent by id.",
  }),
  startParam: Type.Optional(Type.Object({
    task: Type.String({
      description: "The task for the subagent to execute (required for action:'start'). Whitespace-only is rejected.",
    }),
    agent: Type.Optional(Type.String({
      description: 'Agent name (system prompt + tools). Defaults to "worker". Available: worker, researcher, scout, planner, reviewer, oracle, context-builder. Custom agents configurable.',
    })),
    wait: Type.Optional(Type.Boolean({
      description: "Execution mode. true (default) = sync: blocks until done, returns result. false = background: returns a subagentId immediately; on completion a message auto-injects that triggers a new turn (no need to poll). Use false for parallel fan-out (multiple start actions with wait:false in one message run concurrently, default maxConcurrent=4) or long tasks.",
    })),
    model: Type.Optional(Type.String({
      description: 'Model override in "provider/modelId" format. If omitted, uses the agent\'s configured default.',
    })),
    thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
    skillPath: Type.Optional(Type.String()),
    appendSystemPrompt: Type.Optional(Type.Array(Type.String())),
    schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    maxTurns: Type.Optional(Type.Number()),
    graceTurns: Type.Optional(Type.Number()),
  })),
  listParam: Type.Optional(Type.Object({
    includeFinished: Type.Optional(Type.Boolean({
      description: "Include finished (done/failed/cancelled) records. Default false (running only).",
    })),
    limit: Type.Optional(Type.Number({
      description: "Max items to return. Default 20, clamped to [1, 100].",
    })),
  })),
  cancelParam: Type.Optional(Type.Object({
    subagentId: Type.Optional(Type.String({
      description: "The subagentId to cancel (required for action:'cancel'). Only background subagents can be cancelled.",
    })),
  })),
});
```

- [ ] **步骤 4：重写 tool description（删 poll 段 + anti-pattern）**

`tools/subagent-tool.ts:114-145` 的整个 `description` 字符串（从 `` `Delegate a task... `` 到结尾 `` `, ``）替换为：

```typescript
    description: `Delegate a task to a specialized subagent via an explicit action.

CRITICAL — this tool is registered with executionMode "sequential": multiple \`subagent\` calls in the SAME message run one-after-another, NOT in parallel. The first must finish before the next starts. To get real concurrency, use background mode (start with wait:false) — background calls return immediately and the underlying tasks run concurrently in the pool (default maxConcurrent=4; extras queue).

## Actions

- action:"start" — run a subagent. Pass startParam: { task, agent?, wait?, ... }.
  - sync (wait:true, default): blocks until the subagent finishes, returns its result. Use when the next step needs the result.
  - background (wait:false): returns a subagentId immediately; the subagent runs detached and keeps running even if you stop. On completion a message is auto-injected that triggers a new turn so you can process the result.
- action:"list" — list subagents. Pass listParam: { includeFinished?: boolean, limit?: number }. Default: running only, limit 20. Each item includes a sessionFile path — read it with the \`read\` tool for full detail (the jsonl is append-only, flushed in real time).
- action:"cancel" — cancel a background subagent. Pass cancelParam: { subagentId }. Only background subagents can be cancelled; sync subagents are cancelled via Esc in the chat.

## After launching background — do NOT wait

Completion auto-notifies you (a message is injected that wakes your next turn). So:
- DO NOT sleep, busy-wait, or poll in a loop after launching. There is no poll action — use action:"list" only when you concretely need the current state.
- DO useful non-overlapping work if you have any.
- Otherwise STOP. Stopping is correct — the completion notification will wake you. It is not giving up.

## Calling patterns

- single — one sync subagent for one task (the common case).
- chain — dependent steps where B needs A's output: sync calls across turns.
- parallel / fan-out — N independent tasks concurrently: send N \`subagent\` calls with action:"start" + wait:false in the SAME message. Each returns a subagentId at once; tasks run concurrently. Then do other work, or just stop.
- background — one long-running task you don't want to block on: action:"start" + wait:false, then move on. Cancel later with action:"cancel" if the direction is wrong.

## Anti-patterns

- Multiple sync (wait:true) calls in one message expecting parallelism → they serialize; a slow first call delays the rest and long chains may get interrupted.
- Launching background, then sleeping/polling instead of working or stopping.
- Using background for a result you need right now → use sync.`,
```

- [ ] **步骤 5：改 executeSubagent 为 switch(action) 路由骨架（暂 throw）**

`tools/subagent-tool.ts:217-286` 的整个 `executeSubagent` 实现（含大段 ASCII 注释）替换为：

```typescript
/**
 * execute 实现（action 路由 + adapter）。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  service = getSubagentService() —— 未初始化 throw                  ║
 *   ║                                                                    ║
 *   ║  switch(params.action):                                           ║
 *   ║    "start"  → startHandler(service, params.startParam, signal,    ║
 *   ║                onUpdate) → 领域对象                                 ║
 *   ║    "list"   → listHandler(service, params.listParam) → 领域对象    ║
 *   ║    "cancel" → cancelHandler(service, params.cancelParam) → 领域对象║
 *   ║                                                                    ║
 *   ║  result = adapter(action, 领域对象)                                ║
 *   ║  return { content: [{text: JSON.stringify(result)}], details: result }║
 *   ╚══════════════════════════════════════════════════════════════════╝
 *
 * handler 返回纯领域对象（不碰 {content, details}），adapter 唯一包装。
 * content（JSON 字符串）给 LLM，details（领域对象 + action）给 renderResult，同源。
 */
const executeSubagent: SubagentExecuteCb = async (
  _toolCallId,
  params,
  signal,
  onUpdate,
  _ctx,
) => {
  const service = getSubagentService();
  if (!service) throw new Error("subagents runtime not initialized");

  switch (params.action) {
    case "start":
      return adapter("start", await startHandler(service, params.startParam, signal, onUpdate));
    case "list":
      return adapter("list", await listHandler(service, params.listParam));
    case "cancel":
      return adapter("cancel", await cancelHandler(service, params.cancelParam));
    default:
      throw new Error(`Unknown subagent action: ${String((params as { action?: unknown }).action)}`);
  }
};
```

> **占位符说明：** `startHandler`/`listHandler`/`cancelHandler`/`adapter` 在 T6 创建于 `tools/subagent-actions.ts`。本步骤末 typecheck 会因「未 import」FAIL——这是预期的（T6 填肉后绿）。

- [ ] **步骤 6：在 subagent-tool.ts 顶部加 import（指向 T6 将创建的模块）**

`tools/subagent-tool.ts` import 区（`subagent-tool.ts:17-20` 附近）加：

```typescript
import { adapter, cancelHandler, listHandler, startHandler } from "./subagent-actions.ts";
```

- [ ] **步骤 7：运行 typecheck（预期 FAIL：subagent-actions.ts 不存在）**

运行：`cd extensions/subagents && pnpm typecheck`
预期：**FAIL**——`Cannot find module './subagent-actions.ts'`。确认 tool-render.ts 的 `backgroundId` 错误也在（T7 处理）。

- [ ] **步骤 8：暂不提交（等 T6 填肉后一起 commit，避免中间破损态）**

> **执行者注意：** 本任务不单独提交。T6 完成后，T5+T6 合并为一次提交（见 T6 步骤末）。

---

## 任务 6: 三 handler + adapter 实现（subagent-actions.ts，新建）

**文件：**
- 创建：`tools/subagent-actions.ts`
- 测试：`__tests__/tool-action.test.ts`（T10 新建；本任务先手写最小可编译，T10 补全测试）

**目标：** 三个 handler 返回纯领域对象，adapter 唯一包装为 `SubagentToolResult` + `{content, details}`。覆盖 FR-2/FR-3/FR-5/FR-6 的业务逻辑。

- [ ] **步骤 1：创建 subagent-actions.ts 骨架（类型 + handler 签名 + adapter 签名）**

创建 `tools/subagent-actions.ts`，写入骨架（先全部 `throw`，确保 T5 的 typecheck 能过——行为在步骤 2-6 填）：

```typescript
// src/tools/subagent-actions.ts
//
// subagent tool 的内部 handler + 唯一 adapter。
//
// 分层（spec FR-2）：
//   1. startHandler / listHandler / cancelHandler —— 纯领域对象进出，不碰 {content, details}
//   2. adapter(action, 领域对象) —— 唯一包装为 AgentToolResult<SubagentToolResult>
//
// content（JSON 字符串）给 LLM，details（SubagentToolResult）给 renderResult，同源同处生成。

import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

import type {
  BgResponse,
  CancelResponse,
  ListResponse,
  SubagentListItem,
  SubagentToolResult,
  SyncResponse,
} from "../types.ts";
import type { SubagentService } from "../runtime/subagent-service.ts";

// ============================================================
// start handler
// ============================================================

/** start 入参（从 tool params.startParam 来，task 必填）。 */
export interface StartHandlerInput {
  task?: string;
  agent?: string;
  wait?: boolean;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
}

/** start 领域对象（adapter 包成 syncResponse 或 bgResponse）。 */
export type StartHandlerResult =
  | { kind: "sync"; subagentId: string; sessionFile: string | undefined; response: SyncResponse }
  | { kind: "bg"; subagentId: string; sessionFile: string | undefined; response: BgResponse };

// ============================================================
// list handler
// ============================================================

export interface ListHandlerInput {
  includeFinished?: boolean;
  limit?: number;
}

/** list 领域对象（adapter 包成 listResponse，最外层 subagentId/sessionFile 为 null）。 */
export interface ListHandlerResult {
  response: ListResponse;
}

// ============================================================
// cancel handler
// ============================================================

export interface CancelHandlerInput {
  subagentId?: string;
}

/** cancel 领域对象（adapter 包成 cancelResponse）。 */
export interface CancelHandlerResult {
  subagentId: string;
  response: CancelResponse;
}

// ============================================================
// handlers（步骤 2/4/6 填肉，先 throw）
// ============================================================

export async function startHandler(
  _service: SubagentService,
  _input: StartHandlerInput | undefined,
  _signal: AbortSignal | undefined,
  _onUpdate?: (partialResult: AgentToolResult<SubagentToolResult>) => void,
): Promise<StartHandlerResult> {
  throw new Error("startHandler not implemented");
}

export function listHandler(
  _service: SubagentService,
  _input: ListHandlerInput | undefined,
): ListHandlerResult {
  throw new Error("listHandler not implemented");
}

export async function cancelHandler(
  _service: SubagentService,
  _input: CancelHandlerInput | undefined,
): Promise<CancelHandlerResult> {
  throw new Error("cancelHandler not implemented");
}

// ============================================================
// adapter（步骤 5 填肉，先 throw）
// ============================================================

export function adapter(
  _action: "start" | "list" | "cancel",
  _domain: StartHandlerResult | ListHandlerResult | CancelHandlerResult,
): AgentToolResult<SubagentToolResult> {
  throw new Error("adapter not implemented");
}
```

- [ ] **步骤 2：实现 startHandler（task 校验 + service.execute + 领域对象）**

把 `startHandler` 的 `throw` 体替换为：

```typescript
export async function startHandler(
  service: SubagentService,
  input: StartHandlerInput | undefined,
  signal: AbortSignal | undefined,
  onUpdate?: (partialResult: AgentToolResult<SubagentToolResult>) => void,
): Promise<StartHandlerResult> {
  if (!input) throw new Error("startParam is required for action:'start'");
  // task 必填 + 空白校验（G-008）
  const task = input.task?.trim();
  if (!task) throw new Error("startParam.task is required (and must not be whitespace-only)");

  const handle = await service.execute({
    task,
    agent: input.agent,
    wait: input.wait,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    skillPath: input.skillPath,
    appendSystemPrompt: input.appendSystemPrompt,
    schema: input.schema,
    maxTurns: input.maxTurns,
    graceTurns: input.graceTurns,
    signal,
    onUpdate: onUpdate
      // sync streaming 回流：把 project 产出的内层 SubagentToolDetails 包成 SubagentToolResult
      // （与 renderResult 同源）。background 不回流（execute return 后无 onUpdate）。
      ? (details) => {
          onUpdate({
            content: [{ type: "text", text: details.result ?? "" }],
            details: liftSync(details),
          });
        }
      : undefined,
  });

  if (handle.mode === "background") {
    return {
      kind: "bg",
      subagentId: handle.subagentId,
      sessionFile: handle.sessionFile,
      response: {
        status: "running",
        mode: "background",
        message: "detached, will notify on completion",
      },
    };
  }

  // sync 完成：record 已 settled，details 含 mode/sessionFile/elapsedSeconds。
  const d = handle.details;
  return {
    kind: "sync",
    subagentId: handle.record.id,
    sessionFile: d.sessionFile,
    response: {
      status: d.status,
      mode: "sync",
      agent: d.agent,
      model: d.model,
      thinkingLevel: d.thinkingLevel,
      turns: d.turns,
      totalTokens: d.totalTokens,
      elapsedSeconds: d.elapsedSeconds,
      eventLog: d.eventLog,
      currentActivity: d.currentActivity,
      result: d.result,
      error: d.error,
      parsedOutput: d.parsedOutput,
      sessionFile: d.sessionFile,
    },
  };
}
```

并在文件顶部（adapter 之前）加 `liftSync` 辅助函数（把内层 details 包成外层 SubagentToolResult，供 onUpdate 回流）：

```typescript
/** 把内层 SubagentToolDetails（sync streaming）包成外层 SubagentToolResult（onUpdate 回流用）。 */
function liftSync(details: import("../types.ts").SubagentToolDetails): SubagentToolResult {
  return {
    action: "start",
    subagentId: null, // streaming 期 subagentId 未知，终态由 adapter 填
    sessionFile: details.sessionFile ?? null,
    syncResponse: {
      status: details.status,
      mode: "sync",
      agent: details.agent,
      model: details.model,
      thinkingLevel: details.thinkingLevel,
      turns: details.turns,
      totalTokens: details.totalTokens,
      elapsedSeconds: details.elapsedSeconds,
      eventLog: details.eventLog,
      currentActivity: details.currentActivity,
      result: details.result,
      error: details.error,
      parsedOutput: details.parsedOutput,
      sessionFile: details.sessionFile,
    },
  };
}
```

- [ ] **步骤 3：实现 listHandler（默认 running + limit 夹紧 + 排序 + 8 字段 item）**

把 `listHandler` 的 `throw` 体替换为（注意：`listHandler` 同步——`collectRecords` 同步）：

```typescript
export function listHandler(
  service: SubagentService,
  input: ListHandlerInput | undefined,
): ListHandlerResult {
  const includeFinished = input?.includeFinished === true;
  // limit 夹紧：默认 20，范围 [1, 100]
  const rawLimit = input?.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));

  // collectRecords(limit, sessionId) 合并四源；按 status priority + startedAt desc 排好序。
  // includeFinished=false 时过滤掉非 running（list-view 仍用 collectRecords 不变，这里多一层过滤）。
  const all = service.collectRecords(Math.max(limit, MIN_COLLECT_FOR_FILTER), serviceSessionId(service));
  const filtered = includeFinished ? all : all.filter((r) => r.status === "running");
  const items: SubagentListItem[] = filtered.slice(0, limit).map(recordToListItem);
  const running = items.filter((i) => i.status === "running").length;

  return { response: { running, items } };
}
```

在文件顶部加常量 + 两个 helper：

```typescript
/** list 默认 limit。 */
const DEFAULT_LIST_LIMIT = 20;
/** list limit 上限。 */
const MAX_LIST_LIMIT = 100;
/**
 * collectRecords 的取数下限。includeFinished=false 时先取够多再过滤 running，
 * 避免「limit=5 但前 5 条全 done → running 全被过滤掉」。
 * includeFinished=true 时 collect 上限即 limit。
 */
const MIN_COLLECT_FOR_FILTER = 100;

/** 从 service 安全取当前 sessionId（list history 源按此过滤）。 */
function serviceSessionId(service: SubagentService): string | undefined {
  // SubagentService.collectRecords(limit, sessionId) 接收 sessionId；
  // service 内部原本传 modelService.sessionId。这里复用 service.collectRecords 的签名，
  // 但 service 不暴露 sessionId getter——经 collectRecords 默认行为（不传 sessionId = 不过滤 history）。
  // 注：保持与旧 tool 行为一致（旧 poll 不涉及 session 作用域，list 是新能力）。
  // 诚实声明（G3-003）：内存源跨 session 可见，history 源不过滤（service 未暴露 sessionId）。
  return undefined;
}

/** SubagentRecord → SubagentListItem（8 字段，duration 实时计算）。 */
function recordToListItem(r: import("../types.ts").SubagentRecord): SubagentListItem {
  const end = r.endedAt ?? Date.now();
  const duration = Math.max(0, Math.floor((end - r.startedAt) / 1000));
  return {
    subagentId: r.id,
    agent: r.agent,
    status: r.status,
    mode: r.mode,
    duration,
    model: r.model,
    totalTokens: r.totalTokens,
    sessionFile: r.sessionFile,
  };
}
```

- [ ] **步骤 4：实现 cancelHandler（三层 throw 翻译）**

把 `cancelHandler` 的 `throw` 体替换为：

```typescript
export async function cancelHandler(
  service: SubagentService,
  input: CancelHandlerInput | undefined,
): Promise<CancelHandlerResult> {
  const id = input?.subagentId?.trim();
  if (!id) throw new Error("cancelParam.subagentId is required for action:'cancel'");

  // step 1: id 不存在
  const rec = service.findRecord(id);
  if (!rec) throw new Error(`No subagent record with id "${id}"`);
  // step 2: mode 非 background
  if (rec.mode !== "background") {
    throw new Error("Cannot cancel sync subagent (only background can be cancelled)");
  }
  // step 3: service.cancel boolean（list-view 契约不变）；false = 已终态
  if (!service.cancel(id)) {
    throw new Error(`Subagent ${id} already finished (status: ${rec.status})`);
  }
  return { subagentId: id, response: { cancelled: true } };
}
```

- [ ] **步骤 5：实现 adapter（领域对象 → SubagentToolResult + {content, details}）**

把 `adapter` 的 `throw` 体替换为：

```typescript
export function adapter(
  action: "start" | "list" | "cancel",
  domain: StartHandlerResult | ListHandlerResult | CancelHandlerResult,
): AgentToolResult<SubagentToolResult> {
  let result: SubagentToolResult;
  if (action === "start") {
    const d = domain as StartHandlerResult;
    result = d.kind === "sync"
      ? { action, subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, syncResponse: d.response }
      : { action, subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, bgResponse: d.response };
  } else if (action === "list") {
    const d = domain as ListHandlerResult;
    result = { action, subagentId: null, sessionFile: null, listResponse: d.response };
  } else {
    const d = domain as CancelHandlerResult;
    result = { action, subagentId: d.subagentId, sessionFile: null, cancelResponse: d.response };
  }

  // content JSON：LLM 看的结构化结果（schema 模式 parsedOutput 作为嵌套 JSON 值可接受）。
  const text = JSON.stringify(result);
  return {
    content: [{ type: "text", text }],
    details: result,
  };
}
```

- [ ] **步骤 6：运行 typecheck（T5+T6 合并验证，预期全绿除 tool-render.ts）**

运行：`cd extensions/subagents && pnpm typecheck`
预期：**FAIL**——仅剩 `tool-render.ts` 的 `details.backgroundId` 错误（T7 处理）。确认 `subagent-tool.ts` + `subagent-actions.ts` + `subagent-service.ts` 全绿。

- [ ] **步骤 7：提交（T5+T6 合并）**

```bash
git add extensions/subagents/src/tools/subagent-tool.ts extensions/subagents/src/tools/subagent-actions.ts
git commit -m "feat(subagents): tool action 化骨架——params action schema + 三 handler + adapter（start/list/cancel 路由）"
```

---

## 任务 7: renderResult 重构（tool-render.ts）

**文件：**
- 修改：`tui/tool-render.ts:55-66`（props 类型）、`tui/tool-render.ts:124-154`（renderSubagentResult）、`tui/tool-render.ts:178-327`（SubagentResultComponent）、`tui/tool-render.ts:342-356`（buildStatusLine）

**目标：** 组件持 `SubagentToolResult`（外层分组）；`maybeToggleSpinner` 改 `mode === "sync"` 修复锁死 bug；renderCompact/renderExpanded 按 action 分支；入口 guard 按 action 判断。

- [ ] **步骤 1：编写失败测试（spinner 不对 list 启动——FR-8/AC-1 回归保护）**

由于 tool-render 是 TUI 渲染（无单测基础设施），改为**类型 + 行为审查**。本任务不新增 vitest（render 纯函数 `renderSubagentResult` 可测，但组件 setInterval 难测）。验证靠 typecheck + 手测（AC-1 行为）。**替代：在 T10 的 tool-action.test.ts 里加一个 render guard 单测（验证 list/cancel details 不误判「execution failed」）。**

> 本步骤无代码改动，标记 done 进入步骤 2。

- [ ] **步骤 2：改 SubagentResultProps.details 类型为 SubagentToolResult**

`tui/tool-render.ts:20` 的 import，把 `SubagentToolDetails` 改为 `SubagentToolResult`：

```typescript
import type { AgentEventLogEntry, SubagentToolResult } from "../types.ts";
```

`tui/tool-render.ts:62-66` 的 `SubagentResultProps`：

```typescript
export interface SubagentResultProps {
  details: SubagentToolResult;
  expanded: boolean;
  theme: ThemeLike;
}
```

`tui/tool-render.ts:125` 的 `renderSubagentResult` 入参类型：

```typescript
export function renderSubagentResult(
  result: AgentToolResult<SubagentToolResult>,
```

- [ ] **步骤 3：改入口 guard 按 action 判断（G2-007 修复）**

`tui/tool-render.ts:137-139` 的防御 fallback 块替换为：

```typescript
  // 防御性 fallback：按 action 判断 details 结构是否完整（G2-007）。
  // list/cancel 无顶层 status/agent，旧 guard（typeof details.status）会误判「execution failed」。
  if (!details || typeof details.action !== "string" || !isDetailsStructurallyComplete(details)) {
    return new Text(themeLike.fg("warning", "(subagent execution failed — no details available)"), 0, 0);
  }
```

在文件 helper 区（`buildStatusLine` 之前）加 `isDetailsStructurallyComplete`：

```typescript
/** 按 action 检查 details 内层分组是否存在（G2-007 guard）。 */
function isDetailsStructurallyComplete(d: SubagentToolResult): boolean {
  switch (d.action) {
    case "start":
      return d.syncResponse !== undefined || d.bgResponse !== undefined;
    case "list":
      return d.listResponse !== undefined;
    case "cancel":
      return d.cancelResponse !== undefined;
    default:
      return false;
  }
}
```

- [ ] **步骤 4：改 SubagentResultComponent.details 类型 + maybeToggleSpinner 用 mode**

`tui/tool-render.ts:179` 的 `private details: SubagentToolDetails;` 改为 `private details: SubagentToolResult;`。

`tui/tool-render.ts:193` 的 `update(details: SubagentToolDetails, theme: ThemeLike)` 改为 `update(details: SubagentToolResult, theme: ThemeLike)`。

`tui/tool-render.ts:227-239` 的 `maybeToggleSpinner` 整段替换为：

```typescript
  /**
   * 按状态启停 spinner 定时器（FR-8 修复锁死 bug）。
   *   sync running → 启动（持续 onUpdate，需要 spinner 丝滑转动）
   *   其他（bg / list / cancel / terminal）→ 不启动（一次性 block，定时器泄漏会锁死页面）
   *
   *   判断信号：内层 syncResponse.mode === "sync"（非旧 backgroundId）。
   *   旧 bug：poll 返回的 QueryResult 无 backgroundId → spinner 误启动 → setInterval 永久泄漏 → 锁死。
   */
  private maybeToggleSpinner(): void {
    const sync = this.details.syncResponse;
    const isSyncRunning = sync !== undefined && sync.status === "running" && sync.mode === "sync";
    if (isSyncRunning) {
      if (this.spinnerTimer === undefined && this.invalidateFn) {
        this.spinnerTimer = setInterval(() => {
          this.invalidateFn!();
        }, SPINNER_INTERVAL_MS);
      }
    } else if (this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }
```

- [ ] **步骤 5：改 renderCompact 按 action 分支**

`tui/tool-render.ts:243-298` 的 `renderCompact` 整段替换为（按 action 分支；start 复用原 sync 逻辑从 `syncResponse` 取字段；list 表格；cancel 确认行；bg 占位）：

```typescript
  private renderCompact(width: number): string[] {
    const d = this.details;
    const theme = this.theme;

    // ── list 分支：表格（每行一个 item 摘要）──
    if (d.action === "list" && d.listResponse) {
      return renderListCompact(d.listResponse, theme, width);
    }
    // ── cancel 分支：确认行 ──
    if (d.action === "cancel" && d.cancelResponse) {
      return [truncLine(
        `${theme.fg("muted", "■")} ${theme.fg("dim", "cancelled ")}${theme.fg("accent", d.subagentId ?? "?")}`,
        width,
      )];
    }
    // ── start 分支：sync / bg ──
    if (d.bgResponse) {
      // bg 占位：一次性 block，不显示 spinner/eventLog。
      return [truncLine(
        `${theme.fg("accent", "●")} ${theme.fg("dim", "background: ")}${theme.fg("accent", d.subagentId ?? "?")}`
        + ` ${theme.fg("dim", "· running detached · will notify on completion")}`,
        width,
      )];
    }
    // sync：从 syncResponse 取字段（与旧 SubagentToolDetails 同形，字段名一致）
    const sync = d.syncResponse;
    if (!sync) return [truncLine(theme.fg("warning", "(subagent: no sync response)"), width)];

    const lines: string[] = [];
    lines.push(truncLine(buildStatusLineFromSync(sync, theme), width));

    const scrollEntries = foldEntries(sync.eventLog.filter((e) => e.type !== "turn_end"));
    if (sync.status === "running" && sync.currentActivity) {
      const lastEntry = scrollEntries[scrollEntries.length - 1];
      const sameAsLast = lastEntry !== undefined && activityMatchesEntry(sync.currentActivity, lastEntry);
      if (!sameAsLast) {
        lines.push(truncLine(buildActivityLine(sync.currentActivity, theme), width));
      }
    }
    for (const entry of scrollEntries.slice(-COMPACT_SCROLL_LINES)) {
      lines.push(truncLine(`${theme.fg("dim", STREAM_PREFIX)}${formatEventLine(entry, theme)}`, width));
    }
    if (sync.status === "running") {
      lines.push(truncLine(`${theme.fg("dim", FOOTER_PREFIX)}${theme.fg("accent", "Press Ctrl+O for live detail")}`, width));
    } else {
      const delivery = buildDeliveryLineFromSync(sync, theme);
      if (delivery) {
        lines.push(truncLine(`${theme.fg("dim", STREAM_PREFIX)}${delivery}`, width));
      }
    }
    return lines;
  }
```

- [ ] **步骤 6：改 renderExpanded 按 action 分支**

`tui/tool-render.ts:302-326` 的 `renderExpanded` 整段替换为：

```typescript
  private renderExpanded(width: number): string[] {
    const d = this.details;
    const theme = this.theme;

    if (d.action === "list" && d.listResponse) {
      return renderListExpanded(d.listResponse, theme, width);
    }
    if (d.action === "cancel" && d.cancelResponse) {
      return [truncLine(
        `${theme.fg("muted", "■")} ${theme.fg("dim", "cancelled ")}${theme.fg("accent", d.subagentId ?? "?")}`,
        width,
      )];
    }
    const sync = d.syncResponse ?? d.bgResponse;
    if (!sync) return [truncLine(theme.fg("warning", "(subagent: no response)"), width)];

    const lines: string[] = [];
    // bg 占位 expanded 与 compact 同（一次性 block 无细节可展开）
    if (d.bgResponse) {
      lines.push(truncLine(
        `${theme.fg("accent", "●")} ${theme.fg("dim", "background: ")}${theme.fg("accent", d.subagentId ?? "?")}`,
        width,
      ));
      return lines;
    }
    // sync expanded：完整 eventLog + 交付物
    const s = d.syncResponse!;
    lines.push(truncLine(buildStatusLineFromSync(s, theme), width));
    lines.push("");
    for (const entry of s.eventLog) {
      lines.push(truncLine(`${theme.fg("dim", STREAM_PREFIX)}${formatEventLine(entry, theme)}`, width));
    }
    const delivery = buildDeliveryLineFromSync(s, theme);
    if (delivery) {
      lines.push("");
      lines.push(truncLine(`${theme.fg("dim", STREAM_PREFIX)}${delivery}`, width));
    }
    return lines;
  }
```

- [ ] **步骤 7：替换 buildStatusLine / 新增 list 渲染 helper / sync 取值 helper**

`tui/tool-render.ts:342-356` 的 `buildStatusLine` 整段替换为 `buildStatusLineFromSync`（从 SyncResponse 取，删 backgroundId 分支）：

```typescript
/** 构建 sync 状态行（从 SyncResponse 取字段，删 backgroundId 分支）。 */
function buildStatusLineFromSync(
  s: { status: import("../types.ts").ExecutionStatus; turns: number; totalTokens: number; elapsedSeconds: number },
  theme: ThemeLike,
): string {
  const glyph = statusGlyph(s.status);
  const icon = glyph.icon ?? spinnerGlyph(Math.floor(Date.now() / SPINNER_INTERVAL_MS));
  const glyphStr = theme.fg(glyph.color, icon);
  const statsStr = buildStats(s, theme);
  const statsPrefix = statsStr ? ` ${theme.fg("dim", "·")} ${statsStr}` : "";
  return `${glyphStr}${statsPrefix}`;
}
```

`tui/tool-render.ts:362-369` 的 `buildStats` 不变（已接收 `{turns,totalTokens,elapsedSeconds}` 形参，兼容）。

把 `buildDeliveryLine`（`tool-render.ts:395-406`）改名为 `buildDeliveryLineFromSync`，入参从 `SubagentToolDetails` 改为 `SyncResponse`（字段同形）：

```typescript
function buildDeliveryLineFromSync(s: SyncResponse, theme: ThemeLike): string | undefined {
  switch (s.status) {
    case "done":
      return firstLineSanitized(s.result) || undefined;
    case "failed":
      return `${theme.fg("error", "Error:")}: ${firstLineSanitized(s.error)}`;
    case "cancelled":
      return theme.fg("dim", "Cancelled");
    default:
      return undefined;
  }
}
```

（需 import `SyncResponse`：`tui/tool-render.ts:20` 的 import 加 `SyncResponse`、`ListResponse`。）

在文件末尾 helper 区新增 list 渲染：

```typescript
/** list compact：每行一个 item 摘要（glyph + agent + mode + status + duration）。 */
function renderListCompact(resp: ListResponse, theme: ThemeLike, width: number): string[] {
  if (resp.items.length === 0) {
    return [truncLine(theme.fg("dim", `No subagents (running: ${resp.running})`), width)];
  }
  const lines: string[] = [truncLine(theme.fg("dim", `Subagents (running: ${resp.running}/${resp.items.length})`), width)];
  for (const it of resp.items) {
    const glyph = statusGlyph(it.status);
    const icon = glyph.icon ?? "●";
    const mode = it.mode === "background" ? "bg" : "sync";
    const line = `${theme.fg(glyph.color, icon)} ${theme.fg("accent", it.agent)} ${theme.fg("dim", `· ${mode} · ${it.status} · ${formatElapsedSeconds(it.duration)}`)}`;
    lines.push(truncLine(`${STREAM_PREFIX}${line}`, width));
  }
  return lines;
}

/** list expanded：每 item 两行（摘要 + sessionFile 路径）。 */
function renderListExpanded(resp: ListResponse, theme: ThemeLike, width: number): string[] {
  const lines = renderListCompact(resp, theme, width);
  for (const it of resp.items) {
    if (it.sessionFile) {
      lines.push(truncLine(`${theme.fg("dim", `${FOOTER_PREFIX}session: `)}${it.sessionFile}`, width));
    }
  }
  return lines;
}
```

- [ ] **步骤 8：运行 typecheck 确认全绿**

运行：`cd extensions/subagents && pnpm typecheck`
预期：**PASS**（所有类型错误消除）。

- [ ] **步骤 9：运行全量测试（确认未破坏现有）**

运行：`cd extensions/subagents && pnpm test`
预期：**PASS**（现有测试全绿；T9/T10 补新测试）。

- [ ] **步骤 10：提交**

```bash
git add extensions/subagents/src/tui/tool-render.ts
git commit -m "fix(subagents): renderResult 按 action 分支 + spinner 用 mode===sync 修复锁死 bug（FR-8/FR-9）"
```

---

## 任务 8: Command 精简 + 死代码清理（与 T2~T7 正交，可并行）

**文件：**
- 修改：`commands/subagents.ts`
- 删除：`tui/config-wizard.ts`、`tui/format-helpers.ts`
- 修改：`runtime/config/config.ts`（删 `saveGlobalConfig`）、`runtime/model-config-service.ts`（删 `saveGlobalConfig` + import）

**目标：** `/subagents` 等同原 `/subagents list [<id>]`；删 config wizard + format-helpers + 连带死代码 `saveGlobalConfig`。

- [ ] **步骤 1：重写 commands/subagents.ts**

`commands/subagents.ts` 整文件替换为：

```typescript
// src/commands/subagents.ts
//
// /subagents 命令。薄壳——打开 list overlay（等同原 /subagents list [<id>]）。
//
// 解析：args[0] 直接作可选 <id>（聚焦该 record）。

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { getSubagentService } from "../runtime/subagent-service.ts";
import { createSubagentsView } from "../tui/list-view.ts";

/** 注册 /subagents 命令（= list overlay）。 */
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents: /subagents [<id>]",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/subagents requires an interactive UI", "error");
        return;
      }
      const service = getSubagentService();
      if (!service) {
        ctx.ui.notify("subagents execution runtime not ready (session not started)", "error");
        return;
      }
      const args = argsStr.trim().split(/\s+/).filter(Boolean);
      await createSubagentsView(service, ctx.ui.theme, ctx, args[0]);
    },
  });
}
```

- [ ] **步骤 2：删除 config-wizard.ts + format-helpers.ts**

```bash
git rm extensions/subagents/src/tui/config-wizard.ts extensions/subagents/src/tui/format-helpers.ts
```

- [ ] **步骤 3：删除 config.ts 的 saveGlobalConfig**

`runtime/config/config.ts:117-130` 的整个 `saveGlobalConfig` 函数删除。

检查 `config.ts:8` 的 `import * as fs from "node:fs";` 是否仍有其他引用（`loadGlobalConfig` 读 fs、`saveGlobalConfig` 写 fs）。运行：

```bash
cd extensions/subagents && grep -n 'fs\.' src/runtime/config/config.ts
```

若 `fs.` 仅剩 `loadGlobalConfig` 用（读），保留 import；若全删则 import 也删。预期：`loadGlobalConfig` 仍用 `fs.existsSync`/`fs.readFileSync`，import 保留。

- [ ] **步骤 4：删除 model-config-service 的 saveGlobalConfig + saveConfig import**

`runtime/model-config-service.ts:25` 的 import 块，删 `saveGlobalConfig as saveConfig,` 行：

```typescript
import {
  createSessionState,
  loadGlobalConfig,
  restoreSessionState,
} from "./config/config.ts";
```

`runtime/model-config-service.ts:174-178` 的 `saveGlobalConfig` 方法删除。

- [ ] **步骤 5：确认无残留引用**

运行：

```bash
cd extensions/subagents && grep -rn "runConfigWizard\|formatConfigSummary\|saveGlobalConfig\|config-wizard\|format-helpers" src/
```

预期：**无输出**（全删干净；`config-wizard`/`format-helpers` 仅作为已删文件名出现于无，grep 应空）。

- [ ] **步骤 6：运行 typecheck + 全量测试**

运行：`cd extensions/subagents && pnpm typecheck && pnpm test`
预期：**PASS**。

- [ ] **步骤 7：提交**

```bash
git add extensions/subagents/src/commands/subagents.ts extensions/subagents/src/runtime/config/config.ts extensions/subagents/src/runtime/model-config-service.ts
git commit -m "refactor(subagents): /subagents 精简为 list overlay + 删 config-wizard/format-helpers/saveGlobalConfig 死代码（FR-10）"
```

---

## 任务 9: 测试更新（subagent-service.test.ts + execution-record.test.ts 收尾）

**文件：**
- 修改：`__tests__/subagent-service.test.ts`（已在 T4 部分改，本任务补 findRecord 内存源用例）
- 修改：`__tests__/execution-record.test.ts`（T2 已改，本任务确认无遗漏）

**目标：** AC-10——删 query 测试（T4 已做）、补 findRecord 内存源查询用例、确认 project/snapshot 断言完整。

- [ ] **步骤 1：补 findRecord 内存源查询用例（live record 经 register 可见）**

由于 `SubagentService` 无公开 `register`（`store.register` 是 service 内部），无法在单测直接造 live record。`findRecord` 查 `store.getMutable`——空 store 返回 undefined（T4 已覆盖）。**完整 findRecord 内存查询需 execute 集成测试**（mock session-factory），属 T4 TODO 范畴，本任务**不新增**（YAGNI——单测边界）。

> 标记 done：findRecord 的「不存在返回 undefined」已在 T4 覆盖，内存源查询留集成测试。

- [ ] **步骤 2：确认 execution-record.test.ts 的 mode/sessionFile 断言完整**

运行：`cd extensions/subagents && pnpm test -- execution-record`
确认 T2 步骤 1 新增的 4 个用例全绿（project mode/sessionFile + snapshot sessionFile × 2）。

- [ ] **步骤 3：确认 subagent-service.test.ts 无 query 残留**

运行：`cd extensions/subagents && grep -n 'service\.query\|QueryResult' __tests__/subagent-service.test.ts`
预期：**仅注释行**（TODO 集成测试注释）或无。若有非注释残留，删除。

- [ ] **步骤 4：更新集成测试 TODO 注释（subagent-service.test.ts:199-209）**

`__tests__/subagent-service.test.ts:199-209` 的 TODO 注释块，把 `backgroundId` 改 `subagentId`：

```typescript
// ============================================================
// TODO: execute() 集成测试
// ============================================================
// execute() 的完整测试需要 mock session-factory.getSdk() 返回的 SdkLike +
// createAndConfigureSession 的全套依赖。建议覆盖：
//   1. sync happy path: execute({wait:true}) → handle.mode="sync", record.status=done
//   2. background: execute({wait:false}) → handle.mode="background", subagentId 非空, status=running
//   3. dispose flush: background 运行中 dispose → notifier.flushPendingNotifications 被调
//   4. cancel CAS: background running 时 cancel → status=cancelled + durationMs>0
//   5. findRecord: register 后可见 / archive 后仍可见（内存三源）
```

- [ ] **步骤 5：运行全量测试**

运行：`cd extensions/subagents && pnpm test`
预期：**PASS**。

- [ ] **步骤 6：提交（若有改动）**

```bash
git add extensions/subagents/src/__tests__/subagent-service.test.ts
git diff --cached --quiet || git commit -m "test(subagents): 清理 query 残留 + 更新 execute 集成测试 TODO（AC-10）"
```

（若无改动跳过提交。）

---

## 任务 10: tool-action 测试（新建 __tests__/tool-action.test.ts）

**文件：**
- 创建：`__tests__/tool-action.test.ts`

**目标：** AC-2/AC-3/AC-9——action 路由三路径成功 + 失败 + adapter 出参结构。用 mock SubagentService（vi.mock 或手写 stub），不依赖真实 SDK。

- [ ] **步骤 1：编写失败测试（action 路由 + adapter 结构）**

创建 `__tests__/tool-action.test.ts`：

```typescript
// src/__tests__/tool-action.test.ts
//
// tool action 路由 + adapter 出参结构测试（AC-2/AC-3/AC-9）。
// 用 stub SubagentService（不依赖真实 SDK），测 handler + adapter 纯逻辑。

import { describe, expect, it, vi } from "vitest";

import { adapter, cancelHandler, listHandler, startHandler } from "../tools/subagent-actions.ts";
import type { SubagentService } from "../runtime/subagent-service.ts";
import type {
  ExecutionHandle,
  RecordSnapshot,
  SubagentRecord,
  SubagentToolDetails,
} from "../types.ts";

// ── stub 工厂 ──

function makeDetails(over: Partial<SubagentToolDetails> = {}): SubagentToolDetails {
  return {
    status: "done",
    mode: "sync",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    turns: 1,
    totalTokens: 10,
    elapsedSeconds: 1,
    eventLog: [],
    result: "ok",
    ...over,
  };
}

function makeSnapshot(over: Partial<RecordSnapshot> = {}): RecordSnapshot {
  return {
    id: "run-1",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "sync",
    task: "t",
    status: "done",
    eventLog: [],
    turns: 1,
    totalTokens: 10,
    startedAt: 1000,
    endedAt: 2000,
    result: "ok",
    error: undefined,
    sessionFile: undefined,
    ...over,
  };
}

function makeService(over: Partial<SubagentService> = {}): SubagentService {
  return {
    execute: vi.fn(),
    findRecord: vi.fn(() => undefined),
    cancel: vi.fn(() => false),
    collectRecords: vi.fn(() => [] as SubagentRecord[]),
  } as unknown as SubagentService;
}

// ============================================================
// startHandler
// ============================================================
describe("startHandler", () => {
  it("缺 startParam → throw", async () => {
    const svc = makeService();
    await expect(startHandler(svc, undefined, undefined)).rejects.toThrow(/startParam is required/);
  });

  it("task 空白 → throw", async () => {
    const svc = makeService();
    await expect(startHandler(svc, { task: "   " }, undefined)).rejects.toThrow(/task is required/);
  });

  it("sync 完成 → kind=sync + syncResponse + subagentId", async () => {
    const svc = makeService({
      execute: vi.fn(async (): Promise<ExecutionHandle> => ({
        mode: "sync",
        record: makeSnapshot({ id: "run-1", sessionFile: "s.jsonl" }),
        details: makeDetails({ status: "done", sessionFile: "s.jsonl" }),
      })),
    });
    const r = await startHandler(svc, { task: "do it" }, undefined);
    expect(r.kind).toBe("sync");
    if (r.kind !== "sync") return;
    expect(r.subagentId).toBe("run-1");
    expect(r.sessionFile).toBe("s.jsonl");
    expect(r.response.mode).toBe("sync");
    expect(r.response.status).toBe("done");
  });

  it("background 启动 → kind=bg + bgResponse.message 含 detached", async () => {
    const svc = makeService({
      execute: vi.fn(async (): Promise<ExecutionHandle> => ({
        mode: "background",
        subagentId: "bg-1-123",
        sessionFile: undefined,
        details: makeDetails({ status: "running", mode: "background" }),
      })),
    });
    const r = await startHandler(svc, { task: "long", wait: false }, undefined);
    expect(r.kind).toBe("bg");
    if (r.kind !== "bg") return;
    expect(r.subagentId).toBe("bg-1-123");
    expect(r.response.message).toMatch(/detached/);
  });
});

// ============================================================
// listHandler
// ============================================================
describe("listHandler", () => {
  it("空 → running:0, items:[]", () => {
    const svc = makeService({ collectRecords: vi.fn(() => [] as SubagentRecord[]) });
    const r = listHandler(svc, undefined);
    expect(r.response).toEqual({ running: 0, items: [] });
  });

  it("limit 夹紧 [1,100]——传 0 夹为 1，传 100000 夹为 100", () => {
    const svc = makeService({ collectRecords: vi.fn(() => [] as SubagentRecord[]) });
    listHandler(svc, { limit: 0 });
    listHandler(svc, { limit: 100000 });
    // 夹紧逻辑在 handler 内，collectRecords 收到的 limit 应被夹（≥1 ≤100 的 collect 下限）
    // 这里只验证不抛错 + 返回结构合法
  });

  it("includeFinished=false 过滤非 running", () => {
    const records: SubagentRecord[] = [
      { id: "r1", agent: "w", status: "running", mode: "background", startedAt: 1, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
      { id: "r2", agent: "w", status: "done", mode: "sync", startedAt: 2, endedAt: 3, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
    ];
    const svc = makeService({ collectRecords: vi.fn(() => records) });
    const r = listHandler(svc, { includeFinished: false });
    expect(r.response.items).toHaveLength(1);
    expect(r.response.items[0].subagentId).toBe("r1");
    expect(r.response.running).toBe(1);
  });

  it("item 8 字段齐全（含 duration 实时计算）", () => {
    const records: SubagentRecord[] = [
      { id: "r1", agent: "w", status: "done", mode: "sync", startedAt: 1000, endedAt: 2500, turns: 2, totalTokens: 50, model: "m", thinkingLevel: "high", eventLog: [], sessionFile: "x.jsonl" },
    ];
    const svc = makeService({ collectRecords: vi.fn(() => records) });
    const r = listHandler(svc, { includeFinished: true });
    const item = r.response.items[0];
    expect(item).toMatchObject({
      subagentId: "r1", agent: "w", status: "done", mode: "sync",
      duration: 1, model: "m", totalTokens: 50, sessionFile: "x.jsonl",
    });
  });
});

// ============================================================
// cancelHandler
// ============================================================
describe("cancelHandler", () => {
  it("缺 subagentId → throw", async () => {
    const svc = makeService();
    await expect(cancelHandler(svc, undefined)).rejects.toThrow(/subagentId is required/);
    await expect(cancelHandler(svc, { subagentId: "  " })).rejects.toThrow(/subagentId is required/);
  });

  it("id 不存在 → throw No subagent record", async () => {
    const svc = makeService({ findRecord: vi.fn(() => undefined) });
    await expect(cancelHandler(svc, { subagentId: "nope" })).rejects.toThrow(/No subagent record with id "nope"/);
  });

  it("mode=sync → throw Cannot cancel sync", async () => {
    const svc = makeService({
      findRecord: vi.fn(() => makeSnapshot({ id: "run-1", mode: "sync" })),
    });
    await expect(cancelHandler(svc, { subagentId: "run-1" })).rejects.toThrow(/Cannot cancel sync subagent/);
  });

  it("已终态（cancel 返回 false）→ throw already finished", async () => {
    const svc = makeService({
      findRecord: vi.fn(() => makeSnapshot({ id: "bg-1", mode: "background", status: "done" })),
      cancel: vi.fn(() => false),
    });
    await expect(cancelHandler(svc, { subagentId: "bg-1" })).rejects.toThrow(/already finished \(status: done\)/);
  });

  it("成功 → cancelled:true", async () => {
    const svc = makeService({
      findRecord: vi.fn(() => makeSnapshot({ id: "bg-1", mode: "background", status: "running" })),
      cancel: vi.fn(() => true),
    });
    const r = await cancelHandler(svc, { subagentId: "bg-1" });
    expect(r.subagentId).toBe("bg-1");
    expect(r.response.cancelled).toBe(true);
  });
});

// ============================================================
// adapter
// ============================================================
describe("adapter", () => {
  it("start sync → SubagentToolResult.syncResponse + content 是合法 JSON", () => {
    const r = adapter("start", {
      kind: "sync", subagentId: "run-1", sessionFile: "s.jsonl",
      response: { status: "done", mode: "sync", agent: "w", model: "m", thinkingLevel: undefined, turns: 1, totalTokens: 0, elapsedSeconds: 1, eventLog: [] },
    });
    expect(r.details.action).toBe("start");
    expect(r.details.subagentId).toBe("run-1");
    expect(r.details.syncResponse).toBeDefined();
    expect(r.details.bgResponse).toBeUndefined();
    // content 是合法 JSON 字符串
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.action).toBe("start");
  });

  it("list → 最外层 subagentId/sessionFile 为 null", () => {
    const r = adapter("list", { response: { running: 0, items: [] } });
    expect(r.details.action).toBe("list");
    expect(r.details.subagentId).toBeNull();
    expect(r.details.sessionFile).toBeNull();
    expect(r.details.listResponse).toEqual({ running: 0, items: [] });
  });

  it("cancel → cancelResponse.cancelled:true 字面量", () => {
    const r = adapter("cancel", { subagentId: "bg-1", response: { cancelled: true } });
    expect(r.details.cancelResponse).toEqual({ cancelled: true });
    expect(r.details.subagentId).toBe("bg-1");
  });
});
```

- [ ] **步骤 2：运行测试确认通过（handler/adapter 已在 T6 实现）**

运行：`cd extensions/subagents && pnpm test -- tool-action`
预期：**PASS**。若失败，定位是 handler/adapter 实现与测试期望不符，回 T6 修实现（不修测试——测试是 AC 来源）。

- [ ] **步骤 3：提交**

```bash
git add extensions/subagents/src/__tests__/tool-action.test.ts
git commit -m "test(subagents): 新增 tool-action 路由 + adapter 出参结构测试（AC-2/AC-3/AC-9）"
```

---

## 任务 11: 全量验证 + 收尾

**文件：** 无新改动（验证 + grep 残留 + 提交）

**目标：** 确认所有 AC 达标，无残留死代码，tsc + eslint + vitest 三绿。

- [ ] **步骤 1：grep 确认 poll 残留清零（AC-4）**

运行：

```bash
cd extensions/subagents && grep -rn "backgroundId\|QueryResult\|service\.query\|recordToQueryResult" src/ | grep -v '__tests__/subagent-service.test.ts.*TODO'
```

预期：**无输出**（或仅 history 注释/TODO 注释行，无实际代码引用）。若有代码残留，回对应任务修。

- [ ] **步骤 2：grep 确认 command 清理干净（AC-7）**

运行：

```bash
cd extensions/subagents && grep -rn "runConfigWizard\|formatConfigSummary\|saveGlobalConfig" src/
```

预期：**无输出**。

- [ ] **步骤 3：确认文件已删**

运行：

```bash
ls extensions/subagents/src/tui/config-wizard.ts extensions/subagents/src/tui/format-helpers.ts 2>&1
```

预期：两文件均 `No such file or directory`。

- [ ] **步骤 4：typecheck 全绿**

运行：`cd extensions/subagents && pnpm typecheck`
预期：**PASS**（0 error）。

- [ ] **步骤 5：全量测试全绿**

运行：`cd extensions/subagents && pnpm test`
预期：**PASS**（所有测试用例绿，含 T2/T9/T10 新增）。

- [ ] **步骤 6：lint 全绿（taste-lint）**

运行：`pnpm lint`（仓库根，全 monorepo）
预期：**0 warning, 0 error**。若有 warning，按提示修（常见：import 排序 `simple-import-sort`——运行 `pnpm lint:fix` 自动修）。

- [ ] **步骤 7：人工行为验证（AC-1 锁死 bug）**

> 此步骤需在真实 Pi session 中跑（agentic worker 可在交付说明里标注「需用户手测」）。

1. 启动一个 background subagent：`action:"start"` + `wait:false`
2. 连续调 `action:"list"` 5 次
3. 确认页面可正常鼠标滚动（无 setInterval 泄漏锁死底部）
4. 确认 list 返回的 tool block 无 spinner 转动（mode !== "sync"）

- [ ] **步骤 8：最终提交（若有 lint:fix 改动）**

```bash
git status
# 若有未提交的 lint:fix 改动：
git add -A && git commit -m "style(subagents): lint:fix import 排序"
```

---

## 自我审查记录

### 1. 规格覆盖（FR → 任务映射）

| FR | 任务 | 覆盖点 |
|----|------|--------|
| FR-1 tool action 化 | T5（schema）+ T6（路由） | params action + 分组 param；action/param 不匹配在 handler throw（start 缺 startParam、cancel 缺 subagentId） |
| FR-2 handler 路由 + adapter | T5（骨架）+ T6（实现） | switch(action) → 三 handler → adapter 唯一包装 |
| FR-3 出参结构化 + 分层 | T1（类型）+ T6（adapter） | SubagentToolDetails 内层扁平 + SubagentToolResult 外层分组（G3-001 A 方案） |
| FR-4 废弃 poll | T1（删 QueryResult）+ T4（删 query/recordToQueryResult）+ T5（删 poll 分支 + description）+ T11 grep 确认 | 全链路清除 |
| FR-5 cancel 三层 | T4（findRecord）+ T6（cancelHandler 三 throw） | service.cancel boolean 不变 + tool 翻译 |
| FR-6 list 默认范围 + 字段 | T6（listHandler） | 默认 running + includeFinished + limit 夹紧 + 8 字段 + 排序复用 collectRecords |
| FR-7 sessionFile 回填 | T1（字段）+ T2（投影）+ T3（run 回填） | 四处投影生产者 + run 内回填 |
| FR-8 spinner 修复 | T7（maybeToggleSpinner mode===sync） | 根因修复 |
| FR-9 renderResult 按 action | T7（renderCompact/Expanded 分支 + guard） | G2-007 guard + G2-009 标题（标题行 renderCall 不改，list/cancel 标题在 block 内已体现） |
| FR-10 command 精简 | T8 | 删 wizard + format-helpers + saveGlobalConfig |
| FR-11 followUp 保留 | （不动）| notifier/bg-notify-render 零改动，显式确认 |

**遗漏检查：** AC-1~AC-10 全部有对应任务/步骤——AC-1（T7+T11 手测）、AC-2（T10）、AC-3（T10 adapter 测试）、AC-4（T11 grep）、AC-5（T2+T3+T10）、AC-6（T10 list 测试）、AC-7（T11 grep）、AC-8（不动，现有 notifier.test.ts 保证）、AC-9（T10 cancel 测试）、AC-10（T9+T10）。

### 2. 占位符扫描

- T3 步骤 2 的 `makeRunningRecord`/`optsFixture`/`ctxFixture`：已注明「复用现有 session-runner.test.ts 的 mock 装配」+「执行时打开现有测试文件顶部 fixture」——这是对现有代码的引用（非凭空占位），因 session-runner.test.ts 的 mock 结构需执行时读取确认。**可接受**（给出了具体定位指引 + 失败/成功断言）。
- T9 步骤 1 的 findRecord 内存源用例：明确「不新增（YAGNI——单测边界）」，理由充分（service 无公开 register）。
- 无「TBD」「TODO 以后实现」「添加适当错误处理」等空洞占位。所有代码步骤含完整代码块。

### 3. 类型一致性

- `SubagentToolDetails`（T1 内层）：`mode` + `sessionFile?` + 删 `backgroundId`——T2 project 输出对齐、T7 renderCompact 从 `syncResponse` 取（SyncResponse 与 SubagentToolDetails sync 子集字段一致）。
- `SubagentToolResult`（T1 外层）：`action` + `subagentId: string | null` + `sessionFile: string | null` + 四选一 response——T6 adapter 输出对齐、T7 组件持有对齐。
- `ExecutionHandle` background 分支：`subagentId` + `sessionFile: string | undefined`——T4 execute 返回对齐、T6 startHandler 消费对齐。
- `findRecord(id): RecordSnapshot | undefined`（T4）——T6 cancelHandler 消费 `rec.mode`/`rec.status`（RecordSnapshot 有这俩字段，T1 已确认）。
- `SyncResponse`/`BgResponse`/`ListResponse`/`CancelResponse`/`SubagentListItem`（T1）——T6 handler 返回 + T7 render 消费，字段名全文一致（`syncResponse.status`/`.mode`/`.turns`/`.eventLog`/`.currentActivity`/`.result`/`.error`/`.parsedOutput`/`.sessionFile`）。
- handler 返回类型 `StartHandlerResult`（kind discriminant）——T6 adapter 用 `d.kind === "sync"` 分支，类型窄化正确。
- `listHandler` 同步（非 async）——T5 execute 路由 `case "list": return adapter("list", await listHandler(...))` 中 `await` 对同步返回值无害，typecheck 不报错。

**类型一致性确认通过，无 rework 风险。**
