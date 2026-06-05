# Extension 审查报告: goal

## 基本信息
- **包名:** `@zhushanwen/pi-goal`
- **文件数:** 9（index.ts, src/index.ts, src/state.ts, src/tool-handler.ts, src/templates.ts, src/constants.ts, src/budget.ts, src/widget.ts, src/commands.ts）
- **总行数:** 2,316

## 审查结果概览

| 规范项 | 状态 | 严重程度 | 说明 |
|--------|------|----------|------|
| 1. 包结构与命名 | ⚠️ 部分合规 | P2 | 包名格式 `@zhushanwen/pi-goal` 符合 `@scope/pi-<name>`；`pi.extensions` 嵌套在 `pi` 对象下而非顶层 `pi.extensions` 键；缺少 `dependencies` 声明 |
| 2. 入口与工厂模式 | ✅ 合规 | — | `export default function(pi: ExtensionAPI)` 形式正确；工厂函数 ~200 行，委托到子模块；状态变量在闭包内 |
| 3. Tool 注册与设计 | ⚠️ 部分合规 | P1 | `execute` 内部 `executeGoalAction` 大量 `throw`（已由外层 try-catch 兜底转为 `isError`），但不符合"禁止抛异常"的规范精神；`signal` 参数未透传；`details` 使用正确 |
| 4. 事件生命周期管理 | ❌ 不合规 | P0 | `agent_end` 处理器 ~197 行，远超 20 行限制；`agent_end` 中通过 `pi.sendUserMessage` 启动新的 LLM 调用 |
| 5. 状态与会话管理 | ✅ 合规 | — | 状态在工厂闭包内；`deserializeState` 有向后兼容处理 |
| 6. 错误处理与弹性 | ⚠️ 部分合规 | P1 | 无 `isStaleContextError` 检测；无防重入 `isProcessing` 标志；但 `execute` 有 try-catch 兜底 |
| 7. 类型安全 | ⚠️ 部分合规 | P2 | 11 处显式 `any`（均有 eslint-disable 注释解释原因）；无集中 `types.ts` |
| 8. 路径与配置 | ✅ 合规 | — | 无硬编码路径 |
| 9. 依赖管理 | ⚠️ 部分合规 | P2 | 所有 npm 依赖在 `peerDependencies` 中，但缺少 `dependencies` 段（仅用 peer 可接受） |
| 10. 健壮性 | ✅ 合规 | — | 无 `process.exit`；无无限循环；`execute` 有 try-catch 兜底 |
| 11. 代码风格 | ❌ 不合规 | P1 | `src/index.ts` 900 行，违反 ≤500 行指南（但未超 1000 行 P0 上限）；多个函数超过 80 行 |
| 12. Monorepo 约定 | ⚠️ 部分合规 | P2 | `index.ts` re-export 正确；import 顺序大致正确但 `typebox` 在 Pi SDK 之后 |

## 详细问题清单

### P0 问题

#### P0-1: `agent_end` 中启动新的 LLM 调用（违反规范 §4）
- **文件:** `src/index.ts`
- **行号:** 571, 600, 607, 633, 695
- **代码片段:**
  ```typescript
  // agent_end 处理器 handleAgentEnd 内：
  pi.sendUserMessage(budgetLimitPrompt(session.state, "token"), { deliverAs: "steer" });  // L571
  pi.sendUserMessage(continuationPrompt(session.state), { deliverAs: "followUp" });         // L695
  ```
- **说明:** 规范 §4 明确要求 "agent_end 中禁止启动新的 LLM 调用"。`handleAgentEnd` 内有 5 处 `pi.sendUserMessage` 调用，均会触发新的 LLM 调用。这是自主循环的核心机制，需与平台团队确认是否允许在 `agent_end` 中通过 `sendUserMessage` 续跑。

#### P0-2: `agent_end` 处理器远超 20 行限制（违反规范 §4）
- **文件:** `src/index.ts`
- **行号:** 502-699（`handleAgentEnd` 函数）
- **长度:** 197 行
- **说明:** 规范 §4 要求 "每个事件处理器不超过 20 行"。`handleAgentEnd` 达 197 行。虽然已从工厂函数委托到独立函数，但核心逻辑仍集中在一个巨大函数中。建议按 "预算检查"、"进展评估"、"continuation 决策" 拆分为 ≤20 行的子函数。

### P1 问题

#### P1-1: Tool execute 内部使用 `throw` 表达错误（违反规范 §3）
- **文件:** `src/tool-handler.ts`
- **行号:** 225, 231, 235, 253, 273, 278, 283, 286, 289, 316, 319, 323, 329, 350, 360, 387, 390, 394, 397, 403, 421, 424, 428, 431, 437, 440, 455, 458, 462, 465, 470, 483
- **代码片段:**
  ```typescript
  // tool-handler.ts:225
  throw new Error("Goal mode not active. Use /goal <objective> to start.");
  // tool-handler.ts:483
  throw new Error(`Unknown action: ${params.action}`);
  ```
- **说明:** 规范 §3 明确要求 "错误必须返回 `{ isError: true }`，禁止抛异常"。虽然 `index.ts` 的 `execute` 包装器用 `try-catch` 兜底并转换为 `isError: true`，但 `executeGoalAction` 内部使用了 30+ 处 `throw`。更严重的是 `makeGoalResult` (line 159) 也 `throw`，若未来有人直接调用 `executeGoalAction` 而不包装则会导致未捕获异常。建议在 `executeGoalAction` 内部直接返回 `{ content, isError: true }` 而非 throw。

#### P1-2: 缺少 `isStaleContextError` 保护（违反规范 §6）
- **文件:** 全局缺失
- **说明:** 规范 §6 要求使用 `isStaleContextError` 进行 Stale Context 检测。该 extension 未在任何位置实现此检测。在 session 重建或 goal ID 变更场景下，旧回调可能操作新 goal 的状态。当前代码通过 `snapshotGoalId` + `checkStale()` 手动实现了类似保护，但未使用 SDK 提供的标准 `isStaleContextError` 工具函数。

#### P1-3: 缺少防重入 `isProcessing` 标志（违反规范 §6）
- **文件:** `src/index.ts`
- **说明:** 规范 §6 要求使用 `isProcessing` 防重入标志。当前代码没有防止并发调用的机制。如果 `agent_end` 和 `turn_end` 等事件并发触发，可能导致 `currentTurnIndex` 或 `tokensUsed` 计数不一致。

#### P1-4: `signal` 参数未透传（违反规范 §3）
- **文件:** `src/index.ts` 行 744, `src/tool-handler.ts`
- **代码片段:**
  ```typescript
  // index.ts:744
  async execute(_toolCallId: string, params: Static<typeof GoalManagerParams>,
      _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
  ```
- **说明:** 规范 §3 要求 "异步操作必须透传 signal 参数"。`execute` 接收 `signal` 但完全忽略（前缀 `_`）。虽然当前 tool 操作都是同步内存操作不涉及长时间异步调用，但违反了规范要求。

#### P1-5: `src/index.ts` 文件 900 行，超过单文件 ≤500 行指南（违反规范 §11）
- **文件:** `src/index.ts`
- **行数:** 900 行
- **说明:** 规范 §11 指南要求 "单文件 ≤ 500 行"。当前 900 行虽未超 P0 的 1000 行硬限制，但严重超出指南值。主要贡献者为 `handleGoalCommand`（233 行）和 `handleAgentEnd`（197 行）。

#### P1-6: 多个函数超过 80 行限制（违反规范 §11）
- **文件:** `src/index.ts`
- **清单:**
  | 函数 | 行数 |
  |------|------|
  | `handleGoalCommand` | 233 行 (L147-L379) |
  | `handleBeforeAgentStart` | 122 行 (L380-L501) |
  | `handleAgentEnd` | 197 行 (L502-L699) |
  | `reconstructGoalState` | 63 行 (L84-L146) ✅ |

  **文件:** `src/tool-handler.ts`
  | 函数 | 行数 |
  |------|------|
  | `executeGoalAction` | ~260 行 (L220-L484) |

### P2 问题

#### P2-1: 11 处显式 `any` 类型（违反规范 §7）
- **文件:** `src/index.ts`
- **行号:** 744, 758, 770, 825, 838, 846, 865, 871, 889
- **代码片段:**
  ```typescript
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi event types are typed as `any` in CI stubs
  pi.on("before_agent_start", async (_event: any, ctx: ExtensionContext) => {
  ```
- **说明:** 规范 §7 禁止 `any`。每处都有 `eslint-disable` 注释解释原因（Pi SDK 在 CI stubs 中使用 `any`）。建议定义具体的 event 类型接口替代 `any`，或使用 `unknown` 配合类型守卫。

#### P2-2: 缺少集中 `types.ts` 文件（违反规范 §7）
- **说明:** 规范 §7 要求 "跨文件类型集中到 types.ts"。当前共享类型分散在 `state.ts`（`GoalRuntimeState`, `GoalTask`, `Subtask` 等）、`tool-handler.ts`（`GoalSession`, `GoalManagerDetails`）、`budget.ts`（`BudgetDecision`, `BudgetCheckResult`, `ProgressCheck`）中。建议创建 `src/types.ts` 集中管理所有跨文件类型。

#### P2-3: Import 顺序不完全规范（违反规范 §12）
- **文件:** `src/index.ts` 行 17-18
- **代码片段:**
  ```typescript
  import { Text } from "@mariozechner/pi-tui";        // Pi SDK
  import { type Static } from "typebox";                // npm (should be before Pi SDK)
  ```
- **说明:** 规范 §12 要求 Import 顺序: Node内置 → npm → Pi SDK → 内部包 → 当前包。`typebox`（npm）应排在 `@mariozechner/pi-tui`（Pi SDK）之前。类似问题也出现在 `src/tool-handler.ts` 行 22-23。

#### P2-4: `pi.extensions` 键名嵌套方式（需确认）
- **文件:** `package.json`
- **代码片段:**
  ```json
  "pi": {
    "extensions": ["./src/index.ts"]
  }
  ```
- **说明:** 规范描述 "pi.extensions 数组指向入口 TypeScript 文件"，当前使用嵌套在 `pi` 对象下。这取决于平台是否接受 `{ "pi": { "extensions": [...] } }` 格式（而非顶层 `"pi.extensions": [...]`）。若平台仅支持扁平 `pi.extensions` 键则需修改。

#### P2-5: `@sinclair/typebox` 声明为 peerDependency
- **文件:** `package.json`
- **说明:** `@sinclair/typebox` 是一个 npm 第三方包，被声明为 `peerDependencies` 而非 `dependencies`。虽然这在 monorepo 中可能是合理设计（由宿主提供），但若宿主未安装则会导致运行时错误。

#### P2-6: `state.ts` 中 `as` 类型断言过多
- **文件:** `src/state.ts` 行 191-211（`deserializeState` 函数）
- **代码片段:**
  ```typescript
  goalId: (data.goalId as string) ?? "",
  status: (data.status as GoalStatus) ?? "active",
  ```
- **说明:** `deserializeState` 中使用了 ~20 处 `as` 类型断言，虽然函数签名接受 `Record<string, unknown>` 因此需要断言，但缺少运行时类型校验。如果持久化数据损坏（如 `goalId` 为 number），可能导致难以调试的运行时错误。建议使用 `typeof` 守卫或 TypeBox 运行时校验。

## 优点

1. **架构清晰:** 功能拆分为 state/tool-handler/templates/budget/widget/commands/constants 7 个子模块，职责分明，`index.ts` 作为协调层。

2. **状态机设计严谨:** `transitionStatus` 保护终态不可被覆盖，`GoalStatus` 6 种状态定义清晰，`deserializeState` 有向后兼容旧格式的处理。

3. **GoalId 快照防竞态:** `agent_end` 处理器通过 `snapshotGoalId` + `checkStale()` 防止旧回调操作新 goal，这是很好的防御性编程。

4. **预算策略集中管理:** `budget.ts` 将所有阈值判断和决策逻辑集中，调用者只需通过 `checkBudgetOnTurnEnd` / `checkBudgetOnResume` 获取结果，无需了解阈值细节。

5. **常量语义化:** `constants.ts` 所有 magic number 都有语义化命名（`SECONDS_PER_MINUTE`、`BUDGET_RATIO_HIGH` 等）。

6. **Entry GC 机制:** 自动清理旧的 goal-state entries 和超出上限的 history entries，防止 session 数据膨胀。

7. **Widget 使用语义 token 着色:** `widget.ts` 使用 `theme.fg("success"|"warning"|"error"|"dim"|"muted"|"accent")` 语义 token，符合 TUI 规范。

8. **模板 XML 转义:** `templates.ts` 中 `escapeXmlText` 防止 objective 文本破坏 prompt XML 结构。

## 改进建议

### 短期（P0 修复）
1. **与平台团队确认 `agent_end` + `sendUserMessage` 模式**: 如果这是 Pi extension 自主循环的标准模式（而非 bug），则 §4 的限制可能需要为 goal 类 extension 做例外说明。如果不是，需要将 continuation 逻辑移到 `before_agent_start` 中。

2. **拆分 `handleAgentEnd`**: 按 "终态处理" → "预算检查" → "进展评估" → "stall 检测" → "continuation" 拆分为 5 个独立子函数，每个 ≤20 行，在 `handleAgentEnd` 中按顺序调用。

### 中期（P1 修复）
3. **将 `throw` 替换为 `return { isError: true }`**: 在 `executeGoalAction` 中将所有 `throw new Error(...)` 替换为直接返回 `{ content: [...], isError: true }`，同时 `makeGoalResult` 中 `throw new Error("No active goal")` 也需要替换。

4. **添加 `isProcessing` 防重入标志**: 在 `GoalSession` 中添加 `isProcessing: boolean`，在 `handleAgentEnd` 入口检查并在 finally 中重置。

5. **进一步拆分 `src/index.ts`**: 将 `handleGoalCommand` 拆分为 `commands/handle-status.ts`、`commands/handle-set.ts` 等子文件，使 `index.ts` 降至 500 行以下。

6. **透传 `signal`**: 将 `signal` 传递到 `executeGoalAction` 中，对可能长时间运行的操作（如 `persistGoalState`）检查 `signal.aborted`。

### 长期（P2 改进）
7. **创建 `src/types.ts`**: 将 `GoalSession`、`GoalManagerDetails`、`BudgetDecision`、`BudgetCheckResult`、`ProgressCheck` 等跨文件类型集中管理。

8. **替换 `any` 为具体类型**: 为 Pi SDK 事件定义类型接口（如 `interface TurnEndEvent { ... }`），在 CI 环境中也使用这些类型替代 `any`。

9. **`deserializeState` 添加运行时类型校验**: 使用 `typeof` 守卫替代 `as` 断言，对关键字段（goalId, status, tasks）做类型检查。

10. **调整 import 顺序**: 确保所有文件遵循 Node内置 → npm → Pi SDK → 内部包 → 当前包的顺序。
