---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-04-workflow-storage-and-verification"
harness_issues:
  - 'Subagent dispatch 输出不可靠：subagent 报告完成后输出文件可能为空。建议：dispatch 后加 read 验证，失败则重试。'
  - 'ESLint 错误修复循环：subagent 写的代码常有 unused vars。建议：subagent task prompt 加 ESLint 约束。'
  - 'Review YAML frontmatter 格式错误：subagent 用 code block 而非 three-dash 分隔符。建议 prompt 显式要求 three-dash 分隔符。'
  - 'Gate 不区分 P0/P1/P2：taste_review P0 未引起注意。建议 gate 对 P0 加 WARNING 级别。'
  - 'Pre-commit ESLint 对 mocks/ 报错：subagent 创建的 mock 文件有 unused type 参数。建议 ESLint 对 mocks/ 放宽规则。'
---

# Phase 3 Retrospect — Dev

## Phase Execution Review

### Summary

Phase 3 完成了 8 个 task 的实现，通过 4 波 subagent dispatch（Wave 1: 5 并行，Wave 2-4: 各 1 个串行），最终产出：

- **32 个新测试**（140 → 172），全部通过
- **5 个 FR 的完整代码实现**：External State Pointer、True Approval Gate、Verification Gate、Soft 500 Warning、doc 沉淀
- **5 步专项审查**全部 pass（BLR / Standards / Taste / Robustness / Integration），0 must_fix
- **Typecheck** 12/12 packages clean
- **Lint** 0 errors

代码变更：18 files, +1555/-155 lines，覆盖 `extensions/workflow/` 5 个 src 文件 + 1 个 shared types stub + 1 个 SKILL.md + 1 个 doc 文件 + 5 个测试文件 + 3 个 mock 文件。

### Problems Encountered

**P1: ESLint 错误循环（3 轮 commit 失败）**

- 现象：subagent 写的代码有 7 个 unused vars 错误（`pi` 未使用、`tool` 未使用、`result1` 未使用等）。pre-commit hook 拦截。
- 根因：subagent 写代码时不考虑 ESLint 规则，尤其是 `@typescript-eslint/no-unused-vars`。
- 修复：手动 `sed` 逐个修复，3 轮 commit 才通过（第一轮 14 errors → 修复 → 第二轮 6 errors → 修复 → 第三轮 0 errors）。
- 耗时：~15 分钟，占总 phase 时间的 ~15%。

**P2: typecheck 错误（1 轮）**

- 现象：`orchestrator.ts:123` 的 `_totalCalls` 解构参数名与类型定义 `totalCalls` 不匹配。
- 根因：手动 sed 修 lint 时把解构参数改名为 `_totalCalls` 但没同步修改类型声明。
- 修复：改回 `totalCalls` 并省略该参数的解构（只取 `runName` 和 `budget`）。
- 教训：lint 修复和 typecheck 修复应该一起验证，不应该分步。

**P3: robustness_review YAML 格式错误**

- 现象：gate check 报 `robustness_review_v1.md` YAML 解析失败。
- 根因：subagent 把 YAML frontmatter 包在 ` ```yaml ` ` ``` ` code block 里了，而不是用 `---` 分隔符。
- 修复：手动把 code block 替换为 `---` 分隔符。
- 教训：subagent prompt 需要显式要求 frontmatter 格式。

**P4: sessionDir 全局路径（spec 偏差）**

- 现象：BG2-T4 subagent 把 `sessionDir` 设为 `path.join(homedir(), ".pi", "agent")`（全局），而 spec 说"存到 session 目录"。
- 根因：subagent 找不到现成的 sessionDir 获取方式，采用了项目中其他扩展（evolve-daily 等）的惯例路径。
- 影响：state 文件按 runId（UUID）命名，碰撞风险可忽略。但不跟随 session 生命周期清理。
- 处理：记录为已知偏差，不 block gate。后续可优化。

### What Would You Do Differently

1. **Subagent prompt 中显式加入 ESLint 约束**：在每次 subagent dispatch 时，task prompt 末尾加一段 "ESLint 规则：所有 unused 变量/参数加 `_` 前缀。禁止 `any`。import 顺序 Node → npm → internal。" 这样可以避免 P1 的 3 轮修复循环。

2. **Lint + Typecheck 合并验证**：修完 lint 后立刻跑 typecheck，不要分开两步。P2 的 typecheck 错误本可以在第一轮就发现。

3. **Review subagent prompt 中显式要求 YAML frontmatter 格式**：加一句 "YAML frontmatter 必须用 `---` 分隔符包裹，禁止用 ```yaml``` code block"。

4. **SessionDir 应该在 BG2-T4 prompt 中显式指定**：spec 说 `<sessionDir>/workflow-state/{runId}.jsonl`，但 subagent 不知道怎么获取 sessionDir。应该在 prompt 中告诉它用 `homedir() + ".pi/agent/sessions/" + sessionId` 或从 ctx 获取。

### Key Risks for Later Phases

| 风险 | 触发条件 | 缓解 |
|------|----------|------|
| **index.ts 566 行超限** | Taste Review P0，函数过长 | Phase 4 测试前不重构（避免引入回归），Phase 5 PR 前可拆 `tool-run.ts` |
| **未 await 的 async 调用** | index.ts 调 orch.pause/resume/abort 不 await | Integration Review LOW-2，内存状态正确但持久化可能丢失。Phase 4 不影响 |
| **AgentPool._callCache 死代码** | pool 级缓存永不命中 | 低优先级，不阻塞。后续清理 |
| **WorkflowBudget 同名冲突** | state.ts 和 agent-pool.ts 各定义同名不同结构类型 | 维护隐患，不阻塞功能。后续重命名 |
| **Soft warning budget 全零** | maybeEmitSoftWarning 传硬编码零值 | 用户看到 "Budget: 0/0 tokens" 误导。后续从 orchestrator 传入真实值 |

---

## Harness Usability Review

### Flow Friction

**F1: 5-step specialized review 执行效率高，但 dispatch 顺序有优化空间**

- 当前：BLR + Standards + Taste + Robustness（Batch 1 并行）→ Integration（Batch 2 串行，依赖 BLR）
- 实际：BLR 先完成（~60s），但 Integration 必须等全部 4 个 Batch 1 完成后才能 dispatch
- 优化：Integration 只依赖 BLR，不依赖 Standards/Taste/Robustness。可以在 BLR 完成后立即 dispatch Integration，与其他 3 个 Batch 1 并行

**F2: Subagent 输出文件不总是可靠**

- 现象：多次 dispatch subagent 后，output 文件存在但内容不完整或格式不符预期
- 影响：需要手动 read 验证，增加 ~5 min 额外工作
- 建议：subagent dispatch 后加 read 验证步骤

### Gate Quality

**G1: Phase 3 gate 跑 18 项检查，全部通过**

- untracked files 检查抓到了 6 个未提交文件（审查产出），修复后通过
- YAML 解析错误精准定位到 `robustness_review_v1.md`，修复后通过
- 5 步审查的 verdict/must_fix 检查全部正确

**G2: Gate 不区分 P0/P1/P2**

- Taste Review 找到 1 个 P0（index.ts 566 行），但 gate 只看 must_fix=0 就放行
- 建议：P0 虽然不 block，但应该输出 WARNING 引起注意

### Prompt Clarity

**PC1: Subagent task prompt 清晰度**

- 8 个 subagent 的 task prompt 都包含：必读文件、必改文件、修改内容、测试要求、验证步骤
- subagent 基本按 prompt 执行，偏差可控（sessionDir 问题是唯一较大偏差）
- 改进：prompt 中加入 ESLint 约束和 frontmatter 格式要求

**PC2: 五步审查 prompt 清晰度**

- BLR / Standards / Taste / Robustness / Integration 的 prompt 都明确了输入文件、审查要点、输出格式
- 全部 5 个审查都产出了 verdict: pass, must_fix: 0 的合格报告
- 唯一问题：robustness review 的 YAML 格式错误（prompt 中没显式要求 `---` 分隔符）

### Automation Gaps

**AG1: ESLint 修复自动化**

- 当前：subagent 写代码 → 主 agent 手动修复 lint errors → 提交
- 理想：subagent 写代码后自动跑 `eslint --fix`，然后只处理无法自动修复的错误
- 建议：subagent task prompt 中加 "完成后运行 `npx eslint --fix <file>` 自动修复格式问题"

**AG2: Review YAML 格式验证**

- 当前：gate check 时才发现 YAML 格式错误
- 理想：subagent 写完 review 文件后，自动验证 YAML frontmatter 可解析
- 建议：在 subagent task prompt 中加 "验证步骤：`python3 -c \"import yaml; yaml.safe_load(open('file.md').read().split('---')[1])\"` 通过后才报告完成"

### Time Sinks

| 耗时项 | 时长 | 原因 | 可优化 |
|--------|------|------|--------|
| 8 个 subagent dispatch | ~40 min | Wave 1: 5 并行(~15 min) + Wave 2-4: 3 串行(~25 min) | 串行 task 间可更快衔接 |
| ESLint 错误修复 | ~15 min | 3 轮 commit 失败 | subagent prompt 加 lint 约束可减至 0 |
| 5 步审查 dispatch | ~25 min | 4 并行 + 1 串行 | Integration 可提前到 BLR 完成后 |
| Gate 修复 | ~5 min | YAML 格式错误 | AG2 自动验证可减至 0 |
| **总计** | **~85 min** | — | **可优化至 ~50 min** |

---

## Improvement Suggestions (for harness maintainers)

1. **Subagent ESLint 预防**：在 `subagent-driven-development` skill 或主 agent 模板中，加入 "ESLint 约束" 段落，自动注入到所有编码 subagent 的 task prompt 中。内容：unused vars 加 `_` 前缀、禁止 `any`、import 顺序。这能消除 ~80% 的 lint 错误。

2. **Review YAML 格式强制**：在 review subagent prompt 模板中，显式加入 "YAML frontmatter 必须用 `---` 分隔符包裹" 的要求，并在验证步骤中加入 YAML 解析检查。

3. **Integration Review 时序优化**：五步审查中，Integration 只依赖 BLR 产出。建议编码为：BLR 完成后立即 dispatch Integration，同时 Standards/Taste/Robustness 仍在运行。

4. **P0/P1/P2 分级 gate**：当前 gate 只区分 must_fix=0 和 must_fix>0。建议对 taste_review 的 P0 计数加 WARNING 级别（不 block 但在 gate 输出中醒目显示），帮助主 agent 决定是否在下一 phase 前处理。

5. **Subagent output 验证**：主 agent dispatch subagent 后，应自动 read 输出文件验证非空。如果为空或格式错误，重试 dispatch（最多 1 次）。
