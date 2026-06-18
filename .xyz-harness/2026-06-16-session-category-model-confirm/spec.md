---
verdict: pass
---

# Session 首次 Subagent 调用时确认各 Category 模型

## Background

`@zhushanwen/pi-subagents` 扩展已支持「按 category 推荐模型」与「5 级配置链解析模型」。当前模型解析完全静默：LLM 调用 `subagent` 工具时，直接按配置链（param override > per-agent > per-category > category-default > agent-frontmatter > global-fallback）解析出模型并执行，用户无法在本 session 首次使用 subagent 前审视/调整各 category 将用到的模型。

用户期望：**在本 session 第一次执行任何 category 的 subagent 之前，让用户在 TUI input 区域一次性确认所有 category 用什么模型执行**。确认后写入会话级状态，后续不再确认。

## 功能定位

- 仅覆盖 **`subagent` 工具路径**（LLM 直接调用 `subagent` tool）。不覆盖 `workflow` 路径（workflow-run → orchestrator → runtime.runAgent），因为 workflow 有独立的 scene→model 解析链和自己的 confirm 机制。
- 复用现有「会话级 per-category 覆盖」机制（`sessionState.perCategory` + `pi.appendEntry("subagent-model-state")` + `restoreFromEntries`），不引入新的持久化通道。

## Functional Requirements

### FR-1: 首次确认触发点

**FR-1.1** 在 `subagent` 工具的 `execute` 方法中，于模型解析与实际执行**之前**插入确认拦截。需为 `execute` 补上第 5 参数 `ctx: ExtensionContext`（当前签名缺失，见实现变更点 IC-1）。

**FR-1.2 触发判定**（满足全部条件才弹窗）：
- `ctx.hasUI === true`（交互模式；RPC/print 模式跳过确认，直接执行）。
- 本 session 的首次确认尚未完成（`sessionState.categoryConfirmed !== true`，见 FR-3）。
- 不区分 YOLO 状态：**始终触发**（YOLO 在当前代码中仅用于 config-wizard 的 toggle 显示，不参与执行决策——见 tracing G-014 验证）。
- 不区分是否显式传 model：**全部覆盖**。

**FR-1.3 拦截点定位**：在 `assertAgentExists()` 之后、`effectiveWait` 判定之前（`subagent-tool.ts` 约第 285~288 行之间）。
- 此拦截点位于 `backgroundId` 查询分支（已 return）之后，故查询模式不触发。
- 此拦截点位于 sync/background 分支之前，故两种执行模式都覆盖。
- **注意**：拦截点处尚未调用 `resolveModelForAgent`（它在 effectiveWait 之后，约第 303 行）。因此弹窗内的「每个 category 当前模型」需由弹窗逻辑自行批量解析（见 FR-2.4），而非复用 tool 层的单次解析结果。

### FR-2: 确认交互（平铺组件 + 二级菜单）

**FR-2.0 交互形态**：通过 `ctx.ui.custom(factory, { overlay: false })` 在 **TUI input 区**渲染一个常驻自定义组件（替换 editorContainer，接管键盘焦点）。组件内部状态机管理三个视图：category 平铺列表（主视图，常驻）、model 二级菜单、thinking level 子菜单。这是对「串行 `ctx.ui.select`」的升级——一次性平铺所有 category，方向键导航，下钻二级菜单改模型。组件实现为裸 `Component` 类（实现 `render`/`invalidate`/`handleInput`），不 extends Container。

**FR-2.1 主视图（category 平铺列表，常驻）**：
- 一屏平铺所有 category（FR-2.5），每行显示 category 名 + 当前模型。
- 当前模型用**下划线**标注（`theme.underline`）；已被用户修改的行额外标绿色 ✱ 和「(已修改)」。
- 选中行（光标）accent 高亮 + `→` 前缀。
- 列表底部含两个**虚拟项**：`✓ 完成确认`（success 色）、`✗ 取消`（error 色）。
- 底部快捷键提示行。
- **默认光标位置**：组件进入时默认在 `✓ 完成确认`（满足「进来即可一键确认」预期），用户无需任何操作直接 Enter 即可全部用默认完成。
- 方向键 ↑↓ 在所有行（含虚拟项）间移动；main 视图额外支持 j/k（此视图无 filter 输入，j/k 安全）。
- Enter：若光标在 category 行 → 进入该 category 的二级菜单（FR-2.2）；若在 `✓ 完成确认` → 提交（FR-2.3）；若在 `✗ 取消` → 取消（FR-4）。
- Esc → 取消整个确认（FR-4）。

**FR-2.2 二级菜单（model 选择，带 filter）**：选中某 category + Enter 后，组件切换到该 category 的二级菜单（替换主视图内容）：
- 标题显示 `[category] 选择 model`，附 filter 文本（若非空）。
- filter 输入：用户打字实时过滤模型列表（可打印字符追加、Backspace 删除）。
- 下方模型列表。reasoning 模型标 `[reasoning]`。
- 方向键 ↑↓ 在过滤结果里选（二级菜单**不支持 j/k**，避与 filter 文本输入冲突）；Enter 选定 → 进入 thinking 子菜单（FR-2.7，仅 reasoning 模型有可用级别时）或直接写 override（非 reasoning）；Esc 返回主视图（不写）。
- 模型列表来源：`ctx.modelRegistry.getAvailable()`。

**FR-2.3 完成确认（提交）**：主视图中光标移到 `✓ 完成确认` + Enter → 提交。仅写入用户**实际改动过**的 category（未改的不写 perCategory 覆盖），然后标记 `categoryConfirmed=true`（FR-3）。

**FR-2.4 批量解析当前模型**：组件构造时（拦截点）对 `globalConfig.categories` 的每个 category 调用解析逻辑（复用 `mergeConfig`，参数 category 来自遍历），得到每个 category 的当前模型字符串，用于主视图的展示。

**FR-2.5 category 列表来源**：`globalConfig.categories` 的全部 key（6 个默认 + 用户自定义且未被删除的）。`agentCategoryOverrides` 不影响列表（它只是 agent→category 映射，不增加 category 数量）。

**FR-2.6 filter 实现（子串匹配，case-insensitive）**：二级菜单的 filter **自行实现**子串匹配（非 fuzzy，非 SelectList.setFilter）：对 `${provider}/${id} ${name}` 做小写子串包含判断。filter 文本变化时重新计算过滤列表，重置光标到 0。理由：SelectList.setFilter 用 `value.startsWith` 既非模糊也只匹配 value；本实现用子串匹配覆盖 id/name，足够实用且实现简单（YAGNI，不引入 fuzzy 库）。

**FR-2.7 thinking level（默认最高 + 可调）**：选中 model 后，若该 model 有可用 thinking level（通过 `availableThinkingLevels(model)` 从 `thinkingLevelMap` 提取，按 `THINKING_ORDER` 升序），弹出 thinking 子菜单：
- 子菜单标题 `[category · provider/model] thinking level（默认最高）`。
- 列出该模型实际支持的级别（不同模型支持的级别不同，由 `thinkingLevelMap` 决定）。
- **默认光标在最高级别**（THINKING_ORDER 末位），符合「进来即最优」预期。
- 方向键 ↑↓ 选；Enter 写入选定级别 + 返回主视图；Esc 用默认最高写入 + 返回主视图（即「跳过」= 用最高，不丢弃 override）。
- 非 reasoning 模型或无可用级别（`availableThinkingLevels` 返回空）→ 跳过此步，直接写 override（thinkingLevel = undefined）。

**FR-2.8 组件技术约束**：
- 组件实现裸 `Component` 接口（`render(width): string[]` + `invalidate()` + `handleInput?(data)`），不 extends Container。
- 用 `matchesKey(data, "up"/"down"/"enter"/"return"/"escape")`（pi-tui）+ `keybindings.matches(data, "tui.select.up/down/confirm/cancel")` 识别方向键/确认/取消（兼容 legacy/Kitty/modifyOtherKeys 全编码族）。
- 着色用 factory 第 2 参 `theme`（duck-type 为 `ThemeLike`，有 `fg`/`bg`/`bold`/`underline`）。Pi Theme 无 `dim()` 方法——dim 文本一律 `fg("dim", ...)`。不调 `bg()`（input 区背景由 editorContainer 管）。
- `done(result)` 通过 `custom()` 的 factory 第 4 参 `done` 回调返回 `{ action, overrides }`，Promise resolve 该结果。
- 三视图状态机：`main` / `modelSelect` / `thinkingSelect`，`handleInput` 按 `view` 分派。

### FR-3: 会话级持久化

**FR-3.1 原子批量写**：逐 category 确认走完后，**一次性**将所有被修改的 category 写入 `sessionState.perCategory`，并在**同一次** `persistState()` 调用中标记 `categoryConfirmed = true`（避免产生两条 entry 导致 restoreFromEntries 取最新条时字段不一致——见 tracing G-010）。

**FR-3.2 「已确认」标志**：
- 在 `SessionModelState` **新增字段** `categoryConfirmed: boolean`（默认 `false`）。
- 标志 = 「本 session 内首次确认流程已完成」。
- 已确认后，后续所有 `subagent` 工具调用跳过确认拦截，直接执行。
- **必须同步修改** `serializeState` 和 `restoreState`（`session-model-state.ts`）以处理新字段——否则 appendEntry 写了 `categoryConfirmed`，restore 时会被丢弃（见 tracing G-008）。
- `createSessionModelState` 默认 `categoryConfirmed: false`（见 tracing G-009）。

**FR-3.3 跨 session 恢复**：
- **`/resume`**：恢复最新 entry 的 `categoryConfirmed` + `perCategory`。已确认则不弹（perCategory 覆盖一并恢复）。
- **`/fork`**：fork 出的新 session **继承 fork 点的状态**——若 fork 点已有确认 entry，则新 session 已确认；否则未确认。复用现有 `restoreFromEntries` 逻辑，不需特殊处理（fork 复制原 session 的 entries）。
- **`/new`**：新 session 无 entries → `restoreFromEntries` 找不到 entry → sessionState 重置为 `createSessionModelState` 默认（`categoryConfirmed: false`，perCategory 为空）→ 需重新确认。

**FR-3.4** 复用现有 `SubagentRuntime.setSessionCategoryModel()` 写入 perCategory。需新增一个「批量写 + 标记已确认」的 runtime 方法，保证二者在同一次 `persistState()` 中完成（FR-3.1）。

### FR-4: 取消行为

**FR-4.1** 用户在**主视图**（FR-2.1）选 `✗ 取消` 虚拟项或按 Esc 时：
- **取消本次 subagent 调用**：`execute` 抛错，错误信息明确写「用户主动取消了模型确认，不要重试，请向用户说明情况」。
- **不标记已确认**：`categoryConfirmed` 保持 `false`，下次 subagent 调用会再次弹窗。
- **不写入任何 perCategory**（取消发生在提交之前，组件内的修改未持久化）。
- 不影响其它工具调用或主对话。

**FR-4.2 LLM 重试闭环**：取消错误信息中明确提示「不要重试」，依靠 LLM 遵守指令。不做退避机制（YAGNI）。若反复出现弹窗-取消，用户可通过 `/subagents config` 现有入口调整，或选「全部用默认并记住」跳过。

### FR-5: 交互入口（UI 能力）

**FR-5.1** 通过 `subagent` 工具 `execute` 的第 5 参数 `ctx: ExtensionContext` 获取 `ctx.ui`（`ExtensionUIContext`），调用 `ctx.ui.custom(factory, {overlay:false})` 在 TUI input 区域渲染自定义确认组件（FR-2）。组件 factory 接收 `(tui, theme, keybindings, done)`。

**FR-5.2** `ctx.hasUI === false`（RPC/print 模式）时**完全避免调用 ctx.ui.\***，跳过整个确认流程，直接执行 subagent。不能假设 RPC 模式的 ui 实现会优雅返回（见 tracing G-018）。

### FR-6: 覆盖范围与排除

**FR-6.1 覆盖**：`subagent` 工具的 sync 模式和 background 模式（`effectiveWait` 的两个分支），只要不是查询模式。

**FR-6.2 不覆盖**：
- 查询模式（`backgroundId` 路径）——不产生新执行。
- `workflow` 路径（`workflow-run` → orchestrator → `runtime.runAgent`）——有独立 scene→model 链。
- `runtime.runAgent` / `createManagedSession` / `startBackground` 的直接编程调用（非工具路径）。

## 实现变更点（Implementation Changes，供 Phase 2 参考）

| ID | 变更 | 文件 |
|----|------|------|
| IC-1 | `subagent-tool.ts` 的 `execute` 补第 5 参数 `ctx: ExtensionContext` | `src/tools/subagent-tool.ts` |
| IC-2 | 新写「category-confirm 自定义组件」（裸 Component 类，handleInput 三视图状态机：main 平铺 + modelSelect 二级菜单 + thinkingSelect 子菜单；filter 子串匹配；thinking 默认最高）。通过 `ctx.ui.custom(factory, {overlay:false})` 在 input 区渲染。**不直接复用** `editCategoryModel` | `src/tui/category-confirm.ts`（重写） |
| IC-3 | `SessionModelState` 新增 `categoryConfirmed: boolean` 字段 | `src/types.ts` |
| IC-4 | `serializeState` / `restoreState` / `createSessionModelState` 同步处理 `categoryConfirmed` | `src/state/session-model-state.ts` |
| IC-5 | `SubagentRuntime` 新增「批量写 perCategory + 标记已确认（同一次 persistState）」方法 | `src/runtime.ts` |
| IC-6 | `subagent-tool.ts` 在 assertAgentExists 之后、effectiveWait 之前插入确认拦截：调 `ctx.ui.custom(CategoryConfirmComponent factory)`，读 `sessionState.categoryConfirmed` | `src/tools/subagent-tool.ts` |
| IC-7 | 批量解析所有 category 当前模型的 helper（遍历 `globalConfig.categories` 跑 mergeConfig） | `src/tui/batch-model-resolver.ts`（已实现，复用） |

## Acceptance Criteria

### AC-1: 首次确认触发（sync 模式）
**Given** 全新 session，`ctx.hasUI=true`，`categoryConfirmed=false`
**When** LLM 调用 `subagent` 工具（sync 模式）
**Then** 在 subagent 实际执行前于 input 区渲染确认组件（`ctx.ui.custom`）；用户完成确认前 subagent 不执行。

### AC-2: 首次确认触发（background 模式）
**Given** 同 AC-1
**When** LLM 调用 `subagent` 工具（`wait:false`，background 模式）
**Then** 同样弹出确认弹窗；确认完成后才启动 background agent。

### AC-3: 确认后不再弹
**Given** 本 session `categoryConfirmed=true`
**When** 后续任意次数、任意 category 的 `subagent` 调用
**Then** 不再弹窗，直接用确认结果（或配置默认）执行。

### AC-4: 取消则取消本次调用
**Given** 确认组件已渲染（主视图）
**When** 用户移到 `✗ 取消` 虚拟项 + Enter，或按 Esc
**Then** 本次 subagent 调用被取消（execute 抛错，错误信息含「用户主动取消，不要重试」）；`categoryConfirmed` 仍为 `false`；下次 subagent 调用重新渲染组件；不写入任何 perCategory。

### AC-5: RPC 模式跳过
**Given** `ctx.hasUI=false`
**When** `subagent` 工具调用
**Then** 不弹窗，不调用 ctx.ui.\*，直接执行。

### AC-6: 不改任何 category 直接完成
**Given** 确认组件主视图已渲染
**When** 用户不改任何 category，直接移到 `✓ 完成确认` + Enter
**Then** 所有 category 保留当前配置模型（不写 perCategory 覆盖）；`categoryConfirmed=true`；后续不弹窗。

### AC-7: 模型选择写入会话级
**Given** 用户在某 category 的二级菜单中选了新模型
**When** 返回主视图后移到 `✓ 完成确认` + Enter 提交
**Then** 新模型写入 `sessionState.perCategory[category]`（与 `categoryConfirmed=true` 在同一次 persistState）；后续该 category 的 subagent 调用使用新模型；**不修改全局 config.json**。

### AC-8: 持久化与恢复（resume）
**Given** 本 session `categoryConfirmed=true` 且有 perCategory 覆盖
**When** `/resume` 该 session
**Then** `categoryConfirmed` 和 perCategory 覆盖正确恢复；后续不弹窗。

### AC-9: 查询模式不触发
**Given** 任意 session 状态
**When** `subagent` 工具带 `backgroundId` 查询已完成任务
**Then** 不弹窗。

### AC-10: 不影响 workflow
**Given** 任意 session 状态
**When** 通过 `workflow-run` 工具触发 workflow（其内部调 runtime.runAgent）
**Then** 不触发本功能的确认弹窗（workflow 有自己的机制）。

### AC-11: 主视图平铺 + 下划线
**Given** 确认组件主视图已渲染
**When** 渲染 category 行
**Then** 每个 category 的当前模型用下划线标注；选中行青色高亮 + `→`；已改行绿色 ✱ + 「(已修改)」；底部有 `✓ 完成确认`/`✗ 取消` 虚拟项。

### AC-12: 二级菜单 Esc 返回主视图
**Given** 在某 category 的二级菜单（model 选择）中
**When** 用户按 Esc
**Then** 返回主视图，不写入该 category 的修改（保留其之前状态）；不取消整个流程。

### AC-13: fork 继承状态
**Given** 原 session `categoryConfirmed=true`
**When** 从一个已有确认 entry 的点 `/fork`
**Then** fork 出的新 session `categoryConfirmed=true`，不弹窗。

### AC-14: new 重置
**Given** 任意原 session 状态
**When** `/new` 新建 session
**Then** `categoryConfirmed=false`，perCategory 为空，首次 subagent 调用重新弹窗。

## Constraints

- **语言/运行时**：TypeScript（`type: module`），Node.js，jiti 运行时加载。
- **UI 能力**：用 `ctx.ui.custom(factory)` 渲染自定义组件（pi-tui 的 Container/Text/SelectList/Input）。不引入 config-wizard 外的新 TUI 库依赖（pi-tui 已是项目依赖）。
- **不修改全局配置**：确认结果只写会话级（`sessionState.perCategory`），绝不写 `~/.pi/agent/subagents/config.json`。
- **不破坏现有 5 级配置链**：确认结果作为 per-category 覆盖插入链中（优先级第 3 级），不改变 mergeConfig/resolveModelForAgent 的既有逻辑。
- **mock 兼容**：新增的 UI 交互需在 `mocks/pi-tui.ts` 桩下可测试。
- **向后兼容**：现有直接调用 `runtime.runAgent` 的编程调用方（workflow 等）行为不变。

## 业务用例

### UC-1: 开发者首次用 subagent 做代码审查
- **Actor**: 开发者（通过 LLM 交互）
- **场景**: 开发者让 LLM「review src/auth 的错误处理」，LLM 调 `subagent` 工具委派给 reviewer agent（coding category）。
- **预期结果**: 首次调用时弹窗，开发者逐个确认/调整各 category 模型（可批量跳过）；确认后 reviewer 用选定模型执行；后续 review 不再弹窗。

### UC-2: 开发者想跳过确认直接用默认
- **Actor**: 开发者
- **场景**: 开发者对当前 category 模型配置满意，首屏选「全部用默认并记住」。
- **预期结果**: 所有 category 保留默认，`categoryConfirmed=true`，本 session 后续不弹窗。

### UC-3: 开发者取消确认
- **Actor**: 开发者
- **场景**: 首屏弹窗时开发者误触或临时不想执行，选「取消」。
- **预期结果**: 本次 subagent 调用取消，LLM 收到含「不要重试」的取消错误；`categoryConfirmed` 仍 false，下次调用重新弹窗。

### UC-4: CI/RPC 环境
- **Actor**: 自动化脚本（RPC 模式）
- **场景**: 无 TUI 的 RPC 模式下调 subagent 工具。
- **预期结果**: 不弹窗（不调用 ctx.ui.\*），直接用配置模型执行。

### UC-5: 开发者逐个确认时跳过某些 category
- **Actor**: 开发者
- **场景**: 逐个确认中，开发者只想改 coding 和 research 两个 category 的模型，其余保留。
- **预期结果**: 对 coding/research 走级联选择新模型；对其余 category 按 Esc 跳过（保留当前）或选「剩余全部保留默认」；走完后只有 coding/research 写入 perCategory。
