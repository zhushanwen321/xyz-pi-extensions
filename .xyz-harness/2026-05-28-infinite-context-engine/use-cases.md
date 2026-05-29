---
verdict: pass
---

# Use Cases — Infinite Context Engine

## UC-1: 自动上下文压缩（无感）

- **Actor:** 系统（自动触发）
- **Preconditions:** Pi 会话已启动，infinite-context 扩展已加载，对话历史足够长（tree-context ≥70%）
- **Main Flow:**
  1. 用户正常对话，每条消息触发段追踪
  2. Context handler 估算 tree-context token 量
  3. tree-context 达到 70% 阈值
  4. `turn_end` handler 检测 `needsCompression` 标志
  5. 检查 `isCompressing` 守卫（如果已有压缩在执行则跳过）
  6. 异步启动 subagent 进行树压缩
  7. TUI 显示"正在执行树压缩..."
  8. Subagent 完成，校验输出，持久化到 entries
  9. TUI notify 压缩结果
  10. 下一次 context handler 自动使用新树结构
- **Alternative/Exception Paths:**
  - 4a. 压缩期间用户继续输入 → context handler 继续使用旧树，对话不中断
  - 6a. Subagent 超时（30s）→ kill 进程 + 规则降级 + TUI 显示降级警告
  - 7a. 校验失败 → 重试 1 次 → 仍失败 → 规则降级
- **Postconditions:** 历史段被组织为摘要树，当前工作段完整保留，LLM 可通过 recall 检索
- **Module Boundaries:** segment-tracker → tree-compactor → context-handler
- **AC Coverage:** AC-2.1, AC-2.4-2.10, AC-3.1-3.7

## UC-2: 手动触发压缩

- **Actor:** 用户（开发者）
- **Preconditions:** Pi 会话已启动，至少 3 个已完成段
- **Main Flow:**
  1. 用户输入 `/tree-compact`
  2. 命令 handler 调用 `treeCompactor.triggerCompression()`
  3. TUI 显示"正在执行树压缩..."
  4. 压缩完成，TUI notify："压缩了 N 个段为 M 个组，释放约 P% 上下文"
  5. 对话继续
- **Alternative/Exception Paths:**
  - 2a. 已有压缩在执行 → TUI 显示"压缩正在进行中"并跳过
  - 3a. 压缩失败/降级 → TUI 显示降级警告
- **Postconditions:** 树压缩完成（或降级完成），结果持久化
- **Module Boundaries:** commands → tree-compactor
- **AC Coverage:** AC-2.2, AC-5.1

## UC-3: 查看上下文状态

- **Actor:** 用户（开发者）
- **Preconditions:** Pi 会话已启动
- **Main Flow:**
  1. 用户输入 `/context-status`
  2. 命令 handler 读取 `ctx.getContextUsage()`（原始上下文）
  3. 命令 handler 读取 tree-context 估算值
  4. TUI 渲染：原始上下文使用率、树上下文使用率、段数量、压缩历史、recall 使用次数
- **Alternative/Exception Paths:**
  - 2a. 无压缩历史 → 显示"尚未执行压缩"
- **Postconditions:** 用户看到两个上下文使用率对比
- **Module Boundaries:** commands → token-estimator, context-handler
- **AC Coverage:** AC-5.2, AC-6.2

## UC-4: LLM 主动 Recall 被压缩内容

- **Actor:** LLM（通过 recall 工具）
- **Preconditions:** 存在压缩树，LLM 在上下文中看到 `[nodeId] summary` 格式的摘要
- **Main Flow:**
  1. LLM 看到摘要如 `[g0] 项目初始化与基础配置`
  2. LLM 调用 `recall({ nodeId: "g0", mode: "structure" })`
  3. RecallTool 返回 g0 的子树结构（不含原始内容）
  4. LLM 发现需要的段，调用 `recall({ nodeId: "seg_0", mode: "content" })`
  5. RecallTool 读取 seg_0.json 返回完整原始 messages
- **Alternative/Exception Paths:**
  - 2a. nodeId 不存在 → 返回"未找到 nodeId。使用 /context-status 查看可用节点。"
  - 4a. nodeId 是 group + mode:content → 递归展开所有子孙 leaf
  - 5a. seg 文件不存在 → 返回"无内容"
- **Postconditions:** LLM 获得被压缩的原始上下文信息
- **Module Boundaries:** recall-tool → tree-compactor (getTree), segment files
- **AC Coverage:** AC-4.1-4.4

## UC-Coverage Matrix

| UC | AC Coverage |
|----|-------------|
| UC-1 | AC-2.1, AC-2.4-2.10, AC-3.1-3.7 |
| UC-2 | AC-2.2, AC-5.1 |
| UC-3 | AC-5.2, AC-6.2 |
| UC-4 | AC-4.1-4.4 |
| AC-1 | UC-1 (段追踪), UC-2 (段存在前提) |
| AC-2.3 | UC-1 (Pi compaction 接管) |
| AC-6.1 | UC-1 (session_before_compact) |
