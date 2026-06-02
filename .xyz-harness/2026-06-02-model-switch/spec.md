---
verdict: pass
---

# Model Switch — 智能模型推荐与切换

## Background

Pi coding agent 支持多个 LLM provider（zai/opencode-go/kimi-coding），每个 provider 下有多个模型。不同模型在成本、能力（推理/多模态/编码）、套餐额度上差异显著。

当前痛点：

1. **AI 不知道何时切换模型**：没有机制告诉 AI "现在是高峰期，应该用便宜的模型"
2. **套餐用量不可见**：statusline 展示了用量，但 AI 看不到原始数据，无法据此决策
3. **KV Cache 成本被忽略**：频繁切换模型会导致 input tokens 重复计费，需要粘性保护
4. **高峰期预算分配**：zai 套餐 14:00-18:00 三倍计费，需要智能分配"什么时候用 zai、什么时候用替代"

## Functional Requirements

### FR-1: quota-providers 包抽取

从 statusline 扩展中抽出 provider 数据拉取 + 缓存层，作为独立 private 包 `@zhushanwen/pi-quota-providers`。

**FR-1.1: 抽取范围**

从 `packages/statusline/src/providers/` 和 `packages/statusline/src/cache.ts` 中抽取以下模块到新包：

- `types.ts` — `QuotaProvider`、`NormalizedQuotaRow`、`QuotaWindow` 接口
- `cache.ts` — TTL 缓存 + 磁盘持久化 + `readCache()` + `triggerUpdate()`
- `providers/` — 所有 provider 实现（zhipu、opencode-go、kimi-coding、minimax、tavily）
- `registry.ts` — `PROVIDERS` 数组 + `providerById()` 导出

**FR-1.2: statusline 简化**

statusline 扩展改为依赖 `@zhushanwen/pi-quota-providers`，不再自行包含 provider 和 cache 实现。statusline 只保留渲染逻辑。

**FR-1.3: 缓存文件路径**

缓存文件路径保持 `~/.pi/statusline_cache.json` 不变（向后兼容）。两个扩展共享同一份缓存文件，cache 内部的 `lastUpdateAt` 去重机制保证不会重复网络请求。

### FR-2: 模型配置

用户通过 `~/.pi/agent/model-policy.json` 配置模型映射、场景偏好和预算规则。

**FR-2.1: 配置文件结构**

```json
{
  "version": 1,
  "models": {
    "<alias>": {
      "provider": "<Pi provider 名>",
      "modelId": "<Pi model ID>",
      "plan": "<套餐标识>",
      "capabilities": ["coding", "reasoning", "planning", "chat", "vision"]
    }
  },
  "scenes": {
    "<场景名>": ["<模型 alias 优先级排序>"]
  },
  "plans": {
    "<套餐标识>": {
      "priority": <数字, 越小越优先>,
      "peak": { "start": <小时>, "end": <小时>, "multiplier": <倍数> },
      "budgetTarget": <百分比>
    }
  },
  "stickiness": {
    "minTurns": <连续 turn 数阈值>,
    "minInputTokens": <累积 input tokens 阈值>
  }
}
```

**FR-2.2: 配置加载**

扩展在 `session_start` 时加载配置文件。文件不存在或格式错误时，扩展降级为"仅提供手动切换工具"模式，不注入推荐。

### FR-3: 推荐引擎

每个 turn 自动计算推荐模型，注入 system prompt。

**FR-3.1: 决策输入**

每次计算时获取：

- 当前时间（`Date.now()`）
- zai 套餐用量：`tokensPct`（已用百分比）、`resetSec`（5h 窗口重置剩余秒数）
- opencode-go 套餐用量：`rolling.pct`、`weekly.pct`
- 当前模型和 KV Cache 粘性数据（来自 session entries）

**FR-3.2: 决策分层**

三个维度按优先级从高到低：

| 优先级 | 维度 | 规则 |
|--------|------|------|
| 1 | 场景硬性需求 | `vision` → mimo 系列，`planning` → ds-pro。这些场景固定使用特定模型，不受预算影响 |
| 2 | KV Cache 粘性 | 如果当前模型已连续使用 ≥ `minTurns` turn 且累积 ≥ `minInputTokens` input tokens，且当前模型属于推荐场景的候选模型之一，则倾向于保持当前模型不切换。**例外**：最近刚发生 compaction（`turnsSinceCompaction ≤ 1`），KV Cache 已失效，可自由切换 |
| 3 | 预算决策 | 高峰期（zai 14:00-18:00）推荐使用 opencode-go 替代；非高峰期优先使用 zai。详见 FR-3.3 |

**FR-3.3: 预算决策算法**

```
budgetDecision(zai, ocg, now):
  zaiRemaining = budgetTarget - zai.tokensPct
  isPeak = (peak.start ≤ now.hour < peak.end)

  if !isPeak:
    return { provider: "zai" }

  // 以下是高峰期逻辑
  urgency = (zai.resetSec < 3600) && (zaiRemaining > 15)

  if urgency:
    return { provider: "zai", urgent: true }   // 快重置+还有很多额度，不用就浪费
  if zaiRemaining ≤ 0:
    return { provider: "ocg" }                  // 已超预算目标
  if ocg.rollingPct > 80:
    return { provider: "zai" }                  // opencode-go 也快满了，没理由省

  return { provider: "ocg" }                    // 正常高峰期 → 用便宜的
```

**FR-3.4: 粘性计算**

从 `ctx.sessionManager.getBranch()` 扫描 entries，提取：

- 当前模型（最后一个 `model_change` 条目的 `provider/modelId`）
- 连续 turn 数（自最后一次 `model_change` 或 `compaction` 后的 assistant message 数）
- 累积 input tokens（同范围内所有 assistant message 的 `usage.input` 之和）
- 距上次 compaction 的 turn 数

**FR-3.5: 最终推荐**

综合三层决策后，从场景偏好列表中选择具体模型：

1. 预算决策确定 provider（zai 或 ocg）
2. 从场景偏好列表中找到属于该 provider 的第一个模型
3. 如果推荐模型 != 当前模型，执行粘性检查
4. 粘性抵抗时保持当前模型（除非 urgency 强制覆盖）

### FR-4: Prompt 注入

在每个 turn 的 system prompt 中注入精简的推荐信息（约 150-200 tokens）。

**FR-4.1: 注入方式**

通过 `before_agent_start` 事件，在 handler 返回中追加 `systemPrompt` 片段。

**FR-4.2: 注入格式**

正常推荐模式：
```
[Model Advisor]
Status: Peak hours (15:23, 3x Z.ai cost until 18:00)
Z.ai: 72% [5h: 1h22m] | opencode-go: rolling 35%, weekly 45%

>>> Recommended: opencode-go/ds-flash (save Z.ai for after 18:00)
Scene guide: coding→glm-5.1(after 18:00)/ds-flash(now) | planning→ds-pro | vision→mimo-v2.5-pro
To switch: use switch_model tool
```

粘性覆盖模式：
```
[Model Advisor]
Status: Peak hours (15:23, 3x Z.ai cost until 18:00)
Z.ai: 72% [5h: 1h22m] | opencode-go: rolling 35%, weekly 45%

>>> Budget recommends: opencode-go/ds-flash, BUT staying on zhipu/glm-5.1
Reason: 8 turns / 120K tokens KV cache. Switch cost > peak surcharge.
Override: use switch_model tool to force switch.
```

**FR-4.3: 注入条件**

- 配置文件存在且格式正确时注入
- `before_agent_start` 事件中计算推荐并注入
- 注入内容包含当前推荐、套餐状态、场景映射、当前模型粘性信息

### FR-5: switch_model 工具

提供手动切换模型的工具，替代 pi-model-switch（未安装）。

**FR-5.1: 工具参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum | 是 | `list` / `search` / `switch` / `recommend` |
| `query` | string | 否 | search/switch 时的搜索词（模型 alias、provider/modelId） |

**FR-5.2: 行为**

- `list`：列出配置中所有模型及其状态（当前模型标注标记）
- `search`：按 alias / provider / modelId 模糊搜索
- `switch`：切换到指定模型（通过 `pi.setModel()`）。支持 alias（如 `glm-5.1`）和完整 ID（如 `zhipu/glm-5.1-plus`）
- `recommend`：返回当前推荐结果和推荐原因（调试用）

**FR-5.3: 切换后的 session entry**

切换成功后，通过 `ctx.sessionManager.appendEntry()` 记录一次 `model_change` entry（与 Pi 核心的 `model_select` 事件记录格式一致），确保粘性计算在下一个 turn 立即感知到模型变化。

### FR-6: quota-providers 包的公共 API

**FR-6.1: 导出接口**

```typescript
// 缓存读取（TTL 过期时自动触发后台刷新）
export function readCache(): CacheData;

// 手动触发刷新（去重保护）
export function triggerUpdate(): void;

// Provider 注册表
export const PROVIDERS: QuotaProvider[];
export function providerById(id: string): QuotaProvider | undefined;

// 类型导出
export type { QuotaProvider, NormalizedQuotaRow, QuotaWindow, CacheData };
export type { ZhipuData, OpenCodeGoData, KimiCodingData, MinimaxData, TavilyData };
```

**FR-6.2: 包依赖**

该包仅依赖 Node.js 内置模块（`fs`、`os`、`path`），无第三方依赖。`fetch` 使用 Node.js 内置的全局 `fetch`。

## Acceptance Criteria

### AC-1: quota-providers 包

- [ ] `packages/quota-providers/` 存在，`package.json` 中 `name` 为 `@zhushanwen/pi-quota-providers`，`private: true`
- [ ] `pnpm --filter @zhushanwen/pi-quota-providers typecheck` 通过
- [ ] statusline 扩展改为依赖此包，`pnpm --filter @zhushanwen/pi-statusline typecheck` 通过
- [ ] `readCache()` 返回的数据结构与迁移前一致
- [ ] 缓存文件路径 `~/.pi/statusline_cache.json` 不变

### AC-2: model-switch 扩展

- [ ] `packages/model-switch/` 存在，`package.json` 中 `name` 为 `@zhushanwen/pi-model-switch`
- [ ] `pnpm --filter @zhushanwen/pi-model-switch typecheck` 通过
- [ ] `switch_model` 工具注册成功，支持 list/search/switch/recommend 四种 action
- [ ] 配置文件 `~/.pi/agent/model-policy.json` 不存在时，扩展降级为仅手动切换工具模式

### AC-3: 推荐引擎

- [ ] 非高峰期 + coding 场景 + zai 额度充足 → 推荐 glm-5.1
- [ ] 高峰期 + coding 场景 + zai 额度充足 + ocg 额度充足 → 推荐 ds-flash
- [ ] 高峰期 + coding 场景 + zai 快重置 + 剩余额度多 → 推荐 glm-5.1（urgency）
- [ ] 高峰期 + coding 场景 + zai 已超预算目标 → 推荐 ds-flash
- [ ] vision 场景 → 推荐 mimo-v2.5-pro（不受预算影响）
- [ ] planning 场景 → 推荐 ds-pro（不受预算影响）

### AC-4: 粘性保护

- [ ] 当前模型连续 ≥ 3 turn 且累积 ≥ 20K input tokens 时，预算推荐的切换被粘性阻止
- [ ] compaction 后 1 turn 内，粘性检查返回"可自由切换"
- [ ] urgency 场景（快重置+大量剩余额度）强制切换，忽略粘性

### AC-5: Prompt 注入

- [ ] `before_agent_start` 事件触发时，推荐信息被追加到 system prompt
- [ ] 注入格式包含：状态行、套餐用量、推荐模型、场景映射
- [ ] 注入内容 ≤ 200 tokens

### AC-6: 全量类型检查

- [ ] `pnpm -r typecheck` 通过（包含新包和修改后的 statusline）

## Constraints

### 技术约束

- TypeScript，Pi 运行时执行，不独立编译
- 依赖 `@mariozechner/pi-coding-agent` Extension API
- quota-providers 无第三方依赖
- model-switch 依赖 quota-providers + Pi SDK

### 运行时约束

- 扩展在 Pi 进程内执行，不是独立进程
- `readCache()` 从磁盘读取缓存文件，`triggerUpdate()` 发起网络请求（有 TTL 去重）
- 推荐计算在每个 `before_agent_start` 时同步执行（无异步网络调用，纯读缓存 + 计算）
- session entries 扫描限于当前 branch（`getBranch()`），不遍历整棵 session tree

### 模型切换约束

- `pi.setModel()` 是异步操作，切换后下一轮对话生效
- `before_provider_request` hook 无法切换模型（只能修改请求 payload）
- 模型切换需要通过 `ctx.modelRegistry.getAvailable()` 确认模型已配置 API key

### 配置约束

- 配置文件路径固定为 `~/.pi/agent/model-policy.json`
- 配置文件不存在时不报错，降级为仅手动切换模式
- 配置文件格式错误时，在 statusline 或 console 输出警告，不阻塞 session

## 业务用例

### UC-1: 高峰期自动推荐替代模型

- **Actor**: AI agent
- **场景**: 用户在 14:30 发起 coding 对话，当前使用 glm-5.1
- **预期结果**: 扩展检测到高峰期，在 system prompt 中注入推荐"opencode-go/ds-flash"。AI 看到推荐后调用 `switch_model` 工具切换到 ds-flash。对话继续使用 ds-flash。

### UC-2: KV Cache 粘性阻止不必要的切换

- **Actor**: AI agent
- **场景**: 用户在 14:30 发起 coding 对话，当前使用 glm-5.1 且已连续 8 turn / 120K tokens
- **预期结果**: 扩展检测到高峰期但粘性保护生效，在 system prompt 中注入"staying on glm-5.1 due to KV cache"。AI 不切换，继续使用 glm-5.1。

### UC-3: Compaction 后自由切换

- **Actor**: AI agent
- **场景**: 高峰期，context compaction 刚发生，当前模型 glm-5.1
- **预期结果**: 扩展检测到 compaction 后 1 turn 内，粘性检查返回"可自由切换"。推荐 ds-flash，AI 切换。

### UC-4: Urgency 强制使用即将过期的额度

- **Actor**: AI agent
- **场景**: 高峰期 14:30，zai 5h 窗口还剩 40min 重置，zai 已用 20%（还有 65% 预算）
- **预期结果**: 扩展检测到 urgency 条件成立，推荐 glm-5.1（不用就浪费了），忽略粘性。

### UC-5: 手动切换模型

- **Actor**: AI agent（用户请求）
- **场景**: 用户说"切换到 ds-pro"
- **预期结果**: AI 调用 `switch_model` 工具 `action=switch query=ds-pro`，工具通过 `pi.setModel()` 切换模型。

### UC-6: Vision 场景固定使用多模态模型

- **Actor**: AI agent
- **场景**: 用户上传图片，需要 image analysis
- **预期结果**: 无论高峰期还是非高峰期，推荐 mimo-v2.5-pro。场景硬性需求不受预算影响。

### UC-7: 配置文件缺失时降级

- **Actor**: AI agent
- **场景**: `model-policy.json` 不存在
- **预期结果**: 扩展仅注册 `switch_model` 工具（支持 list/search/switch），不注入推荐信息。AI 仍可手动切换模型。

## Complexity Assessment

- **quota-providers 抽取**：中等（重构现有代码，不涉及新逻辑）
- **推荐引擎**：中等（纯函数计算，算法确定，无 ML/异步）
- **Prompt 注入**：低（字符串拼接 + `before_agent_start` handler）
- **switch_model 工具**：低（参考 pi-model-switch 的实现，参数解析 + `pi.setModel()`）
- **粘性计算**：中等（session entries 遍历 + 统计）
- **总体**：中等。核心复杂度在推荐引擎的分层决策和粘性保护，但都是确定性逻辑。

## Out of Scope

- **自动切换模式**（`before_agent_start` 时无 AI 参与直接调用 `pi.setModel()`）：不实现。所有切换都通过 AI 调用 `switch_model` 工具
- **模型能力自动检测**：不自动发现模型是否支持 vision/reasoning，依赖用户在配置中声明
- **用量预测/趋势分析**：不预测未来用量，仅基于当前快照做推荐
- **多用户/多配置**：不支持按项目或按 session 使用不同配置
- **与 pi-model-switch 共存**：不兼容，本扩展完全替代
