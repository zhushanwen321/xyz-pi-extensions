---
phase: spec
verdict: pass
---

# Spec Phase Retrospect — Pi Workflow Extension

## 1. Phase Execution Review

### Summary

完成了 Pi Workflow Extension 的完整 spec，包含 11 个功能需求、9 个验收条件、4 个架构决策。核心设计：JS Worker 线程 + agent 代理 + callCache 重放恢复 + ExecutionTrace 日志。投入的主要工作包括：

- 阅读和消化 3 份外部调研文档（Claude Code Workflow 调研、Pi 集成方案、xyz-harness 集成分析）
- 6 轮渐进式提问，逐层澄清需求（优先级、完成标准、脚本格式、执行环境、后台模式、DAG 与 JS 关系）
- 逐节展示设计并确认（6 节：架构、执行模型、Commands/Tools、GUI 兼容、持久化、范围）
- Pi-mono 源码调研 3 个技术点（settings 配置、Session JSONL 跨会话恢复、TUI API 按键支持）
- 3 轮独立审查，修复 2 条 MUST_FIX 后才通过 gate

### Problems Encountered

1. **DAG 概念过度设计**：最初将 DAG 描述为带有边和拓扑排序的显式图，用户多次追问后才澄清——DAG 只是线性执行轨迹日志（callId 递增序列），不含显式边。最终改名为 ExecutionTrace 以避免误导。这是本 phase 耗时最长的分歧点，根源在于我过早跳入方案而没有先确认用户对 DAG 的期望。

2. **架构约束冲突**（MUST_FIX #1）：spec 选择 `worker_threads` 但 CLAUDE.md 规定扩展只能使用 fs。需要声明例外并将例外原因写入 spec 和 CLAUDE.md。

3. **模块耦合声明**（MUST_FIX #2）：spec 多处直接引用 Subagent Extension 内部 API，与解耦原则矛盾。修正为使用相同底层协议但独立实现的模式。

4. **review 轮次过多**：3 轮审查对于这个复杂度的 spec 是可接受的，但增加额外开销。根本原因是 v1 spec 在 worker_threads 例外和 Subagent 耦合宣告不到位，导致审查发现问题后需要修复并重审。

### What Would Be Different

- 在 DAG 讨论的第一轮就明确："DAG 是内部执行记录，用户不可见，不做显式图结构"。节省 3 轮讨论。
- 写完 spec 后先自检 CLAUDE.md 中的架构约束（扩展模块限制），避免审查发现后再补。
- 审查前做一轮内部一致性检查（对比 Constraints 节和其他节的措辞对齐）。

### Key Risks

- **Worker 线程生命周期管理**：Worker 的暂停/恢复（SIGTERM → 重新创建）在单线程 Node.js 中不存在竞态，但 restart 时间窗口内的状态一致性需要 plan 阶段仔细设计。
- **callCache 重放的非确定性**：恢复时 JS 脚本重新执行，非 agent 副作用（console.log、文件写入）会重复。对于依赖副作用的复杂脚本是潜在 bug 来源。
- **跨会话恢复的 UX**：需要在 session_start 扫描旧 JSONL 文件并向用户确认恢复，用户体验需要仔细设计（不能静默恢复也不能每次喧宾夺主）。

## 2. Harness Usability Review

### Flow Friction

- **渐进式提问节奏慢**：6 轮提问 + 6 节设计确认，总对话轮次较多。对于已有丰富调研文档的需求，可以考虑跳过部分提问直接进入设计展示。
- **review → 修复 → gate 循环不够自动化**：3 轮审查意味着 agent 3 次 dispatch review subagent + wait + read result + fix + retry gate。如果能将 gate 的 MUST_FIX 项自动注入为修复指令，可以减少 manual loop 轮次。

### Gate Quality

Gate 检查正确识别了 frontmatter 格式问题和 review verdict 要求，没有误报。唯一的 friction 是 spec_review_v3 因 API 限额无法 dispatch，需要手动更新 v2 的 verdict。

### Prompt Clarity

Brainstorming skill 中的渐进式提问层级（Layer 1→2→3）结构清晰，帮助保持了提问节奏。Scope Decomposition 的提醒有效——本项目确实需要先确定 P0/P1 优先级而非同时做两件事。

### Automation Gaps

- **内部一致性检查**：Constraints 节与其他节的措辞矛盾（"不直接引用" vs "直接复用"）是人工审查发现的。如果在 spec 完成后运行自动化检查（扫描"直接复用 Subagent"等模式），可以在审查前捕获。

### Time Sinks

1. **DAG 讨论**（~5 轮对话）：本质是概念对齐问题，一次深入讨论即可解决
2. **Pi-mono 源码调研**（1 次 subagent dispatch）：必要的技术确认，不算是浪费
3. **3 轮审查排队**：每轮 subagent 审查需要独立 dispatch + wait，沟通开销积累。v2→v3 因 API 限额中断

### Summary

Spec 质量总体良好，评审发现的问题集中在架构约束合规性和内部措辞一致性两个维度——而非功能性设计缺陷。最大的效率损失来自 DAG 概念的过度设计，根源是方案先行而非需求澄清。后续 plan 阶段应吸取教训，在方案产出前先做更多需求层面的对齐。
