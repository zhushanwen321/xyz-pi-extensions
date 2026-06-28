---
verdict: CHANGES_REQUESTED
machine_check: PASS
dimension: redteam
---

# 红队审查报告 — architecture（必要性与比例性）

> fresh-context subagent，与对齐组隔离。反过度设计维度。

## Verdict

CHANGES_REQUESTED（1 阻断 + 1 可选改进）

## 过度设计发现

### 发现 1（阻断）：GitPort interface 抽象 — deletion test 未通过，建议降级

**deletion test**：
- 删掉：WorktreeManager 直接用 execFileSync("git")。**现有先例**：session-runner.ts:233 buildEnvBlock 已直接 execFileSync("git",["rev-parse",...]) 无 port，运行良好
- 证伪三连反驳：现有 tombstone-store/record-store 等 Runtime 模块测试不抽 FsPort 也能单测；git CLI 极稳定（requirements C 承认），seam 价值近零；interface 永远可后加
- D-011 标 D-不可逆 是误判——interface 抽象是高度可逆的实现细节，非架构方向

**建议降级**：删除 GitPort interface + RealGitPort（~160 LOC）。WorktreeManager 内部封装私有 gitRun helper。

### 发现 2（非阻断）：PatchCollector 该合并进 WorktreeManager

- §7/§8 已写"WorktreeManager 持有 PatchCollector"——当模块所有描述都是"被另一模块持有"时，它不是独立模块
- 变化轴重叠（都是 git 策略族）
- 建议作为 WorktreeManager.collectPatch 方法

### 发现 3-4（合理保留）：FinalizedMarker / WorktreeManager / SessionContextResolver 独立成模块 ✓；D-001/D-002/D-004/D-014 不可逆性检验 ✓

## 必须修改

1. 降级 GitPort（涉及 D-011 ask_user confirmed，转主 agent 裁决/ask_user）
