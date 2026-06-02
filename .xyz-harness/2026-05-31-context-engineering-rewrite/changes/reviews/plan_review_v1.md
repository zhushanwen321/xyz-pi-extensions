---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-31T16:30:00"
  target: ".xyz-harness/2026-05-31-context-engineering-rewrite/plan.md"
  verdict: fail
  summary: "计划评审第1轮，2条MUST FIX，Task 4/5 Files列表遗漏config.ts，需修复后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 4 → Files"
    title: "Task 4 Files 列表缺少 config.ts"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 5 → Files"
    title: "Task 5 Files 列表缺少 config.ts"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md:C-6 vs FR-2"
    title: "Spec C-6 与 FR-2 FrozenFreshState 持久化描述矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 3 → 实现要点"
    title: "Compact Boundary 检测方式未确定，列为风险项"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:Task 2 + Task 6"
    title: "processBudget 串联到管道的描述不完整，pipeline 编排位置有歧义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-31 16:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-31-context-engineering-rewrite/plan.md` + `spec.md` + `use-cases.md` + `e2e-test-plan.md` + `non-functional-design.md`
- 参考基准：`CLAUDE.md` 架构约束和编码规范 + 现有源码（compressor.ts 547行, config.ts 144行, index.ts 99行, recall-store.ts 63行, commands.ts 118行）

---

## 1. Spec 完整性

### 1.1 目标明确性 ✅

目标一句话可概括：「在 context-engineering 扩展中复刻 Claude Code 三层上下文管理架构，新增 Microcompact + Tool Result Budget + Frozen/Fresh，修复 L1 缺失 protected turn 检查」。四个设计缺陷（Background #1-#4）与三层架构对应关系清晰。

### 1.2 范围合理性 ✅

范围限定在 context-engineering 扩展内部，不涉及其他扩展、不修改 Pi 核心、不引入新依赖。Constraints C-1~C-5 划定了明确边界。

### 1.3 验收标准可量化 ✅

AC-1~AC-8 全部使用 Given/When/Then 格式，包含具体数值（60 分钟、5 个、200K chars、8 个 toolResult）。每个 AC 可以直接转化为 vitest 测试用例。

### 1.4 [待决议] 项 ✅

无 `[待决议]` 标记。

### 1.5 Spec 内部一致性 ⚠️

见 Issue #3（LOW）— C-6 说 FrozenFreshState "通过 pi.appendEntry 持久化"，但 FR-2 说 "session_start 时重建"。两个描述矛盾。Plan 选择了 FR-2 的解释（不持久化），逻辑正确（session 重启后 toolResult 重新评估，FrozenFreshState 重建为空是合理的），但 spec 应统一措辞。

---

## 2. Plan 可行性

### 2.1 任务拆分合理性 ✅

6 个 Task 拆分粒度适中：
- Task 1（Microcompact）：新增函数 + config，独立可完成
- Task 2（Budget + Frozen/Fresh）：新增模块 + 函数 + config，依赖 Task 1 的 McConfig 格式
- Task 3（Compact Boundary）：新增函数，修改 compressContext
- Task 4（L1 修复 + L2 boundary）：修改已有函数签名
- Task 5（Recall 扩展 + L0 keepRecent）：修改已有函数 + 类型
- Task 6（配置 + 命令 + 集成）：胶水层

每个 Task 可由一个 subagent 在单次执行中完成。

### 2.2 依赖关系正确性 ✅

```
Task 1 ──┬──→ Task 2 ──┬──→ Task 6
         ├──→ Task 3 ──┤
         │     Task 4 ──┘ (depends on Task 3)
         └──→ Task 5 (depends on Task 2)
```

依赖关系符合代码实际情况：
- Task 2 依赖 Task 1：BudgetConfig 在 McConfig 之后定义，compressor.ts 已有 Task 1 的 processMicrocompact 调用
- Task 3 依赖 Task 1：findCompactBoundary 需要在已有 processMicrocompact 之后插入
- Task 4 依赖 Task 3：processL1 需要接收 Task 3 产出的 compactBoundaryIdx
- Task 5 依赖 Task 2：recall-store 的 StoredContent level 扩展与 Task 2 的 budget-persisted 关联
- Task 6 依赖全部：集成所有变更

### 2.3 工作量估算 ✅

现有代码 1668 行。新增 ~280 行实现代码（frozen-fresh.ts ~50, compressor.ts 新增 ~150, config/commands/index ~80）+ ~300 行测试 ≈ ~580 行。Spec 估算的 ~500 行接近实际。

### 2.4 遗漏 Task 检查

对照 spec 逐条：
- FR-1 → Task 1 ✅
- FR-2 → Task 2 ✅
- FR-3 → Task 3 ✅
- FR-4 → Task 5 ✅
- FR-5 → 无需改动（v1 已实现）✅
- FR-6 → 无需改动 ✅
- FR-7 → Task 4 ✅
- FR-8 → Task 5 ✅
- FR-9 → Task 4 ✅
- FR-10 → 无需改动 ✅
- FR-11 → Task 6 ✅
- FR-12 → Task 6 ✅

无遗漏。

### 2.5 File List 完整性 ❌

见 Issue #1、#2（MUST FIX）。

---

## 3. Spec 与 Plan 一致性

### 3.1 AC 覆盖矩阵

| AC | Plan Task | 覆盖状态 |
|----|-----------|---------|
| AC-1 | Task 1 | ✅ 完整 |
| AC-2 | Task 2 | ✅ 完整 |
| AC-3 | Task 2 | ✅ 完整 |
| AC-4 | Task 3 | ✅ 完整 |
| AC-5 | Task 4 | ✅ 完整 |
| AC-6 | Task 2 | ✅ 间接（Frozen/Fresh 保证 cache 稳定性） |
| AC-7 | Task 3 | ✅ 完整 |
| AC-8 | Task 6 | ✅ 完整 |

### 3.2 Plan 无 spec 未提及的额外工作 ✅

所有 Task 都可追溯到 spec FR 或 AC。

### 3.3 验收标准映射 ✅

每个 AC 都能在 Task 的测试要求中找到对应场景。

---

## 4. Execution Groups 合理性

### 4.1 分组合理性 ✅

BG1 包含 6 个 Task、8 个文件。文件数 ≤ 10。Task 数 > 4 但因全部共享 compressor.ts 必须串行，强行拆组无实际收益。

### 4.2 类型划分 ✅

全部为后端 Task（TypeScript 扩展），无混合类型。

### 4.3 功能关联度 ✅

所有 Task 都在同一个压缩管道中，修改同一个 compressor.ts 和 config.ts，功能强关联。

### 4.4 依赖关系 ✅

串行执行，被依赖的排在前面。Wave Schedule 正确反映了依赖关系。

### 4.5 Wave 编排 ✅

由于共享文件冲突，所有 Wave 实际串行。Plan 正确标注了这一点。

### 4.6 Subagent 配置完整性 ✅

每组包含 Agent、Model、注入上下文、读取文件、修改/创建文件。Task 描述包含函数签名、逻辑步骤、测试场景。

### 4.7 上下文充分性 ✅

每个 Task 的实现要点包含：要修改的函数、新增的接口、具体逻辑步骤、默认值。足以让 subagent 独立完成。

### 4.8 文件数预估 ✅

8 个文件（3 create + 5 modify），与实际文件结构一致。

---

## 5. Interface Contracts 审查

### 5.1 方法签名完整性 ✅

`processMicrocompact`、`processBudget`、`findCompactBoundary`、`FrozenFreshState` 的方法签名、参数类型、返回值、Edge Cases 均有定义。

### 5.2 AC 覆盖矩阵 ✅

所有 8 个 AC 在矩阵中有对应行，追溯到了具体的 Interface Method 和 Data Flow。

### 5.3 CompressionStats 定义不完整

McStats 和 BudgetStats 定义了，但 CompressionStats 的更新后完整定义未在 Interface Contracts 中体现（Task 1 新增 mcTriggered/mcCleared，Task 2 新增 budgetPersisted）。影响不大（实现者可从上下文推断），但不够严谨。

---

## 6. 后端设计充分性（L1）

### 6.1 "为什么" 说明 ✅

每个 Task 的实现要点既说了"做什么"也解释了"为什么"（如 L1 protected turn 修复：防止 agent 反复读取同一文件）。

### 6.2 存储变更 ✅

无持久化存储变更，仅内存中的 Map/Set。符合 C-3（不持久化原始内容）。

### 6.3 边界条件 ✅

- 无 assistant 消息时不触发 Microcompact
- 无 compactionSummary 时返回 null
- 所有 toolResult 均 frozen 时不处理
- protectRecentTurns 为 0 时视为禁用

### 6.4 非功能性要求 ✅

`non-functional-design.md` 覆盖了稳定性（try-catch 容错）、性能（纯字符串处理 < 45ms）、数据安全（软应用、不修改 session entries）。

### 6.5 潜在风险 ⚠️

见 Issue #4（LOW）— Compact Boundary 检测依赖 Pi 内部消息格式，三种方案尚未验证。

---

## 7. 辅助交付物审查

### 7.1 e2e-test-plan.md ✅

6 个场景覆盖全部 8 个 AC。测试环境说明明确（vitest，不用 node:test）。场景前置条件具体，步骤可执行。

### 7.2 use-cases.md ✅

6 个 UC 覆盖全部 AC。每个 UC 包含 Main Flow、Alternative Paths、Exception Paths、Postconditions。覆盖映射表完整。

### 7.3 non-functional-design.md ✅

覆盖稳定性、数据一致性、性能、业务安全、数据安全。与 spec Constraints C-1~C-5 一致。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 4 → Files | Task 4 实现要点明确要求 "L1Config 新增 `protectRecentTurns: number` 字段，默认值 2"，但 Files 列表只有 `compressor.ts` 和测试文件，**缺少 `config.ts`**。当前 L1Config（config.ts:20-26）没有 `protectRecentTurns` 字段。Subagent 执行 Task 4 时不会修改 config.ts，导致 L1Config 接口不完整，编译失败。 | Task 4 Files 增加 `- Modify: context-engineering/src/config.ts` |
| 2 | MUST FIX | plan.md:Task 5 → Files | Task 5 实现要点明确要求 "L0Config 新增 `keepRecent: number` 字段，默认值 5"，但 Files 列表只有 `recall-store.ts`、`compressor.ts` 和测试文件，**缺少 `config.ts`**。当前 L0Config（config.ts:6-12）没有 `keepRecent` 字段。Subagent 执行 Task 5 时不会修改 config.ts，导致 L0Config 接口不完整。 | Task 5 Files 增加 `- Modify: context-engineering/src/config.ts` |
| 3 | LOW | spec.md:C-6 vs FR-2 | C-6 说 FrozenFreshState "通过 `pi.appendEntry` 持久化到 session manager"，FR-2 说 "状态存储：扩展闭包变量（`session_start` 时重建）"。两者矛盾。Plan 选择了 FR-2 的解释（不持久化），这在逻辑上正确：session 重启后所有 toolResult 重新评估，frozen 状态无意义。但 spec 应统一，避免实现者困惑。 | 将 C-6 的 "通过 `pi.appendEntry` 持久化到 session manager" 改为 "状态存储在扩展闭包变量中，session_start 时重建"。或明确区分哪些状态需要 appendEntry、哪些不需要。 |
| 4 | LOW | plan.md:Task 3 → 实现要点 | Compact Boundary 检测方式列了 3 种方案（A/B/C），但未选定。plan 说 "建议先用方案 A，dev phase 验证后调整"。这意味着 Task 3 的实现可能需要返工（如果方案 A 不对）。建议在 plan 中显式标记为**风险项**，并说明如果方案 A 失败的回退策略。 | 在 Task 3 实现要点开头加 `⚠️ 风险项：compact boundary 检测依赖 Pi 内部消息格式，需 dev phase 初期验证。` 如果方案 A 失败，回退到检查消息 role + content 结构的方式。 |
| 5 | LOW | plan.md:Task 2 + Task 6 | Task 1 明确写了 "compressContext：在 L0 之前调用 processMicrocompact"，但 Task 2 没有类似的 "compressContext：在 processMicrocompact 之后调用 processBudget" 描述。同时，Task 6 说 "context handler 中串联新管道" 但 context handler 在 index.ts 中，而管道逻辑在 compressContext（compressor.ts）中。两者的编排位置有歧义。 | Task 2 实现要点增加：`compressContext：在 processMicrocompact 之后、L0 之前调用 processBudget`。Task 6 的 "串联新管道" 改为 "更新 compressContext 调用，传入 frozenFreshState" 或明确说明管道逻辑保留在 compressContext 中。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 架构合规性补充审查

### 与 CLAUDE.md 约束的合规性

| 约束 | 合规 | 说明 |
|------|------|------|
| 扩展在 Pi 进程内执行，非独立进程 | ✅ | 无 child_process 使用 |
| 模块级变量需 session_start 重建 | ✅ | frozenFreshState 在 session_start 重建 |
| 不依赖 fs 之外的 Node 原生模块 | ✅ | 仅用现有 crypto（recall-store） |
| Tool 参数用 typebox 定义 | ✅ | recall_context 已有，无需新增 |
| execute 返回 content + details | ✅ | 无新 tool，recall_context 保持现有格式 |
| 单文件 ≤ 1000 行 | ✅ | compressor.ts 当前 547 行，新增 ~150 行后 ~700 行 |
| 函数 ≤ 80 行 | ⚠️ | processBudget 逻辑较复杂，需注意拆分 |
| 禁止 any | ✅ | Interface Contracts 使用具体类型 |

### 与现有代码的兼容性

- `compressContext` 签名需扩展（增加 frozenFreshState 参数），调用方 index.ts 需同步更新
- `CompressionStats` 新增字段，`addStats` 和 `zeroStats` 需同步更新（Task 6 已覆盖）
- `parseLevelArgs` 需扩展支持 "mc" 和 "budget" target（Task 6 已覆盖）
- 现有测试不会被破坏（新函数独立，已有函数签名变更需兼容）

---

## 结论

**需修改后重审**。2 条 MUST FIX 均为 Task Files 列表遗漏 config.ts，修复简单（每个 Task 加一行）。3 条 LOW 为 spec 一致性、风险标注、管道编排描述的改进建议。

### Summary

计划评审完成，第1轮，2条MUST FIX（Task 4/5 Files 缺少 config.ts），需修复后重审。
