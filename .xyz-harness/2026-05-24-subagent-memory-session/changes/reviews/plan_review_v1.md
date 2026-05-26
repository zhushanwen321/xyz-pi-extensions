---
verdict: pass
must_fix: 0

review:
  type: plan_review
  round: 1
  timestamp: "2026-05-25T11:00:00"
  target: ".xyz-harness/2026-05-24-subagent-memory-session/spec.md + plan.md + e2e-test-plan.md"
  summary: "计划评审完成，第1轮通过，0条MUST FIX，3条LOW建议"

statistics:
  total_issues: 4
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: LOW
    location: "plan.md:Task 1 Step 5"
    title: "冲突的代码片段残留——`copyFileSync` 的早期版本通过 `.replace()` 反向推导主 session 路径"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "plan.md:Execution Groups → File section"
    title: "缺少显式的 render.ts 读取步骤——SubagentDetails 接口需要修改但无独立步骤"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "e2e-test-plan.md:TS-2"
    title: "TS-2 第二个验证标准无法外部验证——'subagent 能回忆之前的对话（KV cache 命中）'"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: INFO
    location: "plan.md:Task 1 Step 2"
    title: "hasTasks/hasChain 计算时机——plan 已自识别模式检测需重排"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-25 11:00
- 评审类型：计划评审（spec + plan + e2e-test-plan）
- 评审对象：Subagent Memory Session（2026-05-24）

---

## 1. Spec 完整性

**目标明确性：** ✅ 通过。一段话说清核心目标："在现有 subagent 扩展上增加可选的 memory 参数，让 subagent 拥有持久化的 session 文件"。

**范围合理性：** ✅ 通过。spec 明确限定了改动范围（`spawn.ts` + `index.ts`），约束条件清晰（不改变现有行为、不做 diff/摘要、不新增外部依赖、Session 文件管理最小化）。

**验收标准可量化性：** ✅ 通过。AC-1 到 AC-9 都有明确的 Given/When/Then 或简单验证条件，每个都可写测试或检查。

**`[待决议]` 项：** ✅ 无。

**设计决策层面的一个偏差（非问题，观察项）：** spec FR-2 提到使用 `--fork <主session文件>` CLI 参数创建 session 文件，但 plan 改用 `fs.copyFileSync`。plan 给出了合理理由（`--fork` 将文件放在 Pi 默认 session 目录，而非主 session 同目录；`copyFileSync` 在 POSIX 上原子操作且我们能控制精确路径）。所有 AC 仍满足无需问。这个偏差是 **设计优化**，不是 spec 违规。

---

## 2. Plan 可行性

### Task 拆分

| # | Task | 粒度评估 |
|---|------|---------|
| 1 | memory schema + validation + session file management + spawn logic | ✅ 适中。集中在 index.ts 和 spawn.ts 两个文件 |
| 2 | tool description + renderCall/renderResult memory display | ✅ 适中。集中在 index.ts（description + 渲染逻辑） |

依赖关系：Task 2 → Task 1。**正确**。

### Spec 指标全覆盖

逐一对照 spec 的 9 个 AC 和 7 个 FR：

| 来源 | 指标 | Task 覆盖 | 状态 |
|------|------|-----------|------|
| AC-1 | 首次 memory 调用创建 `*.mem-*.jsonl` + `--session` | Task 1 Step 5, 6 | ✅ |
| AC-2 | 后续调用复用已有 session | Task 1 Step 6 (action="resume") | ✅ |
| AC-3 | 无 memory 调用不变（`--no-session`） | Task 1 Step 5 (else 分支) | ✅ |
| AC-4 | memory 参数 sanitization | Task 1 Step 3 (sanitizeMemoryId) | ✅ |
| AC-5 | Session 文件位于主 session 同目录 | Task 1 Step 3 (resolveMemorySessionFile) | ✅ |
| AC-6 | tsc --noEmit 通过 | Task 1 Step 8, Task 2 Step 4 | ✅ |
| AC-7 | ESLint 通过 | Task 2 Step 4 | ✅ |
| AC-8 | memory 不允许在 background/parallel/chain 模式 | Task 1 Step 2 | ✅ |
| AC-9 | tool description 包含 memory 指引 | Task 2 Step 1 | ✅ |
| FR-1 | memory 参数 | Task 1 Step 1 (schema) | ✅ |
| FR-2 | 首次调用创建 session | Task 1 Step 6 (action=create) | ✅ |
| FR-3 | 后续调用恢复 session | Task 1 Step 6 (action=resume) | ✅ |
| FR-4 | Session 文件管理（命名/sanitization/生命周期） | Task 1 Step 3, 6 | ✅ |
| FR-5 | 模式限制 | Task 1 Step 2 | ✅ |
| FR-6 | tool description 更新 | Task 2 Step 1 | ✅ |
| FR-7 | renderCall/renderResult 展示 | Task 2 Step 2, 3 | ✅ |

**无遗漏 task。**

### 工作量估算

spec 自身标记为"中等偏低"，plan 拆分为 2 个 task + 3 个文件（index.ts, spawn.ts, render.ts）。估算合理。

---

## 3. Spec 与 Plan 一致性

- plan 逐条覆盖了 spec 的所有 FR 和 AC
- plan 没有引入 spec 未要求的额外功能（无 scope creep）
- plan 的 Execution Groups 表中包含 Spec Metrics Traceability 表，可追溯性清晰
- 验收标准都能在 plan task 中找到对应实现步骤

**一致。**

---

## 4. Execution Groups 合理性

只有一个分组 BG1，因为这是一个 2 task / 3 文件的小型特性：

| 检查项 | 评估 |
|--------|------|
| 每组文件数 ≤ 10 | ✅ 3 个文件（index.ts, spawn.ts, render.ts） |
| 类型划分（前后端分离） | ✅ 纯后端（TypeScript），无前端 |
| 功能关联度 | ✅ Task 2 依赖 Task 1 的接口变更，密切关联 |
| 依赖关系 | ✅ BG1-Task1 → BG1-Task2 |
| Wave 编排 | ✅ Wave 1: Task1, Wave 2: Task2 |
| Subagent 配置完整性 | ✅ Agent, Model, 注入上下文, 读取文件, 修改文件均指定 |
| 上下文充分性 | ✅ 注入 spec.md + 现有代码结构 + FR/AC 引用 |
| 文件数预估 | ✅ 3 个文件（0 create + 3 modify） |

---

## 5. 发现的问题

| # | 优先级 | 位置 | 描述 | 建议 |
|---|--------|------|------|------|
| 1 | LOW | plan.md Task 1 Step 5 | **冲突的代码片段残留。** Step 5 先展示了一个通过 `memorySession.filePath.replace(/\.mem-[^.]+\.jsonl$/, ".jsonl")` 反向推导主 session 路径的版本，然后说"Wait —"并展示了改用 `mainSessionFile` 的正确版本。最终修正版是正确的，但早期版本仍留在文档中，实现者若不仔细阅读可能使用错误版本。 | 删除 Step 5 中第一个版本（`.replace` 版本）的代码块，仅保留最终修正版本。 |
| 2 | LOW | plan.md Execution Groups → File section | **缺少 render.ts 的显式读取步骤。** Execution Groups 表格标明 render.ts 是读取/修改文件之一，Task 1 Step 7 也提到"Update `SubagentDetails` interface in `render.ts`"，但没有任何步骤说"读取 `render.ts` 找到 `SubagentDetails` 接口定义"。实现者可能漏掉这一步。 | 在 Task 1 中增加一个子步骤："Read `subagent/src/render.ts` to find and update the `SubagentDetails` interface". |
| 3 | LOW | e2e-test-plan.md TS-2 | **第二个验证标准无法外部验证。** `验证：subagent 能回忆之前的对话（KV cache 命中）` 无法通过外部观察确认。KV cache 命中是 Pi 进程内部行为，测试者无法判断是否命中。实际可验证的是 session 文件状态和返回结果中的 `memoryAction="resume"`。 | 删除或重新措辞第二个验证标准。改为"验证：第二次调用的 session 文件存在且未被重新创建（`fs.statSync` 的 mtime 未大幅更新）"或简称"验证：`memoryAction` 返回 `resume`"。 |
| 4 | INFO | plan.md Task 1 Step 2 | **hasTasks/hasChain 计算时机。** Plan 自识别问题：`hasTasks` 和 `hasChain` 在当前代码中计算较晚（Step 3），但 memory 验证需要在 spawn 之前。Plan 已说明"need to move validation after mode detection or compute mode flags earlier"。 | 已在 plan 中自识别，实现时注意按最终修正版本（Step 2 之后或与 Step 3 合并）合理安排计算顺序。 |

---

## 优先级判定依据

所有问题按以下规则判定：

- **LOW #1**（冲突代码片段）：并非功能性错误，修正版已给出。但残留的早期版本可能误导实现者。不影响功能正确性。
- **LOW #2**（缺少 render.ts 读取步骤）：实现者可能从 Execution Groups 推断出需要读 render.ts，但 plan 没有提供明确的步骤指引。文档完整性问题，不影响实现质量。
- **LOW #3**（TS-2 无法外部验证）：KV cache 命中是内部实现细节，不是外部可验证的行为。测试文档措辞问题，不影响 feature 正确性。第一个验证标准（memoryAction="resume"）已足够。
- **INFO #4**（hasTasks 排序）：plan 自识别并给出解决方案。属于规划过程中的正常发现。

---

## 结论

**通过。** 无 MUST FIX 问题。spec 完整、plan 可行、一致性良好、Execution Groups 编排合理。3 条 LOW 建议可选择性修复以提升文档清晰度。

### Summary

计划评审完成，第1轮通过，0条MUST FIX，3条LOW。
