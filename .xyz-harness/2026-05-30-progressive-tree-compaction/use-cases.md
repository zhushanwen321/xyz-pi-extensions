---
verdict: pass
---

# Business Use Cases — Progressive Tree Compaction

> 纯技术性需求，无需业务用例。本扩展是 Pi coding agent 的基础设施层，
> 用户（AI agent）通过使用 Infinite Context 自动受益，不涉及业务 Actor 或用户交互流程。

## AC 覆盖映射

| Spec AC | 验证方式 | 用例覆盖 |
|---------|---------|---------|
| AC-1 Dynamic retention | TC-1-01, TC-1-02 | 技术测试 |
| AC-2 Dynamic scope | TC-2-01, TC-2-02, TC-2-03 | 技术测试 |
| AC-3 Append-only tree | TC-3-01 | 技术测试 |
| AC-4 Context injection | TC-4-01 | 技术测试 |
| AC-5 Stable ratio | 集成测试 (manual) | 技术测试 |
| AC-6 Low usage skip | TC-5-01 | 技术测试 |
| FR-1~FR-7 | 对应 TC 覆盖 | 技术测试 |
| C-1~C-4 | TC-6-01, TC-6-02 | 技术测试 |
