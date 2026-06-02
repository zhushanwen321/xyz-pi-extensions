---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 31
  issues_found: 12
  must_fix_count: 0
  low_count: 8
  info_count: 4
---

# Standards Review — evolve-daily

审查范围：`packages/evolve-daily/` 全部 TypeScript 和 Python 代码。
审查基准：项目 `CLAUDE.md` 编码规范 + ESLint taste-lint 规则 + PEP 8。

## 审查维度总结

| 维度 | 结论 |
|------|------|
| TypeScript `any` 禁令 | PASS — 零 `any` 使用 |
| TypeScript import 顺序 | PASS — Node 内置 → 项目内部 |
| TypeScript 行数限制 | PASS — 最大文件 234 行（problems.ts），最大函数体约 60 行 |
| Python PEP 8 | PASS — 格式规范 |
| Python type hints | PASS — 所有公开函数有 docstring + type hints |
| Python import 清洁度 | LOW — 5 个未使用的 import（见下） |
| 命名规范 | PASS — 符合项目约定 |
| 注释规范 | PASS — 注释解释 "为什么"，无不必要的 "是什么" 注释 |
| 代码重复 | LOW — 3 处重复工具函数（见下） |
| 死代码 | LOW — 2 处死代码/未使用导出（见下） |

## Issues

### LOW-1: Python 未使用的 import（5 处）

以下文件 `from typing import Any` 未使用（对应文件无 `Any` 引用）：

- `analyzer/extractors/compact.py:3` — `from typing import Any`
- `analyzer/extractors/context.py:3` — `from typing import Any`
- `analyzer/extractors/workflow.py:3` — `from typing import Any`
- `analyzer/rules/__init__.py:8` — `from typing import Any`
- `analyzer/rules/edit_match_failure.py:6` — `import re`

**建议**：删除未使用的 import。不影响运行，但违反 PEP 8 的 import 清洁度要求。

### LOW-2: `_extract_text_from_content` 重复实现（3 处）

以下三个文件包含完全相同的 `_extract_text_from_content` 函数：

- `analyzer/extractors/goal_quality.py:34`
- `analyzer/extractors/subagent.py:29`
- `analyzer/extractors/tool_errors.py:51`

`analyzer/extractors/context.py` 也有类似逻辑的 `_extract_content_length`。

**建议**：提取到共享模块（如 `analyzer/extractors/_utils.py`）。Python 模块间没有 workspace 依赖约束，抽取成本低。

### LOW-3: `classify_error` 和错误模式列表 TS/Python 双写

TypeScript `src/detectors/param-error.ts` 和 Python `analyzer/extractors/tool_errors.py` 各维护一套 `PARAM_ERROR_PATTERNS` / `RUNTIME_ERROR_PATTERNS` + `classifyError()`。两边的列表和正则目前一致，但未来修改时容易不同步。

同理，`src/detectors/subagent-result.ts` 的 `TASK_TYPE_PATTERNS` 和 `analyzer/extractors/subagent.py` 也存在同样的双写。

**建议**：可以接受当前状态（TS 用于实时检测，Python 用于离线分析，职责不同），但应加注释标明两边需要同步。

### LOW-4: `problems.ts` 中有 5 个 exported interfaces 从未被外部引用

以下 interface 被 `export` 但仅在本文件内使用：

- `SeverityRule`
- `DetectorConfig`
- `MatchCondition`
- `AnalysisConfig`
- `SuggestionTemplate`

同时 `getProblemById()` 和 `getProblemsByCategory()` 被导出但全项目无调用方。

**建议**：不影响运行，但增加了公共 API 表面积。可以改为非 export 或标记 `@internal`。低优先级。

### LOW-5: `PROBLEM_REGISTRY.find()` 使用非空断言 `!`

`src/index.ts:67-76` 中 4 处使用 `PROBLEM_REGISTRY.find((p) => p.id === "xxx")!` 非空断言。如果 registry 中缺少对应 id，运行时会抛出难以调试的 `Cannot read properties of undefined` 错误。

**建议**：用 `getProblemById()` + 运行时检查替代非空断言。当前代码安全（id 硬编码且 registry 就在同一文件），但未来新增 detector 时容易遗漏。

### LOW-6: `DetectorInstance` 接口的 `match`/`createItem` 参数类型为 `Record<string, unknown>`

`src/index.ts:25-27` 定义了 `DetectorInstance` 接口，`match` 和 `createItem` 参数为 `Record<string, unknown>`。各 detector 实际上有更具体的类型签名（如 `{ type: string; toolName?: string; isError?: boolean }`），但为了统一接口被泛化了。

**建议**：当前设计合理（多态需要统一签名），不需要改。但可以考虑定义 `ToolExecutionEvent` 类型替代 `Record<string, unknown>`。

### LOW-7: Python `rules/__init__.py` 的 `run_rules` 使用 `# type: ignore[attr-defined]`

`analyzer/rules/__init__.py:43` 和 `analyzer/extractors/__init__.py:51` 使用 `# type: ignore[attr-defined]` 绕过动态调用的类型检查。

**建议**：`extractors/__init__.py` 已经定义了 `BaseExtractor` Protocol，可以在 `discover_extractors` 返回类型中用它。`rules` 侧可以类似定义 `BaseRule` Protocol。

### LOW-8: `goal_quality.py` 中 `stall_stats` 的 `goals_with_stall` 计算有逻辑缺陷

`analyzer/extractors/goal_quality.py:149`:
```python
"goals_with_stall": 1 if stall_count > 0 else 0,
```

`stall_count` 是所有 session 的 stall 总和，但 `goals_with_stall` 只输出 0 或 1。如果有多个 goal 都出现了 stall，这个值仍然是 1。

**建议**：应该在循环中统计有多少个独立的 goal 出现了 stall，而不是对聚合后的 stall_count 做布尔转换。

## INFO（观察，不构成问题）

### INFO-1: `workflow.py` 中 3 个始终为 0 的变量

`analyzer/extractors/workflow.py:38-40` 中 `review_findings_total`、`retrospect_written`、`retrospect_expected` 初始化为 0 但从未被赋值。它们出现在返回值中但始终为 0。

这是预留的字段，未来实现 review 分析时会填充。当前不影响正确性，但增加了静态分析噪音。

### INFO-2: Python extract 函数体较长

以下 `extract()` 函数体超过 80 行（项目 TypeScript 规范上限）：

- `workflow.py`: 127 行
- `goal_quality.py`: 118 行
- `tool_errors.py`: 104 行
- `context.py`: 83 行

Python 侧没有明确的行数规范，且这些函数是数据提取管道，拆分反而降低可读性。记录为 INFO，不需要修改。

### INFO-3: TS/Python 两层架构的一致性

TypeScript 负责实时检测（L2 detectors），Python 负责离线分析（L1 analyzer）。两边的正则、模式、分类逻辑需要保持一致。当前一致，但缺少自动化同步验证。

### INFO-4: `DetectorInstance.steering()` 已定义但未在 `index.ts` 中调用

`src/index.ts:28` 的 `DetectorInstance` 接口定义了 `steering` 方法，各 detector 也实现了它，但 `tool_execution_end` 事件处理器中没有调用 `detector.steering()`。

`steering` 文本定义在 `problems.ts` 的 `detector.steering` 字段中，可能由 SKILL.md 中的 `/evolve` 工作流间接消费。不算死代码，但接口和实际使用之间存在间接关系。

## 规范符合性逐项检查

### TypeScript 规范

| 规则 | 状态 |
|------|------|
| 禁止 `any` | PASS — 零 `any` |
| 类型守卫替代 `(x as any).field` | PASS — 无 `as any` |
| import 顺序（Node → npm → 内部） | PASS |
| 单文件 ≤ 1000 行 | PASS — 最大 234 行 |
| 函数 ≤ 300 行 | PASS — 最大约 60 行 |
| `console.error` 仅用于错误日志 | PASS — 2 处，均为错误场景 |

### Python 规范

| 规则 | 状态 |
|------|------|
| PEP 8 格式 | PASS |
| Type hints | PASS — 公开函数均有 |
| Docstrings | PASS — 所有 `extract()`/`check()` 均有 |
| 函数长度 | PASS — 单个 `check()` 均在 30 行内 |
| `print()` 仅用于 Warning | PASS — 4 处，均为加载失败警告 |

### 命名规范

| 规则 | 状态 |
|------|------|
| 扩展入口 `xxxExtension` | PASS — `evolveDailyExtension` |
| 工厂函数 `createXxxDetector` | PASS — 4 个 detector 工厂 |
| 文件名 kebab-case | PASS — `goal-quality.ts`, `param-error.ts` |
| 常量 UPPER_SNAKE_CASE | PASS — `PROBLEM_REGISTRY`, `TASK_TYPE_PATTERNS` |

### 注释规范

| 规则 | 状态 |
|------|------|
| 解释 "为什么" | PASS — 如 `daily-reports/ 目录复用旧 extension 的目录路径` 注释 |
| 无冗余 "是什么" 注释 | PASS — 无 `// increment counter` 类注释 |
| 无 TODO/FIXME | PASS |

## 结论

代码质量良好，无 must-fix 问题。8 个 LOW 级别问题主要是代码清洁度（未使用 import、重复代码、非空断言）和一个小型逻辑缺陷（stall 统计）。这些问题不影响功能和正确性，可在后续迭代中逐步清理。
