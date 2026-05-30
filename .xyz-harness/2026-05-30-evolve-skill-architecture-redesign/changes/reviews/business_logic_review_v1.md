---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-31T16:00:00"
  target: "evolve-daily/src/index.ts + skills/evolve/SKILL.md + skills/evolve-apply/SKILL.md + skills/evolve-report/SKILL.md"
  verdict: fail
  summary: "业务逻辑审查第1轮，2条MUST FIX（rollback失败时写入假记录 + JSONL heredoc多行字段损坏），需修改后重审"

statistics:
  total_issues: 7
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "skills/evolve-apply/SKILL.md:ROLLBACK Mode 步骤5-7"
    title: "Rollback 恢复失败时仍写入 history 记录 + 给出错误确认"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "skills/evolve-apply/SKILL.md:APPLY Mode 步骤7"
    title: "Bash heredoc 写入 JSONL 在 instruction 含换行时产生非法多行记录"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "skills/evolve-apply/SKILL.md:APPLY Mode 步骤3-4"
    title: "备份成功但 edit 失败时，backups/ 中残留孤立备份文件"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "skills/evolve-apply/SKILL.md:ROLLBACK Mode"
    title: "Rollback 成功后未更新 pending.json 中对应建议的状态"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "skills/evolve-report/SKILL.md:Show Report"
    title: "daily-reports 目录为空时无显式处理（依赖 LLM 自行判断空输出）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "skills/evolve-apply/SKILL.md:LIST Mode"
    title: "0-indexed 展示（[#0]）对非技术用户可能困惑"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "skills/evolve/SKILL.md:步骤5"
    title: "pending.json 全量覆写语义明确，已通过 history.jsonl 补偿"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 业务逻辑审查 v1

## 评审记录
- 评审时间：2026-05-31 16:00
- 评审类型：业务逻辑审查（编码评审子维度）
- 评审对象：evolve-daily/src/index.ts + skills/evolve/SKILL.md + skills/evolve-apply/SKILL.md + skills/evolve-report/SKILL.md

## 审查方法

逐用例追踪主路径、异常路径、数据流完整性。用模拟业务数据验证执行路径是否闭环。

## 用例逐一审查

### UC-1: 每日自动数据收集 — ✅ 主路径正确

**代码** (`evolve-daily/src/index.ts`，36 行):

```
session_start → existsSync(YYYY-MM-DD.json) → 不存在 → pi.exec(python3 analyze.py --output <path>) → catch 错误
```

| 检查项 | 结果 |
|--------|------|
| 监听 `session_start` | ✅ `pi.on("session_start", ...)` |
| 检查当天报告是否存在 | ✅ `existsSync(reportPath)` |
| 不存在则执行 analyzer | ✅ `pi.exec("python3", [..., "--output", reportPath])` |
| 幂等（已存在跳过） | ✅ early return |
| 失败不阻塞 session | ✅ try-catch + console.error |
| 路径与 spec 一致 | ✅ `~/.pi/agent/evolution-data/daily-reports/YYYY-MM-DD.json` |

**模拟数据**：
- Day1 首次启动 → `2026-05-30.json` 不存在 → 执行 analyzer → 文件生成 ✅
- Day1 二次启动 → 文件已存在 → 跳过 ✅
- Day2 启动 → `2026-05-31.json` 不存在 → 执行 ✅
- Python 脚本不存在 → `pi.exec` 失败 → catch → session 正常 ✅

**无问题。**

---

### UC-2: 手动触发进化分析 — ✅ 主路径正确

**SKILL.md** (`skills/evolve/SKILL.md`):

| 检查项 | 结果 |
|--------|------|
| 触发词覆盖 | ✅ `/evolve`, `evolve`, `进化分析`, `分析使用模式` |
| 数据源列表完整 | ✅ 6 个数据源与 spec FR-2.2 一致 |
| 无数据场景处理 | ✅ "Do NOT proceed to generate suggestions" |
| since=Nd 参数解析 | ✅ 步骤1 说明了参数解析逻辑 |
| 建议格式与 spec 数据模型一致 | ✅ 包含 id/target/targetPath/severity/confidence/title/description/rationale/instruction/status |
| targetPath 约束 | ✅ "MUST be under ~/.pi/agent/ and end with .md" |
| 写入路径正确 | ✅ `~/.pi/agent/evolution-data/suggestions/pending.json` |

**模拟数据**：
- `/evolve` → 读取最近 7 天 daily/*.json + daily-reports/*.json → LLM 分析 → 生成 5 条建议 → write pending.json ✅
- `/evolve since=14d` → 读取 14 天数据 ✅
- 无数据 → "No usage data available..." ✅
- 旧 pending.json 有 3 条 pending + 1 条 applied → 全量覆写 → 新建议替换旧 pending ✅（applied 建议的历史在 history.jsonl 保留）

**无问题。** pending.json 全量覆写是设计选择，applied 建议通过 history.jsonl 保留。记录为 INFO（#7）。

---

### UC-3: 应用进化建议 — ⚠️ 有问题

**APPLY 模式** (`skills/evolve-apply/SKILL.md`):

**主路径追踪**：

```
读取 pending.json → 验证索引 N → cp 备份 → edit 目标文件 → git commit → 更新 pending.json → 追加 history.jsonl
```

| 检查项 | 结果 |
|--------|------|
| 读取 pending.json | ✅ |
| 验证索引 + 状态 | ✅ "validate index N exists and status is 'pending'" |
| cp 备份到 backups/ | ✅ mkdir -p + cp |
| edit/write 修改文件 | ✅ |
| git commit（失败继续） | ✅ "If commit fails → CONTINUE" |
| 更新 pending.json 状态为 applied | ✅ write 工具覆写 |
| 追加 history.jsonl | ✅ bash heredoc |
| 确认信息 | ✅ |

**异常路径追踪**：

| 异常路径 | 预期行为 | 实际行为 | 结果 |
|---------|---------|---------|------|
| E1: edit 失败 | 说明原因，保持 pending，不做任何写入 | 步骤4明确说 ABORT + 不更新 pending/history | ✅ 正确 |
| E2: git commit 失败 | 继续，commitSha 为空 | 步骤5 "CONTINUE" | ✅ 正确 |
| E3: 备份失败 | 中止 apply | 步骤3 "ABORT" | ✅ 正确 |
| 备份成功但 edit 失败 | — | 已有备份文件残留 | ⚠️ LOW #3 |

**MUST FIX #2 — history.jsonl heredoc 多行 instruction 损坏**：

SKILL.md 步骤7 使用 bash heredoc 追加 JSONL 记录：

```bash
cat >> ~/.pi/agent/evolution-data/history.jsonl << 'EOF'
{"timestamp":"...","instruction":"<escaped>",...}
EOF
```

`instruction` 字段定义为 "Step-by-step modification instruction"，高概率包含多行内容（例如："Add the following rules:\n1. Rule A\n2. Rule B"）。LLM 从 pending.json 读取 instruction 后，在 heredoc 中写入时：
- 如果保留原始换行 → JSON 跨多行 → 非法 JSONL
- 如果正确转义为 `\n` → 正确

风险点：SKILL.md 没有明确要求转义换行符。heredoc 模板中的 `<escaped>` 注释不足以指导 LLM 正确处理。

**影响**：损坏的 history.jsonl 记录导致下游回滚（`tail -1` 读到多行 JSON）和报告解析失败。

**修复方向**：使用 `python3 -c` 安全编码 JSON 后追加，或在步骤中明确要求 "instruction 字段中的换行必须转义为 `\n`，确保整条记录为单行 JSON"。

---

### UC-4: 跳过进化建议 — ✅ 正确

| 检查项 | 结果 |
|--------|------|
| 读取 pending.json | ✅ |
| 验证索引 + 状态 | ✅ |
| 更新状态为 rejected | ✅ |
| 写回 pending.json | ✅ |
| 确认信息 | ✅ |

**无问题。**

---

### UC-5: 回滚进化建议 — ❌ 有 MUST FIX

**ROLLBACK 模式** (`skills/evolve-apply/SKILL.md`):

**主路径追踪**：

```
读取 history.jsonl → 找最近未回滚的 apply 记录 → 检查备份文件 → cp 恢复 → git commit → 追加 rollback 记录 → 确认
```

| 检查项 | 结果 |
|--------|------|
| 读取 history.jsonl | ✅ |
| 找最近未回滚的 apply | ✅ |
| 首选 cp 备份恢复 | ✅ 不使用 git revert |
| 恢复后 git commit | ✅ |
| 追加 rollback 记录 | ✅ |
| 确认信息 | ✅ |

**MUST FIX #1 — 恢复失败时仍写入假记录**：

步骤 5（备份不存在）和步骤 6（追加 rollback 记录）是顺序执行关系，缺少分支退出。恢复失败时的实际执行路径：

```
步骤3: backupPath 不存在
步骤5: 告诉用户 "Cannot auto-restore..."  ← 只输出信息，没有 abort
步骤6: 追加 rollback 记录到 history.jsonl  ← 写入了虚假记录
步骤7: 确认 "Rolled back: <title>. File restored from backup."  ← 确认信息错误
```

**后果**：
1. history.jsonl 中存在一条 rollback 记录，但文件并未恢复
2. 下次 rollback 会跳过该 apply 记录（已被 "回滚"）
3. 用户收到错误确认，以为操作成功

**修复方向**：步骤 5 后加 "→ STOP, do not proceed to step 6/7"。恢复失败时不应追加任何 history 记录。

**LOW #4 — rollback 后 pending.json 状态不同步**：

rollback 成功后，pending.json 中对应建议的 status 仍为 "applied"。用户执行 `/evolve-apply list` 看到的是 "applied"，而实际文件已恢复原状。这不影响功能（history.jsonl 是回滚的事实来源），但可能造成用户困惑。建议 rollback 成功后检查 pending.json 中是否存在该建议，如有则将状态改为 "rolled_back" 或恢复为 "pending"。

---

### UC-6: 查看报告 — ✅ 基本正确

| 检查项 | 结果 |
|--------|------|
| 无参数显示今天报告 | ✅ |
| 指定日期显示对应报告 | ✅ |
| `--list` 列出可用报告 | ✅ |
| 仅读 .json 文件 | ✅ 注释说明忽略 .md legacy 文件 |

**LOW #5**：SKILL.md 未显式处理 daily-reports 目录为空的场景。`ls *.json` 返回空输出时，依赖 LLM 自行判断并告知用户。建议在步骤中增加 "如果无可用报告，告知用户 'No reports available. Wait for evolve-daily to generate the first report.'"

---

### UC-7: 查看统计数据 — ✅ 正确

读 daily/*.json，LLM 自行汇总展示。逻辑简单，无问题。

---

### UC-8: 系统清理和迁移 — N/A

纯手动操作步骤，无代码逻辑。

---

## 数据流完整性验证

### 主数据流：evolve → pending.json → evolve-apply → history.jsonl

```
/evolve
  → LLM 读 daily/*.json + daily-reports/*.json + history.jsonl
  → LLM 分析 + 生成建议
  → write pending.json（全量覆写）
  ✅ 数据源到产出闭环

/evolve-apply apply N
  → read pending.json
  → cp 备份到 backups/
  → edit 目标文件
  → git commit
  → write pending.json（status → applied）
  → append history.jsonl
  ✅ pending → backups + 目标文件 + history 闭环

/evolve-apply rollback
  → read history.jsonl
  → cp 从 backups/ 恢复
  → git commit
  → append history.jsonl（rollback 记录）
  ⚠️ 步骤5失败时仍写入假记录 → 数据不一致（MUST FIX #1）
```

### 模拟业务数据验证

**场景：完整生命周期**

```
Day 1:  安装 evolve-daily，启动 Pi → 生成 2026-05-30.json ✅
Day 7:  /evolve → pending.json 含 5 条 pending 建议 ✅
Day 7:  /evolve-apply apply 0 → CLAUDE.md 修改 + 备份 + history ✅
Day 7:  /evolve-apply skip 1 → rejected ✅
Day 8:  /evolve-apply rollback → 从备份恢复 + history rollback 记录 ✅
Day 8:  /evolve → 新 pending.json（旧 applied/rejected 从 pending 视图消失）
        → history.jsonl 仍有完整记录 ✅
Day 8:  /evolve-report → 读取 daily-reports/*.json 展示 ✅
```

**场景：异常路径**

```
/evolve-apply apply 3 → edit 失败 → pending 保持不变 ✅
                           但 backups/ 中有孤立备份文件 ⚠️ LOW #3

/evolve-apply rollback → backupPath 不存在 → 写入假 rollback 记录 ❌ MUST FIX #1
```

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | skills/evolve-apply/SKILL.md:ROLLBACK 步骤5-7 | Rollback 恢复失败（备份不存在）时，步骤6仍追加 rollback 记录到 history.jsonl，步骤7确认信息说"File restored"但实际未恢复。假记录导致该 apply 被标记为"已回滚"，后续无法再次回滚 | 步骤5后加 "→ STOP. Do not write history record or confirmation." 恢复失败时只告知用户原因 |
| 2 | MUST FIX | skills/evolve-apply/SKILL.md:APPLY 步骤7 | Bash heredoc 写入 JSONL 记录时，`instruction` 字段含多行内容会破坏 JSONL 格式（一条记录跨多行） | 改用 `python3 -c "import json; ..."` 安全编码后追加，或在步骤中明确要求 "instruction 中的换行必须转义为 \\n，确保单行 JSON" |
| 3 | LOW | skills/evolve-apply/SKILL.md:APPLY 步骤3-4 | 备份成功后 edit 失败 → backups/ 中残留孤立备份文件 | edit 失败时删除刚创建的备份文件，或记录为可接受行为（不影响功能） |
| 4 | LOW | skills/evolve-apply/SKILL.md:ROLLBACK | Rollback 成功后 pending.json 中建议状态仍为 "applied"，用户 list 时看到的状态与实际文件不一致 | Rollback 成功后检查 pending.json，将对应建议状态更新为反映已回滚 |
| 5 | LOW | skills/evolve-report/SKILL.md:Show Report | 未显式处理 daily-reports/ 为空的场景 | 增加步骤："如果 ls 返回空，告知用户 'No reports available yet.'" |
| 6 | INFO | skills/evolve-apply/SKILL.md:LIST Mode | 0-indexed 展示 `[#0]` 对非技术用户可能困惑 | 可考虑 1-indexed 展示但内部映射为 0-indexed |
| 7 | INFO | skills/evolve/SKILL.md:步骤5 | pending.json 全量覆写，已 applied/rejected 的建议从 pending 视图消失，但 history.jsonl 保留完整记录 | 无需修改，当前行为合理 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 结论

需修改后重审。2 条 MUST FIX 均集中在 evolve-apply SKILL.md：
1. Rollback 失败路径写入虚假历史记录（数据语义错误）
2. Apply 的 JSONL 写入在多行 instruction 时损坏数据（数据丢失）

### Summary

业务逻辑审查完成，第1轮，2条MUST FIX（rollback假记录 + JSONL多行损坏），需修改后重审。
