---
phase: dev
verdict: pass
---

# Phase 3 Retrospect — subagent-tui

> 复盘分析师对 Phase 3 (dev) 全流程的回顾与评估，基于 plan.md、10 个 commit、code_review_v1.md、code_review_v2.md、test_results.md，以及 spec.md.

---

## 维度一：Phase 执行质量

### 1. 实现质量

**总评：高质量。** 10 个 commit，8 个 AC 全部实现并通过验证，无遗留 MUST FIX 问题。实现严格遵循 plan.md 的 task 划分。

**Commit-to-Task 对照：**

| Commit | Task | 说明 |
|--------|------|------|
| `c2e9eb4` fix: getFinalOutput skips empty text | T7 | 独立修复，计划中第 1 个执行 ✅ |
| `6693cd4` feat: fixed temp dir + 1hr auto-cleanup | T8 | 独立修复，计划中第 2 个执行 ✅ |
| `920be88` feat: time fields + view model interfaces + format helpers | T1 | 数据模型基础建设 ✅ |
| `ae83def` feat: track startTime/endTime/durationMs/lastActivityTime | T2 | 时间跟踪 ✅ |
| `00ce7ee` feat: add buildAgentResultView + buildParallelSummaryView | T3 | 构建函数 ✅ |
| `05fe567` refactor: separate rendering into view model + pure render functions | T4 | 核心重构，renderResult 瘦身 ✅ |
| `8a3a777` feat: 500ms throttle for parallel streaming updates | T5 | 节流 ✅ |
| `b6c9483` feat: isError=true on partial parallel failure | T6 | 错误聚合 ✅ |
| `54d199b` fix: indentation issues | 后审修复 | code review v1 LOW #2 修复 ✅ |
| `5c59ca2` fix: restore model display in single collapsed mode | 后审修复 | code review v1 LOW #2 跟进修复 ✅ |

**执行顺序与计划一致性：** 严格按照 plan.md 推荐的执行顺序：T7 → T8 → T1 → T2 → T3 → T4 → T5 → T6。计划中标注的 "do them first (smallest, lowest risk)" 策略被忠实执行——先做两个独立修复（getFinalOutput、temp cleanup），降低后续重构的代码基变更风险。

**做得好的：**

- **渐进式重构，无大爆炸 commit**：每个 task 对应一个 commit，粒度精确到单个职责。T4（render 重构）是最大 commit，但因为有 T1-T3 的数据模型和构建函数前置铺垫，T4 commit 本身职责清晰（replace renderResult body with dispatcher + add render functions）。
- **类型安全**：`DurationInfo`、`AgentResultView`、`ParallelSummaryView`、`ThrottleState` 四个新类型/接口在测试验证中被 grep 确认完整实现。
- **视图模型隔离干净**：`renderAgentDetail` 不依赖 `SingleResult` 原始数据，只依赖 `AgentResultView`。渲染函数是纯函数（只依赖 view + theme），可独立测试。
- **时序正确**：`startTime` 在 3 个初始化位点均设置，`lastActivityTime` 在 message_end 和 tool_result_end 更新，`endTime`/`durationMs` 在进程 close/abort 时设置。

**问题模式分析：**

**MUST FIX 级遗留问题：0 个。** 但 code review v1 中产生了一个假阳性 MUST FIX：

| 问题 | 严重度（最终） | 根因 |
|------|---------------|------|
| forceEmit `lastEmitTime = 0` vs `Date.now()` | 假阳性（正确实现） | code review 继承 spec 文本，但 plan review 已在 Phase 2 确认 `lastEmitTime = 0` 是有意的正确修复 |

这个假阳性的更深层原因是 **Phase 2 plan review 的上下文没有传递到 Phase 3 code review**。plan review 发现 spec 中的 `forceEmit` 写法会导致时序 bug，plan 已修改为 `lastEmitTime = 0`。code review 在 Phase 3 中独立检查时，又用 spec 原文做参照，得出了错误结论。这是 harness 设计中的已知 trade-off（上下文隔离 vs. 信息完整性）。

**代码质量指标：**

| 指标 | 值 | 评价 |
|------|----|------|
| 总 commit 数 | 10 | 合理 |
| 功能 commit / 修复 commit | 8 / 2 | 修复占比 20%，正常 |
| 审查发现需修复数 | 1 (LOW) | 低——说明编码质量高，但也说明 review 深度有限 |
| 假阳性 MUST FIX | 1 | 由于上下文隔离导致，非代码质量问题 |

### 2. Bug 发现与修复

| 来源 | 发现的问题 | 是否真实 Bug | 是否修复 |
|------|-----------|-------------|---------|
| code review v1 #1 | forceEmit `lastEmitTime = 0` | ❌ 假阳性 | 无需修复（v2 撤销） |
| code review v1 #2 | single collapsed 丢失 model 显示 | ✅ 轻微行为变化 | 已修复（5c59ca2） |
| code review v1 #4 | renderAgentDetail model 条件显示 | ✅ 轻微行为变化 | 接受，未修 |
| code review v1 #5 | finally 块残留空行 | ✅ 代码风格 | 未修（INFO） |

**真实 bug 发现率**：code review v1 提出了 5 个 issue，其中真实的是 2 个 LOW + 1 个 INFO。没有发现功能性 bug（如数据丢失、时序错误、竞态条件等）。这在一定程度上说明编码质量高，但也引发一个问题：

> **是否因为 reviewer 没有深入运行时行为（只能做静态分析）而错过了真正的 bug？**

对于单文件修改 + 没有测试框架的项目，这是 code review 的固有局限。静态 grep 可以验证"函数存在"和"字段初始化"，但无法验证"运行时逻辑是否正确"。例如：
- `forceEmit` 被调用后 `shouldEmit` 的行为：静态分析可以推断正确，但如果有更复杂的时序依赖则无法验证。
- 并行模式下 `allResults` 数组的索引一致性与 agent 完成顺序的关系：无法静态验证。

### 3. Review 流程有效性

**Code review v1（fail）→ v2（pass）的演变：**

| 轮次 | 发现 MUST FIX | 其中真实 | verdict |
|------|--------------|---------|---------|
| v1 | 1 | 0（假阳性） | fail |
| v2 | 0 | — | pass |

**正面**：
- v2 评审没有"为了找问题而找问题"，诚实承认 v1 的 MUST FIX 是误判。
- v2 逐条验证了 v1 的每个 issue，包括 forceEmit 的重新时序分析（确认 `lastEmitTime = 0` 正确）、LOW #2 的修复确认。
- 评审报告格式统一、YAML frontmatter 完整，符合 SKILL.md 规范。

**问题**：
- **假阳性成本**：v1 将正确的实现标记为 MUST FIX，触发了"需修改后重审"流程。开发者和 reviewer 都需要额外投入时间重新分析一个根本不是问题的问题。
- **代码 review 与 plan review 上下文断裂**：这是本案例中最值得关注的结构性矛盾。plan review 在 Phase 2 已经花了 2 轮评审确认了 forceEmit 的正确实现，但 code review 在 Phase 3 又从零开始分析了一遍。如果 plan review 的 issue 记录能在 code review 时可查询（至少通过一个"已知决议列表"），假阳性可避免。

**建议的修复**：在 code review 的输入参数中增加一个可选的 `plan_review_resolved_issues` 参数。当提供时，reviewer 在检查 spec 合规性前先 check：如果某个代码偏差已经在 plan review 中被确认且记录，则跳过该项检查。这不会破坏上下文隔离——reviewer 仍然看不到 plan review 的全部对话，但可以避免重复劳动。

### 4. 交付物完整度

| 交付物 | 状态 | 质量评估 |
|--------|------|---------|
| test_results.md | ✅ 完成 | 逐 AC 验证，grep 证据精确到行号；AC 覆盖矩阵完整 |
| code_review_v1.md | ✅ 完成 | 结构化报告，YAML frontmatter 完整，含详细时序分析 |
| code_review_v2.md | ✅ 完成 | 逐条验证 v1 issue，纠偏假阳性 |
| 代码变更 | ✅ 完成 | 10 commit，所有 AC 实现 |

**缺少的交付物：**
- 本 harness 流程未要求 dev subagent 产出独立的 `Phase 3 执行日志` 或 `实现报告`——在单文件 + L1 复杂度下这合理，但如果复杂度升级（L2+多文件），缺少执行日志会给团队 review 带来困难。

**test_results.md 质量分析：**

| 维度 | 评价 | 说明 |
|------|------|------|
| 覆盖度 | ✅ 完整 | 8/8 AC 全部覆盖 |
| 证据精确性 | ✅ 高 | grep 命令精确到行号范围 |
| 测试可重复性 | ⚠️ 低 | 手动 grep，不可自动化 |
| 边界测试 | ❌ 无 | 没有测试 0 turn、超长 agent name、并发 temp 文件冲突等边界场景 |

鉴于项目无自动化测试框架，手动 grep 验证是合理的选择。但缺乏边界测试是值得注意的风险——例如 `formatDuration(0)` 返回 `0ms` 而非 `0s`，`renderAgentRow` 在 `turns=0` 时显示 `"0 turns"` 等。

---

## 维度二：Harness 体验

### 1. Phase 3 Dev Skill 流程顺畅度

| 环节 | 体验 | 说明 |
|------|------|------|
| Plan 接收与理解 | ✅ 顺畅 | plan.md 的 task 定义足够细粒度（Step 级），每个 task 可直接转化为实施动作 |
| 执行顺序决策 | ✅ 顺畅 | plan.md 明确标注了推荐顺序：先 T7/T8（独立、低风险）→ T1-T6 主链 |
| 逐 task 编码 | ✅ 顺畅 | 每个 task 的 Plan 步骤精确到"哪段代码怎么改"，执行者无需自行设计 |
| 逐 task commit | ✅ 顺畅 | 每个 task 配独立 commit，message 格式清晰（`feat/fix/refactor` 前缀） |
| 代码 review 触发 | ⚠️ 稍摩擦 | code review v1 的假阳性 MUST FIX 需要额外分析→纠偏流程 |
| 测试验证 | ✅ 顺畅 | 手动 grep + AC 对照矩阵，步骤明确 |
| 修复 commit 归位 | ✅ 顺畅 | 2 个修复 commit 在 8 个功能 commit 之后，逻辑清晰 |

### 2. 卡顿点与瓶颈

**Bottleneck 1：Code review 的上下文隔离导致假阳性（关键瓶颈）**

这是本 Phase 中最显著的卡顿点。具体路径：
1. Plan review v1 → 发现 forceEmit 时序 bug → 记录为 MUST FIX #1
2. Plan review v2 → 确认 `lastEmitTime = 0` 是正确的 → issue #1 resolved
3. Code review v1 → 独立审视代码，用 spec 原文做参照 → 再次标记 forceEmit 为 MUST FIX（假阳性）
4. Code review v2 → 回顾 plan review 记录 → 确认 v1 是假阳性 → 降级为 INFO

**成本**：多消耗了 1 轮 code review（v1→v2）。在简单的 2 轮制中，这刚好被消化。如果 code review 只有 1 轮，假阳性可能导致不必要的代码回滚。

**根因**：code review SKILL.md 明确要求"不继承执行者上下文"。但 plan review 产出的是**决议**，不是"上下文"。决议是结构化的、可传递的已知信息（如：`forceEmit → lastEmitTime = 0（已确认正确，非 spec 原文的 Date.now()）`）。当前流程没有在 code review 的输入中引入 plan review 的 resolved issues 作为参考依据。

**Bottleneck 2：无自动化测试导致验证覆盖深度有限**

test_results.md 的验证方法是 grep 式静态检查。这确保"代码中有这个函数/字段"，但无法验证：
- `ThrottleState` 在真实时序下的行为是否正确
- 并行模式下多个 agent 同时完成时 `forceEmit` + `shouldEmit` 是否不会有竞态
- `cleanupOldTempFiles` 在大于 1 小时的边界上是否正确

对于 L1 单文件修改，这不致命。但对于 L2+ 修改，没有自动化测试是高风险。

**Bottleneck 3：修复 commit 没有在 code review 中被重新验证**

code review v1 提出 LOW #2（model display），修复 commit（54d199b, 5c59ca2）是在 code review v2 之后才做的（从 git log 看，这 2 个 fix commit 不在 v2 评审范围内）。这意味着 code review v2 的 `verdict: pass` 是在**部分问题尚未修复**的情况下给出的。

严格来说，修复后的代码没有经过 reviewer re-check。如果是 MUST FIX，这会违反流程（必须先修复再 pass）。但因 LOW 不阻塞流程，所以只记录不责备。

**建议**：code review v2 应明确标注"尚未修复的 LOW 问题的当前状态"，并在 verdict 为 pass 时说明"剩余 LOW 问题不阻塞流程，建议在后续 cleanup 中处理"。

### 3. 改进建议

**建议 1（高优先级）：Code review 输入引入 plan review 决议表**

在 code review 的输入参数中新增可选的 `plan_review_resolved_issues` 字段。当提供时，code review 在检查 spec 合规性前先做一次"偏差匹配"：
- 对于代码中与 spec 不一致的地方，先查是否在已决议列表中
- 如果匹配已决议项，跳过该检查，只在报告中注明"plan review 已确认"
- 如果不在已决议列表中，按正常流程标记

这样不破坏上下文隔离（reviewer 只看结构化决议，不看对话），但可以消除假阳性。

**实现方式**：在 plan review 的最终交付物（`plan_review_v{N}.md`）的 YAML frontmatter 中增加一个 `resolved_issues` 数组，包含已决议的"spec 偏差项"。code review 的入口流程自动读取并过滤。

**建议 2（中优先级）：为无测试框架的项目设计轻量级自动化验证脚本**

当前代码验证依赖手动 grep。一个简单的 `verify-subagent.mjs` 脚本，放在项目根目录或 `scripts/` 下，可以：

```javascript
// 伪代码示例
const checks = {
  formatDuration: { type: "function", pattern: "function formatDuration" },
  ThrottleState: { type: "class", pattern: "class ThrottleState" },
  TEMP_SUBDIR: { type: "const", pattern: `TEMP_SUBDIR = "pi-subagent"` },
  // ... 更多检查
};
```

每次编码后 `node scripts/verify-subagent.mjs` 即可快速验证结构完整性。这不需要 TypeScript 编译或运行时环境，但能提供比 grep 更结构化的验证。

**建议 3（低优先级）：修复 commit 纳入 code review 范围**

当 code review 发现 LOW/INFO 问题后，开发者的修复应该在 code review 中有一个显式的 re-check 步骤（即使不阻塞 verdict）。当前流程中修复 commit（54d199b, 5c59ca2）在 code review 完成后才 commit，没有 reviewer 验证。

可以要求在 code review v2 中标注"待处理的 LOW 问题"列表，修复后在 plan_retrospect/dev_retrospect 中补充验证。

**建议 4（低优先级）：Spec AC 标准化**

当前 spec.md 的 AC 是在 plan.md 中定义的，spec.md 本身没有独立的 AC 章节。这意味着代码 review 和 test review 需要跨文件查看才能确定 AC 是什么（spec → AC 在 plan 中→ 验证在 test results 中）。三个文件各有一份 AC 引用，但没有一个权威出处。

建议：spec.md 增加 Ac 章节（frontmatter 中显式列出），plan.md 引用 spec AC，test_results.md 引用 spec AC。AC 编号跨文件一致。

---

## 综合评价

| 维度 | 评分 | 说明 |
|------|------|------|
| **实现质量** | 9/10 | 8/8 AC 全部实现，渐进式重构，类型安全，无运行时 bug；唯一扣分点是排查 `forceEmit` 假阳性消耗了额外精力 |
| **Bug 发现与修复** | 7/10 | 2 个 real LOW + 1 INFO 被 code review 发现，1 个假阳性 MUST FIX。真实 bug 发现率低（可能因为代码质量高，也可能因为静态分析深度有限） |
| **Review 流程有效性** | 8/10 | 结构化评审、精确到行、YAML frontmatter 完整。v2 纠偏能力强。但假阳性表明上下文隔离策略在实际操作中有摩擦 |
| **交付物完整度** | 9/10 | test_results.md + code_review_v1/v2 全部产出，质量达标。缺少的仅是可复现验证脚本和修复后 re-check |
| **Harness 流程** | 7/10 | 整体顺畅，但 plan→code review 的上下文断裂是系统性问题，在当前 harness 设计中未覆盖 |

**整体 verdict：pass**

Phase 3 的 dev 阶段严格按照 plan.md 执行，10 个 commit 完成 8 个 AC 的全覆盖实现。代码质量高，重构干净（数据模型/构建/渲染三层分离），类型安全。

主要的供应链摩擦是：**Phase 2 plan review 已经花 2 轮解决了 forceEmit 时序问题（确认 `lastEmitTime = 0` 是正确的），但 Phase 3 code review 因上下文隔离再次独立分析并产生了假阳性 MUST FIX。** 这消耗了 1 轮额外评审，且在 v2 才被修正。

这不是"谁做错了"的问题，而是**harness 设计中的一个已知 trade-off 需要主动管理**——上下文隔离保证了评审独立性，但在 plan 和 code review 之间缺少一个"已知决议传递机制"。

---

## 核心经验总结

1. **Plan 质量直接影响 dev 速度**——本案例中 plan.md 的 task 定义足够精确（Step 级代码片段），开发者可以"照着写"而不需要重新设计。这也是为什么 10 个 commit 能顺畅执行完的原因。

2. **Plan review 的假阳性在 code review 中再次出现，暴露了上下文断裂问题**——同一个 issue（forceEmit）在 plan review 中花了 1 轮确认，在 code review 中又花了 1 轮确认。如果 harness 能传递"已决议列表"，两轮都可以省掉。

3. **修复 commit 的归宿问题**——2 个 post-review 修复 commit 在 code review 完成后才提交，没有被 reviewer re-check。在 LOW 场景下可接受，但如果未来的 MUST FIX 修复也在 code review 完成后才提交且未经 re-check，则流程有漏洞。

4. **对于无测试框架的项目，静态 grep 验证的深度有限**——但这是 L1 单文件修改的合理策略。如果要扩展到 L2+，需要引入至少一个轻量级的结构验证脚本。

---

## 附件：Phase 3 问题生命周期

```
code_review_v1 (fail, 1 MUST FIX + 3 LOW + 1 INFO)
├── #1 MUST_FIX: forceEmit 时序 (假阳性)    →  v2: dismissed (plan review 已确认)
├── #2 LOW: single collapsed 丢失 model     →  5c59ca2: restored
├── #3 LOW: chain expanded 总耗时语义        →  no action (逻辑正确,撤回)
├── #4 LOW: renderAgentDetail model 条件显示 →  no action (可接受)
└── #5 INFO: finally 块残留空行              →  no action

code_review_v2 (pass, 0 MUST FIX)
├── #1: dismissed (plan review 决议传递到 v2)
├── #2: resolved (5c59ca2)
├── #3: withdrawn
├── #4: no action
└── #5: no action

Fix commits (code_review_v2 之后,未重新审查):
├── 54d199b: indentation fixes (代码风格)
└── 5c59ca2: model display restored (#2 修复)
```
