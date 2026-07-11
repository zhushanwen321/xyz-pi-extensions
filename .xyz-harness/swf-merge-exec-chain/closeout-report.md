# Closeout Report — swf-merge-exec-chain

## Topic 概述

将 @zhushanwen/pi-subagents 和 @zhushanwen/pi-workflow 合并为新包 @zhushanwen/pi-subagents-workflow。两部分工作：(1) 包结构合并；(2) 执行链统一（SAR 委托 SubagentService.executeAndAwait）。

## Wave 执行汇总

| Wave | 说明 | 状态 |
|------|------|------|
| wave-0 | prefactor 包结构合并 | committed |
| wave-1 | executeAndAwait | committed |
| wave-2 | schemaEnv bridge | committed |
| wave-3 | 重复代码消除 | committed |
| wave-4 | SAR 委托重写 | committed |
| wave-5 | 依赖声明更新 | committed |
| wave-6 | 全量测试+契约验证 | verified |

## 测试结果

| 包 | 测试文件 | 测试数 | 结果 |
|----|---------|--------|------|
| subagents-workflow | 41 | 655 | PASS |
| subagents (old) | 35 | 587 | PASS |
| workflow (old) | 40 | 686 | PASS |
| coding-workflow | 28 | 316 | PASS |
| pending-notifications | 1 | 23 | PASS |

## 已知遗留

1. AC-ARCH-2: extractYamlField 在 orchestration/agent-discovery.ts 中仍有副本
2. T2（删 sync + 并发池分层 + 通知合并）待后续 topic
3. T3（预制脚本 + 文档/ADR + 旧包 deprecated）待后续 topic
