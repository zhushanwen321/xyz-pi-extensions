---
review:
  type: spec_review
  round: 2
  timestamp: "2026-06-01T23:30:00"
  target: ".xyz-harness/2026-06-01-merge-harness-extensions-monorepo/spec.md"
  verdict: pass
  summary: "Spec 评审第2轮，4条MUST FIX全部已修复，0条新增MUST FIX，通过"

statistics:
  total_issues: 8
  must_fix: 0
  must_fix_resolved: 4
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-6 + AC-5"
    title: "todolist 迁移策略自相矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "spec.md:AC (全体) + Constraint 7"
    title: "缺少功能回归验证的验收标准"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR-5"
    title: "subagent 去重缺乏具体改动说明"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: MUST_FIX
    location: "spec.md:AC-3 + FR-3"
    title: "Python 脚本迁移位置和依赖管理未说明"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: LOW
    location: "spec.md:FR-3 + AC-3"
    title: "harness 的 agents 和 commands 缺完整清单"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: LOW
    location: "spec.md:全体"
    title: "缺少里程碑检查点和回滚策略"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 7
    severity: LOW
    location: "spec.md:业务用例"
    title: "业务用例完全为空，缺少受益方说明"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 8
    severity: INFO
    location: "spec.md:Complexity Assessment"
    title: "风险评估较笼统，未识别具体风险场景"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-06-01 23:30
- 评审类型：计划评审（spec 阶段，第 2 轮增量审查）
- 评审对象：`.xyz-harness/2026-06-01-merge-harness-extensions-monorepo/spec.md`
- 项目约束来源：`CLAUDE.md`（monorepo 架构、设计原则、运行时约束）

## MUST FIX 修复验证

### [FIXED] #1: todolist 迁移策略自相矛盾

FR-6 已改写为明确的决策陈述：**决策：不迁入**，以当前项目的 `todo` 为主。条件性迁移描述已移除，改为"如果后续发现 todolist 有独特功能需要，作为独立需求单独处理，不纳入本次迁移"。AC-5 第 4 条"todolist 不迁入"与 FR-6 现在完全一致。✅ 已修复

### [FIXED] #2: 缺少功能回归验证的验收标准

新增 AC-7（功能回归验证），包含 4 条可验证的 smoke test：
1. 在 Pi 中加载所有已迁移的 extensions（`--extension` 参数），无启动错误
2. coding-workflow 的 gate tool 可执行
3. goal 的 `goal_manager` tool 可调用
4. subagent 的 basic single 模式可执行

每条都可实际操作验证，与 Constraint 7（不改变运行时行为）形成闭环。✅ 已修复

### [FIXED] #3: subagent 去重缺乏具体改动说明

FR-5 已补充为详细的迁移规格：
- 明确列出 3 个内部文件（`subagent.ts`、`model-resolve.ts`、`process-manager.ts`）及其导出内容
- 明确列出 2 个消费方（`index.ts`、`review-dispatcher.ts`）及其具体 import 项
- 给出 5 步迁移策略，每步有具体的文件和 import 路径变化
- 标注了公共 API 可能受影响的风险，并要求 Phase 2 详细列出 API 变化

✅ 已修复

### [FIXED] #4: Python 脚本迁移位置和依赖管理未说明

Complexity Assessment 章节新增"Python 脚本管理"子节：
- `gate-check.py` → `packages/coding-workflow/scripts/`，通过 `__dirname` 相对路径调用
- Python 依赖（PyYAML）在 README 中说明，不纳入 npm 包管理
- 纳入 npm 包的 `files` 白名单确保发布时包含
- `validate-skill-yaml.py` → `scripts/`（共享脚本）

风险表中也增加了 gate-check.py 路径问题的风险项及缓解措施。✅ 已修复

## 回归检查

逐项确认修复未引入新问题：

| 检查项 | 结果 |
|--------|------|
| FR-6 决策与 AC-5 一致性 | ✅ 一致，均为"不迁入" |
| AC-7 与现有 AC 不冲突 | ✅ 独立的新 AC，无重叠 |
| FR-5 补充信息与 CLAUDE.md 约束一致 | ✅ coding-workflow 通过 `workspace:*` 依赖 subagent，符合 CLAUDE.md 设计原则 |
| Python 脚本管理方案与 monorepo 结构兼容 | ✅ 包级 scripts + 根级 scripts，结构合理 |
| AC-9 里程碑检查点与 AC-7/AC-8 逻辑顺序正确 | ✅ CP-1 → CP-4 渐进式验证 |
| FR-3 的 skills 清单与 CLAUDE.md 包清单无冲突 | ✅ coding-workflow 含 ~20 skills，evolve-daily 含 3 skills |
| FR-4 独立 skills 清单合理 | ✅ 10 个 skills，明确列出了 worktree/审查/工具类 |

## LOW/INFO 修复验证

| # | 问题 | 修复状态 |
|---|------|---------|
| 5 | agents/commands 清单缺失 | ✅ AC-3 列出 7 个 agents + 2 个 commands |
| 6 | 里程碑和回滚策略缺失 | ✅ AC-9 增加CP-1~CP-4；风险表含 release tag + 只读归档策略 |
| 7 | 业务用例为空 | ✅ UC-1（跨仓库改动简化）、UC-2（用户安装体验）已补充 |
| 8 | 风险评估笼统 | ✅ 风险表含 4 个具体场景（subagent 去重、skill 路径、Python 路径、git 历史） |

## 结论

通过。

## Summary

Spec 评审完成，第2轮，0条MUST FIX，通过。4条历史MUST FIX全部已修复，无回归问题。
