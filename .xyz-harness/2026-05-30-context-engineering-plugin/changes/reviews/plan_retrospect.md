---
phase: plan
verdict: pass
---

# Plan Phase Retrospect

## 1. Phase Execution Review

### Summary

Phase 2 产出 6 个交付物：plan.md（L1 复杂度，6 个 Task）、e2e-test-plan.md（9 个测试场景）、test_cases_template.json（16 条用例）、use-cases.md（4 个 UC）、non-functional-design.md（5 维度）。经过 2 轮 review 通过。

整体流程：复杂度评估（L1）→ 文件结构设计 → 接口契约定义 → 任务拆分 → Self-Review → 独立审查（FAIL → 修复 → PASS）。

### Problems Encountered

| 问题 | 影响 | 解决方式 |
|------|------|---------|
| settings.jsonl vs settings.json 命名错误 | review FAIL，MUST_FIX #1 | Pi 的 SettingsManager 实际使用 `settings.json`，非 JSON Lines 格式。修正 plan 中所有引用 |
| processL0 签名缺少 turnBoundaries 参数 | review FAIL，MUST_FIX #2 | Interface Contract 的 processL0 只定义了 4 个参数，但 Task 3 Step 5 调用时传了 5 个（含 turnBoundaries）。补齐签名 |
| Wave Schedule 与 Dependency Graph 矛盾 | review FAIL，MUST_FIX #3 | 依赖图是严格串行 1→2→3→4→5→6，但 Wave Schedule 把 Task 1/2 放 Wave 1 并行。改为 6 个 Wave 各 1 个 Task |
| 3 条 LOW 级残留（review v2 发现） | 不阻塞但影响一致性 | Task 正文中的简写签名和 File Structure 表中的 settings.jsonl 引用未同步更新。手动修复 |

**根因**：plan 编写时在多处描述同一接口（Interface Contract 表格 + Task 正文 + Wave Schedule），但没有做跨章节一致性校验。Self-Review 只检查了 spec 覆盖和 placeholder，没有检查内部一致性。

### What Would You Do Differently

1. **先写 Interface Contract 再写 Task**：本次先写了 Task 再补 Interface Contract，导致签名不一致。应该先定义接口（方法签名表），再围绕接口组织 Task
2. **Wave Schedule 应该从 Dependency Graph 机械推导**：不应该独立设计 Wave Schedule。应该先确定依赖关系，然后按拓扑排序自动生成 Wave，避免人为矛盾
3. **Settings 文件格式应先验证**：Pi 的 settings 存储实际路径和格式应该在 plan 开始前验证（read SettingsManager 源码），而不是凭 spec C-4 的描述写（spec 中写了 settings.jsonl 但实际是 settings.json）

### Key Risks for Later Phases

1. **AgentMessage 类型深入理解**：plan 假设了 toolResult 有 `toolCallId` 字段、assistant 的 content 中有 `type: "toolCall"` 的项、bashExecution 有 `output` 字段。Phase 3 实现时需要验证这些字段名是否准确（从 pi-agent-core 的类型定义中确认）
2. **L1 正则的边界情况**：plan 描述了正则策略但没给出完整的实现细节（多语言代码块、混合代码和文字、超长单行等）。Phase 3 需要充分测试
3. **context 事件的性能**：每次 LLM 调用前触发，如果消息很多（>200 条），线性扫描可能接近 5ms 阈值。Phase 3 应考虑早期退出（检测到无过期消息时跳过）

## 2. Harness Usability Review

### Flow Friction

- **Interface Contract 模板对 L1 过重**：L1 复杂度按 skill 定义不需要 interface_chain.json，但方法签名表、Data 定义、AC 覆盖矩阵仍然需要。对于一个 7 文件的扩展来说，Interface Contract 花了约 30% 的 plan 编写时间，产出密度不高
- **use-cases.md 和 non-functional-design.md 是额外开销**：spec 已包含业务用例和非功能约束，这两个文档有 60% 的内容是 spec 的复述。对于 L1 复杂度的项目，这两个文档的 ROI 偏低

### Gate Quality

- Gate 一次 PASS（fix 后），无 false positive
- Review subagent 正确识别了 3 个 MUST_FIX，都是 plan 内部一致性问题，质量较高
- Review v2 确认 3 个 MUST_FIX 全部 resolved，并发现了 3 条 LOW 级残留（review 的连续性很好）

### Prompt Clarity

- Skill 对 L1/L2 分级指引清晰，Interface Contract 的 L1 简化版规则明确
- Execution Group 模板格式清晰，Subagent 配置表格实用
- Self-Check Checklist 的"禁止实现代码"规则在 plan 中容易违反（Task 步骤中写配置代码示例时需要严格区分"签名"和"实现"）

### Automation Gaps

- **跨章节一致性检查可自动化**：Interface Contract 的方法签名应与 Task 正文中的调用签名自动比对
- **settings 文件格式验证**：plan 中引用的配置源路径（settings.json）应与 Pi 源码自动校验

### Time Sinks

- **最大时间消耗是 Pi 源码阅读**：花大量时间阅读 Extension API types.ts、SettingsManager.ts、messages.ts、compaction.ts，确认 context 事件签名、AgentMessage 类型结构、配置读取方式。这些信息应该在 Phase 1 spec 阶段就已整理好（Phase 1 确实做了 API 能力扫描，但没有产出类型参考文档）
- **Interface Contract 编写**：对于一个纯后端 L1 项目，方法签名表的边际价值较低（Task 描述本身已经足够清晰）
