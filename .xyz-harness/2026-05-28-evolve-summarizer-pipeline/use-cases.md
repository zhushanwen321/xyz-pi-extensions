---
verdict: pass
---

# Use Cases — Evolve Summarizer Pipeline

## UC-1: 用户运行 /evolve 分析改进建议

- **Actor**: Pi Agent 用户（通过 AI 助手调用 `/evolve` 命令）
- **Preconditions**: 用户有 >=1 天的 session 使用数据；analyzer 报告已生成或可生成
- **Main Flow**:
  1. 用户触发 `/evolve`（或 AI 助手调用 evolve tool）
  2. 系统查找或生成原始 analyzer 报告（可能 ~750KB）
  3. Summarizer 将报告压缩为信号摘要（~5KB），提取 MetricsSnapshot
  4. 信号摘要保存到 `signals/signal-{ts}.json`
  5. MetricsSnapshot 追加到 `metrics-history.json`（滑动窗口 30 条）
  6. GC 清理旧数据（reports 保留 3 份，signals 保留 30 份）
  7. Judge 通过 stdin 接收信号摘要 + system prompt，生成建议
  8. 建议保存到 `pending.json`
  9. 用户通过 `/evolve-apply action=list` 查看建议
- **Alternative/Exception Paths**:
  - 报告不存在 → 自动运行 Python analyzer 生成
  - Judge 返回空输出 → 重试 1 次（短 prompt）→ 仍失败则报错（含 stderr 诊断信息）
  - 无改进建议 → 返回空列表，pending.json 含空 suggestions 数组
- **Postconditions**: signals/ 下新增信号摘要；pending.json 就绪可供 review；metrics-history.json 已更新
- **Module Boundaries**: commands.ts → summarizer.ts → state.ts → judge.ts

### Spec AC 覆盖映射

| UC Step | AC | 覆盖说明 |
|---------|-----|---------|
| Step 3 | AC-1 | 745KB → ≤10KB 压缩 |
| Step 5 | AC-3 | metrics-history ≤30 条 |
| Step 4 + Step 3 | AC-4 | 趋势对比 ±20% 过滤 |
| Step 7 | AC-2, AC-7 | Judge 不空输出 + stdin 传 prompt |
| Step 6 | AC-6 | GC 清理 |

## UC-2: 用户 apply 建议后观察效果

- **Actor**: Pi Agent 用户
- **Preconditions**: 至少 1 条 suggestion 已 apply（通过 `/evolve-apply action=apply`）；后续有新的 session 使用数据
- **Main Flow**:
  1. 用户在 apply 建议后一段时间再次运行 `/evolve`
  2. Effect Tracker 检查 history.jsonl 中最近 7 天的 apply 记录
  3. 读取 apply 时刻的 MetricsSnapshot（before）和当前最新 MetricsSnapshot（after）
  4. 计算关键指标的变化率
  5. 将 effectReview 数据写入信号摘要
  6. LLM Judge 看到效果数据，判断建议是否有效，可能生成后续建议
- **Alternative/Exception Paths**:
  - 无最近 7 天的 apply 记录 → effectReview 为空，Judge 正常工作
  - apply 前的 snapshot 不存在（首次 evolve）→ 跳过该条 apply 的 effect 计算
- **Postconditions**: 信号摘要含 effectReview 字段；LLM Judge 输出可能包含"建议有效/无效"的判断
- **Module Boundaries**: commands.ts → effect-tracker.ts → state.ts

### Spec AC 覆盖映射

| UC Step | AC | 覆盖说明 |
|---------|-----|---------|
| Step 3 | AC-5 | effectReview 数据 |
| Step 4 | AC-5 | 前后指标对比 |
