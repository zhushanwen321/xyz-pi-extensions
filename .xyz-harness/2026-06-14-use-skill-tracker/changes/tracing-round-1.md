# Tracing Round 1

## 追踪范围

- spec 初稿版本：skill-execution tracker 触发机制重设计 — use_skill 主动声明（初稿含 FR-1~FR-6 + AC-1~AC-8）
- 追踪的视角：User Journey / Data Lifecycle / API Contract / State Machine / Failure Path（全部 5 视角，无降级）

**降级说明**：本需求虽是 Pi Extension 内的工具/状态机改造，但同时涉及 API 契约（use_skill tool schema）、状态机（FR-3 六状态）、数据生命周期（序列化/反序列化/GC）和失败路径，全部 5 视角均有实质追踪内容。按「工具/脚本」类型降级 User Journey 以外的视角不适用，但本需求的状态机和数据模型改造足够重大，强行降级会漏掉关键 gap。

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-001 | F | API Contract | types.ts:89-97 | `TrackerParams` 的 `action` 枚举当前为 `["update", "list"]`，`status` 枚举为 `["completed", "error", "recorded", "dismissed"]`。FR-1 新增 `start` action，FR-3 将 dismissed 替换为 cancelled 并新增 abandoned。`TrackerParams` 是 `createTracker` 框架的**共享 schema**——所有 tracker 复用。修改此 schema 会改变所有 tracker 的工具接口。需要确认：是修改共享 schema（所有 tracker 都获得 start action），还是 skill-execution 不走 createTracker 的 tool 注册路径而单独注册 tool？ |
| G-002 | F | API Contract | FR-2 | `use_skill(action=start, name, path?)` 需要 `name`（必填）和 `path`（可选）参数，但当前 `TrackerParams` 不包含这两个字段。start action 的参数空间与 update/list 完全不同——update 需要 id+status，start 需要 name+path。如何在一个共享 schema 中表达？是否需要参数联合类型（start 时 name 必填，update 时 id+status 必填），还是 skill-execution 绕过 TrackerParams 自定义参数？ |
| G-003 | D | State Machine | core.ts:171-193 / FR-1,FR-5 | 当前 `createTracker` 框架将 item 创建耦合在 `triggerEvent` handler 内（core.ts:171-193）。FR-1 要求创建改为 tool action（start），FR-5 要求废弃被动监听。这意味着 skill-execution 的创建逻辑需要从 event handler 移到 tool execute handler。**架构决策**：(A) 让 `createTracker` 支持可选的 `triggerEvent`（不传则不注册 event listener），创建逻辑由 tracker 自己在 tool handler 中实现；(B) skill-execution 绕过 `createTracker`，自行注册 tool 和事件——但这丢弃了框架的 persistState/remind/GC 等样板逻辑。倾向 A，但需要框架改动。 |
| G-004 | F | State Machine | types.ts:15-36 | `TERMINAL_STATUSES` 当前为 `Set(["completed", "recorded", "dismissed"])`。FR-3 终态变为 completed/recorded/cancelled/abandoned（4 个）。`ALLOWED_TRANSITIONS` 从 2 条映射变为更复杂的矩阵。`TrackedItemStatus` 联合类型也需要更新（dismissed → cancelled + 新增 abandoned）。这些是 `types.ts` 的核心导出，改动会影响 serialize/deserialize、canTransition、isTerminalStatus 等所有下游消费方。spec 已描述了目标状态机，但实现层面的改动范围（多少文件、多少行需要联动修改）未被显式评估。 |
| G-005 | D | State Machine | FR-3 转换矩阵 / FR-4 | FR-4 仅对 `loaded` 状态检查 abandoned（turnsSinceLoad >= abandonThreshold）。但 `error` 状态的 item 如果永远未被 update，也会成为僵尸。当前转换矩阵 error → cancelled 允许 agent 手动放弃，但 agent 也可能遗忘 error item。是否需要 error → abandoned 的系统自动转换？如果不支持，error 僵尸 item 会在 reconstructState 中被保留（因为 error 不是终态），每次 session restore 都会触发 onContextRestore steering，造成无意义的提醒噪音。 |
| G-006 | F | State Machine | core.ts:90 / FR-4 | `TrackerConfig` 接口（core.ts:66-101）当前有 `remindInterval` 和 `errorThreshold`，但没有 `abandonThreshold`。FR-4 需要 `abandonThreshold` 作为配置项（默认 20）。需要在 `TrackerConfig` 接口中新增此字段，并在 `turn_end` handler 中使用。另外，`turn_end` 中 remind 和 abandoned 的执行顺序也需要明确（见 G-009）。 |
| G-007 | K | Data Lifecycle | spec FR-3 [UNVERIFIED] / types.ts:125-145 | spec 明确标记为 `[UNVERIFIED]`："遇到旧 dismissed 字符串的具体处理策略——丢弃该 item / 当作 cancelled 映射 / 当作 loaded。plan 阶段定，倾向丢弃"。`deserializeState`（types.ts:125-145）当前通过 `(raw.status as TrackedItemStatus) ?? "loaded"` 反序列化，旧 dismissed item 会被原样恢复。新状态机不认识 dismissed，`canTransition("dismissed", ...)` 全部返回 false，`isTerminalStatus("dismissed")` 也返回 false（如果从 TERMINAL_STATUSES 移除）。**两种方案**：(A) deserialize 时遇到 dismissed 直接丢弃该 item（从 items 数组中过滤掉）；(B) 映射为 cancelled（保留数据但改变语义）。方案 A 更干净但丢失历史数据，方案 B 保留数据但语义不精确（dismissed 本意是"误报"，cancelled 是"主动放弃"）。需要用户决策。 |
| G-008 | K | User Journey | FR-2 | `use_skill(action=start, name)` 的 `name` 参数描述为"从 available_skills 列表获取"。但 tool execute handler 中是否需要校验 name 合法性？如果 agent 传入一个不存在的 skill 名称（如拼写错误），是否 (A) 正常创建 TrackedItem（name 可以是任意字符串），还是 (B) 校验后拒绝？当前被动监听方案中 name 从 SKILL.md 路径提取（有硬校验），新方案中 name 来自 agent 自由输入，校验策略不同。 |
| G-009 | F | State Machine | core.ts:265-285 / FR-4 | `turn_end` handler 中，remind 在 `turnsSinceLoad >= remindInterval` 时触发，且 `turnsSinceRemind >= remindInterval` 时重复触发。FR-4 在 `turnsSinceLoad >= abandonThreshold`（= 20）时强制 abandoned。**冲突场景**：turn 20 时，remind 条件满足（20 >= 10 且 10 >= 10），abandoned 条件也满足（20 >= 20）。如果先执行 remind 再执行 abandoned，agent 收到一个无意义的提醒然后 item 立即变终态。如果先执行 abandoned 再检查 remind，remind 被跳过。需要明确：(A) abandoned 检查在 remind 之前（跳过即将 abandon 的 item 的 remind）；(B) 顺序无关（abandoned 后 item 变终态，后续轮次不再 remind）。倾向 A。 |
| G-010 | F | Failure Path | run_tests.mjs:159-174 | `run_tests.mjs` 有 12 个测试用例，其中 TC-3-03 和 TC-3-04 专门测试 dismissed 转换。TC-2-01~TC-2-04 测试被动监听的 triggerMatch。FR-5 废弃被动监听后这些测试全部失效。AC-7 要求 `run_tests.mjs` 全过，所以这些测试需要**重写**而非仅修改。新测试应该覆盖：(A) use_skill(start) 创建逻辑；(B) 新状态机转换矩阵；(C) abandoned 自动转换；(D) 名称/参数校验。spec 未提及测试重写的具体范围。 |
| G-011 | K | Failure Path | index.ts:105 / FR-1 | `index.ts` 调用 `createTracker(pi, skillExecutionConfig)` 注册 tracker。FR-1 废弃 `skill_state` tool，新 tool 名为 `use_skill`。tool 名称变更意味着：(A) 旧 session 中 agent 正在使用 `skill_state`，更新扩展后旧 tool 名失效；(B) Pi 的 tool 注册是否支持动态替换同名 tool？如果不能，需要确认扩展更新时的行为。此外，`skillExecutionConfig` 对象需要大量修改（toolName、description、promptSnippet、promptGuidelines、triggerEvent/triggerMatch 等），spec 未显式列出配置变更清单。 |
| G-012 | D | API Contract | FR-6 | spec 明确指出 "description 是方案可靠性关键" 且 "具体措辞 plan 阶段定"。这是本需求**最核心的设计元素**——description 决定了 agent 是否正确理解何时调用 start。如果措辞不够精确，会要么过度触发（误报零容忍目标失败），要么触发不足（漏报过多）。虽然 spec 标注了"plan 阶段定"，但作为追踪者必须指出：description 措辞不是 plan 阶段的实现细节，而是**需求级别的关键设计决策**。措辞的判断标准（什么叫"决定执行" vs "调研"）需要在 spec 层面定义，plan 只负责措辞润色。 |
| G-013 | F | Data Lifecycle | types.ts:69-76 | `TrackerDetails` 接口的 `action` 字段类型为 `"update" \| "list"`。FR-1 新增 start action 后，需要添加 `"start"` 变体。同时，`details` 返回值在 start 场景下包含什么？update 返回 `{action: "update", items, updatedId}`，list 返回 `{action: "list", items}`，start 应返回 `{action: "start", items, createdId}`？还是只返回新 item 的 id？这个返回值结构影响 GUI 渲染描述符（`_render` 协议）的设计。spec 未定义 start action 的 details 返回结构。 |
| G-014 | K | User Journey | FR-2 / AC-1 | FR-2 说"每次 start 独立创建新 TrackedItem，不去重"，AC-1 验证"连续两次 start 同名 skill 产生两个独立 item"。但**没有上限约束**。如果 agent 因为 bug 或 description 歧义反复调用 start，会在 items 数组中堆积大量 loaded item，每个都触发 remind steering。是否有最大并发 item 数量限制？或者超过 N 个 loaded item 时拒绝新 start？ |
| G-015 | D | Failure Path | core.ts:183-199 / FR-4 | `reconstructState`（session restore 时调用）只过滤终态 item，不检查 abandoned 条件。场景：agent start 后 session compact/reload，`currentTurnIndex` 从 entry count 重建。如果旧 item 的 loadedAtTurn 距离新 turnIndex 已超 abandonThreshold，但 session restore 期间没有 `turn_end` 事件触发，该 item 会保持 loaded 状态直到下一个 `turn_end`。这是否可接受？还是需要在 `reconstructState` 中也做 abandoned 检查？ |
| G-016 | F | Data Lifecycle | types.ts:44-46 / FR-3 | `TrackedItemStatus` 是 exported type，被 `skill-execution.ts`、`core.ts`、`run_tests.mjs` 等多处消费。FR-3 变更 status 枚举（dismissed → cancelled + 新增 abandoned）需要同步更新所有引用。特别注意：`detectors/` 目录下的 `param-error.ts:19`、`goal-quality.ts:21`、`subagent-result.ts:18`、`compact.ts:11` 也定义了含 `dismissed` 的 status 类型——虽然这些是检测器自身的状态而非 TrackedItem 状态，但语义混淆风险存在（检测器的 dismissed ≠ tracker 的 cancelled）。需要确认检测器系统是否受此次改动影响。 |
| G-017 | K | User Journey | FR-2 / FR-4 | `use_skill(start)` 返回的 steering 提示措辞未在 spec 中定义。涉及多个场景：(A) start 后的初始 steering（FR-2 提到"完成后调 use_skill(update, id=X, status=completed)"但不够完整——是否也需要提示 error/cancelled 路径？）；(B) remind steering（turnsSinceLoad >= remindInterval 时，措辞从 skill_state 改为 use_skill）；(C) error threshold 达到时的 steering（原来建议 dispatch subagent，新方案下语义变化——误报零容忍下是否还建议 subagent？）；(D) onContextRestore steering（session restore 时）。spec 只笼统提到"plan 阶段定"，但 steering 措辞直接影响 agent 行为可靠性。 |
| G-018 | D | State Machine | FR-3 转换矩阵 | FR-3 定义 `loaded → completed \| error \| cancelled \| abandoned`，但 `abandoned` 在 FR-4 中被定义为"系统自动标记"。那么 agent 能否通过 `use_skill(update, id, status=abandoned)` 手动设置 abandoned？如果不能，abandoned 不应出现在 `TrackerParams` 的 status 枚举中（避免 agent 误调用）。如果能，abandoned 语义从"系统超时标记"变为"可手动设置"，含义模糊。需要决策：abandoned 是纯系统状态（不在 tool status 枚举中），还是 agent 也可设置？ |
| G-019 | K | Failure Path | analyze.py / FR-3 | Python analyzer（`analyze.py`）从 JSONL 中读取 tracker 数据并生成报告。如果 analyzer 解析 status 字段，新旧 status 共存（历史 dismissed + 新 cancelled）需要兼容。spec 提到"evolve 可借此区分主动放弃 vs 遗忘"——但 analyzer 是否需要更新才能区分？还是由 evolve 的 LLM 分析层在 natural language 中区分？需要确认 analyzer 的 status 消费方式。 |

## 降级视角记录

无降级。全部 5 视角均适用，理由：

| 视角 | 适用性判断 |
|------|-----------|
| User Journey | agent 是用户，use_skill tool 是交互界面。start/update/list 的调用流程、steering 交互、错误反馈都需追踪。 |
| Data Lifecycle | TrackedItem 的创建、序列化/反序列化、GC、历史数据兼容（dismissed → cancelled）是核心改造内容。 |
| API Contract | use_skill tool 的参数 schema、返回值、错误码、action 枚举是需求的接口层。 |
| State Machine | FR-3 明确定义 6 状态 + 转换矩阵，是本需求的核心数据模型。 |
| Failure Path | 多种失败场景：agent 遗忘、session compact、turn_end 不触发、旧数据兼容、test 重写等。 |
