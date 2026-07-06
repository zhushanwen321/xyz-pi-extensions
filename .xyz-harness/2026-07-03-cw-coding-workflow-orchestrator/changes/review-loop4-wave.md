# review-fix-loop 第 4 路 — Wave 依赖 + 测试闭环

> 认知帧：对齐（正向）。审查对象：`execution-plan.md`。上游契约：`code-architecture.md` §4（时序图）/ §6（test-matrix）/ §7（现有代码映射）/ §8（Wave 拓扑）+ `decisions.md`。检查清单来源：`extensions/coding-workflow/skills/full-execution-plan/references/wave-template.md`。

## 校验方法

1. 抽取 `code-architecture.md` §6 全量用例（来源 A 38 条 T1-T5 + 来源 B 18 条 T2.11-T2.28 = **56 条**）作为基准集。
2. 以 `execution-plan.md` 末尾「测试验收清单」为 canonical 归属表（已核：56 行，无内部重复，每条唯一 Wave）。
3. 逐 Wave 比对其「覆盖的 test-matrix 用例 ID」清单与 canonical 表的双向一致性。
4. 按 wave-template.md 14 项检查清单逐条核对。

---

## MUST_FIX

### M1. Wave 0 覆盖清单漏列 T2.28（迁移日志）— 真实覆盖缺口

- **事实**：canonical 验收清单 `| T2.28 | 迁移日志 from→to | W0 | real | B NFR |`，但 Wave 0「覆盖的 test-matrix 用例 ID」只列了 T2.11/T2.12/T2.13/T2.27，**唯独漏 T2.28**。
- **后果**：Wave 0 的「完成判定」（覆盖用例全 PASS）不含 T2.28。Wave 0 可在迁移日志测试未实现/未过时被宣告完成。T2.27（user_version 迁移数据保留）与 T2.28（迁移日志 from→to）同属 issue #11、同在 store.ts 迁移路径上，验收清单把两者都归 W0，Wave 0 清单却只收一个。
- **违反**：wave-template 检查 #7（并集 = 全量，无遗漏）+ #13（功能 Wave 覆盖 ID 必须在验收清单出现，双向一致）。
- **修复**：Wave 0「覆盖的 test-matrix 用例 ID」追加 `- T2.28（迁移日志 from→to，来源 B）`。

### M2. T3.2 / T3.3 / T3.4 重复归属（Wave 2 + Wave 4）

- **事实**：
  - Wave 2 清单：`- T3.2/T3.3/T3.4（GitValidator 三项 fail）`
  - Wave 4 清单：`- T3.1~T3.9（dev 渐进式全用例）`（区间含 T3.2/T3.3/T3.4）
  - canonical 验收清单：`T3.2/T3.3/T3.4 → W4`
- **后果**：同一用例 ID 两个 Wave 都认领，完成判定归属不清——Wave 2 若以 GitValidator 单测过即宣告 T3.2-T3.4 完成，Wave 4 的 dev 流程集成尚未跑，产生假「完成」信号。
- **违反**：wave-template 检查 #8（用例 ID 无重复归属）+ #13（双向一致）。
- **根因**：T3.2-T3.4 在 code-arch §6 是 **UC-3 dev 流程**用例（commit 不存在/外来/空），属 dev action 集成语义；Wave 2 创建 GitValidator.validate 时做的是 adapter 单测，与 UC-3 集成用例同 ID。canonical 表已裁定归 W4。
- **修复**：从 Wave 2 清单移除 `T3.2/T3.3/T3.4`。Wave 2 的 GitValidator adapter 单测如需保留为独立完成判定，应引用 code-arch §6 中真正的 adapter 层用例（当前 §6 未为 GitValidator 单测分配独立 ID——那么 Wave 2 完成判定就以 #3 AC-3.1~3.3 的 AC 条目为准，不重复认领 UC-3 用例 ID）。验收标准行 `GitValidator 三项独立校验（#3 AC-3.1~3.4）` 已覆盖此点，无需用 T3.x 占位。

### M3. T4.6 重复归属（Wave 1 + Wave 4）

- **事实**：
  - Wave 1 清单：`- T4.6（跨阶段级联失败）`
  - Wave 4 清单：`- T4.1~T4.10（test 双分支全用例）`（区间含 T4.6）
  - canonical 验收清单：`T4.6 → W1`
- **后果**：同 M2，完成判定归属不清。
- **违反**：wave-template 检查 #8 + #13。
- **根因**：T4.6 在 §6 是「跨阶段级联失败（功能 C guard alt）」——dev 有 Wave 未 committed 调 test → throw phase_incomplete。本质是 `checkPhaseCascade` guard 逻辑用例，canonical 表裁归 W1（state-machine）。Wave 4 的 test action 集成会复现该路径，但用例 ID 归属唯一。
- **修复**：Wave 4 清单把 `T4.1~T4.10` 显式排除 T4.6，写成 `T4.1~T4.5, T4.7~T4.10`（或注 `（T4.6 归 Wave 1）`）。

---

## SHOULD_FIX

### S1. T2.24 在 Wave 3 仅括号暗示，未显式列入覆盖清单

- **事实**：Wave 3 清单行 `- T2.1/T2.8（plan/clarify gate pass + review 桩缺失 hint，来源 B T2.24）` —— T2.24 只作为 T2.8 的括号注解出现，不是独立覆盖项。canonical 验收清单 `T2.24 → W3`。
- **后果**：T2.24 是否计入 Wave 3 完成判定有歧义；机器或人按「覆盖的 test-matrix 用例 ID」逐条核 PASS 时易漏。
- **违反**：wave-template 检查 #13（双向一致，显式枚举）。
- **修复**：Wave 3 清单独立成行 `- T2.24（review 缺失预检 hint，来源 B）`，与 T2.1/T2.8 并列。

### S2. Wave 0 清单出现 test-matrix 不存在的幽灵用例 ID「T8.1」

- **事实**：Wave 0 清单首行 `- T8.1（#8 AC-8.1 等价，judgeByExpected 迁移）`。但 code-arch §6 test-matrix（来源 A+B）**没有 T8.x 编号段**；judgeByExpected 8 条等价迁移属「来源 0」（内化基线），plan 末尾注也明确「来源 0…不纳入本 mid test-matrix 比对集」。
- **后果**：`T8.1` 形似 test-matrix 用例 ID 却不在 56 条基准集内，触发覆盖核对时造成「基准集里查无此 ID」的误判噪音；与 plan 自身「来源 0 不纳入比对集」的声明自相矛盾。
- **违反**：wave-template 检查 #6（覆盖 ID 必须来自⑤§6 来源 A+B）。
- **修复**：把该行改写为非 test-matrix 的迁移基线标注，如 `- 来源 0：judgeByExpected 8 条等价迁移测试（#8 AC-8.1，内化基线，非 test-matrix 比对集）`，移出「覆盖的 test-matrix 用例 ID」小节或明确分区。

### S3. 验收 Wave（W6）blocked_by 显式列遗漏 Wave 0

- **事实**：Wave 6 `Blocked by: Wave 1, 2, 3, 4, 5（所有功能 Wave）`，未列 Wave 0。DAG 图 W5→W6，W0 经 W1/W2→…→W5→W6 传递可达，故 W0 是传递前置。
- **后果**：字面读「所有功能 Wave」却漏列 W0，与 checklist 表述不一致；Wave 0 的测试（T2.11/T2.12/T2.13/T2.27/T2.28）确实在验收清单内由 W6 跑，功能上不漏。
- **定性**：wave-template 自身示例也是「Wave 6 blocked by 1,2,3,4,5」（prefactor 不入显式列），故符合模板惯例；但本 plan W0 含实质性实现（store.ts/types.ts），更显式列 W0 可免歧义。
- **修复（可选）**：W6 blocked_by 改为 `Wave 0, 1, 2, 3, 4, 5`，或注 `（W0 经传递链前置）`。

### S4. Prefactor 对 §7 delete 项的 W0/W5 拆分缺一句依赖说明

- **事实**：wave-template「Prefactor Wave 约束」要求 prefactor 覆盖 §7 所有 move/delete/merge 项。实际拆分：
  - W0：move（judgeByExpected→types.ts）、delete+rewrite（plan-parser.ts）、merge（allPassed/allTerminal→computeGatePassed）、create（store.ts）
  - W5：replace（index.ts registerTestOrchestratorTool→registerCodingWorkflowTool）、delete（lib/gates re-export）、delete（workflows/coding-execute.js）
- **判断**：W5 的两项 delete 与 index.ts replace 强耦合（re-export 移除本身就是新 index.ts 的一行；coding-execute.js 须等新 CW 注册后才能安全删），无法前置到 W0，拆分依赖逻辑正确。plan 已在 W5 注「覆盖 code-arch §7 现有代码映射（delete 项）」，但未说明「为何不在 W0」。
- **修复（可选）**：W0 prefactor 说明或 W5 说明处加一句——`lib/gates re-export 与 coding-execute.js 的 delete 依赖 index.ts 重写完成（W5），故归 W5 而非 W0；本拆分符合 §7 处置列`，以抢先回应 checklist 挑战。

---

## OK（无动作）

- **检查 #1 时序图方法依赖方向**：每个 Wave 关联时序图调用的方法，定义均在更早或同 Wave。
  - W3 single-shot handler 调 loadTopic(W0)/guard(W1)/parseLitePlan(W2)/runGate(W2)/GateRunner.runCheck(W2)/buildNextAction(W1)，全部 W0-W2，W3 blocked by W1,W2 ✓
  - W4 dev/test handler 调 GitValidator.validate(W2)/judgeByExpected(W0)/computeGatePassed(W1)，全部 ≤W2 ✓
  - W5 index.ts dispatch 路由 8 handler（W3+W4）✓
  - 无任何时序图方法定义在比调用者更晚的 Wave。
- **检查 #2 并行组文件隔离**：唯一并行组 A = W1（state-machine.ts）+ W2（gates.ts / plan-parser.ts），文件集无交集 ✓。W3/W4/W5 各自串行（B/C/D 组）。
- **检查 #3 验收 Wave 存在且末端**：W6 存在，DAG 末端，blocked by 全部功能 Wave（W0 传递前置，见 S3）✓。
- **检查 #4 / #11 验收清单 = §6 全量**：验收清单 56 行 = 来源 A 38（T1-T5）+ 来源 B 18（T2.11-T2.28），与 code-arch §6 来源 A+B 完全一致，无内部重复 ✓。
- **检查 #5 P0 在 Wave 0-1**：P0 issue #1（CwStore）→ W0；P0 issue #2（状态机 guard）→ W1。两条 P0 全在 W0-W1 ✓。
- **检查 #5 P3/Won't 标理由**：#12 [P3 延后] skill 改名——「推迟到 CW 稳定后，避免改名与实现交织」✓；#13 [Won't] full 路径——「未来需要开新 topic 重设计」✓。
- **检查 #6 Prefactor 铺路**：W0 产出 store.ts（sqlite DAO）+ types.ts（judgeByExpected + 跨层类型），是 W1 state-machine / W2 gates / W3-W5 actions 的共同前置，确实为后续 Wave 铺路 ✓。
- **检查 #9 时序图 alt/else 全覆盖**：功能 A 异常分支→T2.2/T2.3/T2.4/T2.5（W1/W2）；功能 B 异常分支→T3.2/T3.3/T3.4（W4，M2 待去重）；功能 C 异常分支→T4.2/T4.3/T4.5/T4.6（W4/W1，M3 待去重）。所有 alt/else 至少落在一个 Wave 覆盖内 ✓（去重后归属唯一）。
- **检查 #10 骨架叶子作用域映射**：code-arch §9 骨架全部方法分散到 W0（types/store）→W1（state-machine）→W2（gates/parser）→W3-W4（actions）→W5（index.ts），无骨架代码未被 Wave 实现 ✓。
- **DAG 与调度表一致**：mermaid 边 `W0→W1, W0→W2, W1→W3, W2→W3, W3→W4, W4→W5, W5→W6` 与调度表 Blocked by 列逐行吻合 ✓。

---

## 汇总

| 级别 | 条目 | 一句话 |
|------|------|--------|
| MUST_FIX | M1 | Wave 0 覆盖清单漏 T2.28（迁移日志），Wave 0 完成判定跳过该测试 |
| MUST_FIX | M2 | T3.2/T3.3/T3.4 重复归属 W2+W4，须从 W2 移除（canonical 归 W4） |
| MUST_FIX | M3 | T4.6 重复归属 W1+W4，W4 区间须显式排除 T4.6（canonical 归 W1） |
| SHOULD_FIX | S1 | T2.24 在 W3 仅括号暗示，须独立成行 |
| SHOULD_FIX | S2 | W0 幽灵 ID「T8.1」不在 test-matrix，须改标注为来源 0 迁移基线 |
| SHOULD_FIX | S3 | W6 blocked_by 显式列可加 W0（传递前置，功能不漏） |
| SHOULD_FIX | S4 | §7 delete 项 W0/W5 拆分依赖说明可补一句 |

去重并补齐后，per-Wave 覆盖清单与 canonical 验收清单（56 条）将完全一致，测试闭环闭合。
