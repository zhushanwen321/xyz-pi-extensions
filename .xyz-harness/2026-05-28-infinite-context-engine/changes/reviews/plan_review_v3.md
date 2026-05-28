---
verdict: pass
must_fix: 0
review:
  type: plan_review
  round: 3
  timestamp: "2026-05-29T04:30:00"
  target: ".xyz-harness/2026-05-28-infinite-context-engine"
  verdict: pass
  summary: "计划评审第3轮，v2的2条MUST FIX全部修复，无新MUST FIX。2条LOW遗留+2条LOW新发现，不阻塞实施"

statistics:
  total_issues: 6
  v2_must_fix: 2
  v2_must_fix_resolved: 2
  v2_low: 2
  v2_low_resolved: 1
  v2_low_carried: 1
  new_must_fix: 0
  new_low: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "v2 MF#1 — plan.md Task 2 Step 1/2, Task 4 Step 2; spec.md FR-1.5"
    title: "isCompressing 三处矛盾"
    status: resolved
    raised_in_round: 2
    resolved_in_round: 3

  - id: 2
    severity: MUST_FIX
    location: "v2 MF#2 — plan.md Task 3 Step 1 assembleMessages"
    title: "Budget truncation 保护层级未定义"
    status: resolved
    raised_in_round: 2
    resolved_in_round: 3

  - id: 3
    severity: LOW
    location: "plan.md BG2 Execution Flow → Task 6 (L269-270)"
    title: "Task 6 执行流仍缺 executor 子步骤（v2 LOW#3 未修复）"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan.md Interface Contracts Data Section"
    title: "CompactResult 和 ValidateError 类型被引用但字段未定义"
    status: open
    raised_in_round: 3
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "plan.md Task 2 Step 2 cancelPiCompaction, Task 4 Step 2 session_before_compact handler"
    title: "cancelPiCompaction 无条件返回 cancel:true，首棵树建成前 Pi 原生 compaction 也被取消"
    status: open
    raised_in_round: 3
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "plan.md Task 6 Step 5"
    title: "Entry GC 仅提及 ic-turn，未说明 ic-segment 条目的积累问题"
    status: open
    raised_in_round: 3
    resolved_in_round: null

---

# 计划评审 v3

## 评审记录
- **评审时间：** 2026-05-29 04:30
- **评审类型：** 计划评审（模式一）— 第 3 轮
- **评审对象：** `.xyz-harness/2026-05-28-infinite-context-engine/plan.md`
- **评审范围：** v2 的 2 条 MUST FIX 修复验证 + 全局新问题发现

---

## 1. V2 MUST FIX 修复验证

### MF#1: isCompressing 三处矛盾 ✅ RESOLVED

v2 指出 plan.md 三处关于 `isCompressing` 归属的矛盾：

| 出处 | v2 原文（矛盾方向） | v3 修改后 | 状态 |
|------|---------------------|----------|------|
| P1: Task 2 Step 1 | "添加 isCompressing 到扩展闭包" | "isCompressing 状态由 TreeCompactor 内部管理（私有属性），无需在 types.ts 中定义" | ✅ |
| P2: Task 2 Step 2 | "isCompressing 由 TreeCompactor 内部管理" | 不变，与 P1 一致 | ✅ |
| P3: Task 4 Step 2 | "声明闭包变量：…isCompressing" | "声明闭包变量：…needsCompression（isCompressing 由 TreeCompactor 内部管理，通过 treeCompactor.isCompressing() 查询）" | ✅ |

**验证要点：**

| 检查项 | 结果 |
|--------|------|
| 三处表述是否统一为 TreeCompactor 内部管理 | ✅ P1 明确"无需在 types.ts 中定义"，P2 保持一致，P3 注释说明查询方式 |
| 工厂闭包是否移除了 isCompressing 变量 | ✅ P3 仅声明 needsCompression，isCompressing 以括号注释说明归属 |
| Interface Contracts 是否有 isCompressing() 查询方法 | ✅ TreeCompactor 方法表有 `isCompressing() => boolean` |
| spec.md FR-1.5 是否同步更新 | ✅ 已更新为 "TreeCompactor 内部管理" |
| spec.md FR-2.2 执行流程 | ✅ L70-71: "检查 isCompressing 守卫→设置 isCompressing = true"，描述的是 triggerCompression 内部行为 |

**结论：** v2 MF#1 完全修复。所有权模型统一为 TreeCompactor 内部管理，plan + spec 表述一致。

---

### MF#2: Budget truncation 保护层级 ✅ RESOLVED

v2 指出 assembleMessages 的预算裁剪缺少保护层级定义，三个未定义问题：

| 问题 | v3 修改 |
|------|--------|
| Q1: retention window 是否受保护 | ✅ 保护层级 L1：保留窗口 → "永不可截断，无论如何都完整原文" |
| Q2: 所有树节点截光后仍超限 | ✅ 保护层级 L3：未压缩旧段按时间倒序截断；L4：极端降级策略 |
| Q3: 未压缩旧段的角色 | ✅ 保护层级 L3 明确为"树节点全部裁剪后仍超限时"的下一级截断候选 |

**完整保护层级验证：**

```
L1: 保留窗口（当前段 + 最近 2 段）→ 永不可截断，完整原文      ✅ 保护 AC-3.1/C-2
L2: 树节点摘要（BFS 展平）→ 按深度裁剪（先砍最深层最老节点）  ✅ 对应 spec FR-3.3 步骤 1-2
L3: 未压缩旧段 → L2 全部截完后启用，从最旧段开始截断         ✅ v2 新增，填补空白
L4: 极端降级 → retention window + Level 1 + recall 提示       ✅ 对应 spec FR-3.3 步骤 3
```

**与 spec FR-3.3 一致性检查：**

| spec FR-3.3 步骤 | plan 保护层级 | 匹配 |
|-----------------|-------------|------|
| 1. 先从最深层开始截断（保留 L1 全部，砍 L3 最老） | L2: 按深度裁剪 | ✅ |
| 2. 仍超限则砍 L2 最老 | L2: 继续深度裁剪 | ✅ |
| 3. 最坏情况：只保留 L1 全部 + recall 提示 | L4: 极端降级 | ✅ |
| spec 未提及但 AC-3.1 要求：retention window 完整 | L1: 永不可截断 | ✅ plan 超出 spec（正向） |

**结论：** v2 MF#2 完全修复。保护层级定义清晰，覆盖从正常到极端的完整场景链路，且与 spec FR-3.3 保持一致。

---

## 2. V2 LOW 问题状态

### LOW#3: Task 6 执行流缺 executor 子步骤 ⚠️ 未修复

v2 建议将 BG2 Task 6 执行流改为：

```
1. general-purpose (read xyz-harness-backend-dev) → TUI 渲染 + entry GC + 类型检查
2. general-purpose (read xyz-harness-expert-reviewer) → 全链路集成审查
```

当前 plan 仍为：

```
Task 6 (depends on Task 1-5):
    1. general-purpose (read xyz-harness-expert-reviewer) → 全链路集成审查 + entry GC
```

**影响评估：** Task 6 的 Task Details 有 6 个实现步骤（TUI renderCall/renderResult × 3、tsc 检查、entry GC、commit），但执行流仅标注"审查"。subagent 按执行流实施时会漏掉 TUI 渲染实现和类型检查。

**建议修复（可选，不阻塞通过）：** 执行流增加 executor 子步骤。实施者可参照 Task Details 自行补齐。

### LOW#4: Spec-Plan isCompressing 不一致 ✅ RESOLVED

spec.md FR-1.5 已更新为 TreeCompactor 内部管理。随 MF#1 修复一并解决。

---

## 3. 新发现问题

### New LOW#4: CompactResult / ValidateError 类型字段缺失

**位置：** plan.md Interface Contracts Data Section

**问题：** Task 2 Step 1 说"添加 `CompactTree`, `TreeNode`, `CompactResult`, `ValidateError` 类型"，Interface Contracts 的 Data Section 只定义了 `CompactTree` 和 `TreeNode` 的字段。`CompactResult` 和 `ValidateError` 被引用但未定义字段。

- `CompactResult` 被 `triggerCompression` 的 `onComplete` 回调和 `appendEntry("ic-compact-tree", result)` 使用
- `ValidateError` 被 `validateTreeOutput` 使用

**影响：** 中等。实施者需要自行推断字段结构。建议在 Interface Contracts 中补充：

```typescript
// CompactResult 可能字段（推断）
interface CompactResult {
  tree: CompactTree;
  compressionTime: number;  // ms
  retryCount: number;
}

// ValidateError 可能字段（推断）
interface ValidateError {
  type: "invalid_json" | "missing_seg_id" | "duplicate" | "cycle" | "empty_summary";
  detail: string;
}
```

### New LOW#5: cancelPiCompaction 无条件取消

**位置：** plan.md Task 2 Step 2 (`cancelPiCompaction`) + Task 4 Step 2 (`session_before_compact` handler)

**问题：** `cancelPiCompaction()` 无条件返回 `{ cancel: true }`。在首棵树建成之前（首次压缩尚未完成），Pi 的原生 compaction 也被取消。此时：

1. 扩展没有树可用于 context 组装（所有段都是"未压缩旧段"，完整原文）
2. Pi 原生 compaction 被取消 → 无人执行上下文缩减
3. 上下文持续增长直到首次压缩完成

**时序分析：**

```
session 开始 → turns 累积 → 70% 阈值触发首次压缩 → 异步 spawn（~30s）
                                    ↑
                          如果 Pi 在此之前尝试 compact，
                          扩展 cancel=true 但无替代方案
```

**实际风险评估：** 低。`shouldCompress` 在 70% 阈值触发，而 Pi 的原生 compaction 通常在更高阈值触发。正常情况下，扩展的首次压缩会在 Pi 需要原生 compact 之前完成。仅在首次压缩超时 + fallback 也失败时才成为问题。

**建议改进（可选）：** `cancelPiCompaction` 增加条件判断：

```typescript
cancelPiCompaction(): { cancel: boolean } {
  return { cancel: this.getTree() !== undefined };
}
```

### New LOW#6: Entry GC 仅覆盖 ic-turn

**位置：** plan.md Task 6 Step 5

**问题：** GC 策略仅提及"达到 1000 条 ic-turn entries 时 splice"，未说明 `ic-segment` 条目的处理。`ic-segment` 条目同样会随 session 增长而积累。

**实际影响：** 低。`ic-segment` 条目数量远少于 `ic-turn`（每段一条 vs 每 turn 一条），且段数据包含 filePath 等恢复必需字段。可在实施时根据实际积累速度决定是否增加 `ic-segment` GC。

---

## 4. 全局质量评估

### 4.1 计划质量评分

| 维度 | 评分 | 说明 |
|------|------|------|
| Spec 完整性 | ⭐ 优秀 | 29 条 AC 全部可量化可验证，覆盖矩阵完整 |
| 任务拆分 | ⭐ 优秀 | 6 Task 粒度适中，依赖图无环，波浪编排清晰 |
| 接口契约 | ⭐ 良好 | 14 方法 + 5 数据结构定义齐全，CompactResult/ValidateError 字段待补充 |
| 异常处理 | ⭐ 优秀 | 重试/降级/超时/校验/BFS 裁剪层级均覆盖 |
| 执行编排 | ⭐ 良好 | BG1/BG2 波浪编排合理，Task 6 执行流小瑕疵 |
| Plan-Spec 一致性 | ⭐ 优秀 | MF#1/MF#2 修复后完全一致 |

### 4.2 各轮修复趋势

| 轮次 | MUST FIX | LOW | 总问题 | 新问题趋势 |
|------|----------|-----|--------|-----------|
| v1 | 2 | 2 (+1 info) | 5 | — |
| v2 | 2 (新) | 2 (新) | 6 | 修复引入新问题 |
| v3 | 0 | 2 (1遗留 + 2新) | 4 | 收敛，无新 MUST FIX |

### 4.3 可实施性评估

计划具备完整可实施性：

- ✅ 所有文件路径明确（10 个文件，create/modify 标注清晰）
- ✅ 接口契约签名完整（参数类型 + 返回值 + edge cases）
- ✅ 依赖关系无环（DAG 验证通过）
- ✅ AC 追溯完整（29/29 覆盖）
- ✅ 异常路径有降级方案（subagent 超时 → 规则 fallback）
- ⚠️ Task 6 执行流需实施者参照 Task Details 自行补齐

---

## 结论

**PASS — 计划可进入实施阶段。**

v2 的 2 条 MUST FIX 全部高质量修复：
- **MF#1（isCompressing 归属）：** 三处矛盾消除，统一为 TreeCompactor 内部管理，spec 已同步。
- **MF#2（预算裁剪保护层级）：** 4 级保护层级定义完整，覆盖从正常到极端的全部场景。

4 条 LOW 不阻塞实施：
- LOW#3（Task 6 执行流）：v2 遗留，实施者可参照 Task Details 补齐
- LOW#4（CompactResult 字段）：实施时推断，建议补充
- LOW#5（cancelPiCompaction 无条件取消）：实际风险低，建议增加条件判断
- LOW#6（ic-segment GC）：影响小，可后续迭代

### 给实施者的建议

1. **Task 6 执行流**：建议按 v2 建议拆为 executor + reviewer 两步
2. **types.ts**：在实现 `CompactResult` 和 `ValidateError` 时参考本评审第 3 节的字段建议
3. **cancelPiCompaction**：考虑增加 `getTree() !== undefined` 条件判断
4. **Entry GC**：实现时可先只做 ic-turn，监控 ic-segment 积累速度

---

## 评审依据

| 检查维度 | 状态 |
|---------|------|
| 1. v2 MUST FIX 修复 | ✅ 2/2 全部解决 |
| 2. v2 LOW 修复 | ⚠️ 1/2 解决（LOW#3 仍 open） |
| 3. 新问题识别 | ✅ 0 条 MUST FIX, 2 条 LOW |
| 4. 接口契约完整度 | ✅ 通过（CompactResult 字段建议补充） |
| 5. Spec-Plan 一致性 | ✅ 通过（isCompressing + 保护层级一致） |
| 6. 执行流完整性 | ⚠️ Task 6 小瑕疵（不阻塞） |
