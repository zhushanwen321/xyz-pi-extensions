---
verdict: pass
---

# skill-execution tracker 触发机制重设计：use_skill 主动声明

## Background

evolve-daily 的 skill-execution tracker 当前通过被动监听 `tool_call` + `read SKILL.md` 触发 tracking（`skill-execution.ts:107-122`）。该信号多义——调研性 read、开发性 read、执行性 read 无法在信号层区分，导致**误报**（调研性 read 被当成"使用 skill"记录），污染 evolve 后续分析的底层数据。

目标：将触发改为 agent 主动声明（`use_skill` tool），实现**误报零容忍**。漏报（agent 忘记调用）可接受。为 evolve-daily 提供干净的 skill 使用数据。

约束来源（用户决策）：误报零容忍 > 高覆盖率。

## Functional Requirements

### FR-1 合并单 tool

废弃 `skill_state`，合并为单 tool `use_skill`，通过 `action` 区分：
- `start`：创建 TrackedItem（替代原被动触发）。返回 `{action:"start", items, createdId}` + steering
- `update`：更新 item 状态（原 skill_state update）
- `list`：查询所有 item（原 skill_state list）

`TrackerParams` schema 改为 action 联合参数（start 需 name+path?，update 需 id+status+detail?，list 无参）。tool 名变更 skill_state→use_skill 后，旧 session 升级时 agent 下一 turn 自动看到新 tool 列表，无需特殊迁移。

### FR-2 start 语义

`use_skill(action=start, name, path?)`：
- agent **决定执行某 skill 的指引**时调用，一次
- 每次 start 独立创建新 TrackedItem，**不去重**（支持使用频次统计）
- `name`（必填）：skill 名称，从 available_skills 列表获取
- `path`（可选）：SKILL.md 绝对路径，从 available_skills 的 location 字段获取。缺失时 metadata.skillMdPath 留空，不阻断创建
- 返回新 item id + steering 提示"完成后调 use_skill(update, id=X, status=completed)"

### FR-3 状态机

6 状态：

| 状态 | 含义 | 触发方 |
|------|------|--------|
| loaded | 已 start，使用中 | start 创建 |
| completed | 正常完成 | agent update |
| error | 执行失败 | agent update |
| cancelled | agent 主动放弃（替代原 dismissed） | agent update |
| abandoned | 超时未终结，系统自动标记 | 系统 turn_end |
| recorded | 错误达阈值后记录入库 | errorCount >= errorThreshold |

合法转换：
- loaded → completed | error | cancelled | abandoned（系统）
- error → completed | error | recorded | cancelled | abandoned（系统）
- abandoned → completed | error | cancelled | recorded（agent 手动恢复）
- 终态不可变更：completed / recorded / cancelled

注：abandoned 主要是系统路径（turn_end/reconstructState 自动触发，见 FR-4），不经过 tool status 枚举校验。但允许 agent 在后续 turn 中显式 update 到 completed/error/cancelled/recorded，以避免"用户回来收尾时无法关闭"的僵局。

废弃 dismissed。deserialize 遇到旧 dismissed 字符串的 item 直接丢弃（过滤掉），不迁移、不映射。用户确认"历史数据不用管"。

### FR-4 abandoned 自动终结（纯系统行为）

abandoned 是纯系统状态，agent **不能**手动设置（不在 tool status 枚举中）。

tool status 枚举（agent 可手动设）：`completed` / `error` / `cancelled` / `recorded`。
纯系统状态（不在枚举中）：`abandoned`。

**recorded 流程（保留现有逻辑）**：agent 调 `status=error` → `errorCount++` → 达 `errorThreshold`(2) 时系统发 `errorForceRecordPrompt` steering 提示 agent dispatch subagent 记录 issue → agent 完成记录后手动调 `status=recorded`。recorded 由 agent 手动设（完成记录动作的标记），非系统自动转换。

完整规则（用户确认）：
1. `turn_end` 检查所有非终态 item（loaded 和 error），`turnsSinceLoad >= abandonThreshold`（默认 20，=remindInterval×2）→ 转 abandoned
2. `turn_end` 中 abandoned 检查**先于** remind——即将 abandon 的 item 不再发 remind（避免无意义提示）
3. `reconstructState`（session restore）也检查 abandoned——compact/reload 后立即清理超时 item，不等下一个 turn_end
4. abandoned 可恢复：agent 可以手动 update 到 completed/error/cancelled/recorded。若 agent 未恢复，item 仍会被过滤（不进入 before_agent_start context），直到被显式更新。

`TrackerConfig` 新增 `abandonThreshold: number` 字段。

### FR-5 废弃被动监听 + 框架改造（方案 A）

删除 `skill-execution.ts`：`triggerEvent`、`triggerMatch`、`isPathInCwd`。

**框架改造（用户确认方案 A）**：`createTracker` 支持可选 `triggerEvent`。不传则不注册 event listener，创建逻辑由 tracker 在 tool execute handler 中调用框架暴露的 `createItem()` 实现。skill-execution 不配 triggerEvent，配 `triggerTool`（start action）。框架同时保留两种触发模式给未来 tracker。改动集中在 core.ts，TrackerParams 只被 skill-execution 使用（全局仅此一处），不影响其他系统。detectors 系统独立，不受影响。

### FR-6 use_skill description 边界标准

"使用 skill"的边界是需求级决策（非 plan 细节）：**准备按 skill 指引行动 = 使用**；仅 read 了解/评估/分析 = 不使用。具体措辞 plan 阶段定，参考 meta-sk-skill-writer。

## Acceptance Criteria

- AC-1: `use_skill(start, name="X")` 返回 createdId；连续两次 start 同名 skill 产生两个独立 item
- AC-2: `use_skill(update, id, status)` 按 FR-3 矩阵转换，非法转换报错（如 completed → error）；abandoned 允许更新为 completed/error/cancelled/recorded
- AC-3: `use_skill(list)` 返回所有 item（含终态）
- AC-4: agent read SKILL.md（无论调研还是执行）**不**触发 tracking 创建——无任何对 read 的被动监听
- AC-5: loaded 或 error 状态超 20 turn，turn_end 后自动转 abandoned；abandoned 检查先于 remind
- AC-6: cancelled 与 abandoned 在数据中可区分；abandoned 不在 tool status 枚举中（agent 不能手动设）；recorded 在枚举中（agent 完成记录后手动设）
- AC-7: session restore 后 reconstructState 检查 abandoned，立即清理超时 item
- AC-8: `use_skill(start, name="不存在")` 返回错误提示"skill not found"
- AC-9: `node extensions/evolve-daily/src/trackers/run_tests.mjs` 全过（测试需重写：废弃 dismissed/被动监听用例，新增 start/cancelled/abandoned 用例）
- AC-10: `npx tsc --noEmit` 零错误

## 待 plan 阶段确认

- **name 校验的 skills 目录扫描方案**：用户选"扫描 skills 路径 + reload 更新"。来源（resource-loader.js 确认）：`homedir()/.pi/agent/skills`、`{cwd}/.agents/skills`、`homedir()/.pi/agent/npm/node_modules/*/skills`（glob）。已知风险：extension bundled skills 路径依赖 glob 模式，新增 extension 格式变化可能漏扫。plan 阶段需验证覆盖度，不足则退回 system prompt 解析（从 ctx.getSystemPrompt() 正则提取 `<name>` 标签，session_start 缓存）作为 fallback。
- **steering 措辞**：onCreate/remind/onError/onContextRestore 四处文案从 skill_state 改为 use_skill，具体措辞 plan 定。
- **Python analyzer 兼容**：`scripts/extractors/skill_state.py`（旧 entry type）和 `analyzer/extractors/tracker.py`（新 entry type）读 status。entry type 名不变（evolve-tracker-skill），新增 cancelled/abandoned status 值需 analyzer 后续兼容。属下游任务，不阻塞本需求。

## Constraints

### Out of Scope

本需求明确不做的事（避免实施时范围蔓延）：
- **不改 Pi 核心**：不改 agent-session.js / extension-runner.js，改动只在 evolve-daily 扩展内
- **不迁移历史数据**：旧 dismissed item 在 deserialize 时直接丢弃，不写迁移逻辑
- **不改 detectors 系统**：detectors 有自己的 status（含 dismissed），与 TrackedItemStatus 独立，本次不动
- **不改 Python analyzer**：analyzer 消费 status 字段的兼容是下游任务，不阻塞本需求
- **不覆盖 agent 自主 read 执行场景**：progressive disclosure 下 agent 自主 read SKILL.md 执行的 skill 不追踪（"误报零容忍"的代价）

### 技术约束

- TypeScript, Pi Extension API（registerTool / pi.on / appendEntry）, typebox
- 遵循 createTracker 框架模式（core.ts），改框架支持 triggerTool
- 废弃 dismissed，不写历史数据迁移逻辑
- 单文件 ≤ 1000 行，函数 ≤ 80 行
- 状态持久化走 `pi.appendEntry` + sessionManager（现有机制不变）
- stale context 保护（isStaleContextError）保留

## 业务用例

### UC-1: agent 执行 skill
- **Actor**: agent
- **场景**: agent 决定按某 skill（如 zcommit）指引行动
- **预期结果**: 调 use_skill(start) → 按 skill 执行 → use_skill(update, id, completed)

### UC-2: agent 主动放弃 skill
- **Actor**: agent
- **场景**: start 后读了 skill 内容，发现不适用当前任务
- **预期结果**: 调 use_skill(update, id, cancelled, detail="不适用")

### UC-3: 遗忘未收尾
- **Actor**: 系统
- **场景**: agent start 后忘记 update，loaded 持续超 20 turn
- **预期结果**: turn_end 自动转 abandoned，evolve 数据标记为"遗忘"

## 决策记录

- **为何合并单 tool**：两个 tool 都要 steering 提示 agent 调用，提示负担加倍。单 tool 用 action 区分，agent 认知成本更低。
- **为何每次 start 独立 item**：用户重视精确使用频次（zcommit 提交两次 = 两次使用）。代价是 agent 忘 update 会堆积，由 abandoned 兜底。
- **为何 cancelled 替代 dismissed**：dismissed 原语义"误报"在主动声明方案下失效。cancelled 语义"主动放弃"更准确。evolve 可借此区分"主动放弃"（skill description 可能误导）vs"遗忘"（tool 机制需加强 steering）。
- **为何方案 A（createTracker 支持可选 triggerEvent）**：框架封装了 persist/remind/GC/steering 样板，绕过会代码重复。triggerEvent 改可选后，skill-execution 用 triggerTool，未来 tracker 可选用任一模式。长期方案。
- **为何 abandoned 是纯系统状态**：agent 手动设 abandoned 会导致"系统超时"和"主动标记"语义模糊。纯系统状态让 evolve 能准确区分 cancelled（主动）vs abandoned（遗忘）。
- **为何 error 也自动 abandoned**：否则 error 僵尸 item 每次 session restore 都触发 onContextRestore steering，造成噪音。统一规则：所有非终态超时都 abandoned。
