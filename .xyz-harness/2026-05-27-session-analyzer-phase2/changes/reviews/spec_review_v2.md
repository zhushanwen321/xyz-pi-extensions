---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-27T11:30:00"
  target: ".xyz-harness/2026-05-27-session-analyzer-phase2/spec.md"
  verdict: pass
  summary: "Spec 评审完成，第2轮。2条 MUST FIX 均修复关闭，新增1条 LOW 设计意见"

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 2
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-4 + FR-3 (reporter API 签名)"
    title: "Sampling 标识无法传递到 reporter"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-2 (generate_actionable_issues)"
    title: "Top-N 问题建议操作生成缺乏可实现的规则定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: LOW
    location: "spec.md:AC-1"
    title: "CLI 错误处理行为未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "spec.md:FR-4 (--sample 参数)"
    title: "--sample 参数超出 session 总数时的行为未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "spec.md:FR-5, FR-6"
    title: "FR-5 和 FR-6 属于运维/部署操作，不宜混在功能需求中"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "spec.md:AC-5"
    title: "性能测试条件未指定测试机器规格"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "spec.md:FR-2 (建议操作自动推导规则优先级)"
    title: "通用规则（Rule 1）优先级高于 edit/bash 专用规则（Rule 2/3），导致高错误率场景下建议操作更模糊"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-27 11:30
- 评审类型：Spec 评审（第 2 轮，MUST FIX 验证）
- 评审对象：`.xyz-harness/2026-05-27-session-analyzer-phase2/spec.md`
- 评审目标：验证第 1 轮发现的 2 条 MUST FIX 是否已修复，检查修复是否引入新问题

---

## 1. MUST FIX #1：Sampling 标识无法传递到 reporter

| 字段 | 内容 |
|------|------|
| 严重程度 | **MUST FIX** |
| 状态 | **已修复 ✅** |
| 修复位置 | FR-2（`mine_patterns` 返回结构）+ FR-3（reporter 读取逻辑） |

### 修复验证

**问题回顾**：第 1 轮指出，reporter 的 `to_markdown(aggregated_result)` 无法区分抽样/全量模式，因为 spec 未定义 `aggregated_result` 的接口结构，也未要求包含 `is_sample` 标记。

**修复内容**：

1. **FR-2 中 `mine_patterns()` 签名和返回结构已明确定义**：

```python
def mine_patterns(..., is_sample: bool = False, sample_size: int | None = None,
                  total_sessions: int = 0) -> dict:
```

返回结构包含 `_meta`：

```python
{
    "_meta": {
        "is_sample": bool,
        "sample_size": int | None,
        "total_sessions": int,
        "analysis_period": {"since": str, "until": str}
    },
    ...
}
```

2. **FR-3 中 reporter 明确定义了采样信息的读取规则**：

```python
def to_markdown(aggregated_result) -> str:
    """输出 Markdown 报告。读取 _meta.is_sample 决定是否标记为抽样报告。"""
```

配套文字说明：
- `is_sample=True` → 标题改为 "Pi Session 抽样分析报告"，注明抽样数量
- `is_sample=False` → 标题为 "Pi Session 分析报告"

3. **FR-1 执行流程第 4 步**明确要求"传入 `is_sample` 和 `sample_size` 元信息"，数据流完整。

### 数据流完整性验证

```
CLI (--sample N)
  → FR-1 step 3: 确定 is_sample / sample_size / total_sessions
  → FR-1 step 4: 调用 miner 时传入 is_sample, sample_size
  → FR-2 mine_patterns(): 将元信息存入 _meta
  → FR-3 to_markdown(): 读取 _meta.is_sample 决定标题
```

**判定：数据流完整，修复充分。**

**替代方案分析**：第 1 轮提出了 3 个方案（A: miner 携带元数据 / B: reporter 增加参数 / C: 定义 AggregatedResult 接口），spec 选择了方案 A 的变体 —— 结构化的 `_meta` 嵌入。这是最合理的方案，因为保持了 reporter 的"只格式化不分析"职责边界。

---

## 2. MUST FIX #2：Top-N 建议操作生成缺乏规则定义

| 字段 | 内容 |
|------|------|
| 严重程度 | **MUST FIX** |
| 状态 | **已修复 ✅** |
| 修复位置 | FR-2（新增"建议操作自动推导规则"表格） |

### 修复验证

**问题回顾**：第 1 轮指出，spec 只给出了输出格式示例，没有定义从统计数据自动推导建议操作的规则，导致不同实现者产出质量悬殊。

**修复内容**：FR-2 新增了完整的规则表格：

| # | 条件 | 建议操作模板 |
|---|------|-------------|
| 1 | 某工具错误率 > 30% | "审查 {tool_name} 工具的使用场景，降低失败率" |
| 2 | edit 匹配失败率 > 20% | "优化 whitespace-fixer skill 的触发条件，减少 edit 重试" |
| 3 | bash 失败率 > 20% | "检查高频失败的 bash 命令模式，考虑创建专用 skill" |
| 4 | 同一 session 内同一目标重复 > 5 次 | "分析 {tool_name} 的重复调用原因，优化一次完成率" |
| 5 | 跨 session 重复指令 >= 3 次 | "在 CLAUDE.md 中增加规则：{user_pattern}" |
| 6 | 某 skill 安装后从未被触发 | "评估 {skill_name} 是否需要保留，或优化其触发描述" |
| 7 | 某 skill 的 SKILL.md > 20KB | "考虑拆分 {skill_name}，减少 token 消耗" |
| 8 | 兜底 | 不生成建议操作字段（设为 null） |

规则设计特征：
- **优先级排序**：明确"按优先级匹配，命中第一条即停止"
- **条件明确**：每条都有可量化的触发条件（`> 30%`、`> 20%`、`>= 3` 等）
- **模板化**：输出模板统一使用 `{variable}` 占位符
- **兜底策略**：fallback 为 null，避免无意义占位

**判定：规则完备，满足 MUST FIX 要求。**

### 优先级逻辑优化建议（新增 LOW 意见 #7）

规则 1（通用工具错误率 > 30%）的优先级高于规则 2（edit 专用）和规则 3（bash 专用）。这意味着：

- **edit 错误率 35%** → 规则 1 先匹配 → 输出通用建议"审查 edit 工具的使用场景"
- **edit 错误率 25%** → 规则 1 不匹配 → 规则 2 匹配 → 输出具体建议"优化 whitespace-fixer skill 的触发条件"

当 edit/bash 错误率 > 30%（高错误率场景）时，本应产出的**最具体建议**被通用规则拦截。建议两种优化方向之一：

- **方向 A**：将 edit/bash 专用规则（规则 2、3）移到规则 1 之前，确保具体规则优先匹配
- **方向 B**：在规则 1 中加入例外条款："某工具错误率 > 30%（排除 edit 和 bash，这两者有专用规则）"

此问题不影响实现（实现者完全按现有规则编码即可正确运行），但影响产出质量。属于设计品味优化，**不阻塞通过**。

---

## 3. 前轮 LOW/INFO 问题追踪

### Issue #3 — CLI 错误处理行为（LOW）✅ 已修复

FR-1 新增了完整的错误处理段落：

| 场景 | 行为 |
|------|------|
| 无效参数格式 | argparse 自动报错，exit code 2 |
| JSONL 目录不存在 | 打印错误到 stderr，exit code 1 |
| JSONL 文件损坏 | 跳过，打印 warning 到 stderr（--verbose 显示详情） |
| 无匹配 session | 打印提示到 stderr，输出空报告（仅元信息），exit code 0 |

覆盖了上一轮指出的所有失败场景。

### Issue #4 — `--sample` 超出总数（LOW）✅ 已修复

FR-1 执行流程 step 3 明确定义：
- `min(N, len(sessions))` 做为实际抽样数
- N > 可用 session 数时打印 warning 到 stderr，降级为全量分析

⚠️ 这里有一处文字歧义："取 `min(N, len(sessions))` 做为实际抽样数，若 N > 可用 session 数则...降级为全量分析"。当 N > 可用数时，`min(N, len)` 返回 `len`（即全部 session），但"降级为全量分析"意味着不再做抽样标记（`is_sample=False`）。实现时应在 N > 可用数时不调用 `min()`，直接做全量分析并传递 `is_sample=False`。建议措辞调整为：

```
若 --sample N 中的 N 大于可用 session 数，则打印 warning 到 stderr 并降级为全量分析；
否则取 N 作为实际抽样数。
```

以免实现者混淆。

### Issue #5 — FR-5/FR-6 属于运维操作（LOW）❌ 未修复

仍以 FR-5 和 FR-6 形式保留在功能需求章节。第 1 轮的判断仍然成立：FR-5（一次性回顾分析）是测试验证步骤，FR-6（cron 配置）是部署操作。建议移至 "Post-Implementation" 或 "Deployment" 章节。不阻塞通过。

### Issue #6 — 性能测试机器规格（INFO）❌ 未修复

仍为 INFO 级别，不阻塞通过。如希望提升 AC-5 的可复现性，可注明测试机器 CPU 核心数和磁盘类型。

---

## 4. 新增问题清单

仅发现 1 个新增 LOW 问题（见 MUST FIX #2 验证部分的"优先级逻辑优化建议"），无新的 MUST FIX。

---

## 5. 整体质量评估

| 要素 | 状态 | 说明 |
|------|------|------|
| MUST FIX 修复 | ✅ 2/2 | 两条 MUST FIX 均已充分修复 |
| LOW 问题修复 | ✅ 2/4 | CLI 错误处理和 --sample 边界已修复；FR-5/FR-6 分类和机器规格未修，但非阻塞 |
| 修复引入新问题 | ✅ 无 MUST FIX | 1 条 LOW 品味建议（规则优先级），不阻塞 |
| 数据流一致性 | ✅ | miner → reporter 的采样信息传递逻辑完整闭合 |
| 规则可实现性 | ✅ | 建议操作规则表可直接转化为 if-elif 实现 |

---

## 结论

**verdict: pass**

第 1 轮发现的 2 条 MUST FIX 已全部修复：

1. **Sampling 标识传递**：通过 `mine_patterns()` 返回结构中的 `_meta.is_sample` 字段，reporter 读取该字段决定标题格式。数据流从 CLI → miner → reporter 完整闭合。

2. **建议操作生成规则**：新增 7 条（+1 条兜底）优先级排序的规则表，每条有可量化的条件和模板化输出，可直接编码实现。

新增问题：1 条 LOW 级别的优先级逻辑优化建议（规则 1 可能遮蔽规则 2/3 的具体建议），不影响实现，建议在下轮迭代中优化。

spec 整体质量从第 1 轮的状态进一步提升，功能需求可测试性强，数据流清晰，约束完备。可进入 Plan 阶段。
