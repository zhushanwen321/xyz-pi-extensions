---
converged: false
---

# 追踪 round-1 — 演进帧（视角5 变化轴 + 视角6 行为契约）

> fresh-context subagent，独立追踪。refactor 模式 → 视角6 不降级。

## verdict: NOT CONVERGED（6 gap）

## 视角5：变化轴

### GAP-E1 [D] keepBranch 是 zero-value 伪 seam，与 D-005 矛盾
- D-005「worktree 真正一次性、不堆积分支」，但预留 keepBranch 接口
- 调用方本轮 = 零；不捕获现存不对称（只捕获未来可能性，且该未来已被 D-005 排除本轮）
- 删证伪三连：去掉塌缩成一块 → 伪 seam

### GAP-E2 [F] [CROSS-VALIDATED] WorktreeReaper 身份分裂
- §7 新增模块表：scan 是 WorktreeManager 方法
- §7 修改模块表/§9 泳道/AC-6：当独立模块 `WorktreeReaper`
- 变化轴归属未定（reaper 策略 vs create/cleanup）

### GAP-E3 [K] SessionContextResolver fork 策略轴揉进未决 compaction 交错
- §7 变化轴「forkFrom vs createBranchedSession vs compaction-point」
- 实际是两个轴被并一：fork 实现策略（D-007 已定）+ compaction 交错（未拍板）
- 纯函数定位 + compaction 读源原子性 → 破坏纯函数契约

## 视角6：行为契约

### GAP-E4 [F] BC 清单漏列「崩溃会话现状显示 done」被改为 crashed
- 源码 session-reconstructor.ts:396-396：reconstructFromFile 永远只推 done/failed
- 现有行为：kill-9 会话（无 tombstone）重建显示 done
- 本次改动：done → crashed（无声改变），§12 未登记

### GAP-E5 [K] worktree cleanup 挂载点未定，三条终态路径覆盖不对称
- 三条路径：runAndFinalize done/failed、finalizeFailed create-failed、cancelBackground
- §7 只说 finalizeRecord + cancelBackground 调 cleanup，漏第 2 条（create-failed）
- worktreeHandle 守卫（非 worktree run 跳过）未说
- cleanup 在 finalizeRecord 内 vs run() finally 外？跨层问题（Core 调 Runtime）

### GAP-E6 [F] background .catch(()=>{}) 吞错边界未约束
- subagent-service.ts:367 detached 吞所有 reject
- 三件套（cleanup/diff/writeFinalized）任一抛错 → 逃逸 → archive 被跳过 → record 卡 running
- §10 特化决策只说 best-effort 吞，没约束 try/catch 边界

## 汇总

| 编号 | 类型 | 视角 | 优先级 |
|------|------|------|--------|
| GAP-E1 | D | 5 | 中 |
| GAP-E2 | F | 5 | 中 |
| GAP-E3 | K | 5 | 中 |
| GAP-E4 | F | 6 | 高 |
| GAP-E5 | K | 6 | 高 |
| GAP-E6 | F | 6 | 中-高 |

## 交叉验证候选

- GAP-E1（keepBranch 伪 seam）可能被结构帧 GitPort 之外过度抽象同源命中
- GAP-E5（cleanup 跨层）可能被结构帧 session-runner 调 WorktreeManager 同源命中
- GAP-E2（reaper 身份）= 结构帧 GAP-4.3 → `[CROSS-VALIDATED]`
