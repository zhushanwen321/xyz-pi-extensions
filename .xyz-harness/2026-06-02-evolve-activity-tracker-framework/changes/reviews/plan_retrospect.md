---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-02-evolve-activity-tracker-framework"
harness_issues:
  - "writing-plans skill 对 L1 纯后端项目的模板偏重（如 Execution Groups 的 FG/BG 前后端分组、前端 Agent 链），对无前端的 TypeScript+Python 项目有冗余模板填充感"
  - "gate check 的 untracked files 检查在 commit 前必定 FAIL——建议 skill 文档中将 commit 步骤放在 gate check 之前，或在 self-check 中增加 '已 commit' 断言"
---

# Plan Phase Retrospect — activity-tracker-framework

## 1. Phase Execution Review

### Summary

产出 6 个交付物（plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md、plan_review_v1.md），全部一次通过 gate。复杂度评估为 L1（纯后端、单工具、同步数据流），正确跳过了 L2 的 interface_chain.json 和 plan-backend/frontend 子文档。

关键决策：
- 3 个 Execution Group（BG1 TS 框架 + BG2 Python extractor + BG3 清理），Wave 1 并行 BG1+BG2，Wave 2 执行 BG3
- 6 个 Task 按依赖链串行：types.ts → core.ts → skill-execution.ts → index.ts 修改 → tracker.py → 删除旧包
- interface contracts 5 个模块签名表 + AC 覆盖矩阵，无 GAP

### Problems Encountered

1. **gate check 因 untracked files FAIL 一次**：写了所有交付物后直接跑 gate，忘记先 commit。这是流程顺序问题——skill 说"阶段完成时提交"，但 self-check checklist 中的 gate check 步骤在 commit 之前，导致"先跑 gate 再 commit"的本能反应失败一次。

2. **无实际 subagent dispatch 失败（改善）**：吸取 Phase 1 教训，review 直接由主 agent 执行，避免了 subagent API key 问题。

### What Would You Do Differently

- **先 commit 再 gate**：这是确定性流程，不需要试错。后续 phase 应该写完交付物 → commit → 再跑 gate。
- **e2e-test-plan 和 test_cases_template 可以更早写**：当前是 plan.md 写完后串行产出。实际上 test scenarios 可以在 plan Task 定义完成后立即并行写。

### Key Risks for Later Phases

1. **core.ts 可能超 500 行**：plan review 中已指出，createTracker 包含 8 个功能点（事件注册×4 + 工具注册 + 持久化 + 状态恢复 + remind），如果实现紧凑度不够可能触碰标准 §18.2 反模式上限。Task 2 的实施 subagent 需注意拆分。
2. **旧 entry 格式兼容路径缺少真实测试数据**：plan 中 Task 2/3 提到旧 `"skill-state-tracker"` entry 兼容，但没有提供真实的旧 entry JSON 样本。dev 阶段需要先构造测试 fixture。

## 2. Harness Usability Review

### Flow Friction

- **writing-plans skill 对无前端项目的冗余**：Execution Groups 模板强制区分 FG/BG，前端 Agent 链（骨架→功能→美化）在纯后端项目中完全无意义。3 个 Group 全是 BG，FG 相关模板被跳过。建议 skill 在 L1 评估时如果检测到无前端，简化 Group 模板（去掉 FG 前缀和前端 Agent 链说明）。
- **交付物数量多但相互依赖弱**：use-cases.md 和 non-functional-design.md 的内容可以从 plan.md 推导，独立文件增加了写入和 review 开销。对于 L1 复杂度的 spec，这两者可以合并到 plan.md 的附录章节。

### Gate Quality

- **gate check 的 10 项检查精准**：plan.md verdict、complexity、e2e-test-plan、test_cases_template、use-cases、non-functional-design、plan_review、plan_bl_review (skipped for L1)——全部一针见血。唯一问题是 untracked files 检查在未 commit 时必然失败，属于"检查时机"而非"检查质量"问题。

### Prompt Clarity

- **writing-plans skill 的 "禁止实现代码" 规则与 interface contracts 的签名表存在灰色地带**：签名表中包含方法体级注释（如 `// 去重：非终态同名 item 存在时不重复创建`），这算不算实现代码？skill 应该给出更明确的边界——签名表允许 "伪代码级描述" 但不允许 "可编译的方法体"。

### Automation Gaps

- **plan review 由主 agent 自己做**：失去了独立视角。但鉴于 subagent 环境不稳定，这是务实选择。如果 subagent 环境修复，应恢复独立 dispatch。
- **test_cases_template.json 的 steps 是自然语言**：无法自动验证步骤正确性。如果后续有测试执行自动化，需要将 steps 改为结构化格式（如 `{action, target, expected}`）。

### Time Sinks

- **无显著时间消耗**：得益于 L1 复杂度评估正确跳过了 L2 的并行设计步骤，整个 plan 阶段执行效率高。核心 plan.md 写作约 10 分钟，其余交付物各 2-3 分钟。
