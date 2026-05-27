---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-27T20:10:00"
  target: ".xyz-harness/2026-05-27-self-evolution-phase3"
  verdict: fail
  summary: "计划评审完成，第1轮，4条MUST FIX，需修改后重审"

statistics:
  total_issues: 12
  must_fix: 4
  must_fix_resolved: 0
  low: 5
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "non-functional-design.md:§5"
    title: "缺少 targetPath 运行时校验，存在路径遍历安全风险"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 4 (applier.ts) §1"
    title: "建议使用 npm 依赖 (diff-match-patch) 违反 CLAUDE.md 约束"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Interface Contracts §Module: commands"
    title: "命令 handler 签名使用的 Dirs 类型未在 Interface Contracts 中定义结构"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "plan.md:Task 3 (judge.ts) 错误处理 vs spec.md:FR-1 步骤8"
    title: "runJudge 非 JSON raw output 文件持久化未显式覆盖 spec 要求"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:Interface Contracts §Module: types"
    title: "StatsData、CommandResult、Dirs 等 4 个类型缺少详细结构定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md:Task 4 (applier.ts) §applyUnifiedDiff"
    title: "diff 实现策略模糊（字符串替换或 npm 包），字符串替换方案脆弱"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "plan.md:Module: commands §handleEvolve vs spec.md:FR-1 步骤11"
    title: "handleEvolve 未显式提及 tmp 文件清理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "plan.md:Interface Contracts §Module: types §EvolutionSuggestion.target"
    title: "EvolutionSuggestion.target 使用 skill(单数) 与 EvolveCommandParams.target 的 skills(复数) 不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: LOW
    location: "plan.md:Interface Contracts §Module: judge §buildJudgeInput"
    title: "buildJudgeInput target 参数签名使用 string 而非精确联合类型"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 10
    severity: INFO
    location: "spec.md"
    title: "无 [待决议] 项 — spec 完整性良好"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 11
    severity: INFO
    location: "plan.md:Spec Coverage Matrix"
    title: "所有 FR 和 AC 在 plan 中均有对应 Task — 覆盖度良好"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 12
    severity: INFO
    location: "plan.md:Task List"
    title: "Task 粒度适合 subagent 调度 — 每个 Task 均可独立执行且文件数合理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录

- **评审时间**: 2026-05-27 20:10
- **评审类型**: 计划评审
- **评审对象**: spec.md + plan.md + e2e-test-plan.md + use-cases.md + non-functional-design.md

## 评审总览

对 Evolution Engine Phase 3 的 spec、plan、e2e-test-plan、use-cases、non-functional-design 进行了全量评审。整体质量较高：spec 结构清晰，plan 覆盖了所有 FR 和 AC，Task 粒度适合 subagent 调度，Execution Groups 分组合理。发现 4 条 MUST FIX 问题，主要涉及安全漏洞（缺少路径校验）、架构约束违反（npm 依赖）、接口契约不完整和 spec-plan gap。

---

## 1. Spec 完整性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目标明确 | ✅ | "构建完整的 evolution-engine Pi Extension，实现信号分析→LLM Judge 审批→Applier 应用"，一句话说清 |
| 范围合理 | ✅ | 明确 out of scope（Dashboard、A/B 测试等），边界清晰 |
| 验收标准可量化 | ✅ | 7 条 AC 均可编写测试验证，无"提升体验"类模糊描述 |
| [待决议] 项 | ✅ | 无待决议项 |
| Complexity Assessment | ✅ | 正确评估为 High，预估代码量 1500-2000 行 |

**结论**: Spec 完整性良好，无需新增 FR 或 AC。

---

## 2. Plan 可行性

### Task 粒度

| Task | 文件数 | 类型 | subagent 适配度 |
|------|--------|------|----------------|
| Task 1 (skeleton + types) | 3 create | backend | ✅ 独立可执行 |
| Task 2 (state + templates) | 4 create | backend | ✅ 依赖 Task 1 |
| Task 3 (judge) | 1 create | backend | ✅ 依赖 Task 1+2 |
| Task 4 (applier) | 1 create | backend | ✅ 依赖 Task 1 |
| Task 5 (monitor) | 1 create | backend | ✅ 依赖 Task 1 |
| Task 6 (commands + widget + entry) | 3 create | backend | ✅ 依赖 Task 2~5 |

**结论**: 所有 Task 粒度适中，适合独立 subagent 调度。依赖关系正确。

### Spec Coverage

所有 FR 在 plan 中有对应的 Task：
- FR-1 `/evolve`: Task 6
- FR-2 LLM Judge: Task 3
- FR-3 Applier: Task 4
- FR-4 `/evolve-apply`: Task 6
- FR-5 `/evolve-stats`: Task 6
- FR-6 `/evolve-rollback`: Task 6
- FR-7 Auto trigger: Task 5
- FR-8 Auto analyze: Task 6

所有 AC 在 plan 中有对应 Task：
- AC-1: Task 1, 2, 3, 4, 6
- AC-2: Task 3
- AC-3: Task 6
- AC-4: Task 4
- AC-5: Task 5
- AC-6: Task 2, 6
- AC-7: Task 2, 4

**结论**: FR 和 AC 全覆盖，无遗漏。

---

## 3. Spec-Plan 一致性

### 逐条检查

| Spec 条目 | Plan 覆盖 | 状态 |
|-----------|-----------|------|
| FR-1: /evolve 触发流程 12 步 | Task 6 handleEvolve 覆盖步骤 1-10 | ⚠️ 步骤 8 (raw output 文件持久化) 与步骤 11 (tmp 清理) 在 plan 中覆盖不完整（见 MUST FIX #4 和 LOW #7） |
| FR-2: Judge 输出 schema | Task 3 覆盖 | ✅ |
| FR-3: Applier 流程 | Task 4 覆盖 | ✅ |
| FR-4: /evolve-apply | Task 6 handleEvolveApply 覆盖 | ✅ |
| FR-5: /evolve-stats | Task 6 handleEvolveStats 覆盖 | ✅ |
| FR-6: /evolve-rollback | Task 6 handleEvolveRollback 覆盖 | ✅ |
| FR-7: Auto trigger | Task 5 覆盖 | ✅ |
| FR-8: 自动分析 | Task 6 handleEvolve 覆盖 | ✅ |
| AC-1~AC-7 | 见上方矩阵 | ✅ |

### 无 spec 未提及的额外工作

Plan 中没有发现 spec 未提及的额外 Task。所有 Task 均可追溯到 spec 的 FR 或 AC。

---

## 4. Execution Groups 合理性

### BG1: Foundation (Task 1 + Task 2)

| 检查项 | 结果 |
|--------|------|
| 文件数（预估） | 7 个（package.json, index.ts, types.ts, state.ts + 3 templates）✅ ≤ 10 |
| 类型划分 | 纯 backend ✅ |
| 功能关联度 | Task 1 (类型定义) + Task 2 (状态管理+模板) 关联紧密 ✅ |
| 依赖关系 | 串行 — Task 2 依赖 Task 1 ✅ |
| Wave 1 编排 | 无文件冲突 ✅ |

### BG2: Core Logic (Task 3 + Task 4 + Task 5)

| 检查项 | 结果 |
|--------|------|
| 文件数（预估） | 3 个（judge.ts, applier.ts, monitor.ts）✅ ≤ 10 |
| 类型划分 | 纯 backend ✅ |
| 功能关联度 | 三个引擎松散耦合，在 Wave 2 可并行 ✅ |
| 依赖关系 | 都依赖 BG1，间相互独立 ✅ |
| Wave 2 编排 | 无文件冲突 ✅ |

### BG3: Integration (Task 6)

| 检查项 | 结果 |
|--------|------|
| 文件数（预估） | 3 个（widget.ts, commands.ts, index.ts）✅ ≤ 10 |
| 类型划分 | 纯 backend ✅ |
| 功能关联度 | 单个 Task，高内聚 ✅ |
| Wave 3 编排 | 依赖 BG1+BG2 全部模块，正确 ✅ |

### Subagent 配置完整性

| 检查项 | BG1 | BG2 | BG3 |
|--------|-----|-----|-----|
| Agent 指定 | ✅ general-purpose | ✅ general-purpose | ✅ general-purpose |
| Model | ✅ medium | ✅ high | ✅ high |
| 注入上下文 | ✅ types + spec 约束 + subagent 参考 | ✅ types + interface + subagent spawn 参考 + Phase 2 字段结构 | ✅ 所有模块签名 + usage-tracker 模式 |
| 读取文件 | ✅ subagent/src/spawn.ts, usage-tracker | ✅ 相关依赖文件 | ✅ 其他模块 |
| 创建文件 | ✅ 7 个 | ✅ 3 个 | ✅ 3 个 |

**结论**: Execution Groups 划分合理，所有检查项通过。

---

## 5. Interface Contracts 审查

### 5.1 plan.md ↔ types.ts 一致性

| 问题 | 位置 | 详情 |
|------|------|------|
| ❌ Dirs 类型未定义结构 | Module: commands | `handleEvolve(params, dirs: Dirs)` — Dirs 被使用但 Interface Contracts 中无结构定义 |
| ⚠️ StatsData、CommandResult 等未定义结构 | Module: types | 列在"定义所有接口"清单中但无结构表格 |
| ⚠️ buildJudgeInput target 用 string | Module: judge | 签名写 `target: string`，但应为 `"all" \| "claude-md" \| "skills"` |

### 5.2 Edge Cases 完整性

| Module | Method | Edge Cases | 状态 |
|--------|--------|------------|------|
| judge | runJudge | 超时 120s ✓ 非 JSON ✓ | ✅ 但 raw output 文件持久化未显式覆盖（见 MUST FIX #4）|
| judge | parseJudgeOutput | 非 JSON ✓ 缺字段 ✓ | ✅ |
| applier | applySuggestion | diff 冲突 ✓ | ✅ |
| applier | rollbackSuggestion | backup 不存在 ✓ | ✅ |
| state | loadPending | 文件不存在 ✓ JSON 损坏 ✓ | ✅ |
| monitor | checkAutoTriggerRules | 除零保护 ✓ | ✅ |

### 5.3 AC 覆盖矩阵完整性

Spec 中所有 7 条 AC 在 Spec Coverage Matrix 中均有对应行。无遗漏。✅

**结论**: Interface Contracts 基本完整，但 Dirs 等关键类型缺少结构定义。

---

## 6. CLAUDE.md 架构约束合规性

| 约束 | 检查 | 状态 |
|------|------|------|
| 模块导入用 @mariozechner/* | plan 的 Tech Stack 已指定 | ✅ |
| 扩展无独立 node_modules | Task 4 建议使用 diff-match-patch npm 包 = 违反 | ❌ MUST FIX |
| 单文件 ≤ 1000 行 | 各文件职责单一，合理 | ✅ |
| Session 隔离 | 采用文件系统持久化，不依赖闭包状态 | ✅ |
| child_process.spawn 例外 | spec 已注明需更新 CLAUDE.md | ✅ |
| 扩展入口命名约定 | `evolutionEngineExtension(pi: ExtensionAPI)` | ✅ |
| taste-lint: no-explicit-any | plan 使用 `Record<string, unknown>` 替代 `any` | ✅ |

---

## 7. 发现的问题

### MUST FIX

#### #1 安全: 缺少 targetPath 运行时校验

**位置**: non-functional-design.md §5

**描述**: non-functional-design 明确承认 "当前版本通过 Judge prompt 约束 targetPath 范围，不做运行时路径校验——后续迭代可加入白名单"。evolution-engine 的核心功能是修改 CLAUDE.md 和 SKILL.md 文件。仅依赖 LLM prompt 约束 targetPath 不足以防止路径遍历攻击。如果 Judge 产生恶意 targetPath（如 `../../etc/passwd`），系统会在无校验的情况下对其执行 backup + apply diff + git commit。

**修改方向**: applySuggestion 执行前必须对 targetPath 进行白名单检查：
1. 解析 targetPath 的 realpath（解析符号链接、`..` 等）
2. 检查 realpath 是否在 `~/.pi/agent/` 目录下
3. 检查文件名是否为 `CLAUDE.md` 或以 `.md` 结尾（skill 文件）

#### #2 CLAUDE.md 约束违反: 不建议使用 npm 依赖

**位置**: plan.md Task 4 (applier.ts) §1

**描述**: Task 4 的 applyUnifiedDiff 实现策略提到 "简单字符串替换或使用 diff-match-patch npm 包"。但 CLAUDE.md 明确约定 "扩展没有自己的 node_modules，所有 @mariozechner/* 和 typebox 依赖由 Pi 运行时提供"。引入第三方 npm 包会破坏现有依赖模型，且需要额外的构建/安装步骤。

**修改方向**: 实现纯 TypeScript 的 unified diff 应用逻辑（解析 diff header + hunk + context，基于字符串匹配和替换），不引入 npm 包。可参考 Python `patch` 模块的逻辑自行实现简易版本，或使用 Node.js 内置的 `diff` 模块（如果有）。

#### #3 Interface Contract: Dirs 类型未定义结构

**位置**: plan.md §Interface Contracts — Module: commands

**描述**: 三个命令 handler 的签名均使用 `dirs: Dirs` 参数：
- `handleEvolve(params: EvolveCommandParams, dirs: Dirs)`
- `handleEvolveApply(dirs: Dirs)`
- `handleEvolveRollback(dirs: Dirs)`

但 Interface Contracts 的数据类型表中没有定义 `Dirs` 的结构。Task 1 的"定义所有接口"清单虽然包含 `Dirs`，但合同层面缺少正式的结构说明。

**修改方向**: 在 Interface Contracts 的 Data 类型表中补充 Dirs 定义：
```
Dirs:
  evolutionDir: string  — ~/.pi/agent/evolution-data
  reportsDir: string    — evolutionDir/reports/
  tmpDir: string        — evolutionDir/tmp/
  templateDir: string   — extension 内 templates/ 目录
  backupDir: string     — evolutionDir/backups/
```

#### #4 Spec-Plan gap: runJudge 非 JSON raw output 文件持久化未显式覆盖

**位置**: plan.md Task 3 (judge.ts) 错误处理 vs spec.md FR-1 步骤 8

**描述**: spec FR-1 步骤 8 明确要求 "若 Judge 返回非 JSON，记录 raw output 到 evolution-data 目录下，显示错误信息"。但 plan 的 Task 3 中 runJudge 的错误处理仅描述为 "spawn 失败 / 非 JSON / 超时均抛 Error，含诊断信息"，未显式说明将 raw output 保存到 evolution-data 目录下的步骤。Interface Contract 的 edge case 虽提及 "含 raw output 路径"，但 Task 3 的具体实现描述中缺少文件持久化子步骤。

**修改方向**: 在 Task 3 的 runJudge 实现中增加一步：
1. 当 stdout 解析失败时，将 raw output 写入 `evolution-data/tmp/judge-raw-{timestamp}.txt`
2. Error 消息中包含该文件路径

或者在 commands.ts 的 handleEvolve 中捕获 runJudge 的 Error 后执行文件持久化。

---

### LOW

#### #5 Interface Contracts 中 4 个类型缺少详细结构定义

**位置**: plan.md §Interface Contracts — Module: types

**描述**: Task 1 的"定义所有接口"清单包含 `StatsData`, `CommandResult`, `ApplyResult`, `RollbackResult`, `Dirs`，但 Interface Contracts 表中只有 `EvolutionSuggestion`, `PendingFile`, `HistoryEntry`, `AutoTriggerFlag`, `JudgeInput`, `EvolveCommandParams` 有结构定义。尤其 `CommandResult` 和 `StatsData` 是多个命令 handler 的输入输出类型，缺少结构定义增加了实现歧义。

#### #6 applyUnifiedDiff 实现策略模糊

**位置**: plan.md Task 4 (applier.ts) §applyUnifiedDiff

**描述**: 实现策略表述为 "简单字符串替换或使用 diff-match-patch npm 包"。字符串替换方案处理 unified diff（含上下文行、行号等）时非常脆弱。建议在 Plan 中明确排除 npm 方案（见 MUST FIX #2），并给出纯 TS 实现的参考方向。

#### #7 Temp 文件清理未在 plan 中体现

**位置**: plan.md Module: commands §handleEvolve

**描述**: spec FR-1 步骤 11 要求 "清理本次产生的临时 flags"。plan 的 handleEvolve 描述中未提及 temp 文件的清理。buildJudgeInput 写入的 `tmpDir/judge-input-{timestamp}.json` 等临时文件应在 handleEvolve 完成（成功或失败）后清理，或依赖 spec 中"session 结束时清理"的约定。

#### #8 EvolutionSuggestion.target 与 EvolveCommandParams.target 命名差异

**位置**: plan.md §Interface Contracts

**描述**: `EvolutionSuggestion.target` 使用 `"skill"`（单数），而 `EvolveCommandParams.target` 和 `JudgeInput.target` 使用 `"skills"`（复数）。虽然语义不同（suggestion target 是"建议修改哪种文件"，command target 是"分析什么数据"），但实现时容易混淆。建议统一为一致的形式（如都用复数），或在文档中明确标注语义差异。

#### #9 buildJudgeInput target 参数签名精度不足

**位置**: plan.md §Interface Contracts — Module: judge

**描述**: `buildJudgeInput` 的签名写为 `(report: Record<string, unknown>, target: string, tmpDir: string) → JudgeInput`，其中 `target: string`。但 `JudgeInput.target` 类型为 `"all" | "claude-md" | "skills"`。签名使用 `string` 丢失了类型约束，可能导致调用时传入无效值。建议改为 `target: "all" | "claude-md" | "skills"`。

---

### INFO

#### #10 无 [待决议] 项

Spec 中没有标记 `[待决议]` 的项，所有设计决策已完成。风险为 0。

#### #11 FR/AC 全覆盖

Plan 的 Spec Coverage Matrix 和 Spec Metrics Traceability 覆盖了所有 8 个 FR 和 7 个 AC，无遗漏。Use Cases 也正确映射到 AC。

#### #12 Task 粒度适合 subagent 调度

每个 Task 的文件数 1-4 个，依赖关系清晰，验证步骤（tsc --noEmit + git commit）完整，适合独立 subagent 执行。

---

## 8. E2E Test Plan 审查

| 检查项 | 结果 |
|--------|------|
| AC 覆盖 | 10 个 TS 覆盖全部 7 个 AC ✅ |
| 正常路径覆盖 | TS-1 (全流程), TS-3 (stats), TS-4 (rollback) ✅ |
| 异常路径覆盖 | TS-7 (analyze.py 失败), TS-8 (diff 冲突) ✅ |
| 边界条件覆盖 | TS-9 (0 条建议), TS-10 (除零保护) ✅ |
| 测试环境定义 | Pi 进程、真实数据、固定模型、Python 位置 ✅ |

**结论**: E2E 测试计划完整，覆盖所有 AC 的正常路径、异常路径和边界条件。

---

## 9. 结论

**评审结果: fail** — 存在 4 条 MUST FIX 问题，需修改后重审。

核心发现：
1. **安全漏洞**: targetPath 缺少运行时校验，攻击面真实存在
2. **架构约束违反**: 误引入 npm 依赖，与项目约定冲突
3. **接口契约不完整**: Dirs 等关键类型缺少结构定义
4. **Spec-Plan gap**: raw output 文件持久化要求未在 plan 中显式覆盖

其余 LOW/INFO 问题不影响本轮评审通过，可在后续迭代中完善。

## Summary

计划评审完成，第1轮，4条 MUST FIX，需修改后重审。
