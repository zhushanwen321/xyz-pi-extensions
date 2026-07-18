# Plan Review: subagent-record-identity

**审查方法**: 禁读重建
**审查时间**: 2026-07-18

## 禁读重建结果

从 spec FR/AC 重建 wave 拆分：

| FR | 重建 Wave | 重建 changes |
|----|-----------|--------------|
| FR-1 (record id UUID) | W2 | subagent-service.ts: 改 id 生成 |
| FR-2 (manifest 持久化) | W1 | 新建 manifest-store.ts |
| FR-3 (原子写入) | W1 | manifest-store.ts 内实现 |
| FR-4 (RPC get_state) | W2 | session-runner.ts: 加 RPC 握手 |
| FR-5 (tmp 残留恢复) | W1 | manifest-store.ts 内实现 |
| FR-6 (PID 超时) | W3 | alive-store.ts: 改常量 |
| FR-7 (持久化失败) | W2 | subagent-service.ts: finalizeRecord 抛错 |
| FR-8 (orphan 处理) | W4 | record-store.ts: collectRecords 整合 |

## 初稿 diff

初稿 wave 拆分与重建结果**完全一致**，无遗漏。

## 三维度审查

### coverage（覆盖度）
- FR-1 ~ FR-8 全部有对应 wave + changes ✓
- AC 验收路径：AC-1 (overlay 显示) 在 W4 验证，AC-2 (RPC identity) 在 W2 验证，AC-3 (崩溃无残留) 在 W1 验证，AC-4 (PID TTL) 在 W3 验证，AC-5 (抛错) 在 W2 验证 ✓

### architecture（架构合理性）
- W1 (存储层) → W2 (业务层) → W4 (集成层) 依赖链合理 ✓
- W3 (PID 超时) 独立，可与 W1/W2 并行 ✓
- 每个 Wave 改 1-2 个文件，粒度适中 ✓

### feasibility（可行性）
- W1 新建文件，无外部依赖 ✓
- W2 改现有文件，RPC get_state 是 Pi 公开协议 ✓
- W3 改常量，零风险 ✓
- W4 改 collectRecords，需理解现有四分支重建逻辑，可行 ✓

## Issues

无 must-fix / should-fix issues。

**nit（只记录不追踪）**：
- W4 的 description 可更具体（"四分支重建"改为"先扫 manifest，fallback 到 transcript 重建"）

## 审查结论

plan **完整覆盖** spec 的全部 FR/AC，wave 拆分合理，依赖链正确，可行性高。**就绪进 tdd_plan**。
