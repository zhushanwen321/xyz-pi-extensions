---
phase: issues
verdict: APPROVED
machine_check: PASS
review_mode: parallel
---

# 审查报告 — issues（红队维度）

> 认知帧：站在「过度/不合理」反方质询，找可删/可降级对象。
> 输入：issues.md / system-architecture.md / decisions.md。
> 红队组在只读模式运行，本报告由主 agent 据红队 subagent 返回内容落盘。

## Verdict: APPROVED

未发现可阻断/可降级的过度设计。D-021/022/023/024 逐条 deletion test 结论均为「必要修复，非伪防御」。

## 过度设计发现（建议降级/删除）

无。

### #12 特别质询（D-021 pid 探活 + 连锁）

**必要性**：跨实例 crashed 误判是 D-004 共享目录架构的真实并发正确性问题，不做则双实例并发 `/list` 误标 crashed。纳入本身是 D-021 ask_user 拍板，按纪律不质询「是否纳入」。

**比例性（核心质询点）**：D-021 的 ~40 LOC alive-store 估算显著低估真实成本——连锁触发 8 issue AC 增量（#1/#2/#4/#6/#7/#9/#10/#12）+ 4 新决策 + 3 阻断级 F-gap（B2/B7/B8）。但构不成降级理由：
- D-021 在 DESIGN-IT-TWICE 3 方案中本身最小（A ~40 < B ~70 < C ~80），复用现有 sidecar 范式。
- 每个衍生修复都是真 bug 的必要防御（非 agent 自造伪复杂度）。
- 无更简单等效方案——B（周期心跳）合取依赖放大 D-017 失败面，C（三层仲裁）维护复杂度最高；用户已排除。

### D-022 / D-023 / D-024 逐条 deletion test

| 决策 | deletion test | 判定 |
|------|--------------|------|
| **D-022** collectPatch 失败保 worktree | 删掉 → collectPatch 失败仍 cleanup = patch 没生成 + worktree rm -rf + branch -D = 改动不可恢复销毁（B2 阻断）。**独立于 #12 存在**——任何 worktree run 都中招 | 真问题，非伪防御。单条件守卫（patchFailed→skip cleanup）最小正确 |
| **D-023** externalInstance 投影标志 | 删掉 → D-021 原写「标 __external」但 __external 非 ExecutionStatus 成员，STATUS_PRIORITY 无 key，消费方 switch 缺分支 → TUI 破损（B7 类型契约裂缝） | 真问题，非伪防御。独立字段 vs 重载 status，最小且类型安全 |
| **D-024** reaper 孤儿判据 + .alive 安全网 | 删掉 → reaper scan 跨实例看不到实例 A 内存 running record → 误删实例 A 活 worktree = rm -rf 正在跑的工作目录 + 改动全丢（B8，比 crashed 误判严重一个量级） | 真问题，非伪防御。孤儿判据=终态标记+无活 .alive，复用 #12 机制零新基础设施。reaper 安全底线而非镀金 |

**关键反证**：B2 的 collectPatch 数据黑洞是 finalize 时序 bug（D-017 范畴），**不依赖 #12 存在**——若降级 #12，B2 仍必修。说明连锁并非全由 D-021 制造，数条是固有缺陷被 tracing 揭露。

### 其余 issue deletion test（批量）

#1~#10：角色 B 已逐条跑删除测试，每条至少一个承重理由，无纯伪 issue。

**#11 ADR-001 修订**：红队最接近「伪 issue」——纯文档、删了不影响运行时。但已 P2 最低优先级（不抬升），BC-2 标「变更」需独立 ticket 防遗漏。建议可作 doc follow-up 注释而非 code issue，但非阻断，影响可忽略。

### 伪复杂度扫描

- AC-12.4（24h pid 复用兜底）：pid 复用是真实风险，24h 对长 session 务实。非伪复杂度。
- AC-12.8（crashed reason 区分）：单字符串差异，成本极低助 debug。非伪复杂度。
- AC-12.5（externalInstance cancel 无效）：跨实例所有权的真实约束描述。非自造逻辑。

## 比例性观察（非阻断，供主 agent 知情）

D-021 连锁的真实工程成本（跨 8 issue + 4 决策 + 3 阻断 F-gap）远超 issues.md 反复出现的「~40 LOC」框架表述。不构成降级理由（用户已拍板纳入、衍生修复皆必要），但主 agent 已据此在 #12 补 scope 注记，排期/工作量评估应以连锁全量而非 alive-store 单模块估算。

## 与对齐组冲突项

**无实质冲突**。红队认为 D-021 比例性可质询（成本被低估），对齐组必然判 #12 是上游 §5 已知盲区的必需覆盖（D-021 反哺合法）。两者方向一致：纳入必要，衍生修复真实。红队不主张推翻纳入，不触发 D-不可逆转 ask_user。

唯一轻微张力：#11（ADR 修订）红队倾向降级为 doc follow-up，对齐组按 BC-2「变更」标记保留为 issue。属可忽略的 P2 归属分歧，主 agent 裁决保留为 P2 issue（不造成伤害）。
