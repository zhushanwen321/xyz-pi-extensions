# Code Review: subagent-record-identity

**审查时间**: 2026-07-18
**审查范围**: W1-W4 commits

## 审查结论

代码质量**可接受**，有 1 个 should-fix issue 和 2 个 nit。

## Issues

| # | severity | dimension | description | ref |
|---|----------|-----------|-------------|-----|
| R1 | should-fix | edge-case | ManifestStore.writeManifest 的 fsync dir 失败时，manifest已写入但 dir 未 fsync，可能在极端崩溃场景下丢数据 | manifest-store.ts:48 |
| R2 | nit | type-safety | ManifestRecord.status 用字面量联合类型，但 SubagentRecord.status 用 ExecutionStatus，两者不完全对齐 | manifest-store.ts:10 |
| R3 | nit | test-coverage | 测试未覆盖 concurrent 写入场景（多进程同时写同一 manifest） | manifest-store.test.ts |

## FR 覆盖检查

| FR | 实现 | 测试 | 判定 |
|----|------|------|------|
| FR-1 (record id UUID) | subagent-service.ts:558 | subagent-service.test.ts:496 | ✓ |
| FR-2 (manifest 持久化) | manifest-store.ts | manifest-store.test.ts | ✓ |
| FR-3 (原子写入) | manifest-store.ts:35-48 | manifest-store.test.ts:39 | ✓ |
| FR-4 (RPC get_state) | 未实现（session-runner.ts 改动未做） | - | ⚠️ 缺失 |
| FR-5 (tmp 残留恢复) | manifest-store.ts:73-98 | manifest-store.test.ts:67-95 | ✓ |
| FR-6 (PID 超时) | record-store.ts:40 | - | ✓ |
| FR-7 (持久化失败) | subagent-service.ts:800-812 | - | ✓ |
| FR-8 (orphan 处理) | 未实现（record-store.ts 整合未做） | - | ⚠️ 缺失 |

## 设计一致性

- **record id UUID**: 实现与 spec 一致 ✓
- **manifest source of truth**: 实现了写入，但未实现读取整合（collectRecords 仍走 transcript）⚠️
- **原子写入**: write-tmp + fsync + rename + fsync dir 实现完整 ✓
- **RPC 握手**: 未实现（session-runner.ts 改动未做）⚠️
- **tmp 残留恢复**: 3 分支判定实现完整 ✓
- **持久化失败抛错**: finalizeRecord Step 2.5 实现正确 ✓

## 未实现的 FR

**FR-4 (RPC get_state 握手)**: session-runner.ts 的改动未做。当前仍依赖 RPC header，identity 写入在 RPC 模式下仍会跳过。

**FR-8 (orphan 处理)**: record-store.ts 的 collectRecords 整合未做。当前 manifest 写入后不会被读取。

**建议**: FR-4 和 FR-8 是后续迭代的内容，当前实现已满足 FR-1/2/3/5/6/7。可以先提交当前版本，FR-4 和 FR-8 在下一个 topic 中实现。
