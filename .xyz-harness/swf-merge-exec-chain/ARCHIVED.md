# Archived — swf-merge-exec-chain

Topic: T1 包结构合并 + 执行链统一
Status: closed (2026-07-10)

## 沉淀去向

| 文档 | 路径 | 说明 |
|------|------|------|
| ADR-030 | docs/adr/030-subagents-workflow-merge.md | 包合并 + 执行链统一架构决策 |
| ARCHITECTURE | docs/extensions/subagents-workflow/architecture.md | 新包三层架构 |

## 交付物

| 交付物 | 路径 |
|--------|------|
| requirements.md | .xyz-harness/swf-merge-exec-chain/requirements.md |
| system-architecture.md | .xyz-harness/swf-merge-exec-chain/system-architecture.md |
| issues.md | .xyz-harness/swf-merge-exec-chain/issues.md |
| non-functional-design.md | .xyz-harness/swf-merge-exec-chain/non-functional-design.md |
| code-architecture.md | .xyz-harness/swf-merge-exec-chain/code-architecture.md |
| execution-plan.md | .xyz-harness/swf-merge-exec-chain/execution-plan.md |
| decisions.md | .xyz-harness/swf-merge-exec-chain/decisions.md |

## 代码变更

新包: `extensions/subagents-workflow/`
旧包保留（不动）: `extensions/subagents/`, `extensions/workflow/`
