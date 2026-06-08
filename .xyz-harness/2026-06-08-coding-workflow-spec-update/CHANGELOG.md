# Changelog

## 0.2.0 — 2026-06-08

### Added
- Gate Pipeline 抽象：`ReviewGate`, `PhaseGate`, `TestFixLoopGate`
- 11 个新的 agent `.md` 文件（reviewer / fix worker / coordinator）
- 4 个 workflow 脚本（Phase 1/2/3 Review-Gate + Phase 4 Test-Fix Loop）
- Phase 2/3 Goal 自动注入
- Retrospect 上下文注入
- 4 个清理后的 SKILL.md（brainstorming/writing-plans/phase-dev/phase-test）
- ADR-019: coding-workflow 依赖 workflow extension 的决策记录

### Changed
- Review-Gate 全部改为 Workflow Extension 驱动
- Test-Fix Loop 改为单一 workflow 脚本，core → noncore 串行
- Gate Handoff 机制删除，由 Gate Pipeline 自动编排

### Removed
- 旧的 Five-Step Specialized Review 手动流程
- 手动 Self-Review / Plan Review 章节
