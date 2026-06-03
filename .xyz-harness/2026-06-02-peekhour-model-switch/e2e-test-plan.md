---
verdict: pass
---

# E2E Test Plan — peekhour-model-switch

## Test Scenarios

### TS-1: 非高峰期注入验证
- **Setup**: 确保 model-policy.json 存在，时间在非高峰期（如 10:00）
- **Steps**:
  1. 启动 Pi session
  2. 发送任意用户消息
  3. 检查 AI 的 system prompt 中是否包含 `[Model Context]` 块
  4. 验证包含 "Off-peak" 标记
  5. 验证包含 Z.ai 用量行（如 cache 有数据）
  6. 验证包含 ocg 用量行（如 cache 有数据）
  7. 验证规则文本为非高峰期规则（"prefer zai"）
- **Expected**: 注入完整，≤200 tokens，无 `>>> Recommended:` 行

### TS-2: 高峰期注入验证
- **Setup**: 时间在 14:00-17:59，或 mock Date
- **Steps**:
  1. 发送用户消息
  2. 检查注入块包含 "Peak" 标记
  3. 验证规则文本为高峰期规则（"Prefer ocg unless"）
  4. 验证包含 "Switch takes effect next turn"
- **Expected**: 高峰期规则正确，包含三个条件（ocg near limit / zai resetting / zai underutilized）

### TS-3: Cache 为空降级
- **Setup**: 删除 statusline_cache.json，重启 Pi
- **Steps**:
  1. 发送用户消息
  2. 检查注入块包含时间 + 规则 + 粘性
  3. 确认无 Z.ai 和 ocg 用量行
- **Expected**: 降级注入，不崩溃

### TS-4: 粘性信息 — compaction 后
- **Setup**: 在 session 中触发 compaction（长对话自动或手动）
- **Steps**:
  1. compaction 后发送 1 条消息
  2. 检查注入块 Stickiness 行包含 "Free switch" 或 "just compacted"
- **Expected**: justCompacted=true 正确标记

### TS-5: switch_model recommend action
- **Setup**: 确保配置存在
- **Steps**:
  1. 让 AI 调用 `switch_model` action=recommend
  2. 验证返回内容是数据快照 + 规则（不是 `>>> Recommended:` 格式）
- **Expected**: 展示 `[Model Context]` 块内容

### TS-6: 向后兼容 — 旧配置
- **Setup**: 使用不含 peakStrategy/rollingWindowHours/thresholds 的 model-policy.json
- **Steps**:
  1. 启动 Pi session
  2. 发送消息
  3. 验证注入正常工作（不崩溃）
  4. 验证默认值生效（高峰期策略为 conserve）
- **Expected**: 正常注入，无报错

### TS-7: setup 命令新字段
- **Setup**: 删除已有 model-policy.json
- **Steps**:
  1. 运行 `/setup-model-policy`
  2. 检查生成的 JSON 包含 `peakStrategy`、`rollingWindowHours`、`thresholds`
  3. 验证默认值正确
- **Expected**: 新字段存在且值正确

## Test Environment

- **Runtime**: Pi agent 进程（需要完整 Pi 运行时）
- **Dependencies**: `statusline_cache.json`（由 statusline 扩展维护）、`model-policy.json`（由 setup 命令生成）
- **Test type**: 集成测试（需要 Pi 运行时，无法在 vitest 中模拟全部 hook 行为）
- **Mock**: 时间 mock 可通过修改 system clock 或在代码中注入 Date 工厂实现（不在本次 scope 内）
