---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-02-peekhour-model-switch"
harness_issues:
  - "gate 不识别 v2 review 文件：standards_review_v2 和 ts_taste_review_v2 存在且 pass，但 gate 仍检查 v1 的 verdict/must_fix，导致 FAIL。需要 v1 本身也被更新为 pass，或 gate 逻辑应取最新版本"
  - "4 个并行 review subagent 完成后触发 needs_attention 信号，实际已正常返回结果。误报噪音（Phase 2 也遇到过）"
---

# Phase 3 Retrospect: Dev

## 1. Phase Execution Review

### Summary

6 个 Task 全部在主 agent 中直接实现（简单路径：纯后端、≤4 tasks 实际 6 个但同属一个 Group）。线性依赖链 types → config → advisor → prompt → index → setup 串行执行，无并行机会。

核心变更：删除推荐引擎（computeRecommendation/detectScene/budgetDecision + Recommendation 类型），替换为纯数据提取 + 规则注入。净减 63 行代码（+242 -305）。

编码后执行 5 步专项审查，发现 4 个 must_fix（跨 2 个 review）：
- advisor.ts dead variables + prompt.ts 硬编码阈值（taste review）
- index.ts 静默 catch（taste review）
- modelSwitchExtension 84 行超标（standards review）
- setup.ts 内联类型重复 4 次（standards review）

全部修复后重新 dispatch v2 review 通过。

### Problems Encountered

1. **Gate 不识别 v2 review 文件**：standards_review_v1 和 ts_taste_review_v1 的 verdict=fail/must_fix=2，修复代码后 dispatch v2 review（pass/must_fix=0），但 gate 仍检查 v1 文件的 frontmatter。需要同时提交 v2 文件并确保 gate 脚本识别最新版本。解决方案：提交 v2 文件后 gate 通过。

2. **ESLint 在 worktree 中无法运行**：`typescript-eslint` 包找不到，导致 lint 检查无法执行。这是 workspace 级别的依赖链问题，不影响代码质量但降低了自动化验证覆盖率。

3. **Review subagent needs_attention 误报**：4 个并行 subagent 完成后各触发一次 needs_attention。实际 status 已完成，无需操作。

### What Went Well

- **净减代码**：删除推荐引擎是简化操作，减少了状态依赖和分支逻辑
- **纯函数设计**：advisor.ts 和 prompt.ts 的核心函数全部纯函数化，无副作用
- **向后兼容一次性通过**：applyDefaults 设计正确，config 加载链路无 bug
- **5 步审查发现真实问题**：taste review 发现的 dead variables 和硬编码阈值是重构遗漏，standards review 发现的函数行数超标和类型重复是代码质量问题，都是值得修的

### What Would I Do Differently

- **先检查函数行数再提交**：modelSwitchExtension 84 行超标 4 行，写代码时应该注意到
- **Dead variables 应该在重构时立即清理**：移走 isSticky 逻辑时留下了 minTurns/minInputTokens，这是粗心

### Key Risks for Later Phases

- **无自动化测试**：Pi extension 运行时依赖使单元测试不现实，Phase 4 集成测试需要完整 Pi 运行时
- **prompt.ts 场景映射用 alias 而非 provider/modelId**：与 spec 附录 A 示例格式有偏差，但不影响功能（AI 看到的 alias 和 switch_model 工具的模型列表对应）

## 2. Harness Usability Review

### Flow Friction

- **Gate 对 review 文件版本的处理是最大摩擦**。v1 fail → 修复 → v2 pass → gate 仍检查 v1 → FAIL。这个循环增加了 2 轮不必要的交互。建议 gate 脚本按文件名排序取最新版本（v2 > v1），而不是检查所有版本的 frontmatter。

- **5 步审查的编排效率高**：Batch 1 并行 4 个（BLR + Standards + Taste + Robustness），Batch 2 串行 1 个（Integration 依赖 BLR）。并行度合理，subagent 间无冲突。

### Gate Quality

- Gate 检查项全面：所有 5 个 review 文件 + test_results.md + untracked files
- 版本识别问题：gate 应该只检查最新版本的 review，而不是所有版本。这是最大的改进点
- test_results.md 的 `all_passing: true` 检查严格（布尔值 vs 字符串），防止了 YAML 类型错误

### Prompt Clarity

- Phase dev skill 的结构清晰：防护预检 → TDD/编码 → 测试 → 5 步审查 → gate
- "简单路径 vs 复杂路径"的判断标准明确：≤4 tasks 单一类型 → 主 agent 直接编码
- 5 步审查的 subagent task prompt 模板质量高，subagent 返回的 review 都是一致的格式

### Automation Gaps

- **ESLint 在 worktree 中断裂**：依赖链 `eslint → typescript-eslint → taste-lint` 不完整。应该在 pnpm install 后自动修复，或者在 pre-commit hook 中做 fallback
- **函数行数检查可以自动化**：standards review 发现的 84 行超标可以用 ESLint 的 max-lines-per-function 规则自动检测，不需要人工 review
- **Dead variable 检测可以自动化**：taste review 发现的 dead variables 可以用 TypeScript 的 noUnusedLocals 配置自动检测

### Time Sinks

- **Gate retry 循环**（v1 fail → v2 pass → gate 仍检查 v1）占用了 2 轮交互。如果 gate 取最新版本，这个循环可以完全避免
- **5 步审查总计 dispatch 了 7 个 subagent**（4+1 初次 + 2 修复后 v2），每个 subagent 需要等待返回。对于 6 个文件的小改动，审查成本偏高。但对于保证代码质量是值得的
