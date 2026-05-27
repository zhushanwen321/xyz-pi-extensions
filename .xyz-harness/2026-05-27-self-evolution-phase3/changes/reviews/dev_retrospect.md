---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — self-evolution-phase3

## 1. Phase Execution Review

### Summary

完成了 evolution-engine Extension 的全部代码实现和 5 步专项审查。产出物：
- 14 个源文件（8 个 .ts + 3 个 .txt 模板 + package.json + index.ts + tsconfig.json）
- 共 2126+ 行 TypeScript 代码（经多轮修复后略有增减）
- 5 步审查全部通过，共经过 3 轮迭代（13 个 MUST FIX 修复）

实现按 Wave 编排执行：
- Wave 1 (BG1): types.ts + state.ts + 3 个 prompt 模板 — 1 个 subagent
- Wave 2 (BG2): judge.ts + applier.ts + monitor.ts — 3 个 subagent（1 串行 + 2 并行）
- Wave 3 (BG3): commands.ts + widget.ts + index.ts — 1 个 subagent

审查发现分布：
| 审查步 | v1 MUST FIX | v2 MUST FIX | v3 MUST FIX | 最终 |
|--------|------------|------------|------------|------|
| Business Logic | 5 | 2 | 0 | pass |
| Standards | 3 | 0 | — | pass |
| Taste | 1 | 0 | — | pass |
| Robustness | 2 | 0 | — | pass |
| Integration | 2 | 0 | — | pass |

### Problems Encountered

**P1: 审批交互设计不匹配 Pi Tool 架构**

BLR v1 发现 handleEvolveApply 直接批量执行所有 pending 建议，无 y/n 决策。根因：plan 中描述了"TUI 审批循环"（spec UC-1 Step 8），但 Pi tool execute 是单次调用，无法做交互式循环。

修复方式：改为 per-call 审批模型——/evolve-apply 接受 action（list/apply/skip）+ index 参数。用户先 list 查看建议详情，再逐条 apply 或 skip。这改变了 spec 中"逐条 y/n 交互"的 UX 设计，但更适合 Pi 的工具架构。

教训：plan 中假设了交互式 TUI 循环，但 Pi Extension 的 tool execute 模型不支持。Phase 2 (plan) 应该提前确认 Pi Extension API 的交互模式限制。

**P2: Backup 路径不一致跨多个文件**

applier.ts 的 backupFile 生成的路径格式（`backups/<timestamp>/<basename>`）与 commands.ts 的 handleEvolveApply 自行拼接的路径（`backups/<uuid>.bak`）不同。BLR v1 和 Robustness v1 都独立发现了这个问题。

修复方式：ApplyResult 新增 backupPath 字段，applySuggestion 返回实际备份路径，handleEvolveApply 从返回值获取。

教训：当一个值在模块 A 生成、在模块 B 消费时，应该通过返回值传递而非各自独立计算。Plan 的 Interface Contracts 已经定义了签名，但没有明确 backupPath 的传递方式。

**P3: Shell 注入面比预期广**

Robustness v1 发现 applier.ts 的 execSync 拼接。修复 applier 后，Robustness v2 又发现 commands.ts 的 analyze.py 调用有同类问题。

教训：审查 shell 命令拼接时应该全项目 grep `execSync`，而不是只看审查报告指向的文件。

**P4: Token-decline 规则实现错误**

BLR v1 和 Integration v1 都指出 token-decline 规则实现与 spec 不符。原实现是"最近 3 天均值 > 基线"，spec 要求"连续 3 天逐天上升"。Integration v1 进一步发现 sliceBeforeLast 函数导致 baseline 和 recent 窗口完全重叠。

修复方式：改用 daily.slice(0, 7) 取前 7 天 baseline，逐天检查最近 3 天每一天 > baseline。

教训：数值比较类规则应在 plan 中写明"逐天"还是"均值"，而非模糊描述"最近 3 天均值连续 > 前 7 天均值"（"连续"和"均值"是矛盾的）。

### What Would You Do Differently

1. **确认 Pi Tool API 交互模式后再写 plan**：在 Phase 2 开始前，先确认 Pi Extension 的 tool execute 是否支持交互式循环。如果不支持，plan 中的审批流程设计应该从一开始就是 per-call 模型。
2. **全项目 grep execSync**：修复 shell 注入时应该一次性扫描所有文件，而不是等审查再发现。
3. **数值比较规则用精确伪代码**：避免"连续均值"这种自相矛盾的描述。

### Key Risks for Later Phases

1. **LLM Judge 子进程未实际测试**：judge.ts 的 spawn + JSONL 解析逻辑基于 subagent/src/spawn.ts 的参考实现，但没有在真实 Pi 环境中测试。Phase 4 (test) 的 E2E 测试是首次验证。
2. **Prompt 模板质量未验证**：3 个模板文件写好了结构，但实际 Judge 输出质量取决于 prompt 的评判维度和约束是否有效。可能需要多轮迭代。
3. **analyze.py 集成**：commands.ts 通过 execFileSync 调用 analyze.py，但 analyze.py 的 `--format json --output` 参数是否正确需要在 E2E 中验证。

## 2. Harness Usability Review

### Flow Friction

**5 步专项审查比单步 review 更有效但也更昂贵**：5 个审查 subagent 共消耗约 10 次 dispatch（含 v2/v3），发现了 13 个 MUST FIX。如果用单步 review，可能遗漏一些跨维度问题（如 shell 注入同时是健壮性和安全问题）。

但代价是显著的上下文消耗和等待时间。每个 subagent 需要读取 8 个源文件，5 个并行 dispatch 后上下文压力很大。

**修复-审查循环效率**：每个 MUST FIX 的修复都触发完整审查重新 dispatch。修复 3 个 MUST FIX 需要 dispatch 1 个修复 subagent + 5 个审查 subagent。如果能在修复后做一次快速 diff review 而不是完整重新审查，会更高效。

### Gate Quality

Gate 在第一轮就发现了所有严重问题。5 步审查的分工清晰：
- BLR 专注业务流程正确性
- Standards 专注项目规范合规
- Taste 专注类型一致性和代码品味
- Robustness 专注错误处理和安全性
- Integration 专注模块间接口和数据流

交叉验证效果好：backup 路径问题被 BLR 和 Robustness 独立发现；shell 注入被 Standards（return vs throw）和 Robustness 同时关注。

### Prompt Clarity

phase-dev skill 的指引清晰：
- 复杂路径（6 tasks + Execution Groups）的判断标准明确
- Wave 编排与 plan 中的 Execution Groups 对应良好
- 5 步审查的模板和输出格式定义完整

一个不明确点：当 BLR v2 的 MUST FIX 涉及代码修复时，"修复后重新 dispatch 所有 5 步"还是"只重新 dispatch BLR"？实际执行中选择了后者（只重新 dispatch 有 MUST FIX 的步骤），因为其他 4 步的代码可能没变。但这意味着可能遗漏跨维度回归。

### Automation Gaps

1. **全项目 execSync 扫描**：修复 shell 注入时应该有自动化工具扫描所有 execSync/execFileSync 调用。
2. **跨审查去重**：BLR 和 Robustness 独立发现 backup 路径问题，如果能自动去重可以节省一轮 dispatch。
3. **tsc --noEmit 自动化**：每次修复后都需要手动运行 tsc，应该作为 edit 后的 hook 自动执行。

### Time Sinks

1. **13 个 MUST FIX 的修复 + 重新审查**：约 15 次 subagent dispatch，占总执行时间的大部分。
2. **审批交互重新设计**：从"TUI 循环"改为"per-call"模型，涉及 types.ts + commands.ts + index.ts + widget.ts 四个文件的联动修改。
3. **token-decline 规则反复修正**：先改"均值"为"逐天"，再改窗口重叠，共 2 轮修复。
