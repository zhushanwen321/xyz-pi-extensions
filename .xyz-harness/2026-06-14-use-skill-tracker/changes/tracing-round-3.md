# Tracing Round 3 — CONVERGED

> **CONVERGED** — 无新 gap。5 视角完整重跑，Round 1（19 gap）和 Round 2（G-R2-001）的修正均已在 spec 中正确体现。

## 追踪范围

- spec 初稿版本：已修正 G-R2-001（recorded 保留在 tool status 枚举中，abandoned 是唯一纯系统状态）
- 追踪的视角：P1 User Journey / P2 Data Lifecycle / P3 API Contract / P4 State Machine / P5 Failure Path（全部 5 视角，无降级）

## 视角追踪摘要

### P1: User Journey

| 操作 | Actor | 主路径 | 强制检查项 | 结果 |
|------|-------|--------|-----------|------|
| UC-1: agent 执行 skill | agent | start → 执行 → update(completed) | 成功下一步/放弃/重复/权限/超时 | ✅ 全部明确 |
| UC-2: agent 放弃 skill | agent | start → update(cancelled) | 同上 | ✅ 明确 |
| UC-3: 遗忘未收尾 | 系统 | start → 20 turns → abandoned | — | ✅ 明确 |

- start 不去重（每次独立 item）：FR-2 明确声明，AC-1 验证
- name 不存在：AC-8 返回错误 "skill not found"
- id 不存在：core.ts current code 返回 error（plan 阶段保留）
- 无效转换：AC-2 + canTransition 校验，返回错误消息

无 gap。

### P2: Data Lifecycle

**TrackedItem 生命周期**：
- Create：use_skill(start) → loaded → 有 id、name 必填、path 可选、默认值完整
- Read：use_skill(list) → 返回全部 items
- Update：use_skill(update) → agent 改 status/detail，系统改 errorCount/lastRemindAtTurn
- Terminal：completed/recorded/cancelled/abandoned 不可变更
- GC：persistState 只保留最新 entry，无无限增长风险
- 唯一性：无（设计如此，FR-2）
- deserializeState 兼容：旧 dismissed → 过滤丢弃（通过终态 filter 或显式过滤，plan 阶段实现）

无 gap。

### P3: API Contract (Tool Contract)

**use_skill 工具参数 schema**：

| action | 必填参数 | 可选参数 | 返回 details.action |
|--------|---------|---------|-------------------|
| start | name | path | "start" + createdId |
| update | id, status | detail | "update" + updatedId |
| list | — | — | "list" |

**status 枚举（agent 可设）**：completed / error / cancelled / recorded
**system-only**：abandoned（不在枚举中）

错误场景全覆盖：name not found (AC-8)、id not found (code)、invalid transition (AC-2)、missing params (code)。

幂等性：start 非幂等（设计如此）、update 对终态幂等（transition rejected）、list 幂等。

无 gap。

### P4: State Machine

**合法转换矩阵**：

| From | To (agent) | To (system) |
|------|-----------|------------|
| loaded | completed, error, cancelled | abandoned (turn_end/reconstructState) |
| error | completed, error, recorded, cancelled | abandoned (turn_end/reconstructState) |
| completed | (终态) | — |
| recorded | (终态) | — |
| cancelled | (终态) | — |
| abandoned | (终态) | — |

交叉验证 spec FR-3 转换矩阵与 FR-4 abandoned 规则：
- loaded→abandoned 和 error→abandoned 均为系统行为（turn_end 先于 remind）
- agent 不能设置 abandoned（不在 status 枚举中）：AC-6 ✅
- recorded 是终态：FR-3 "终态不可变更：completed / recorded / cancelled / abandoned" ✅
- reconstructState 检查 abandoned：FR-4 ✅

无 gap。

### P5: Failure Path

| 失败场景 | 条件 | 检测 | 恢复 | 数据一致性 |
|---------|------|------|------|-----------|
| name 不存在 | start 时 name 不在 skills 目录 | name 校验 | 返回错误 | 无 item 创建 ✅ |
| 无效转换 | update 违反转换矩阵 | canTransition | 返回错误 | item 不变 ✅ |
| id 不存在 | update 时 id 无匹配 | findIndex | 返回错误 | 无变化 ✅ |
| stale context | session 被 teardown | isStaleContextError | skip persist | 下次 reconstructState 修复 ✅ |
| session restore 超时 | compact/reload 后 item 超 threshold | reconstructState 新增检查 | 立即转 abandoned | 干净状态 ✅ |
| 遗忘堆积 | 多次 start 无 update | turn_end 批量检查 | 全部 abandoned | 终态不干扰 ✅ |
| 旧 dismissed 数据 | 反序列化旧 entry | deserializeState 过滤 | 丢弃不迁移 | 无残留 ✅ |

无 gap。

## Round 2 修正验证

G-R2-001 修正内容：recorded 保留在 tool status 枚举中（agent 手动设），abandoned 是唯一纯系统状态。

验证结果：
- spec FR-4 明确："tool status 枚举（agent 可手动设）：completed / error / cancelled / recorded。纯系统状态（不在枚举中）：abandoned。" ✅
- spec FR-3 终态列表："completed / recorded / cancelled / abandoned" ✅
- spec AC-6："abandoned 不在 tool status 枚举中（agent 不能手动设）；recorded 在枚举中（agent 完成记录后手动设）" ✅
- recorded 转换路径：error → recorded（agent 手动），FR-4 说明了完整流程 ✅
- 规则一致性：5 视角无矛盾 ✅

## clarification.md「待追踪」项状态

| 项 | 状态 | 判定 |
|----|------|------|
| name 校验 skills 目录扫描覆盖度 | 计划阶段确认 | 非 spec gap，已有 fallback 方案（system prompt 解析） |
| TrackerParams 联合参数 typebox 表达 | 计划阶段确认 | 非 spec gap，schema 形状已描述 |
| abandonThreshold=20 合理性 | 需实际 session 验证 | 非 spec gap，有默认值 + 验证计划 |

## 结论

**CONVERGED**。spec 经过 Round 1（19 gap）+ Round 2（1 gap）修正后，5 视角完整重跑无新 gap。所有状态转换、边界条件、失败路径、数据生命周期均已被 spec 明确覆盖或推到 plan 阶段（steering 措辞、typebox 表达、analyzer 兼容）。
