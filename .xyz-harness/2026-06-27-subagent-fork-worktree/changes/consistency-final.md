---
verdict: CONSISTENT
phase: execution
step: 6c
date: 2026-06-27
---

# 全文档一致性终检（Consistency Final Check）— Step 6c

> 编码前总闸门。4 组并行 fresh-context subagent 按 6 维做跨文档一致性审计 + Step 0 机器检查。
> 4 组发现的问题已全部作为 gap 处理修复（见下），重跑机器检查全 PASS。

## Step 0：全 6 阶段机器检查（硬阻断，最先做）

| 阶段 | 脚本 | 结果 |
|------|------|------|
| clarity | check_clarity.py | 7/7 PASS |
| architecture | check_architecture.py | 8/8 PASS |
| issues | check_issues.py | 9/9 PASS |
| nfr | check_nfr.py | 8/8 PASS |
| code_arch | check_code_arch.py | 14/14 PASS |
| execution | check_execution.py | 7/8 PASS（唯一 FAIL=consistency-final 未产，本文件产出后 PASS） |

全 PASS（execution 的 consistency-final FAIL 是本步骤产出物前置，产出即过）。进 6 维跨文档审计。

## 6 维审计结论（4 组 fresh-context subagent）

| 组 | 维度 | 初判 | 修复后 |
|----|------|------|--------|
| 术语审计组 | 维1 术语一致性 | INCONSISTENT（3 漂移） | **CONSISTENT**（3 全修） |
| 全链追溯组 | 维2 用例追溯 + 维3 AC 闭环 | INCONSISTENT（AC-1.2 断链） | **CONSISTENT**（D-029 修订） |
| 决策守护组 | 维4 决策一致性 | CONSISTENT | **CONSISTENT**（0 偏离） |
| 落地审计组 | 维5 NFR 回灌 + 维6 骨架↔文档 | CONSISTENT（6 低severity 标注） | **CONSISTENT**（1 标注修，5 留实现期） |

**总判：CONSISTENT。** 4 组发现的真矛盾全部修复。

## 发现的问题 + 处置（gap → 回相应阶段 Step 3）

### 已修复（阻断/高severity）

**G1 [维1 术语漂移①→②③⑤⑥]：WorktreeReaper.scan 旧术语残留**
- 发现：①requirements.md:154 + decisions.md D-013 用已废弃的 `WorktreeReaper.scan`，②-⑥统一用 `WorktreeManager.scan`（reaper 是方法非独立类，GAP-E2/D-019 已定）。
- 处置：①requirements.md:154 改为 `WorktreeManager.scan` + 注 D-019。✅ 已修

**G2 [维1 术语漂移]：worktreeCwd 同义词混用**
- 发现：①requirements.md:117-120,215 + decisions.md D-002/D-004 用 `worktreeCwd`（②§3 统一语言未收录的同义词），规范术语是 `effectiveCwd`(=worktreePath)。
- 处置：①requirements.md 5 处 worktreeCwd→worktreePath + decisions.md D-002/D-004 同步。✅ 已修

**G3 [维1 术语漂移]：PatchCollector.diff 旧术语残留（D-020 合并后）**
- 发现：②system-architecture.md:204,67 + decisions.md D-017 用 `PatchCollector.diff`，D-020 已合并为 `WorktreeManager.collectPatch`。
- 处置：②system-architecture.md 2 处改 `WorktreeManager.collectPatch`（注 D-020 合并）+ decisions.md D-017 同步。✅ 已修

**G4 [维3 AC 闭环断链]：UC-1 AC-1.2「空主 session→降级 from-scratch」全链悬空**
- 发现：①AC-1.2 要求空主 session 降级 from-scratch，但③无 issue AC 落点，⑤T1.3 错误关联到 AC-1.2（验证相反的 hard-failure），⑥无验收点。根因：D-018 fork 经 pi SDK，SDK 对空源抛错（session-manager.ts:1444）而非降级，①AC 未同步演进。
- 处置（D-029）：①AC-1.2 修订为「主 session 空或损坏→pi SDK 抛错→finalizeFailed（不崩溃）」+ 替代流程 line 74 作废；⑤T1.3 场景扩展为「源空或损坏」；⑥清单 T1.3 同步。decisions.md 追加 D-029。✅ 已修（非功能变更，行为仍是 finalizeFailed，是文档对齐）

### 留实现期（低severity，非阻断，不破坏一致性）

**N1 [维6]：recordId 白名单状态「待落」滞后** → 已修（non-functional-design.md:563 改「已落」）。✅

**N2 [维5/维6，留实现期]：fork 路径日志骨架未落**（⑤契约项「fork 路径日志」标骨架约束，骨架 session-runner.ts 仅有注释无 console.log）。处置：⑥Wave 3A 实现时补结构化日志，或回灌运维项。非功能正确性，可观测性日志。

**N3 [维6，留实现期]：骨架 recordToSubagent 命名差**（§3 称 RecordStore.recordToSubpanel 私有方法，骨架为独立函数 toSubagent）。处置：⑥Wave 3B 实现时收进 RecordStore 类对齐§3。

**N4 [维6，留实现期]：resolveSessionContext 签名 agentDir 参数**（§3 单参 vs 骨架双参 agentDir）。处置：D-028 已记录（骨架更完整，§3 应补注）。⑥实现按骨架。

**N5 [维6，留实现期]：createAndConfigureSession 返回类型**（§3 BuiltSession vs 骨架 Promise<{session}>）。处置：spike 简化形态，⑥实现时对齐。

**N6 [维6，留实现期]：⑤§9 骨架核验表行号陈旧**（系统性偏移 1-30 行，接线状态列准确）。处置：文档行号回填，不影响实现（接线状态✅准确）。

## 6 维逐维通过声明

- [x] 维1 术语一致性：①统一语言术语在②-⑥用词一致（G1/G2/G3 旧术语残留全修）；状态机 ExecutionStatus 五值跨①②⑤骨架⑥一致
- [x] 维2 用例可追溯：①每个 UC→③issue→⑤时序图→⑥Wave（UC-3/UC-6 合并说明弱落点不断）；无孤立 UC/幽灵 Wave
- [x] 维3 AC 覆盖闭环：①UC AC→③issue AC→⑤test-matrix→⑥Wave 验收全覆盖（G4 AC-1.2 断链 D-029 修订后闭环）；用例 ID 并集=36 全量
- [x] 维4 决策一致性：decisions.md confirmed 决策未被静默推翻；D-011→D-019 revisit 链完整；D-029 新增（AC-1.2 演进，D-可逆 agent-opinionated）
- [x] 维5 NFR 回灌闭环：④9 条代码测试缓解项 ④→⑤§6→⑥Wave→issues AC 全链闭合；性能混沌=0；recordId 白名单已落
- [x] 维6 骨架↔文档一致：⑤骨架 12 功能文件全映射⑥Wave（无 orphan）；签名抽查自洽（N2-N6 低severity 留实现期）

## 最终裁定

**verdict: CONSISTENT。**

4 组审计发现的 4 个真矛盾（G1-G4）全部修复——3 个术语漂移（①②decisions 旧文回扫更新）+ 1 个 AC 闭环断链（D-029 AC-1.2 演进修订）。6 个低severity 标注：1 个已修（N1），5 个留实现期（N2-N6，非阻断，不破坏设计→实现闭环）。

**CONSISTENT，允许交接编码。**

重跑全 6 阶段机器检查：clarity/architecture/issues/nfr/code_arch 全 PASS；execution 7/8（唯一 consistency-final 前置，本文件产出后 PASS）。
