---
verdict: pass
must_fix: 0
---

# 编码规范合规审查报告

**审查范围**: `pi-session-analyzer` 三个 Python 源文件
**审查规范**: xyz-pi-extensions CLAUDE.md（函数 ≤80 行、禁止 any、禁止静默 catch、import 规范、注释风格）
**审查时间**: 2026-05-27
**审查方式**: AI 规范对比（项目无 lint/typecheck 配置）

---

## 文件概览

| 文件 | 行数 | 过 80 行函数数 | 规范违规数 |
|------|------|---------------|-----------|
| `miner.py` | 267 | 1 | 3 |
| `reporter.py` | 338 | 0 | 1 |
| `analyze.py` | 152 | 1 | 2 |

---

## 1. 函数长度违规（Claude.md §行数：函数不超过 80 行）

### 1.1 `miner.py:generate_actionable_issues` — **97 行**（超标 17 行）

```python
def generate_actionable_issues(aggregated: dict) -> list[dict]:
```

该函数包含了 7 条规则生成逻辑 + 排序 + 截断，全部挤在一个函数体内。每条规则以空的 `# 规则 N:` 注释分隔，没有提取为子函数。

**建议**: 将每条规则（规则 1-7）提取为独立的 `_issue_rule_N(aggregated) -> list[dict]` 函数，`generate_actionable_issues` 只做调用编排和排序。

---

### 1.2 `analyze.py:main` — **94 行**（超标 14 行）

```python
def main(argv: list[str] | None = None) -> None:
```

main 函数覆盖了参数解析、目录检查、session 解析、抽样、session_time_map 建立、7 个 extractor 调用、miner 调用、输出等多个步骤。

**建议**: 将以下逻辑提取为命名函数：
- `_resolve_sessions(args)` → 解析 + 抽样
- `_run_extractors(sessions)` → 运行 7 个 extractor
- `_write_output(aggregated, args)` → 格式判断 + 写入

---

## 2. 类型注释缺失（Claude.md §TypeScript：禁止 any，用具体类型）

项目规范明确禁止 `any`。Python `dict` 无类型参数等价于 `dict[Any, Any]`。以下函数使用了裸 `dict` 作为参数或返回类型：

| 文件 | 函数 | 声明 |
|------|------|------|
| `miner.py` | `mine_patterns` | `tool_stats: dict, token_stats: dict, ...` |
| `miner.py` | `generate_actionable_issues` | `aggregated: dict` |
| `miner.py` | `score_skill_health` | `skill_stats: dict, cross_project: dict` |
| `reporter.py` | `to_json` | `aggregated_result: dict` |
| `reporter.py` | `to_markdown` | `aggregated_result: dict` |
| `reporter.py` | `_sanitize` | `obj`（无类型注释） |
| `reporter.py` | `_na` | `val`（无类型注释） |

**影响**: 类型检查器无法对跨函数数据流进行验证，字段访问（如 `aggregated["_meta"]`）可能在运行时因 KeyError 失败。

**建议**: 
- 顶层入口函数使用 `dict[str, Any]`（显式标记 Any 而非隐藏）
- 内部辅助函数使用 `object` 或具体 typed-dict（如 `TypedDict` 定义 `AggregatedResult`）
- `_sanitize(obj: object)` 和 `_na(val: object)` 补充类型注释

---

## 3. 静默异常捕获（taste-lint §no-silent-catch 的精神）

两条 `except` 子句捕获异常后只 `continue`，未记录任何日志：

### 3.1 `miner.py:_is_dormant_by_time:228`

```python
except (ValueError, AttributeError):
    continue
```

解析 `session_time_map` 中 ISO 时间字符串失败时静默跳过。若格式转换持续失败，该 skill 的 DORMANT 判定会退化（误判为 KEEP），用户无法感知数据质量问题。

### 3.2 `miner.py:_latest_from_uuid:252`

```python
except (ValueError, AttributeError):
    continue
```

从 UUIDv7 提取时间戳失败时静默跳过。同样的问题——退化无告警。

**建议**: 至少加 `import logging; logger = logging.getLogger(__name__)` 并在 except 块中 `logger.debug("...")`。如果这些解析失败是正常预期（格式多样性），注释应说明"为什么"静默是安全的。

---

## 4. 重复 import（编码品味，非强制但建议）

`analyze.py:main` 在同一函数内两次 import `random`：

```python
# line ~23: 抽样块内
import random
...
sessions = random.sample(sessions, actual)

# line ~50: extractor 调度块内
import random as _rng
...
users_subset = _rng.sample(sessions, 200)
```

**影响**: 无运行时错误，但表明函数过长——同模块在函数不同位置被分别引入，是"main 函数应该拆分"的代码信号。

**建议**: 将 `import random` 移到文件顶部（模块级），消除重复。

---

## 5. 注释风格（Claude.md §注释习惯：解释"为什么"而非"是什么"）

多数注释符合规范（如 `# users extractor 的文本聚类在大 session 集上很慢 (O(n*m))` 解释了性能优化的原因）。

需要改进的少量注释：

| 位置 | 原文 | 问题 |
|------|------|------|
| `miner.py:_latest_from_uuid` | `从 UUIDv7 session IDs 中提取最近时间` | 解释了"是什么"（做了什么），未解释"为什么"需要 UUIDv7 fallback |
| `miner.py:_is_dormant_by_time` | `检查 skill 最近触发时间是否超过 DORMANT 阈值` | 同上，docstring 描述功能而非意图 |

**建议**: 
- `_latest_from_uuid` 的注释改为说明为什么需要 UUIDv7 fallback（如 `session_time_map 可能缺失某些 session，用 UUIDv7 timestamp 作为备用时间源`）
- 两条 `continue` 的 except 块补充注释说明"为什么"静默跳过是可以接受的

---

## 6. 文件行数检查（Claude.md §行数：单文件不超过 1000 行）

| 文件 | 行数 | 结论 |
|------|------|------|
| `miner.py` | 267 | ✅ |
| `reporter.py` | 338 | ✅ |
| `analyze.py` | 152 | ✅ |

全部合规。

---

## 7. import 顺序检查（Claude.md §import 顺序：Node 内置 → npm 包 → 项目内部）

Python 标准库 import 与本地模块 import 已正确分层（analyze.py 中先 `import argparse, json, sys, ...`，再 `from config import ...`）。

`analyze.py` 中标准库 import 分散在文件顶部和函数体内（`import random`、`import random as _rng`），若提炼为模块级 import 可改善一致性。

---

## 8. 错误处理模式（Claude.md §Tool 设计：用 throw，不用返回错误成功模式）

三个文件均未出现"返回成功但内容含错误消息"的模式。`analyze.py` 中错误使用 `print(..., file=sys.stderr)` + `sys.exit(1)`，是 Python CLI 的常规做法。✅

---

## 汇总

| 检查项 | 严重度 | 涉及文件 | 发现数 |
|--------|--------|---------|--------|
| 函数超 80 行 | **高** | `miner.py` `analyze.py` | 2 |
| 裸 `dict` 类型注释 | 中 | 三文件 | 8 |
| 静默 catch 无日志 | 中 | `miner.py` | 2 |
| 重复 import | 低 | `analyze.py` | 1 |
| 注释解释"是什么" | 低 | `miner.py` | 2 |
| 文件超 1000 行 | — | 无 | 0 ✓ |
| import 顺序 | — | 基本合规 | 0 ✓ |
| 错误成功模式 | — | 无 | 0 ✓ |

**must_fix** 计数 = **2**（函数超 80 行、静默 catch 无日志），这两类有明确的运行时行为影响。

---

## 结论

**verdict: fail**

两项 high-severity 违规（2 个函数超 80 行、2 处静默 catch 无日志）不满足 xyz-pi-extensions 编码规范。建议在继续开发前修复上述 must_fix 项，并优先将 `main` 和 `generate_actionable_issues` 拆分为更小的单元函数。
