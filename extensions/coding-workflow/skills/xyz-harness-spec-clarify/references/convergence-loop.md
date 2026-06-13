# Round 2+: 收敛循环

收敛循环在「模型构建 → 场景追踪 → gap 发现 → gap 解决」之间循环，直到追踪不再产生新 gap。

```
Step 4: Build/Update Model    → 结构化模型
Step 5: 5-Perspective Tracing → 5 视角枚举所有场景 + 分支
Step 6: Gap Discovery         → 从追踪卡住点提取 gap（见 gap-management.md）
Step 7: Gap Resolution        → F→扫描代码, K→问用户, D→讨论方案
Step 8: Convergence Check     → 无新 gap → 进入 Step 9; 有 gap → 回 Step 4
```

## Step 4: Build/Update Model

创建/更新结构化模型文件 `clarification.md`。模型是 spec 的骨架，所有后续追踪基于此模型。

模型结构、五个维度、构建与更新规则详见 `clarification-model.md`。

## Step 5: 5-Perspective Scenario Tracing

[MANDATORY] 这是核心遗漏发现机制。每个视角强制枚举所有操作，沿路径追踪，在卡住的地方标记 gap。

**追踪规则：**
- 每条路径追踪到可以完整描述（不猜测）为止
- 追踪卡住 = 遇到你**不知道**的信息 = gap
- 每个分支（if/else、成功/失败、边界值）必须单独追踪
- 已在前面视角中追踪过的路径，如果新视角发现了新分支，仍需追踪
- **YAGNI：只追踪当前需求涉及的路径，不探索无关场景。** P2 gap 可以 defer，不阻塞收敛

五个视角的完整追踪模板、强制检查项、典型 gap 模式详见 `scenario-tracing.md`：

1. **User Journey** — 用户能做的所有操作
2. **Data Lifecycle** — 每个实体的完整生命周期（CRUD + 归档）
3. **API Contract** — 所有对外接口的输入/输出/错误/副作用契约
4. **State Machine** — 每个实体的所有合法状态和转换
5. **Failure Path** — 前四个视角中每个操作的失败模式

## Step 6: Gap Discovery & Classification

从 Step 5 的追踪中提取所有 `[GAP]` 标记，分类并记录到 Gap Tracker。

Gap 分类（F/K/D）、优先级（P0/P1/P2）、Tracker 格式、卡住信号、密度指标详见 `gap-management.md`。

## Step 7: Gap Resolution

按优先级从高到低解决 gap。

F/K/D 三类的解决方式、用户回答后的处理流程详见 `gap-management.md` 的「Gap 解决」章节。

## Step 8: Convergence Check

[MANDATORY] **收敛条件（全部满足）：**

1. 5 个视角的场景追踪全部完成（每个视角至少覆盖了所有核心操作）
2. Gap Tracker 中无 `status: open` 的 P0/P1 gap
3. 最近一轮没有发现新的 P0/P1 gap
4. 模型版本号 ≥ 2（至少经过一轮迭代）

**未收敛 → 回 Step 4**，更新模型后重新追踪。重新追踪时：
- 只追踪**本轮新增或修改**的路径
- 已追踪且无变化的路径跳过（记录"与前一轮一致"）

**Stagnation 保底：** 连续 3 轮 gap 数量不降（新发现的 ≥ 已解决的），强制收敛。未解决的 gap 标记为 `[UNRESOLVED]`，在 spec 中标注并交给 review 阶段处理。Stagnation 原因分析见 `gap-management.md`。

---

## Step 9: Spec Generation（退出）

从验证后的模型生成 `spec.md`。

**生成规则：**
1. 模型的 Entity 部分 → spec 的数据模型章节
2. 模型的 Operation 部分 → spec 的功能需求章节
3. 模型的 State Machine → spec 的行为约束章节
4. 模型的 Constraint → spec 的约束章节
5. 场景追踪的 Main Path → spec 的业务用例
6. Gap Tracker 的已解决 Decision → spec 的决策记录
7. Gap Tracker 的 UNRESOLVED → spec 中标记 `[AMBIGUOUS]`

**spec.md 必须包含 YAML frontmatter：**

```yaml
---
verdict: pass
clarification_rounds: {N}
clarification_model_version: {V}
total_gaps_found: {N}
gaps_resolved: {N}
---
```

生成后调用 `coding-workflow-gate(phase=1)`（gate 内部执行 gap-analysis/review-loop/retrospect，由 orchestrator 管理，本 skill 不关心 gate 内部实现）。
