---
phase: test
verdict: pass
absorbed: false
topic: "2026-06-03-workflow-vs-claude-code-analysis"
harness_issues:
  - "coding-workflow-gate 的 reviewPrefix 硬编码为 taste_review，不识别 ts_taste_review，与 skill 文档中 TypeScript 项目的命名约定冲突"
---

# Phase 4 Retrospect — Workflow model-switch 集成

## Phase Execution Review

### Summary

Phase 4 执行了 11 个 test case（TC-1-01~06 + TC-3-01~05），全部在 Round 1 通过，无修复轮次。测试通过单元测试自动化执行（vitest），无需手动验证。

**执行统计：**
- TC 总数：11
- 通过：11（Round 1）
- 失败：0
- 执行方式：全部自动化（vitest unit tests）

### Problems Encountered

1. **Gate review prefix 不匹配**：coding-workflow-gate 扩展的 `reviewPrefix` 列表硬编码为 `"taste_review"`，但 xyz-harness-phase-dev skill 指示 TypeScript 项目产出 `ts_taste_review_v*.md`。Phase 4 gate 首次检查时报 "no taste_review_v*.md found"。修复方式：复制 `ts_taste_review_v2.md` 为 `taste_review_v1.md` 作为 alias。

   **根因**：coding-workflow 扩展（TypeScript）和 skill 文档（Markdown）对 taste review 文件命名有不同约定。扩展只认 `taste_review`，skill 要求 TS 项目产出 `ts_taste_review`。这是 harness 自身的命名不一致，不是用户错误。

2. **无实际测试失败**：所有 11 个 TC 在 Phase 3 TDD 阶段已经通过自动化测试覆盖。Phase 4 的"执行"本质上是重跑 vitest 并记录结果到 test_execution.json。这对于纯后端 API/逻辑代码是合理的——集成测试在单元测试中已完成（模块间通过 mock 隔离）。

### What Would Do Differently

- **Phase 3 产出文件命名应考虑 gate 约束**：在 Phase 3 dispatch taste review subagent 时，task prompt 应指定产出文件名为 `taste_review_v1.md`（而非 `ts_taste_review_v1.md`），避免与 gate 扩展的搜索模式冲突。或者在 skill 文档中明确标注 gate 兼容命名要求。

- **test_execution.json 可以更早产出**：test_execution.json 的内容和 Phase 3 的 test_results.md 高度重叠。可以在 Phase 3 TDD 完成后立即生成 test_execution.json 的初始版本，Phase 4 只做增量更新和最终确认。

### Key Risks for Later Phases

- **端到端集成未覆盖**：当前测试通过 mock 隔离了 `loadConfig`、`readCache`、`computePeakRecommend` 等外部依赖。真实的 Pi 运行时集成（model-switch config 文件读取 → resolveModelForScene → orchestrator → agent-pool spawn `pi --model`）未被测试覆盖。Phase 5 部署后需要手动验证完整链路。
- **test_cases_template.json 缺少 TC-1-07**：实际测试文件中有 TC-1-07（providerKey != planName → 返回 providerKey/modelId），但 template.json 中未声明。Phase 3 补充了测试用例但没有同步更新 template。

## Harness Usability Review

### Flow Friction

- **taste_review 命名冲突是最大的摩擦点**：skill 说 TS 项目用 `ts_taste_review`，gate 扩展只认 `taste_review`。用户/harness 开发者需要知道这个不一致才能避免 gate FAIL。建议修复方向：要么 gate 扩展的 `reviewPrefix` 增加 `ts_taste_review` 和 `rust_taste_review`（与 `check_gate.py` 脚本对齐），要么 skill 文档统一为 `taste_review`。

- **test_execution.json 与 test_results.md 职责重叠**：两个文件记录几乎相同的信息（哪些测试通过/失败），但格式不同（JSON vs Markdown）。test_execution.json 有 round/evidence 结构化字段，test_results.md 有终端输出粘贴。对于自动化测试项目，test_execution.json 是唯一有用的，test_results.md 更像仪式性产出。

### Gate Quality

- Phase 4 gate 正确验证了 test_execution.json 的结构和字段类型（布尔值 `passed`、正整数 `round`、非空 `execute_steps`）。
- gate 的 cross-reference 检查（TC ID 匹配）正确工作。

### Time Spent

- 实际测试执行：~30 秒（两次 vitest run）
- test_execution.json 编写：~5 分钟
- gate 命名冲突排查 + 修复：~5 分钟
- 提交推送：~1 分钟
- **Phase 4 总耗时：~12 分钟**（其中 ~40% 是 harness 命名冲突处理）
