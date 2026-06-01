---
phase: test
verdict: pass
absorbed: false
topic: "2026-06-01-merge-harness-extensions-monorepo"
harness_issues:
  - 'test_execution.json 的 schema 是通过反复 gate 失败才摸索出来的（先缺 execution 数组名，再缺 caseId/round/execute_steps，再缺 passed 布尔字段）。Gate 脚本应该输出期望 schema 示例，或者 test_cases_template.json 中应该包含 execution 记录的 schema 定义，而不是让执行者猜。'
  - 'dev_retrospect.md 的 YAML 解析失败是因为 harness_issues 数组中的字符串包含 @zhushanwen/pi-subagent，双引号内的 @ 在某些 YAML 解析器中触发错误。harness 的 retrospect 模板应该提示：harness_issues 字符串用单引号包裹，或对 @ # : 等特殊字符转义。'
  - 'taste_review 文件命名不一致：审查产出 ts_taste_review_v1.md，但 gate 搜索 taste_review_v*.md。五步审查的文件命名规范没有在 skill 中明确说明，导致执行者按自己理解命名。建议在 coding-workflow 的 dev skill 中列出审查文件命名规范。'
---

# Test Phase Retrospect

## 1. Phase Execution Review

### Summary

Phase 4 产出 test_execution.json（17 个 TC，全部 pass），gate 通过。实际测试执行在 Phase 3 的 dev_retrospect.md 之前已完成（test_results.md + 22 项结构验证），Phase 4 主要是格式化和通过 gate。

17 个测试用例覆盖了 8 个 Test Scenario：
- TS-1 Monorepo 基础设施（2 TC）
- TS-2 npm 包可发布（3 TC，1 个 known deviation）
- TS-3 代码迁移完整性（6 TC）
- TS-4 依赖关系（1 TC）
- TS-5 去重验证（1 TC，含 known deviation）
- TS-6 类型检查（1 TC）
- TS-7 功能回归（2 TC，手动验证）
- TS-8 Harness 仓库归档（1 TC）

### Problems Encountered

1. **YAML 解析失败阻塞 Phase 启动**：Phase 4 无法启动，因为 Phase 3 的 dev_retrospect.md 中 `harness_issues` 数组的双引号字符串包含 `@zhushanwen/pi-subagent`，YAML 解析器报错。诊断用了 1 轮（python3 yaml.safe_load 验证），修复用了 1 轮（双引号改单引号）。

2. **审查文件命名不匹配**：ts_taste_review_v1.md vs gate 期望的 taste_review_v1.md。git mv 修复。

3. **test_execution.json schema 反复试错**（5 轮 gate 失败）：
   - 第 1 轮：缺 test_execution.json 文件
   - 第 2 轮：数组名 `test_cases` → 期望 `execution`
   - 第 3 轮：记录缺 `caseId`、`round`、`execute_steps` 字段
   - 第 4 轮：用了 `verdict: "pass"` → 期望 `passed: true`（布尔值）
   - 第 5 轮：通过

   这 5 轮试错完全是格式问题，没有任何实质性的测试逻辑错误。

### What Would You Do Differently

1. **先看 gate 脚本的 schema 校验代码**，而不是按 test_cases_template.json 的格式写 test_execution.json。两个文件的 schema 不同（template 用 `id`/`title`/`steps`，execution 用 `caseId`/`round`/`passed`/`execute_steps`），这个差异没有在任何文档中说明。

2. **YAML frontmatter 用单引号包裹所有字符串值**，特别是 harness_issues 数组中的长文本。双引号在包含 `@`、`:`、`#` 时容易触发解析错误。

### Key Risks

- 无新增风险。Phase 4 是纯验证阶段，未修改任何代码。

## 2. Harness Usability Review

### Flow Friction

- **Gate schema 不透明**：test_execution.json 的 4 轮格式试错是最严重的流程摩擦。每次 gate 失败只告诉"缺什么字段"，但不告诉完整的期望 schema。如果 gate 在第一次失败时就输出期望 schema 示例（一个完整的 JSON 示例），5 轮可以压缩到 1 轮。
- **Phase 间依赖检查过于严格**：dev_retrospect.md 的 YAML 解析错误完全阻塞了 Phase 4 启动，但这个错误不影响测试执行。Phase 间的 retrospect 检查应该是警告而非阻塞。

### Gate Quality

- Gate 正确识别了所有缺失文件和格式问题。但 gate 的错误信息是"frontmatter 缺少 verdict"——实际问题是 YAML 解析失败（`@` 字符触发 ScannerError），不是缺少字段。错误信息应该更精确。

### Prompt Clarity

- test_cases_template.json 和 test_execution.json 的 schema 关系没有说明。Template 定义了 TC 的 id/steps/description，但 execution 记录用不同的字段名（caseId/round/passed/execute_steps）。两者之间的映射关系需要文档化。

### Automation Gaps

- **test_execution.json 应该有 schema 验证工具**：在 gate 之前就能验证格式正确性，而不是等 gate 报错。
- **YAML frontmatter lint**：写 retrospect 文件后自动验证 YAML 是否能被 python yaml.safe_load 解析。

### Time Sinks

- **test_execution.json 格式调整**（~60% Phase 时间）：5 轮 gate 试错，每轮等待 push + gate。核心原因是 schema 不透明。
- **dev_retrospect.md YAML 修复**（~20% 时间）：诊断 + 修复 harness_issues 中的特殊字符问题。
