---
phase: issues
round: 2
type: convergence
---

# 追踪 Round 2 — 收敛复核（gap 分流 F/K/D → 修复）

> 输入：tracing-round-1.md（角色 A 4 gap + 角色 B 12 gap = 16 gap，3 阻断）。
> 分流纪律：F=事实错（必修）/ K=知识盲区（补 AC 或显式延后）/ D=决策分歧（走 Step 6b 反哺）。

## 分流与修复总表

| gap id | 类型 | 主题 | 处置 | 落地 |
|--------|------|------|------|------|
| A-MISSING | K | §4 SubagentIdentityData forkDepth 写侧 M4 守卫无 AC | 修复 | #6 AC-6.8（写侧守卫，与 M3/AC-2.3 对称）+ 覆盖表改归属 #6 |
| A-MISMATCH#1 | K | 同 A-MISSING（读/写两侧混淆）| 修复 | 同上（#3 仅读侧 AC-3.5）|
| A-MISMATCH#2 | K | WorktreeManager.create 的 node_modules 软链 + setupHook 无正向 AC | 修复 | #4 AC-4.10/4.11（正向功能契约 + 无 node_modules 边界）|
| A-MISMATCH#3 | K | WorktreeHandle VO 归属模糊 | 修复 | #4 AC-4.13（归属明确 + readonly）+ 覆盖表 |
| B1 | K | fork 读源遇 compaction 写入交错（脏读/撕裂）| 修复 | #6 AC-6.9（SDK 快照读 / createBranchedSession 取 compaction 后路径）|
| **B2** | **F** | **collectPatch 失败 → cleanup 删 worktree = 数据黑洞**（阻断）| **修复 + D-022** | #7 方案 A 修订 + AC-7.4（collectPatch 失败跳过 cleanup 保留 worktree）|
| B3 | K | GC 误清活 .alive 致误判 crashed | 修复 | #10 AC-10.2 + #12 AC-12.6（GC 清 .alive 前先探活，pid 活跳过）|
| B4 | F | isProcessAlive Windows 语义 + pid≤0 边界 | 修复 | #12 AC-12.7（pid≤0 拒绝；Windows 异常 try/catch 返回 false）|
| B5 | K | 同 A-MISMATCH#2 | 修复 | #4 AC-4.10/4.11 |
| B6 | K | collectPatch 空 patch / 二进制边界 | 修复 | #4 AC-4.12（空 patch no-op；二进制记 binary-skipped）|
| **B7** | **F** | **__external 不在 ExecutionStatus 联合类型**（阻断，类型契约裂缝）| **修复 + D-023** | #1 AC-1.5 + #12 AC-12.5（externalInstance 投影标志字段，不污染 ExecutionStatus）|
| **B8** | **F** | **reaper scan 跨实例删活 worktree**（阻断，最危险破坏性竞态）| **修复 + D-024** | #4 AC-4.4 + #9 AC-9.4（孤儿判据=终态标记+无活 .alive，复用 #12 机制）|
| B9 | F | completeRecord/archive 抛错逃逸 detached .catch → ③全跳过 | 修复 | #7 AC-7.9（外层兜底 try/catch，finalized/cleanup 仍 best-effort）|
| B10 | K | createBranchedSession 返回 unknown 类型契约为零 | 修复 | #1 AC-1.6（runtime shape check / 受控断言，非裸 any 强转）|
| B11 | F | crashed reason 不区分来源 | 修复 | #2 AC-2.4（基础无 .alive 路径）+ #12 AC-12.8（pid 死独立 reason）|
| B12 | K | createBranchedSession 降级判定标准未定 | 修复 | #6 AC-6.10（try/catch 捕获抛错降级，非 falsy/方法检测）|

## 收敛结果

- **16 gap 全部处置**：16 修复（无延后、无 D 反哺）。
- **3 阻断（B2/B7/B8）全部修复**：各配新决策（D-022/D-023/D-024，D-可逆细化，非推翻 D-不可逆）+ 验收 AC。
- **类型分布**：F 6 全修（B2/B4/B7/B8/B9/B11 + A 无 F）；K 10 全修（A 4 + B1/B3/B5/B6/B10/B12）；D 0（无已确认决策被推翻，不触发 Step 6b 反哺）。
- **新决策**：D-022（collectPatch 失败保 worktree）、D-023（externalInstance 投影标志）、D-024（reaper 孤儿判据安全网）。

## 机器检查复核

check_issues.py 重跑 8/9 passed（唯一 FAIL = review-issues.md 未生成，属 Step 6 产物）。结构硬伤全清：P0/P1 ≥2 方案 ✅、blocked_by 无幽灵 ✅、P 级一致 ✅、覆盖核验表无待补 ✅。

## 结论

**converged**。Round 1 的 3 阻断 + 13 K/F 全部收敛进 issues.md AC 与 decisions.md D-022/023/024。可进 Step 5 定稿 + Step 6 审查。
