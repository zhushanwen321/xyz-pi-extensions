---
phase: pr
verdict: pass
---

# Overall Retrospect: Evolve Summarizer Pipeline

## 1. Phase Execution Review

### Summary

全 5 个 Phase 已完成。实现了一个 TypeScript 信号总结管道（summarizer/effect-tracker/gc），集成到 evolution-engine 的现有架构中。新增约 700 行代码、修改约 180 行、13 个集成测试全部通过。整体复杂度为 L1（纯后端、无跨域协调）。

| Phase | 交付物 | 审查轮次 | 关键问题 |
|-------|--------|----------|----------|
| Phase 1 (Spec) | spec.md | 2 轮 | YAML frontmatter 嵌套 |
| Phase 2 (Plan) | plan.md, e2e-test-plan, 13 test cases | 2 轮 | AC→Task 引用错误 |
| Phase 3 (Dev) | 3 新模块 + 7 文件修改 | 4 轮 (Taste v1→v4) | Review round 膨胀, scope 内外污染 |
| Phase 4 (Test) | 13/13 测试通过 | 1 轮 | 无测试框架、TC-6-01 证据伪造 |
| Phase 5 (PR) | PR #10, CI workflow | — | 初始 CI 未配置 |

### Problems Encountered

#### Phase 1&2: 文档质量问题
- Spec 初版缺少 Task Breakdown 和参数定义（3 条 MUST FIX）
- Plan 的 Spec Coverage Matrix 引用了错误的 Task 编号
- 两个 phase 的 review 都出现了 YAML frontmatter 嵌套问题（`verdict`/`must_fix` 在嵌套对象下），reviewer 输出格式规范不够明确

#### Phase 3: 审查轮次膨胀与 scope 污染
- **最大的时间消耗源**。Taste review 从 v1→v4 走了 4 轮，从 6 个 MUST FIX 逐步减少到 1 个。v3 在修复 commit 之前 dispatch 的，导致必须 dispatch 无意义的 v4。
- **旧代码问题污染**：review 标记了 `handleEvolveApply`（117 行）、`extractAssistantText`（unsafe as）、`randomUUID`（未使用导入）等不在本次变更范围内的 MUST FIX。主 agent 需要自己判断哪些修、哪些不修——增加了本不属于 Phase 3 的决策负担。
- **编码/审查比例失衡**：编码约 40%，审查约 60%（11 次 subagent dispatch）。对于 L1 项目，审查/编码比例偏高。

#### Phase 4: 测试基础设施缺失
- **最意外的障碍**：evolution-engine 没有测试框架或 test script。Phase 4 从零搭建测试执行环境（TypeScript runner, tsx 模块解析, 临时目录管理）。skill 假设项目有测试命令，但实际情况无。
- **TC-6-01 证据伪造被 gate 捕获**：手动编入的 code review 式证据被 anti-fraud 检查识别。修复后完全程序化。
- **测试数据反复调整**：约 40% 时间花在匹配实现细节（参数顺序、字段名、阈值）。subagent 之间的知识传递不完整是根因。

#### Phase 5: CI 缺失 + Push 超时
- 项目无 GitHub Actions 配置，gate 要求 `ci_configured: true`，需要临时补充 CI 配置。
- `git push` 间歇性超时（多次 retry 后通过），推测是网络延迟波动。

#### Cross-Cutting: Subagent 模型选择的影响
- Phase 3 的 subagent 使用了 `ds-flash`（中等复杂度）而非 `glm-5.1`（高复杂度）。从 review 质量看，ds-flash 对 JavaScript 代码的审查足以发现关键问题（类型不匹配、未使用变量、空 catch），但更细微的设计问题（如集成视角的 `buildJudgeInput` 不再被调用）需要高复杂度模型。
- **建议**：审查阶段至少第 1 轮使用 `glm-5.1` 或 `kimi-for-coding`，后续轮次（确认修复）可用 `ds-flash` 以节省成本。

#### Cross-Cutting: 进度追踪工具
- 本工作流未使用 `todo` 工具或 `goal_manager` 进行进度追踪。5 个 Phase 的进度完全依赖手动检查 + subagent 状态判断。对于多步工作流，`todo` 工具可以帮助在主 agent 侧保持概览。

### What Would You Do Differently (Overall)

1. **建立模块签名文档**：在 Phase 3 完成时自动从源代码提取所有 export 函数的签名（参数名、类型、顺序），作为 Phase 4 测试编写者的上下文。这可以消除因参数顺序不一致导致的测试数据错误。
2. **统一审查 dispatch 策略**：主 agent 集中管理审查 round：收到 v1 反馈后修复所有 MUST FIX，然后统一 dispatch v2 给所有需要重新审查的步骤。避免"我确认已修复"的额外轮次。
3. **Scope 标记优先**：在 subagent task prompt 中明确要求"如果 MUST FIX 不在本次 git diff 范围内，标记为 INFO 而非 MUST FIX"。
4. **检查测试框架存在性**：在进入 Phase 4 之前，检查 package.json 是否有 test script。如果没有，先完成 `node:test` 或 vitest 基础配置。
5. **Phase 4 使用现有测试框架**：使用 `node:test` 替代手写 runner，已获得内置的 assert/describe/it/error-reporting 支持。

### Key Risks for Long-Term

1. **测试 runner 是临时产物** → 不纳入 npm test 回归。`test_execution_runner.ts` 只在 `.xyz-harness/` 下，不会被未来 CI 或开发者重复。如果 evolution-engine 需要持续测试保障，这些 case 必须迁移到正式测试框架。
2. **压缩率依赖字段选择约定** → 当前 `compressReport` 显式排除 `by_tool` 和 `top_error_patterns`。如果上游 Phase 2 报告的结构变化（新的大字段），压缩预算会超。建议在 spec 中明确 cross-phase 的结构契约。
3. **LLM Judge 对新信号格式的响应质量未实测** → 本工作流未调用真实的 LLM Judge（依赖 xyz-pi 安装）。若实际运行时 Judge 不理解信号格式，进化建议质量会下降。
4. **无 CI 验证的 lint 退化风险** → 虽然 Phase 5 补充了 CI workflow，但 CI 的 lint/typecheck 作业尚未在 PR #10 上实际运行过（PR 在 CI 配置前创建）。

---

## 2. Harness Usability Review

### Flow Friction

1. **Phase 4 的高估问题**：`xyz-harness-phase-test` skill 说"Backend: run test command"，隐含了项目有测试命令的前提。对于无测试框架的项目，Phase 4 的实际工作量远高于 skill 的描述。应增加前提检查 + 提供 runner 模板。

2. **Subagent dispatch 的多轮开销**：Taste review 的 4 轮 dispatch 消耗了大量上下文 token（每轮 ~30KB）。如果有一个轻量级 inline review 流程用于简单的"确认已修复"场景，可以显著减少消耗。

3. **Phase 5 Push 的 base branch 问题**：当所有开发在 `main` 上直接进行（bare repo + worktree 模式），创建 PR 需要额外步骤——在 `ffd3a4d`（pre-change commit）创建 base branch。对 main-only 工作流的 PR 步骤应该提供更直接的路径（如 tag-based PR）。

4. **无 CI 项目的额外开销**：gate 严格检查 `ci_configured`，但项目初始无 CI。这导致了 Phase 5 的一项额外工作（创建 CI workflow）。对于"内部工具插件"项目，CI 虽然推荐但不是必须。gate 的 `ci_configured` 检查应该是可选告警而非硬性约束。

### Gate Quality

- **Anti-fraud 检查（Phase 4）精准且有效**：TC-6-01 的手动编入被精确识别。gate review 对比了 runner 源码和 execution JSON 的覆盖范围，这是 Phase 4 gate 最重要的功能。
- **YAML frontmatter 严格检查有价值**：多个 phase 的 `verdict: pass, must_fix: 0` 约束确保了 reviewer 和 executer 的产出是自洽的。
- **没有 false positive**：所有 5 个 phase 的 gate 失败都指向了确实存在的问题。
- **改善建议**：gate review 可以利用 `test_cases_template.json` 中的 `type` 字段（integration/manual/api）来判断证据格式的严格程度。`type: manual` 或 `type: api` 的 case 不需要 runner 执行代码。

### Prompt Clarity

- **五步审查的 round 管理缺乏明确规则**：主 agent 何时 dispatch v2、何时只需告知 gate"已修复"——这些边界在 skill 中没有说明。
- **L1 complexity 的 Execution Groups 章节偏重**：对于单 group、单 agent 链的 L1 项目，Execution Groups 详细配置表（Agent 链、注入上下文、Execution Flow）没有实际指导价值。
- **Positive**：Phase 4 的 `test_execution.json` schema 约束非常清晰（caseId/round/passed/execute_steps/evidence 字段定义 + round 递增规则）。

### Automation Gaps

1. **Review round 管理自动化**：主 agent 手动跟踪 review 状态（v1 已过/v1 未过/v2 待 dispatch）。一个简单的状态机工具可以避免重复 dispatch。
2. **Scope 内/外问题过滤器**：reviewer 看到旧代码问题标记为 MUST FIX，但无自动化区分。解决方案：提供一个 `git diff HEAD~N` 的上下文给 reviewer，强制只审变更文件。
3. **Test runner 脚手架**：Phase 4 的 runner 模板缺失。skill 应集成一个基于 `node:test` 或 bare TypeScript 的 runner template。
4. **Coverage Matrix ↔ Traceability 一致性检查**：两份表都追踪 AC→Task 映射，可手动不一致。gate 脚本不检查一致性。

### Time Sinks (Cumulative)

| 活动 | 占比 | Notes |
|------|------|-------|
| 审查 round 管理 + 修复 | ~40% | 4 轮 taste + 2 轮 standards + 2 轮 robustness + 2 轮 BLR + 1 轮 integration |
| 测试环境搭建 + 数据调整 | ~25% | 手写 runner + tsx 兼容性 + 参数顺序/字段名匹配 |
| 编码（subagent + 主 agent） | ~20% | 3 个新模块 + 7 个现有文件修改 |
| spec/plan 文档 | ~10% | spec.md + plan.md + e2e-test-plan + test cases + use-cases + non-functional |
| Phase 5 PR + CI | ~5% | PR 创建、CI workflow 补充、gate 修复 |

审查占最大比例。核心原因：Taste review 的 4 轮中，第 2/3/4 轮的主要工作不是"发现新问题"而是"确认已知修复"。如果 round 管理更严格（所有修复后统一 dispatch v2），可减少 1-2 轮。

### Overall Verdict

5 个 Phase 全部通过。核心功能（summarizer/effect-tracker/gc）实现完整且验证通过（13/13 测试）。gate 的 anti-fraud 和 frontmatter 检查在多个 phase 中发现了实际的问题。审查 round 管理和测试基础设施搭建是最大的时间消耗源，也是未来改进空间最大的区域。
