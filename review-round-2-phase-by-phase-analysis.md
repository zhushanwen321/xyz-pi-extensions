# Review Loop 适合度分析：coding-workflow 5 个阶段

## 汇总表

| 阶段 | 产出物 | 当前 QA 机制 | 循环 Review 适合度 | 核心收益 | 实现复杂度 |
|------|--------|-------------|-------------------|---------|-----------|
| Phase 1: Spec | spec.md | 主 agent 自审 + gate 脚本检查 | **高** | 需求遗漏/歧义尽早发现，避免下游浪费 | 低 |
| Phase 2: Plan | plan.md + e2e-test-plan.md | 主 agent 自审 + gate 脚本检查 | **高** | plan 缺陷导致 dev 返工，循环成本最低 | 低 |
| Phase 3: Dev | 代码变更 | expert-reviewer skill（主 agent 自读自审）+ gate 反欺诈 | **最高** | 代码 bug/架构问题的循环修复，收益最大 | 中 |
| Phase 4: Test | 测试代码 + 测试结果 | expert-reviewer skill + gate 反欺诈 | **中** | 测试覆盖度和质量有价值，但复杂度低于 dev | 低 |
| Phase 5: PR | 证据收集 | 无 review | **不适合** | 纯汇总阶段，无代码/文档变更 | — |

## 核心概念：当前机制的"伪循环"

### 现状：gate retry ≠ review loop

`tool-handlers.ts` 中的 `maxGateRetries=10` 是 gate **脚本**的 retry（类型检查、lint 通过），不是 content review loop：

```
gate 脚本 (tsc/eslint) → fail → 主 agent 修 → 再跑 gate 脚本 → ...
```

Gate 通过后，`dispatchReviewSubagent()` 做一次 **反欺诈审查**（gate-reviewer），验证产出物不是伪造的。这不是 content quality review。

Content quality review（expert-reviewer skill）是主 agent **自己读自己的产出**然后自审——没有独立 subagent，没有循环。

### 引入循环 review 的核心改变

```
phase 完成 → gate 脚本通过 → content review subagent → 发现 MUST_FIX → 主 agent 修复 → 重新 gate + review → ...
                                                                                        ↑ 直到 MUST_FIX = 0
```

---

## 逐阶段详细分析

### Phase 1: Spec（brainstorming）

**当前 QA**：
- SKILL.md 要求主 agent 写完 spec 后自查（完整性清单、AC 格式、FR/NFR 覆盖）
- gate 检查：spec.md 文件存在、格式合规
- 无独立 reviewer，无循环

**产出物特征**：
- 单文件 spec.md，~200-800 行
- 错误类型：需求遗漏、歧义表述、缺失 AC、NFR 未覆盖
- 出错概率：**高**（最容易出现理解偏差的阶段）

**循环 Review 收益：高**
- spec 是整个工作流的基石，缺陷传递到 plan/dev 阶段的修复成本指数级增长
- 独立 reviewer 检查"需求完整性"比主 agent 自审更客观
- spec 是纯文档，review → fix → re-review 循环代价极低（改文本，不涉及编译/测试）

**实现方式**：
- 改动点：`review-dispatcher.ts` 增加 `dispatchContentReview()` 方法
- Reviewer 角色：`xyz-harness-expert-reviewer` 的 `plan_review` 模式（已有 plan 评审逻辑，spec 是 plan 的输入）
- 触发点：gate 脚本通过后、反欺诈审查之前
- 终止条件：review 产出 `must_fix: 0` 或达到最大 3 轮
- 循环流程：
  1. `dispatchContentReview()` 用 `runSingleAgent()` 启动独立 subagent
  2. subagent 读 spec.md，按 expert-reviewer 的 plan_review 模式审查
  3. 解析 review 产出的 YAML frontmatter 中 `must_fix` 数值
  4. `must_fix > 0` → 将 review 内容注入主 agent 上下文，要求修复 → 修复后重新 gate + review
  5. `must_fix = 0` → 通过，继续反欺诈审查

### Phase 2: Plan（writing-plans）

**当前 QA**：
- SKILL.md 要求主 agent 自查（任务完整性、AC 覆盖矩阵、类型一致性）
- gate 检查：plan.md 存在、格式合规
- 无独立 reviewer，无循环

**产出物特征**：
- plan.md + e2e-test-plan.md + test-cases 模板，~300-1200 行
- 错误类型：任务遗漏、接口定义不一致、AC 覆盖缺口、依赖关系错误
- 出错概率：**高**（复杂系统的分治本身就有盲区）

**循环 Review 收益：高**
- plan 中的接口定义不一致会直接导致 dev 阶段的返工
- AC 覆盖矩阵的缺口会导致测试阶段补测
- 同样是纯文档，循环代价低

**实现方式**：
- 与 Phase 1 共用 `dispatchContentReview()`，传入不同 phaseConfig
- Reviewer：`xyz-harness-expert-reviewer` 的 `plan_review` 模式（已经设计为同时审 spec + plan）
- 终止条件：同 Phase 1

### Phase 3: Dev（phase-dev）

**当前 QA**：
- expert-reviewer skill 的 `code_review` 模式——**但这是主 agent 自己读 review skill 然后自审**
- 5 维度审查：BLR（功能正确性）、standards（规范）、robustness（健壮性）、integration（集成）、taste（品味）
- gate 反欺诈审查
- 无循环

**产出物特征**：
- 代码变更（多文件，可能 10+ 个文件）
- 错误类型：逻辑 bug、边界条件、类型错误、架构违规、测试遗漏
- 出错概率：**最高**（代码是最容易出错的产出物）

**循环 Review 收益：最高**
- dev 是整个工作流中产出最复杂、出错率最高的阶段
- 5 维度 review 由独立 subagent 做，客观性和覆盖度远超主 agent 自审
- review 发现的 MUST_FIX 通常是真实的 bug 或架构问题，修复后再 review 有明确价值
- **这是循环 review 的核心战场**

**实现方式**：
- `review-dispatcher.ts` 增加 `dispatchContentReview()` 方法，支持 `code_review` 模式
- 需要特殊处理：review subagent 需要 `git diff` 作为输入（不只是文件内容）
- Reviewer：`xyz-harness-expert-reviewer` 的 `code_review` 模式
- 终止条件：`must_fix = 0` 或最大 3 轮
- 注意事项：
  - 增量 review：第 2+ 轮 review 应只审查变更部分（expert-reviewer 已支持增量模式）
  - 每轮 review 前需要重新跑 gate 脚本（确保修复没有引入新问题）

### Phase 4: Test（phase-test）

**当前 QA**：
- expert-reviewer skill 的 `test_review` 模式（同样是主 agent 自审）
- gate 反欺诈审查
- 无循环

**产出物特征**：
- 测试代码 + 测试执行结果
- 错误类型：覆盖不足、断言太弱、测试间依赖、mock 不当
- 出错概率：**中**

**循环 Review 收益：中**
- 测试质量 review 有价值，但：
  - dev 阶段的 review loop 已经捕获了大部分代码问题
  - 测试代码的复杂度通常低于业务代码
  - 测试结果（pass/fail）本身就是客观的质量信号
- 适合做单轮 review（非循环），确认覆盖度足够即可

**实现方式**：
- 复用 `dispatchContentReview()`，传入 `test_review` 模式
- 建议：先实现 Phase 1-3 的循环，Phase 4 观察效果后再决定是否加循环
- 如果做循环：终止条件同上

### Phase 5: PR（phase-pr）

**当前 QA**：无 review（纯汇总阶段）

**产出物**：
- 从各阶段收集证据，生成 PR 描述
- 无代码/文档变更

**循环 Review 收益：不适合**
- PR 阶段不产生新代码，只是汇总
- 如果前面阶段的 review loop 运作正常，PR 阶段不需要额外 review

---

## 实现路线图

### 第一步：基础设施（review-dispatcher.ts 扩展）

在 `review-dispatcher.ts` 中新增：

```typescript
// 新增接口
interface ContentReviewConfig {
  mode: "plan_review" | "code_review" | "test_review";
  maxRounds: number; // 默认 3
}

// 新增函数
async function dispatchContentReview(
  phaseConfig: PhaseConfigForReview,
  topicDir: string,
  skillResolver: SkillResolver,
  mode: ContentReviewConfig["mode"],
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
  processRegistry?: ChildProcess[],
): Promise<ReviewDispatchResult>
```

### 第二步：集成到 gate 流程（tool-handlers.ts）

修改 `executeGateTool()`：
1. gate 脚本通过后 → dispatch content review（而非直接跳到反欺诈）
2. 解析 review 结果的 `must_fix` 数值
3. `must_fix > 0` → 将 MUST_FIX 列表注入返回内容，主 agent 修复后重新调用 gate
4. `must_fix = 0` → 通过，继续反欺诈审查

### 第三步：SKILL.md 指导更新

在 phase-dev / brainstorming / writing-plans 的 SKILL.md 中：
- 移除主 agent 自审的指导（由 subagent review 替代）
- 增加"收到 MUST_FIX 后如何修复"的指导

---

## 关键设计决策

### 为什么不用 worktree

项目已在 bare+worktree 模式下运行，coding-workflow 本身就在独立 worktree 中。循环 review 的本质是 **内容质量** 的迭代验证，不需要额外的文件系统隔离。

### 为什么 expert-reviewer 作为 subagent 而非主 agent 自审

当前 expert-reviewer 是主 agent 读 SKILL.md 后"假装"自己是 reviewer。问题是：
1. **confirmation bias**：主 agent 倾向于认为自己的产出没问题
2. **上下文污染**：reviewer 的判断受实现过程记忆影响
3. **无循环动力**：主 agent 没有动力反复检查直到零问题

独立 subagent（通过 `runSingleAgent()`）拿到的是干净上下文，只看产出物本身。

### 循环终止条件

- 硬性：`must_fix = 0`（reviewer 认为无必须修复的问题）
- 硬性：最大 3 轮（防止无限循环）
- 软性：连续 2 轮 `must_fix` 数值不降反升（说明 review-fix 循环在恶化，需要人工介入）
