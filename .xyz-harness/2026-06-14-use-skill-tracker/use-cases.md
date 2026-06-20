---
verdict: pass
---

# Use Cases — use_skill tracker

## UC-1: agent 执行 skill

- **Actor**: agent
- **Preconditions**: agent 已通过 available_skills 列表知道目标 skill 的 name 和 location
- **Main Flow**:
  1. agent 决定按某 skill（如 zcommit）的指引行动
  2. agent 调用 `use_skill(action=start, name="zcommit", path=".../zcommit/SKILL.md")`
  3. 系统校验 name 合法（skill-registry 目录扫描 + system prompt fallback）
  4. 系统创建 TrackedItem（status=loaded），返回 createdId + steering 提示
  5. agent 按 skill 指引执行任务
  6. agent 调用 `use_skill(action=update, id=X, status=completed)`
- **Alternative Paths**:
  - name 不存在 → 系统返回 "skill not found" 错误，agent 可修正后重试
  - path 缺失 → metadata.skillMdPath 留空，不阻断创建
- **Exception Paths**:
  - 执行中失败 → agent 调 `status=error`，errorCount++；达阈值后系统 steering 提示记录
  - skill 不适用 → 见 UC-2（status=cancelled）
- **Postconditions**: TrackedItem 进入终态 completed，evolve 数据记录一次成功使用
- **Module Boundaries**: use_skill tool (core.ts) → createItem → persistState (appendEntry)

## UC-2: agent 主动放弃 skill

- **Actor**: agent
- **Preconditions**: 已有 loaded 状态的 TrackedItem
- **Main Flow**:
  1. agent start 后读了 skill 内容
  2. agent 发现该 skill 不适用于当前任务
  3. agent 调用 `use_skill(action=update, id=X, status=cancelled, detail="不适用：当前任务不需要 commit")`
  4. 系统验证转换合法（loaded → cancelled = true），更新 item
- **Alternative Paths**: 无
- **Exception Paths**: 无（cancelled 是终态，后续不可变更）
- **Postconditions**: TrackedItem 进入终态 cancelled，evolve 可借此数据分析"skill description 是否误导触发"
- **Module Boundaries**: use_skill tool (core.ts) → canTransition (types.ts) → persistState

## UC-3: 遗忘未收尾（系统 abandoned）

- **Actor**: 系统（turn_end / reconstructState）
- **Preconditions**: 存在 loaded 或 error 状态的 TrackedItem，turnsSinceLoad >= abandonThreshold(20)
- **Main Flow**:
  1. turn_end 触发（abandoned 检查先于 remind）
  2. 系统遍历所有非终态 item
  3. turnsSinceLoad >= 20 的 item 自动转 abandoned
  4. persistState 持久化
- **Alternative Paths**:
  - session compact/reload → reconstructState 中也检查 abandoned（不等 turn_end）
- **Exception Paths**: 无（abandoned 是终态，不可恢复）
- **Postconditions**: TrackedItem 进入终态 abandoned，evolve 数据标记为"遗忘"，可用于分析"tool 机制是否需加强 steering"
- **Module Boundaries**: turn_end handler (core.ts) → abandoned 检查 → persistState

## UC 覆盖映射

| UC | Spec AC | 覆盖状态 |
|----|---------|---------|
| UC-1 | AC-1（start 返回 createdId）、AC-8（name 校验） | ✅ |
| UC-2 | AC-2（转换矩阵）、AC-6（cancelled 可区分） | ✅ |
| UC-3 | AC-5（超 20 turn abandoned）、AC-7（reconstructState 检查） | ✅ |
