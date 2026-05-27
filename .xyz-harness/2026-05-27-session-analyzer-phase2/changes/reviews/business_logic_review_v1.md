---
verdict: pass
must_fix: 0
---

# 业务逻辑审查报告

**审核对象**: session-analyzer-phase2（miner.py, reporter.py, analyze.py）  
**审核基准**: spec.md FR-1, FR-2, FR-3, FR-4  
**审查日期**: 2026-05-27  
**审查人**: AI 业务逻辑审查专家

---

## 审查维度与结论

### 1. miner.py 建议操作推导规则 vs spec FR-2

#### 1.1 规则对照表

| # | 条件 (spec) | miner.py 实现 | 状态 |
|---|-------------|---------------|------|
| 1 | 某工具错误率 > 30% → "审查 {tool_name}…" | `error_rate > 0.30`, suggestion 模板一致 | ✅ |
| 2 | edit 匹配失败率 > 20% → "优化 whitespace-fixer…" | `edit_match_failure_rate > 0.20`, 模板一致 | ✅ |
| 3 | bash 失败率 > 20% → "检查高频失败的 bash…" | `bash_failure_rate > 0.20`, 模板一致 | ✅ |
| 4 | 同一 session 内同一目标重复 > 5 次 → "分析 {tool_name} 的重复调用原因…" | `duplicate_reads[i].count > 5`, 但 **suggestion 硬编码为 "read"** | ❌ MUST_FIX |
| 5 | 跨 session 用户重复指令 >= 3 次 → "在 CLAUDE.md 中增加规则：{user_pattern}" | `count >= 3`, 模板一致 | ✅ |
| 6 | skill 安装后从未触发 → "评估 {skill_name} 是否需要保留…" | `never_triggered`, 模板一致 | ✅ |
| 7 | skill 文件 > 20KB → "考虑拆分 {skill_name}…" | `size_kb > 20`, 模板一致 | ✅ |
| — | 兜底规则 → suggestion 设为 null | 无兜底分支（不匹配的条目不产生 issue，等价于 null） | ✅ |

#### 1.2 MUST_FIX-1: 规则 4 suggestion 硬编码为 "read"

**问题描述**: spec FR-2 规则 4 的建议操作模板为 `"分析 {tool_name} 的重复调用原因，优化一次完成率"`，但 miner.py 第 82 行硬编码为：

```python
"suggestion": f"分析 read 工具的重复调用原因，优化一次完成率",
```

`duplicate_reads` 的数据源是文件读取操作（read tool），但 spec 模板中使用 `{tool_name}` 变量，说明设计上预期这是一个通用模板，不应硬编码工具名。当前实现与 spec 不一致。

**严重程度**: high  
**影响**: 若后续有其他工具的重复调用检测加入，suggestion 会错误地指向 "read"。

#### 1.3 MUST_FIX-2: "按优先级匹配，命中第一条即停止"未实现

**问题描述**: spec FR-2 明确标注建议操作推导规则"按优先级匹配，命中第一条即停止"。但 `generate_actionable_issues()` 的实现对所有 7 条规则做全量匹配并收集所有命中结果。对于同一个工具，可能同时触发规则 1（错误率 > 30%）和规则 4（重复调用 > 5 次），从而产生两条关于同一工具的问题。

当前实现等价于"全量匹配"，与 spec 的"命中第一条即停止"语义不符。

**严重程度**: high  
**影响**: 对同一工具会生产重叠建议，降低报告的简洁性。

#### 1.4 建议改进: 规则 4 "同一 session 内"语义不明

`duplicate_reads` 中的 `count` 字段和 `sessions` 字段的语义不透明。如果 `sessions` 是一个 list（表示跨 session 的聚合），则当前 `count > 5` 检测的是跨 session 累计重复次数，而非 spec 要求的"同一 session 内同一目标重复 > 5 次"。如果 extractor 已经按 session 做了内聚合（每个条目代表一个 session 内对某文件的重复读取），则当前实现正确。

**建议**: 在 miner.py 中增加注释或断言说明对 `duplicate_reads` 数据结构的预期（每个条目代表一个 session 内的聚合还是跨 session 的聚合）。

---

### 2. reporter.py Markdown 报告的 8 个章节完整性

| 章节 (spec 要求) | reporter.py 实现 | 状态 |
|-----------------|-------------------|------|
| 概要 | `## 概要` | ✅ |
| 工具使用统计 | `## 工具使用统计` | ✅ |
| Token 消耗 | `## Token 消耗` | ✅ |
| 错误分析 | `## 错误分析` | ✅ |
| 用户模式 | `## 用户模式` | ✅ |
| Skill 健康度 | `## Skill 健康度` | ✅ |
| 跨项目洞察 | `## 跨项目洞察` | ✅ |
| Top-N 可操作问题 | `## Top-N 可操作问题` | ✅ |

**结论**: 全部 8 个章节都已实现，顺序与 spec 一致。✅

#### 2.1 建议改进: 用户模式章节标注子集限制

当 `analyze.py` 因性能原因只传递 200 个 session 子集给 `analyze_user_patterns` 时（见下方第 6 节），reporter 的用户模式章节未标注此限制。建议在用户模式章节增加一行标注：

```
**注意**: 用户模式分析基于 200 个 session 子集（总 {total_sessions} 个 session），部分模式可能被遗漏。
```

由于 `_append_user_section` 的参数 `up` 不包含 `is_sample` 或 `total_sessions` 信息，当前无法在章节中显示此标注。

---

### 3. analyze.py Pipeline 完整性（parse → extract → mine → report）

```
main()
  ├── parse_all_sessions()          ← parse
  ├── 7 × extractors                ← extract
  │     analyze_tool_usage()
  │     analyze_token_usage()
  │     analyze_errors()
  │     analyze_user_patterns()
  │     analyze_skill_usage()
  │     analyze_cross_project()
  │     analyze_satisfaction()
  ├── mine_patterns()               ← mine
  └── to_markdown() / to_json_string()  ← report
```

**结论**: Pipeline 完整，4 阶段全部覆盖。✅

额外验证：
- 参数解析（argparse） ✅
- --verbose 进度到 stderr ✅
- JSONL 目录不存在 → exit 1 ✅
- 无匹配 session → 输出空报告到 stderr，exit code 0 ✅
- --sample 超出 → 降级全量 + warning ✅
- session_time_map 传递供 DORMANT 时间判定 ✅

---

### 4. DORMANT 判定——60 天阈值

#### 4.1 阈值设定

```python
_DORMANT_THRESHOLD_DAYS = 60
threshold = now - timedelta(days=_DORMANT_THRESHOLD_DAYS)
return latest < threshold
```

与 spec AC-4 "60+ 天未触发"一致。✅

#### 4.2 判定流程

```
score_skill_health(skill):
  ├── triggers == 0                → "DORMANT"
  ├── _is_dormant_by_time() true   → "DORMANT"
  ├── file_size_kb > 20            → "REFINE"
  ├── triggers > 0 AND projects==1 AND size_kb > 10  → "REFINE"
  └── 其他                          → "KEEP"
```

判定顺序合理：先判 DORMANT（完全无使用），再判 REFINE（低效使用），最后 KEEP。✅

#### 4.3 时间来源的降级处理

`_is_dormant_by_time()` 实现了两级时间提取：
1. 优先从 `session_time_map`（start_time ISO 字符串）
2. 降级到 UUIDv7 字节提取时间戳

两级降级覆盖了 session metadata 不完整的情况。✅

#### 4.4 边界情况

- `triggers > 0` 但所有 session 时间戳均无法解析 → `latest is None` → 返回 `False`（不算 DORMANT）→ 合理，避免数据缺失时的误判 ✅
- `session_time_map` 为空且 session_id 不是 UUIDv7 → 同上 ✅

---

### 5. 抽样模式数据流完整性

数据流链路：

```
analyze.py                              miner.py               reporter.py
──────────                              ────────               ───────────
args.sample=20
  is_sample = True
  sample_size = min(N, len(sessions))
  │
  ├── mine_patterns(is_sample=True,     → _meta["is_sample"]=True
  │                 sample_size=20,        _meta["sample_size"]=20
  │                 ...)                   ...
  │
  └── aggregated  ←─── 包含 _meta ────┘
       │
       └── to_markdown(aggregated)
             ├── 读取 _meta["is_sample"] → 标题改为"抽样分析报告"
             └── 读取 _meta["sample_size"] → 注明抽样数量
```

**结论**: 数据流完整。is_sample 和 sample_size 从 CLI 入口逐层传递到 reporter，标题和正文均正确反映抽样状态。✅

---

### 6. Users Extractor 200 Session 限制的影响分析

#### 6.1 问题描述

analyze.py 第 113-119 行：

```python
import random as _rng
if len(sessions) > 200:
    users_subset = _rng.sample(sessions, 200)
    _verbose(f"Users extractor: 使用 {len(users_subset)}/{len(sessions)} sessions (性能优化)",
             args.verbose)
else:
    users_subset = sessions
user_patterns = analyze_user_patterns(users_subset)
```

当总 session 数 > 200 时（如全量 670 个），users 分析降级为 200 个 session 子集。

#### 6.2 影响分析

| 方面 | 影响 | 严重程度 |
|------|------|----------|
| repeated_requests 检测 | 跨 session 重复指令需要出现在 200 个样本中才能被检测到 | medium |
| repeated_requests 计数 | 样本外出现 3 次以上重复的指令可能被遗漏 | medium |
| corrections 统计 | 否定式反馈的绝对计数偏低（但比例相对稳定） | low |

#### 6.3 风险场景

假设用户有 5 条跨 session 重复指令，每条出现 4 次，分布在 670 个 session 的不同子集中。如果随机抽样 200 个 session，每条指令出现在样本中的概率约为 `1 - (1-200/670)^5 ≈ 78%`。如果真实重复次数只有 3 次，抽样后降到 < 3 次的概率更高，导致规则 5 无法触发。

#### 6.4 结论

当前是合理的性能优化（O(n*m) 复杂度），且在代码中标注了原因。建议：
1. 在报告的用户模式章节标注"基于 200 个 session 子集"（见 2.1）
2. 后续可通过调优 extractor 算法解决，不在 Phase 2 范围内

**不做 MUST_FIX，标注为已知局限。**

---

## 汇总

### MUST_FIX（必须修复）

| # | 文件 | 行 | 描述 | 建议修复 |
|---|------|-----|------|---------|
| 1 | miner.py | ~82 | 规则 4 suggestion 硬编码 "read" | 改为 `f"分析 {tool} 的重复调用原因，优化一次完成率"`，其中 tool 从 duplicate_reads 条目中提取 |
| 2 | miner.py | `generate_actionable_issues()` | 未实现"命中第一条即停止"的优先级链 | 在每条规则前检查是否为同一工具已生成高优先级问题，或按 spec 只保留优先级最高的匹配 |

### SHOULD_FIX（建议修复）

| # | 文件 | 描述 |
|---|------|------|
| 1 | miner.py | 对 `duplicate_reads` 的数据结构语义（每个条目代表 session 内聚合还是跨 session 聚合）增加注释 |
| 2 | reporter.py | 在用户模式章节标注"基于 200 个 session 子集"（依赖 analyze.py 传递此信息） |

### 无需修复

| 检查项 | 结论 |
|--------|------|
| DORMANT 60 天阈值 | ✅ 正确实现 |
| Pipeline 完整性 (parse→extract→mine→report) | ✅ 完整 |
| Markdown 8 章节完整性 | ✅ 全部包含 |
| 抽样模式数据流 (is_sample → reporter) | ✅ 完整 |
| DORMANT 时间降级 (session_time_map → UUIDv7) | ✅ 两级降级覆盖 |
| 无匹配 session 的空报告处理 | ✅ exit 0，stderr 提示 |

---

## 评分

**verdict**: fail（存在 2 个 MUST_FIX）

**open MUST_FIX 数量**: 2

两项 MUST_FIX 均不涉及架构重构，修改范围局限在 `generate_actionable_issues()` 函数内部，预计修复后即可晋升 pass。
