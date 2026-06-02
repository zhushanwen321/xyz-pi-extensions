---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-31T22:00:00"
  target: ".xyz-harness/2026-05-30-context-engineering-plugin/plan.md"
  verdict: pass
  summary: "计划评审完成，第2轮，0条MUST FIX，3条v1 MUST_FIX全部resolved，通过"

statistics:
  total_issues: 12
  must_fix: 0
  must_fix_resolved: 3
  low: 8
  info: 1

issues:
  # === v1 MUST_FIX → 全部 resolved ===
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 Step 2 (loadConfig)"
    title: "settings.jsonl vs settings.json 文件名和解析逻辑双重错误"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Interface Contracts → processL0 签名"
    title: "processL0 Interface Contract 缺少 turnBoundaries 参数"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Wave Schedule vs Dependency Graph"
    title: "Wave Schedule 与 Dependency Graph 矛盾，并行/串行冲突"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  # === v1 LOW/INFO carryover ===
  - id: 4
    severity: LOW
    location: "plan.md:Task 5 Step 2 (context event handler)"
    title: "context 事件处理器未包含 try-catch 错误处理"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: LOW
    location: "plan.md:Task 2 Step 1 (crypto.randomUUID)"
    title: "crypto 模块可能受 CLAUDE.md 限制（仅允许 fs）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "use-cases.md:UC-3 → emergencyCompress()"
    title: "UC-3 引用 emergencyCompress() 但 Interface Contracts 定义为 processL2()"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "plan.md:Interface Contracts → CompressionStats"
    title: "CompressionStats 缺少 validationFailed 字段"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "plan.md:File Structure vs Complexity Assessment"
    title: "File Structure 7 文件（无 widget.ts）vs Complexity Assessment 5-6 文件（含 widget.ts）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: INFO
    location: "plan.md:Task 6"
    title: "单元测试仅覆盖 compressor.ts，config/recall-store/commands 无独立测试"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  # === v2 新发现 ===
  - id: 10
    severity: LOW
    location: "plan.md:File Structure table L25"
    title: "File Structure 表残留 settings.jsonl 描述，与 Task 1 Step 2 的 settings.json 不一致"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 11
    severity: LOW
    location: "plan.md:Task 3 Step 2 L264"
    title: "Task 3 Step 2 processL0 简写签名仍为 4 参数，与 Interface Contract 的 5 参数不一致"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 12
    severity: LOW
    location: "spec.md:C-4 vs plan.md:Task 1 Step 2"
    title: "spec C-4 仍写 settings.jsonl，plan 修正为 settings.json，spec 未同步"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-05-31 22:00
- 评审类型：计划评审（增量审查模式）
- 评审对象：`spec.md` + `plan.md` + `e2e-test-plan.md` + `use-cases.md` + `non-functional-design.md`

## v1 MUST_FIX 修复验证

### [FIXED] Issue #1: settings.jsonl vs settings.json

**v1 问题：** spec C-4 要求 `settings.jsonl`（JSON Lines），但 plan Task 1 Step 2 写的是 `settings.json` + `JSON.parse`（整个文件解析），文件名和解析逻辑都不匹配。

**v2 状态：** ✅ 已修复。

- Task 1 Step 2 现在写 `~/.pi/agent/settings.json`，并注明"Pi 使用 `.json` 扩展名而非 `.jsonl`"
- 解析逻辑 `fs.readFileSync` + `JSON.parse` 与 `.json` 文件格式一致
- ADR Evaluation 也更新为 `settings.json`

**残留：** File Structure 表第 25 行仍写 `settings.jsonl 读取`（见 Issue #10），为 LOW 级文档不一致。

### [FIXED] Issue #2: processL0 签名缺少 turnBoundaries

**v1 问题：** processL0 Interface Contract 签名只有 4 个参数，但 Task 3 Step 5 调用时传了 5 个参数（含 boundaries）。

**v2 状态：** ✅ 已修复。

- Interface Contract 现定义为 `(messages, config, store, now, turnBoundaries: TurnBoundary[])` — 5 个参数
- Task 3 Step 5 调用 `processL0(messages, config.l0, store, Date.now(), boundaries)` — 5 个参数
- 签名与调用一致

**残留：** Task 3 Step 2 描述标题仍写 `processL0(messages, config, store, now)` 4 参数简写（见 Issue #11），为 LOW 级文档不一致。Step 2 正文提到"不在保护 turn 内"，逻辑正确。

### [FIXED] Issue #3: Wave Schedule 与 Dependency Graph 矛盾

**v1 问题：** Dependency Graph 显示严格串行，但 Wave Schedule 将 Task 1/2 放入同一 Wave（暗示并行）。

**v2 状态：** ✅ 已修复。

- Wave Schedule 现为严格 6 Waves：Wave 1=Task1, Wave 2=Task2, ..., Wave 6=Task6
- 每个 Wave 单一 Task，无并行暗示
- 与 Dependency Graph 完全一致

## v1 LOW 修复验证

### [FIXED] Issue #4: context 事件 try-catch

Task 5 Step 2 现明确写 `→ try-catch 包裹`，与 non-functional-design.md 的承诺一致。

### [OPEN] Issues #5-#9: 未修复，维持 LOW/INFO

均为 v1 已识别的非阻塞性问题，本轮不做重新评估（增量审查模式跳过 LOW/INFO 重扫）。

## v2 新发现问题

| # | 优先级 | 文件/位置 | 描述 | 来源 |
|---|--------|----------|------|------|
| 10 | LOW | plan.md:File Structure L25 | File Structure 表 config.ts 描述仍写 `settings.jsonl 读取`，与 Task 1 Step 2 的 `settings.json` 矛盾。修复 Issue #1 时只更新了 Task 步骤和 ADR，遗漏了 File Structure 表。 | [REGRESSION] |
| 11 | LOW | plan.md:Task 3 Step 2 L264 | Task 3 Step 2 函数签名简写为 `processL0(messages, config, store, now)` 4 参数，但 Interface Contract 定义 5 参数（含 turnBoundaries）。修复 Issue #2 时只更新了 Interface Contract 和 Step 5 调用，遗漏了 Step 2 描述标题。 | [REGRESSION] |
| 12 | LOW | spec.md:C-4 vs plan.md:Task 1 | spec C-4 仍写 `settings.jsonl`，plan 已修正为 `settings.json`。spec 未同步更新。属于 spec 层面问题，不影响 plan 可行性，但会导致阅读者困惑。 | [NEW] |

**分析：** 三个新问题都是 v1 MUST_FIX 修复不彻底导致的残留——修复集中在核心位置（Interface Contract、Task 关键步骤、ADR），但 File Structure 表和 Task Step 描述标题等辅助位置未同步更新。这些位置不影响实现正确性（执行者会以 Interface Contract 为准），但影响文档一致性。

---

## 结论

**通过。** v1 的 3 条 MUST_FIX 全部修复，核心实现路径（Interface Contract、Task 关键步骤、Wave Schedule）正确且一致。新发现的 3 条 LOW 是修复过程中的文档残留，不影响实现正确性。

## Summary

计划评审完成，第2轮通过，3条v1 MUST_FIX全部resolved，0条新MUST_FIX。修复引入3条LOW级文档残留（File Structure 表、Step 2 签名简写、spec 未同步），均不影响实现正确性。
