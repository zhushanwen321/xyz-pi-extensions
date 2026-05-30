---
verdict: pass
---

# Non-Functional Design — Progressive Tree Compaction

## 1. 稳定性

改动集中在 TreeCompactor 类的压缩算法和触发流程。原有 fallback 机制（ruleBasedFallback + 最多 1 次重试 + 30s 超时）保持不变。新增的 `computeCompressionScope` 是确定性算法（纯数学计算，无外部 I/O），不会引入新的失败路径。唯一新增的风险点是 `buildCompressionPrompt` 中新增的 `existingGroups` 段落 — 如果树很大，prompt 增长可能超出上下文预算。但现有逻辑中，`buildSegmentDigests` 已经有截断（ASSISTANT_TEXT_MAX=800, ASSISTANT_SUMMARY_LIMIT=15），旧树 groups 的摘要本身很小（~100 chars/group），几十个 group 也不超过几千 chars，风险可控。

## 2. 数据一致性

压缩树通过 `pi.appendEntry("ic-compact-tree", tree)` 以追加模式写入 session entries。同一 session 中可能存在多个 compact tree entries（每次压缩追加一条）。`restoreState()` 读取最后一个 entry 作为最新树。旧的 entry 成为死数据但不影响正确性。`compressedSegIds` 存储在 TreeCompactor 闭包中（内存），每次 session 启动时从 entries 重建（推断哪些 segId 被压缩 — 通过对比树中所有 leaf 的 segId 与 session 中所有 segment）。这不需要额外的持久化字段。

## 3. 性能

核心性能影响在 `computeCompressionScope` — 它是一个 O(n) 遍历（最多 1000 段）。每段的预估只有一次整数运算，无字符串拼接或 I/O。较旧版本（一次性压缩所有段）而言，新版本减少了 LLM 调用的输入体积（只压缩部分段），实际上降低了每次压缩的 token 消耗。但代价是压缩更频繁（每次触发只压缩一部分段）。综合看，对于典型 session（50-200 段），每 10-20 次 user message 触发一次压缩，每次压缩只涉及 3-15 段，token 开销远低于一次性压缩全部段。

## 4. 业务安全

不适用。本扩展不涉及业务逻辑或用户数据访问策略的变更。

## 5. 数据安全

不适用。本扩展不处理敏感信息或 PII。段文件（`.pi/infinite-context/`）的访问控制由 Pi 运行时管理。新增的 `compressedSegIds` 是纯内存状态，不持久化到磁盘。
