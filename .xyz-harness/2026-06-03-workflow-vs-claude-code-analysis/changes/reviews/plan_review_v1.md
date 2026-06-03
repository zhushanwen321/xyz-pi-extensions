---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-03T16:45:00"
  target: ".xyz-harness/2026-06-03-workflow-vs-claude-code-analysis/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，3条MUST FIX，plan 的核心算法设计有误需重审"

statistics:
  total_issues: 6
  must_fix: 3
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 Step 1（行 ~8-9）"
    title: "computePeakRecommend 是系统级函数，per-candidate 调用会错误跳过非 peak plan 候选"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 1 Step 1（行 ~8）"
    title: "返回格式使用 pcfg.plan 而非 providerKey，plan≠provider 时产出错误 model 字符串"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Task 1 Step 1"
    title: "缺少 FR-3 step 5 要求的候选排序逻辑（非 peak 优先 → priority 高优先）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:File Structure 表"
    title: "File Structure 表缺少 model-resolver.ts（create），BG2 subagent 配置中有但表漏列"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:Task 1 Step 1"
    title: "computeQuotaSnapshot 应在循环外调用一次，而非 per-candidate 重复调用"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "plan.md:Task 1/3"
    title: "tests/ 目录当前不存在，subagent 需创建目录"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-03 16:45
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-06-03-workflow-vs-claude-code-analysis/plan.md` + 辅助文档

## 1. spec 完整性

**结论：通过。**

- **目标明确**：一段话即可概括——让 workflow 脚本通过 `agent({ scene: "coding" })` 声明场景，由 model-switch advisor 自动推荐最优模型。
- **范围合理**：聚焦在 agent() → orchestrator → model-switch 这条链路上，不涉及 budget、callCache、worker 线程模型的改动。边界清晰（constraints 章节列出了 5 项"不做什么"）。
- **验收标准可量化**：6 个 AC 全部可通过检查 Pi 子进程的 `--model` 参数值来验证，无模糊描述。
- **待决议项**：无。
- **辅助文档完备**：use-cases.md 细化了两个 UC 的 alternative paths；non-functional-design.md 覆盖了稳定性、性能；e2e-test-plan.md 提供了 5 个端到端场景。

## 2. plan 可行性

**结论：Task 拆分合理，但核心算法实现设计有误（见 MUST_FIX #1）。**

- **任务拆分**：3 个 Task 粒度适中，每个 Task 可由一个 subagent 独立完成。
- **依赖关系**：Task 3 depends on Task 1 + Task 2，正确。
- **工作量估算**：~80 行新增代码，3 个 Task，合理。
- **遗漏检查**：所有 spec FR（FR-1 到 FR-5）和 AC（AC-1 到 AC-6）在 Spec Coverage Matrix 中都有对应 Task。
- **关键问题**：Task 1 中 `resolveModelForScene()` 的核心算法设计有误，详见 MUST FIX #1。

## 3. spec 与 plan 一致性

**结论：FR-3 的实现方案与 spec 描述不一致（见 MUST_FIX #1、#3）。**

逐条对照：

| Spec 需求 | Plan 覆盖 | 状态 |
|-----------|----------|------|
| FR-1 agent() 新增 scene | Task 2 | ✅ |
| FR-2 Orchestrator 模型解析 | Task 3 | ✅ |
| FR-3 resolveModelForScene | Task 1 | ❌ 见 MUST_FIX #1, #2, #3 |
| FR-4 workflow 依赖声明 | Task 3 | ✅ |
| FR-5 错误处理 | Task 1 + Task 3 | ✅ |
| AC-1 到 AC-6 | 全部映射 | ✅ |

**FR-3 不一致细节**：

1. Spec FR-3 step 5 要求"按别名排序：非 peak plan 优先 → priority 高的优先"，plan 未实现排序。
2. Spec FR-3 step 6 要求"返回 provider/modelId"，plan 返回 `pcfg.plan/modelId`（语义不同）。
3. Plan 的 per-candidate `computePeakRecommend` 调用模式与该函数的实际行为不匹配。

## 4. Execution Groups 合理性

**结论：通过。**

- **分组**：BG1（3 文件，1 Task）、BG2（6 文件，2 Task），均在限制内。
- **类型划分**：全部后端 Task，无混合类型。
- **功能关联度**：BG2 内 Task 2（类型扩展）和 Task 3（集成）紧密关联。
- **依赖关系**：BG2 depends on BG1，正确。
- **Wave 编排**：Wave 1（BG1）→ Wave 2（BG2），串行无冲突。
- **Subagent 配置**：每组包含 Agent、Model、注入上下文、读取/修改文件列表。上下文具体，不含糊引用。
- **文件数预估**：标注与 Task 文件变更表一致（BG2 File Structure 表缺 `model-resolver.ts`，见 LOW #4）。

## 5. 接口契约审查

**结论：AC 覆盖矩阵完整，接口签名清晰。**

- **Spec Coverage Matrix**：6 个 AC + 5 个 FR + FR-5 子项全部有对应 Task 行。
- **接口签名**：
  - `resolveModelForScene(scene: string) => string | undefined` — 签名清晰，但实现逻辑需修正（MUST_FIX #1, #3）。
  - `resolveModel(opts: AgentCallOpts) => string | undefined` — 签名和实现逻辑正确。
  - `AgentCallOpts` 扩展 `scene?: string` — 类型正确，位置合理。
- **data_flows**：无 data_flows 章节（L1 plan），不适用。

## 6. 后端设计充分性（L1）

**结论：基本充分，但核心算法存在设计错误。**

- **"为什么"解释**：Task 3 Step 2 的 `resolveModel()` 解释了优先级逻辑（显式 model > scene > 默认），合理。
- **存储变更**：无存储变更，不适用。
- **API 设计**：函数接口清晰，与业务场景对应。
- **边界条件**：error handling 覆盖了 5 种异常场景（config null、scene 不存在、all avoid、异常抛出），符合 spec FR-5。
- **非功能性**：plan 通过 FR-5 覆盖了 non-functional-design.md 中的稳定性要求（降级不阻断）。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md: Task 1 Step 1 | **computePeakRecommend 是系统级函数，per-candidate 调用导致错误跳过非 peak plan 候选**。当前 `computePeakRecommend()` 内部通过 `findPeakPlan(config)` 找到唯一的 peak plan（zhipu），检查其 peak 时段和 quota。该函数不接收 plan 参数，对任何候选调用都返回相同结果。plan 的算法"对每个候选调用 computePeakRecommend，avoid 则跳过"会导致：peak 时段时，**所有候选都被跳过**（包括没有 peak 限制的 opencode-go），直接违反 AC-2（AC-2 期望 opencode-go/ds-flash 在 zhipu peak 时段仍被选中）。 | 修改 `resolveModelForScene()` 算法：1) 调一次 `computePeakRecommend` 得到系统级 peak 状态；2) 遍历候选时，仅当候选的 plan 匹配 peak plan 且 peak result 为 "avoid" 时才跳过；3) 非 peak plan 的候选不受影响。或者为 advisor 新增 `isPeakAvoid(planName, config, snapshot): boolean` 函数，只检查指定 plan 的 peak 状态。 |
| 2 | MUST FIX | plan.md: Task 1 Step 1 行 8 | **返回格式使用 `pcfg.plan` 而非 provider key**。Plan 明确写"返回 `pcfg.plan/modelEntry.modelId`（字符串拼接为 `"plan/modelId"`）"。但 `--model` flag 接受的格式是 `providerAlias/modelId`（如 `zhipu/glm-5.1`），其中 providerAlias 是 `config.models` 的 key。当前配置中 `plan == provider key`（zhipu → plan: "zhipu"），所以碰巧正确。但如果用户配置了 `config.models["my-custom-provider"].plan = "shared-plan"`，函数会返回 `shared-plan/modelId`，Pi 的 `--model` 无法识别。 | 返回 `providerKey/modelEntry.modelId`，其中 `providerKey` 是遍历 `config.models` 时的外层 key（`for (const [providerKey, pcfg] of Object.entries(config.models))`）。这是 Pi `--model` flag 的正确格式。 |
| 3 | MUST FIX | plan.md: Task 1 Step 1 | **缺少 FR-3 step 5 要求的候选排序**。Spec 明确要求"按别名排序：非 peak plan 优先 → priority 高的优先"，然后返回排序后的首个。Plan 的实现直接按 scenes 列表顺序遍历、跳过 avoid、返回第一个。这意味着当 scenes 列表顺序与 priority 不一致时（如 `["ds-flash", "glm-5.1"]`，而 zhipu priority=1 更高），返回结果与 spec 预期不同。 | 两种修法（二选一）：(a) 实现 spec 的排序：收集所有非 avoid 候选及其 provider 的 priority → 按 [非 peak 优先, priority 降序] 排序 → 返回首个。(b) 更新 spec 明确声明"scenes 列表顺序即优先级顺序，不做额外排序"，然后 plan 的当前实现是正确的。无论选哪种，plan 和 spec 必须一致。 |
| 4 | LOW | plan.md: File Structure 表 | File Structure 表列了 `extensions/workflow/src/orchestrator.ts`（modify），但 Task 3 Step 5 推荐提取 `model-resolver.ts`，BG2 subagent 配置中也列了 `extensions/workflow/src/model-resolver.ts`（create），而 File Structure 表漏列该文件。 | 在 File Structure 表中添加 `extensions/workflow/src/model-resolver.ts | create | BG2 | 从 orchestrator 提取的模型解析纯函数`。 |
| 5 | LOW | plan.md: Task 1 Step 1 | `computeQuotaSnapshot(cache, config)` 计算所有 plan 的快照，应只需调用一次。Plan 的伪代码暗示在 per-candidate 循环内调用，造成不必要的重复计算（虽然结果相同）。 | 将 `readCache()` 和 `computeQuotaSnapshot()` 调用提到循环之前，`computePeakRecommend()` 同理（如果保留当前函数则也只需一次）。 |
| 6 | INFO | plan.md: Task 1 & Task 3 | `extensions/model-switch/tests/` 和 `extensions/workflow/tests/` 目录当前不存在。Subagent 需要先创建目录再写入测试文件。Plan 未显式提及。 | subagent 执行时 `write` 工具会自动创建父目录，无需额外步骤。确认执行环境支持即可。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。
> - **LOW**：建议修复，但不阻塞。
> - **INFO**：观察记录，无需操作。

#### MUST FIX #1 详细分析

`computePeakRecommend` 的源码（`advisor.ts:101-160`）：

```typescript
export function computePeakRecommend(
  now: Date,
  config: ModelPolicy,
  snapshot: QuotaSnapshot,
): RecommendInfo {
  const peakPlan = findPeakPlan(config);      // ← 找到唯一的 peak plan
  if (!peakPlan) return { result: "ok" };      // ← 无 peak plan → 全部 ok
  // ... 只检查这一个 peak plan 的时段和 quota
}
```

关键：`findPeakPlan` 返回配置中唯一的 peak plan（当前是 zhipu）。函数不区分"我在检查哪个候选"，统一返回 peak plan 的状态。

**Plan 预期行为 vs 实际行为：**

| 场景 | Plan 预期 | 实际行为 |
|------|----------|---------|
| peak 时段，候选在 zhipu plan | 跳过 ✓ | computePeakRecommend → "avoid" → 跳过 ✓ |
| peak 时段，候选在 opencode-go plan | 不跳过 ✓ | computePeakRecommend → "avoid" → **跳过 ✗** |
| 非 peak，任何候选 | 不跳过 ✓ | computePeakRecommend → "ok" → 不跳过 ✓ |

AC-2 明确期望 peak 时段返回 `opencode-go/ds-flash`。按 plan 当前算法，peak 时段所有候选被跳过，返回 undefined，**AC-2 失败**。

### 结论

需修改后重审。3 条 MUST FIX 均集中在 Task 1 的 `resolveModelForScene()` 核心算法设计上。建议修改后提交 v2。

### Summary

计划评审完成，第1轮需重审，3条MUST FIX。
