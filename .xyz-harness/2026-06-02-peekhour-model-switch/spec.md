---
verdict: pass
---

# PeekHour-Aware Model Switch

## Background

`@zhushanwen/pi-model-switch` 扩展在每个 turn 的 `before_agent_start` 阶段注入模型推荐信息。当前实现有两个结构性缺陷：

1. **推荐引擎不读真实用量**：`computeRecommendation()` 内部的 `computeQuotaSnapshotFromCache()` 是 stub，始终返回 `{ zai: null, ocg: null }`。`readCache()` 获取的真实用量数据只传给了 `formatAdvisorPrompt()` 格式化，没传给推荐算法。
2. **场景检测不可靠**：`detectScene()` 用关键词匹配系统 prompt（`\b(plan|architecture|design)\b` → planning），无法准确区分 AI 当前在 coding 还是 planning。
3. **高峰期策略过于粗糙**：只有 binary 判断（高峰期用 ocg / 非高峰期用 zai），没有考虑 rolling window 释放动力学、紧急消耗场景、underutilized 预测。

用户有两个 provider：
- **router-openai/glm-5.1**（Z.ai 套餐）：5h rolling token limit，无周/月限制。14-18 点高峰期 3x 计费。
- **router-openai/ds-flash, ds-pro, mimo-v2.5, mimo-v2.5-pro**（opencode-go 套餐）：5h rolling + 周限额 + 月限额，总量有限。

**策略目标**：非高峰期优先用 glm-5.1（1x 计费，无硬性长期限制）；高峰期节省 glm-5.1 配额（避免 3x 消耗），但保证 5h 窗口配额不被浪费。

## Functional Requirements

### FR-1: 数据 + 规则注入（替代推荐引擎）

每个 turn 注入 **事实数据 + 行为规则**，不注入具体推荐结果。AI 基于自身对场景的判断 + 注入的规则自主决策。

注入内容（约 150-200 tokens）：
- **当前时间**：`HH:MM`，高峰期/非高峰期标记
- **当前模型**：provider/modelId + 从上次 model_change 或 compaction 后的 turn 数和累积 input tokens
- **粘性提示**：是否刚 compaction（free switch）、当前模型 cache 热度
- **Z.ai 用量**：5h rolling pct + reset 倒计时。标注无周/月限制。
- **opencode-go 用量**：rolling pct + reset、weekly pct + reset、monthly pct + reset
- **行为规则**：高峰期策略的一句话总结
- **场景映射**：从 model-policy.json 的 `scenes` 字段读取，格式如 `coding→glm-5.1/ds-flash | vision→mimo-v2.5/mimo-v2.5-pro | planning→ds-pro/glm-5.1 | chat→ds-flash/glm-5.1`。每个场景的模型列表即为配置中 `scenes[sceneName]` 数组的别名列表，按配置顺序排列
- **切换提示**：`Switch: use switch_model tool (takes effect next turn).`

### FR-2: 粘性信息提取

从 `ctx.sessionManager.getBranch()` 返回的 entries 中提取：
1. 最近一个 `type === "model_change"` entry 的索引
2. 最近一个 `type === "compaction"` entry 的索引
3. 从上述两个索引中较后的那个开始，统计 assistant turn 数和累积 input tokens

输出：
- `turnsSinceSwitch: number`
- `inputTokensSinceSwitch: number`
- `justCompacted: boolean`（compaction 后 ≤ 1 个 assistant turn）

### FR-3: 用量快照构建

从 `readCache()` 返回的 `CacheData` 中提取结构化用量：

**Z.ai**（cache key: `"zhipu"`）：
- `pct: number` — 5h rolling tokens 使用百分比
- `resetSec: number` — 5h 窗口首批额度释放倒计时（秒）
- 无周/月限制（不提取）

**opencode-go**（cache key: `"opencodeGo"`）：
- `rollingPct: number` + `rollingResetSec: number`
- `weeklyPct: number` + `weeklyResetSec: number`
- `monthlyPct: number` + `monthlyResetSec: number`

当 cache 无数据（`updatedAt === 0`）时，quota 行跳过，只注入时间 + 规则 + 粘性。

**resetTime 格式**：Z.ai 的 `cache.zhipu.resetTime` 是人类可读的 duration 字符串（如 `"4h39m"`、`"3d20h"`），需解析为秒数。opencode-go 的 `resetInSec` 是整数秒。

### FR-4: 高峰期规则注入

规则文本根据 `model-policy.json` 中的 `plans` 配置动态生成：

**非高峰期**：
> "Off-peak: prefer zai (1x cost, no week/month limit). Switch to ocg only when zai rolling ≥95%."

Z.ai 95% 阈值为固定设计决策（窗口几乎满了才让出），不暴露为配置项，原因：Z.ai 是优先使用的套餐，阈值只作为安全阀。

**高峰期**：
> "Peak (3x zai cost). Prefer ocg unless: ocg rolling/weekly near limit (≥80%), or zai resetting soon (<1h) with budget left, or zai underutilized (<20%). Switch takes effect next turn."

阈值来源：ocg ≥80% 来自 `plans[opencode-go].thresholds`（可配置）；zai <1h 和 <20% 为固定设计参数。

### FR-5: model-policy.json 扩展

在 `PlanConfig` 上新增可选字段（向后兼容，缺省使用默认值）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `peakStrategy` | `"conserve" \| "normal"` | `"conserve"` | 高峰期省 zai 策略 |
| `rollingWindowHours` | `number` | `5` | 滚动窗口大小（小时），用于推测释放速率 |
| `thresholds` | `{ rollingLimitPct?: number, weeklyLimitPct?: number }` | `{ rollingLimitPct: 80, weeklyLimitPct: 80 }` | opencode-go 套餐的限额阈值 |

旧配置无新字段时，`loadConfig()` 填充默认值。

### FR-6: switch_model 工具保留

`switch_model` 工具保持现有 5 个 action（list/search/switch/recommend/setup）不变。

`recommend` action 改为展示当前注入的 **数据快照 + 规则**，而非推荐结果。让用户看到 AI 看到的信息。

### FR-7: setup 命令更新

`/setup-model-policy` 命令生成的配置包含新字段（`peakStrategy`、`rollingWindowHours`、`thresholds`）。

## Acceptance Criteria

### AC-1: 每个 turn 注入完整信息
- [ ] `before_agent_start` 注入包含：当前时间 HH:MM、高峰期标记、当前模型 + turn 数 + input tokens、Z.ai 5h 用量 + reset、ocg 三窗口用量 + reset、行为规则、场景映射
- [ ] 注入文本 ≤ 200 tokens
- [ ] 无 model-policy.json 时静默跳过（降级模式）

### AC-2: 用量数据来自真实 cache
- [ ] Z.ai pct 来自 `cache.zhipu.tokensPct`
- [ ] Z.ai resetSec 来自解析 `cache.zhipu.resetTime`
- [ ] ocg 数据来自 `cache opencodeGo.rolling/weekly/monthly`
- [ ] cache 为空时跳过 quota 行

### AC-3: 粘性信息正确提取
- [ ] 从 `getBranch()` entries 中找 `model_change` 和 `compaction` 事件
- [ ] 统计 switch/compaction 后的 assistant turn 数和 input tokens
- [ ] compaction 后 ≤ 1 turn 标记为 `justCompacted`

### AC-4: 高峰期规则正确
- [ ] 14:00-17:59 标记为高峰期
- [ ] 非高峰期规则：优先 zai，zai≥95% 切 ocg
- [ ] 高峰期规则包含 ocg 限额/urgent/underutilized 三个条件

### AC-5: 向后兼容
- [ ] 旧 model-policy.json（无 `peakStrategy`/`rollingWindowHours`/`thresholds`）正常加载
- [ ] 缺失字段使用默认值
- [ ] `switch_model` 工具 5 个 action 全部正常工作

### AC-6: 推荐引擎移除
- [ ] `computeRecommendation` 函数删除或重写为纯数据提取
- [ ] `detectScene` 函数删除（不再需要场景检测）
- [ ] `budgetDecision` 函数删除（规则以文本注入，不在代码中计算）
- [ ] advisor.ts 只保留：粘性提取 + 用量快照构建

### AC-7: setup 命令更新
- [ ] `/setup-model-policy` 生成的配置 JSON 包含 `peakStrategy`、`rollingWindowHours`、`thresholds` 三个新字段
- [ ] `peakStrategy` 默认值为 `"conserve"`，`rollingWindowHours` 默认值为 `5`，`thresholds` 默认值为 `{ rollingLimitPct: 80, weeklyLimitPct: 80 }`
- [ ] setup 生成摘要中展示新字段及其默认值

## Constraints

- **Pi 运行时限制**：扩展在 Pi 进程内执行，不能使用 fs 之外的 Node 原生模块
- **Session 隔离**：状态通过 `session_start` 重建的闭包变量管理
- **TTL 5min**：quota cache 的刷新间隔为 5 分钟，每 turn 读到的可能是 ≤5min 前的数据
- **模型切换 1-turn 延迟**：`pi.setModel()` 在当前 turn 的 tool call 后生效，下一 turn 的 AI response 才使用新模型。注入文本需提示 AI 这一行为
- **Token 预算**：注入文本 ≤ 200 tokens，避免占用过多上下文窗口
- **向后兼容**：新增的 model-policy.json 字段全部可选，有默认值

## 业务用例

### UC-1: 非高峰期 coding
- **Actor**: AI agent
- **场景**: 上午 10:00，用户请求写代码。Z.ai 5h 用了 45%，ocg rolling 30%
- **预期结果**: AI 看到"Off-peak, prefer glm-5.1"，不切换模型（或切到 glm-5.1），在 glm-5.1 上完成 coding

### UC-2: 高峰期 ocg 充裕
- **Actor**: AI agent
- **场景**: 下午 16:00，用户请求 coding。Z.ai 30%，ocg rolling 40%
- **预期结果**: AI 看到"Peak hours, prefer ds-flash unless..."，判断 ocg 充裕，调用 switch_model 切到 ds-flash

### UC-3: 高峰期 ocg 快满
- **Actor**: AI agent
- **场景**: 下午 15:30，Z.ai 60%，ocg rolling 85%
- **预期结果**: AI 看到"Peak hours, prefer ds-flash unless ocg near limit (≥80%)"，判断 ocg 快满，继续用 glm-5.1

### UC-4: 高峰期 urgent（窗口即将释放）
- **Actor**: AI agent
- **场景**: 下午 17:15，Z.ai 70% [reset 45m]，ocg rolling 40%
- **预期结果**: AI 看到 reset 45m + budget remaining 30%，判断 urgent，继续用 glm-5.1 消耗即将释放的配额

### UC-5: 首次启动无 cache
- **Actor**: AI agent
- **场景**: Pi 刚启动，statusline_cache.json 不存在或 updatedAt=0
- **预期结果**: 注入跳过 quota 行，只注入时间 + 规则 + 粘性

### UC-6: compaction 后自由切换
- **Actor**: AI agent
- **场景**: 会话中发生 compaction，之前在 glm-5.1 上跑了 10 turns
- **预期结果**: 注入显示"justCompacted: free switch"，AI 知道 KV cache 已清空，切换成本接近 0

## 附录 A: 注入文本示例

以下为高峰期场景的完整注入文本（约 150 tokens）：

```
[Model Context]
Current: router-openai/glm-5.1-plus (5 turns, ~40k input)
Stickiness: prefer staying. Free switch after compaction.
Time: 15:30 | Peak hours (14-18, 3x Z.ai)
Z.ai: 60% [5h, reset 2h00m | no week/month limit]
ocg: rolling 42% [reset 54m], weekly 30% [reset 5d], monthly 66% [reset 22d]
Rule: Peak (3x zai cost). Prefer ocg unless: ocg near limit (≥80%), or zai resetting soon (<1h), or zai underutilized (<20%). Switch takes effect next turn.
Scene: coding→glm-5.1/ds-flash | vision→mimo-v2.5/mimo-v2.5-pro | planning→ds-pro/glm-5.1 | chat→ds-flash/glm-5.1
Switch: use switch_model tool.
```

非高峰期场景（约 120 tokens）：

```
[Model Context]
Current: router-openai/ds-flash (2 turns, ~8k input)
Stickiness: prefer staying. Free switch after compaction.
Time: 10:32 | Off-peak
Z.ai: 45% [5h, reset 3h15m | no week/month limit]
ocg: rolling 30% [reset 4h], weekly 20% [reset 3d], monthly 15% [reset 22d]
Rule: Off-peak: prefer zai (1x cost, no week/month limit). Switch to ocg only when zai rolling ≥95%. Switch takes effect next turn.
Scene: coding→glm-5.1/ds-flash | vision→mimo-v2.5/mimo-v2.5-pro | planning→ds-pro/glm-5.1 | chat→ds-flash/glm-5.1
Switch: use switch_model tool.
```

## Complexity Assessment

- **改动文件数**：6（types.ts, config.ts, advisor.ts, prompt.ts, index.ts, setup.ts）
- **核心复杂度**：中等。删推荐引擎（净减代码）+ 改注入格式 + 补用量提取
- **风险点**：向后兼容（旧 config）、cache 为空时的降级行为
- **不需要新依赖**：所有功能基于现有 `quota-providers` 和 Pi SDK
