---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-31T12:00:00"
  target: ".xyz-harness/2026-05-30-evolve-skill-architecture-redesign/spec.md"
  verdict: pass
  summary: "第 2 轮审查通过。2 条 MUST FIX 均已充分修复，rollback 策略清晰可靠。apply 流程的备份失败场景存在隐含假设但可接受。1 条新 LOW 级发现。"

statistics:
  total_issues: 4
  must_fix: 0
  low: 1
  info: 0
  v1_resolved: 2
  v1_downgraded: 3

v1_issue_tracking:
  - id: 1
    v1_severity: MUST_FIX
    resolution: RESOLVED
    resolution_detail: "FR-3.3 已补充完整失败处理策略，见下方分析"
  - id: 2
    v1_severity: MUST_FIX
    resolution: RESOLVED
    resolution_detail: "FR-3.5 rollback 降级策略已明确，见下方分析"
  - id: 3
    v1_severity: LOW
    resolution: RESOLVED
    resolution_detail: "AC-2 已改为具体输入/输出对（since=14d, 分析 skill），可量化验证"
  - id: 4
    v1_severity: LOW
    resolution: RESOLVED
    resolution_detail: "FR-1.3 补充了幂等写入说明，并发场景有了明确结论"
  - id: 5
    v1_severity: INFO
    resolution: RESOLVED
    resolution_detail: "AC-2 补充了格式最低标准（suggestions 非空、必需字段）"

issues:
  - id: 6
    severity: LOW
    location: "spec.md:FR-3.3"
    title: "apply 流程中 backup (cp) 失败的处置未显式定义"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-31 12:00
- 评审类型：spec 第 2 轮审查（验证 v1 MUST FIX 修复 + 新问题扫描）
- 评审对象：`.xyz-harness/2026-05-30-evolve-skill-architecture-redesign/spec.md`

## v1 MUST FIX 修复验证

### Issue #1: FR-3.3 apply 操作失败场景未定义 → **RESOLVED**

**v1 问题**：apply 涉及 4 步（edit → cp backup → git commit → 更新状态），部分失败时行为未定义。

**当前 spec 修复内容**（FR-3.3 失败处理段落）：

> - 文件修改失败时（edit 报错、输出为空等），LLM 向用户说明原因，保持 pending 状态，不做任何写入
> - git commit 失败不影响 apply 结果（文件已修改成功，只是未提交）
> - history.jsonl 记录时 commitSha 为空

**验证结论**：修复充分。理由：

1. **主路径清晰**：edit 成功 → applied，commit 失败 → applied（commitSha 空），状态一致
2. **失败安全**：edit 失败 → 不写入任何状态，pending.json 不变，用户可以重试
3. **可追溯性**：commitSha 为空的 history 记录保留了"文件已修改但未提交"的中间态，不会丢失信息
4. **与 rollback 衔接**：即使 commit 失败，backup 已存在（cp 在 edit 之前），rollback 可以正常工作

唯一残留点：backup (cp) 失败的场景隐含在"文件修改失败时...不做任何写入"中（LLM 会把 backup 失败视为整体失败），但未显式说明。见 Issue #6。

### Issue #2: FR-3.5 rollback 降级逻辑不完整 → **RESOLVED**

**v1 问题**：cp 备份恢复和 git revert 的优先级关系不明确，revert 冲突时行为未定义。

**当前 spec 修复内容**（FR-3.5 完整重写）：

> - **首选 cp 备份恢复**：从 backups/ 目录恢复原文件，这是最可靠的手段
> - git revert 不作为恢复手段（可能因后续 commit 冲突），仅作为参考信息展示给用户
> - **失败处理**：备份文件不存在时，向用户说明无法自动恢复，建议手动 git 检查

**验证结论**：修复充分。理由：

1. **优先级明确**：cp 备份是唯一恢复手段，git revert 降级为参考信息，消除了歧义
2. **技术正确**：git revert 在有后续 commit 时可能冲突，不适合作为自动恢复手段。cp 备份是最可靠的
3. **兜底完整**：备份不存在时向用户报告，不尝试猜测或自动操作
4. **决策合理**：把 git revert 从"恢复手段"降级为"参考信息"是正确的工程决策，避免了一个高复杂度的自动冲突解决场景

## v1 LOW/INFO 问题验证

### Issue #3 (LOW → RESOLVED)

AC-2 已改为具体输入/输出对验证：`/evolve since=14d` → "读取不少于 14 天数据"，`/evolve 分析 skill` → "输出聚焦 skill 维度而非全部维度"。可量化，可测试。

### Issue #4 (LOW → RESOLVED)

FR-1.3 补充了"并发执行不冲突（后写入者覆盖，内容一致）"的幂等性说明。理由合理——同一日期的数据分析结果是确定性的，后写入者覆盖不会丢失信息。

### Issue #5 (INFO → RESOLVED)

AC-2 补充了格式最低标准："suggestions 数组非空，每条包含 id/title/targetPath/status 必需字段"。不阻塞实现，但为后续迭代提供了验收基线。

## 新问题扫描

### Issue #6: apply 流程中 backup 失败的处置隐含但未显式

**位置**：FR-3.3
**严重度**：LOW
**描述**：apply 流程是 `cp 备份 → edit 文件 → git commit → 更新状态`。spec 的失败处理只显式提到了"文件修改失败"和"git commit 失败"两种场景。如果 `cp` 备份步骤失败（磁盘满、权限不足等），spec 没有显式说是否应中止 apply。

**当前隐含逻辑**：失败处理说"文件修改失败时...不做任何写入"。作为 Skill，LLM 大概率会把 backup 失败视为流程失败并中止。但"大概率"不是"确定"。

**影响评估**：如果 backup 失败后 apply 继续执行，rollback 时将无法恢复（FR-3.5 的"备份不存在"兜底会触发）。功能不会损坏，但用户体验降级。

**建议**：在 FR-3.3 失败处理中补充一句："备份失败时中止 apply，保持 pending 状态，等同于文件修改失败处理"。不阻塞本轮 pass。

## 修复是否引入新问题

逐项检查 spec 修改的影响范围：

| 检查项 | 结论 |
|--------|------|
| FR-3.3 失败处理与 AC-3 一致性 | ✅ AC-3 的验收标准覆盖了"apply 成功"和"rollback 成功"两个正向路径，失败路径不在 AC scope 内（由 SKILL.md prompt 质量保证），不矛盾 |
| FR-3.5 rollback 简化后是否丢失能力 | ✅ git revert 的能力并未被删除——"作为参考信息展示给用户"意味着 LLM 仍然会告诉用户有 revert 选项，只是不自动执行。用户可以手动 revert |
| 失败处理策略与数据模型一致性 | ✅ history.jsonl 的 commitSha 字段可以是 undefined（commit 失败时），与数据模型定义一致 |
| FR-1.3 幂等性假设是否合理 | ✅ Python analyzer 对同一天的数据做确定性分析，输出结果相同，幂等写入的假设成立 |

## 结论

**PASS**。v1 的 2 条 MUST FIX 已充分修复：

- FR-3.3 的失败处理策略覆盖了两个关键分支（edit 失败 → 中止；commit 失败 → 继续），状态转换一致
- FR-3.5 的 rollback 策略简化为 cp 备份恢复 + 兜底报告，消除了 git revert 冲突的复杂性

1 条新 LOW 级发现（backup 失败显式化），不阻塞实现。
