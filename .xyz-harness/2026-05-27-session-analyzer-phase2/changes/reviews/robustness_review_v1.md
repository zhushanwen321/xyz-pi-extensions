---
verdict: pass
must_fix: 0
---

# 健壮性审查报告：pi-session-analyzer

**审查范围**: `miner.py` · `reporter.py` · `analyze.py`
**审查维度**: 错误处理 · 异常安全 · 日志 · Fail-fast · 测试友好 · 调试友好

---

## 1. 总体结论

**verdict: fail** — 代码的纯函数部分（miner 的信号聚合、reporter 的格式化）健壮性尚可，但 pipeline 编排层（analyze.py）缺少任何错误隔离机制，加上 miner.py 中有一处直接 KeyError 风险，以及 reporter.py 入口处缺少 None 防护，必须修复后才能进入生产使用。

---

## 2. 各文件逐项分析

### 2.1 miner.py

#### 优点
- `mine_patterns` 所有参数都是纯字典输入，无副作用，天然可测试。
- `.get()` 加默认值的防御性访问在绝大多数地方使用得当。
- `_is_dormant_by_time` 内对 `fromisoformat` 和 `UUID` 解析做了 try/except 包裹，不会因单条脏数据崩溃。

#### 问题

**M1 (must-fix) — 不一致的字典访问导致 KeyError 风险**
`generate_actionable_issues()` 中对 `duplicate_reads` 的迭代使用 `<dict>.get()` 和直接 `[]` 访问混用：

```python
# line 53-58: 安全访问
if dup.get("count", 0) > 5:
    sessions_val = dup.get("sessions", 1)
    ...
    "文件 {dup.get('file', '?')} 被重复读取 {dup['count']} 次"
```

`dup['count']` 在字符串插值中直接索引。如果 `dup` 字典的 `count` 字段缺失（比如 extractor 侧的 schema 变更或部分 session 缺少该字段），此处会抛出 `KeyError`。既然前面 `dup.get("count", 0)` 已经用了安全方式，字符串插值也应统一为 `dup.get("count", "?")`。

**影响**: 一旦 `count` 缺失，整个 `mine_patterns()` 调用崩溃，下游 reporter 无法产出任何输出。修复成本极低，但能消除一个明确的运行时崩溃点。

**M2 (should-fix) — 无日志，错误静默吸收**
`_is_dormant_by_time` 在 `fromisoformat` / `UUID` 解析失败时 `continue` 静默跳过。虽然行为正确（不因单条脏时间戳崩溃整个函数），但缺少日志意味着：
- 无法知道有多少 session 的时间戳不能被解析
- DORMANT 判定可能因大量时间戳缺失而误判为 recent
- 调试时无法追溯

建议对非预期的异常（非 ValueError）或计数超过阈值时由调用方可选打印。

**M3 (should-fix) — 入口无类型守卫**
`mine_patterns()` 和 `generate_actionable_issues()` 的入参只通过 docstring 和类型标注约定为 dict，但没有任何 `isinstance` / `hasattr` 检查。如果被错误调用（比如 extractor 返回了 None），第一个 `.get()` 调用就会抛出 `AttributeError`。

---

### 2.2 reporter.py

#### 优点
- `_sanitize()` 对 None/NaN 的递归处理正确，覆盖 dict/list/float/None 四种情况。
- `_safe_pct(0, 0)` 返回 "N/A"，不会爆炸。
- `_na()` / `_pct()` / `_fmt_num()` 等格式化函数都有 None 保护。
- 纯函数，无副作用，高度可测试。

#### 问题

**R1 (must-fix) — `to_markdown(None)` 入口无防护**
`to_markdown()` 没有对 `aggregated_result` 参数做任何 None 检查。如果上游 `mine_patterns()` 返回 None（或中间件修改了传来的 dict），第一行 `aggregated_result.get("_meta", {})` 会抛出 `AttributeError`。

```python
def to_markdown(aggregated_result: dict) -> str:
    meta = aggregated_result.get("_meta", {})  # 若 aggregated_result 为 None → AttributeError
```

建议在函数顶部加：
```python
if aggregated_result is None:
    return "# Pi Session 分析报告\n\n_无可用数据_"
```

**R2 (must-fix) — `_na("")` 将空字符串错误归为 N/A**
`_na()` 的实现：
```python
def _na(val) -> str:
    if val is None or val == "" or (isinstance(val, float) and math.isnan(val)):
        return "N/A"
    return str(val)
```

空字符串 `""` 是合法的数据值（例如用户未设置 project 名、error_pattern 为空等），但这里统一替换为 "N/A"，导致数据丢失。筛选条件应为 `val == ""` 只在 `val` 是字符串时检查，且语义上应区分"没有提供"和"提供了空值"。建议：
- 移除 `val == ""`（让空字符串原样显示），或改为 `val == "" and not isinstance(val, bool)` + 更明确的条件。

**R3 (should-fix) — `_fmt_num` 未处理 inf/-inf**
`_fmt_num` 对 `float('inf')` 会输出 "1.7M+" 等荒谬值。虽然 session token 数据不太可能出现 inf，但防御性处理成本低。

---

### 2.3 analyze.py

#### 优点
- `sessions_path.exists()` 检查做在第一步，良好的 fail-fast。
- sample 数量检查 + 降级警告合理。
- `--verbose` 参数 + `_verbose()` 输出到 stderr，不污染 stdout。
- `session_time_map` 用 `hasattr` 做安全检查。
- 文件输出时 `out_path.parent.mkdir(parents=True, exist_ok=True)` 确保了目录存在。

#### 问题

**A1 (must-fix) — 无错误隔离，单一 extractor 失败导致全管道崩溃**
`main()` 中 7 个 extractor 串行调用，没有任何 try/except：

```python
tool_stats = analyze_tool_usage(sessions)
token_stats = analyze_token_usage(sessions)
error_stats = analyze_errors(sessions)
# ...
user_patterns = analyze_user_patterns(users_subset)
# ...
```

如果任一 extractor 抛出异常（如 analyze_user_patterns 在大 session 集上的 OOM、analyze_errors 遇到非预期数据结构），整个 pipeline 中止，用户无法获得任何部分输出。

建议：
- 用 `try/except` 包裹每个 extractor，失败时返回空字典并打印错误（stderr），而非传播异常。
- 部分结果优于无结果。

**A2 (must-fix) — `main()` 是难以测试的巨石**
整个 CLI 入口是一个约 70 行的单函数，包含 arg parse → 输入校验 → 抽样逻辑 → 7 个 extractor 调用 → miner → reporter → 输出。测试时不可能不启动整个 pipeline。

建议：
- 将 extractor 编排逻辑抽取为 `run_pipeline(sessions, args) -> dict` 函数，`main()` 只负责 arg parse + 调用 run_pipeline + 输出。
- `_verbose` 改为可注入的 logger 回调，便于测试时捕获输出断言。

**A3 (should-fix) — `import random` 两次**
函数体内部有 `import random`，同时顶部也有 `import random as _rng`。

```python
# 顶部
import random as _rng   # 导入了
# 函数内部
import random            # 又导一次（在 users_subset 判断块内）
```

虽然 Python 的 import 缓存不会真的重复加载模块，但这暴露了重构不干净（`_rng` 定义在顶部但内层代码仍用 `import random`）。应统一使用 `_rng`。

**A4 (should-fix) — `--until` 默认值精度不一致**
```python
until_str = args.until or datetime.now(timezone.utc).isoformat()[:10]
```
`[:10]` 截断到日期级别（`2026-05-27`），而 `since` 可接受 `7d` / 精确 ISO。报告中的 `analysis_period.until` 只有日期没有时间，与 `since` 可能不对齐。改为 `datetime.now(timezone.utc).isoformat()`（完整精度）更一致。

---

## 3. 六维度评分汇总

| 维度 | 评价 | 说明 |
|------|------|------|
| **错误处理** | ⚠️ 中等 | 纯函数层有良好的 `.get()` 防御，但 pipeline 层无隔离，单个 extractor 失败即全崩 |
| **异常安全** | ✅ 良好 | 无资源泄露风险（无非托管资源）；文件写入失败走默认异常传播 |
| **日志** | ⚠️ 中等 | analyze.py verbose 模式尚可；miner.py 完全静默，异常被吸收但不留痕迹 |
| **Fail-fast** | ⚠️ 中等 | sessions 目录检查和 sample 降级做得好；但 miner/reporter 入口均无类型验证 |
| **测试友好** | ⚠️ 中等 | miner 和 reporter 是纯函数，高度可测；analyze.py main() 是巨石，极难测试 |
| **调试友好** | ⚠️ 中等 | 纯函数层 traceback 清晰；pipeline 层缺少错误上下文关联 |

---

## 4. 修复优先级

| ID | 严重度 | 文件 | 问题 | 修复成本 | 影响 |
|----|--------|------|------|----------|------|
| M1 | **HIGH** | miner.py | `dup['count']` 直接索引 → KeyError | 改 1 行 | 消除运行时崩溃 |
| R1 | **HIGH** | reporter.py | `to_markdown(None)` → AttributeError | 加 3 行 | 消除入口 None 崩溃 |
| A1 | **HIGH** | analyze.py | extractor 无错误隔离 | 加 7 个 try/except | 部分结果替代全崩 |
| R2 | **MEDIUM** | reporter.py | `_na("")` 丢弃空字符串数据 | 删 1 个条件 | 防止有效空值被覆盖 |
| A2 | **MEDIUM** | analyze.py | main() 巨石不可测 | 抽取 run_pipeline() | 提升可测试性 |
| M2 | **LOW** | miner.py | 异常静默无日志 | 加 logger/print | 调试友好性 |
| A3 | **LOW** | analyze.py | 重复 import random | 删内层 import | 代码整洁 |
| A4 | **LOW** | analyze.py | `--until` 精度不一致 | 改 1 行 | 数据一致性 |

**must-fix 项 (4 项)**: M1, R1, A1, R2

**建议全面修复后再进入生产使用 (verdict: fail)**。
