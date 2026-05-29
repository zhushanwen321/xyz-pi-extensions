# ADR-009: 压缩在 turn_end 中同步执行，不停止对话

## 上下文

Pi 原生 compaction 在压缩完成后会终止 agent loop——用户看到"对话结束"并需要重新发消息继续。树压缩面临同样的设计选择：

- **Option A**: 模仿 Pi 原生 compaction，压缩后停止 loop
- **Option B**: 在 turn_end handler 中同步执行压缩，对话无缝继续

## 决策

选择 Option B：在 turn_end handler 中同步调用 subagent 执行压缩，对话不停止。

## 原因

1. **压缩是基础架构操作**：压缩不是对话的一部分，用户不应该被中断。用户只应该看到 TUI 上的瞬时状态消息（"正在执行树压缩..."），然后继续正常工作
2. **技术可行性**：我们的压缩不修改 `agent.state.messages`（raw entries 永远不变），只改变 context handler 的返回值。agent loop 对压缩无感知——它只是在下一次 LLM 调用时收到不同的 messages
3. **代价可接受**：spawnSync 阻塞 turn_end handler 3-10 秒，这是用户不可见的区间（两个 turn 之间）。如果变成异步，反而需要在 turn_start 时增加"等待压缩完成"的复杂逻辑
4. **简单性**：同步执行意味着 context handler 读取的树结构总是最新状态，不存在 race condition
