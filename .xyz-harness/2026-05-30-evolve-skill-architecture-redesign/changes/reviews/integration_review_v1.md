---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-31T17:30:00"
  target: "evolve-daily/src/index.ts + skills/evolve/SKILL.md + skills/evolve-apply/SKILL.md + skills/evolve-report/SKILL.md"
  verdict: fail
  summary: "集成审查第1轮，1条MUST FIX（ROLLBACK错误路径未中止，污染pending.json语义），需修改后重审"

statistics:
  total_issues: 4
  must_fix: 1
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "skills/evolve-apply/SKILL.md:ROLLBACK Mode 步骤5→6→8"
    title: "ROLLBACK 备份缺失时步骤5未中止流程，步骤6/8仍执行导致pending.json语义错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "skills/evolve/SKILL.md:步骤5 ↔ skills/evolve-apply/SKILL.md:ROLLBACK 步骤6"
    title: "evolve 全量覆写 pending.json 后，rollback 步骤6按 suggestionId 查找可能落空"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "skills/evolve-report/SKILL.md:Show Report 步骤1"
    title: "daily-reports 目录为空时无显式处理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "skills/evolve-apply/SKILL.md:LIST Mode"
    title: "0-indexed 展示对非技术用户可能困惑"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 集成审查 v1

## 评审记录
- 评审时间：2026-05-31 17:30
- 评审类型：集成审查（编码评审子维度）
- 评审对象：evolve-daily/src/index.ts + skills/evolve/SKILL.md + skills/evolve-apply/SKILL.md + skills/evolve-report/SKILL.md

## 审查方法

以 4 个模块间的共享数据文件为切入点，追踪每个文件的写入方和读取方，验证：
1. 格式一致性（生产者写入的字段/结构 = 消费者期望的字段/结构）
2. 路径一致性（写入路径 = 读取路径）
3. 数据流闭环（生产→消费链路无断裂）
4. 语义冲突（不同模块对同一字段的语义理解是否一致）

## 共享数据文件清单

| 文件 | 写入方 | 读取方 |
|------|--------|--------|
| `daily-reports/YYYY-MM-DD.json` | evolve-daily (ext) | evolve, evolve-report |
| `daily/*.json` | usage-tracker (外部) | evolve, evolve-report |
| `suggestions/pending.json` | evolve, evolve-apply | evolve-apply |
| `history.jsonl` | evolve-apply | evolve-apply, evolve |
| `backups/<ts>-<file>` | evolve-apply | evolve-apply |

---

## 集成点逐一审查

### IP-1: pending.json — evolve(写) ↔ evolve-apply(读/写)

**evolve 写入格式**（SKILL.md 步骤5）：

```json
{
  "generatedAt": "<ISO>",
  "reportUsed": "daily-reports + history",
  "suggestions": [
    {
      "id": "<uuid>",
      "target": "claude-md | skill",
      "targetPath": "<absolute path>",
      "severity": "high | medium | low",
      "confidence": 0.85,
      "title": "...",
      "description": "...",
      "rationale": "...",
      "instruction": "...",
      "status": "pending"
    }
  ]
}
```

**evolve-apply 消费方式**：

| 模式 | 读取字段 | 写入字段 | 一致性 |
|------|---------|---------|--------|
| LIST | `suggestions[]` 整体, `.severity`, `.confidence`, `.targetPath`, `.status`, `.description` | 无 | ✅ |
| APPLY | `suggestions[N]`, `.status=="pending"`, `.instruction`, `.targetPath`, `.title`, `.id` | `.status` → `"applied"` | ✅ |
| SKIP | `suggestions[N]`, `.status=="pending"` | `.status` → `"rejected"` | ✅ |
| ROLLBACK | 按 `.id` 匹配 | `.status` → `"pending"` | ✅ (正常路径) |

**结论**：格式完全一致，字段名和值域匹配。evolve 写入的 `suggestions` 数组结构被 evolve-apply 的所有模式正确消费。✅

---

### IP-2: history.jsonl — evolve-apply(写) ↔ evolve-apply + evolve(读)

**APPLY 写入格式**（evolve-apply SKILL.md 步骤7）：

```json
{"timestamp":"<ISO>","action":"apply","suggestionId":"<id>","targetPath":"<path>","backupPath":"<backup>","instruction":"<text>","title":"<title>","commitSha":"<sha>"}
```

**ROLLBACK 写入格式**（步骤7）：

```json
{"timestamp":"<ISO>","action":"rollback","suggestionId":"<id>","targetPath":"<path>","backupPath":"<backup>","instruction":"","title":"<title>","commitSha":"<sha>"}
```

**ROLLBACK 消费方式**：
- 扫描全文件，找 `action=="apply"` 且无同 `suggestionId` 的 `action=="rollback"` 记录 → 字段 `action`, `suggestionId` 可用 ✅
- 取 `backupPath` → 验证文件存在 → 字段 `backupPath` 可用 ✅
- 取 `targetPath`, `title` → 用于 git commit 和确认 → ✅

**evolve 消费方式**（evolve SKILL.md 步骤3）：
- "Check history.jsonl for recently applied suggestions and evaluate their impact using before/after metrics"
- 使用 `action=="apply"`, `timestamp`, `title` 做效果评估 → 字段可用 ✅

**JSONL 格式安全性**：
- 两处写入均使用 `python3 -c "import json; print(json.dumps({...}))"` — 不会因 instruction 含换行/引号而损坏 ✅
- `>>` 追加模式，不存在时自动创建 ✅

**结论**：格式自洽，写入和读取的字段完全匹配。✅

---

### IP-3: daily-reports/*.json — evolve-daily(写) ↔ evolve + evolve-report(读)

**evolve-daily 写入**（`evolve-daily/src/index.ts`）：

```typescript
const REPORTS_DIR = join(homedir(), ".pi/agent/evolution-data/daily-reports");
const reportPath = join(REPORTS_DIR, `${today}.json`);
// pi.exec("python3", [ANALYZER_PATH, ..., "--output", reportPath])
```

产出路径：`~/.pi/agent/evolution-data/daily-reports/YYYY-MM-DD.json`

**evolve-report 读取**（SKILL.md Data Paths）：

```
~/.pi/agent/evolution-data/daily-reports/*.json
```

**evolve 读取**（SKILL.md 步骤2）：

```
daily-reports/*.json — Python analyzer deep analysis (.json files only; .md files are legacy, ignore them)
```

**路径验证**：

| 模块 | 硬编码路径 | 解析结果 | 匹配 |
|------|-----------|---------|------|
| evolve-daily | `join(homedir(), ".pi/agent/evolution-data/daily-reports")` | `~/.pi/agent/evolution-data/daily-reports/` | — |
| evolve-report | `~/.pi/agent/evolution-data/daily-reports/*.json` | 同上 | ✅ |
| evolve | `~/.pi/agent/evolution-data/daily-reports/*.json` | 同上 | ✅ |

**额外检查**：
- evolve-daily 幂等：`existsSync(reportPath)` → 已存在则跳过 ✅
- evolve-daily 失败不阻塞：try-catch + `unlinkSync` 清理部分写入 ✅
- evolve 和 evolve-report 均声明忽略 `.md` legacy 文件 → 与 evolve-daily 只写 `.json` 不冲突 ✅

**结论**：路径完全一致，读写模式兼容。✅

---

### IP-4: 数据流闭环验证

#### 主数据流：evolve → pending → apply → history

```
/evolve (skill)
  → 读 daily/*.json + daily-reports/*.json + history.jsonl
  → LLM 分析
  → 写 pending.json (全量覆写)
  ✅ 数据源到产出闭环

/evolve-apply apply N
  → 读 pending.json
  → cp 备份到 backups/
  → edit 目标文件
  → git commit
  → 写 pending.json (status: applied)
  → 追加 history.jsonl (apply 记录)
  ✅ pending → 目标文件 + backups + history 闭环

/evolve-apply rollback
  → 读 history.jsonl
  → 找最近 apply 记录
  → cp 从 backups/ 恢复
  → git commit
  → 写 pending.json (status: pending)
  → 追加 history.jsonl (rollback 记录)
  ✅ history → 目标文件恢复 + history 记录闭环
```

#### 辅助数据流：daily → daily-reports → evolve-report

```
evolve-daily (extension)
  → session_start 触发
  → 执行 python3 analyzer
  → 写 daily-reports/YYYY-MM-DD.json
  ✅ 自动收集闭环

/evolve-report
  → 读 daily-reports/*.json
  → 展示给用户
  ✅ 报告展示闭环
```

#### 反馈环路：history → evolve

```
/evolve 步骤3 "effect review"
  → 读 history.jsonl
  → 评估已应用建议的效果
  → 影响新一轮建议生成
  ✅ 反馈闭环
```

**结论**：数据流完整闭环，无断裂。✅

---

### IP-5: 模块间语义一致性

#### pending.json status 状态机

```
evolve 写入:    "pending"
evolve-apply:   "pending" → "applied" (APPLY)
                "pending" → "rejected" (SKIP)
                "applied" → "pending" (ROLLBACK)
```

三模块对 status 字段的语义理解一致：
- evolve 只写 "pending" ✅
- evolve-apply 只在 "pending" 时允许 apply/skip ✅
- evolve-apply 只在 "applied" 时允许 rollback ✅

**但**：ROLLBACK 错误路径会破坏此语义 → 见 MUST FIX #1。

#### evolve 全量覆写 vs rollback 查找

evolve 步骤5 全量覆写 pending.json（只保留新的 pending 建议）。已 applied/rejected 的建议从 pending.json 消失，但 history.jsonl 保留完整记录。

ROLLBACK 步骤6 按 suggestionId 在 pending.json 中查找对应建议。如果 /evolve 在 apply 和 rollback 之间运行过，该建议已不在 pending.json 中。

**影响**：步骤6 查找落空 → LLM 无法更新状态 → 但文件恢复和历史记录均正常。这是设计取舍（pending.json 是工作队列而非账本），不是接口错误。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | skills/evolve-apply/SKILL.md:ROLLBACK 步骤5→6→8 | **ROLLBACK 错误路径未中止流程**。步骤5（备份缺失）只说 "Do NOT write to history.jsonl"，未说 STOP。步骤6 和 8 没有类似步骤7 的 "(only if step 4 succeeded)" 守卫。结果：(a) 步骤6 将仍处于 applied 状态的建议改为 pending（文件实际未恢复），破坏 pending.json 的语义契约——消费者（LIST、evolve）会看到错误状态；(b) 步骤8 输出 "File restored from backup" 的虚假确认 | 步骤5 末尾加 "→ STOP. Do not proceed to steps 6-8."；或给步骤6和8加 "(only if step 4 succeeded)" 前缀。与步骤7保持一致的守卫风格 |
| 2 | LOW | skills/evolve/SKILL.md:步骤5 ↔ skills/evolve-apply/SKILL.md:ROLLBACK 步骤6 | **evolve 全量覆写后 rollback 查找可能落空**。/evolve 覆写 pending.json 后，rollback 步骤6 按 suggestionId 查找可能找不到。文件恢复和历史记录不受影响，但 pending.json 状态不会更新。边缘场景（/evolve 在 apply 和 rollback 之间运行） | rollback 步骤6 加 "如果未找到匹配的建议，跳过此步骤（pending.json 可能已被新的 /evolve 运行覆写）" |
| 3 | LOW | skills/evolve-report/SKILL.md:Show Report 步骤1 | **daily-reports 目录为空无显式处理**。`ls *.json 2>/dev/null` 返回空输出时，依赖 LLM 自行判断。用户可能看到空响应或困惑 | 步骤1后加 "如果无 .json 文件，告知用户 'No reports available yet. Wait for evolve-daily to generate the first report.'" |
| 4 | INFO | skills/evolve-apply/SKILL.md:LIST Mode | 0-indexed `[#0]` 展示对非技术用户可能困惑 | 可考虑 1-indexed 展示（内部映射） |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 与 BLR 的交叉分析

BLR v1 提出 7 个问题（2 MUST FIX）。本集成审查的发现与 BLR 的关系：

| 集成审查 # | BLR 对应 | 关系 |
|-----------|---------|------|
| INT#1 (MUST FIX) | BLR#1 (MUST FIX) | 同一根因（ROLLBACK 错误路径流程控制），不同视角。BLR 聚焦 history.jsonl 假记录（已被当前 SKILL.md 步骤7守卫修复），本审查聚焦 pending.json 语义污染（**仍未修复**：步骤6/8缺守卫） |
| INT#2 (LOW) | BLR#4 (LOW) | 相同问题（rollback 后 pending 状态不同步），集成视角补充了 evolve 覆写场景下的查找落空分析 |
| INT#3 (LOW) | BLR#5 (LOW) | 相同问题（空目录处理） |
| INT#4 (INFO) | BLR#6 (INFO) | 相同问题（0-indexed） |

BLR MUST FIX #2（heredoc 多行损坏）已在当前 SKILL.md 中修复（改用 python3 -c + json.dumps）。✅

BLR MUST FIX #1 部分 修复——history.jsonl 写入已加守卫，但 **pending.json 更新和确认消息** 仍缺守卫。这就是本审查的 INT#1。

### 结论

需修改后重审。1 条 MUST FIX：ROLLBACK 错误路径的流程控制不完整（步骤6/8缺守卫），导致 pending.json 接口的语义契约被破坏。其余集成点（格式、路径、数据流）均验证通过。

### Summary

集成审查完成，第1轮，1条MUST FIX（ROLLBACK错误路径pending.json语义污染），需修改后重审。
