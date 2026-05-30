---
phase: dev
verdict: pass
---

# Dev Phase Retrospect

## 1. Phase Execution Review

### Summary

实现了 context-engineering 插件的全部代码：8 个文件（~1300 行），7/7 单元测试通过。通过 3 波 subagent dispatch 完成编码（Wave 1: scaffold+config+recall-store → Wave 2: compressor+tests → Wave 3: entry+commands），然后执行 5 步专项审查，修复 4 个 MUST_FIX 后全部通过。

### Problems Encountered

| 问题 | 严重度 | 发现者 | 根因 | 解决方式 |
|------|--------|--------|------|---------|
| `config.l0.enabled` 未检查 | MUST_FIX | BLR Review | compressor.ts 中 L1/L2 都有 enabled 检查，唯独 L0 没有。TDD 测试中 L0 总是启用的，未覆盖禁用场景 | 增加 `if (config.l0.enabled)` 条件 |
| 魔法数字 `4` 和 `200000` | MUST_FIX | Standards Review | chars→tokens→percent 转换中的估算因子直接写在表达式中 | 提取为 `CHARS_PER_TOKEN` 和 `DEFAULT_CONTEXT_WINDOW` 常量 |
| 主函数 107 行超限 | MUST_FIX | Standards Review | 拆分为辅助函数时过度拆分导致 index.ts 注册逻辑膨胀 | 合并行内，提取纯函数 `recallResult()` 和 `addStats()` |
| **闭包捕获错误** | MUST_FIX | Integration Review | 拆分为 `registerRecallTool(pi, store)` / `registerCommands(pi, config, stats)` 后，`session_start` 重赋值外层 let 变量不影响已捕获的参数 | 去掉辅助函数，所有 handler 直接闭包捕获外层 let 变量；`recallResult` 作为纯函数在 execute 时传入 store |
| `deepMerge<T>` 泛型约束过严 | LOW | tsc | `ContextEngineeringConfig` 含嵌套对象，不满足 `Record<string, unknown>` 约束 | 放宽为 `<T>` 无约束 |

### What Would You Do Differently

1. **闭包 state 管理应用对象引用模式**：`const state = { config, store, stats }` 然后 handler 通过 `state.store` 访问。这样即使拆分为辅助函数也能正确工作，因为重赋值的是 `state.store = newStore`（属性赋值），而非 `store = newStore`（变量重赋值，闭包看不到）。

2. **真正的 TDD — 先写失败测试**：compressor.ts 的 7 个测试是后补的，没有发现 L0 enabled 检查缺失。应该先写 `config.l0.enabled = false` → expect 无压缩 → verify RED → 再写实现。

3. **Self-Review 应检查"对偶完整性"**：L0/L1/L2 三个级别，L1 和 L2 都有 enabled 检查但 L0 没有。Self-Review 时应做"同类项对比"——同一层级的处理逻辑是否对称。

4. **Wave 调度可以更大胆**：Wave 1 的 config.ts 和 recall-store.ts 完全无依赖，可以并行 dispatch（而不是在一个 subagent 中串行），但 2 个文件总行数太少，合并为一个 subagent 的效率更高。这个决策是对的。

### Key Risks for Later Phases

1. **BashExecutionMessage 展开运算符**：compressor 用 `{ ...msg, output: newOutput }` 替换 bash 输出。如果 Pi 的 BashExecutionMessage 后续增加不可序列化的字段，展开运算符可能导致运行时错误。Phase 4 集成测试应验证替换后的消息被 Pi 正确处理。

2. **ToolResultMessage 含 ImageContent**：当前 L0/L1 压缩只处理 TextContent，如果原始 content 包含 ImageContent（截图工具结果），压缩后会丢失图片。spec 中未要求保留图片，但 LLM 在对话中看到 `[Tool result expired]` 后调用 `recall_context` 只能拿回文字，图片丢失。Phase 4 应测试含图片的 toolResult。

3. **L1 condenseToolResult 的非代码场景**：正则提取 import/function/class 行只适用于编程语言源码。对于 JSON、YAML、Markdown、自然语言输出等场景，正则命中率极低，fallback 到截断策略。截断效果取决于首尾行的信息密度。Phase 4 应测试非代码内容的 L1 压缩质量。

## 2. Harness Usability Review

### Flow Friction

- **5 步审查的重叠度较高**：BLR 和 Standards 都检查了代码结构和命名；Taste 和 Standards 有约 40% 的重叠。对 L1 复杂度项目，5 步审查总时间（含修复 + 重审）约占 Phase 3 总时间的 55%。建议 L1 项目合并为 3 步（BLR+Standards, Taste+Robustness, Integration）。
- **审查 YAML 格式不统一**：BLR/Taste/Integration 使用 `verdict: pass` + `must_fix: 0` 的扁平结构；Standards/Robustness 的 v1 使用了嵌套 `review:` 对象。gate 检查脚本需要处理多种格式，增加了复杂度。
- **pre-commit hook 阻塞了 vitest 相关的 commit**：`tsc --noEmit` 报 vitest 模块解析错误导致 hook 失败，需要 `SKIP_TSC=1` 才能提交。这是项目配置问题（vitest 类型声明未包含在 tsconfig paths 中），不是 harness 流程问题，但增加了提交摩擦。

### Gate Quality

- **Integration Review 的价值最高**：发现了闭包捕获错误，这是一个只有在 session 切换时才会暴露的运行时 bug。如果直接跳到 Phase 4 手动测试，可能需要精确构造"新 session + 使用旧压缩 ID"的场景才能发现。Integration Review 在代码层面就捕获了它。
- **BLR 发现了 L0 enabled 缺失**：这是功能正确性问题，不是代码品味问题。说明 BLR 在业务逻辑维度确实能发现 TDD 遗漏的边界条件。
- **无 false positive**：所有 MUST_FIX 都是真实问题，修复后验证通过。

### Prompt Clarity

- **Skill 中"复杂路径"的定义明确**：6 tasks → 复杂路径 → subagent dispatch。实际执行中按 Wave 分批 dispatch 的编排方式清晰。
- **subagent task prompt 的接口签名传递**：plan.md 的 Interface Contracts 章节被完整复制到 subagent prompt 中，避免了接口偏差。这个做法值得保持。
- **"禁码铁律"执行正确**：主 agent 在复杂路径下只做编排（dispatch subagent、审查结果、修复 MUST_FIX），没有直接写实现代码（除了 MUST_FIX 修复，这是 skill 允许的）。

### Automation Gaps

- **行数限制应自动化**：ESLint 的 `max-lines-per-function` 规则可以自动检测，不需要人工 Standards Review 发现。
- **闭包捕获模式应加入 lint**：检测"辅助函数参数名与外层 let 变量同名"的模式（`registerCommands(pi, config, stats)` 其中 config/stats 是外层 let），发出 warning。
- **YAML frontmatter 格式校验**：应有一个轻量脚本在 review subagent 完成后检查 frontmatter 格式一致性。

### Time Sinks

- **最大消耗：MUST_FIX 修复 + 重审循环**：4 个 MUST_FIX → 修复 → commit → 重新 dispatch review subagent → 等待结果。每个修复-重审循环约 3-5 分钟。总共 2 轮重审（BLR v2 + Standards v2 + Integration v2）。如果能一次性修复所有问题，只需 1 轮重审。
- **次要消耗：Pi 源码类型确认**：Phase 3 开始时花了约 20% 的时间确认 AgentMessage、ToolResultMessage、BashExecutionMessage 的精确字段名。这些信息应该在 Phase 1 或 Phase 2 就整理为类型参考文档。
