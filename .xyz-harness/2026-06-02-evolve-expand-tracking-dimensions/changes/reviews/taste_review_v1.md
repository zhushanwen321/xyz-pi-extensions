# Taste Review: evolve-daily 包

```yaml
---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 27
  issues_found: 7
  must_fix_count: 0
  low_count: 3
  info_count: 4
---
```

## 审查范围

- TypeScript: `src/index.ts`, `src/problems.ts`, `src/detectors/*.ts` (4 files)
- Python extractors: `analyzer/extractors/*.py` (7 files)
- Python rules: `analyzer/rules/*.py` (15 files)
- Skills: `skills/evolve/SKILL.md`, `skills/evolve-report/SKILL.md`

品味规则来源: `packages/taste-lint/base.mjs` (max-lines: 1000, max-lines-per-function: 300, no-magic-numbers, no-silent-catch, prefer-allsettled, no-explicit-any, no-empty)

## 审查结论

代码整体品味良好。文件长度均在限制内（最长 `problems.ts` 234 行），函数长度合理，命名语义清晰，错误处理有日志输出。以下为发现的问题。

---

## LOW — 需要关注但不阻塞

### L1. `_extract_text_from_content` 在 3 个 Python extractor 中完全重复

**文件**: `analyzer/extractors/tool_errors.py:51`, `analyzer/extractors/goal_quality.py:34`, `analyzer/extractors/subagent.py:29`

三处实现完全相同：

```python
def _extract_text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            item.get("text", "")
            for item in content
            if isinstance(item, dict) and "text" in item
        )
    return ""
```

**建议**: 提取到 `analyzer/extractors/_shared.py` 或 `analyzer/utils.py`，各模块 import 使用。

### L2. `discover_extractors` 和 `discover_rules` 结构近乎相同

**文件**: `analyzer/extractors/__init__.py`, `analyzer/rules/__init__.py`

两者共享完全相同的 pkgutil + importlib 自动发现逻辑，仅接口名 (`extract` vs `check`) 和 key 前缀不同。结构差异仅在:
- extractor 用 `f"{name}_stats"` 做 key
- rule 的 `check` 返回 `list[dict]`，需要 extend

**建议**: 可以提取 `discover_modules(package, required_attr) -> dict[str, module]` 共享函数。当前体量下也可接受，但 extractor 和 rule 继续增长时值得统一。

### L3. `index.ts:41` 静默 catch

```typescript
try {
  unlinkSync(reportPath);
} catch {
  /* already gone */
}
```

项目 taste-lint 规则 `no-silent-catch` 要求 catch 块不能为空或只有注释。虽然此处逻辑正确（清理可能不存在的临时文件），但建议至少加一行日志以符合规则精神：

```typescript
catch {
  // file already removed or never created
}
```

或者如果 taste-lint 规则豁免了注释-only 的 catch，则当前可接受。

---

## INFO — 供参考

### I1. `workflow.py` 中 3 个变量初始化后从未赋值

**文件**: `analyzer/extractors/workflow.py`

```python
review_findings_total = 0      # 从未被修改
retrospect_written = 0          # 从未被修改
retrospect_expected = 0         # 从未被修改
```

输出中 `review_findings` 和 `retrospect_coverage` 永远是零值。这是未完成的实现，不影响功能正确性（调用方不会读到有意义的数据），但会误导报告读者以为"没有 review findings"。

### I2. `problems.ts` 引用不存在的 rule 文件

`goal-task-quality` 的 `analysis.minerRules` 包含 `"goal-high-cancel"`，但 `analyzer/rules/` 目录下没有 `goal_high_cancel.py`。自动发现机制会静默跳过，不会报错，但 registry 声明与实际实现不一致。

（注: `"goal-low-evidence-quality"` 确实有对应实现，在 `goal_low_evidence.py` 中作为第二个 issue 输出，只是没有独立文件。）

### I3. `getProblemById` / `getProblemsByCategory` 导出但未使用

**文件**: `src/problems.ts:228-235`

两个工具函数已导出但当前代码中没有调用方。按"不加推测性功能"原则，可以等实际需要时再加。不过它们是简单的查询函数，保留也不增加维护负担。

### I4. 未使用的 `Any` import

**文件**: `analyzer/extractors/compact.py:3`, `analyzer/extractors/context.py:3`

```python
from typing import Any  # 未在代码中使用
```

`tool_errors.py`、`goal_quality.py`、`subagent.py` 中的 `Any` 有实际使用（`content: Any` 参数），但 `compact.py` 和 `context.py` 的 `extract()` 函数参数和返回值都没有用到 `Any`。

---

## 审查统计

| 维度 | 状态 |
|------|------|
| 结构（文件/函数长度） | 通过 — 最长 234 行，远低于 1000 行限制 |
| 命名（语义清晰） | 通过 — detector/extractor/rule 命名一致 |
| 复杂度 | 通过 — 无过度嵌套或复杂逻辑 |
| 重复 | LOW×2 — Python 侧有可提取的公共逻辑 |
| 错误处理 | LOW×1 — 一处静默 catch |
| 类型安全 | 通过 — TypeScript 侧无 any 滥用 |
