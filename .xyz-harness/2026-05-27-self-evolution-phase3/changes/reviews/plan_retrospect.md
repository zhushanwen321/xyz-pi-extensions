---
phase: plan
verdict: pass
---

# Plan Phase Retrospect — self-evolution-phase3

## 1. Phase Execution Review

### Summary

完成了 evolution-engine 的实现计划，产出 6 个交付物：
- `plan.md`：6 个 Task，3 个 Execution Group（BG1/BG2/BG3），3 个 Wave
- `e2e-test-plan.md`：10 个测试场景，覆盖全部 7 个 AC
- `test_cases_template.json`：12 个测试用例
- `use-cases.md`：4 个 UC，含 AC 覆盖矩阵
- `non-functional-design.md`：5 个维度设计考量
- `plan_review_v1.md`（fail）→ 修复 4 个 MUST FIX → `plan_review_v2.md`（pass）

关键决策：
1. L1 复杂度——无前端/后端拆分，单个 plan.md 覆盖所有 Task
2. 按职责分层 3 个 BG：Foundation（类型+状态+模板）→ Core Logic（judge+applier+monitor）→ Integration（commands+widget+入口）
3. applier.ts 做路径白名单校验，不依赖 Judge prompt 约束
4. diff 应用使用纯字符串替换，不引入 npm 依赖

### Problems Encountered

**P1: 4 个 MUST FIX 在第一轮 review 中被发现**

1. **targetPath 无运行时校验**——spec 的 non-functional-design 中提到"通过 Judge prompt 约束"，但 review 正确指出 prompt 约束不足够，需要运行时白名单。
2. **diff-match-patch npm 包**——plan 中建议使用 npm 包，但 CLAUDE.md 明确说"扩展没有自己的 node_modules"。这是写 plan 时对项目约束的疏忽。
3. **Dirs 类型缺失**——在 commands 方法签名中使用了 Dirs 类型但未在 Interface Contracts 中定义。
4. **非 JSON raw output 未持久化**——spec FR-1 明确要求"记录 raw output 到 evolution-data 目录下"，但 plan 的 runJudge 只抛 Error 没有持久化步骤。

根因：这 4 个问题都是"plan 编写时没有逐条对照 spec"导致的。Self-review 环节检查了 FR/AC 覆盖和类型一致性，但遗漏了 spec 中具体的错误处理细节和 CLAUDE.md 的依赖约束。

### What Would You Do Differently

1. **先 grep CLAUDE.md 再写 plan**：写 Task 4 时就应该搜索 "node_modules" 和 "child_process" 相关约束，而不是依赖记忆。
2. **spec→plan 对照检查应更细致**：不仅检查"有没有对应的 Task"，还要检查"每个 FR 中的错误处理细节是否在 Task 中有对应的实现步骤"。
3. **Interface Contracts 完整性检查**：方法签名中引用的类型（如 Dirs）必须在同章节有定义，这个检查应该是 self-review 的固定步骤。

### Key Risks for Later Phases

1. **Task 3 (judge.ts) 的 JSONL 解析**：Pi `--mode json` 输出 JSONL 事件流，需要从中提取 LLM 响应。subagent/src/spawn.ts 已有参考实现，但直接移植可能遇到边界情况（如响应分多行输出、事件顺序不同）。
2. **Prompt 模板质量**：3 个模板文件在 Task 2 中创建，但模板的评判维度和输出 schema 约束直接影响 Judge 输出质量。建议 Phase 3 (dev) 中 BG2 的 subagent 优先实现 judge.ts，在真实数据上测试模板效果。
3. **TUI 审批交互**：spec 只描述了"y/n/e/q"交互模式，但 Pi 的 TUI command 交互机制需要确认（command execute 返回结果后用户如何继续输入？是否需要 followUp 机制？）。这可能在 Phase 3 中需要调整设计。

## 2. Harness Usability Review

### Flow Friction

**数据验证步骤有价值但耗上下文**：为了确保 plan 引用的数据字段准确，我读取了 Phase 2 报告 JSON 的实际结构（tool_stats、token_stats 等字段的真实键名）。这一步花费了约 3 次工具调用，但产出的字段信息让 plan 的数据裁剪逻辑（buildJudgeInput）避免了"凭记忆写字段名"的风险。

**Execution Groups 设计自然**：3 个 BG 的分层（Foundation → Core → Integration）与文件依赖关系完全对应，不需要额外调整。Wave 编排也很直观。

### Gate Quality

第一轮 plan review 发现的 4 个 MUST FIX 质量都很高，没有 false positive。特别是 targetPath 安全校验和 npm 依赖约束——这两个问题如果不修复，会在 Phase 3 (dev) 中直接导致实现失败。

### Prompt Clarity

writing-plans skill 的指引很清晰：
- Interface Contracts 章节模板好用，按 module 分组的方法签名表让类型定义一目了然
- Spec Coverage Matrix 模板简单直接，填完就能看出是否有 gap
- Execution Groups 模板结构完整，subagent 配置表让 Phase 3 的 subagent 派遣有明确的参考

一个不明确点：L1 plan 的 "禁止实现代码" 边界——Interface Contracts 中的方法签名是"设计契约"还是"实现代码"？skill 说"签名表中可以包含参数类型和返回类型的名称，但不允许包含方法体"。这个边界在执行中是清晰的，但初次阅读时需要仔细理解。

### Automation Gaps

1. **数据字段验证无法自动化**：需要手动读取 Phase 2 报告 JSON 确认字段名。如果有一个工具能从 JSON sample 自动生成 TypeScript interface，可以省去这个步骤。
2. **CLAUDE.md 约束检查**：plan review 发现的 2 个约束违反（npm 依赖、child_process）本可以在写 plan 时自动检测。

### Time Sinks

1. **4 个 MUST FIX 修复 + 重新 dispatch review**：约 3 个 turn。根因是 self-review 不够细致，遗漏了 spec 中的错误处理细节。
2. **数据结构验证**：3 次工具调用读取 Phase 2 报告 JSON。必要的投入，避免了后续实现中的字段名错误。
