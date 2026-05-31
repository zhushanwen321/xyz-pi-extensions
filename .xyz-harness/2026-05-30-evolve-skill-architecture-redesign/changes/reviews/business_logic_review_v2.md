---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-31T17:00:00"
  target: "skills/evolve-apply/SKILL.md"
  verdict: pass
  summary: "第2轮审查：2条MUST FIX均已充分修复，v1的2条LOW（#3孤立备份、#4 pending状态）也一并解决，未引入新问题"

statistics:
  total_issues: 2
  must_fix: 0
  must_fix_resolved: 2
  low_new: 0
  info_new: 0

v1_issue_status:
  - id: 1
    severity: MUST_FIX
    v1_title: "Rollback 恢复失败时仍写入 history 记录 + 给出错误确认"
    v2_status: resolved
    v2_evidence: "ROLLBACK 步骤5 加 'STOP HERE. Do NOT proceed to steps 6-8. Do NOT update pending.json or history.jsonl.'；步骤6-8 加 '(only if step 4 succeeded)' 前置条件。三路分支均有明确退出点。"
  - id: 2
    severity: MUST_FIX
    v1_title: "Bash heredoc 写入 JSONL 在 instruction 含换行时产生非法多行记录"
    v2_status: resolved
    v2_evidence: "APPLY 步骤7 和 ROLLBACK 步骤7 均改为 python3 -c + json.dumps()，自动转义换行和特殊字符。附注 'Escape single quotes in values'。"
  - id: 3
    severity: LOW
    v1_title: "备份成功但 edit 失败时残留孤立备份文件"
    v2_status: resolved
    v2_evidence: "APPLY 步骤4 增加 'clean up backup file (rm <backupPath>)' 指令。"
  - id: 4
    severity: LOW
    v1_title: "Rollback 成功后 pending.json 状态不同步"
    v2_status: resolved
    v2_evidence: "ROLLBACK 步骤6 增加 'Find the suggestion matching the suggestionId and change its status back to pending'。"
  - id: 5
    severity: LOW
    v1_title: "daily-reports 目录为空时无显式处理"
    v2_status: open
    v2_note: "属于 evolve-report SKILL.md，本轮审查范围不含此文件，不阻塞。"
  - id: 6
    severity: INFO
    v1_title: "0-indexed 展示对非技术用户可能困惑"
    v2_status: open
    v2_note: "不影响正确性，保留观察。"
  - id: 7
    severity: INFO
    v1_title: "pending.json 全量覆写语义"
    v2_status: open
    v2_note: "设计选择，无需修改。"
---

# 业务逻辑审查 v2

## 评审记录
- 评审时间：2026-05-31 17:00
- 评审类型：业务逻辑审查（第 2 轮，验证修复）
- 评审对象：skills/evolve-apply/SKILL.md
- 审查范围：验证 v1 的 2 条 MUST FIX 是否充分修复，检查是否引入新问题

## 修复验证

### MUST FIX #1（v1-#1）：Rollback 恢复失败时仍写入假记录 — ✅ 已修复

**v1 问题**：ROLLBACK 步骤 5（备份不存在）仅输出提示信息，没有中止后续步骤。步骤 6-7 仍会写入 rollback history 记录和错误确认信息。

**当前文本**（ROLLBACK Mode 步骤 4-8）：

```
步骤4: If backup exists → cp 恢复 → 验证 exit code → 失败 ABORT / 成功 commit
步骤5: If backup missing → "Cannot auto-restore..." STOP HERE.
       Do NOT proceed to steps 6-8. Do NOT update pending.json or history.jsonl.
步骤6: (only if step 4 succeeded) → 更新 pending.json
步骤7: (only if step 4 succeeded) → 追加 history.jsonl
步骤8: (only if step 4 succeeded) → 确认信息
```

**三路分支验证**：

| 场景 | 行为 | history 写入 | pending 更新 | 确认信息 | 结果 |
|------|------|-------------|-------------|---------|------|
| 备份存在 + cp 成功 | → commit → 步骤 6-8 | ✅ 写入 rollback 记录 | ✅ status→pending | ✅ 正确确认 | ✅ |
| 备份存在 + cp 失败 | → ABORT | ✅ 步骤 7 前置条件不满足 | ✅ 步骤 6 前置条件不满足 | ✅ 不触发 | ✅ |
| 备份不存在 | → STOP HERE | ✅ 显式禁止 | ✅ 显式禁止 | ✅ 不触发 | ✅ |

**判定**：修复充分。双重保护（ABORT 语义 + 步骤 6-8 的 "only if step 4 succeeded" 前置条件）确保恢复失败时不写入任何假记录。

---

### MUST FIX #2（v1-#2）：JSONL heredoc 多行损坏 — ✅ 已修复

**v1 问题**：APPLY 步骤 7 使用 bash heredoc 写入 JSONL，instruction 含换行时产生非法多行记录。

**当前文本**（APPLY 步骤 7）：

```bash
python3 -c "import json; print(json.dumps({'timestamp':'<ISO>','action':'apply',
'suggestionId':'<id>','targetPath':'<path>','backupPath':'<backup>',
'instruction':'<instruction text>','title':'<title>',
'commitSha':'<sha>'}, ensure_ascii=False))" >> history.jsonl
```

附注："Escape single quotes in values before passing to python -c."

**验证**：

| 检查项 | 结果 |
|--------|------|
| 换行转义 | ✅ `json.dumps()` 自动将 `\n` 转义为 `\\n`，保证单行输出 |
| Unicode 安全 | ✅ `ensure_ascii=False` 保留中文原文 |
| ROLLBACK 同步修复 | ✅ ROLLBACK 步骤 7 也使用相同的 `python3 -c` 模式 |
| 单引号冲突提示 | ✅ 附注提醒转义单引号 |

**边界场景**：

- instruction 含换行 → `json.dumps` 转为 `\\n` → 单行 JSON ✅
- instruction 含双引号 → `json.dumps` 转为 `\\"` → 有效 JSON ✅
- instruction 含反斜杠 → `json.dumps` 转为 `\\\\` → 有效 JSON ✅
- instruction 含单引号 → 需 LLM 手动转义（附注已提醒）→ 可接受风险 ✅

**判定**：修复充分。`json.dumps()` 是处理此问题的正确方案，比 heredoc 手动转义可靠得多。

---

## v1 LOW 级问题附带修复检查

### LOW #3（孤立备份文件）— ✅ 顺便修复

APPLY 步骤 4："If edit fails → clean up backup file (`rm "<backupPath>"`), ABORT"

edit 失败时主动删除刚创建的备份文件，消除孤立残留。

### LOW #4（pending.json 状态不同步）— ✅ 顺便修复

ROLLBACK 步骤 6："Find the suggestion matching the suggestionId and change its status back to `pending`"

rollback 成功后将 pending.json 中对应建议恢复为 pending，用户 list 时状态与实际文件一致。

---

## 新问题检查

对修复后的完整 ROLLBACK 和 APPLY 流程进行二次遍历，检查是否引入新问题：

| 检查项 | 结果 |
|--------|------|
| ROLLBACK 步骤 4 cp 失败后，ABORT 是否被步骤 6-8 严格执行 | ✅ 步骤 6-8 均有 "(only if step 4 succeeded)" |
| ROLLBACK 步骤 5 STOP 是否覆盖所有后续副作用 | ✅ 显式列出 "Do NOT update pending.json or history.jsonl" |
| APPLY 步骤 7 python -c 中单引号嵌套风险 | ✅ 有转义提示，可接受。如需更健壮可用 env var 传值，但当前方案已足够 |
| APPLY 步骤 4 edit 失败清理备份时 rm 也失败 | ⚪ 极端边界，不影响数据一致性（最多是孤立备份文件），不构成新问题 |
| ROLLBACK 步骤 6 将 status 改回 pending 后，该建议可被再次 apply | ✅ 符合语义——回滚后建议回到可应用状态 |

**未发现新的 MUST FIX 或 LOW 级问题。**

---

## 结论

v1 的 2 条 MUST FIX 均已充分修复，修复方案正确且无遗漏。v1 的 2 条 LOW 级问题也一并解决。未引入新问题。

**verdict: pass**
