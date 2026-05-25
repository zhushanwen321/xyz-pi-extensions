---
phase: plan
verdict: pass
---

# Phase 2 (Plan) 复盘 — Ad-hoc Workflow Generation

## Phase 执行质量

### 总结

基于 L2 spec 产出 L1 plan（4 Task、3 Group、3 Wave）。Plan review 发现 1 条 MUST_FIX（G2/G3 并行修改 commands.ts 冲突），修复后 v2 通过 gate。总耗时 8 turns。

### 遇到的问题

1. **文件冲突未在自检中发现**：Self-Review 时检查了 spec coverage、placeholder、type consistency，但漏掉了"不同 Group 修改同一文件"的冲突检查。Plan review 正确指出 G2 Task 4 需要在 commands.ts 提取共用函数，而 G3 也要改 commands.ts。修复方案清晰：将共用函数提取合并到 G2，G3 只 import 不修改。

2. **L1/L2 判定**：spec 自评 L2 但实际 plan 按 L1 写（单文档，无前后端拆分）。这个判定是正确的——所有改动都在 TypeScript 扩展内，无前端/后端/API 分离需求。但 spec 的 Complexity Assessment 写 L2 是因为"commands.ts 路由逻辑较复杂"，和 plan 的 L1 评估维度不同。

3. **Task 粒度偏粗**：4 个 Task 覆盖 5 个文件，Task 2 包含 save 子命令 + 路由增强 + 共用函数提取三个关注点。按 skill 指导"每个 Task 对应一次 subagent 调度"是合理的，但对 subagent 来说单个 Task 的上下文量较大。

### 下次的不同做法

- Self-Review 增加"不同 Group 文件交集检查"项
- Task 描述中更明确地标注哪些是新增代码、哪些是修改已有代码的具体位置

### 关键风险

- **G2 Task 2 复杂度最高**：save 子命令 + 路由增强 + 共用函数提取三合一，subagent 可能需要多轮迭代
- **sendUserMessage 拼接格式**：AI 端如何解析 workflow 列表决定了匹配质量，plan 中定义了格式但没有强制约束

## Harness 体验

### 流程摩擦

- **Plan review 只有 1 条 MUST_FIX**：相比 spec review 的 10 条，plan 质量明显更高。归功于 spec 阶段的充分讨论和 Decisions 节的提前记录。
- **v1 → v2 循环轻量**：只需调整 Group 依赖和 Wave 编排，不需要重写整个 plan。

### Gate 质量

- Plan review 准确识别了文件冲突，无误报
- 非阻塞建议（G2 内部并行化、meta 验证方式）合理但优先级低

### 自动化缺口

- **文件冲突检测可自动化**：扫描 plan.md 的 File Structure 表格，检查不同 Group 的文件交集
- **Spec-Plan 一致性可自动化**：检查 plan 的 Traceability 表格是否覆盖所有 AC
