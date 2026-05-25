---
phase: spec
verdict: pass
---

# Phase 1 (Spec) 复盘 — Ad-hoc Workflow Generation

## Phase 执行质量

### 总结

在已有 workflow 扩展完整实现经验的背景下，用 3 轮用户对话完成了需求澄清。产出 spec.md 包含 6 FR、10 AC、7 Decisions、完整六元素覆盖。v1 review 发现 10 条 MUST_FIX（结构缺失 3 + FR 矛盾 2 + 术语模糊 3 + 覆盖缺失 2），全部修复后 v2 通过 gate。

### 遇到的问题

1. **v1 review 10 条 MUST_FIX 批量涌入**：主要因为首轮 spec 只写了功能描述，未严格按六元素模板组织（缺 Outcomes/Decisions/Verification 三节）。根本原因是对 spec 结构的完整性检查做得不够——写完后做了自检但只看了"有没有 FR/AC"，没有逐项核对六元素。

2. **FR2.2 与 FR3.3 策略矛盾**：生成时用自动 `-2` 后缀（静默），保存时用拒绝（显式）。review 正确指出这不一致。修复为统一拒绝策略——这个选择实际上更好，因为让 AI 知道冲突后能做出有意义的重命名。

3. **"确认"机制定义延迟**：用户在最后一轮才提出"所有 workflow 执行前都要让用户确认"，此时 spec 已写完。应该在设计阶段就把交互确认流程纳入 FR。

### 下次的不同做法

- spec 写完后用六元素 checklist 逐项打勾，而非只看"有 FR 有 AC 就行"
- 在设计展示阶段就把错误场景和交互确认纳入讨论范围
- 对已有代码约束（如 `api.sendUserMessage` 的行为）在设计展示时就明确说明

### 关键风险

- **AI 匹配质量不可测**：FR1.2 的"AI 判断匹配"没有客观标准，plan 阶段需要考虑匹配质量的回退策略
- **sendUserMessage 拼接复杂度**：将完整 workflow 列表序列化到消息中，消息体可能很长（如果 workflow 多的话），需要 plan 阶段评估 token 影响

## Harness 体验

### 流程摩擦

- **v1 → v2 review 循环**：10 条 MUST_FIX 导致需要完整重写 spec + 写 v2 review + 重新 gate。如果首轮就按六元素模板写，可以省掉这一轮。
- **用户在最后一轮追加需求**：用户在 spec 写完后提出"执行前确认"的新需求。harness 流程允许在本阶段内直接迭代，但频繁追加会导致 review 轮次增加。

### Gate 质量

- v1 review 质量很高——10 条 MUST_FIX 全部准确，没有误报
- gate 脚本正确要求 v2 review 文件存在且 verdict=pass

### 自动化缺口

- **六元素自检可以自动化**：扫描 spec.md 是否包含 `## Outcomes`、`## Decisions`、`## Verification` 等标题，缺失时在 gate 前就警告
