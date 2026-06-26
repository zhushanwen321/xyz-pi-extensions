# widget 精简 + slug + budget 显示 — 5 视角独立追踪（Round 1）

> 由隔离上下文 subagent 独立追踪（不继承主 agent 对话历史）。
> 源码中 `slug` 字段完全不存在（全仓 grep 零命中），故所有视角的「现状」均指 slug 引入前的代码事实。

## 汇总

本轮共发现 **12 个 gap**（F: 9, K: 2, D: 3，有重叠标注——GAP-2/6/8 跨 D/F，GAP-1/10 跨 K/D）。

按优先级：
- **阻塞实现（必须先决）**：GAP-1（生成规则）、GAP-2（objective/slug 必填性）、GAP-6（update 时 slug 处理）
- **事实遗漏（spec 漏了改造点）**：GAP-3（service.createGoal 签名）、GAP-5（history 显示层）、GAP-7（无预算渲染 + k 缩写工具）、GAP-8（widget objective 行去留）、GAP-11（tool renderResult）、GAP-12（终态行）
- **风险点**：GAP-4（deserialize 误用 req 致 state 全丢）

---

## GAP-1 [K/D] slug 生成规则未定义
- 视角: User Journey + Failure Path
- 问题: spec FR-2 与 clarification 把 [SLUG-RULE] 标为待定，未给 kebab-case 算法、长度上限、字符集、冲突处理。`/goal` 命令路径需确定性纯函数从 objective 生成 slug；AI toolcall 路径 slug 由 AI 提供，但同样需校验。全仓无 slug 工具函数。
- 类型: K（需用户拍板规则）
- 建议: A=kebab-case≤40 字符仅 `[a-z0-9-]` 超长截断，非 ASCII 丢弃/转写，冲突不处理；B=同 A + 冲突追加 -2/-3；C=不自动生成，命令路径 slug 留空 fallback objective。

## GAP-2 [D] goal_control create 的 slug/objective 必填性矛盾
- 视角: API Contract + User Journey
- 问题: spec 说「objective 可选，缺省 fallback slug」，但现状 `handleCreate`（L106-108）硬性要求 objective 必填。若 objective 可选且空，prompt 注入的 `<objective>` 会是空串，方向感丢失，自相矛盾。
- 类型: D
- 建议: A=objective 仍必填（slug 仅标题，最简单）；B=objective 可选，缺省时 state.objective=slug；C=objective 可选可空，prompt 标注「slug used as title」。

## GAP-3 [F] createGoalState/createGoal 签名未带 slug，漏 service.createGoal 层
- 视角: Data Lifecycle + API Contract
- 问题: spec FR-1 只提 `createGoalState` 加 slug，漏了 `service.createGoal`（service.ts L145-162）这层。slug 要从入口流到 state，需同步改 3 层签名：createGoalState + service.createGoal + 两个 adapter 调用点（command-adapter L333、goal-control-adapter L133）。
- 类型: F（事实遗漏）

## GAP-4 [F] deserializeState slug 解析方式与 FR-5 严格模式冲突，误用致 state 全丢
- 视角: Data Lifecycle
- 问题: spec AC-5 要求旧数据 deserialize 不 throw。但 deserializeState（L33-61）现用 `req(key)` 对每字段缺失 throw，仅 completedAtTurnIndex 用可选解析。加 slug 必须用可选模式（`slug: data.slug as string | undefined`）。若误用 req，旧数据会导致 reconstructGoalState 抛错 → session.state=null，widget/prompt 全失效（G-024 部分损坏全丢）。
- 类型: F（事实风险）

## GAP-5 [F] makeHistoryEntry/handleHistory 未覆盖 slug + 显示层 fallback 漏列
- 视角: User Journey（history）+ Data Lifecycle
- 问题: GoalHistoryEntry（ports.ts L13-21）无 slug 字段；makeHistoryEntry（L70-80）只拷 objective；handleHistory（command-adapter L186-222）显示用 objective 截断。spec 提了加字段+拷贝，漏了显示层（handleHistory 标题渲染 L212-219）。
- 类型: F

## GAP-6 [D] /goal update 改 objective 时 slug 是否重置/重生成未定义
- 视角: State Machine + User Journey
- 问题: handleUpdate（L252-288）重塑时重置 objective/turnIndex/flags，但不重置 slug（字段不存在）。引入后 objective 变了 slug 还是旧的，widget 标题与新 objective 不符。spec 全文未提 update 路径。
- 类型: D
- 建议: A=update 时 slug 置空（fallback objective 截断）；B=update 自动重生成 slug；C=update 不动 slug（需单独改 slug 路径，见 GAP-9）。

## GAP-7 [F] widget 无预算显示绝对值是全新行为 + k 缩写工具缺失
- 视角: widget 显示
- 问题: D-widget-3 要求无预算显示 `12k used (no budget)`，但现状 renderStatusLine（L64/L68）/renderWidgetLines（L142-151）无预算时根本不输出 token/time 文本。「无预算显示绝对值」是全新分支。另外 spec 用 `12k/50k` k 缩写，但全仓无 token 缩写格式化函数（grep 1000/toK/abbreviat 无果），需新建。
- 类型: F（新增渲染逻辑 + 缩写工具）

## GAP-8 [F/D] widget 标题用 slug 的渲染点未明确，objective 行去留未定
- 视角: User Journey（widget）
- 问题: spec FR-3 说「状态栏标题用 slug」，但现状 renderStatusLine 标题是固定 `◆ Goal`+turnIndex；renderWidgetLines 第二行是 `Objective: ${objDisplay}`。引入 slug 后：(a) statusLine 标题位是否换成 slug（UC-1 暗示是）；(b) widgetLines 的 Objective: 全文行保留还是移除（精简诉求）未定。
- 类型: F（渲染点）/ 偏 D（objective 行去留）

## GAP-9 [K] 缺少修改 slug 的命令/tool，slug 设定后无修正路径
- 视角: User Journey + State Machine
- 问题: /goal update 只改 objective，goal_control 无 edit action。AI slug 拼错或自动生成不理想时，用户无法单独改 slug。
- 类型: K
- 建议: 若需，/goal update 加可选 slug 参数或新增 tool action；若不需，明确 slug 不可改。

## GAP-10 [F/K] prompt 标题是否用 slug 未定
- 视角: prompt 引擎
- 问题: contextInjection/continuation 的 [GOAL] 标题行（L131/L229）是否改为 `[GOAL: ${slug}]` 未定。clarification 只说 prompt 读 objective，但标题行用不用 slug 是独立问题。
- 类型: F（待定）/ 偏 K

## GAP-11 [F] goal_control renderResult/renderCall 未涉及 slug
- 视角: API Contract + User Journey
- 问题: tool execute 返回文本含 `Objective: ${params.objective}`，renderResult 显示 `◆ Goal Created`。引入 slug 后 create 返回文本 + renderResult 是否带 slug 未定。AC-1 只验 widget。
- 类型: F

## GAP-12 [F] 终态单行 renderTerminalStatusLine 无预算分支未定
- 视角: widget 终态行
- 问题: renderTerminalStatusLine（L96-127）终态单行也只显示有预算的维度百分比。D-widget-3 的「无预算显示绝对值」是否适用于终态行未定（终态已结束，显示 used (no budget) 是否有意义）。
- 类型: F
