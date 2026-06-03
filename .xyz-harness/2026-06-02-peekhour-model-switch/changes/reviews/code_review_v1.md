---
# Code Review Report — v2 Redesign
review_round: 1
changes: 8 source files, 2 packages
status: PASS
must_fix: 0
---

## 概要
- 审查范围: 8 源文件（model-switch 6 文件 + quota-providers 2 文件）
- 审查模式: harness（有 spec/plan）
- 审查维度: BLR / Standards / Taste / Robustness / Integration

## 汇总问题清单
无 MUST_FIX。0 个 blocking 问题。

## 各维度详细

### 1. BLR — 业务逻辑覆盖 ✅

| UC | 覆盖状态 | 验证方式 |
|----|---------|---------|
| UC-1: 非高峰期 coding | ✅ computeQuotaSnapshot → formatContextPrompt, now=off-peak | 集成测试 TC4, TC8 |
| UC-2: 高峰期 ocg 充裕 | ✅ computePeakRecommend → "avoid zhipu" 触发条件 | 集成测试 TC5 |
| UC-3: 高峰期 ocg≥80% | ✅ Advice+Quota 行注入，AI 自行判断 | 注入含 Quota 行 |
| UC-4: 高峰期 urgent | ✅ computePeakRecommend → "avoid" 当 >50% | 集成测试 TC5 |
| UC-5: peekhour 后半段重叠 | ✅ computePeakRecommend → "ok" 不限制 | 集成测试 TC6 |
| UC-6: session 模型表 | ✅ formatSessionModels 注入 [Available Models] | 集成测试 TC1 |
| UC-7: setup delete/list/edit | ✅ handleSetup 3 个 sub-action | 代码检查 |
| UC-8: quota-provider 规范化 | ✅ opencodeGo→opencode-go, kimiCoding→kimi-coding | 代码检查 |

**结论**: 所有业务用例全部覆盖。

### 2. Standards — 编码规范合规 ✅

| 规则 | 状态 | 证据 |
|------|------|------|
| 禁止 `any` | ✅ PASS | `grep -rn "as any\|: any\|<any>"` 无结果 |
| 函数 ≤80 行 | ✅ PASS | 最大函数: 62 行 (computePeakRecommend) |
| import 顺序 | ✅ PASS | 全部: Node builtin → npm → internal |
| 命名规范 | ✅ PASS | factory `modelSwitchExtension`, type `PlanQuota`, `RecommendInfo` |
| lint 0 error | ✅ PASS | `npx eslint packages/model-switch/` → 0 error, 20 warnings（均为项目级 magic-number） |
| tsc 0 error | ✅ PASS | `npx tsc --noEmit` 无输出 |

**注意**: advisor.ts 使用大量 `as Record<string, unknown>` 类型断言。这是与 Pi SDK 交互的必要模式（SDK 返回 `any[]`），属于豁免，不违规。

### 3. Taste — 代码品味 ✅

| 维度 | 状态 | 评估 |
|------|------|------|
| 死代码 | ✅ 无 | 所有 import 和变量均已使用 |
| 硬编码值 | ✅ 合理 | `95`(安全阀)和 `50`(阈值)是业务逻辑定义的常数，已在 `computePeakRecommend` 中命名 |
| 函数复杂度 | ✅ 合理 | `extractSingleQuota` 62 行，职责单一（模式匹配 4 种 cache 格式） |
| 类型安全 | ✅ 可接受 | `as Record<string, unknown>` 是 Pi SDK 对接的必要模式 |
| 错误处理 | ✅ 完整 | catch 块均有 `console.warn`，无静默 catch |

**改进建议（LOW）**:
- `computePeakRecommend` 中的 `95` 安全阀阈值可提取为命名常量 `const ZAI_LIMIT_SAFETY_VALVE = 95;`
- `findPeakPlan` 的 `import("./types").PlanConfig` 建议改为在文件顶部的 `import type`

### 4. Robustness — 健壮性 ✅

| 维度 | 状态 |
|------|------|
| 空值防御 | ✅ 所有 `null`/`undefined` 路径有 fallback |
| 异常传播 | ✅ catch 全部 `console.warn` + `return` |
| 降级路径 | ✅ `config == null` → `before_agent_start` 静默返回 |
| 数据源不可用 | ✅ cache 无数据 → `QuotaSnapshot.plans` 为空对象 |
| 类型断言安全 | ✅ `as Record<string, unknown>` 后都有 `typeof` 守卫 |

**降级路径验证**:
- 无 config 文件 → `loadConfig()` 返回 null → `before_agent_start` 不注入 → `switch_model` tool 降级但不报错
- cache TTL 过期 → `readCache()` 返回旧数据（非 null）
- cache 文件损坏 → `readCache()` 返回 `{ updatedAt: 0 }` → `extractSingleQuota` 返回 null → 无 quota 行

### 5. Integration — 模块边界 ✅

| 边界 | 数据流 | 状态 |
|------|--------|------|
| index.ts→config.ts | `loadConfig()` → `State.config` | ✅ null-safe |
| index.ts→advisor.ts | `computeQuotaSnapshot(cache, config)` | ✅ config.plans keys iterate |
| index.ts→advisor.ts | `computePeakRecommend(now, config, snapshot)` | ✅ 参数类型匹配 |
| index.ts→prompt.ts | `formatContextPrompt(data)` | ✅ RecommendInfo 接口一致 |
| index.ts→prompt.ts | `formatSessionModels(config)` | ✅ ProviderConfig 结构匹配 |
| index.ts→setup.ts | `generatePolicyConfig` → v2 JSON | ✅ PROVIDER_TO_PLAN 映射 |
| advisor.ts→quota-providers | `cache[planName]` = quota-provider `id` | ✅ ID 已规范化 |

**关键验证**: `computeQuotaSnapshot` 遍历 `config.plans` 的 key 来查缓存，与 `config.models[provider].plan` 的值匹配。两个来源（plans key 和 provider plan 字段）的 plan 名必须一致。setup.ts 确保这一点。

## 统计
- MUST_FIX: 0
- LOW: 2（命名常量提取、import type 优化）
- INFO: 0
