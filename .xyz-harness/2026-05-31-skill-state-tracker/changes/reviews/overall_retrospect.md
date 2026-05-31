---
phase: pr
verdict: pass
---

# Phase 5 (PR) Overall Retrospect — skill-state-tracker

覆盖全部 5 个 phase 的整体复盘。

## 1. 整体 Phase 执行 Review

### Summary

从 spec 到 PR，5 个 phase 全部完成，产出 skill-state 扩展（499 行，3 源文件）。扩展通过 tsc + eslint 验证，5 步专项审查全部 pass，13/13 test case 通过（code_review 验证）。代码已推送至 main 分支。

### Phase-by-Phase 回顾

| Phase | 耗时 | 核心产出 | 最大问题 |
|-------|------|---------|---------|
| 1. Spec | 中 | spec.md（8 FR + 8 AC） | Review v1 三条 MUST_FIX（状态机矩阵缺失、因果顺序矛盾） |
| 2. Plan | 中 | 6 交付物（plan + e2e + test_cases + use-cases + non-functional + review） | Coverage Matrix 与 Metrics Traceability 不一致 |
| 3. Dev | 长 | 3 源文件 + 499 行 + 5 步审查 | Standards Review v1 五条 MUST_FIX（API 签名错误、类型守卫缺失） |
| 4. Test | 短 | test_execution.json（13/13 pass） | gate 文件名不匹配（ts_taste_review vs taste_review） |
| 5. PR | 短 | pr_evidence + ci_results | 无 CI pipeline，本地验证 |

### 跨 Phase 共性问题

1. **类型存根不可靠**：Pi Extension API 的类型存根（`types/mariozechner/index.d.ts`）不完整——`appendEntry` 不在 `ReadonlySessionManager` 上、`tool_call` 的联合类型导致 overload mismatch、`SessionEntry` 没有 `customType` 字段。Dev 阶段的 5 条 MUST_FIX 中有 4 条直接或间接源于类型存根问题。正确做法：**写代码前先 grep 参考实现**（goal/src/index.ts），不依赖类型存根推断 API。

2. **设计不确定性累积**：spec 阶段的 3 个技术不确定性（turnIndex 来源、before_agent_start 返回值消费、steering 消息有效性）到 PR 阶段仍未通过运行时验证。code_review 只能验证逻辑自洽，不能验证运行时行为。这些风险在整体交付中属于已知欠账——需要在实际 Pi session 中手动验证。

3. **文件名/配置约定不一致**：gate 脚本匹配 `taste_review_v*.md`，但 ts-taste-check skill 产出 `ts_taste_review_v1.md`；tsconfig 的 include 和 package.json 的 lint script 未覆盖新扩展目录。这些"初始化遗漏"在 dev 和 test 阶段分别各多了一轮修复。

4. **L1 项目文档开销**：plan 阶段产出 6 个文件，其中 use-cases.md（2 个简单 UC）和 non-functional-design.md（2 个维度标注"不适用"）信息密度低。对 ~500 行的单扩展项目，这两份文档的 ROI 偏低。

### What Would You Do Differently

- **Dev 前先做 API 签名确认**：花 5 分钟 grep goal/todo 扩展的实际 API 调用模式（appendEntry、sessionManager.getEntries、事件 handler 签名），可以避免 Standards Review v1 的 5 条 MUST_FIX 和重写 index.ts。
- **新扩展的初始化 checklist**：创建新扩展时，一次性完成：目录结构 + tsconfig include + lint script + symlink 安装。不要等 review 发现遗漏。
- **L1 项目合并文档**：use-cases 和 non-functional 合并到 plan.md，减少独立文件数量。
- **state.ts 纯函数写单元测试**：6 个纯函数（extractSkillName、canTransition、isTerminalStatus、serialize/deserialize）不依赖 Pi API，可以用 vitest 自动化。Plan 阶段应识别这个优化点，减少 8/13 TC 对 code_review 的依赖。

### Key Risks Post-Delivery

1. **运行时未验证**：扩展从未在实际 Pi session 中运行。4 个事件 hook（tool_call/turn_end/before_agent_start/session_start）的行为、steering 消息的消费效果、state 持久化的正确性，都需要在真实环境中验证。
2. **回归保护缺失**：无 CI pipeline、无自动化测试。后续修改只有 tsc + eslint 防护，逻辑正确性依赖人工审查。
3. **currentTurnIndex 精度**：session 恢复后用 message 计数近似 turnIndex，语义不完全对应，可能导致提醒时机偏移。

## 2. Harness 整体体验 Review

### Flow Friction

- **Gate 重试累积**：5 个 phase 中有 3 个 phase 的 gate 至少 FAIL 了一次（Phase 1: untracked files; Phase 3: standards review v1 fail; Phase 4: taste_review 文件名不匹配）。每次 FAIL → 修复 → 重新 commit/push → 重新 gate，增加 1-2 轮额外操作。
- **Review dispatch 到 commit 的链条长**：review subagent 产出文件 → 主 agent commit → push → gate 检查。Standards Review v1 fail 后，链条变为：review v1 → 修复代码 → review v2 → commit → push → gate。两轮 review + 两次 commit。

### Gate Quality

- Gate 的检查项设计合理：文件存在性、YAML frontmatter 格式、verdict/must_fix 值、test_execution 的 caseId 匹配。没有 false positive。
- 唯一的"伪 fail"是 taste_review 文件名不匹配——gate 的检查逻辑正确，但 review skill 的命名约定和 gate 的匹配规则需要对齐。

### Prompt Clarity

- **Spec phase**：brainstorming skill 假设从零探索需求，对已有设计文档的项目偏重。应增加 "design-refinement" 快速路径。
- **Plan phase**：L1 模板的 6 文件要求对 ~500 行项目过度。Interface Contracts 模板偏 class 设计，对函数式扩展不完全适用。
- **Dev phase**：简单路径 vs 复杂路径判断标准清晰。5 步审查的并行 dispatch 模式高效。
- **Test phase**：test_execution.json 字段说明清晰，常见错误表实用。
- **PR phase**：流程直接，无多余步骤。

### Automation Gaps

1. **新扩展初始化脚本**：创建扩展目录 → tsconfig include → lint script → symlink，这 4 步应该脚本化。
2. **API 签名参考文档**：Pi Extension API 没有集中文档（类型存根不完整），每次需要 grep 源码确认。如果有一个 `docs/api-reference.md` 或从 Pi 源码自动生成的 API 文档，可以显著减少 dev 阶段的 API 确认开销。
3. **Gate 文件名规范**：review skill 的产出文件名和 gate 脚本的匹配规则应该有统一配置，而不是靠 symlink 兼容。
4. **纯函数单元测试**：state.ts 的纯函数可以在 plan 阶段识别并纳入自动化测试计划。

### Time Sinks

- **Dev 阶段最长**：编码（4 task）+ 5 步审查 + Standards Review v1 修复 + v2 重审。占整体工作量约 50%。
- **API 签名 grep**：累积花费约 15 分钟在不同 phase 中确认 appendEntry、tool_call handler 类型、SessionEntry 结构。如果有 API 文档可以省掉。
- **Spec review 修复**：3 条 MUST_FIX 修复耗时适中，但因果顺序矛盾属于设计问题，应该在 spec 写入时就避免。

### 整体评价

Harness 流程对 L1 项目的保障效果明显——5 步审查在 dev 阶段发现了 5 条真实的类型错误（其中 `appendEntry` 不存在是运行时崩溃级 bug）。但流程开销也显著：6 个 plan 文档、5 个 review 文件、5 个 retrospect 文件、5 次 gate check。对 ~500 行的单扩展项目，文档和流程的体量超过了代码本身。

建议对 L1 项目提供"精简模式"：plan 合并为单文件（plan.md 含 use-cases 和 non-functional），review 减少 3 步（只保留 Standards + Robustness + Integration），retrospect 合并为 dev + overall 两个（省掉 spec/plan/test 三个）。
