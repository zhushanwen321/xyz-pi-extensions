---
verdict: pass
---

# Use Cases — peekhour-model-switch

## UC-1: 非高峰期 coding

- **Actor**: AI agent
- **Preconditions**: model-policy.json 存在；当前时间非高峰期（如 10:00）；statusline_cache.json 有 Z.ai 和 ocg 数据
- **Main Flow**:
  1. 用户发送 coding 请求
  2. `before_agent_start` 触发，读取 cache、entries、config
  3. `formatContextPrompt` 生成注入文本，含 "Off-peak" + "prefer zai" 规则
  4. AI 看到注入，判断当前在 coding 场景
  5. AI 不调用 switch_model（已经在 glm-5.1 上）或主动切到 glm-5.1
  6. AI 在 glm-5.1 上完成 coding
- **Alternative/Exception Paths**:
  - Z.ai rolling ≥95% → AI 看到 "Switch to ocg only when zai rolling ≥95%" → 切到 ocg
  - Cache 为空 → 注入跳过 quota 行，AI 按规则默认优先 zai
- **Postconditions**: coding 完成且使用 glm-5.1（或 Z.ai 满了用 ocg）
- **Module Boundaries**: advisor.ts (snapshot+stickiness) → prompt.ts (format) → index.ts (inject)
- **Spec AC 覆盖**: AC-1 (完整注入), AC-4 (非高峰规则)

## UC-2: 高峰期 ocg 充裕

- **Actor**: AI agent
- **Preconditions**: 当前时间 14:00-17:59；ocg rolling < 80%，weekly < 80%；Z.ai 有余量
- **Main Flow**:
  1. 用户发送 coding 请求
  2. 注入含 "Peak (3x zai cost). Prefer ocg unless..." 规则
  3. AI 判断 ocg 充裕（从 ocg 数据行看到 rolling 40%）
  4. AI 调用 `switch_model` action=switch query=ds-flash
  5. 模型切换到 ds-flash（下一 turn 生效）
  6. 后续 coding 在 ds-flash 上进行
- **Alternative/Exception Paths**:
  - AI 当前已在 ds-flash → 不调用 switch_model
  - switch_model 返回 model not available → AI 继续用当前模型
- **Postconditions**: 使用 ds-flash 完成任务，Z.ai 配额被节省
- **Module Boundaries**: index.ts (handleSwitch) → pi.setModel → advisor.ts (quota snapshot)
- **Spec AC 覆盖**: AC-4 (高峰规则)

## UC-3: 高峰期 ocg 快满

- **Actor**: AI agent
- **Preconditions**: 当前时间 14:00-17:59；ocg rolling ≥ 80%
- **Main Flow**:
  1. 用户发送请求
  2. 注入含 Peak 规则 + "ocg rolling 85%" 数据
  3. AI 判断 ocg near limit（≥80%）
  4. AI 不切换，继续使用当前模型（glm-5.1）
- **Alternative/Exception Paths**:
  - ocg weekly 也 ≥80% → 更确定不切 ocg
  - ocg rolling 正常但 weekly ≥80% → AI 仍倾向不切
- **Postconditions**: 留在 glm-5.1，ocg 配额不被进一步消耗
- **Module Boundaries**: prompt.ts (规则注入) → AI 自主决策
- **Spec AC 覆盖**: AC-4 (高峰规则 ocg near limit 条件)

## UC-4: 高峰期 urgent（窗口即将释放）

- **Actor**: AI agent
- **Preconditions**: 当前时间 17:15；Z.ai 70% [reset 45m]
- **Main Flow**:
  1. 用户发送请求
  2. 注入含 Peak 规则 + "Z.ai: 70% [5h, reset 45m]" 数据
  3. AI 判断 reset 45m < 1h + budget remaining 30% > 20%
  4. AI 继续用 glm-5.1（配额即将释放，浪费可惜）
- **Alternative/Exception Paths**:
  - Z.ai 95% + reset 45m → AI 判断即使即将释放也不够，可能切 ocg
  - reset 2h → 不触发 urgent 条件，AI 可能切 ocg
- **Postconditions**: glm-5.1 消耗即将释放的配额
- **Module Boundaries**: advisor.ts (parseZaiResetTime) → prompt.ts (resetSec 格式化) → AI 决策
- **Spec AC 覆盖**: AC-2 (真实 cache), AC-4 (高峰规则 zai resetting 条件)

## UC-5: 首次启动无 cache

- **Actor**: AI agent
- **Preconditions**: statusline_cache.json 不存在或 updatedAt=0
- **Main Flow**:
  1. 用户发送请求
  2. `computeQuotaSnapshot` 返回 `{ zai: null, ocg: null }`
  3. `formatContextPrompt` 跳过 quota 行
  4. 注入只含时间 + 规则 + 粘性 + 场景映射
  5. AI 按规则默认优先 zai（非高峰期）
- **Alternative/Exception Paths**:
  - 第二个 turn cache 已有数据 → 正常注入 quota 行
- **Postconditions**: 不崩溃，AI 仍能基于规则决策
- **Module Boundaries**: advisor.ts (null snapshot) → prompt.ts (skip quota) → index.ts (inject)
- **Spec AC 覆盖**: AC-2 (cache 为空跳过)

## UC-6: compaction 后自由切换

- **Actor**: AI agent
- **Preconditions**: 会话在 glm-5.1 上跑了 10+ turns；发生 compaction
- **Main Flow**:
  1. compaction 后用户发送消息
  2. `computeStickiness` 检测到 compaction entry 且 ≤1 turn → justCompacted=true
  3. 注入 Stickiness 行："Free switch (just compacted)."
  4. AI 知道 KV cache 已清空，切换成本 ≈0
  5. AI 根据场景和规则选择最优模型，自由切换
- **Alternative/Exception Paths**:
  - compaction 后 2+ turns → justCompacted=false，正常粘性规则
- **Postconditions**: AI 自由选择模型，不受粘性约束
- **Module Boundaries**: advisor.ts (computeStickiness justCompacted) → prompt.ts (Stickiness 行)
- **Spec AC 覆盖**: AC-3 (justCompacted ≤1 turn)

## 覆盖映射表

| UC | AC-1 | AC-2 | AC-3 | AC-4 | AC-5 | AC-6 | AC-7 |
|----|------|------|------|------|------|------|------|
| UC-1 | ✅ | | | ✅ | | | |
| UC-2 | | | | ✅ | | | |
| UC-3 | | | | ✅ | | | |
| UC-4 | | ✅ | | ✅ | | | |
| UC-5 | | ✅ | | | | | |
| UC-6 | | | ✅ | | | | |
| 向后兼容 | | | | | ✅ | | |
| 推荐引擎删除 | | | | | | ✅ | |
| setup 新字段 | | | | | | | ✅ |
