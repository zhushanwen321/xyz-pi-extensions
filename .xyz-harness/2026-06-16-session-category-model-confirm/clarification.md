# Clarification Log — Session 首次 Subagent 调用时确认各 Category 模型

## 已澄清决策（来自与用户的交互提问）

### D-1: 确认时机
**决策**: session 内**首次任意 subagent 调用时**，一次性弹出确认所有 category 的模型。
**推理**: 避开「静态枚举 workflow 动态脚本中所有 category」的难题——不需要预知会用到哪些 category，而是在第一次有 subagent 要执行时，把所有 category 一次性列出。
**否决方案**: 「提前静态批量枚举所有 category」——workflow worker 脚本是动态 JS（含条件/循环/数据驱动分支），agent 调用运行时才确定，无法在启动前静态收集。

### D-2: 确认范围
**决策**: 全量展示所有 category（6 默认 + 自定义），用当前已配置模型作为默认预选，可批量跳过。
**否决方案**: 「只确认可能用到的」——无法准确判断「可能用到」（workflow 动态、subagent 工具由 LLM 运行时决定）。

### D-3: 确认默认值
**决策**: 用当前 5 级配置链解析出的模型作为每个 category 的预选默认。用户不改则保留。

### D-4: 触发条件与 YOLO
**决策**: **始终触发（不管 YOLO）**。YOLO 现仅影响 config-wizard 的 toggle 语义，不参与本功能。
**注意**: 需在 Step 3 复核 YOLO 语义是否真的与本功能无关（避免与未来 YOLO 扩展冲突）。

### D-5: 取消行为
**决策**: 取消则**取消本次调用**（execute 抛错，错误信息含「用户取消」），不标记已确认，下次再弹。

### D-6: 确认粒度
**决策**: 每个 category 走 **provider→model→thinking 三步级联**（复用现有 `editCategoryModel` 逻辑）。

### D-7: 存储粒度
**决策**: **会话级**（复用现有 `sessionState.perCategory` + `pi.appendEntry` + `restoreFromEntries`）。不写全局 config.json。

### D-8: RPC 模式
**决策**: `ctx.hasUI=false` 时跳过确认，直接执行。

### D-9: 覆盖路径
**决策**: **只覆盖 subagent 工具路径**。不覆盖 workflow（有独立 scene→model 链 + 自己的 confirm）。

### D-10: 显式 model 参数处理
**决策**: **全部覆盖**，显式 model 作为弹窗中该 category 的预选默认值（不跳过确认）。

## 已验证的事实（代码级）

### F-1: subagent 工具 execute 可获取 ctx.ui
**事实**: `ToolDefinition.execute` 签名是 `(toolCallId, params, signal, onUpdate, ctx: ExtensionContext)`。第 5 参数 `ctx` 含 `ctx.ui: ExtensionUIContext`（select/input/confirm/notify）和 `ctx.hasUI`。
**现状**: 当前 `subagent-tool.ts` 的 execute **只用了前 4 参数，忽略了 ctx**。需补上第 5 参数。
**验证**: `grep "execute(" pi-coding-agent types.d.ts` → 确认第 5 参数为 `ctx: ExtensionContext`。

### F-2: 会话级 per-category 覆盖机制已存在
**事实**: `SessionModelState.perCategory: Record<string, {model, thinkingLevel}>`，通过 `setCategoryModel()` 写入，`serializeState()` 序列化，`pi.appendEntry("subagent-model-state")` 持久化，`restoreFromEntries()` 倒序取最新恢复。
**影响**: FR-3 可完全复用，无需新增持久化通道。

### F-3: 5 级配置链
**事实**: `mergeConfig` 优先级 param > per-agent > per-category > category-default > agent-default > global-fallback。确认结果写入 per-category（第 3 级），低于 param override。
**影响**: 与 D-10 一致——显式 param 仍最高优先级，但确认弹窗会用 param 值作为预选（展示层），用户不改则 per-category 写入会被 param 覆盖（需在 Step 3 复核这个交互是否让人困惑）。

### F-4: config-wizard 的 editCategoryModel 可复用
**事实**: `editCategoryModel(ui, category, config, homeDir, modelRegistry, isNew)` 已实现 provider→model→thinking 三步级联，写到全局 config。
**影响**: 需改造一个变体，写入 `sessionState.perCategory` 而非全局 config。

### F-5: workflow 路径不经过 subagent 工具
**事实**: `workflow-run` → `orchestrator.run` → worker 脚本 → `AgentPool.enqueue` → `runtime.runAgent()`，全程不经 `subagent` 工具 execute。
**影响**: 仅在 subagent 工具 execute 拦截即可天然不覆盖 workflow（D-9）。

### F-6: 拦截点定位
**事实**: subagent-tool.ts execute 流程：`getRuntime` → `backgroundId 查询分支(返回)` → `task 校验` → `assertAgentExists` → `effectiveWait 判定` → model 解析 → `sync/background 分支`。
**拦截点**: 在 `assertAgentExists` 之后、`effectiveWait` 判定之前。此处 sync/background 两分支都覆盖，查询分支已 return。

## Step 3 追踪结果与 Step 4 处理（tracing-round-1.md 的 18 个 gap）

### 已解决的 gap（决策记录）

| Gap | 类型 | 决策 |
|-----|------|------|
| G-001 | F→D | `ctx.ui.select` 无预选能力（已验证：`ExtensionUIDialogOptions` 仅 signal/timeout）。决策：采用 **(current) 置顶伪预选**——当前 provider/model 作为 options 第一项标注 (current)，光标默认第 0 项，回车=保留。不用 `ctx.ui.custom()` 自建组件。 |
| G-002 | F | `editCategoryModel` 不可直接复用（无保留/跳过能力、不展示当前值、强制重选）。决策：**新写「批量逐 category 确认」组件**（IC-2），不直接复用。 |
| G-003 | F→D | 逐 category 中途 Esc 语义。决策：**中途 Esc = 仅跳过当前 category，继续下一个**（不取消整个流程）。只有首屏入口取消才取消整个。 |
| G-004 | D | （并入 G-001）预选用 (current) 置顶伪预选。 |
| G-005 | F | 拦截点描述修正：拦截点在 effectiveWait 之前正确，但 resolveModelForAgent 在 effectiveWait 之后。决策：spec FR-1.3 已修正说明，FR-2.4 新增「弹窗内批量解析」逻辑。 |
| G-006 | K | category 列表来源。决策：**globalConfig.categories 全部**（6 默认 + 自定义未删除的）。agentCategoryOverrides 不影响列表。 |
| G-007 | D | 逐 category 原子性。决策：**原子批量写**——走完所有 category 后一次性写 perCategory + 标记 categoryConfirmed（FR-3.1）。中途 Esc 跳过的 category 不写入（保留当前），已处理的也不立即写（直到全部走完）。 |
| G-008 | F | SessionModelState 无 categoryConfirmed，serialize/restore 必须同步改。决策：IC-3/IC-4 已列入实现变更点。 |
| G-009 | F | /new 应重置。决策：FR-3.3 已明确 /new 重置为默认（createSessionModelState 默认 false）。 |
| G-010 | F | persistState 必须合并。决策：FR-3.1 原子批量写 + IC-5 新增 runtime 方法保证同一次 persistState。 |
| G-011 | F | execute 缺第 5 参数 ctx。决策：IC-1 已列入。 |
| G-012 | F | indexOf 重名 bug。决策：新组件用稳定标识（provider/modelId）回查而非展示串 indexOf，避免继承 bug。 |
| G-013 | F | LLM 重试循环。决策：错误信息明确写「不要重试」，不做退避机制（YAGNI）。FR-4.2。 |
| G-014 | F | YOLO 解耦验证通过，D-4 成立。无需改 spec。 |
| G-015 | F | 并发竞态不存在（executionMode=sequential）。无需改 spec。 |
| G-016 | F | 批量解析缺失。决策：IC-7 新增批量解析 helper，FR-2.4。 |
| G-017 | K | /fork 行为。决策：**继承 fork 点状态**（FR-3.3）。 |
| G-018 | F | RPC 模式 hasUI 检查正确，FR-5.2 已明确完全不调 ctx.ui.*。 |

### 关于 D-10 + F-3（显式 param 与 perCategory 优先级）

追踪确认：param override（最高优先级）会覆盖 perCategory（第 3 级）。用户在弹窗为某 category 选了模型并写入 perCategory，但若该次调用 LLM 显式传了 model，最终执行仍用 param override。
决策：**不在弹窗中特殊说明此点**——确认的语义是「为后续该 category 的所有调用设定会话级默认」，不是「覆盖本次的显式 param」。显式 param 是调用方明确意图，理应优先。spec 未把 param 作为预选（G-001 否决了预选），改用 (current) 置顶，故此矛盾在修订后的 spec 中已消解。

### 收敛状态

18 个 gap 全部处理完毕，无 [UNRESOLVED]。进入 Step 5 收敛复核。
