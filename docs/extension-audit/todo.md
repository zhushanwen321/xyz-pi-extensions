# Extension 审查报告: todo

## 基本信息

| 项目 | 值 |
|------|-----|
| 包名 | `@zhushanwen/pi-todo` |
| 版本 | `0.1.4` |
| 入口文件 | `./src/index.ts` (re-export via `index.ts`) |
| 源码文件 | `src/index.ts` (928行), `src/model.ts` (312行) |
| 测试文件 | `src/__tests__/todo.test.ts` |
| 总代码行数 | 1240行 |

## 审查结果概览

| 规范项 | 状态 | 严重程度 | 说明 |
|--------|------|----------|------|
| 1. 包结构与命名 | ⚠️ 部分合规 | P2 | npm scope 为个人 `@zhushanwen` 而非项目级 scope；`files` 未直接包含入口 `.ts` 文件（含 `src/` 目录可接受） |
| 1. pi.extensions 字段 | ⚠️ 部分合规 | P2 | 使用 `"pi": { "extensions": [...] }` 嵌套结构，规范要求 `pi.extensions` 扁平键名格式待确认 |
| 1. peerDependencies | ⚠️ 部分合规 | P1 | `@mariozechner/pi-coding-agent` 未设为 optional ✅正确，但 `@mariozechner/pi-ai` 和 `@mariozechner/pi-tui` 被标记为 optional，需确认是否符合规范 |
| 2. 入口与工厂模式 | ❌ 不合规 | P1 | 工厂函数体 612 行，远超 100 行委托阈值，`executeTodoAction` 函数 318 行，应拆分为子模块 |
| 2. 模块级变量 | ✅ 合规 | - | 所有状态变量在工厂闭包内，无模块级 `let` |
| 3. Tool execute 返回格式 | ✅ 合规 | - | 返回 `{ content: [{type:"text",text}], details }` 格式正确 |
| 3. 错误处理禁止抛异常 | ✅ 合规 | - | 无 `throw` 语句，错误通过 `{ content, details: {error} }` 返回 |
| 3. signal 透传 | ❌ 不合规 | P1 | `execute` 接收 `_signal` 但未透传给任何异步操作（当前无真正异步操作，但未保留扩展能力） |
| 3. 参数 schema description | ⚠️ 部分合规 | P2 | 顶层字段有 description，但 `updates[]` 内嵌 `id`/`status`/`text` 字段缺少 description |
| 3. details 作为 renderResult 数据源 | ✅ 合规 | - | renderResult 统一从 `details: TodoDetails` 读取数据 |
| 4. 事件处理器 ≤20行 | ❌ 不合规 | P1 | `agent_end` 处理器约 60 行，`before_agent_start` 处理器约 40 行，均超过 20 行限制 |
| 4. agent_end 禁止启动新 LLM 调用 | ⚠️ 需确认 | P0 | `agent_end` 中调用了 `pi.sendUserMessage()` 3 处（L813/L826/L832），使用 `deliverAs: "steer"`——若 steer 触发新一轮 LLM 调用则违反规范 |
| 4. session_tree 丢弃旧分支 pending | ✅ 合规 | - | `reconstructState` 正确重建状态并清理旧 entries |
| 5. 状态在工厂闭包内 | ✅ 合规 | - | 所有 `let todos/nextId/userMessageCount` 等在闭包内 |
| 5. 反序列化向后兼容 | ✅ 合规 | - | `migrateTodo()` 处理旧 `done: boolean` 格式，补充缺失字段默认值 |
| 6. Stale Context 检测 | ❌ 缺失 | P1 | 未使用 `isStaleContextError` 进行保护 |
| 6. 防重入 | ❌ 缺失 | P2 | 无 `isProcessing` 标志，`executeTodoAction` 为同步函数故风险较低 |
| 6. 所有控制流路径显式 return | ✅ 合规 | - | 每个 case 分支都有 return |
| 7. 类型安全 | ✅ 合规 | - | 无 `any` 使用；`model.ts` 集中定义类型；`Record<string, unknown>` 仅在迁移函数内使用 |
| 8. 路径与配置 | ✅ 合规 | - | 无硬编码路径，无文件系统操作 |
| 9. 依赖管理 | ✅ 合规 | - | 第三方包 `typebox`/`vitest` 在 dependencies/devDependencies 中声明 |
| 10. 健壮性 - 未捕获异常 | ✅ 合规 | - | 无 `throw`，事件处理器用 try-catch 保护 |
| 10. 健壮性 - process.exit | ✅ 合规 | - | 无 `process.exit` 调用 |
| 10. 健壮性 - 无限循环 | ✅ 合规 | - | 无无限循环 |
| 10. 异步 signal 取消 | ⚠️ 部分合规 | P2 | 当前无真正异步操作，但 execute 声明为 async 应支持 signal |
| 11. 单文件 ≤ 500 行 | ❌ 不合规 | P1 | `src/index.ts` 928 行，超过 500 行风格限制 |
| 11. 函数 ≤ 80 行 | ❌ 不合规 | P1 | `executeTodoAction` 318 行，远超 80 行限制 |
| 12. 单文件 ≤ 1000 行 (P0) | ✅ 合规 | - | 最大文件 928 行，未超过 1000 行硬限制 |
| 12. Import 顺序 | ✅ 合规 | - | Node内置 → npm(pi-ai/typebox) → Pi SDK → 内部(model)，顺序正确 |

## 详细问题清单

### P0 问题

#### P0-1: `agent_end` 中调用 `sendUserMessage` 可能触发新 LLM 调用

- **文件**: `src/index.ts` 行 813, 826, 832
- **规范**: §4 事件生命周期管理 — "agent_end 中禁止启动新的 LLM 调用"
- **代码片段**:
```typescript
// src/index.ts L813
pi.sendUserMessage(
    `<todo_context>\n[TODO] 验证失败: Task ...`,
    { deliverAs: "steer", customType: "todo-context" },
);

// src/index.ts L826
pi.sendUserMessage(buildPendingContext(userMessageCount),
    { deliverAs: "steer", customType: "todo-context" });

// src/index.ts L832
pi.sendUserMessage(buildPendingContext(userMessageCount),
    { deliverAs: "steer", customType: "todo-context" });
```
- **说明**: `agent_end` 处理器中 3 处调用 `pi.sendUserMessage()`，使用 `deliverAs: "steer"`。如果 `steer` 消息会触发新一轮 agent 调用，则直接违反规范。需确认 `steer` 在 Pi 运行时中的行为——如果它仅注入到下一轮上下文而不触发立即调用，则合规；否则为 P0 违规。
- **建议**: 如果 steer 确实触发 LLM 调用，应将这些逻辑迁移到 `before_agent_start` 事件或使用非 LLM 触发的方式。

---

### P1 问题

#### P1-1: 工厂函数体 612 行，超过 100 行委托阈值

- **文件**: `src/index.ts` 行 317-928
- **规范**: §2 入口与工厂模式 — "超过100行的工厂函数应按功能委托到子模块"
- **代码片段**:
```typescript
// src/index.ts L317
export default function (pi: ExtensionAPI) {
    // ... 612 lines of code ...
}
```
- **说明**: 工厂函数从 L317 到 L928，共 612 行。包含状态声明、refreshDisplay、buildPendingContext、executeTodoAction、reconstructState、所有事件处理器注册、tool 注册、command 注册。应按功能拆分为子模块。
- **建议**: 拆分为 `src/handlers.ts`（事件处理器）、`src/commands.ts`（命令注册）、`src/tool.ts`（工具注册 + execute）、`src/render.ts`（渲染逻辑）。

#### P1-2: `executeTodoAction` 函数 318 行，远超 80 行限制

- **文件**: `src/index.ts` 行 348-665
- **规范**: §11 代码风格 — "函数 ≤ 80 行"
- **说明**: 该函数包含 list/add/update/delete/clear 五个 action 的完整逻辑，update 分支尤其庞大（含单条更新和批量更新两套逻辑，含大量验证拦截代码）。
- **建议**: 将每个 action 拆为独立函数：`handleList()`、`handleAdd()`、`handleUpdate()`、`handleDelete()`、`handleClear()`，由 `executeTodoAction` 做分发。

#### P1-3: `src/index.ts` 928 行，超过 500 行风格限制

- **文件**: `src/index.ts` (928 行)
- **规范**: §11 代码风格 — "单文件 ≤ 500 行"
- **说明**: 虽然 P0 硬限制 1000 行未超标，但 928 行已大幅超过 500 行风格指南。结合 P1-1（工厂函数过长），应进行模块拆分。
- **建议**: 提取 TUI 组件到 `src/components/todo-list.ts`，渲染函数到 `src/render.ts`，事件处理到 `src/handlers.ts`。

#### P1-4: 事件处理器超过 20 行限制

- **文件**: `src/index.ts`
- **规范**: §4/§11 — "每个事件处理器不超过20行"
- **问题**:
  - `agent_end` 处理器（L790-L852）: ~60 行
  - `before_agent_start` 处理器（L740-L789）: ~40 行
  - `reconstructState`（L668-L715）: ~44 行（虽然不是事件处理器但被 `session_start`/`session_tree` 调用）
- **建议**: 将 `agent_end` 的逻辑拆分为 `handleAutoClear()`、`handleVerifyFailure()`、`handleStallDetection()`、`handleReminder()` 四个子函数；将 `before_agent_start` 拆分为 `buildTodoContextMessage()`。

#### P1-5: signal 参数未透传

- **文件**: `src/index.ts` 行 866
- **规范**: §3 Tool 注册与设计 — "异步操作必须透传 signal 参数"
- **代码片段**:
```typescript
async execute(_toolCallId: string, params: Static<typeof TodoParams>,
    _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
    const result = executeTodoAction(params as ..., ctx);
    // signal 未被使用
    return result;
}
```
- **说明**: `execute` 声明为 `async` 但实际操作为同步，`_signal` 未透传。虽然当前无真正异步操作风险较低，但不符合规范要求。
- **建议**: 如果 `executeTodoAction` 未来引入异步操作（如文件 I/O），应传入 signal 参数。当前可将函数签名改为同步以匹配实际行为。

#### P1-6: 缺少 Stale Context 检测

- **文件**: `src/index.ts`
- **规范**: §6 错误处理与弹性 — "Stale Context 检测: isStaleContextError 保护"
- **说明**: 代码中未使用 `isStaleContextError` 进行保护。在 `reconstructState` 中直接操作 session entries，无 stale context 防护。
- **建议**: 在关键操作（如 `reconstructState`、`executeTodoAction`）中添加 `isStaleContextError` 保护。

#### P1-7: `updates[]` 内嵌 schema 字段缺少 description

- **文件**: `src/index.ts` 行 42-50
- **规范**: §3 Tool 注册与设计 — "参数用 TypeBox Type.Object() 定义，每个字段加 description"
- **代码片段**:
```typescript
Type.Object({
    id: Type.Number(),          // ❌ 缺少 description
    status: Type.Optional(Type.String()),  // ❌ 缺少 description
    text: Type.Optional(Type.String()),    // ❌ 缺少 description
    verified: Type.Optional(Type.Boolean({ description: "..." })),  // ✅ 有 description
    evidence: Type.Optional(Type.String({ description: "..." })),   // ✅ 有 description
}),
```
- **说明**: `updates[]` 内嵌 Object 中的 `id`、`status`、`text` 三个字段缺少 `description`，仅 `verified` 和 `evidence` 有描述。
- **建议**: 为这三个字段补充 description。

---

### P2 问题

#### P2-1: npm scope 为个人账号而非项目级

- **文件**: `package.json`
- **规范**: §1 包结构与命名 — "npm 包名格式: @scope/pi-<name>"
- **说明**: 包名 `@zhushanwen/pi-todo` 使用个人 scope。如果项目有统一的 org scope（如 `@pi-extentions/pi-todo`），应统一。
- **建议**: 确认项目级 scope 并统一包名。

#### P2-2: 无防重入保护

- **文件**: `src/index.ts`
- **规范**: §6 错误处理与弹性 — "防重入: isProcessing 标志"
- **说明**: 无 `isProcessing` 标志。由于 `executeTodoAction` 是同步函数，实际重入风险极低。但如果未来引入异步操作，可能需要防护。
- **建议**: 当前可接受，但建议预留 `isProcessing` 标志以便未来扩展。

#### P2-3: `model.ts` 中 `updateTodos` 函数约 108 行，略超 80 行限制

- **文件**: `src/model.ts` 行 ~150-258
- **规范**: §11 代码风格 — "函数 ≤ 80 行"
- **说明**: `updateTodos` 纯函数约 108 行，含验证、拦截、应用三个阶段。逻辑内聚但行数超标。
- **建议**: 可拆分为 `validateUpdates()`、`checkBlocked()`、`applyUpdates()` 三个子函数。

#### P2-4: `model.ts` 中 `Record<string, unknown>` 使用场景

- **文件**: `src/model.ts` 行 40
- **规范**: §7 类型安全 — "Record<string, unknown> 仅在白名单场景"
- **代码片段**:
```typescript
const record = raw as unknown as Record<string, unknown>;
```
- **说明**: 在 `migrateTodo` 中用于旧格式迁移，属于反序列化兼容的白名单场景。✅ 合规。

#### P2-5: TodoListComponent 类中 verifyTag 渲染逻辑重复

- **文件**: `src/index.ts` 行 ~230-250 (TodoListComponent.render), 行 ~270-290 (renderWidgetLines), 行 ~360-380 (buildTodoListText)
- **规范**: §11 代码风格 / DRY 原则
- **说明**: verifyTag 渲染逻辑（根据 status/verifyText/evidence 决定标签文本）在 `TodoListComponent.render()`、`renderWidgetLines()`、`buildTodoListText()` 三处几乎完全重复。
- **建议**: 提取为共用函数 `buildVerifyTag(todo, theme)` 。

---

## 优点

1. **类型安全优秀**: 全项目零 `any`，类型集中在 `model.ts`，`Todo`/`TodoDetails` 等接口定义清晰。
2. **向后兼容处理完善**: `migrateTodo()` 同时处理旧 `done: boolean` 格式和缺失字段，确保旧数据无缝迁移。
3. **错误处理规范**: 所有错误通过 `{ content, details: {error} }` 返回，无 `throw` 或 `process.exit`。
4. **纯函数分离良好**: 核心业务逻辑（`addTodos`、`updateTodos`、`buildRender`）提取到 `model.ts` 作为纯函数，便于单元测试。
5. **测试覆盖全面**: 测试文件覆盖了数据迁移、add/update/delete 操作、状态转换拦截、batch 更新验证、verify 流程等核心场景。
6. **验证流程设计精巧**: verifying 状态机（in_progress → verifying → completed）配合 evidence 和 verifyAttempts 提供了完整的验证生命周期管理。
7. **事件处理器有 try-catch 保护**: `agent_end` 和 `before_agent_start` 都用 try-catch 包裹，防止未捕获异常。
8. **Entry GC 机制**: `reconstructState` 在重建状态后清理旧的 todo entries，避免 context 膨胀。
9. **TUI 组件支持**: `TodoListComponent` 提供了交互式 todo 浏览界面，使用语义 token 着色。

## 改进建议

### 高优先级

1. **拆分 `src/index.ts`**: 建议拆分为以下结构：
   ```
   src/
   ├── index.ts          # 工厂入口 + 事件注册 (~100行)
   ├── model.ts          # 数据模型 + 纯函数 (保持)
   ├── tool.ts           # Tool 注册 + executeTodoAction
   ├── handlers.ts       # 事件处理器 (agent_end/before_agent_start 逻辑)
   ├── render.ts         # 渲染函数 + TUI 组件
   ├── schema.ts         # TypeBox 参数定义
   └── __tests__/        # 测试 (保持)
   ```

2. **拆分 `executeTodoAction`**: 将 5 个 action 分为独立函数，由 dispatcher 调用：
   ```typescript
   function executeTodoAction(params, ctx) {
       switch (params.action) {
           case "list": return handleList(params, ctx);
           case "add": return handleAdd(params, ctx);
           // ...
       }
   }
   ```

3. **确认 `sendUserMessage` 在 `agent_end` 中的安全性**: 如果 `deliverAs: "steer"` 会触发新 LLM 调用，必须迁移到 `before_agent_start`。否则需在代码中添加注释说明安全性。

4. **补充 `updates[]` 内嵌字段 description**: 为 `id`、`status`、`text` 添加描述。

### 中优先级

5. **添加 `isStaleContextError` 保护**: 在 `reconstructState` 和关键操作中添加保护。
6. **消除 verifyTag 渲染重复**: 提取共用函数。
7. **拆分 `updateTodos` 纯函数**: 拆为 validate/checkBlocked/apply 三步。

### 低优先级

8. **统一 npm scope**: 确认项目级 scope。
9. **预留 isProcessing 标志**: 为未来异步扩展做准备。
