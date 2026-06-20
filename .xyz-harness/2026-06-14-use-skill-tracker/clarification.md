# Clarification — skill-execution tracker 触发机制重设计

## 已知信息

### 代码事实（已验证）

- 当前 tracker 用被动监听 `tool_call` + `read SKILL.md` 触发（`skill-execution.ts:107-122`）
- A+D 修复已在当前分支：`dismissed` 终态（`types.ts:19/46`）+ cwd 排除 `isPathInCwd`（`skill-execution.ts:39-42`）。use_skill 方案废弃被动监听后这些代码删除
- createTracker 框架（`core.ts`）当前支持 `triggerEvent` + `triggerMatch`。**全局只有 skillExecutionConfig 一个 tracker 用 createTracker**，TrackerParams 只在 trackers/ 内部用
- **detectors 系统完全独立**：有自己的 status（pending/completed/error/dismissed），不进 tracker 的 state.items，不走 skill_state tool，用 appendEntry("evolve-feedback")。改动 TrackedItemStatus 零影响 detectors
- 当前状态机：`loaded → completed|error|dismissed → recorded`（`types.ts:24-36`）
- 现有配置：`remindInterval=10`, `errorThreshold=2`（`skill-execution.ts:135-136`）
- skills 目录来源（resource-loader.js 确认）：`homedir()/.pi/agent/skills`、`{cwd}/.agents/skills`、extension bundled（resources_discover 声明，extension 拿不到汇总）
- ExtensionContext/ExtensionAPI 无 getSkills 方法；resourceLoader.getSkills() 在 agent-session 内部，extension 拿不到
- Python analyzer 消费 tracker status：`scripts/extractors/skill_state.py`（旧 entry type）+ `analyzer/extractors/tracker.py`（新 entry type）

### 用户决策（ask_user 确认）

1. **tool 方案**：主动声明 tool（use_skill），废弃被动监听。理由：误报零容忍 > 高覆盖率
2. **合并单 tool**：use_skill 通过 action（start/update/list）区分，skill_state 废弃
3. **每次 start 独立 item**：不去重，支持精确使用频次。代价是堆积，由 abandoned 兜底
4. **abandoned 纯系统行为**：覆盖所有非终态（loaded+error）；agent 不能手动设；turn_end 先于 remind 检查；reconstructState 也检查
5. **废弃 dismissed，新增 cancelled**：cancelled = agent 主动放弃。历史数据 deserialize 时丢弃 dismissed item
6. **框架方案 A**：createTracker 支持可选 triggerEvent，创建逻辑由 tracker 在 tool handler 调 createItem()
7. **name 校验**：启动时扫描 skills 目录 + reload 更新。不做并发限制

## Gap 处理记录（Round 1，19 个 gap）

### 丢弃（误报，二次确认否定）

- G-016 detectors 有 dismissed → 误报，detectors 独立系统不受影响
- G-001 共享 schema 影响所有 tracker → 误报，全局只有 1 个 tracker 用 createTracker

### 消化到 spec（实现细节）

- G-002（start 参数 schema）→ 并入 FR-1
- G-004（types.ts 改动范围）→ 并入 FR-3/FR-5
- G-006（TrackerConfig 缺 abandonThreshold）→ 并入 FR-4
- G-010（run_tests.mjs 重写）→ 并入 AC-9
- G-013（start 返回结构）→ 并入 FR-1（createdId）
- G-017（steering 措辞）→ 并入"待 plan 阶段确认"
- G-019（analyzer 兼容）→ 并入"待 plan 阶段确认"（下游任务）

### 问用户后决策

- G-003 框架架构 → 方案 A
- G-005/G-009/G-015/G-018 abandoned 行为 → 纯系统状态，覆盖所有非终态
- G-008/G-014 start 输入约束 → name 校验，不做并发限制
- G-007 旧 dismissed → deserialize 丢弃
- G-011 tool 名迁移 → 无需特殊处理（digest 到 FR-1）
- G-012 description 边界 → 需求级（digest 到 FR-6）

## Gap 处理记录（Round 2，1 个 gap）

### 修正 spec 内部不一致（未问用户）

- G-R2-001（标为 D，实质 F）recorded 状态归属矛盾。Round 1 处理后的 spec 内部不一致：FR-3 把 recorded 列为终态（error → recorded 转换存在），但 FR-4 又把 tool status 枚举限定为 completed/error/cancelled（排除 recorded，agent 无法设置它）。这造成「终态可达但无触发路径」的死状态。tracing-round-2.md 标为 D 类（需决策自动转换发生位置 / steering 去向），但主 agent 二次确认后发现修正方向唯一——让 recorded 保留在 tool status 枚举中（agent 完成问题记录 subagent dispatch 后手动设），abandoned 成为唯一纯系统状态。无决策空间，未走 ask_user。修正落地：spec FR-3 终态列表含 recorded；FR-4 明确「tool status 枚举含 completed/error/cancelled/recorded，纯系统状态仅 abandoned」，并补充 recorded 完整流程（errorCount 达阈值 → 系统 steering 提示 → agent 手动设 recorded）。tracing-round-3.md 已验证修正一致性。

## 待追踪项的最终状态（Round 3 收敛后）

tracing-round-3.md 判定 CONVERGED。以下三项均确认为非 spec gap：

- name 校验的 skills 目录扫描覆盖度 → 已有 fallback（system prompt 解析），推到 plan 阶段确认
- TrackerParams 联合参数的 typebox 表达 → schema 形状已在 FR-1 描述，具体表达推到 plan 阶段
- abandonThreshold=20 是否合理 → 有默认值，需实际 session 验证，非 spec gap
