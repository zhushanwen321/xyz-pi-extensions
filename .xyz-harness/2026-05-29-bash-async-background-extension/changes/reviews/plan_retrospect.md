---
phase: plan
verdict: pass
---

# Plan Phase Retrospect — bash-async-background-extension

## Phase Execution Review

### Summary

完成了 bash-async 扩展的 L1 实施计划，产出 7 个交付物：plan.md（5 Task + Interface Contracts + Spec Coverage Matrix）、e2e-test-plan.md（13 个测试场景）、test_cases_template.json（17 条用例）、use-cases.md（6 个业务用例 + AC 覆盖映射表）、non-functional-design.md（5 维度分析）、plan_review_v1.md（独立审查 pass）。

关键决策：(1) L1 复杂度 — 单 Group BG1，无前后端拆分；(2) 发现 `getShellConfig` 已从 Pi 导出，Task 2 从"重新实现"改为"直接复用"，节省 ~30 行代码；(3) pipe 策略选择"从开始就写临时文件"而非"超时后切换 pipe"，避免 Node.js pipe 切换难题。

### Problems Encountered

1. **API 可用性验证不够早**：在写 spec 时知道 `createLocalBashOperations` 可导出，但没逐个检查 `getShellConfig`/`getShellEnv` 的导出状态。直到 review v1 指出后才验证发现 `getShellConfig` 确实已导出。这导致 spec 写了"自行实现 shell 发现"，plan 初始也照搬。如果从一开始就 `grep` 导出列表，可以避免这个反复。

2. **sendMessage 调用格式未验证**：reviewer 指出 plan 中 `pi.sendMessage({ customType: ..., deliverAs: ..., triggerTurn: true })` 将 options 混入了第一个参数，与 Pi 实际 API（第二个参数为 options）不一致。plan 标注了"subagent 有 Pi 源码参考可自行纠正"，但这属于 LOW 而非 MUST FIX — 实际执行时应确保正确。

### What Would You Do Differently

1. **在写 Interface Contracts 前先做完整的 API 导出扫描**：一次性 `grep` 所有 `@mariozechner/pi-coding-agent` 的导出项，列出哪些函数可用、哪些类型可用。这 30 秒的工作能避免后续多次返工。

2. **Pi API 调用格式应直接从源码确认**：`sendMessage`、`registerTool`、`pi.on` 等关键 API 的签名应从 `types.ts` 或 `.d.ts` 确认，而非凭 subagent 扩展的用法推断。

### Key Risks for Later Phases

1. **Task 4 (spawn engine) 是最大风险点**：超时 detach 的 pipe 管理、background 模式的 sendMessage 回调、kill 的进程组管理——这三个子功能都涉及 Node.js 进程管理的边界情况。Plan 中描述了策略但没有实际代码验证。
2. **临时文件清理**：sync 模式正常完成后是否立即删除临时文件？plan 的 non-functional-design 提到了但 Task 4 的步骤中没有明确。Dev 阶段需要补充。
3. **Windows 兼容性**：plan 决定 v1 不支持 Windows，但如果用户在 Windows 上安装扩展，`getShellConfig` 会自动处理——只有 `killProcessGroup` 需要额外处理（taskkill vs SIGTERM）。

## Harness Usability Review

### Flow Friction

- **L1/L2 评估自然顺畅**：5 维度评估都命中 L1，直接走单 plan.md 路径。没有不必要的子文档拆分。
- **Interface Contracts 章节有价值但耗时**：逐模块列出方法签名表确实帮助发现了 `getShellConfig` 可导出的问题，但也增加了 ~40 分钟的编写时间。对于 L1 项目，可以考虑简化为关键模块的签名表而非全覆盖。

### Gate Quality

- **Gate 正确放行**：plan_review verdict=pass + must_fix=0，gate 直接通过。
- **Reviewer 发现了 plan 中 6 条 LOW 和 1 条有价值的纠正**（`getShellConfig` 已导出），说明独立审查确实有价值。

### Prompt Clarity

- **Writing-plans skill 的 L1 路径指引清晰**：Task 结构模板、Interface Contracts 模板、Self-Review Checklist 都很实用。
- **Execution Groups 对单 Group 项目略显冗余**：BG1 是唯一的 Group，Wave Schedule 只有一个 Wave。Skill 对 L1 项目可以简化 Execution Groups 章节——但这是流程规范，不是问题。

### Automation Gaps

- **Gate check 脚本不可用**：`check_gate.py` 不存在于本地环境。手动做了 YAML frontmatter 和文件存在性验证。这应该由 gate tool 自动执行。
- **API 导出扫描没有自动化**：每次都需要手动 `grep` `.d.ts` 文件确认导出状态。如果有一个 "scan Pi exports" 的工具会更高效。

### Time Sinks

- **Interface Contracts 编写**占 ~40% 时间（方法签名表 + AC 覆盖矩阵 + Spec Metrics Traceability）。对 L1 项目来说偏重，但确实帮助发现了 API 可用性问题。
- **6 个交付物文件**对 L1 项目数量偏多。use-cases.md 和 non-functional-design.md 对这个项目的信息密度不高（use-cases 主要是从 spec 翻译，non-functional 大部分是"与内置 bash 一致"）。
