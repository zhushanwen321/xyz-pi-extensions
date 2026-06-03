---
review:
  type: spec_review
  round: 1
  timestamp: "2026-06-03T22:15:00"
  target: ".xyz-harness/2026-06-02-peekhour-model-switch/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，2条 MUST FIX（场景映射内容缺失、FR-7 无 AC），需补充后重审"

statistics:
  total_issues: 5
  must_fix: 2
  low: 3
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > FR-1 > 场景映射"
    title: "场景映射表的具体内容未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-7 vs Acceptance Criteria"
    title: "FR-7 (setup 命令更新) 缺少对应的验收标准"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md > FR-3 > resetTime"
    title: "resetTime 数据格式未说明，实现者需自行查看 cache 结构"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md > FR-4 vs FR-5"
    title: "Z.ai 阈值 (95%) 硬编码在规则模板中，与 opencode-go 可配置阈值设计不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md > FR-1 vs AC-1"
    title: "200 tokens 预算可行性未验证，注入内容项多且含动态数值"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-06-03 22:15
- 评审类型：计划评审（Spec 完整性检查）
- 评审对象：`.xyz-harness/2026-06-02-peekhour-model-switch/spec.md`

## 逐项检查

### 1. Spec 完整性

#### 1.1 目标是否明确 ✅

目标清晰：将推荐引擎（`computeRecommendation`）替换为数据+规则注入模式，让 AI 自主决策而非代码硬编码推荐。一段话能说清楚。

#### 1.2 范围是否合理 ✅

6 个文件改动，中等复杂度，净减代码为主。边界清晰：删什么（推荐引擎三函数）、改什么（注入格式、config 字段）、保留什么（switch_model 5 个 action）。没有过度膨胀。

#### 1.3 验收标准是否可量化 ⚠️（部分问题）

AC-1 到 AC-6 大部分可量化、可测试：

| AC | 可量化 | 说明 |
|----|--------|------|
| AC-1 | ✅ | ≤200 tokens、具体字段列表 |
| AC-2 | ✅ | 数据来源明确映射 |
| AC-3 | ✅ | ≤1 turn 可验证 |
| AC-4 | ✅ | 14:00-17:59 可测试 |
| AC-5 | ✅ | 旧 config 加载可测试 |
| AC-6 | ✅ | 函数删除可 grep 验证 |

**但 FR-7（setup 命令更新）没有对应的 AC。** FR-7 要求 setup 命令生成新字段配置，但没有验收标准定义"生成正确"意味着什么。见 Issue #2。

#### 1.4 待决议项 ✅

无 `[待决议]` 标记。所有设计决策已在 spec 中做出。

### 2. FR 内部一致性

#### FR 覆盖度 vs UC 覆盖度 ✅

6 个业务用例都有对应的 FR 覆盖：

| UC | 覆盖的 FR |
|----|-----------|
| UC-1 非高峰期 coding | FR-1, FR-4 |
| UC-2 高峰期 ocg 充裕 | FR-4 |
| UC-3 高峰期 ocg 快满 | FR-4, FR-5 |
| UC-4 高峰期 urgent | FR-3, FR-4 |
| UC-5 首次启动无 cache | FR-3 |
| UC-6 compaction 后自由切换 | FR-2 |

#### FR ↔ AC 映射 ⚠️

| FR | 对应 AC | 覆盖状态 |
|----|---------|---------|
| FR-1 数据+规则注入 | AC-1 | ✅ |
| FR-2 粘性信息提取 | AC-3 | ✅ |
| FR-3 用量快照构建 | AC-2 | ✅ |
| FR-4 高峰期规则注入 | AC-4 | ✅ |
| FR-5 model-policy.json 扩展 | AC-5 | ✅ |
| FR-6 switch_model 保留 | AC-5, AC-6 | ✅ |
| **FR-7 setup 命令更新** | **无** | **❌ 缺失** |

### 3. Constraints 审查 ✅

约束条件完整，覆盖了 Pi 运行时限制、Session 隔离、TTL、切换延迟、token 预算、向后兼容。"模型切换 1-turn 延迟"的约束在 FR-4 规则文本中有体现（"Switch takes effect next turn"），与约束一致。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md > FR-1 > 场景映射 | FR-1 要求注入"场景映射：各场景（coding/vision/planning/chat）对应的模型优先列表"，AC-1 也要求注入包含"场景映射"。但 **映射表的具体内容未定义**。实现者不知道 coding→glm-5.1 还是 ds-flash，vision 用什么模型，planning 和 chat 的优先列表是什么。这是新增内容（旧 `detectScene` 被删除），不存在于当前代码中，无法通过读现有代码推导。 | 补充场景映射表。例如：`coding: glm-5.1 (non-peak) / ds-flash (peak); vision: mimo-v2.5; planning: glm-5.1; chat: ds-flash`。或者说明映射表从 model-policy.json 中读取（需在 FR-5 中定义对应字段）。 |
| 2 | MUST FIX | spec.md > FR-7 vs AC | FR-7 要求 `/setup-model-policy` 命令生成的配置包含 `peakStrategy`、`rollingWindowHours`、`thresholds` 新字段。但没有对应的 AC 定义验收标准。如果 setup 命令生成了错误格式、遗漏字段、或使用错误的默认值，没有 AC 能捕获。 | 新增 AC-7 覆盖 setup 命令，至少包含：setup 生成的配置包含所有新字段且值合法；setup 交互流程引导用户配置关键选项。 |
| 3 | LOW | spec.md > FR-3 > resetTime | FR-3 要求"Z.ai resetSec 来自解析 cache.zhipu.resetTime"，但 `resetTime` 的数据格式未说明。是 Unix 时间戳？ISO string？还是 duration string？实现者需要查看 `readCache()` 返回的实际数据结构。实现者可以自行查看代码，但建议在 spec 中注明格式（如 "resetTime 为 ISO 8601 时间戳"），降低实现风险。 | 在 FR-3 中补充 `resetTime` 的格式说明（一行即可）。 |
| 4 | LOW | spec.md > FR-4 vs FR-5 | FR-5 为 opencode-go 定义了可配置阈值（`thresholds.rollingLimitPct` 默认 80，`thresholds.weeklyLimitPct` 默认 80）。但 FR-4 非高峰期规则中 Z.ai 的 "≥95%" 是硬编码在规则文本模板中的。两个 provider 的阈值策略不一致：ocg 可配置，zai 不可配置。如果这是有意为之（Z.ai 策略固定），建议在 spec 中说明理由。 | 要么在 FR-5 中为 Z.ai 也增加阈值字段（如 `zaiRollingLimitPct`），要么在 FR-4 中注释 "Z.ai 95% 阈值为设计决策，不暴露为配置项"。 |
| 5 | LOW | spec.md > FR-1 vs AC-1 | AC-1 要求注入文本 ≤ 200 tokens，FR-1 估算 "约 150-200 tokens"。但 FR-1 列出 7 大类注入内容（时间、模型、粘性、Z.ai 用量、ocg 三窗口用量、规则、场景映射），其中 ocg 三窗口含 6 个动态数值。高峰期规则文本也比非高峰期长。建议在 spec 中附一个注入文本的示例（mock 数据），以便验证 token 预算。 | 在 FR-1 或附录中补充一个完整注入文本的示例（含 mock 数据），标注预估 token 数。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 结论

需修改后重审。2 条 MUST FIX 均为 spec 内容缺失（场景映射表、FR-7 AC），不涉及设计推翻，补充即可。

### Summary

Spec 评审完成，第1轮，2条 MUST FIX（场景映射内容缺失、FR-7 无 AC），需补充后重审。
