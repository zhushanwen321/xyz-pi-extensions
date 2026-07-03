---
converged: false
phase: nfr
round: 1
role: backfeed-pointer-rebuilder
---

# 回灌指针重建 Round 1 — 反向核对 ③ 指针

> 先读 issues.md（③，不先读 ④ 回灌表）重建 issue 清单，再核 ④ 回灌表每条「回灌去向=③issue #N」。

## 重建的 issues.md 清单（③ 真相源）

issues.md 共 #1–#13（无 #14+，仅「后续迭代」占位段）。回灌相关关键 AC：
- #1 AC-1.5（externalInstance 投影）/ #2 AC-2.2/2.3（status 收口）/ #4 AC-4.4（孤儿判据）/4.10/4.11（软链）/ #6 AC-6.3/6.6（降级）/ #7 AC-7.4（保 worktree）/7.9（兜底）/ #8 AC-8.4（敏感数据）/ #9 AC-9.4（孤儿判据）/ #10 AC-10.2（GC 探活）/ #12 AC-12.2（四分支）/12.4（多实例）。

## 回灌指针核对（逐条）

| # | 缓解项 | 声明去向 | 结果 |
|---|--------|---------|------|
| 1 | collectPatch 失败保 worktree（D-022） | #7 AC-7.4 | ✅ OK |
| 2 | completeRecord/archive 抛错兜底（B9） | #7 AC-7.9 | ✅ OK |
| 3 | reaper 孤儿判据 .alive 守卫（D-024） | #4 AC-4.4 / #9 AC-9.4 | ✅ OK |
| 4 | GC 清 .alive 先探活（B3） | #10 AC-10.2 | ✅ OK |
| 5 | 四分支 sidecar 矩阵（D-021） | #12 AC-12.2 | ✅ OK |
| 6 | externalInstance 投影类型测试（D-023） | #1 AC-1.5 / #12 AC-12.4 | ✅ OK |
| 7 | fork 继承敏感数据文档化（G5 D-007） | #8 AC-8.4 | ✅ OK |
| 8 | **fork 三级降级链测试** | **#6 AC-6.3/6.6** | ❌ **MISMATCH + AC 断链（K）** |
| 9 | node_modules 软链生效验证 | #4 AC-4.10/4.11 | ✅ OK |
| 10 | status 收口静态规则 | #2 AC-2.2/2.3 | ✅ OK |

## 唯一 gap：#8 fork 降级链「三级」声明与 AC 实际「两级」错配 [K]

**声明**：④ 回灌表 + ⑤骨架验证表 + 残余风险表三处均称「**三级**降级链（createBranched→forkFrom→**from-scratch**）」。

**实际**：
- AC-6.3 只测**两级**（createBranchedSession 抛错→降级 forkFrom，断言「走 forkFrom」），**未测** forkFrom 再抛错→from-scratch 第三级。
- issues.md #6 问题描述本身只描述两级（「优先 createBranchedSession，forkFrom 仅作降级 D-018」），无 from-scratch 第三级设计。
- AC-6.6 是 `fork:false → 保持原 create 路径`——属用户未开 fork 的默认路径，**与降级链无关**，不能验证降级属性。

**结论**：回灌声明「三级降级链」被只覆盖两级的 AC（6.3）+ 一个无关 AC（6.6）承接，AC 内容与声明属性错配。无 PHANTOM（#6 真实存在），无 P 级 MISMATCH。

**修复方向（供主 agent 决策）**：
- 方案 a（收紧声明）：把声明改为「两级降级（createBranched→forkFrom）」，验收指针仅留 AC-6.3，删除 AC-6.6 作降级指针。
- 方案 b（补设计+AC）：若 from-scratch 第三级确为需求，#6 补 AC-6.3b（mock forkFrom reject→断言走 from-scratch create）+ 问题描述补该级设计。

**注**：NFR 初稿 #6 稳定性维度也写了「三级降级链 createBranched→forkFrom→from-scratch」（第 268 行），同源措辞漂移。

## 结论

**CONVERGED = false**（1 条 gap）。10 条 ③ 指针 9 条 OK（无 PHANTOM、无 P 级 MISMATCH），1 条 K（#6 降级链声明与 AC 错配）。⑤ 指针未查（⑤尚未产出，闭环由⑤ §6 来源B 接住）。
