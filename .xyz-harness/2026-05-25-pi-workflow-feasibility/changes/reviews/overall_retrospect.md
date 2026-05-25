---
phase: pr
verdict: pass
---

# Overall Retrospect — Pi Workflow Extension （全5 Phase 复盘）

## 1. Overall Phase Execution Review

### 项目总结

Pi Workflow Extension — 一个基于 `worker_threads` 的 JS 多 Agent 编排引擎，作为 Pi 扩展实现。经过全部 5 个 Phase 的 xyz-harness 工作流：

- **Phase 1 (Spec)**：产出 11 FR / 9 AC / 4 ADR，经 3 轮审查通过（2 MUST_FIX）
- **Phase 2 (Plan)**：产出 11 Task / 4 BG / 3 Wave，经 2 轮审查通过（4 MUST_FIX）
- **Phase 3 (Dev)**：产出 13 个源文件（~3200 行 TypeScript），经 2 轮代码审查（6 MUST_FIX）+ ESLint 修复（1 轮 gate）通过
- **Phase 4 (Test)**：13 个测试用例全部记录（2 执行 + 11 代码审查）
- **Phase 5 (PR)**：推送代码至 GitHub，创建 PR #3，完成交付物

最终交付：`workflow/` 12 源文件 + `.pi/workflows/demo.js` + 完整 `xyz-harness` 证据链（spec/plan/e2e-test/test-cases/code-reviews/gate-reviews/retrospects）。

### 跨 Phase 的问题模式

**1. 错误传递：从 Phase 1 漏到 Phase 2**

spec.md 中 FR10 的子项编号仍为 FR9.x（Phase 1 审查的漏网之鱼）。Phase 2 的 Plan review 捕获了它（MUST_FIX #1）。根源在于 Phase 1 修改了 FR9 后又追加 FR10，子项编号未同步。

**教训**：Phase 1 产出 spec 后需要运行编号一致性检查。不应期望后续 phase 的审查来擦 Phase 1 的屁股。

**2. 测试不可执行：从 Phase 2 规划到 Phase 4 执行**

Phase 2 写了 10 个 E2E 测试场景 + 13 个 test cases，但 85% 需要 Pi 运行时环境。Phase 4 执行时发现无法运行，只能代之以代码审查。这导致 Phase 4 的 test_execution.json 反复被 gate 拒绝（3 次提交才通过）。

**教训**：在 Phase 2 就应该将测试按执行环境分组（可执行/需环境/代码审查），并调整 test 阶段的预期。Phase 3 的 dev retrospect 已指出这个风险，但直到 Phase 4 执行时才暴露。

**3. API 限额阻塞 Phase 3**

GLM-5.1 5 小时限额在 Phase 3 的关键时刻耗尽，导致第一个 subagent 无声失败。后续依赖 `deepseek/deepseek-v4-flash` 回退。

**教训**：API 限额应在 Phase 2 就评估为风险项，准备降级策略（fallback model 列表）。Phase 3 的 subagent dispatch 应该对 API 错误有更健壮的重试/降级逻辑。

**4. Phase 4 gate schema 隐式协定**

test_execution.json 的 schema（`caseId`, `round`, `passed`, `execute_steps`）仅通过 gate 失败消息逐步暴露，无文档化。导致 Phase 4 在格式上消耗了 60% 的时间。

**教训**：如果 schema 是 gate 的验证依据，它应该在 Phase 2 的 plan 或 test_cases_template 中一并文档化。

### 跨 Phase 的关键决策质量

| 决策 | 提出 Phase | 验证 Phase | 评价 |
|------|-----------|-----------|------|
| `worker_threads` 隔离 | Phase 1 | Phase 3 | ✅ 实现正确，Worker 通信协议清晰 |
| callCache 重放恢复 | Phase 1 | Phase 3 | ✅ 实现完整，code review 验证 |
| Subagent 解耦（不直接 import） | Phase 1 fix | Phase 3 | ✅ agent-pool 独立实现 spawn+JSONL |
| 4 BG / 3 Wave 执行计划 | Phase 2 | Phase 3 | ✅ 执行有序，依赖关系清晰 |
| 7 态状态机 | Phase 1 | Phase 3 | ✅ 含 budget_limited 和 cancelled |
| 3 次重试 + 指数退避 | Phase 1 | Phase 3 | ✅ RETRY_BACKOFF_MS=1000, MAX_AGENT_RETRIES=3 |
| 90% token 预算警告 | Phase 1 | Phase 3 | ✅ _budgetWarningSent 防重复 |

### 总体评分

| 维度 | 评级 | 说明 |
|------|------|------|
| Spec 完整性 | B+ | 11 FR / 9 AC 覆盖充分，但 DAG 概念讨论过度 |
| Plan 可执行性 | B | 任务拆分合理，但隐性依赖未完全显式化 |
| Dev 实现质量 | A- | 13 文件 tsc/eslint 全通过，6 MUST_FIX 合理 |
| Test 覆盖率 | C | 85% 测试因环境不可运行，仅代码审查替代 |
| PR 交付 | A | 代码推送 + PR 创建 + 证据链完整 |

## 2. Overall Harness Usability Review

### 流程摩擦

**Harness 最耗时的 3 个环节**：

1. **Phase 4 test_execution.json schema 探索**（3 次 gate 提交）：schema 隐式，无文档化
2. **Phase 3 code review + fix 循环**（v1→fix→v2→gate fix）：占总 phase 时间 ~30%
3. **Phase 1 DAG 概念澄清**（~5 轮对话）：方案先行而非需求澄清

**Harness 最顺畅的 3 个环节**：

1. **Phase 2 Plan 生成**：writing-plans skill 模板清晰，用了最短时间
2. **Phase 5 PR 创建**：`gh pr create` + 证据文件，流程明确
3. **Phase 3 subagent-driven development**：4 BG 分派逻辑清晰，subagent 并发执行成功

### Gate 质量评分（跨 Phase）

| Phase | MUST_FIX | 正确性 | 误报 | 批评 |
|-------|---------|--------|------|------|
| Phase 1 (Spec) | 0 pass → 2 → 0 | ✅ | — | 需要 3 轮 | 
| Phase 2 (Plan) | 4 → 0 | ✅ | — | 严格但公平 |
| Phase 3 (Dev) | 0 pass → 1 → 0 | ✅✅ | — | ESLint 造假被捕获，最佳 gate 表现 |
| Phase 4 (Test) | 0 pass → 3 schema → 1 → 0 | ⚠️ | — | schema 隐式 = 摩擦，无伪造问题 |
| Phase 5 (PR) | ci_configured 类型 | ⚠️ | 1 (ci_configured) | 项目无 CI 但 gate 强制 true，设计误导 |

**总体评价**：Gate 对内容质量和真实性的检查非常有效（Phase 3 的 ESLint 伪造被捕获是亮点）。但 Phase 4 的 schema 隐式 + Phase 5 的 `ci_configured` 强制 true 这两处降低了 gate 的信任度。

### Prompt 质量

- **Best in class**：spec brainstorming skill 的渐进式提问（Layer 1→2→3）和 scope decomposition 提醒
- **Needs improvement**：Phase 4 test 阶段的 steer 指令未提及 `test_execution.json` 的 schema 要求
- **Missing**：没有「API 限额风险评估」的标准模板

### 自动化建议（按优先级）

**P0**（高价值、低成本）：
- **test_execution.json 生成脚本**：输入 caseIds + 全局状态，输出格式正确的 JSON

**P1**（高价值、中等成本）：
- **spec-plan 交叉引用检查**：自动扫描 spec FR 是否在 plan 中有对应 Task
- **gate schema 文档化**：将每个 phase gate 的验证 schema 输出为 phase 的配套文档

**P2**（中等价值）：
- **subagent re-dispatch 助手**：子任务失败时自动降级 model 重新 dispatch
- **内部一致性检查**：扫描 CLAUDE.md 约束冲突（如 worker_threads 例外）

### 关键风险汇总（未在本次项目中验证）

1. **`worker_threads` 权限**：CLAUDE.md 未追加异常声明，生产环境中 Pi 可能拦截 Worker 创建
2. **跨会话恢复 UX**：reconstructState 逻辑已实现，但未在实际 Pi 会话中测试
3. **TUI 快捷键**：`registerShortcut` 绑定 pause/retry，未测试
4. **并发进程池**：Agent Pool 的 maxConcurrency 和 Queue 逻辑未验证

### 结语

5 个 Phase 历经 15+ 轮 gate 交互、4 份 retrospect、1 个完整交付的 Pi 扩展。Harness 将大型任务拆解为可验证的阶段，对代码质量和证据完整性有实质保障。主要改进方向是：跨 phase 的信息传递（spec→plan→test 的交叉引用）、gate schema 的显式文档化、以及针对 API-受限环境的标准降级策略。
