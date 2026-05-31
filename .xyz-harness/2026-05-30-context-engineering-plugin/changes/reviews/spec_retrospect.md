---
phase: spec
verdict: pass
---

# Spec Phase Retrospect

## 1. Phase Execution Review

### Summary

Phase 1 完成了 context-engineering 插件的 spec 设计。整个过程分三个阶段：

1. **调研先行**（非 spec 流程但在同一次会话中完成）：启动 3 个并行 subagent 调研 Hermes/OpenClaw/Claude Code+Aider+Qwen Code+OpenCode，产出 3 份调研文档（共 2313 行）
2. **分析综合**：基于调研结果，分析了 Pi 上下文的 15 个要素及其压缩策略，写入 `docs/evolution/001-context-compression-redesign.md`
3. **Spec 编写**：通过 coding-workflow 进入正式 spec 流程，经过 1 轮审查失败、1 轮修复后通过

**关键决策**：
- L1 压缩从 LLM 摘要改为纯规则化摘要（审查发现 Pi Extension API 无 LLM 调用能力）
- 明确"不替代原生 compact"的约束（吸取 tree-compact 失败教训）
- 引入 Recall 机制（压缩不等于丢弃，LLM 可按需恢复）

### Problems Encountered

| 问题 | 影响 | 解决方式 |
|------|------|---------|
| FR-4 假设 Pi Extension API 有 LLM 调用能力 | spec 审查 FAIL，5 条 MUST_FIX | 审查 subagent 验证了 API 源码，发现无此能力。改为纯规则化摘要 |
| FR-8 假设 context 事件有 details 返回字段 | spec 审查 FAIL | 改为闭包变量 + 命令展示 |
| FR-8/FR-9 缺少 AC | AC 覆盖率仅 78% | 补充 AC-9、AC-10 |
| C-8 处理顺序和 C-9 turn 定义模糊 | 审查指出影响实现一致性 | 新增 C-8 和 C-9 约束 |

**根因**：spec 编写时未先验证 Pi Extension API 的实际能力就做了假设。应该在写 spec 前先 dispatch 一个 API 能力扫描 subagent。

### What Would You Do Differently

1. **先验证 API 再写 spec**：在 brainstorming 阶段就应该 dispatch subagent 扫描 Pi Extension API 的实际能力（types.ts、agent-session.ts），而不是凭印象假设
2. **调研和 spec 流程分离更好**：本次调研（subagent 调研）和 spec（coding-workflow）在同一次会话中完成。调研产出的大量上下文（2313 行文档）占据了大量 context，可能导致 spec 编写时的注意力分散
3. **AC 应该随 FR 一起写**：FR-8 和 FR-9 的 AC 遗漏是因为 FR 写完后"回头补 AC"时跳过了这两个

### Key Risks for Later Phases

1. **L1 规则化摘要质量**：对非代码内容（JSON、YAML、Markdown、日志）的正则匹配效果可能不好，plan 阶段需要设计 fallback 策略
2. **Tool Result 消息结构多样性**：不同工具（read/edit/grep/bash）的 tool_result 格式不同，压缩时需要区分处理
3. **`context` 事件的 `structuredClone` 性能**：Pi 在 emitContext 中对 messages 做了深拷贝。如果消息很多（几百条），clone 本身可能就是瓶颈

## 2. Harness Usability Review

### Flow Friction

- **Brainstorming skill 的步骤太重**：skill 要求 Quick Overview → Ask Questions → Propose Approaches → Present Design → Write Spec 的完整流程。但本次需求已经在会话中充分讨论过（调研+分析），不需要渐进提问。我跳过了 Step 2-4 直接写 spec，但 skill 的 checklist 检查点会产生摩擦
- **审查 subagent 的质量很高但耗时**：两轮审查分别发现了 5 条和 0 条 MUST_FIX，第一轮的审查质量非常高（验证了 API 源码）。但每轮审查需要等待 subagent 完成，增加了总体时间

### Gate Quality

- Gate 一次 PASS，无 false positive
- 审查 subagent 正确识别了 5 个 MUST_FIX，其中 3 个是 API 兼容性问题（最重要的类别）
- 审查覆盖了 6 要素完整性、FR 一致性、AC 覆盖矩阵、Constraints 合理性、API 兼容性 5 个维度

### Prompt Clarity

- coding-workflow 的 Phase 1 描述清晰：spec → review → gate
- brainstorming skill 的"one question at a time"流程对于"已有充分上下文"的场景过于冗长
- 审查 subagent 的 task prompt 模板好用，直接指定了文件路径和检查维度

### Automation Gaps

- **调研文档和 spec 的链接需要手动维护**：spec 的 Background 中引用了调研文档路径，但没有自动验证这些文件是否存在
- **AC 覆盖率检查可以自动化**：FR 和 AC 的对应关系可以通过简单脚本验证（扫描 FR-*. / AC-*. 标题）

### Time Sinks

- **最大的时间消耗是调研 subagent**：3 个并行 subagent 产出 2313 行文档，但 spec 实际只用了其中约 20% 的内容（各工具的精华/糟粕总结、渐进式压缩思路、Pi API 能力分析）。调研文档更像是"知识储备"，不是 spec 的直接输入
- **spec 重写**：第一轮审查后选择了整个 spec 重写而非局部修改，因为 5 个 MUST_FIX 分布在 FR-4/FR-8/FR-9/FR-7/AC 多个位置。如果问题更集中，局部修改更快
