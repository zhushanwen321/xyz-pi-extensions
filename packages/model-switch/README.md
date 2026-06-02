# @zhushanwen/pi-model-switch

Pi coding agent 的智能模型推荐与切换扩展。

根据套餐用量、高峰期规则、场景需求和 KV Cache 粘性，自动推荐最佳模型并通过 prompt 注入告知 AI。

## 安装

```bash
pi install npm:@zhushanwen/pi-model-switch
```

重启 Pi 后生效。

## 快速开始

### 1. 生成配置

首次使用需要生成 `~/.pi/agent/model-policy.json` 配置文件。

**方式 A：自动生成（推荐）**

在 Pi 中运行：

```
/setup-model-policy
```

扩展会自动读取你已配置的模型（优先使用 `settings.json` 中的 `enabledModels`），按 provider 分组，推断场景偏好和套餐规则，生成配置并展示给你确认。

**方式 B：手动创建**

按照下方配置格式手动创建 `~/.pi/agent/model-policy.json`。

### 2. 配置生效

配置文件创建后，下一个 turn 自动生效。扩展会在每次对话开始时：

1. 读取套餐用量缓存
2. 计算当前时间和高峰期状态
3. 评估 KV Cache 粘性
4. 在 system prompt 中注入推荐信息（约 150-200 tokens）

### 3. 切换模型

AI 看到 `switch_model` 工具后可随时切换：

```
用户: 切换到 ds-pro
AI: (调用 switch_model action=switch query=ds-pro)
```

## 配置文件格式

`~/.pi/agent/model-policy.json`：

```json
{
  "version": 1,
  "models": {
    "glm-5.1": {
      "provider": "zhipu",
      "modelId": "glm-5.1-plus",
      "plan": "zai",
      "capabilities": ["coding", "reasoning", "planning", "chat"]
    },
    "ds-flash": {
      "provider": "opencode-go",
      "modelId": "deepseek-chat-v3-0324",
      "plan": "opencode-go",
      "capabilities": ["coding", "chat"]
    }
  },
  "scenes": {
    "coding": ["glm-5.1", "ds-flash"],
    "planning": ["ds-pro", "glm-5.1"],
    "vision": ["mimo-v2.5-pro", "mimo-v2.5"],
    "chat": ["ds-flash", "glm-turbo"]
  },
  "plans": {
    "zai": {
      "priority": 1,
      "peak": { "start": 14, "end": 18, "multiplier": 3 },
      "budgetTarget": 85
    },
    "opencode-go": {
      "priority": 2
    }
  },
  "stickiness": {
    "minTurns": 3,
    "minInputTokens": 20000
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `models` | 模型别名到 Pi provider/modelId 的映射，含所属套餐和能力标签 |
| `scenes` | 场景偏好列表，数组顺序 = 优先级顺序 |
| `plans` | 套餐配置：priority（越小越优先）、peak（高峰期时段）、budgetTarget（目标消耗百分比） |
| `stickiness` | KV Cache 粘性保护阈值：连续 turn 数和累积 input tokens |

## 推荐引擎

### 三层决策

| 优先级 | 维度 | 规则 |
|--------|------|------|
| 1 | 场景硬性需求 | `vision` → 多模态模型，`planning` → 推理模型。不受预算影响 |
| 2 | KV Cache 粘性 | 连续 ≥ `minTurns` turn 且累积 ≥ `minInputTokens` tokens 时，倾向不切换。compaction 后 1 turn 内可自由切换 |
| 3 | 预算决策 | 非高峰期优先使用高优先级套餐；高峰期自动降级到低成本套餐 |

### 预算算法

```
非高峰期 → 使用高优先级套餐（如 zai）
高峰期:
  - 窗口快重置 + 还有大量预算 → 仍然使用高优先级套餐（urgency）
  - 已超预算目标 → 切换到低成本套餐
  - 低成本套餐也快满了 → 仍然使用高优先级套餐
  - 其他 → 切换到低成本套餐
```

## switch_model 工具

| Action | 说明 |
|--------|------|
| `list` | 列出配置中所有模型（标注当前模型） |
| `search` | 按别名/provider/modelId 模糊搜索 |
| `switch` | 切换到指定模型 |
| `recommend` | 查看当前推荐结果和原因 |
| `setup` | 自动生成配置 JSON（无配置时可用） |

## /setup-model-policy 命令

自动生成 `model-policy.json` 的流程：

1. 读取 `settings.json` 中的 `enabledModels`（如果没有则降级到全部已配置 API key 的模型）
2. 按 provider 分组
3. 推断每个模型的能力标签（reasoning → planning，vision → 多模态，其余 → coding/chat）
4. 推断套餐规则（zai 套餐默认启用高峰期 14:00-18:00 3x 计费 + 85% 预算目标）
5. 展示生成的配置供用户确认修改

生成后用户可以让 AI 调整任何字段，确认后写入文件。

## 降级模式

配置文件不存在时：
- 不注入推荐信息
- `switch_model` 工具仍可使用 `list`/`search`/`switch`/`setup` action
- 运行 `/setup-model-policy` 可自动生成配置

## 依赖

本扩展依赖 `@zhushanwen/pi-quota-providers`（private 包）获取套餐用量数据。

## License

MIT
