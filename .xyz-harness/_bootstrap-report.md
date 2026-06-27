# 项目文档基建初始化报告

> 生成时间：2026-06-27
> 仓库：xyz-pi-extensions / worktree `refactor-coding-workflow-design`
> 执行：design-init skill（dry-run 确认后正式执行）

## 文档基建扫描结果

### 必备
- **CLAUDE.md** ✅（804 行，主配置。本项目用 CLAUDE.md，按新 skill 规则不强制归一化为 AGENTS.md）
- **README.md** ✅
- **CONTEXT.md** ✅（Pi 平台术语表）

### 推荐（本次新建骨架）
- **ARCHITECTURE.md** ✅ 新建（分层/模块/状态机/依赖，含已知信息，细节待 design-closeout 沉淀）
- **PRODUCT.md** ✅ 新建（愿景/用户/边界/非目标）
- **NFR.md** ✅ 新建（含已验证约束 C-1 Session 隔离 + RISK-1）

### 可选（本次新建骨架）
- **TEST-STRATEGY.md** ✅ 新建（金字塔/门禁/Mock 约定）
- **DESIGN-LOG.md** ✅ 新建（主题台账 + ADR 索引）

## 已执行操作

| # | 操作 | 结果 |
|---|------|------|
| 1 | 删除根目录过程产物 | `progress.md` / `draft-issue-setactivetools.md` / `review-output.md` / `phase-specs-review.md` |
| 2 | 合并 Review Loop 调研 | `review-round-1/2` 三个文件 → `docs/research/review-loop-feasibility.md` |
| 3 | 新建 5 个长期文档骨架 | ARCHITECTURE / PRODUCT / NFR / TEST-STRATEGY / DESIGN-LOG |
| 4 | 更新 design-init skill | 去 symlink 归一化，改「主配置定位 + 文档位置推断」逻辑 |
| 5 | 更新 design-closeout skill | 沉淀目标文档位置跟随主配置 |
| 6 | 新增 githooks 规则 | `.githooks/check-doc-layout`（根目录 + docs 白名单），集成 pre-commit(0e) + check-structure |

## Githooks 规则

- **根目录 .md 白名单**（阻断）：README / CONTEXT / CLAUDE / AGENTS / ARCHITECTURE / PRODUCT / NFR / TEST-STRATEGY / DESIGN-LOG
- **docs/ 根级 .md 白名单**（阻断）：8 个跨主题规范文档；主题/调研内容进子目录（docs/research/、docs/adr/ 等）
- 触发：pre-commit（staged 根级或 docs 根级 .md 时）+ check-structure（手动全量）

## 待办（后续阶段）

- ARCHITECTURE/PRODUCT/NFR 的实质内容由 design-closeout 从各 `.xyz-harness/{topic}/` 沉淀
- DESIGN-LOG 主题台账待 design-closeout 核对实际归档状态
- **CLAUDE.md 804 行偏臃肿**（skill 建议 <100 行，ETH Zurich 研究显示臃肿 context 降低 agent 成功率）——可独立任务瘦身，本次按「不覆盖已有文档」原则未动
- check-structure 预存 4 个 FAIL（CLAUDE.md 缺 design-status / plan·structured-output re-export / subagents 模块级）非本次引入，建议另行修复
