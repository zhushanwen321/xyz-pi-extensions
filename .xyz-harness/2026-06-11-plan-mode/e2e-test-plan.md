---
verdict: pass
---

# E2E Test Plan — Pi Plan Mode Extension

## Test Scenarios

### TS-1: 进入 Plan Mode

**AC 覆盖:** AC-1

**场景:** 用户通过 `/plan 添加认证` 进入 plan mode

**步骤:**
1. 用户输入 `/plan 添加认证`
2. 验证状态变为 `isActive: true, phase: "brainstorming"`
3. 验证 plan 文件路径已生成（`/tmp/plan-*.md`）
4. 验证 TUI 状态栏显示 `[Plan Mode]`

**预期结果:** Plan mode 成功进入，状态正确

### TS-2: Brainstorming 流程

**AC 覆盖:** AC-2, AC-3

**场景:** AI 在 brainstorming 中先探索再提问，提出 2-3 个方案

**步骤:**
1. 进入 plan mode
2. 验证 AI 先执行代码探索（grep/read）
3. 验证 AI 提问时区分探索能回答的和需要用户偏好的
4. 验证 AI 提出至少 2 个方案并给出推荐

**预期结果:** Brainstorming 流程符合 spec 要求

### TS-3: Plan 文件编写

**AC 覆盖:** AC-4, AC-5

**场景:** AI 按模板章节顺序逐个填写 plan 文件

**步骤:**
1. 选择模板（如 feature-plan）
2. 验证 AI 按章节顺序填写
3. 验证不跳过未写的章节
4. 验证 plan 文件格式正确（YAML frontmatter + 章节结构）

**预期结果:** Plan 文件按顺序生成，格式正确

### TS-4: Abort 取消

**AC 覆盖:** AC-6

**场景:** 用户在任何阶段通过 `/plan abort` 取消

**步骤:**
1. 进入 plan mode
2. 在 brainstorming 阶段执行 `/plan abort`
3. 验证状态变为 `isActive: false, phase: "idle"`
4. 验证 TUI 状态栏不再显示 `[Plan Mode]`

**预期结果:** Plan mode 成功取消

### TS-5: Complete + Compact

**AC 覆盖:** AC-7

**场景:** Plan 完成后选择 compact 隔离上下文

**步骤:**
1. 完成 plan 编写
2. 调用 `plan` tool (complete)
3. 选择 compact 隔离方式
4. 验证 compact 成功执行
5. 验证新上下文中 AI 读取 plan 文件并提议执行策略

**预期结果:** Compact 成功，新上下文正确加载 plan

### TS-6: Complete + Compact 失败降级

**AC 覆盖:** AC-8

**场景:** Compact 失败时降级为直接继续

**步骤:**
1. 模拟 compact 失败
2. 验证降级为直接继续
3. 验证通知用户

**预期结果:** 降级路径正常工作

### TS-7: Goal API 启动

**AC 覆盖:** AC-9

**场景:** Plan 完成后通过 `__goalInit` API 启动 goal

**步骤:**
1. 确保 goal extension 已安装
2. 完成 plan 并调用 complete
3. 验证 `__goalInit` 被调用

**预期结果:** Goal 成功启动

### TS-8: 自定义模板发现

**AC 覆盖:** AC-10

**场景:** 用户自定义模板被 list-template 正确发现

**步骤:**
1. 在项目 `.pi/plan-templates/` 创建自定义模板
2. 调用 `plan` tool (list-template)
3. 验证自定义模板在列表中

**预期结果:** 自定义模板被正确发现

### TS-9: 多 Session 隔离

**AC 覆盖:** AC-11

**场景:** 同一 Pi 进程多 session 时 plan 状态互不干扰

**步骤:**
1. 在 session A 进入 plan mode
2. 在 session B 进入 plan mode
3. 验证两个 session 的状态独立

**预期结果:** Session 隔离正确

### TS-10: Complete + Tree 隔离

**AC 覆盖:** AC-6, FR-5.4

**场景:** Plan 完成后选择 tree 隔离方式

**步骤:**
1. 完成 plan 编写
2. 调用 `plan` tool (complete, isolation="tree")
3. 验证只通知用户手动 /tree，不注入 steer
4. 验证不自动启动 goal

**预期结果:** Tree 隔离只通知，不自动操作

### TS-11: 无效 Action 测试

**AC 覆盖:** FR-3 (边界)

**场景:** 调用 plan tool 时传入无效 action

**步骤:**
1. 调用 `plan` tool (action="invalid")
2. 验证返回错误信息

**预期结果:** 返回 "Unknown plan action" 错误

### TS-12: 模板不存在测试

**AC 覆盖:** FR-4 (边界)

**场景:** select-template 时模板不存在

**步骤:**
1. 调用 `plan` tool (select-template, templateName="nonexistent")
2. 验证返回错误信息

**预期结果:** 返回 "Template not found" 错误

### TS-13: Goal Extension 未安装测试

**AC 覆盖:** FR-6 (降级)

**场景:** goal extension 未安装时 plan complete

**步骤:**
1. 卸载 goal extension
2. 完成 plan 并调用 complete
3. 验证 goal init 失败时降级通知

**预期结果:** 降级通知用户，不阻塞流程

## Test Environment

- **Pi 版本:** 最新
- **Extensions:** @zhushanwen/pi-plan, @zhushanwen/pi-goal
- **操作系统:** macOS / Linux
