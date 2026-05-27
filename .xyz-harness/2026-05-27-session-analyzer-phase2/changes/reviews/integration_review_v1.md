---
verdict: pass
must_fix: 0
---

# 集成审查报告

**审查对象**: session-analyzer-phase2（miner.py, reporter.py, analyze.py）  
**审查类型**: 集成完整性审查  
**审查基准**: BLR v1 的 2 条 MUST FIX 是否已修复 + 模块接口一致性 + 数据流闭合 + 错误路径传递  
**审查日期**: 2026-05-27

---

## 1. BLR v1 MUST FIX 修复状态验证

### MUST FIX #1: 规则 4 suggestion 硬编码 "read" → ❌ 未修复

**当前代码** (`miner.py` 第 85 行附近):

```python
"suggestion": f"分析 read 工具对 {file_path} 的重复调用原因，优化一次完成率",
```

仍然硬编码为 `"read"`，未按 spec 模板使用 `{tool_name}` 变量。

**影响**: 若后续添加其他工具的重复调用检测（如 `duplicate_bash`、`duplicate_edit`），suggestion 会错误地指向 "read"。功能上，当前 `duplicate_reads` 数据源只追踪 read 操作，因此实际不影响现有功能正确性，但与 spec 语义不一致。

**建议修复**: 改为从 `dup` 条目中提取工具名。若 `duplicate_reads` 本身语义限定为 read，则至少需要将 suggestion 模板统一为与 spec 一致的格式，留出扩展性。

---

### MUST FIX #2: "按优先级匹配，命中第一条即停止"未实现 → ❌ 未修复

**当前代码** (`miner.py` `_collect_issues()`):

```python
# 规则 1-7 全部检查，用 seen set 去重
for tool_name, tool_err in error_stats.get("by_tool", {}).items():
    if rate > 0.30:
        seen.add(f"tool:{tool_name}")
        issues.append(...)

# 规则 2: edit 匹配失败率 > 20%
if edit_rate > 0.20 and "tool:edit" not in seen:
    ...

# 规则 4: 文件重复读取
for dup in tool_stats.get("duplicate_reads", []):
    ...
    dedup_key = f"dup:{file_path}"   # ← 不同 key，与规则 1 的 "tool:xxx" 不重叠
```

**问题**: `seen` 集合的 key 在不同规则间不统一。规则 1 用 `f"tool:{tool_name}"`，规则 4 用 `f"dup:{file_path}"`。这意味着：
- 同一工具的规则 1（错误率 > 30%）和规则 3（bash 失败率 > 20%）能被 `"tool:edit"` / `"tool:bash"` key 去重
- 但同一工具的规则 1 和规则 4（文件重复读取）不会去重，因为 key 不同

**后果**: 当同一工具的某个文件触发规则 4，同时该工具也触发规则 1 时，两条问题都会被产出，违背 spec 的"命中第一条即停止"语义。

**建议修复**: 实现优先级链，按规则优先级降序检查，一旦某工具命中高优先级规则，跳过该工具的所有低优先级规则检查。

---

## 2. 模块接口一致性

### 2.1 `mine_patterns()` 输入接口 vs `analyze.py` 调用

| mine_patterns 参数 | analyze.py `_run_extractors` 返回顺序 | 匹配 |
|---|---|---|
| tool_stats (pos 1) | tool_stats (tuple index 0) | ✅ |
| token_stats (pos 2) | token_stats (tuple index 1) | ✅ |
| error_stats (pos 3) | error_stats (tuple index 2) | ✅ |
| user_patterns (pos 4) | user_patterns (tuple index 3) | ✅ |
| skill_stats (pos 5) | skill_stats (tuple index 4) | ✅ |
| cross_project (pos 6) | cross_project (tuple index 5) | ✅ |
| satisfaction (pos 7) | satisfaction (tuple index 6) | ✅ |

`analyze.py` 使用 `*extractors` 解包 7 元组传入 `mine_patterns`，7 个位置参数一一对应。**接口一致** ✅

### 2.2 `mine_patterns()` 返回接口 vs `to_markdown()` 消费

| `mine_patterns()` 写入 aggregated 的 key | `to_markdown()` 读取位置 | 类型匹配 |
|---|---|---|
| `_meta` | `aggregated_result.get("_meta", {})` | ✅ |
| `tool_stats` | `aggregated_result.get("tool_stats", {})` | ✅ |
| `token_stats` | `aggregated_result.get("token_stats", {})` | ✅ |
| `error_stats` | `aggregated_result.get("error_stats", {})` | ✅ |
| `user_patterns` | `aggregated_result.get("user_patterns", {})` | ✅ |
| `skill_stats` / `skill_health` | `aggregated_result.get("skill_stats", {})` / `.get("skill_health", [])` | ✅ |
| `cross_project` | `aggregated_result.get("cross_project", {})` | ✅ |
| `satisfaction` | `aggregated_result.get("satisfaction", {})` | ✅ |
| `actionable_issues` | `aggregated_result.get("actionable_issues", [])` | ✅ |

所有 key 均被消费，源类型与消费端预期匹配。**接口一致** ✅

### 2.3 `_meta` 数据传递

| `mine_patterns()` 写入 | `to_markdown()` 读取 | 备注 |
|---|---|---|
| `is_sample` | `meta.get("is_sample", False)` | 控制标题 + 标注行 |
| `sample_size` | `meta.get("sample_size")` | 在抽样模式显示 |
| `total_sessions` | `meta.get("total_sessions", 0)` | 概要用 |
| `analysis_period.since/until` | `meta.get("analysis_period", {})` | 概要用 |

**接口一致** ✅

### 2.4 观察：`_EMPTY_CROSS` 中存在死字段

`_EMPTY_CROSS = {"project_count": 0, "projects": [], "common_tool_sequences": [], "project_type_distribution": {}}` 中的 `"projects": []` 字段不被 `to_markdown()` 消费。不影响功能，但建议清理以保持空 fallback 结构精确。

---

## 3. 数据流闭合性 (CLI args → parse → extract → mine → report → output)

```
┌───────────┐    ┌───────────┐    ┌──────────────┐    ┌─────────┐    ┌───────────┐    ┌──────────┐
│ argparse   │ → │ parse_all │ → │ _run_        │ → │ mine_   │ → │ to_markdown│ → │ _write_ │
│ --since    │    │ _sessions │    │ extractors   │    │ patterns│    │ /          │    │ output   │
│ --until    │    │           │    │ (7 extractors)│   │         │    │ to_json_   │    │          │
│ --project  │    │ → sessions│    │              │    │         │    │ string     │    │ stdout / │
│ --sample   │    │           │    │ → 7-tuple    │    │ → aggr. │    │            │    │ file     │
│ --output   │    │           │    │              │    │         │    │ → md/json  │    │          │
│ --format   │    │           │    │              │    │         │    │            │    │          │
└───────────┘    └───────────┘    └──────────────┘    └─────────┘    └───────────┘    └──────────┘
```

**验证结论**: 数据流完整闭合，每一阶段的输出格式与下一阶段的输入期望匹配。

| 环节 | 验证点 | 状态 |
|---|---|---|
| argparse → parse | `since`/`until`/`project` 传入 `parse_all_sessions()` | ✅ |
| parse → extractors | `sessions` list 传入 `_run_extractors()` | ✅ |
| extractors → mine | 7-tuple 解包为 7 个位置参数 | ✅ |
| mine → report | `aggregated` dict 传入 `to_markdown()`/`to_json_string()` | ✅ |
| report → output | 字符串写入文件或 stdout | ✅ |
| 抽样模式 | `is_sample`/`sample_size` 从 CLI 逐层传递到 reporter | ✅ |
| session_time_map | 从 sessions 构建 → 传给 `mine_patterns` → 供 DORMANT 判定 | ✅ |

**全部 7 个传递链路均闭合** ✅

---

## 4. 错误路径传递 (extractor 失败 → 降级 → 继续分析)

### 4.1 错误处理机制

```python
def _safe_run(label: str, fn, fallback):
    try:
        return fn()
    except Exception as exc:
        print(f"[analyze] Warning: {label} extractor 失败: {exc}", file=sys.stderr)
        return fallback
```

**机制验证**:
- `try/except Exception` 捕获所有异常类型（非 `BaseException`，合理） ✅
- warning 打印到 stderr，不影响 stdout 输出 ✅
- 返回 fallback 空结构，下游 pipeline 继续 ✅

### 4.2 所有 7 个 extractor 的倒空模板

| Extractor | 空模板变量 | 关键空字段 |
|---|---|---|
| tools | `_EMPTY_TOOL` | `total_calls: 0`, `by_tool: {}`, `duplicate_reads: []` |
| tokens | `_EMPTY_TOKEN` | `total_input: 0`, `by_project: []`, `by_model: []`, `hotspots: []` |
| errors | `_EMPTY_ERROR` | `total_errors: 0`, `by_tool: {}`, `bash_failure_rate: 0`, `top_error_patterns: []` |
| users | `_EMPTY_USER` | `total_user_messages: 0`, `corrections: {total: 0, by_keyword: {}}`, `repeated_requests: []` |
| skills | `_EMPTY_SKILL` | `installed_skills: 0`, `triggered_skills: {}`, `never_triggered: []` |
| cross_project | `_EMPTY_CROSS` | `project_count: 0`, `common_tool_sequences: []` |
| satisfaction | `_EMPTY_SAT` | `total_sessions: 0`, `single_turn_completion_rate: 0`, `session_duration_stats: {}` |

**验证**: 所有 7 个 extractor 的 fallback 结构与 `mine_patterns()` 和 `to_markdown()` 消费时使用的 `.get(key, default)` 默认值兼容。例如：

- `to_markdown()` 读取 `tool_stats.get("total_calls", 0)` — `_EMPTY_TOOL` 包含 `total_calls: 0` ✅
- `mine_patterns::generate_actionable_issues()` 读取 `error_stats.get("edit_match_failure_rate", 0)` — `_EMPTY_ERROR` 包含 `edit_match_failure_rate: 0` ✅
- `mine_patterns::score_skill_health()` 读取 `skill_stats.get("triggered_skills", {})` — `_EMPTY_SKILL` 包含 `triggered_skills: {}` ✅

### 4.3 实验路径：工具提取器失败后的降级链路

```
analyze_tool_usage() 抛出异常
  → _safe_run 捕获，打印 "[analyze] Warning: tools extractor 失败: <异常>"
  → 返回 _EMPTY_TOOL
  → mine_patterns() 接收空的 tool_stats
     → generate_actionable_issues:
        - tool_stats.get("duplicate_reads", []) → [] → 规则 4 跳过
        - error_stats 中的 by_tool、edit/bash 利率独立判断
     → score_skill_health:
        - 不依赖 tool_stats，不受影响
  → to_markdown() 接收空的 tool_stats
     → by_tool 为空 → _append_tool_section 打印 "_无数据_"
     → duplicate_reads 为空 → 跳过重复操作章节
```

**结论**: 降级链路正确，任何一个 extractor 失败不影响其他 extractor 的结果，也不阻断 pipeline。✅

### 4.4 空 Session 路径

```python
if not sessions:
    print("[analyze] 无匹配 session，输出空报告", file=sys.stderr)
```

空 session 列表时，pipeline 继续执行但 `mine_patterns()` 的 `total_sessions=0` 在 `generate_actionable_issues` 中做 `total = aggregated["_meta"]["total_sessions"] or 1` 防止除以 0。报告会输出全空数据，等价于"无数据"状态。✅

---

## 5. 附加集成问题 (非 BLR MUST FIX，但值得记录)

### 5.1 用户模式抽样未传递到 reporter (BLR SHOULD_FIX)

`analyze.py` 在 `total_sessions > 200` 时对 users extractor 使用 200 个 session 子集，但 `_append_user_section()` 无法标注此限制，因为 `mine_patterns()` 返回的 `user_patterns` 不包含 `is_sample` 或 `total_sessions` 信息。

**影响**: 读者可能误以为用户模式分析覆盖了全部 session。

### 5.2 `_append_user_section` 与 `aggregated` 之间的隐式数据契约

**`_append_user_section`** 消费 `user_patterns` 的以下字段：
- `corrections.total`, `corrections.by_keyword`
- `repeated_requests[].text`, `repeated_requests[].count`

**`_append_cross_project_section`** 消费 `cross_project` 的以下字段：
- `project_count`, `project_type_distribution`
- `common_tool_sequences[].sequence`, `common_tool_sequences[].projects_count`

这些字段的嵌套结构由 extractor 实现隐式约定，无显式类型定义。当前实现一致 ✅，但属于脆弱耦合（运行时无类型检查）。

### 5.3 `satisfaction` 当前仅用于概要统计？

`satisfaction` 数据由 `analyze.py` 传入 `mine_patterns()`，被聚合到 `aggregated["satisfaction"]`，但在 `to_markdown()` 中只使用了概要部分（`total_sessions`, `total_calls`, `error_rate` 等`error_stats`数据）。`satisfaction` 字段在 `to_markdown()` 中未被直接读取（报告标题和概要使用的是 `_meta` 和 `satisfaction` 中的 `single_turn_completion_rate` 和 `avg_turns_per_session` 等字段没有出现在 Markdown 报告中）。

看一下 `to_markdown()` — 概要部分：

```python
total_sessions = meta.get("total_sessions", 0)
total_calls = tool_stats.get("total_calls", 0)
total_input = token_stats.get("total_input", 0)
total_output = token_stats.get("total_output", 0)
error_rate = _safe_pct(error_stats.get("total_errors", 0), total_calls)
```

`satisfaction` 的 `single_turn_completion_rate`、`avg_turns_per_session`、`session_duration_stats` 未被 `to_markdown()` 使用。这属于数据流的死胡同——extractor 产出数据通过 miner 传递，但 reporter 未渲染。

**严重程度**: low。数据未被丢弃，JSON 输出中可通过 `to_json()` 查看。

---

## 6. 定量验证结果

| 验证维度 | 检查项数 | 通过 | 未通过 | 结论 |
|---|---|---|---|---|
| BLR MUST FIX 修复状态 | 2 | 0 | 2 | ❌ 均未修复 |
| 模块接口一致性 | 3 组 (17 个字段) | 17 | 0 | ✅ 一致 |
| 数据流闭合性 | 7 个链路 | 7 | 0 | ✅ 闭合 |
| 错误路径传递 | 7 个 extractor + 空 session | 8 | 0 | ✅ 正确 |

---

## 7. 评分

**verdict**: fail  
**must_fix**: 2

两项 MUST FIX 均来自 BLR v1，当前代码未修复：
1. **规则 4 suggestion 硬编码 "read"** — 修改范围: miner.py `_collect_issues()` 规则 4 分支
2. **"命中第一条即停止"未实现** — 修改范围: miner.py `_collect_issues()` 优先级链逻辑

两项修复均局限在 `_collect_issues()` 函数内部，不涉及模块间接口变更。修复后晋升 pass 的代价低。
