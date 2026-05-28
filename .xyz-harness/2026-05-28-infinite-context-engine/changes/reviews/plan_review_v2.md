---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-29T03:00:00"
  target: ".xyz-harness/2026-05-28-infinite-context-engine"
  verdict: fail
  summary: "计划评审第2轮，4项v1问题全部解决，新发现2条MUST FIX，需继续修改"

statistics:
  total_issues: 6
  v1_must_fix: 2
  v1_must_fix_resolved: 2
  v1_low: 2
  v1_low_resolved: 2
  v1_info: 1
  v1_info_resolved: 1
  new_must_fix: 2
  new_low: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md FR-1.5 + plan.md Task 2 Step 1 (line 331), Task 2 Step 2 (line 332), Task 4 Step 2 (line 397)"
    title: "isCompressing 所有权矛盾——spec 定义为闭包变量，plan 自身三处说法不一致"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "plan.md Task 3 Step 1 assembleMessages 步骤 2/5/6；spec.md FR-3.3/FR-3.5"
    title: "Budget truncation 保护边界未定义——retention window 是否受保护、树节点全部截完仍超限时无策略"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "plan.md BG2 Execution Flow → Task 6（line 269-270）"
    title: "Task 6 执行流缺少实现步骤——仅标注审查步骤，但 Task Details 有 6 个实现步骤"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md FR-1.5 vs plan.md Task 2 Step 2"
    title: "Spec-Plan 不一致——FR-1.5 说 isCompressing 是闭包变量，plan 决策改为 TreeCompactor 内部管理，spec 需同步更新"
    status: open
    raised_in_round: 2
    resolved_in_round: null

---

# 计划评审 v2

## 评审记录
- **评审时间：** 2026-05-29 03:00
- **评审类型：** 计划评审（模式一）— 第 2 轮
- **评审对象：** `.xyz-harness/2026-05-28-infinite-context-engine/plan.md`
- **评审范围：** v1 问题修复验证 + 全局新问题发现

---

## 1. V1 问题修复验证

### MF#1: TDD vs 手动测试矛盾 ✅ RESOLVED

| 检查项 | 状态 | 证据 |
|--------|------|------|
| BG1/BG2 是否有"不执行 TDD"声明 | ✅ | BG1/BG2 执行流都有 `注意` 块明确声明"不执行 TDD 流程" |
| Task 步骤是否移除了 TDD 步骤 | ✅ | 所有 Task 的 Step 列表均为纯实现描述，无"写失败测试"字样 |
| 是否统一用 type-level 验证 | ✅ | 统一声明 "type-level 验证（tsc --noEmit）+ 手动集成测试" |

**结论：** v1 MF#1 完全修复。

---

### MF#2: 异步完成通知机制缺失 ✅ RESOLVED

| 检查项 | 状态 | 证据 |
|--------|------|------|
| triggerCompression 签名是否增加回调 | ✅ | `onComplete?: (result: CompactResult) => void` 已加入 |
| 返回值是否改为 void | ✅ | 返回 `void`（不再返回 Promise） |
| Task 2 是否调用回调 | ✅ | 步骤中明确"调用 `onComplete(result)` 回调通知命令/TUI" |
| Task 4 /tree-compact 是否使用回调 | ✅ | 步骤中说"传入 `onComplete` 回调在 TUI 显示压缩结果" |

**设计评价：** 回调模式选择合理，与 fire-and-forget 异步 spawn 的时序匹配。`onComplete` 可选参数（`?`）设计也考虑了自动触发场景不需要回调的情况。

**结论：** v1 MF#2 完全修复。

---

### LOW#3: isCompressing 归属 ✅ RESOLVED（方向正确）

| 检查项 | 状态 | 证据 |
|--------|------|------|
| plan 是否明确 isCompressing 归属 | ✅ | Task 2 Step 2 注释说"`isCompressing 由 TreeCompactor 内部管理，封装性好`" |
| TreeCompactor 是否暴露查询方法 | ✅ | Interface Contracts 有 `isCompressing() => boolean` 方法 |

**但发现新问题**（见 New MF#1）。

---

### LOW#4: Entry GC ✅ RESOLVED

| 检查项 | 状态 | 证据 |
|--------|------|------|
| plan 是否有 GC task | ✅ | Task 6 Step 5 明确描述 GC 逻辑 |
| GC 策略是否合理 | ✅ | 1000 条阈值 + 只 splice ic-turn、保留 ic-compact-tree |
| 执行流是否覆盖 | ✅ | Task 6 执行流标记 "entry GC" |

**结论：** v1 LOW#4 完全修复。GC 策略设计合理（保留树结构、清理turn映射）。

---

### INFO#5: Task 1 工作量偏重 ✅ 观察性结论

v1 提出的观察项不属于修复要求，当前 plan 结构可接受。

---

## 2. 新发现问题

### New MF#1: isCompressing 所有权矛盾（严重）

**位置：** spec.md FR-1.5 + plan.md 三处不一致

**问题描述：**

plan.md 中存在三处关于 `isCompressing` 归属的**矛盾表述**：

| 出处 | 原文 | 方向 |
|------|------|------|
| P1: plan Task 2 Step 1 (L331) | "添加 `isCompressing` 相关状态到**扩展闭包**" | → 闭包变量 |
| P2: plan Task 2 Step 2 (L332) | "`isCompressing` **由 TreeCompactor 内部管理**，封装性好" | → TreeCompactor |
| P3: plan Task 4 Step 2 (L397) | "声明闭包变量：...`isCompressing`, `needsCompression`" | → 闭包变量（重复声明） |

**三处矛盾的具体分析：**

1. **P1 vs P2：** Step 1 说 isCompressing 在扩展闭包（follow spec），Step 2 又说 TreeCompactor 内部管理。同一个 Task（Task 2）的两个相邻子步骤说法相反。实施者读到这里会困惑：到底听哪个？

2. **P2 vs P3：** 如果 TreeCompactor 内部管理 isCompressing，工厂闭包不应再声明同名变量。P3 的 `isCompressing` 是冗余声明，与 TreeCompactor 内部状态之间没有任何同步机制。

3. **P1 vs P3：** 即使认为闭包声明是合理的，P1（Step 1 扩展 types.ts）中"添加 isCompressing 状态到扩展闭包"这个步骤也很奇怪——types.ts 是类型定义文件，不应该包含运行时状态。

**spec 层面的不一致：**

spec.md FR-1.5 明确写着：
> `isCompressing` 布尔标志（**闭包变量**），确保同一时刻最多一个压缩进程运行。

但 plan 在 P2 中决策改为 TreeCompactor 内部管理。如果这是有意的设计优化（封装性确实更好），那么：
- plan 应统一所有表述为 TreeCompactor 内部管理
- spec.md FR-1.5 应同步更新

**影响评估：**

| 场景 | 后果 |
|------|------|
| 实施者选择 P1（闭包）+ P3（闭包） | 工厂闭包管理 isCompressing，TreeCompactor 不管理 → 调用 TreeCompactor 时无法守卫并发 |
| 实施者选择 P2（TreeCompactor）+ P3（闭包） | 两处各自管理不同步 → 守卫检查出错，可能同时启动两个压缩进程或永远无法触发 |
| 实施者混淆直接跳过 | isCompressing 守卫缺失，违反 C-4，可能导致同一时刻多个压缩进程竞争资源 |

**修改建议：**

选择**一种**所有权模型并全局统一。推荐方案（已由 P2 建议）：

> **方案：TreeCompactor 内部管理**
> - `isCompressing` 是 TreeCompactor 的私有字段
> - `triggerCompression` 内部检查并设置
> - 工厂通过 `compactor.isCompressing()` 方法查询
> - 工厂闭包移除 `isCompressing` 变量（`needsCompression` 保留作为压缩触发标志）
> - spec.md FR-1.5 更新为 TreeCompactor 内部管理
> - plan.md Task 2 Step 1 移除"添加 isCompressing 到扩展闭包"（types.ts 只放类型定义）

> **方案 B（备选）：工厂闭包管理**
> - `isCompressing` 是工厂闭包变量
> - TreeCompactor 不维护 isCompressing，改为外部传参
> - `triggerCompression` 增加 `onStart`/`onEnd` 回调让工厂管理状态
> - 封装性不如方案 A

**建议统一采用方案 A（与当前 P2 注释一致）。**

---

### New MF#2: Budget truncation 保护边界未定义（严重）

**位置：** plan.md Task 3 Step 1 assembleMessages 步骤 2/5/6；spec.md FR-3.3/FR-3.5

**问题描述：**

plan 中 assembleMessages 的执行步骤：

```
Step 2: 计算保留窗口 → 完整原文（受 AC-3.1 保护）
Step 3: 已压缩段 → BFS 展平摘要
Step 4: 未压缩的旧段 → 完整原文
Step 5: 预算检查
Step 6: 超限 → 按深度截断（先砍最深层最老节点）
```

**三个未定义的问题：**

**Q1: retention window（Step 2）是否受 budget truncation（Step 6）保护？**

如果不受保护，retention window 的完整原文可能被截断，违反：

- **AC-3.1**："当前段 + 保留窗口使用完整原文"
- **C-2**："原始数据完整性——当前段未压缩"

如果受保护，plan 应显式声明 retention window 不参与截断。

**Q2: 所有树节点截光后仍超限怎么办？**

极端情况：大量未压缩旧段（Step 4）+ retention window（Step 2）的全文堆积，即使所有树节点都被砍掉，仍超出预算。

| 可能策略 | 问题 |
|---------|------|
| 强制触发压缩 | 压缩是异步的，当前 context 调用仍需立即返回 |
| 截断未压缩旧段 | 违反 AC（这些段尚未被压缩，截断丢失信息） |
| 允许超限 | 削弱了预算控制的意义 |

plan 对此场景无任何对策。

**Q3: 未压缩旧段在预算检查中的角色是什么？**

Step 4 将未压缩旧段以完整原文加入 assembled messages。Step 5 对这些全文做预算估算。但 Step 6 的 truncation 只描述了对树节点的操作（"最深层最老节点"）。未压缩旧段是否也是截断候选？如果是，策略是什么？

**修改建议：**

在 plan.md 中增加以下定义：

1. **保护优先级声明**（添加到 Task 3 Step 1）：
   ```
   - 保护层级（不可截断）：当前段 > 保留窗口完整原文
   - 可截断层级（优先截断）：最深层树节点 > 次深层树节点 > ... > Level 1 全部
   - 极端降级层：未压缩旧段（仅在树节点全部截光后仍超限时启用，按时间倒序截断最旧的）
   ```

2. **边界策略**（添加到 Task 3 Step 1 或 Task 6）：
   ```
   - 如果所有可截断内容（树节点 + 未压缩旧段）全部移除后 budget 仍超限：
     a) 强制启用规则保留：当前段完整 + 保留窗口摘要（仅限极端情况）
     b) 在 context handler 返回值中标记 `budgetExceeded: true`，通知用户
   ```

---

### New LOW#3: Task 6 执行流缺少实现步骤

**位置：** plan.md BG2 Execution Flow → Task 6（line 269-270）

**问题描述：**

所有其他 Task 的执行流都有两个子步骤：

| Task | 执行流步骤 |
|------|-----------|
| Task 1 | ① executor（写代码）→ ② reviewer（审查） |
| Task 2 | ① executor（写代码）→ ② reviewer（审查） |
| ... | ... |
| **Task 6** | **① 审查 + entry GC（仅审查）** |

但 Task 6 的 Task Details 包含 6 个实现步骤：

```
Step 1: recall TUI renderCall/renderResult
Step 2: /tree-compact 压缩进度 TUI 渲染
Step 3: /context-status TUI 格式化输出
Step 4: npx tsc --noEmit 类型检查
Step 5: entry GC 实现
Step 6: Commit
```

执行流却只写了"全链路集成审查 + entry GC"，缺少 executor 子步骤。subagent 按执行流实施时会误以为 Task 6 只做审查，错过了 5 个实现步骤。

**影响：** 实施阶段步骤遗漏，TUI 渲染和类型检查无人执行。

**修改建议：**

将 BG2 中 Task 6 的执行流改为两段：
```
Task 6 (depends on Task 1-5):
    1. general-purpose (read xyz-harness-backend-dev) → TUI 渲染 + entry GC + 类型检查
    2. general-purpose (read xyz-harness-expert-reviewer) → 全链路集成审查
```

---

### New LOW#4: Spec-Plan 不一致（isCompressing 所有权）

**位置：** spec.md FR-1.5 vs plan.md Task 2 Step 2

**问题描述：**

- spec.md FR-1.5（原始声明）：`isCompressing` 布尔标志（**闭包变量**）
- plan.md Task 2 Step 2（设计决策）：`isCompressing` **由 TreeCompactor 内部管理**

这是一个有意的设计偏离。如果 plan 选择封装到 TreeCompactor（更好的设计），spec 应同步更新 FR-1.5 章节。

**影响：**
- 低（与 New MF#1 相关，MF#1 修复后 spec 也需同步）

**修改建议：**
- spec.md FR-1.5 将"闭包变量"改为"TreeCompactor 私有字段，通过 `treeCompactor.isCompressing()` 查询"
- 更新 FR-2.2 执行流程第 1-2 步的表述（"检查 isCompressing 守卫→设置 isCompressing = true"改为"调用 compactor.triggerCompression()，内部检查并设置 isCompressing"）

---

## 3. 第二轮全局评估

### 3.1 修复质量评估

v1 的 4 项问题（2 MUST FIX + 2 LOW + 1 INFO）全部得到重视和修复。修复方式与建议一致或更优：

| V1 Issue | 修复质量 | 评价 |
|----------|---------|------|
| MF#1 TDD 矛盾 | ⭐ 优秀 | 全局声明 + 移除所有 TDD 步骤，干净彻底 |
| MF#2 回调缺失 | ⭐ 优秀 | onComplete 回调 + 更新接口契约 + 命令中使用，完整闭环 |
| LOW#3 isCompressing 归属 | ⚠️ 方向正确但引入新问题 | 选择了正确的封装方向但未完全统一 |
| LOW#4 Entry GC | ⭐ 优秀 | 策略明确（1000条阈值+保护树结构），步骤完整 |

### 3.2 新问题严重性评估

| # | 严重性 | 是否会阻导致实施失败 | 修复复杂度 |
|---|--------|---------------------|-----------|
| MF#1 | isCompressing 守卫失效 → 并发压缩 | **高**：直接导致并发控制失效 | 低：统一表述即可 |
| MF#2 | Budget 保护缺失 → AC 违反 | **高**：极端场景下 AC-3.1/C-2 被违反 | 中：增加保护层级定义 |
| LOW#3 | Task 6 步骤遗漏 | 中：可能漏做 TUI 渲染 | 低：补齐执行流步骤 |
| LOW#4 | Spec-Plan 不一致 | 低：不会导致实施失败 | 低：更新 spec |

### 3.3 Plan 整体质量（不含问题）

| 维度 | 评估 | 说明 |
|------|------|------|
| Spec 完整性 | ✅ 优秀 | 29 条 AC 全部可量化可验证 |
| 任务拆分 | ✅ 合理 | 6 个 Task 粒度适中，依赖清晰 |
| 接口契约 | ✅ 完整 | 14 个方法 + 5 个数据结构定义齐全 |
| 异常处理 | ✅ 充分 | 重试/降级/超时/校验均覆盖 |
| 执行编排 | ⚠️ 小缺陷 | Task 6 执行流遗漏实现步骤 |

---

## 结论

**需修改后重审。** v1 的 4 项问题全部高质量修复，但新发现 2 条 MUST FIX 需要修订后重新评审。

### 核心修改要求

**MF#1：** 统一 isCompressing 所有权模型（建议 TreeCompactor 内部管理），消除三处矛盾表述。同步更新 spec.md FR-1.5（约 10 分钟）。

**MF#2：** 在 plan.md Task 3 Step 1 中增加 budget truncation 保护层级声明和极端情况策略。保护 AC-3.1/C-2 不受违反（约 15 分钟）。

**LOW#3（建议同时处理）：** 补齐 BG2 中 Task 6 的执行流（增加 executor 子步骤，约 5 分钟）。

**LOW#4** 随 MF#1 自动解决。

---

## 评审依据

| 检查维度 | 状态 |
|---------|------|
| 1. V1 问题修复 | ✅ 全部 4/4 已解决 |
| 2. 新问题识别 | ⚠️ 发现 2 条 MUST FIX |
| 3. 接口契约完整度 | ✅ 通过 |
| 4. Spec-Plan 一致性 | ⚠️ 1 处不一致（isCompressing） |
| 5. 执行流完整性 | ⚠️ 1 处遗漏（Task 6） |
