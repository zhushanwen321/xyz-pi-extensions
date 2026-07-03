---
phase: issues
verdict: APPROVED
machine_check: PASS
review_mode: parallel
---

## Verdict
APPROVED

> 机器检查 8/9 passed，唯一 ❌ 是 `review-issues.md` 未生成——这是本审查 subagent 即将产出的文件，属预期，不计硬伤。其余 8 项（frontmatter / 关键章节 / 无占位符 / P0-P1 ≥2 方案 / 无幽灵依赖 / P 级一致 / 覆盖核验表完整）全部 PASS。machine_check 标 PASS。

## 机器检查结果

摘要（machine-check-issues.md）：8/9 passed。

| 检查项 | 结果 |
|--------|------|
| issues.md 存在 | ✅ |
| frontmatter verdict: pass | ✅ |
| 关键章节齐全 | ✅ |
| 无占位符 | ✅ |
| review-issues 存在 | ❌（本文件，预期，不计硬伤）|
| P0/P1 ≥2 方案对比 | ✅ |
| blocked_by 无幽灵依赖 | ✅ |
| P 级一致性 | ✅ |
| 覆盖核验表形式 | ✅（54 行，无待补）|

## 维度评估（5 维）

### 1. 内部一致性：✅

- **P 级与 blocked_by 一致**：P0 = #1（无依赖）/#2（#1）；P1 = #3/#4（仅 #1）/ #5（#1,#2）/ #6（#1,#3）/ #7（#1,#2,#4,#5,#6）/ #12（#2,#4,#5,#6,#7）；P2 = #8/#11（仅 #1）/ #9（#1,#4,#7）/ #10（#1,#5）。**无 P0/P1 依赖 P2/P3**，依赖链全部向更小编号收敛，无环。机器检查 P 级一致性 ✅ 印证。
- **方案对比与取舍不自相矛盾**：每个 issue 的"取舍决策"选择方案 A，"放弃方案的理由"逐一对应方案 B/C 的缺点（#1 B 抽包违反 YAGNI；#2 B 违反 D-013#1；#3 B 违反 D-不可逆；#4 B 违反 D-019/D-020；#7 B 违反 D-017 best-effort）。无内部矛盾。
- **AC 引用编号闭环**：AC-1.x~AC-12.x 全部编号连续、归属对应 issue（#1→AC-1.x，#2→AC-2.x ... #12→AC-12.x）。AC-2.2 引 UC-7、AC-3.5 引 UC-1、AC-7.7 引 BC-6 等 trace 引用均在上游覆盖核验表中可查到根。
- **覆盖核验表无 ❌ 待补**：54 行逐元素扫描，状态列全 ✅，无 N/A 漏填、无"待补"残留。

### 2. 上游对齐：✅

- **每个 issue 在 system-architecture.md + decisions.md 可查到根**：
  - #1 ← §7 types.ts 行 + D-013#2#8/D-016/D-012③/D-014/D-023
  - #2 ← §5 状态流转 + §7 三模块 + D-010/D-013#1#2/M3/BC-7
  - #3 ← §7 新增 SCR + D-014 + §11 AC-1/AC-2
  - #4 ← §7 新增 WorktreeManager + D-005/D-015/D-019/D-020 + §4 降级
  - #5 ← §7 新增 FinalizedMarker + §5 crashed 检测 + D-006
  - #6 ← §7 修改 session-runner + §9 泳道 + D-012①③/D-014/D-018/BC-2/BC-3
  - #7 ← §7 集成点表 + D-013#5/D-017/GAP-E5 + BC-1/BC-4/BC-8
  - #8 ← §7 subagent-tool + D-008
  - #9 ← §7 index.ts + D-013#4#6 + §8 边界
  - #10 ← §7 session-file-gc + D-013#3 + §11 AC-5
  - #11 ← §12 BC-2 + D-012④
  - #12 ← §5 已知盲区（反哺为"本轮处理"）+ D-021
- **不违反 D-不可逆决策**（D-001/002/003/004/005/006/009/014）：
  - D-001（in-process）: #6/#7 全程 createAgentSession in-process，无 spawn。✓
  - D-002（git worktree）: #4 用 git worktree add。✓
  - D-003（单后端）: 无 spawn 双后端。✓
  - D-004（主 cwd 编码 sessionDir）: AC-3.6/AC-6.5 明确 getSubagentSessionDir 用 mainCwd 不变。✓
  - D-005（patch 回传）: AC-4.3 collectPatch = git diff --cached → patch，cleanup 用 remove --force + branch -D。✓
  - D-006（finalized sidecar）: #5/AC-5.1 实现 write/readFinalized。✓
  - D-009（双层分布）: #3 SCR 归 Core，#4/#5 归 Runtime。✓
  - D-014（SCR 纯函数 + forkFrom 上移）: AC-3.3/AC-3.4 grep 零副作用验证，#6 session-runner 调 forkFrom。✓
- **D-021~D-024 反哺正确落地**：
  - D-021（pid 探活方案 A）: #12 完整实现 alive-store + 写入点（#6 AC-6.7）+ 删除点（#7 AC-7.8）+ 四分支（#2 扩展注）+ GC（#10 AC-10.2）+ pid 复用兜底（AC-12.4）。✓
  - D-022（collectPatch 失败保 worktree）: #7 AC-7.4 明确"cleanup 必须跳过 + patchFailed:true + 路径"。✓
  - D-023（externalInstance 投影字段）: #1 AC-1.5 + #12 AC-12.5 双点落地，ExecutionStatus 不含 __external。✓
  - D-024（reaper 孤儿判据加活 .alive 守卫）: #4 AC-4.4 + #9 AC-9.4 落地。✓
- **架构 §5「已知盲区——本轮不处理」作废**：issues.md #12 问题描述 + decisions.md D-021 明确记录此条作废反哺为"本轮处理"，一致。

### 3. 可执行性：✅

- **AC 是可机器验证的 grep/检查（非模糊描述）**：抽样验证——AC-1.1（`grep -E "forkFrom|createBranchedSession" types.ts` 命中）、AC-2.1（`grep "crashed" record-store.ts` 命中）、AC-3.3/AC-3.4（grep 无输出）、AC-4.6（`grep -ri "keepBranch"` 无输出）、AC-4.7/AC-4.8（find 文件无输出）、AC-7.2（`grep -n` 顺序检查）、AC-12.1（find alive-store.ts 命中）。少数 AC 是行为契约（如 AC-2.2 三分支 if/else、AC-7.3 三件套各自 try/catch），属需代码审查验证的逻辑结构，非纯 grep，但表述具体到可判定（三分支枚举、独立 try/catch 模式）。整体可执行性强。
- **方案 A 改动具体到文件/方法**：每个 issue 的方案 A "改动"列均指明文件（execution-record.ts/record-store.ts/session-runner.ts/worktree-manager.ts 等）+ 方法（markReconstructedStatus/reconstructAll/resolveSessionContext/createAndConfigureSession/finalizeRecord 等）+ 流程点。LOC 预估（#4 ~280/#5 ~50/#12 ~40）给出规模锚点。

### 4. 完整性：✅

- **上游覆盖核验 4 轴全覆盖**：状态轴 §5（8 元素）/ 模块轴 §7（14 元素）/ 边界轴 §8（3 元素）/ 挑战轴 §10（5 元素）逐元素映射到 issue，无 ❌。
- **兜底全覆盖**：§9 泳道（2）+ §11 AC-1~AC-11（11 条，全部分入对应 issue AC）+ §12 BC-1~BC-8（8 条，标记保持/变更）+ §4 降级/模型（4 条，含 WorktreeHandle VO/forkDepth 守卫/patch 不建模/keepBranch 删除）。逐条可追溯到 issue。
- **无 PHANTOM/MISSING**：无引用不存在的 issue/UC/AC/BC 编号；blocked_by 引用的 #1~#7/#12 均存在（机器检查无幽灵依赖 ✅ 印证）。
- **必问决策点有用户拍板记录**：
  - P0/P1 划线：#1/#2=P0（编译基石），#3~#7/#12=P1（核心），均有"为什么是这个 P 级"论证。
  - 取舍例外：每个 issue "放弃方案的理由"明确。
  - DESIGN-IT-TWICE 选定：#12 经 3 方案对比，D-021 记录"用户拍板方案 A"（confirmed_by=ask_user）。
  - 迷雾（fog）：P2 #8/#9/#10/#11 标 fog，地图 mermaid classDef fog 正确。
  - P3：原 P3 延后项（跨实例盲区）经 D-021 提升为 P1 #12，决策账本有记录；worktree 嵌套延后（OS-6 禁止）独立列"后续迭代"。

### 5. 可视化质量：✅（含 1 处可选改进）

- **决策 DAG 图节点色标正确**：classDef p0 fill:#bbf7d0 绿（#1/#2）/ p1 fill:#fde68a 金（#3/#4/#5/#6/#7/#12）/ p2 fill:#e2e8f0 灰（#8/#9/#10/#11）/ deferred 虚线 stroke-dasharray:5 5（worktree 嵌套）。图例（legend）与色标一致：P0 绿/P1 金/P2 灰/延后虚线。✓
- **依赖边基本正确**：图中边与 blocked_by 大体一致（#1→#2/#3/#4/#6/#8，#2→#5，#3→#6，#4→#7/#12，#5→#7/#12/#10，#6→#7/#12，#7→#12/#9，#4-.->延后）。
- **⚠️ 可选改进（非阻断）**：图中 `I2-->I10`（#2→#10）与 `I2-->I11`（#2→#11）两条边在对应 issue 的 blocked_by 中**未声明**（#10 blocked_by=#1,#5；#11 blocked_by=#1）。这两条是语义关联边（#10 GC 清 .finalized 依赖 #2 的 crashed 概念、#11 ADR 修订依赖 fork 概念）而非硬 blocked_by。建议从图中移除或改注为弱关联，以与 blocked_by 严格对应——但不影响可读性与决策正确性，属可选改进。

## 必须修改
（无阻断项。机器检查的 ❌ 为本审查文件缺失，预期。）

## 可选改进
1. **issues.html DAG 图**：移除或弱化 `I2-->I10` / `I2-->I11` 两条非 blocked_by 边，使图边与 issues.md 的 `**Blocked by**` 字段严格一一对应。当前为语义关联边，不影响落地，但严格性上可对齐。

## 优点
- **追踪收敛纪律强**：Round 1 发现 16 gap（3 阻断 B2/B7/B8 + 13 强化项），Round 2 全修并入 AC，3 阻断升级为 D-022~D-024 不可逆决策回灌。每条 AC 标注 B 编号可溯源，是高质量的异常猎手闭环。
- **反哺决策落地彻底**：D-021~D-024 四条反哺决策在多个 issue 的 AC 中交叉落地（D-021→#2/#5/#6/#7/#10/#12 共 6 处，D-024→#4/#9 两处），无遗漏。
- **D-不可逆决策当约束执行严谨**：每个方案 B/C 的"放弃理由"都明确指向违反的具体 D-不可逆编号（#3 B 违反 D-014、#4 B 违反 D-019/D-020），不把已 confirmed 决策当"待改"。
- **AC 可执行性高**：多数 AC 是具体 grep/find 命令，机器可验证；行为契约类 AC 也表述到可判定的结构层面（三分支枚举、独立 try/catch）。
- **覆盖核验无死角**：54 行逐元素扫描，4 轴 + 兜底全 ✅，无 N/A 漏填。
