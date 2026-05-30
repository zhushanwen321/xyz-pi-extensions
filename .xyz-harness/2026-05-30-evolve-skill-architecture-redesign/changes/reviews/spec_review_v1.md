---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-31T10:00:00"
  target: ".xyz-harness/2026-05-30-evolve-skill-architecture-redesign/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，2条MUST FIX（apply 失败场景未定义、rollback 降级逻辑不完整），需补充后重审"

statistics:
  total_issues: 5
  must_fix: 2
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-3.3"
    title: "apply 操作失败场景未定义，部分失败时状态不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-3.5"
    title: "rollback 降级逻辑不完整，两个恢复手段的关系未明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "spec.md:AC-2"
    title: "AC-2 验收标准不够可量化"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md:FR-1.3"
    title: "fire-and-forget analyzer 缺少并发保护"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: INFO
    location: "spec.md:Complexity Assessment"
    title: "SKILL.md prompt 质量风险未被充分评估"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-31 10:00
- 评审类型：计划评审（spec 完整性专项）
- 评审对象：`.xyz-harness/2026-05-30-evolve-skill-architecture-redesign/spec.md`

## 逐项检查

### 1. Spec 完整性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目标明确 | ✅ | 一段话可概括：将 evolve 从 ~1500 行 extension 改为 3 个 skill + 1 个 hook extension |
| 范围合理 | ✅ | 边界清晰：不动 usage-tracker、不修改 Python analyzer、不修改数据目录结构 |
| AC 可量化 | ⚠️ | 大部分 AC 可测试，但 AC-2 "自然语言参数被正确理解" 无法明确判定 pass/fail（见 #3） |
| [待决议] 项 | ✅ | 无 |
| 数据模型 | ✅ | pending.json 和 history.jsonl 格式已定义，与现有格式兼容 |

### 2. 架构合规（对照项目 CLAUDE.md）

| 检查项 | 结果 | 说明 |
|--------|------|------|
| Skill vs Extension 边界 | ✅ | LLM 驱动的分析/展示用 Skill，自动化 hook 用 Extension，职责划分合理 |
| 目录结构 | ✅ | `skills/evolve*/SKILL.md` + `evolve-daily/` extension 符合项目规范 |
| 依赖约束 | ✅ | evolve-daily 不引入新依赖，只依赖 Pi Extension API + Node.js 内置模块 |
| 数据目录 | ✅ | `~/.pi/agent/evolution-data/` 路径不变，与 usage-tracker 兼容 |

### 3. 需求覆盖完整性

| FR | 有对应 AC | AC 可测试 | 说明 |
|----|----------|----------|------|
| FR-1 每日自动收集 | AC-1 | ✅ | 5 项 checklist，场景覆盖充分 |
| FR-2 /evolve 分析 | AC-2 | ⚠️ | "自然语言参数被正确理解"模糊（见 #3） |
| FR-3 /evolve-apply | AC-3 | ⚠️ | 正常路径可测试，但失败路径未定义（见 #1、#2） |
| FR-4 /evolve-report | AC-4 | ✅ | 3 项 checklist，场景简单明确 |
| FR-5 清理 | AC-5 | ✅ | 3 项 checklist，验证点明确 |
| FR-6 创建 Skill/Extension | — | — | FR-6 是实现步骤，无独立 AC，由 AC-1~5 间接覆盖 |

### 发现的问题

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 1 | MUST FIX | FR-3.3 (apply 操作) | apply 涉及 4 个步骤：edit 文件 → cp 备份 → git commit → 更新 pending.json/history.jsonl。任何一个步骤都可能失败，但 spec 未定义失败时的行为。例如：edit 成功但 git commit 失败时，pending.json 是否应更新为 applied？history.jsonl 是否应记录（无 commitSha）？文件已经改了但没有 commit，用户如何恢复？这种歧义会导致 LLM 在执行时做出不一致决策。 | 在 FR-3.3 中增加失败场景处理策略，建议：(a) commit 失败时仍记录 history.jsonl（commitSha 为空），pending.json 标记为 applied 并附注 commit 失败；(b) 或定义回滚策略——还原文件修改，保持 pending 状态。选择哪种策略由 spec 作者决定，但必须明确。 |
| 2 | MUST FIX | FR-3.5 (rollback) | spec 描述"有备份文件 → cp 恢复"和"有 commitSha → 尝试 git revert"，但未说明两者是二选一还是顺序执行。更关键的是：git revert 可能因后续 commit 产生冲突，此时行为未定义。如果 revert 失败但备份可用，是否用备份覆盖？如果两者都失败呢？ | 明确 rollback 的降级策略：建议优先 cp 备份恢复（简单可靠），git revert 作为辅助信息（记录到 history.jsonl 但不阻塞 rollback）。同时说明 revert 冲突时的处理。 |
| 3 | LOW | AC-2 | "自然语言参数被正确理解"无法量化验证。什么算"正确理解"没有标准——LLM 可能对同一个指令给出不同的分析范围。 | 建议改为具体测试场景：`/evolve since=14d` → 读取 14 天数据而非默认 7 天；`/evolve 分析 skill` → 输出聚焦 skill 维度而非全部维度。用输入/输出对替代"正确理解"的模糊描述。 |
| 4 | LOW | FR-1.3 | fire-and-forget 执行 Python analyzer，如果用户快速连续启动多个 session（或 session 快速重启），可能同时触发多个 analyzer 进程。虽然概率低，但可能导致输出文件写入冲突。 | 建议在 FR-1.3 或 FR-1.1 中补充：执行前检查 analyzer 进程是否已在运行（如 PID lock file），避免并发执行。 |
| 5 | INFO | Complexity Assessment | "低复杂度"的判断基本合理，但 spec 本身提到"SKILL.md 的 prompt 质量"是最大风险点，却没有对应的风险缓解措施或质量标准。作为 Skill，LLM 能否稳定产出符合格式的建议，直接影响功能可用性。 | 考虑在 Constraints 或单独的 "风险" 章节中，补充 prompt 质量的最低标准（如：suggestions 数组非空、每个 suggestion 包含必需字段）。这不阻塞实现，但有助于后续迭代。 |

### 结论

需修改后重审。

Spec 的目标、范围、架构方向都没问题，核心风险集中在 FR-3（apply/rollback）的失败场景处理。这两个操作涉及文件修改和状态变更，部分失败时如果行为不确定，会导致 pending.json、history.jsonl 和实际文件之间的不一致——这在生产中会直接破坏用户信任。

### Summary

Spec 评审完成，第1轮，2条MUST FIX（apply 失败场景 + rollback 降级逻辑），需补充失败处理策略后重审。
