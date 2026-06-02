# Robustness Review — evolve-daily 包

```yaml
---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 32
  issues_found: 15
  must_fix_count: 0
  low_count: 9
  info_count: 6
---
```

## 审查范围

| 层 | 文件数 | 说明 |
|----|--------|------|
| TypeScript 入口 + problems | 2 | `src/index.ts`, `src/problems.ts` |
| TypeScript detectors | 4 | compact, goal-quality, param-error, subagent-result |
| Python extractors | 7 | `__init__` + compact, context, goal_quality, subagent, tool_errors, workflow |
| Python rules | 15 | `__init__` + 14 规则文件 |
| SKILL.md | 2 | evolve, evolve-report |

---

## 六维度评审

### 1. 错误处理

**做得好的：**
- `index.ts` session_start：analyzer 失败时 catch + 清理 partial file（`unlinkSync`）
- `index.ts` tool_execution_end：每个 detector 独立 try/catch，一个挂掉不影响其余
- Python extractors `__init__.py`：`run_extractors()` 对每个 extractor 独立 try/except，失败返回 `{}`
- Python rules `__init__.py`：`run_rules()` 对每个 rule 独立 try/except，失败跳过
- Python `_parse_iso_timestamp`：parse 失败返回 None 而非抛异常

**问题：**

| ID | 严重度 | 文件 | 描述 |
|----|--------|------|------|
| LOW-01 | LOW | `src/index.ts:62-77` | 4 处 `PROBLEM_REGISTRY.find(...)!` 使用 non-null assertion。若 registry 中缺少对应 id，运行时在第一次事件时抛出无上下文的 TypeError。应在 extension init 时做前置校验。 |
| LOW-02 | LOW | `src/index.ts` | `tool_execution_end` handler 对所有 detector 无差别运行，但 `DetectorInstance.events` 声明了关注的事件类型却从未被检查。当前功能正确（因为 match 内部会判断 type），但 `events` 字段成了死代码，可能误导维护者。 |
| INFO-01 | INFO | Python extractors | `run_extractors()` 失败时返回空 dict `{}`，无结构化错误信息写入 report。warning 仅 print 到 stdout，下游无法区分"没有数据"和"extractor 崩溃"。 |

### 2. 异常管理

**做得好的：**
- TS 侧统一前缀 `[evolve-daily]`，Python 侧统一前缀 `[evolve]`
- 错误日志包含上下文：`detector ${detector.problemId} error:`, `Failed to load extractor {modname}:`
- `classifyError` / `classifyTaskType` 对未匹配输入返回明确的 fallback 值（`"unclassified"` / `"unknown"`）

**问题：**

| ID | 严重度 | 文件 | 描述 |
|----|--------|------|------|
| LOW-03 | LOW | `src/index.ts:47-49` | `unlinkSync` 的 catch 块完全静默。对于 `ENOENT`（文件已删）可以忽略，但 `EACCES` 等权限错误也静默吞掉，可能掩盖问题。建议至少在非 ENOENT 错误时 log。 |
| INFO-02 | INFO | Python extractors | `extract()` 函数内部无 try/except。单条消息格式异常会导致整个 extractor 对该 session 失败。外层 `run_extractors` 会捕获，但丢失了部分结果。 |

### 3. 日志

**做得好的：**
- 关键失败路径都有日志（analyzer 失败、detector 异常、extractor/rule 加载失败）
- Python 模块级 docstring 完整
- `extract()` 和 `check()` 函数都有详细 docstring

**问题：**

| ID | 严重度 | 文件 | 描述 |
|----|--------|------|------|
| LOW-04 | LOW | `src/index.ts:39-53` | analyzer 成功运行无日志。无法区分"今天还没运行"和"运行成功但无数据"。建议在成功时 log 一条，如 `[evolve-daily] report generated: ${reportPath}`。 |
| LOW-05 | LOW | `src/index.ts:75-88` | detector 匹配成功时无日志。验证 L2 pipeline 是否工作只能通过检查 `appendEntry` 的持久化数据，调试不友好。建议在 match 成功时 log detector ID。 |
| INFO-03 | INFO | `analyzer/extractors/workflow.py:13` | `_parse_iso_timestamp` 静默吞掉 parse 错误（返回 None）。格式错误的时间戳会导致 duration 数据缺失，但没有任何诊断信息。 |

### 4. Fail-fast

**做得好的：**
- `existsSync(reportPath)` 在运行 analyzer 前检查，避免重复计算
- detector `match()` 对 type 不匹配立即返回 `false`
- Python rules 使用 `dict.get()` + 默认值，防御性处理缺失字段
- Python rules 对样本量有最小阈值检查（如 `total_calls >= 3`, `goals_total >= 2`）

**问题：**

| ID | 严重度 | 文件 | 描述 |
|----|--------|------|------|
| LOW-06 | LOW | `src/index.ts:62-77` | （同 LOW-01 不同角度）4 处 `!` 断言不在 init 时验证，而是延迟到第一次事件触发。若 registry 配置错误，需要等到运行时才能发现。应在 extension init 阶段校验所有 detector 的 registry lookup，失败时 throw 或 log error。 |

### 5. 测试友好

**做得好的：**
- Detector 是纯工厂函数，`match()`/`createItem()`/`steering()` 都是无副作用纯函数，单元测试友好
- Python extractors 是 `list[dict] -> dict` 纯函数，mock 数据构造简单
- Python rules 是 `dict -> list[dict]` 纯函数，threshold 测试直接
- `classifyError` / `classifyTaskType` / `classify_task_type` / `score_evidence` 均为可独立测试的纯函数

**问题：**

| ID | 严重度 | 文件 | 描述 |
|----|--------|------|------|
| LOW-07 | LOW | `src/detectors/*.ts` | `DetectorInstance` 接口用 `Record<string, unknown>` 作为事件参数，但每个 detector 内部期望特定 shape。测试需要构造 mock event，但期望的 shape 只能从 detector 实现中推断，没有共享的事件类型定义。建议为每个 detector 导出其期望的事件接口。 |
| INFO-05 | INFO | 整体 | 无测试文件和测试配置。函数设计上完全可测，但实际测试覆盖率为零。 |

### 6. 调试友好

**做得好的：**
- TrackedItem ID 含前缀 + 时间戳 + 随机后缀（如 `compact-1717305600000-a3f2b`），可追溯
- Python rule issue 包含 `metric` 和 `threshold` 字段，可验证触发原因
- Steering template 含上下文变量（`{{id}}`, `{{toolName}}`, `{{errorPreview}}`）

**问题：**

| ID | 严重度 | 文件 | 描述 |
|----|--------|------|------|
| LOW-08 | LOW | 所有 detector `createItem()` | `sessionId` 永远为空字符串 `""`。feedback entry 无法关联到具体 session，丧失了追溯能力。应从事件上下文或 Pi API 获取 session ID。 |
| LOW-09 | LOW | `src/detectors/goal-quality.ts` | `goalId` 永远为空字符串 `""`。无法将 feedback 关联到具体 goal。应从 `event.details` 中提取 goalId。 |
| INFO-06 | INFO | `src/detectors/subagent-result.ts:58` | steering 模板中 `{{duration}}` 永远为 `"unknown"`。事件中不包含 duration 信息，但模板暗示有此数据。对调试者可能造成困惑——是数据缺失还是代码问题？ |

---

## 问题汇总

| ID | 严重度 | 维度 | 摘要 |
|----|--------|------|------|
| LOW-01 | LOW | 错误处理 | `PROBLEM_REGISTRY.find(...)!` non-null assertion 无前置校验 |
| LOW-02 | LOW | 错误处理 | `DetectorInstance.events` 声明但未使用，成为死代码 |
| LOW-03 | LOW | 异常管理 | `unlinkSync` catch 静默吞掉所有错误 |
| LOW-04 | LOW | 日志 | analyzer 成功运行无日志 |
| LOW-05 | LOW | 日志 | detector 匹配成功无日志 |
| LOW-06 | LOW | Fail-fast | registry lookup 不在 init 时校验 |
| LOW-07 | LOW | 测试友好 | detector 事件类型无共享定义 |
| LOW-08 | LOW | 调试友好 | sessionId 永远为空，无法追溯 |
| LOW-09 | LOW | 调试友好 | goalId 永远为空，无法追溯 |
| INFO-01 | INFO | 错误处理 | Python extractor 失败时无结构化错误信息 |
| INFO-02 | INFO | 异常管理 | Python extract() 内部无 try/except，单条消息异常丢失整个 session 结果 |
| INFO-03 | INFO | 日志 | ISO 时间戳 parse 失败静默丢弃 |
| INFO-04 | INFO | Fail-fast | detector.events 声明与实际行为不一致 |
| INFO-05 | INFO | 测试友好 | 无测试文件 |
| INFO-06 | INFO | 调试友好 | subagent duration 永远为 "unknown" |

## 整体评价

代码健壮性整体良好。错误处理方面做到了：

1. **所有关键路径有 try/catch**：analyzer 调用、detector 循环、Python extractor/rule 发现与执行
2. **故障隔离到位**：单个 detector/extractor/rule 失败不影响其他组件
3. **Python 侧防御性编程**：`dict.get()` + 默认值、样本量阈值检查

主要改进方向（均为 LOW，无 MUST_FIX）：

1. **注册前置校验**：将 `!` 断言改为 init 时校验 + 明确错误消息（LOW-01 + LOW-06）
2. **可追溯性**：填充 sessionId / goalId（LOW-08 + LOW-09）
3. **可观测性**：成功路径加日志（LOW-04 + LOW-05）

这些问题不影响功能正确性，但会在生产环境排障时造成摩擦。建议在下一个迭代中处理。
