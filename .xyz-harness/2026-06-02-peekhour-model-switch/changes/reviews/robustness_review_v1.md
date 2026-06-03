---
verdict: pass
must_fix: 0
reviewer: robustness-reviewer
date: 2026-06-03
scope: packages/model-switch/src/{advisor,prompt,index,config,types}.ts
---

# Robustness Review — peekhour-model-switch

## 变更摘要

将 model-switch 从"推荐引擎"（computeRecommendation → 推荐 A 模型）重构为"数据注入层"（提取用量/粘性数据 + 规则 → AI 自主决策）。删除了 `computeRecommendation`、`detectScene`、`budgetDecision` 及 `Recommendation` 类型。新增 `StickinessInfo`、`ContextPromptData`、`applyDefaults` 等。

---

## 六维度审查

### 1. 错误处理：空值/null 边界

| 场景 | 处理方式 | 评价 |
|------|---------|------|
| `cache` 为空对象 `{}` | `computeQuotaSnapshot` 返回 `{ zai: null, ocg: null }` | ✅ 安全，prompt 中 zai/ocg 行不输出 |
| `config` 为 null | `index.ts:52` 提前 `return`（before_agent_start）；`handleRecommend` 等各 handler 均有 null guard | ✅ 一致 |
| `entries` 为空数组 `[]` | `computeStickiness` 循环不执行，返回 `{ turns: 0, inputTokens: 0, justCompacted: false }` | ✅ 安全 |
| `currentModel` 为空字符串 | `formatCurrentLine` 输出 `Current:  (0 turns, ~0k input)`，模型名空但格式不崩 | ⚠️ 轻微：`provider/modelId` 中间有空格，不影响功能但可读性差 |
| `zaiData.tokensPct` 缺失 | `?? 0` 兜底 | ✅ |
| `ocgData.monthly` 缺失（旧 cache 格式） | `?.` + `?? 0` 链式兜底 | ✅ |
| JSON parse 失败 | `loadConfig` try/catch → `console.warn` → `return null` | ✅ |

**结论**：所有空值路径覆盖完整，无 crash 风险。

### 2. 异常管理：try/catch 覆盖

| 位置 | try/catch | 评价 |
|------|-----------|------|
| `before_agent_start` (L53-70) | 外层 try/catch，catch 中静默 `return` | ✅ 合理——注入失败不应阻塞 agent 启动 |
| `handleRecommend` (L209-225) | try/catch，catch 返回错误消息给用户 | ✅ 合理——工具调用应返回可读错误 |
| `handleSwitch` → `switchToModel` (L236-256) | try/catch 包裹 `pi.setModel` + `appendEntry` | ✅ |
| `loadConfig` (config.ts) | try/catch 包裹 `readFileSync` + `JSON.parse` | ✅ |

**一个问题**：`before_agent_start` 的 catch 块完全静默（无 `console.warn`）。如果 `computeQuotaSnapshot` 或 `computeStickiness` 抛出异常（比如 cache 数据结构意外变化），用户完全无感知，debug 困难。

**严重度**：低。before_agent_start 每个 turn 都调用，下一 turn 可能自愈。但建议加一行 `console.warn`。

### 3. 日志：console.warn 使用

| 位置 | 消息 | 评价 |
|------|------|------|
| config.ts:38 | `[model-switch] Failed to parse ${CONFIG_PATH}:` + err | ✅ 含文件路径 |
| config.ts:45 | `[model-switch] Invalid config: expected object` | ✅ |
| config.ts:51 | `[model-switch] Unsupported config version: ...` | ✅ 含 version 值 |
| config.ts:57-65 | `[model-switch] Config missing "models/scenes/plans/stickiness"` | ✅ 具体字段名 |

**缺失**：`before_agent_start` 和 `handleRecommend` 的 catch 块没有 `console.warn`。`handleRecommend` 的错误信息返回给用户但没记到 console，生产环境排查只能靠用户截图。

### 4. Fail-fast：config 格式错误时行为

| 条件 | 行为 | 评价 |
|------|------|------|
| 文件不存在 | `return null` | ✅ 降级模式合理 |
| JSON 解析失败 | `console.warn` + `return null` | ✅ |
| version ≠ 1 | `console.warn` + `return null` | ✅ |
| 缺少顶层字段 | `console.warn` + `return null` | ✅ 逐一检查 |
| 新字段缺失 | `applyDefaults` 填充默认值 | ✅ 向后兼容 |

`applyDefaults` 设计正确：只为 `undefined` 字段填充默认值，不会覆盖用户显式配置。嵌套 `thresholds` 的部分填充也处理了。

**注意**：`applyDefaults` 不会校验值范围（如 `rollingLimitPct: 999`）。但这与 fail-fast 原则不冲突——范围校验属于 validation 层，当前设计选择信任用户配置，合理。

### 5. 测试友好：纯函数 & 副作用

| 函数 | 纯函数 | 可 mock 的外部依赖 | 评价 |
|------|--------|-------------------|------|
| `computeQuotaSnapshot(cache)` | ✅ | 无 | 输入 CacheData，输出 QuotaSnapshot |
| `computeStickiness(entries, config?)` | ✅ | 无 | 输入 entries + 可选 config |
| `parseZaiResetTime(label)` | ✅ | 无 | 简单字符串解析 |
| `formatContextPrompt(data)` | ✅ | 无 | 所有数据通过参数传入 |
| `loadConfig()` | ❌ | `fs` | 读文件，有 IO 副作用 |
| `applyDefaults(config)` | ⚠️ | 无 | mutate 输入对象 |

**评价**：核心数据提取层全部纯函数化，测试友好性很高。`applyDefaults` 是 mutable 的但只在新字段为 `undefined` 时写入，实际使用中不会造成意外。`loadConfig` 的 IO 不可避免。

**改进建议**（非必须）：将 `applyDefaults` 改为返回新对象（`{ ...plan, ... }`），消除 mutation。但当前实现已足够安全。

### 6. 调试友好：错误消息上下文

| 错误场景 | 消息质量 | 评价 |
|----------|---------|------|
| config 解析失败 | 含文件路径 + 原始 error | ✅ |
| config 字段缺失 | 含具体字段名 | ✅ |
| tool 错误 | 含 Error.message | ✅ |
| before_agent_start 失败 | **无消息** | ⚠️ 见下 |
| `formatResetSec(0)` | 输出 `?` 而非空字符串 | ✅ 比 diff 前的 `""` 更好 |

**before_agent_start 静默失败的风险**：如果 `readCache()` 返回意外结构（如 `null` 而非 `{}`），`computeQuotaSnapshot(cache)` 中 `cache as Record<string, unknown>` 会在属性访问时抛 TypeError。catch 吞掉后，用户看到的是模型上下文注入消失，但没有错误提示。下一 turn 可能重复同样错误。

**缓解因素**：`readCache()` 来自外部包，API 契约相对稳定。且 `as Record<string, unknown>` 对 `null` 是安全的（只是后续属性访问不会匹配到 key）。

---

## 发现汇总

| # | 严重度 | 类别 | 描述 |
|---|--------|------|------|
| F1 | Low | 日志 | `before_agent_start` catch 块缺少 `console.warn`，异常时完全静默 |
| F2 | Info | 测试 | `applyDefaults` 直接 mutate 输入对象，纯函数风格可更彻底 |
| F3 | Info | 格式 | `currentModel` 为空时 `formatCurrentLine` 输出 `Current:  (0 turns...)`，模型名位置有空字符串 |

## 建议（非阻塞）

1. **F1**：在 `before_agent_start` 的 catch 块加一行：
   ```typescript
   } catch (err) {
     console.warn("[model-switch] before_agent_start injection failed:", err);
     return;
   }
   ```

2. **F3**：在 `getCurrentModelId` 返回空时提供 fallback：
   ```typescript
   const displayModel = currentModel || "(unknown)";
   ```

## Verdict

**PASS** — 变更将推荐引擎简化为数据注入层，健壮性显著提升。所有关键路径有空值兜底，fail-fast 策略一致，纯函数设计使测试友好。三个发现均为低严重度/信息级别，不影响功能正确性。
