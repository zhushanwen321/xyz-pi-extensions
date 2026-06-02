---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-01-merge-harness-extensions-monorepo"
harness_issues:
  - "brainstorming skill 的 Terminology Step 在多轮对话中执行不完整——讨论中出现了 'monorepo'、'workspace protocol'、'resources_discover' 等术语，但未即时写入 CONTEXT.md，而是在 Step 8 检查时才发现无需新增。流程应更明确：要么即时写入，要么即时记录'无需新增'的判断"
  - "spec review 第 1 轮发现的 4 条 MUST_FIX 中，有 3 条（subagent 去重细节、Python 脚本位置、todolist 策略矛盾）本应在写 spec 时就想到。写 spec 时缺少自检清单中'代码假设验证'的执行——对 coding-workflow/lib/ 的扫描应该在写 FR-5 之前就做，而不是等 review subagent 指出"
  - "brainstorming skill 的 Step 4（Present design）和 Step 3（Propose approaches）的边界模糊——我在用户确认'harness 是逻辑概念'后直接跳到了方案对比，没有先完整展示设计再分段确认。部分原因是对话是异步的，用户回复简短，难以判断是否适合分段"
---

# Spec Phase Retrospect

## 1. Phase Execution Review

### Summary

完成 xyz-pi-extensions + xyz-harness-engineering 合并为 monorepo 的 spec 设计。核心产出：
- spec.md（2 轮 review，4 条 MUST FIX 修复后通过）
- CLAUDE.md 更新（项目概述、架构、命令、安装指南、包清单全部重写）
- ADR-007（monorepo 合并决策记录）

关键决策：pnpm workspaces + changesets，npm scope `@zhushanwen`，skills 内嵌到所属 extension 通过 `resources_discover` 自动注册，harness 是逻辑概念不是物理层。

### Problems Encountered

1. **spec 首版质量不足**：第 1 轮 review 发现 4 条 MUST FIX（todolist 策略矛盾、缺功能回归 AC、subagent 去重缺细节、Python 脚本位置未说明）。根本原因是写 FR-5（subagent 去重）时没有先扫描 coding-workflow/lib/ 的实际代码，凭印象写了"改为 workspace:* 依赖"这种泛泛描述。

2. **Clarifying questions 阶段效率**：7-8 轮问答后才进入方案阶段。部分问题（如 npm scope、独立 skills 分发方式）可以在用户给出初始需求时就附带确认，减少来回轮次。

### What Would You Do Differently

1. 写 FR 涉及具体代码改动时（如 subagent 去重、Python 脚本迁移），**先 dispatch on-demand scan 再写 FR**，而不是写完等 review 指出信息不足。
2. 将"澄清问题"阶段的低悬果实（scope、分发方式、命名）合并到一个问题中问，而不是逐个确认。

### Key Risks

1. **subagent 去重的行为差异**（Phase 2/3 中最高风险点）：coding-workflow 的 lib/subagent.ts 和 pi-subagent 包的实现可能有微妙的行为差异。plan 阶段需要先做详细的 diff 分析。
2. **coding-workflow index.ts 44k 行**：这是一个巨大的单文件，迁移时任何路径变更都可能引入 bug。

## 2. Harness Usability Review

### Flow Friction

- **brainstorming → spec 的过渡不明确**：skill 说"propose 2-3 approaches"然后"present design"，但用户在 approaches 阶段追问了"长期合理架构是什么"，导致 approaches 和 design 合并成了一个更大的回答。skill 对"用户追问深层设计"的处理没有指导。

### Gate Quality

- Gate check 工作正常。第 1 轮 review 正确识别了 4 条实质性信息缺失，没有误报。第 2 轮确认全部修复后通过。

### Prompt Clarity

- brainstorming skill 的 Step 2（Clarifying Questions）指导清晰，"one question at a time"和"multiple choice preferred"的约束有效。
- Step 4（Present Design）的"ask after each section"在异步对话中难以执行——用户简短回复（如"是的"、"沿用原名"、"1"）后，不确定是否适合停下来问"这部分设计 OK 吗"。

### Automation Gaps

- spec review 由 subagent 执行，这是自动化的。但 review 发现问题后的修复-重审循环需要主 agent 手动编排。可以考虑将"修复 MUST FIX → 重新 dispatch review"做成自动循环。
- CLAUDE.md 的更新和 ADR 创建是手动判断的，没有自动化触发。

### Time Sinks

- 最大的时间消耗在**澄清问题阶段的来回轮次**（7-8 轮）和**spec 首版写完后才发现信息不足需要补写**。后者完全可以通过先 scan 再写来避免。
