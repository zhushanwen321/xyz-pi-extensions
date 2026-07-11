# Context Summary — T2 mid-detail-plan

## 不可推翻的决策清单

| id | decision | 来源 |
|----|----------|------|
| D-000 | 合并为一包 @zhushanwen/pi-subagents-workflow | T1 decisions.md |
| D-004 | 旧两包原样保留、不标记 deprecated；deprecated 标记与清理由 T3 负责 | T1 decisions.md |
| D-007/D-008 | executeAndAwait 已在 T1 实现 | T1 decisions.md |
| D-009 | 双重记账一致性由 T2 处理 | T1 decisions.md |
| D-010 | M-4 子进程 kill 归属迁移到 session-runner.spawnedChildren | T1 decisions.md |
| handoff | wait 参数彻底删除（用户明确决策） | handoff §决策1 |

## T2 设计树入口

从 T2 system-architecture.md 推导：
- §5 模块拆分：4 个模块改造（subagent-service / concurrency-pool / notifier / types）
- §8 并发模型：分层配额 max(1, maxConcurrent-depth)
- §9 通知机制合并：删除 notifier.ts，改用 pending:unregister
- §10 sync 删除：wait 参数完全删除
- §11 双重记账一致性：统一 record 生命周期管理

## 与上游的接口契约

- T1 已实现 executeAndAwait（D-A1/D-A10），T2 不改
- T1 已实现 SAR 委托重写（D-A2），T2 不改
- T1 已实现 session-runner schemaEnv bridge（D-A6），T2 不改
- T2 改 concurrency-pool.ts（分层配额）、删 notifier.ts、删 sync 分支

## 相关长期约束

- MAX_FORK_DEPTH=10 硬上限（handoff §并发控制）
- 通知机制必须通过 pending:unregister 事件（pending-notifications 扩展消费）
- 并发池分层配额必须保底 1 槽位（不饿死）
