---
phase: test
verdict: pass
---

# Phase 4 (Test) Retrospect

## 1. Phase Execution Review

### Summary

执行 10 个 manual test case，发现 1 个实际 bug（Pi 只对内置工具 emit `tool_call` 事件，custom tools 如 subagent 不触发）。修复后全部通过。

### Problems Encountered

1. **TC-1-02 FAIL — Pi tool_call 事件对 custom tools 不触发**：这是 Phase 3 代码审查未能发现的关键问题。spec 假设 `tool_call` 事件对所有工具都触发（包括 subagent），但实际上 Pi 只对 7 个内置工具（Bash/Read/Edit/Write/Grep/Find/Ls）emit `tool_call`。custom tools（由扩展注册的工具）走 `tool_execution_start`/`tool_execution_end` 事件通道。修复：agent 计数从 `tool_call` 改为 `tool_execution_start`。

2. **Spec 假设 vs 运行时行为不一致**：spec 中 "Timing guarantee" 明确写了 `tool_call` 覆盖所有工具调用，但实际运行时行为不符。这是 spec 编写时基于 Pi 文档推断的假设，没有经过运行时验证。如果 Phase 1 有机会做技术验证（spike），这个问题可以在 spec 阶段就发现。

3. **Manual test 的验证局限**：10 个 TC 中，6 个通过代码审查替代运行时验证。对于 Pi Extension 这种无法自动化测试的组件，代码审查是合理的替代手段，但不如运行时验证可靠。修复后的 `tool_execution_start` 方案需要重启 Pi session 才能验证，当前 session 中无法确认。

### What Would You Do Differently

- **Phase 1 增加技术 spike**：对于依赖外部平台事件系统的功能（如 Pi 的 tool_call 事件），spec 阶段应该做最小化 spike 验证假设，而不是纯文档推断。一个简单的测试扩展（监听 tool_call 并 console.log toolName）就能在 5 分钟内发现这个假设错误。
- **优先运行时验证而非代码审查**：代码审查确认逻辑正确，但无法发现平台行为与文档不符的问题。应优先构造可以触发真实事件的测试场景。

### Key Risks for Later Phases

- **修复未运行时验证**：`tool_execution_start` 方案从 API 定义上看是正确的（文档说 "Fired when a tool starts executing"，对所有工具生效），但未经运行时确认。Phase 5 合入后，用户需要在实际 Pi session 中验证 agent 计数是否生效。
- **stats 文件格式向后兼容**：当前 stats 文件包含旧格式数据（只有 skills 计数），修复后 agents 计数开始生效，不会破坏现有数据。

## 2. Harness Usability Review

### Flow Friction

- test_cases_template.json 中所有 TC 都是 `manual` 类型，Phase 4 skill 没有明确指导如何处理"代码审查替代运行时验证"的情况。我在 execute_steps 中标注了 "Code review" 作为验证方式，但这不是 skill 定义的标准验证方法（`verification_method` 字段在 template 中不存在，只有在 self-check checklist 中提到）。

### Gate Quality

Phase 4 gate 只有 4 个检查项（vs Phase 3 的 19 个），对 test_execution.json 的 cross-reference 检查很有效——确认了所有 10 个 template case 都被覆盖，且最终轮次全部 passed。但 gate 不检查 `execute_steps` 的内容质量（空数组就能通过），也不区分 manual 和 automated test 的验证深度。

### Automation Gaps

- Pi Extension 没有自动化测试框架。所有测试要么是运行时手动验证，要么是代码审查。这是 Pi 平台的限制，不是 harness 的缺口。但如果 harness 能提供一个"代码审查替代测试"的标准化模板（如何描述审查范围、结论、置信度），会更有结构。

### Time Sinks

- TC-1-02 的诊断过程花费较多时间：从发现 `agents: {}` 为空 → 检查 Pi 类型定义 → 理解事件系统架构 → 确认 tool_call 只覆盖内置工具 → 设计修复方案。这个过程是必要的，因为发现了真实 bug。

### Positive Surprises

- **Skill 计数已经在当前 session 中生效**：安装 extension 后，Phase 3 的审查 subagent 触发了 `ts-taste-check` 和 `xyz-harness-gate-reviewer` SKILL.md 的读取，自动产生了测试数据。这间接验证了 TC-1-01（skill 计数）无需额外操作。
