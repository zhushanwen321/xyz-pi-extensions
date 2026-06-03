---
review:
  type: spec_review
  round: 2
  timestamp: "2026-06-03T23:30:00"
  target: ".xyz-harness/2026-06-02-peekhour-model-switch/spec.md"
  verdict: pass
  summary: "Spec 评审第2轮通过，v1 的 2 条 MUST FIX 和 3 条 LOW 全部已修复，无新 MUST FIX"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 2
  low: 4
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > FR-1 > 场景映射"
    title: "场景映射表的具体内容未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-7 vs Acceptance Criteria"
    title: "FR-7 (setup 命令更新) 缺少对应的验收标准"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: LOW
    location: "spec.md > FR-3 > resetTime"
    title: "resetTime 数据格式未说明，实现者需自行查看 cache 结构"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: LOW
    location: "spec.md > FR-4 vs FR-5"
    title: "Z.ai 阈值 (95%) 硬编码在规则模板中，与 opencode-go 可配置阈值设计不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: LOW
    location: "spec.md > FR-1 vs AC-1"
    title: "200 tokens 预算可行性未验证，注入内容项多且含动态数值"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: LOW
    location: "spec.md > FR-1 vs FR-5"
    title: "scenes 字段的来源（现有 vs 新增）未明确声明"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-06-03 23:30
- 评审类型：计划评审（Spec 完整性检查，增量审查模式）
- 评审对象：`.xyz-harness/2026-06-02-peekhour-model-switch/spec.md`
- 上一轮评审：spec_review_v1.md（2 MUST FIX, 3 LOW）

## v1 Issue 修复验证

### [FIXED] #1 MUST FIX — 场景映射表的具体内容未定义

**v1 问题**：FR-1 要求注入"场景映射"但未定义映射表的具体内容，实现者无法确定 coding→哪个模型。

**v2 修复验证**：FR-1 场景映射段落已重写，现在明确声明：
1. 数据来源：`model-policy.json` 的 `scenes` 字段
2. 结构：`scenes[sceneName]` 数组的别名列表，按配置顺序
3. 输出格式：`coding→glm-5.1/ds-flash | vision→mimo-v2.5/mimo-v2.5-pro | planning→ds-pro/glm-5.1 | chat→ds-flash/glm-5.1`
4. 附录 A 提供了完整的 peak/off-peak 注入文本示例，包含场景映射行

✅ 已修复。

### [FIXED] #2 MUST FIX — FR-7 缺少对应的验收标准

**v1 问题**：FR-7 要求 setup 命令生成新字段配置，但没有 AC 定义"生成正确"的标准。

**v2 修复验证**：新增 AC-7（setup 命令更新），包含 3 条可验证的 checkbox：
1. 生成的配置 JSON 包含 `peakStrategy`、`rollingWindowHours`、`thresholds`
2. 三个字段的默认值明确定义
3. setup 摘要展示新字段及默认值

✅ 已修复。

### [FIXED] #3 LOW — resetTime 数据格式未说明

**v1 问题**：`resetTime` 是时间戳、ISO string 还是 duration string 未明确。

**v2 修复验证**：FR-3 新增"resetTime 格式"段落：
> Z.ai 的 `cache.zhipu.resetTime` 是人类可读的 duration 字符串（如 `"4h39m"`、`"3d20h"`），需解析为秒数。opencode-go 的 `resetInSec` 是整数秒。

✅ 已修复。

### [FIXED] #4 LOW — Z.ai 阈值硬编码策略未说明理由

**v1 问题**：ocg 阈值可配置但 Z.ai 95% 硬编码，设计意图不明。

**v2 修复验证**：FR-4 非高峰期规则后新增设计理由：
> Z.ai 95% 阈值为固定设计决策（窗口几乎满了才让出），不暴露为配置项，原因：Z.ai 是优先使用的套餐，阈值只作为安全阀。

设计决策已记录理由。

✅ 已修复。

### [FIXED] #5 LOW — 200 tokens 预算可行性未验证

**v1 问题**：7 大类注入内容预估 150-200 tokens，但无完整示例验证。

**v2 修复验证**：新增"附录 A: 注入文本示例"，包含：
- 高峰期完整注入文本（约 150 tokens）
- 非高峰期完整注入文本（约 120 tokens）
- 两个示例均包含全部 7 类注入内容 + 动态数值

token 预算可行，高峰期也在 200 以内。

✅ 已修复。

## 增量完整性检查

在 v2 spec 上做新一轮完整性扫描，重点关注修复是否引入新问题。

### FR ↔ AC 覆盖矩阵

| FR | 对应 AC | 覆盖状态 |
|----|---------|---------|
| FR-1 数据+规则注入 | AC-1 | ✅ |
| FR-2 粘性信息提取 | AC-3 | ✅ |
| FR-3 用量快照构建 | AC-2 | ✅ |
| FR-4 高峰期规则注入 | AC-4 | ✅ |
| FR-5 model-policy.json 扩展 | AC-5 | ✅ |
| FR-6 switch_model 保留 | AC-5, AC-6 | ✅ |
| FR-7 setup 命令更新 | AC-7 | ✅ v2 新增 |

覆盖完整，无遗漏。

### UC ↔ FR 覆盖

6 个 UC 均有对应 FR，未因修复引入变化。UC-5（首次启动无 cache）的降级逻辑在 AC-1 "无 model-policy.json 时静默跳过" 中覆盖。

### 约束条件

6 条约束（Pi 运行时、Session 隔离、TTL、1-turn 延迟、Token 预算、向后兼容）均可在 FR/AC 中找到对应实现要求。Token 预算已有附录 A 的具体示例佐证。

### 附录 A 一致性

高峰期和非高峰期示例文本与 FR-1 描述的 7 类注入内容逐项吻合：
- ✅ 当前时间 + 高峰期标记
- ✅ 当前模型 + turn 数 + input tokens
- ✅ 粘性提示
- ✅ Z.ai 用量 + reset + 无周/月限制标注
- ✅ ocg 三窗口用量 + reset
- ✅ 行为规则
- ✅ 场景映射
- ✅ 切换提示

### 新发现

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 6 | LOW | spec.md > FR-1 vs FR-5 | FR-1 声明场景映射从 `model-policy.json` 的 `scenes` 字段读取，但 FR-5（model-policy.json 扩展）只定义了 `peakStrategy`、`rollingWindowHours`、`thresholds` 三个新字段，未提及 `scenes`。如果 `scenes` 是现有字段则无问题；如果是新增字段，则 FR-5 缺少其 schema 定义，FR-7 的 setup 命令和 AC-7 也未覆盖它。spec 未明确声明 `scenes` 是 existing 还是 new。 | 在 FR-5 或 FR-1 中加一句说明："`scenes` 为 model-policy.json 现有字段，结构为 `{ [sceneName]: string[] }`，无需变更"。如果是新增字段，则补充到 FR-5 的字段表中。 |

> 不标为 MUST FIX 的理由：附录 A 提供了完整的场景映射格式和值，FR-1 描述了读取逻辑（`scenes[sceneName]` 数组），实现者有足够信息完成开发。AC-1 的降级模式也覆盖了字段缺失的情况。问题仅在于文档一致性（FR-5 是否应列出该字段），不影响功能正确性。

## 结论

通过。v1 的 2 条 MUST FIX 和 3 条 LOW 全部已修复，修复质量好——不是敷衍补一行，而是补充了完整的内容（附录 A、AC-7、resetTime 格式说明、阈值设计理由）。新增 1 条 LOW（`scenes` 字段来源未声明），不阻塞。

### Summary

Spec 评审第2轮通过，v1 的 2 条 MUST FIX 和 3 条 LOW 全部已修复，0 条新 MUST FIX，1 条新 LOW。
