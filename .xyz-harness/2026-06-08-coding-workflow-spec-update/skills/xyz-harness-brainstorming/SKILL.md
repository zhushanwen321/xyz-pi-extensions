---
name: xyz-harness-brainstorming
description: >-
  Phase 1 (spec) of the xyz-harness workflow. Explores user intent, requirements and design before implementation, produces spec.md.
---

## Dev-flow 上下文

| 项目 | 值 |
|------|---|
| 所在阶段 | Phase 1 (spec) brainstorming |
| 执行者 | 主 agent（交互 + 编排） |
| 上游 | 用户提出需求 |
| 下游（完成后进入） | Phase 2 (plan) — 加载 writing-plans skill |

## 关键变更（V2）

- **Review-Gate 由 coding-workflow 扩展自动管理**，skill 中不再手动 dispatch review subagent
- **Gate Handoff 已删除**，gate 检查在 `coding-workflow-gate` tool 内部自动执行
- **Phase Transition 不再要求单独 session 跑 gate**

## 完整流程

1. **Quick overview** — 主 agent 快速浏览项目结构
2. **Ask clarifying questions** — one at a time
3. **Propose 2-3 approaches** — with trade-offs
4. **Present design** — get user approval
5. **Assumption Audit** — 验证所有假设
6. **Write design doc** — save to `.xyz-harness/${topic}/spec.md`
7. **Spec completeness check** — verify six elements
8. **Terminology & ADR Step**
9. **User reviews written spec**

## Goal 追踪

Brainstorming 完成后、编写 spec 前，**提示用户使用 `/goal`** 初始化任务追踪（任务列表：Write spec.md）。

> 这是 Phase 1 唯一需要用户手动触发 `/goal` 的阶段。Phase 2/3 起由 coding-workflow 扩展自动注入 Goal。

## 完成后

**编写完 spec.md 后，调用 `coding-workflow-gate(phase=1)` 提交。**

不要自行审查 spec，不要 dispatch review subagent。Gate tool 内部会自动：
- 启动 Review-Gate Workflow（循环审查 + 修复）
- Review-Gate 通过后自动触发 Phase-Gate（脚本检查）
- Phase-Gate 通过后自动触发 Retrospect

## 阶段完成

Phase-Gate 通过 + Retrospect 完成后，主 agent 收到 steer 指令调用 `coding-workflow-phase-start()` 进入 Phase 2。
