# Spec Review: subagent-record-identity

**审查方法**: 禁读重建
**审查时间**: 2026-07-18

## 禁读重建结果

### FR 列表

| ID | 标题 | 详情 |
|----|------|------|
| FR-1 | record id 全局唯一 | 改为 crypto.randomUUID()，替代 bg-${tag}-${seq}-${Date.now()} |
| FR-2 | manifest 文件持久化 | <uuid>.json 包含 id, rootSessionId, agentName, status, createdAt, completedAt, sessionFile, pid |
| FR-3 | 原子写入 | write-tmp + fsync + rename + fsync dir |
| FR-4 | RPC 握手获取 sessionFile | spawn 后调 get_state 获取 sessionFile + sessionId |
| FR-5 | 启动时 tmp 残留恢复 | 扫描 *.json.tmp.* 残留，3 分支判定 |
| FR-6 | PID 超时收窄 | ALIVE_SOFT_TIMEOUT_MS 从 24h→1h |
| FR-7 | 持久化失败不静默吞 | manifest 写入失败向上抛错，不走 bestEffort |
| FR-8 | orphan session 处理 | 标为孤儿，UI 提供丢弃/保留选项 |

### AC 列表

| ID | 条件 | 验证方式 |
|----|------|----------|
| AC-1 | subagent 完成后 overlay 仍显示终态 record | e2e |
| AC-2 | RPC 模式下 identity 写入成功 | unit |
| AC-3 | 崩溃后无 tmp 残留 | unit |
| AC-4 | PID 复用被 1h TTL 兜底 | unit |
| AC-5 | 写入失败时抛错而非静默 | unit |

### 决策清单

| ID | 决策 | 理由 |
|----|------|------|
| D1 | record 身份从 transcript 解耦 | ADR-035: 根治 transcript 损坏→record 消失 |
| D2 | manifest 作为 source of truth | 不依赖外部状态 |
| D3 | RPC get_state 握手 | 不改 Pi 源码，用公开协议 |
| D4 | ALIVE_SOFT_TIMEOUT_MS 1h | 缩小 PID 复用窗口 |
| D5 | orphan 不迁移 | 承认无法无损迁移 |

## 初稿 diff

初稿只有澄清记录，**缺失**：
- FR 清单（8 项）
- AC 清单（5 项）
- 决策清单（5 项）
- manifest 存储位置
- get_state 时序/重试策略
- 并发隔离策略
- legacy 兼容策略

## Issues

| # | severity | dimension | description | ref |
|---|----------|-----------|-------------|-----|
| SR1 | must-fix | completeness | manifest 文件存储位置未定义（~/.pi/agent/records/? ~/.pi/agent/subagents/records/?） | FR-2 |
| SR2 | must-fix | completeness | get_state 时序边界未定义：session 初始化完成前调 get_state 会返回空 sessionFile，需要重试策略或等待信号 | FR-4 |
| SR3 | must-fix | completeness | concurrent subagent 的 manifest 隔离策略未定义：多个 subagent 并发创建 record 时，manifest 文件名已是 UUID 所以不会冲突，但 RecordStore 的内存 records Map 需要同步保护 | FR-2 |
| SR4 | must-fix | completeness | manifest 与现有 RecordStore 的关系未定义：替换还是并存？collectRecords 如何整合 manifest 和 transcript 重建的 record？ | FR-2 |
| SR5 | should-fix | completeness | tmp 残留恢复的判定标准需细化：JSON.parse 验证完整性？文件大小阈值？mtime 过旧？ | FR-5 |
| SR6 | should-fix | completeness | manifest 字段完整性：sessionFile 可能为空（get_state 失败时），status 状态转换时机未定义 | FR-2 |
| SR7 | should-fix | reasonableness | 原子写入 rename 失败（如 EXDEV 跨设备）时的清理策略 | FR-3 |
| SR8 | should-fix | completeness | orphan 判定标准：manifest 存在但 session 文件缺失？manifest 缺失但 session 存在？ | FR-8 |
| SR9 | nit | consistency | FR-8 说"orphan session 标为孤儿"，但 orphan 是 manifest 级还是 session 级？术语需统一 | FR-8 |

## 审查结论

初稿**不完整**，缺失 FR/AC 清单和多个关键设计点。有 4 个 must-fix issues 需要修复后才能进 plan。

**建议**：修复 must-fix issues 后重新 gen-spec，再进 plan 阶段。
