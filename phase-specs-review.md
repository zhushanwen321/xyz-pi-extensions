# Phase-Specs 交叉审查报告

审查范围：`docs/phase-specs/` 下 4 个文件（phase-1-spec / phase-2-plan / phase-3-dev / phase-4-test）

---

## 🔴 冲突/矛盾

### 1. Phase 1 Goal 触发方式与其他 Phase 不一致

**位置**：
- Phase 1 (`phase-1-spec.md:36`)：`触发方式：用户手动 /goal`
- Phase 2 (`phase-2-plan.md:36`)：`触发方式：phase-start 自动注入（initializeGoalFromExternal() API）`
- Phase 3 (`phase-3-dev.md:31`)：`触发方式：phase-start 自动注入（initializeGoalFromExternal() API）`
- Phase 4：**完全没有提到 Goal**

**矛盾**：Phase 1 要求用户手动触发，而 Phase 2/3 通过 `initializeGoalFromExternal()` API 自动注入。Phase 4 完全没有 Goal 配置章节。

**问题**：
1. Phase 1 为什么不能也用 `initializeGoalFromExternal()` 自动注入？如果是因为 brainstorming 阶段不知道具体要写什么文档，那 Phase 2 的"先默认 L1 后追加 L2"策略同样适用于 Phase 1（先注入默认 3 个任务）。
2. Phase 4 没有 Goal 意味着整个 Test-Fix Loop 过程无法追踪进度。主 agent 在 Test-Fix Loop 期间无法向用户报告"当前到哪一步了"。

### 2. Phase-Gate 模式描述在 P1/P2 vs P3 之间矛盾

**位置**：
- Phase 1 (`phase-1-spec.md:67`)：`模式 | 2 步：脚本检查 + 防伪造检查`，步骤 2 明确写 `AI Agent 防伪造检查：验证内容非空、非占位`
- Phase 2 (`phase-2-plan.md:193`)：同 Phase 1，`2 步：脚本检查 + 防伪造检查`
- Phase 3 (`phase-3-dev.md:169`)：`与 Phase 1/2 的差异：Phase 1/2 只有脚本检查。Phase 3 额外增加防伪造检查。`

**矛盾**：Phase 1/2 的 Phase-Gate 表格明明写了"步骤 2: AI Agent 防伪造检查"，但 Phase 3 声称"Phase 1/2 只有脚本检查"。如果 P1/P2 有防伪造检查，那 P3 的差异描述是错误的；如果 P1/P2 没有防伪造检查，那 P1/P2 的表格是错误的。

### 3. Phase 2 Review-Gate L2 说"串行"但原始 playbook 说"并行"

**位置**：Phase 2 (`phase-2-plan.md:174`)：
> L2 Agent | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md`（**串行**审查）

但在 Review-Gate 内部结构中写：
> 两个 reviewer 串行执行（避免同时修改文件冲突）

**问题**：两个 reviewer 串行执行是合理的（避免文件冲突），但标签 `串行审查` 与之前的 playbook 分析中 L2 的"并行 2 subagent"说法矛盾。虽然当前 spec 的串行策略更合理，但这里应该明确说明**为什么改为串行**，而不是默默改变。

### 4. Phase 4 缺少 Phase 过渡章节

**位置**：Phase 1 有 `Phase 过渡` 章节，Phase 2 有 `Phase 过渡` 章节，Phase 3 没有 `Phase 过渡` 但流程末尾提到了 `coding-workflow-gate(phase=3)`，Phase 4 完全没有 `Phase 过渡` 章节。

**问题**：
- Phase 4 结束后如何过渡到 Phase 5（PR）？没有明确说明。
- Phase 3 结束后如何过渡到 Phase 4？也没有明确的 Phase 过渡章节。
- Phase 1 的过渡章节写 `coding-workflow-phase-start(phase=2)`，但 Phase 2 的过渡章节写 `coding-workflow-phase-start(phase=3)`，而 Phase 3/4 没有。

---

## 🟡 遗漏/模糊

### 5. Phase 3 阶段一失败后 Goal 重新初始化的时机不明确

**位置**：Phase 3 (`phase-3-dev.md:112-117`)：
```
FAIL → 退出 workflow → 主 agent 重新启动 goal → 检查缺失能力
     → 重新拆分 Wave → 编码 → 测试验证 → commit → 重新提交 review-gate
1. 重新启动 goal（initializeGoalFromExternal() 或重置现有 goal 状态）
```

**问题**："重新启动 goal" 是重新创建一个新的 goal 还是在现有 goal 上重置任务状态？如果是重新创建，之前的 progress 会丢失。如果是重置，API 是什么？`initializeGoalFromExternal()` 的行为在 goal 已存在时没有定义。

### 6. Phase 4 Test-Fix Loop 中"跳过理由充分性"由谁判定？

**位置**：Phase 4 (`phase-4-test.md:188-199`)：
```
4. [Workflow 节点] 汇总
   - 所有 skipped 的理由是否充分？
```

但"跳过理由充分性判定"表格（`phase-4-test.md:213-219`）定义了 5 种情况，其中 ⚠️ 需审查和 ❌ 不充分需要主观判断。

**问题**：这个判定是由 Workflow 节点的代码逻辑做，还是由 AI Agent 做？如果是 Workflow 代码，无法做主观判断；如果是 AI Agent，没有指定是哪个 agent。`test-execute-coordinator.md` 的职责描述是"汇总判断"，但没有说它有 AI 判断能力。

### 7. Phase 4 缺少 Retrospect 的触发条件

**位置**：Phase 4 完整流程（`phase-4-test.md:46`）：
```
9. [Subagent] Retrospect（fork session）
```

但 Phase-Gate 的"失败处理"（`phase-4-test.md:292`）：
```
修复后直接重新提交 phase-gate（不回到测试 workflow loop）
```

**问题**：如果 phase-gate 失败并打回主 agent，主 agent 修复后重新提交 phase-gate，此时 Retrospect 是在 phase-gate 通过后自动触发还是需要主 agent 手动触发？文档没有说清楚 Retrospect 的触发点。

### 8. Review-Gate 中 Agent 的"直接修复"边界不清

**位置**：
- Phase 1 (`phase-1-spec.md:48`)：`agent 审查 + 直接修复 → must_fix=0 退出`
- Phase 2 (`phase-2-plan.md:178`)：同上

**问题**："直接修复"是什么意思？Agent 修改 spec.md / plan.md 文件？如果 Agent 修改了这些文件，主 agent 的上下文中还是旧版本，可能导致后续操作基于过时的文件内容。修改后是否需要通知主 agent？

### 9. Phase 2 L1 任务列表数量不匹配

**位置**：Phase 2 (`phase-2-plan.md:45-49`)：
> L1 任务列表（默认注入）：
> 1. Write plan.md (with Execution Groups)
> 2. Write e2e-test-plan.md + test_cases_template.json
> 3. Write use-cases.md + non-functional-design.md

**问题**：任务列表写"3 个任务"但产出物清单说是"5 个文件"。Task 2 包含 2 个文件，Task 3 包含 2 个文件。如果 plan.md 通过了但 e2e-test-plan.json 格式有问题，Goal 是标记 Task 2 整体失败还是只标记其中一个文件？

而且前面说"5 个任务"但实际只有 3 行。数量不一致。

### 10. Phase 4 缺少 Goal 配置章节

**位置**：Phase 4 没有 Goal 配置章节。

**问题**：Phase 4 的 Test-Fix Loop 是一个复杂的多步骤流程（启动服务→核心测试→非核心测试→手动清单→phase-gate→retrospect）。主 agent 如何向用户报告进度？虽然 Loop 内部有 test-execute JSON 追踪，但用户在 goal 追踪工具中看不到进度。

### 11. Phase 3 Integration Reviewer 输入源描述有歧义

**位置**：Phase 3 (`phase-3-dev.md:178`)：
> 阶段一的 spec-plan-conformance-reviewer 报告中包含「模拟数据路径」字段

但阶段一 reviewer（`spec-plan-conformance-reviewer.md`）是新建的 Agent，文档中没有定义它的输出格式包含"模拟数据路径"字段。这个字段的格式、命名、内容都没有定义。

### 12. Phase 4 manual 类型测试用例没有 type 字段

**位置**：Phase 2 (`phase-2-plan.md:97-103`) 的 test_cases_template.json 示例中：
```json
{
  "id": "TC-M01",
  "type": "manual",
  "phase": 4,
  "verification_method": "manual"
}
```

**问题**：`type: manual` 在 Phase 4 的测试类型表中不存在。Phase 4 的测试类型表只有 API 集成测试、模块协作测试、E2E（API）、E2E（UI）四种。manual 类型的 case 在 Phase 4 中如何处理？文档说"输出不可测试项手动验证清单给用户"，但 Test-Fix Loop 的结构中完全没有处理 `type: manual` case 的逻辑。

---

## 🟢 建议

### 13. 统一产出物命名格式

- Phase 3 review 报告用下划线：`spec_plan_conformance_v{N}.md`
- Phase 4 测试记录用连字符：`test-execute-v{N}-core.json`

建议统一为一种分隔符。推荐连字符（与目录名 `xyz-harness-*` 一致），或全部用下划线。

### 14. Phase 3 Fix Worker 和 Phase 4 Fix Worker 的职责差异应显式标注

- Phase 3 Fix Worker：汇总 5 个 reviewer + 判断退出 + 修复代码（一个节点三种职责）
- Phase 4 Fix Worker：只分析失败 + 修复代码 + 更新状态（不做汇总判断）

两个都叫 "Fix Worker" 但职责范围不同。建议在 Phase 3 中改为"Review-Sync-Fix Worker"或类似名称，或显式标注差异。

### 15. Phase 3 阶段一 vs 阶段二的"循环"语义不同但都用同一术语

- 阶段一：单次，不循环（只执行一次审查）
- 阶段二：循环（审查→修复→重新审查）

但 Review-Gate 整体被描述为"一个 Workflow，内含两阶段"，而标题只说"最多 3 轮"——这 3 轮是阶段二的循环，不是阶段一的。建议在 Review-Gate 章节标题或描述中更明确地区分。

### 16. Phase 2 test_cases_template.json 示例中 TC-E01 出现两次

**位置**：Phase 4 (`phase-4-test.md:137-163`) 的 test-execute-v{N}.json 示例中，`TC-E01` 出现了两次（一次 status=failed，一次 status=fixed）。这意味着同一 ID 的 case 在同一 version 的 JSON 中有两个 entry。

**问题**：这不太对。如果是同一 version，一个 case 应该只有一个 entry（最新状态）。如果需要历史，用 `history` 字段。Phase 4 的结构设计已经包含了 `history` 数组来追踪多轮状态，但示例中却同时用了两种方式（顶层 entry + history），容易造成实现歧义。

### 17. 缺少 Phase 5 的 spec

4 个 phase spec 覆盖了 Phase 1-4，但没有 Phase 5（PR）。Phase 5 的描述散落在其他文档中（playbook 写了"P5: 纯汇总，无 review-gate"），但没有独立的 phase-specs 文件。虽然 Phase 5 较简单，但"收集证据→生成 PR→推送→phase-gate→Overall Retrospect"的流程仍需要规范定义。

---

## 总结

| 严重度 | 数量 | 关键问题 |
|--------|------|---------|
| 🔴 冲突/矛盾 | 4 | Goal 触发方式不一致；Phase-Gate 描述自相矛盾；L2 串行/并行未解释变更；Phase 3/4 缺少 Phase 过渡 |
| 🟡 遗漏/模糊 | 8 | Goal 重新初始化未定义；跳过理由判定主体不明；Agent"直接修复"边界不清；manual 类型测试无处理逻辑 |
| 🟢 建议 | 5 | 命名格式统一；Fix Worker 命名区分；Phase 5 spec 缺失 |
