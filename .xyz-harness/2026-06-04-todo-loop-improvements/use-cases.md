---
verdict: pass
---

# Use Cases — Todo Extension v4

## UC-1: AI 自发管理多步骤任务

- **Actor**: AI coding agent
- **Preconditions**: 用户给了一个需要多个步骤完成的请求（无 `/goal`）
- **Main Flow**:
  1. AI 分析任务，分解为 3-5 个独立步骤
  2. AI 调用 `todo add(texts=["步骤1", "步骤2", ...])`
  3. AI 逐一执行每个步骤，完成一个更新一个
  4. 全部完成后 `agent_end` 检测到所有 todo 均为 completed
  5. 2 轮后自动 clear，todos 数组清空
- **Alternative Paths**:
  - AI 在执行中发现问题需要新增步骤 → `todo add` 追加
  - 某步骤无法完成 → `todo update(status=in_progress)` 保持为未完成
- **Postconditions**: Todos 数组为空，状态栏无 todo 显示
- **Module Boundaries**: Todo 扩展独立完成，不涉及 goal、vision 等其他扩展

### AC 覆盖: AC-4 (agent_end auto-close), AC-6 (prompt usage)

---

## UC-2: 复杂任务的验证

- **Actor**: AI coding agent
- **Preconditions**: AI 创建了一个需要验证的复杂任务 todo
- **Main Flow**:
  1. AI 调用 `todo add(texts=["修复登录模块"], verifyTexts=["密码错误时返回正确错误码"])`
  2. AI 执行修复工作
  3. AI 调用 `todo update(id=1, status=completed)`
  4. `agent_end` 检测到任务有 verifyText，注入 `<todo_context>` 验证提醒
  5. AI 读取 verifyText，对照执行验证
  6. 验证通过 → AI 可能再次 update（不变），任务保留 completed
- **Alternative Paths**:
  - 验证失败 → `verifyAttempts` +1，AI 重新修复后重试
  - 2 次失败 → 状态变为 `failed`，通知用户
- **Postconditions**: 任务状态为 completed（通过）或 failed（失败）
- **Module Boundaries**: 验证逻辑由 Todo 扩展的 `agent_end` 自动触发，AI 自主执行验证

### AC 覆盖: AC-2 (verifyTexts), AC-5 (verify flow)

---

## UC-3: 批量完成

- **Actor**: AI coding agent
- **Preconditions**: AI 有多个独立任务并行执行完成
- **Main Flow**:
  1. AI 创建 3 个并行任务
  2. AI 一次性完成所有工作
  3. AI 调用 `todo update(updates=[{id:1,status:completed},{id:2,status:completed},{id:3,status:completed}])`
  4. 一次调用更新全部
- **Alternative Paths**:
  - 部分完成 → 只更新已完成的任务，其余保持原状态
- **Postconditions**: 3 个任务均为 completed，工具调用次数大幅减少
- **Module Boundaries**: Todo 扩展的 batch 参数

### AC 覆盖: AC-3 (batch update)

---

## UC-4: 验证失败

- **Actor**: AI coding agent + 用户
- **Preconditions**: 某任务有 verifyText 且 AI 两次验证均失败
- **Main Flow**:
  1. AI 标记任务 completed → agent_end 触发验证
  2. AI 验证失败 → verifyAttempts = 1 → AI 重新修复
  3. AI 再次标记 completed → 验证再次失败 → verifyAttempts = 2
  4. 状态自动变为 `failed`
  5. TUI 显示 `✗ #1: 修复登录模块 [验证失败]`
  6. AI 向用户报告失败原因
- **Alternative Paths**:
  - 用户手动调用 `todo update(id=1, status=completed)` 强制通过
  - 用户删除任务
  - 用户修改 verifyText 后要求 AI 重新验证
- **Postconditions**: 任务为 failed 状态，等待用户处理
- **Module Boundaries**: Todo 扩展管理状态转换，用户手动 override 通过标准 tool 调用

### AC 覆盖: AC-5 (verify failed -> failed status)

---

## Spec AC Coverage Map

| UC | Actor | Covered AC |
|----|-------|-----------|
| UC-1 | AI | AC-4, AC-6 |
| UC-2 | AI | AC-2, AC-5 |
| UC-3 | AI | AC-3 |
| UC-4 | AI + User | AC-5 |
