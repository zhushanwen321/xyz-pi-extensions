---
review:
  type: plan_review
  round: 2
  timestamp: "2026-06-03T17:30:00"
  target: ".xyz-harness/2026-06-03-workflow-vs-claude-code-analysis/plan.md"
  verdict: pass
  summary: "计划评审完成，第2轮，0条MUST FIX，3条历史MUST FIX全部已修复，评审通过"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 3
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 Step 1"
    title: "computePeakRecommend 是系统级函数，per-candidate 调用会错误跳过非 peak plan 候选"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 1 Step 1"
    title: "返回格式使用 pcfg.plan 而非 providerKey，plan≠provider 时产出错误 model 字符串"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Task 1 Step 1"
    title: "缺少 FR-3 step 5 要求的候选排序逻辑（非 peak 优先 → priority 高优先）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: LOW
    location: "plan.md:File Structure 表"
    title: "File Structure 表缺少 model-resolver.ts（create），BG2 subagent 配置中有但表漏列"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: LOW
    location: "plan.md:Task 1 Step 1"
    title: "computeQuotaSnapshot 应在循环外调用一次，而非 per-candidate 重复调用"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: INFO
    location: "plan.md:Task 1/3"
    title: "tests/ 目录当前不存在，subagent 需创建目录"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-06-03 17:30
- 评审类型：计划评审（增量审查模式）
- 评审对象：`.xyz-harness/2026-06-03-workflow-vs-claude-code-analysis/plan.md` + `spec.md`
- 评审轮次：第 2 轮（验证第 1 轮 3 条 MUST FIX 修复情况）

## MUST FIX 修复验证

### [FIXED] #1: computePeakRecommend per-candidate 调用问题

**原问题**：plan v1 对每个候选调用 `computePeakRecommend()`，导致 peak 时段所有候选（包括非 peak plan 的候选）都被跳过，AC-2 失败。

**修复验证**：plan v2 Task 1 Step 1 已重构算法：
- 行 5：明确"调一次 computePeakRecommend(now, config, snapshot) 得到系统级 peak 状态"
- 行 7：`isPeakAvoid` 判断改为"仅当候选的 `pcfg.plan` 等于 `findPeakPlan(config)` 返回的 planName 且 `peakRecommend.result === 'avoid'` 时为 true"
- 关键设计决策明确声明"computePeakRecommend 只调用一次（在循环外），避免 per-candidate 重复调用"
- spec FR-3 第 3 条也同步更新了描述："调一次 computeQuotaSnapshot(cache, config) 得全局快照，再调一次 computePeakRecommend() 得系统级 peak 状态"

**结论**：✅ 已修复。算法正确——peak 时段只会跳过 plan 匹配 peakPlan 的候选（zhipu），不匹配的（opencode-go）不受影响。

### [FIXED] #2: 返回格式 pcfg.plan vs providerKey

**原问题**：plan v1 返回 `pcfg.plan/modelId`，当 plan ≠ providerKey 时产出 Pi 无法识别的模型字符串。

**修复验证**：plan v2 已全面修正：
- Task 1 Step 1 行 9：明确"返回排序后首个候选的 `providerKey/modelId`"
- 关键设计决策第 3 条："返回 providerKey/modelId（如 `zhipu/glm-5.1`），不是 plan/modelId。providerKey 是 config.models 的 key（遍历时的外层 key）"
- 候选收集逻辑（行 7）："对 config.models 的每个 [providerKey, pcfg]，检查 pcfg.models[alias] 是否存在 → 找到后记录 providerKey"
- spec FR-3 第 6 条：改为"返回排序后首个候选的 providerKey/modelId（如 `zhipu/glm-5.1`，这是 Pi --model flag 的正确格式）"
- Interface Contracts 表 Returns 列：`"provider/modelId" 或 undefined`

**结论**：✅ 已修复。返回值使用 `providerKey`（config.models 的外层 key），与 Pi `--model` flag 格式一致。

### [FIXED] #3: 缺少候选排序

**原问题**：plan v1 按 scenes 列表顺序遍历、跳过 avoid、返回第一个，缺少 spec FR-3 step 5 要求的排序（非 peak 优先 → priority 高优先）。

**修复验证**：plan v2 已实现排序：
- Task 1 Step 1 行 8："按 spec FR-3 排序：isPeakAvoid === false 优先 → priority 数值小的优先（priority 1 > priority 2）"
- 候选数据结构包含 `{ alias, providerKey, modelId, plan, priority, isPeakAvoid }`，支持排序所需的所有字段
- spec FR-3 第 5 条也同步更新："过滤掉 avoid 候选，剩余按 priority 排序（priority 数值小的优先）"
- 测试用例 TC-1-06 覆盖了排序场景："scenes 列表顺序与 priority 不一致（如 ["ds-flash", "glm-5.1"]）+ 非 peak → 仍返回 zhipu/glm-5.1（priority 排序后取首个）"

**结论**：✅ 已修复。排序逻辑与 spec 一致，且通过测试用例验证。

## LOW/INFO 修复验证

### [FIXED] #4: File Structure 表漏列 model-resolver.ts

File Structure 表已添加 `extensions/workflow/src/model-resolver.ts | create | BG2 | 从 orchestrator 提取的模型解析纯函数`。✅

### [FIXED] #5: computeQuotaSnapshot 循环外调用

plan v2 Task 1 Step 1 行 4："调一次 computeQuotaSnapshot(cache, config) 得到全局快照"，明确在循环外调用。✅

### #6: tests/ 目录不存在（INFO）

无需操作，write 工具会自动创建父目录。维持 open 状态。

## spec 与 plan 一致性复核

逐条对照修复后的 spec FR-3 与 plan Task 1 Step 1：

| Spec FR-3 步骤 | Plan 实现 | 状态 |
|----------------|----------|------|
| 1. loadConfig() | 行 1：调 loadConfig() | ✅ |
| 2. config.scenes[scene] 获取候选列表 | 行 2：查 config.scenes[scene] | ✅ |
| 3. computeQuotaSnapshot + computePeakRecommend 各调一次 | 行 4-5：各调一次 | ✅ |
| 4. 判断 isPeakAvoid：候选 plan 匹配 peakPlan + avoid | 行 7：明确匹配逻辑 | ✅ |
| 5. 过滤 avoid，按 priority 排序 | 行 8：isPeakAvoid=false 优先 → priority 升序 | ✅ |
| 6. 返回 providerKey/modelId | 行 9：providerKey/modelId | ✅ |
| 7. 全部 avoid → undefined | 行 10：info 日志并返回 undefined | ✅ |

## 结论

通过。3 条 MUST FIX 全部已修复，plan 与 spec 一致，可进入执行阶段。

### Summary

计划评审完成，第2轮通过，0条MUST FIX。
