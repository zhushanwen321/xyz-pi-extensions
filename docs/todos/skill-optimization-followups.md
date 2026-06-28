# Skill 优化 — 待跟进项

> 来源：2026-05-31 skill 优化周期（`improvement/skill-optimization-backlog.md` 已删除）
> 原则：完成一项删一项，全部清空后删除本文件。

---

## P1 — 待合并/精简（功能重叠）

| Skill | 现状 | 建议 |
|-------|------|------|
| `code-taste-review` | 通用品味审查 | 与 `ts-taste-check` + `rust-taste-check` 合并为统一品味审查入口，按语言路由 |
| `ts-taste-check` | TS/Vue 品味检查（含 ESLint 自动化） | 并入统一品味审查 |
| `rust-taste-check` | Rust 品味检查（含 lint 脚本） | 并入统一品味审查 |
| `manage-worktree` | worktree 创建+删除 | 与 `create-worktree` + `remove-worktree` 重叠，评估合并 |
| `diagnose` | 系统化调试循环 | 与 `rethink` 重叠（都"跳出局部"），明确分工或合并 |
| `rethink` | 思维框架 | 同上 |

---

## P2 — 低频/零触发，待评估保留或删除

| Skill | 来源 | 触发 | 评估方向 |
|-------|------|------|----------|
| `bug-fix-recorder` | useful-dev-tools | 零 | 可否由 `meta-sk-skill-writer` 规则替代 |
| `cc-agent-design` | useful-dev-tools | 零 | 与 `meta-sk-agent-writer` 定位差异（设计咨询 vs 编写） |
| `improve-codebase-architecture` | .agents/skills | 零 | 可否由架构规则替代 |
| `lightmerge-branch` | useful-dev-tools | 低 | 独立价值 or 合并 `merge-worktree` |
| `py-preference` | useful-dev-tools | 低 | 并入 `meta-sk-skill-writer` 规则输出 |
| `token-counter` | useful-dev-tools | 低 | 改为 CLI 工具而非 skill |
| `to-prd` | .agents/skills | 零 | PRD 生成，频率极低 |
| `task-test-guide-workspace` | useful-dev-tools | 零 | 历史遗留，可能无价值 |
| `learned` | useful-dev-tools | 零 | Claude Code 遗留，Pi 不使用 |

---

## 已决策保留（不算 todo）

`pr-worktree`、`remove-worktree`、`evolve*`（3件套）、`remotion-*`（4个）、`grill-with-docs`、`impeccable`、`vision-analysis`、`web-fetch`、所有 `xyz-harness-*`（16个）。
