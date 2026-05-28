---
verdict: pass
---

# E2E Test Plan — Infinite Context Engine

## Test Scenarios

### TS-1: 段索引生命周期
**覆盖 AC:** AC-1
**前置条件:** 启动 Pi 并加载 infinite-context 扩展
**场景:**
1. 用户发送第一条消息 → 验证 seg_0 创建
2. 用户发送第二条消息 → 验证 seg_0 completed, seg_1 创建
3. 重启 session → 验证段索引从 entries 恢复
4. 验证 seg_N.json 文件正确写入 `.pi/infinite-context/<sessionId>/`

### TS-2: 自动树压缩触发
**覆盖 AC:** AC-2.1, AC-2.10
**前置条件:** 段索引有足够历史段（>2），tree-context ≥70%
**场景:**
1. 模拟多轮对话使 tree-context 达到 70%
2. 验证 `turn_end` 后自动触发压缩
3. 验证压缩期间对话不中断
4. 验证 `isCompressing` 守卫阻止并发压缩

### TS-3: 手动树压缩
**覆盖 AC:** AC-2.2, AC-5.1
**前置条件:** 至少 3 个已完成段
**场景:**
1. 用户输入 `/tree-compact`
2. 验证 TUI 显示"正在执行树压缩..."
3. 验证压缩完成后 TUI notify 结果摘要
4. 验证压缩结果持久化到 session entries

### TS-4: 压缩输出校验与降级
**覆盖 AC:** AC-2.5, AC-2.7, AC-2.8, AC-2.9
**前置条件:** 树压缩触发
**场景:**
1. 正常压缩 → 验证输出为合法 JSON 树
2. 注入非法 JSON → 验证重试 1 次
3. 重试仍失败 → 验证降级到规则 fallback
4. 模拟 subagent 超时（30s）→ 验证 kill + 降级

### TS-5: Context 消息组装
**覆盖 AC:** AC-3.1-3.7
**前置条件:** 存在压缩树和活跃段
**场景:**
1. 验证当前段使用完整原文
2. 验证保留窗口段使用完整原文
3. 验证已压缩段使用 `[nodeId] summary` 格式
4. 验证 BFS 展平顺序（浅层在前，同层 newest-first）
5. 验证预算超限时按深度截断
6. 验证 recall 提示正确注入
7. 验证 tree-context 估算值

### TS-6: Recall 工具两次调用
**覆盖 AC:** AC-4.1-4.4
**前置条件:** 存在压缩树
**场景:**
1. `recall({ nodeId: "g0", mode: "structure" })` → 验证返回子树不含原始内容
2. `recall({ nodeId: "seg_0", mode: "content" })` → 验证返回完整原始 messages
3. `recall({ nodeId: "nonexistent", mode: "structure" })` → 验证返回错误消息
4. `recall({ nodeId: "g0", mode: "content" })` → 验证 group 递归展开所有 leaf

### TS-7: Pi 原生 compaction 接管
**覆盖 AC:** AC-6.1
**前置条件:** 长会话触发 Pi 原生 compaction
**场景:**
1. 验证 `session_before_compact` handler 返回 `{ cancel: true }`
2. 验证 Pi 原生 compaction 被取消
3. 验证我们的树压缩接管

### TS-8: 上下文状态命令
**覆盖 AC:** AC-5.2, AC-6.2
**前置条件:** 存在压缩历史
**场景:**
1. 用户输入 `/context-status`
2. 验证同时显示原始上下文和树上下文
3. 验证段数量统计正确

## Test Environment

- **Runtime:** Pi (xyz-pi 或原版 pi)
- **Extension 安装:** `ln -s infinite-context ~/.pi/agent/extensions/infinite-context`
- **测试方式:** 手动集成测试（Pi 无单元测试框架）。通过模拟对话触发各场景，观察 TUI 输出和 session JSONL entries。
- **验证手段:**
  - TUI 输出观察
  - `ctx.sessionManager.getEntries()` 读取 entries 验证
  - `.pi/infinite-context/<sessionId>/` 文件检查
  - LLM 是否使用 recall 工具（通过 TUI 工具调用显示）
