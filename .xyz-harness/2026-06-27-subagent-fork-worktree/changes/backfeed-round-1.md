---
phase: issues
round: 1
type: backfeed
---

# 反哺检查 Round 1 — 回扫上游（issues → architecture/decisions）

> Step 6b：审查 APPROVED 后，回扫 ①requirements / ②system-architecture 上游，记录本阶段产生的新决策/反哺是否需更新上游 .md。
> decisions.md 已即时 append D-021~D-024（Step 1/3-4），本文件记录对 system-architecture.md / requirements.md 的反哺修订。

## 反哺条目

### BF-1: ②system-architecture §5 已知盲区（S1）处置反转 [已应用]

- **来源**: D-021（issues 阶段，用户拍板 #12 从 P3 提升为本轮纳入，方案 A pid 探活）。
- **修订**: §5 line 131-133「跨 pi 实例 crashed 误判...本轮不处理」→ 「D-021 反哺为本轮处理（方案 A pid 探活）」。
- **状态**: ✅ 已编辑 system-architecture.md（含 alive-store 模块 + externalInstance 投影标志 + D-022/D-023/D-024 修复指向）。

### BF-2: ②system-architecture §8 git 边界表 GitPort 陈旧 [已应用]

- **来源**: tracing-round-1 角色 A 附带观察 + D-019（architecture 阶段删 GitPort）。
- **修订**: §8 line 246 git「经 GitPort」→ 「经 WorktreeManager 内部私有 gitRun helper（D-019 删 GitPort）」。
- **状态**: ✅ 已编辑。② 内部不一致（§6/§7 已是 gitRun，仅 §8 表漏改）已修正。

### BF-3: ②system-architecture §7 新增模块表缺 alive-store [已应用]

- **来源**: D-021（alive-store 是 #12 的新模块）。
- **修订**: §7 新增模块表加 `alive-store`（Runtime 执行域，~40 LOC，pid 探活标记）。
- **状态**: ✅ 已编辑。

### BF-4: ②system-architecture 是否需加 D-022/D-023/D-024 的架构层面映射？[评估：不必，issues 层足够]

- **评估**: D-022（collectPatch 失败保 worktree）是 finalizeRecord 时序的执行级约束，已在 §7 集成点表 + §10 D-017 之下，issues.md #7 AC-7.4 收口，不需改 §架构正文（§架构描述「best-effort」，issues AC 细化「失败保 worktree」是执行细节）。D-023（externalInstance 投影标志）已在 BF-1 的 §5 修订中提及。D-024（reaper 孤儿判据）是 WorktreeManager.scan 的执行级约束，issues.md #4 AC-4.4 + #9 AC-9.4 收口，不需改 §架构正文。
- **结论**: 不再改 §架构正文，issues AC 层足够承载这三个执行级修复。

## ①requirements 是否需更新？

- UC-7（崩溃标记）已覆盖 crashed 三分支；#12 的四分支扩展是 UC-7 的并发场景细化，不需改 UC-7（用例级不变）。
- F7/C6（fork 体积控制）在 D-018 已落实为 createBranchedSession 优先，requirements 层不变。
- **结论**: ①requirements 不需更新（用例级/功能级不变，#12 是并发正确性细化）。

## 结论

4 条反哺条目：BF-1/2/3 已应用（system-architecture.md 编辑），BF-4 评估为不必（issues AC 层足够），①requirements 不需更新。无 D-不可逆决策被推翻（D-021~D-024 均 D-可逆细化）。
