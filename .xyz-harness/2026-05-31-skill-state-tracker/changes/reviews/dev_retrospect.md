---
phase: dev
verdict: pass
---

# Phase 3 (Dev) Retrospect — skill-state-tracker

## 1. Phase Execution Review

### Summary

实现 skill-state 扩展（3 源文件，499 行），通过 tsc + eslint 验证，5 步专项审查全部 pass。关键产出：state.ts（状态机 + 序列化）、templates.ts（4 个 steering 模板）、index.ts（4 事件 hook + 1 工具 + 3 消息渲染器）。Standards Review v1 发现 5 条 MUST_FIX，全部修复后 v2 通过。

### Problems Encountered

1. **`ctx.sessionManager.appendEntry` 不存在**：plan 中写的是 `ctx.sessionManager.appendEntry`，实际 API 是 `pi.appendEntry`。Standards Review v1 #1 正确识别了这个运行时崩溃级问题。根因：API 签名是从类型存根推断的，存根不完整；实际应参考 goal 扩展的用法。
2. **事件 handler 类型不匹配**：Pi 类型存根中 `tool_call` 是联合类型（BashToolCallEvent | ReadToolCallEvent | ...），用 `Record<string, unknown>` 注解导致 overload resolution 失败。修复：删除显式类型注解，让 TS 从 `pi.on()` 重载推断。
3. **SessionEntry 类型守卫缺失**：直接在联合类型上访问 `.customType`。参考 goal 扩展的 `isGoalEntry` 模式，添加 `isSkillStateEntry` 类型守卫。
4. **tsconfig/lint 未包含 skill-state**：新扩展目录未加入项目的 include 和 lint script。Gate 通过是因为旧版 tsconfig 不检查 skill-state，隐藏了类型错误。修复后加入 tsconfig include 和 package.json lint script。
5. **Standards Review v1 block gate**：gate 检查到 standards_review_v1 的 verdict=fail，必须重新 dispatch 产出 v2。多了一轮 review 周期。

### What Would You Do Differently

- **写代码前先确认 API 签名**：不是从类型存根推断，而是直接 `grep` 参考实现（goal/src/index.ts）的实际调用模式。类型存根在 CI 环境才有意义，本地开发应以运行时行为为准。
- **新扩展应立即加入 tsconfig/lint**：这是一个初始化步骤，应该在 Task 1（骨架）中包含，而不是等 review 发现。
- **turn_end 事件的 turnIndex 来源**：spec 说"从 entries 推算"，但 SessionEntry 联合类型中没有 turn_end 类型。最终改用 message 计数作为近似。这个语义偏差应该在 plan 阶段就识别——turn_end entries 不一定等于 message entries。

### Key Risks for Later Phases

- **currentTurnIndex 恢复精度**：用 message/entry 计数近似 turnIndex，如果 Pi runtime 的 turn 概念与 message 不完全对应，session 恢复后提醒时间会偏移。Phase 4 E2E 测试需要验证。
- **before_agent_start 返回值消费**：Integration Review 指出如果 Pi runtime 不处理 before_agent_start 的返回值（message），FR-8 会静默失效。这个需要在实际 Pi 运行中验证。
- **提示词有效性未测试**：steering 消息能否引导 AI 正确调用 skill_state 工具，取决于 LLM 对提示词的理解。这是最大的不确定性，只能在 E2E 中验证。

## 2. Harness Usability Review

### Flow Friction

- 5 步专项审查并行 dispatch 很高效（Batch 1 四个并行），但 Standards Review v1 FAIL 后需要串行修复 + 重新 dispatch + 重新 commit + 重新 gate，增加了 2 轮额外操作。
- Gate 检查 review 文件的 verdict/must_fix 而不是代码本身，这意味着修复代码后必须重新 dispatch review 产出新文件。这个设计是正确的（防止跳过 review），但流程上感觉冗余。

### Gate Quality

- Gate 正确识别了 standards_review_v1 的 fail 状态，没有误报。
- Gate 不检查其他 4 个 review 的版本号（v1 vs v2），只看最新的文件。这允许局部修复。

### Prompt Clarity

- phase-dev skill 的"防护预检"步骤检测到 pre-commit hook 未安装但 .githooks 存在。没有给出明确指导（应该安装还是跳过），我选择了跳过（不影响编码）。建议：对 .githooks 存在但 hook 未安装的情况，给出明确的"安装或跳过"选项。
- "简单路径 vs 复杂路径"判断标准清晰（4 tasks / 单一类型 → 简单路径），执行顺利。

### Automation Gaps

- tsconfig.json 和 package.json 的 lint script 更新是手动执行的。新扩展目录应该有一个脚本自动注册到这两个配置文件中。
- API 签名确认依赖手动 grep 参考实现。如果有 API 文档或自动生成的类型（而非 CI 存根），可以减少这类错误。

### Time Sinks

- Standards Review v1 的 5 条 MUST_FIX 修复耗时较长（重写 index.ts、修改类型、重新验证）。但这些都是真实的代码质量问题，review 质量高。时间花在正确的地方。
- Pi 源码 grep 确认 API 签名占了不少时间（tool_call 事件结构、TurnEndEvent 类型、appendEntry 调用方）。如果有集中的 API 参考文档，这部分可以省掉。
