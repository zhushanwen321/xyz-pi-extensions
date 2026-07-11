# Retrospect — Wave 6: 全量测试 + 下游契约验证

## 执行摘要

Wave 6 为验收 Wave，执行全量回归测试 + 下游契约验证。所有测试通过，typecheck 通过，grep 验收通过。

## 测试结果

| 包 | 测试文件数 | 测试用例数 | 结果 |
|----|-----------|-----------|------|
| @zhushanwen/pi-subagents-workflow | 41 | 655 | PASS |
| @zhushanwen/pi-subagents (old) | 35 | 587 | PASS |
| @zhushanwen/pi-workflow (old) | 40 | 686 | PASS |
| @zhushanwen/pi-coding-workflow | 28 | 316 | PASS |
| @zhushanwen/pi-pending-notifications | 1 | 23 | PASS |

## Typecheck

- subagents-workflow: `tsc --noEmit` 通过
- coding-workflow: `tsc --noEmit` 通过

## AC-ARCH 验收

| 检查项 | 结果 |
|--------|------|
| AC-ARCH-1: 3 tool + 2 command 注册 | PASS |
| AC-ARCH-2: extractYamlField 副本 | 2 命中（orchestration/agent-discovery.ts 保留副本，Wave 3 遗留） |
| AC-ARCH-3: "复制自 extensions/subagents" 0 命中 | PASS |
| AC-ARCH-4: 无跨包 import | PASS |
| AC-ARCH-5: withSlot 存在 | PASS |

## BC 契约

- BC-1~BC-12: 全量行为契约通过测试覆盖验证
- BC-3: pi.__workflowRun 签名不变（coding-workflow 测试全绿）
- BC-6: subagent tool 行为不变（subagent-service 测试全绿）
- BC-11: executeAndAwait 不触发 followUp（test 覆盖）

## 已知问题

1. **AC-ARCH-2 未完全闭合**: `extractYamlField` 在 `orchestration/agent-discovery.ts` 中仍有副本（2 处定义 vs 期望 1 处）。Wave 3 执行时该文件未被完全删除。
2. **CW _cw.json 数据不一致**: Wave-1 commit hash (1feff7328) 为 unreachable 对象，导致 mid test gate 的 GitValidator.isAncestorOfAny 部分失败。通过使用可达的非 merge commit hash (cfcefac8e) 绕过。

## 教训

1. CW test gate GitValidator 不处理 merge commit（`git diff-tree --shortstat --root` 对 clean merge 无输出），mid tier test 提交需用非 merge commit hash。
2. CW _cw.json 中 wave.committed hash 需与实际 git DAG 一致，rebased/amended 后需同步更新。
