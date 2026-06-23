# docs 目录

xyz-pi-extensions 的文档统一存放于 `docs/`。按内容性质分目录，全项目共享。

## 目录结构

| 目录 | 内容 | 性质 |
|------|------|------|
| 根级 `*.md` | 全项目统一遵守的规范 | 活文档，持续维护 |
| `adr/` | 架构决策记录（不可逆决策，`NNN-<topic>.md`） | 永久 |
| `evolution/` | 决策前的方案探索与 brainstorming | 迭代到决策或废弃 |
| `research/` | 外部调研、竞品借鉴、技术分析（每个主题一个子目录） | 长期参考 |
| `third-party-extensions/` | 社区扩展借鉴记录（source of truth: `extensions.yaml`） | 长期参考 |
| `extensions/<name>/` | 单个 extension 的内部架构文档 | 随 extension 演进 |
| `todos/` | 跨 extension 的待跟进项，完成即删 | 临时 |

## 文档归属判定

| 问题 | 去向 |
|------|------|
| 只对一个 extension 有意义？ | `extensions/<name>/` |
| 全项目通用规范？ | 根级 `*.md` |
| 已做出的不可逆决策？ | `adr/` |
| 决策前的方案探索？ | `evolution/` |
| 外部 / 竞品 / 技术调研？ | `research/<topic>/` |
| 待跟进的 TODO？ | `todos/` |

## 禁止放入 docs/

- xyz-harness 工作流产出物（spec / plan / test / retrospect）→ `.xyz-harness/<date>-<slug>/`
- 一次性审查日志、已完成的修复记录 → 完成后删除（git 可追溯）
- extension 的 CHANGELOG / README → 放 extension 源码目录

## 关键文档入口

- [architecture.md](./architecture.md) — 系统架构总览（最新）
- [standards.md](./standards.md) — Pi Extension 开发规范
- [monorepo-conventions.md](./monorepo-conventions.md) — 目录结构与发布规则
- [quality-gates.md](./quality-gates.md) — 质量门控与 Git Hooks
- [pi-tui-development-guide.md](./pi-tui-development-guide.md) — TUI 扩展避坑指南
