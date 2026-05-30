---
phase: dev
verdict: pass
---

# Dev Phase Retrospect

## 1. Phase Execution Review

### Summary

Phase 3 实现了 context-engineering 插件的全部代码（8 个文件，~1300 行），7/7 单元测试通过。经过 5 步专项审查（BLR → Standards → Taste → Robustness → Integration），修复了 4 个 MUST_FIX 后全部通过。

### Problems Encountered

| 问题 | 来源 | 影响 | 解决方式 |
|------|------|------|---------|
| `config.l0.enabled` 未检查 | BLR MUST_FIX #1 | L0 无法通过命令禁用 | 在 compressContext 中增加 `if (config.l0.enabled)` 条件 |
| 魔法数字 `4` 和 `200000` | Standards MUST_FIX #2 | 可读性差 | 提取为 `CHARS_PER_TOKEN` 和 `DEFAULT_CONTEXT_WINDOW` 常量 |
| index.ts 主函数 107 行 | Standards MUST_FIX #3 | 超过 80 行限制 | 拆分为辅助函数 |
| **闭包捕获错误** | Integration MUST_FIX #1 | **严重**：session_start 后 tool/command 仍引用旧 store/config | 去掉辅助函数，所有 handler 直接闭包捕获外层 let 变量；recallResult 作为纯函数在 execute 时传入 store |

### What Would You Do Differently

1. **闭包捕获是 JS/TS 中最隐蔽的 bug 之一**：拆分辅助函数时没有意识到参数传递 vs 闭包捕获的区别。下次写 Pi 扩展时，state 管理应该用对象引用模式（`const state = { config, store }`，handler 通过 `state.store` 访问），而非 let 变量重赋值模式。这样即使拆分为辅助函数也能正确工作。

2. **先写测试再实现**（真正的 TDD）：本次 compressor.ts 的测试是在实现之后补写的。虽然 7/7 通过，但测试没有发现 L0 enabled 检查缺失的问题（因为测试中 L0 总是启用的）。应该先写 `config.l0.enabled = false` 的测试用例，验证失败后再写实现。

3. **审查轮次过多**：4 个 MUST_FIX 导致了 2 轮额外审查（BLR v2, Standards v2, Integration v2）。如果 Self-Review 更仔细（检查 L0 enabled、闭包语义、行数限制），可以减少到 1 轮。

### Key Risks for Later Phases

1. **BashExecutionMessage 替换的正确性**：compressor 使用展开运算符 `{ ...msg, output: newOutput }` 创建新的 BashExecutionMessage。但 Pi 的 AgentMessage 是联合类型，运行时可能包含更多字段（如自定义消息）。Phase 4 的集成测试需要验证替换后的消息仍被 Pi 正确处理。

2. **ToolResultMessage.content 替换**：content 是 `(TextContent | ImageContent)[]`，不是 string。代码正确创建了 `[{ type: "text", text: "..." }]`，但如果原始 content 包含 ImageContent（截图），压缩后会丢失图片。这是已知的限制（spec 中未要求保留图片），但应在 Phase 4 验证不会导致 LLM 行为异常。

## 2. Harness Usability Review

### Flow Friction

- **5 步审查的重叠**：BLR 和 Standards 都检查了代码结构和命名规范，Taste Review 和 Standards Review 有约 40% 的重叠。对于 L1 复杂度项目，5 步审查的总时间（含修复和重审）约占总开发时间的 60%。建议 L1 项目合并为 3 步（BLR+Standards, Taste+Robustness, Integration）。

- **Standards Review 的 YAML frontmatter 格式不一致**：BLR、Taste、Robustness 使用 `verdict: pass/fail` + `must_fix: N`，但 Standards 和 Robustness 的 v1 使用了不同的 YAML 结构（`review:` 嵌套对象）。gate 检查脚本可能需要处理多种格式。

### Gate Quality

- **Integration Review 发现了真正的严重 bug**（闭包捕获错误），证明了 Integration Review 的价值。如果没有这一步，bug 只能在实际运行时才会暴露（session 切换后 recall 失效）。

- **BLR 发现了 L0 enabled 检查缺失**，这也是一个实际的功能 bug。审查质量高。

### Automation Gaps

- **行数限制应自动化**：ESLint 的 `max-lines-per-function` 规则可以自动检测，不需要人工 Standards Review。
- **闭包捕获模式应加入 lint 规则**：检测"函数参数名与外层变量同名"的模式，发出警告。

### Time Sinks

- **最大时间消耗是 5 步审查 + 修复 + 重审**：总共 4 个 MUST_FIX，每个都需要修复 + commit + 重新 dispatch review subagent。审查流程本身消耗了比编码更多的时间。
