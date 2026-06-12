---
verdict: pass
---

# Use Cases — Pi Plan Mode Extension

## UC-1: 新功能规划

- **Actor**: 开发者
- **Preconditions**: Pi agent 已启动，goal extension 已安装
- **Main Flow**:
  1. 开发者输入 `/plan 添加用户认证`
  2. AI 进入 brainstorming 阶段
  3. AI 自动 ls + README + package.json 建立上下文
  4. AI 渐进式提问（2-3 个问题）
  5. AI 提出 2-3 个方案 + 推荐
  6. AI 做假设审计
  7. 用户选择模板（feature-plan）
  8. AI 按章节顺序写 plan 文件
  9. 用户确认 plan
  10. AI 调用 complete，用户选择 compact
  11. AI 读取 plan 文件，建议启动 goal + wave
- **Alternative Paths**:
  - 用户不满意 plan → 回到步骤 4 重新提问
  - 用户 abort → 退出 plan mode
  - compact 失败 → 降级为直接继续
- **Postconditions**: Plan 文件生成，goal 启动
- **Module Boundaries**: plan extension, goal extension

**AC 覆盖:** AC-1, AC-2, AC-3, AC-4, AC-5, AC-7, AC-9

## UC-2: 复杂 Bug 修复

- **Actor**: 开发者
- **Preconditions**: Pi agent 已启动
- **Main Flow**:
  1. 开发者输入 `/plan 修复登录超时问题`
  2. AI 进入 brainstorming
  3. AI 探索相关代码
  4. AI 提问了解问题现象
  5. AI 分析可能的根因
  6. 用户选择模板（bugfix-plan）
  7. AI 写 plan 文件（含根因分析 + 修复策略）
  8. 用户确认 plan
  9. AI 调用 complete
- **Alternative Paths**:
  - AI 无法确定根因 → 标记 [UNVERIFIED]，用户确认
  - 用户 abort → 退出 plan mode
- **Postconditions**: Bugfix plan 文件生成
- **Module Boundaries**: plan extension

**AC 覆盖:** AC-1, AC-2, AC-4, AC-5, AC-6

## UC-3: 快速调研

- **Actor**: 开发者
- **Preconditions**: Pi agent 已启动
- **Main Flow**:
  1. 开发者输入 `/plan 对比 React 和 Vue 的优劣`
  2. AI 进入 brainstorming
  3. AI 搜索相关资料
  4. AI 提问了解具体需求
  5. 用户选择模板（research-plan）
  6. AI 写 plan 文件（含方案对比 + 推荐）
  7. 用户确认 plan
  8. AI 调用 complete，选择直接继续
- **Alternative Paths**:
  - 用户要求深入某个方案 → 回到步骤 3
  - 用户 abort → 退出 plan mode
- **Postconditions**: Research plan 文件生成
- **Module Boundaries**: plan extension

**AC 覆盖:** AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-8

## UC-4: 已有 Spec 的实现计划

- **Actor**: 开发者
- **Preconditions**: Pi agent 已启动，spec.md 已存在
- **Main Flow**:
  1. 开发者输入 `/plan 实现 spec.md 中的功能`
  2. AI 检测到已有 spec，跳过 brainstorming
  3. 用户选择模板（implementation-plan）
  4. AI 读取 spec.md
  5. AI 写 plan 文件（分步骤实现计划）
  6. 用户确认 plan
  7. AI 调用 complete
- **Alternative Paths**:
  - spec.md 不存在 → 回到 brainstorming 流程
  - 用户 abort → 退出 plan mode
- **Postconditions**: Implementation plan 文件生成
- **Module Boundaries**: plan extension

**AC 覆盖:** AC-1, AC-4, AC-5, AC-6

## AC 覆盖映射表

| UC | 覆盖的 AC |
|----|----------|
| UC-1 | AC-1, AC-2, AC-3, AC-4, AC-5, AC-7, AC-9 |
| UC-2 | AC-1, AC-2, AC-4, AC-5, AC-6 |
| UC-3 | AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-8 |
| UC-4 | AC-1, AC-4, AC-5, AC-6 |

**未覆盖的 AC:** AC-10 (自定义模板发现), AC-11 (多 session 隔离) — 这些通过 TC-8 和 TC-9 测试覆盖。

## UC 合并说明

plan-mode-design.md 列出 11 个 UC，本 use-cases.md 精简为 4 个核心 UC，其余场景通过以下方式覆盖：

| 原始 UC | 合并到 | 覆盖方式 |
|---------|--------|----------|
| UC-3 (重构规划) | UC-1 | 模板选择为 refactor-plan |
| UC-6 (Plan 迭代修改) | UC-1 Alternative Path | 用户不满意 plan → 回到提问 |
| UC-7 (中途切换到 Plan Mode) | UC-1 Preconditions | 任何对话中输入 /plan |
| UC-9 (查看已有 Plan) | UC-4 Alternative Path | 重入逻辑检测已有 plan |
| UC-10 (Plan 完成后进入实现) | UC-1 Postconditions | compact + goal init |
| UC-11 (非代码任务规划) | UC-3 | research-plan 模板 |
