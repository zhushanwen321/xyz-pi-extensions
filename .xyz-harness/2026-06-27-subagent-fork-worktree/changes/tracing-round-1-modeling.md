---
converged: false
---

# 追踪 round-1 — 建模帧（视角1 模型完整性 + 视角2 状态正交性）

> fresh-context subagent，独立追踪。CONVERGED 的检查面不重报。

## verdict: NOT CONVERGED（6 gap）

## 视角1：模型完整性

### M1 [F] patch 路径承载模型未定 — record.result vs ExecutionRecord.patchFile
- requirements.md UC-4「patch 路径塞进 record.result **或** ExecutionRecord.patchFile」（二选一未定）
- system-architecture.md §4 ExecutionRecord 不变式无 patchFile；§7 execution-record.ts 改动无 patchFile
- 问题：承载模型跨需求/架构不一致，patch 概念散落 UC-4/§3/§9 泳道无统一建模

### M2 [K] SessionContextResolver 入参含 gitPort 但职责无 git 操作
- §7 签名含 gitPort，但职责（fork→forkFrom / worktree→仅透传 / 深度校验）无 git 操作
- gitPort 冗余或职责描述遗漏——与 D-009 纯函数定位不一致

### M3 [K] crashed 重建赋值是否经 ExecutionRecord 收口方法（vs 裸赋值）
- §5 三分支 `status = crashed`；§7 注 crashed 判定上移 record-store
- record-store（Runtime）写 ExecutionRecord（Core aggregate）status 时是否裸赋值？aggregate 不变式守卫原则要求经模型方法

### M4 [K] SubagentIdentityData.forkDepth 写入守卫归属
- §4 forkDepth 可变字段，depth+1 经 bumpDepth 还是裸赋值？
- 深度 >10 拒绝校验（AC-1.3）在构造器内守卫还是 SessionContextResolver 外部校验？

## 视角2：状态正交性

### S1 [K] 跨 pi 实例并发时内存 running 无 finalized 的 subagent 被误判 crashed
- crashed 检测依赖「磁盘无 .finalized/.cancelled → crashed」
- 双 pi 实例并发：第二实例扫磁盘看不到第一实例内存 running record + 磁盘无 finalized → 误判 crashed
- UC-5 worktree reaper 层有 pid/时间戳判断，但 record 状态层无对应

### S2 [K] STATUS_PRIORITY 用途语义未明
- §5 crashed=failed=1 同级，二级 startedAt desc
- 文档未说 STATUS_PRIORITY 驱动什么（/list 排序？过滤？），无法判断同级是否掩盖 crashed 可见性

## 汇总

| 编号 | 类型 | 视角 | 优先级 |
|------|------|------|--------|
| M1 | F | 1 | 高 |
| M2 | K | 1 | 高 |
| M3 | K | 1 | 中 |
| M4 | K | 1 | 中 |
| S1 | K | 2 | 中-高 |
| S2 | K | 2 | 中 |
