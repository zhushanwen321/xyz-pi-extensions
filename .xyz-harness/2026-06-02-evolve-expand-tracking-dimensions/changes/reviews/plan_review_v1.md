---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-02T16:30:00"
  target: ".xyz-harness/2026-06-02-evolve-expand-tracking-dimensions/plan.md"
  verdict: fail
  summary: "计划评审第1轮，4条MUST FIX（文件路径错误、TypeScript detector 缺实际集成、tool_errors 硬编码占位值、context extractor 逻辑错误），需修改后重审"

statistics:
  total_issues: 10
  must_fix: 4
  must_fix_resolved: 0
  low: 4
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:File Structure 表格 + 所有 Task"
    title: "文件路径错误：packages/evolve/ 应为 packages/evolve-daily/"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:BG1 + Task 1-5"
    title: "TypeScript detector 只有工厂函数定义，缺实际集成到 engine.ts 的注册和事件监听"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Task 10 (tool_errors.py)"
    title: "self_correction_rate 硬编码为 0.65 占位值，未实现实际计算逻辑"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "plan.md:Task 8 (context.py)"
    title: "estimate_tokens 收到的是 'x' * cumulative_chars 的长度而非实际文本，估算结果无意义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:Task 6 (__init__.py)"
    title: "BaseExtractor 使用 Protocol 但 extract 函数签名不含 self，与实际模块级函数不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md:Task 9 (subagent.py)"
    title: "retry_count 计算逻辑有误——连续两次 subagent 调用不应全部算作重试，应只计 error 后的立即重试"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "plan.md:Task 11 (workflow.py)"
    title: "gate_count >= 5 作为 workflow 完成判定过于脆弱——用户可能在某阶段多次 gate 重试"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "plan.md:Task 13 (miner rules)"
    title: "14 条 rules 只有 1 条给出了完整代码示例，其余 13 条只说'类似'，缺乏可执行规格"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: INFO
    location: "spec.md:§2.2 + plan.md:Task 8"
    title: "context_stats 的字符数/token 估算精度极低，spec 已承认但 plan 未提出缓解措施（如标注置信度）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 10
    severity: INFO
    location: "plan.md:BG2 Dependencies"
    title: "BG2 依赖 BG1 的 ProblemRegistry ID 定义，但 BG2 的 Python extractor 实际不引用任何 TypeScript 常量——依赖关系不真实"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-02 16:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-06-02-evolve-expand-tracking-dimensions/plan.md` + `spec.md` + `e2e-test-plan.md` + `use-cases.md` + `non-functional-design.md`

---

## 1. spec 完整性

### 目标明确性 ✅
spec 目标清晰：为 evolve 系统新增 6 个追踪维度（compact、上下文利用率、subagent 效率、工具参数错误、工作流阶段耗时、Goal/Todo 质量）。一段话可以概括。

### 范围合理性 ✅
范围有明确边界：
- 明确标注了"不能追踪的"内容（如 compact 前后精确 token 数、信息丢失量）
- 明确标注了 Problem Registry 的定位（文档化 + 阈值共享，不驱动 L2/L3 的实际逻辑）
- 精度说明坦率（字符数/token 估算只用于趋势观察）

### 验收标准可量化 ✅
5 条验收标准（AC-1 ~ AC-5）均可量化验证：
- AC-1~AC-6：daily-reports JSON 包含特定字段
- AC-7：actionable_issues 包含 10+ 条新规则
- AC-8：/evolve skill 能分析新维度数据
- AC-9：extractor 独立运行不互相影响
- AC-10：新增维度只需 1+1+1 文件

### 未决议项 ⚠️
spec 中无 `[待决议]` 标记。但 spec §1.1 Problem Registry 定位中，"不驱动 L2 检测器的创建"与 plan 中 Task 1 创建 `PROBLEM_REGISTRY` 常量（含 detector 配置）存在语义张力。这不算未决议，但设计意图的表述可以更精确。

---

## 2. plan 可行性

### 任务拆分 ✅
15 个 Task 拆分合理，每个 Task 粒度适中（1~2 个文件），可由一个 subagent 独立完成。

### 依赖关系 ⚠️
plan 声明 BG2 依赖 BG1，理由是"ProblemRegistry ID 定义需要一致"。但实际检查代码：
- BG2 的 Python extractor 不 import 任何 TypeScript 文件
- extractor 和 rule 中的 problem ID（如 "compact-high-frequency"）是硬编码字符串，不引用 PROBLEM_REGISTRY
- **BG1 和 BG2 实际上可以并行**（见 Issue #10）

这意味着 Wave 调度有优化空间，但不影响正确性。

### 工作量估算 ✅
27 个新文件（5 TS + 20 Python + 2 SKILL.md 修改），工作量合理。Medium model 用于 extractor 写作是合适的。

### 遗漏检查 ⚠️
对照 spec 发现以下遗漏：

1. **spec §3.1 数据流中 L2 → feedback-records 的路径**：spec 描述了 detector 写入 feedback-records/*.jsonl，但 plan 中 Task 1-5 的 detector 只有 `createItem` 和 `steering` 方法，没有写入 feedback-records 的逻辑。spec 明确标注了 4 条 L2 路径（compact detector / subagent detector / param-error detector / goal-quality detector → feedback-records），plan 完全遗漏了这一层。

2. **spec §2.5 workflow 数据采集方式**：spec 明确说"workflow 数据不通过 L2 追踪引擎采集"，但 plan 中 BG1 没有 workflow detector（正确），BG2 有 workflow extractor（正确）。这一致，但 plan 没有显式说明为什么 BG1 只有 4 个 detector 而不是 6 个。

3. **spec §2.4 中的 `top_param_errors` 字段**：plan Task 10 的实现提取错误模式的方式（`f"{tool_name}: {match.group()}"`）与 spec 的示例格式（`{"tool": "edit", "pattern": "Could not find the exact text", "count": 8}`）不一致——plan 用正则 match 的 group() 可能只返回部分文本。

---

## 3. spec 与 plan 一致性

### 逐条覆盖检查

| Spec 需求 | Plan Task | 覆盖状态 |
|-----------|-----------|----------|
| §2.1 Compact 追踪 | Task 2 (detector) + Task 7 (extractor) + 2 rules | ✅ 完整 |
| §2.2 上下文窗口利用率 | Task 8 (extractor) + 1 rule | ⚠️ 无 TS detector，但 spec 说"信号源是 model_change 事件"——L2 实时追踪不可行（无精确 token 数据），这合理 |
| §2.3 Subagent 调度效率 | Task 3 (detector) + Task 9 (extractor) + 2 rules | ✅ 完整 |
| §2.4 工具参数校验失败 | Task 4 (detector) + Task 10 (extractor) + 3 rules | ⚠️ self_correction_rate 硬编码占位（Issue #3） |
| §2.5 Coding-Workflow 阶段耗时 | Task 11 (extractor) + 2 rules | ✅ 完整（无 TS detector，与 spec 一致） |
| §2.6 Goal/Todo 质量 | Task 5 (detector) + Task 12 (extractor) + 4 rules | ✅ 完整 |
| §3.1 数据流（L2→feedback-records） | 无 | ❌ 遗漏（见上文遗漏检查） |
| §3.2 daily-reports 新字段 | Task 6-12 | ✅ 完整 |
| §3.3 /evolve skill 消费新数据 | Task 14 | ✅ 完整 |
| §4 新增文件清单 | 全部 Task | ⚠️ 路径错误（Issue #1） |
| §5 验收标准 AC-1~AC-10 | Spec Coverage Matrix | ✅ 矩阵完整 |

### plan 中 spec 未提及的额外工作
- Task 6（extractor 自动发现机制）：spec §5 AC-9 提到"extractor 独立运行"，plan 额外实现了自动发现机制。这是合理的工程补充。

---

## 4. Execution Groups 合理性

### 分组合理性 ⚠️
- BG1: 5 个文件 / 5 个 Task — 合理
- BG2: 20 个文件 / 8 个 Task — **超过 10 个文件阈值（20 个）**。建议拆分为 BG2a（6 个 extractor）和 BG2b（14 条 rules + __init__.py），但功能关联度高，不强制要求
- BG3: 2 个文件 / 2 个 Task — 合理

### 类型划分 ✅
BG1 全 TS，BG2 全 Python，BG3 全 SKILL.md，无混合类型 Group。

### 功能关联度 ✅
同组 Task 关联紧密。

### 依赖关系 ⚠️
BG1 → BG2 的依赖关系不真实（见 Issue #10），但不会导致错误，只是浪费并行机会。

### Subagent 配置完整性 ✅
每组都有 Agent、Model、注入上下文、读取文件、修改/创建文件。配置完整。

### 上下文充分性 ✅
注入上下文指向 spec 的具体章节和现有代码文件，subagent 可以独立完成。

---

## 5. 接口契约审查

### AC 覆盖矩阵 ✅
Spec Coverage Matrix 覆盖了所有 10 条 AC，每条 AC 有对应的 Task 和 Data Flow。

### 数据结构一致性 ⚠️
plan 的 Interface Contracts 中定义的数据结构（CompactStats, ContextStats 等）与 spec 中的产出数据结构一致。但具体实现在某些地方偏离了 spec：
- `tool_errors.py` 的 `top_param_errors` 格式与 spec 不完全一致（见上文遗漏检查 #3）

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:File Structure + 全部 Task | **文件路径错误**：plan 中所有文件路径使用 `packages/evolve/` 前缀，但实际项目中的包名是 `packages/evolve-daily/`。package.json 的 name 是 `@zhushanwen/pi-evolve-daily`，src 目录在 `packages/evolve-daily/src/`，skills 在 `packages/evolve-daily/skills/`。27 个文件路径全部错误，subagent 执行时会找不到目标位置。 | 全局替换 `packages/evolve/` → `packages/evolve-daily/`。需要验证 analyzer/ 目录是否存在（当前 `packages/evolve-daily/` 下没有 `analyzer/` 目录，说明这是一个新增目录）。 |
| 2 | MUST FIX | plan.md:BG1 + Task 1-5 | **TypeScript detector 缺实际集成**：plan 中 Task 1-5 创建了 detector 工厂函数（`createCompactDetector` 等），但这些 detector 没有注册到任何事件系统。现有的 `packages/evolve-daily/src/index.ts` 只在 `session_start` 中调用 Python analyzer，没有任何 L2 实时追踪的事件监听代码。plan 缺少一个 Task 将这些 detector 注册到 Pi 的 `pi.on("tool_execution_end")` 或类似事件中。没有注册代码，这些 detector 永远不会被执行。 | 方案 A：新增 Task 在 `packages/evolve-daily/src/index.ts` 中添加事件监听代码，将 detector 注册到 Pi 事件系统。方案 B：如果 L2 实时追踪不在本期范围内，在 plan 中明确标注，并从 File Structure 中移除 TypeScript detector 文件（只保留 ProblemRegistry）。 |
| 3 | MUST FIX | plan.md:Task 10 (tool_errors.py) | **self_correction_rate 硬编码占位值**：`tool_errors.py` 中 `self_correction_rate = 0.65  # 占位值`。这个值会被写入 daily-reports JSON 并被 miner rules 消费。spec §2.4 明确定义了"自行修正率 = 错误后 turn 内同工具成功调用的比例"，plan 的注释说"这需要更复杂的 turn 级分析，这里简化处理"——但 spec 已定义了计算方式，plan 不应简化掉。spec 的 miner rule `low-self-correction` 条件是 `self_correction_rate ≤ 0.50`，硬编码 0.65 永远不会触发这条规则。 | 实现 spec 定义的自行修正率计算：对每个错误，检查同一 session 中同工具的后续调用是否成功。至少要做到基本正确，不能用常量占位。 |
| 4 | MUST FIX | plan.md:Task 8 (context.py) | **estimate_tokens 估算逻辑错误**：`context.py` 中 `estimate_tokens("x" * cumulative_chars)` 传入的是由 `'x'` 字符组成的字符串，而非原始消息内容。`'x'` 全是 ASCII 字符，会被按英文 0.25 token/char 计算，完全失去了中英文混合估算的能力。正确做法应该是传入原始消息内容或直接用字符数 * 混合比例估算。 | 修改为直接基于 cumulative_chars 字符数估算：不构造假字符串，而是基于中文字符比例估算。或者简化为 `cumulative_chars * 0.5`（一个保守的混合比例）。当前 `estimate_tokens` 函数的输入不是实际文本，输出完全无意义。 |
| 5 | LOW | plan.md:Task 6 (__init__.py) | **Protocol 定义与实际使用不匹配**：`BaseExtractor` 定义为 Protocol 类，要求 `extract(self, sessions)` 方法签名。但实际 extractor 模块（如 compact.py）导出的是模块级函数 `def extract(sessions)`（无 self）。Python 的 Protocol 检查不会在运行时报错（structural subtyping），但类型标注不一致会误导开发者。 | 方案 A：将 Protocol 改为文档说明（注释或 docstring）。方案 B：所有 extractor 实现为类并实例化。当前代码能运行但语义不清晰。 |
| 6 | LOW | plan.md:Task 9 (subagent.py) | **retry_count 计算逻辑过于宽泛**：当前逻辑是"如果 prev_subagent_call 不为 None，retry_count += 1"——即除了第一次 subagent 调用外，所有后续调用都算作"重试"。这不准确。一个 session 中可能有多个独立的 subagent 任务（如先做 code review 再做 implementation），它们不是重试关系。 | 应该基于任务内容相似性或 error 后的立即重试来判定。最简单的方案：只在 isError=True 的下一条 subagent 调用算重试。 |
| 7 | LOW | plan.md:Task 11 (workflow.py) | **workflow 完成判定逻辑脆弱**：`gate_count >= 5` 作为"至少完成 5 个阶段"的判定。但用户可能在某阶段 gate 重试多次（如 phase=dev 重试 2 次），5 个阶段可能实际只完成了 3 个。反之，如果 5 阶段都 pass 但用户重试了某阶段（gate_count = 6），会被判为 completed 但实际有额外的 gate 调用。 | 应该检查 5 个不同的 phase 是否都有 passed 的 gate 记录，而不是简单计数。 |
| 8 | LOW | plan.md:Task 13 | **14 条 miner rules 只有 1 条完整代码**：plan 对 Task 13 的描述是"其余 13 条规则类似，每个文件实现 check 函数"，但没有给出每条规则的具体阈值、触发条件和产出格式。subagent 需要精确规格才能正确实现。 | 至少为每条 rule 列出：metric path（从 daily_report 中读取哪个字段）、阈值条件、severity、suggestion 文本。不需要完整代码，但需要足够精确的规格。 |
| 9 | INFO | spec.md:§2.2 + plan.md:Task 8 | context_stats 的估算精度极低——spec 坦率承认"只用于趋势观察"。但 plan 的实现没有在产出数据中标注置信度或精度等级，消费者（miner rules、/evolve skill）可能误以为数据是精确的。 | 可选改进：在 context_stats 中增加 `_precision_note: "estimated_from_char_count"` 字段，或 miner rules 的触发阈值留更大余量。 |
| 10 | INFO | plan.md:BG2 Dependencies | BG2 声明依赖 BG1，理由是"ProblemRegistry ID 定义需要一致"。但 BG2 的 Python extractor 和 rule 完全不引用 BG1 的 TypeScript 代码。两者之间唯一的关联是 problem ID 字符串的一致性（如 "compact-high-frequency"），这可以通过 spec 文档保证，不需要执行顺序依赖。 | 可以将 BG1 和 BG2 改为同一 Wave 并行执行，缩短总耗时。不阻塞当前 plan，是优化建议。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### MUST FIX 详细分析

**Issue #1（文件路径错误）**：这是最严重的问题。plan 中 27 个文件路径全部使用 `packages/evolve/` 前缀，但项目中实际包名是 `packages/evolve-daily/`。验证方式：
- `packages/evolve-daily/package.json` 的 name 是 `@zhushanwen/pi-evolve-daily`
- `packages/evolve-daily/src/index.ts` 已存在（当前只有 session_start 调用 Python analyzer 的逻辑）
- `packages/evolve-daily/skills/` 下有 evolve/evolve-apply/evolve-report 三个 skill
- `packages/evolve/` 目录**不存在**

如果 subagent 按照当前 plan 执行，所有文件都会写到不存在的目录。虽然 git 可以处理，但 typecheck 命令 `pnpm --filter @zhushanwen/pi-evolve typecheck` 也会失败（正确的是 `@zhushanwen/pi-evolve-daily`）。

**Issue #2（detector 缺集成）**：plan 创建了 4 个 detector（compact/subagent/param-error/goal-quality），每个有 match/createItem/steering 方法。但这些 detector 没有注册到 Pi 的事件系统。当前 `packages/evolve-daily/src/index.ts` 只监听 `session_start`，不监听 `message_end`/`tool_result`/`turn_end`。detector 工厂函数被创建但从未被调用。

两种修复路径：
- 路径 A：增加一个 Task 在 index.ts 中注册 detector（涉及 Pi Extension API 的事件系统，需要调研可用事件）
- 路径 B：明确标注本期只做 L3（Python extractor），L2 detector 作为后续工作

**Issue #3（self_correction_rate 占位值）**：hardcoded 0.65 的问题不只是"不精确"，而是**永远不会触发 miner rule**。spec 定义 `low-self-correction` 规则条件为 `self_correction_rate ≤ 0.50`，而占位值 0.65 > 0.50，所以这条 rule 永远不会触发。这等于 spec 定义的 `low-self-correction` 规则完全失效。

**Issue #4（estimate_tokens 输入错误）**：`estimate_tokens("x" * cumulative_chars)` 构造了一个由纯 ASCII 字符 'x' 组成的字符串，其长度等于累积消息字符数。这个字符串会被 `estimate_tokens` 函数当作纯英文文本处理（0.25 token/char），完全忽略了原始消息中可能包含的中文字符。更准确地说，这个函数估算的不是"这些消息大约有多少 token"，而是"等长度的纯英文文本大约有多少 token"。这违反了 spec 定义的"中文约 1.5 token/char，英文约 0.25 token/char"的估算目标。

---

## 6. 后端设计充分性

### 是否说明了"为什么" ⚠️
- ProblemRegistry 的设计理由在 spec §1.1 中有说明（文档化 + 阈值共享），plan 引用了 spec。
- 但 detector 的设计只说明了"做什么"（工厂函数），没有说明"为什么用工厂模式而不是直接注册事件处理器"。

### 存储变更是否有选型理由 ✅
daily-reports JSON 是只写覆盖，无增量更新，无并发问题。non-functional-design.md 中有说明。

### 边界条件 ⚠️
- 空输入：extractor 都处理了空 session 列表（返回零值统计）✅
- 异常处理：`__init__.py` 的 `run_extractors` 用 try/except 隔离 ✅
- 但 tool_errors.py 的 `self_correction_rate` 占位值是一个隐藏的边界条件问题（Issue #3）

### 非功能性要求 ✅
non-functional-design.md 覆盖了稳定性、数据一致性、性能、安全。

---

## 辅助文档评审

### e2e-test-plan.md ✅
8 个测试场景覆盖了 AC-1~AC-9。每个场景有明确的输入、执行步骤和预期结果。测试粒度合理。

缺少的测试：
- 无 AC-10（新增维度只需 1+1+1）的验证——但这更像是架构验证而非功能测试
- 无端到端的"完整 daily-reports JSON 结构验证"（所有 7 个新字段同时存在）

### use-cases.md ✅
7 个用例覆盖了所有 spec 维度。每个用例有明确的 Actor、Preconditions、Main Flow、Alternative Paths、Postconditions、Module Boundaries。UC-7 覆盖了 AC-7 和 AC-8。

### non-functional-design.md ✅
简洁实用，覆盖了 5 个非功能性维度。特别好的点：
- "Python extractor 只提取统计数据，不存储原始消息内容"（数据安全）
- "每次分析覆盖写入"（避免并发问题）

---

## 结论

需修改后重审。4 条 MUST FIX 中，Issue #1（文件路径错误）和 Issue #2（detector 缺集成）是结构性问题，需要在 plan 层面解决。Issue #3 和 Issue #4 是代码层面的逻辑错误，可以在 Task 实现中修正，但 plan 需要更新对应的伪代码。

### Summary

计划评审完成，第1轮，4条MUST FIX（文件路径全部错误、detector 缺运行时注册、占位值导致规则失效、估算函数输入错误），需修改后重审。
