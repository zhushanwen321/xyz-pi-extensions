---
phase: pr
verdict: pass
---

# Phase 5 (Overall) Retrospect — skill-state-tracker

覆盖全部 5 个 phase 的整体复盘。

---

## 1. Phase Execution Review（按 Phase 逐回顾 + 跨 Phase 模式分析）

### Phase 1 — Spec

**执行质量：良好。** Spec 一次成型（v2 通过），3 条 MUST_FIX 都是真实设计缺陷：状态机转换矩阵缺失、FR-4/FR-5 因果顺序矛盾、"上下文摘要"不可实现。Review subagent 的审查质量高——特别是跨 FR 一致性检查，人工容易遗漏。

**主要教训**：状态机设计应在初版就给出完整的转换矩阵表，而不是依赖 review 补漏。因果顺序（steering 注入 → AI 调 subagent → AI 调 skill_state）应在设计讨论时显式声明，不应隐含在多个 FR 中。

### Phase 2 — Plan

**执行质量：良好。** 正确评估为 L1 复杂度，4 Task 线性依赖。Coverage Matrix 与 Metrics Traceability 的不一致被 review 识别并修复。Review 产出 0 MUST_FIX，一次通过。

**主要教训**：两张表（Coverage Matrix vs Metrics Traceability）是同一信息的两种视角，写完后应立即交叉比对。对 L1 项目，use-cases.md 和 non-functional-design.md 的信息密度偏低，有合并到 plan.md 的空间。

### Phase 3 — Dev

**执行质量：中等偏上。** 产出 499 行 / 3 源文件，最终 tsc + eslint + 5 步审查全部 pass。但过程暴露了多个前期验证不足的问题：

1. **`ctx.sessionManager.appendEntry` 不存在**（运行时崩溃级）——根因是从类型存根推断 API，而非 grep 参考实现
2. **事件 handler 类型不匹配**——类型存根的联合类型与 overload resolution 冲突
3. **tsconfig/lint 未包含新扩展**——初始化步骤遗漏
4. **Standards Review v1 FAIL → 修复 → v2 pass**——多了一轮 review 周期

**主要教训**：写代码前应先 grep 参考实现的实际调用模式，类型存根在本地开发中不可靠。新扩展的 tsconfig/lint 注册应作为 Task 1（骨架）的标准步骤。

### Phase 4 — Test

**执行质量：中等。** 13/13 TC 通过，但全部依赖 code_review 验证（Pi 扩展无独立测试框架）。state.ts 的 6 个纯函数本可以用 vitest 写单元测试，覆盖 8/13 个 TC 的逻辑路径，但没有在 plan 阶段识别这个优化点。Gate 因 review 文件名匹配规则不一致（`taste_review` vs `ts_taste_review`）额外阻塞一轮。

**主要教训**：测试策略应在 plan 阶段明确（Pi 扩展 = code_review，但纯函数可以自动化）。Gate 脚本的文件名匹配模式与 review skill 的命名约定需要对齐。

### Phase 5 — PR

**执行质量：顺畅。** 直接 commit 到 main（扩展仓库惯例），本地 tsc + eslint 通过，无 CI pipeline。5 步审查全部 pass，13/13 TC pass。无意外。

### 跨 Phase 模式

| 模式 | 出现 Phase | 影响 |
|------|-----------|------|
| 类型存根不可靠，需 grep 参考实现 | P3 | Standards Review v1 FAIL，多一轮修复 |
| 文件名/配置约定不一致 | P3（tsconfig）、P4（gate 匹配） | 每次多一轮 commit + verify |
| 纯函数可自动化测试但未识别 | P2→P4 | 8/13 TC 依赖人工 code_review，回归风险 |
| 前期验证不足推到后期发现 | P1→P3（turnIndex）、P3→P4（runtime 验证） | 不确定性累积到测试阶段 |

---

## 2. Harness Usability Review

### Flow Friction

1. **L1 项目文档负担**：Phase 2 产出 5 个独立文档，其中 use-cases.md（2 个简单 UC）和 non-functional-design.md（2/5 维度标注"不适用"）信息密度低。对 ~580 行的单扩展项目，合并到 plan.md 足矣。建议 L1 允许合并 use-cases + non-functional 到 plan.md。
2. **Review 文件名约定不一致**：gate 脚本匹配 `taste_review_v*.md`，但 ts-taste-check skill 输出 `ts_taste_review_v*.md`。Phase 4 才暴露（gate 检查全部前置 review 完整性），用 symlink workaround。应在 harness 配置中统一规范，或 gate 脚本使用更宽松的 glob。
3. **Standards Review FAIL 的修复循环**：v1 FAIL → 修代码 → 重新 dispatch review → 产出 v2 → commit → gate。设计正确（防止跳过 review），但流程上感觉冗余。考虑允许 gate 接受"v1 fail + 修复 diff"作为替代，减少 subagent dispatch。

### Gate Quality

**总体评价：高。** 5 个 phase 的 gate 全部正确工作：
- P1: 正确识别 untracked files
- P2: 一次通过
- P3: 正确识别 Standards Review v1 的 fail 状态
- P4: 正确识别 review 文件名不匹配
- P5: 通过

无 false positive。Gate 的防遗漏机制（检查所有前置 review 完整性）在 P4 发挥了作用，但也暴露了命名约定不一致。

### Prompt Clarity

1. **Brainstorming skill 对"需求已有设计文档"场景不匹配**：P1 中，skill 假设从零探索，但本需求附有详尽的 ADR 级别设计文档。Step 2-4 的大部分提问被跳过。建议增加 "design-refinement" 快速路径。
2. **phase-dev 的"防护预检"指导模糊**：检测到 .githooks 存在但 hook 未安装，没有给出"安装或跳过"的明确选项。
3. **Interface Contracts 模板偏 class 设计**：对 Pi 扩展的函数式设计不完全适用，实际执行中改为函数签名表效果更好。
4. **phase-test 的 test_execution.json 字段说明清晰**：常见错误表实用，第一次写就格式正确。

### Automation Gaps

1. **新扩展注册自动化**：tsconfig.json include 和 package.json lint script 的更新是手动执行的。应有脚本自动注册新扩展目录。
2. **API 签名文档缺失**：Pi 扩展 API（pi.on、pi.appendEntry、ctx.sessionManager）没有集中的参考文档，依赖 grep 参考实现。API 文档或自动生成的类型（而非 CI 存根）可以减少 dev 阶段的签名确认时间。
3. **纯函数单元测试**：state.ts 的 6 个纯函数可以用 vitest 自动化，减少 8/13 个 TC 对 code_review 的依赖。Plan 阶段没有识别这个优化点，harness 可以在 plan 模板中增加"识别可自动化测试的纯函数"检查步骤。

### Time Sinks

1. **Pi 源码 grep 确认 API 签名**（P3）：tool_call 事件结构、TurnEndEvent 类型、appendEntry 调用方——每次都要 grep pi-mono 源码。如果有 API 文档，这部分可以省掉。
2. **Standards Review v1 的 5 条 MUST_FIX 修复**（P3）：重写 index.ts、修改类型、重新验证。耗时但正确——这些都是真实的代码质量问题。
3. **逐条 code_review 13 个 TC**（P4）：每个 TC 约 2-3 分钟，manual 测试的固有成本。如果 state.ts 有 vitest 单元测试，这部分可以大幅减少。

### 整体评价

**Harness 流程对这个规模的项目（~580 行，L1 复杂度）基本适用，但有优化空间**：

- 最大的流程价值来自 Review subagent 的审查质量——多个跨 FR 一致性问题和运行时崩溃级 API 误用都被正确识别
- 最大的流程摩擦来自 L1 文档负担和命名约定不一致——对简单项目，文档要求可以精简
- 最大的质量盲区来自运行时验证缺失——code_review 只能验证逻辑自洽，Pi runtime 的实际行为（事件派发、steering 消费）无法在 harness 中验证
