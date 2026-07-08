---
converged: false
phase: nfr
round: 1
scope: periphery+hygiene (#5/#8/#9/#10/#11)
viewpoints: [副作用覆盖性, 缓解可行性]
---

# 正向追踪 Round 1 — 外围 + 卫生族 (#5/#8/#9/#10/#11)

> 2 视角。对照 decisions.md D-006/D-007/D-008/D-021/D-024 + system-architecture §7/§11/§12 + 源码。

## 总结

2 个中等 gap（#5 实质分析错误 + #9 覆盖遗漏）+ 4 个小 gap。#8/#10/#11 质量高。

| Issue | gap 数 | 严重度 | 阻断? |
|-------|--------|--------|-------|
| #5 FinalizedMarker | 1 (F+K) | 中等 | 是（须订正） |
| #8 subagent-tool | 1 (K) | 低 | 否 |
| #9 index.ts | 2 (K) | 中等+低 | 是（须补分析） |
| #10 session-file-gc | 1 (K) | 低 | 否 |
| #11 ADR-001 | 1 (K) | 低 | 否 |

## #5 FinalizedMarker — gap #5-1 [F+K 中等] 残余风险窗口方向倒置 + 兜底不适用

**F（事实错误）**：NFR 数据维度写「finalize 写 .finalized 后但进程在写下一 entry 前死 → .finalized 存在但 session 不完整。UC-7 异常：降级用 recon stopReason」。但 D-017 时序 `⓪collectPatch→①completeRecord→②archive→③FinalizedMarker.write`，.finalized 在 ③ 最后写，写时 record 已 completeRecord+archive（磁盘已落终态）。故「.finalized 存在但 session 不完整」窗口**不存在**——描述假设 .finalized 先写，与 D-017 相悖。

**K（漏识别的真窗口）**：真窗口是 ①+② 之后、③ 之前 → 无 .finalized 但 record 在磁盘已 done/failed。三分支（§5:118-129）在「都无」分支**恒判 crashed，忽略 recon.status**。故此窗口内 record 被误判 crashed（应为 done/failed）。

**兜底不适用**：NFR 引用的「UC-7 降级 recon stopReason」对真窗口无效——session-reconstructor 仍按 stopReason 推，但 record-store 三分支在无 .finalized 分支根本不读 recon.status，recon 推导结果被丢弃。

**建议**：① 订正 ⚠️ 数据事务边界/残余风险为真窗口（①+②后、③前 → 无.finalized 但磁盘已 done → 三分支恒判 crashed）；② 删除「UC-7 recon stopReason 兜底」表述（三分支不读 recon.status，兜底不成立）；③ 残余接受理由改写为「窗口极短 + 纯显示误差 + record 磁盘完整，crashed 误判可接受」。

## #8 subagent-tool — gap #8-1 [K 低] 「用户显式 opt-in」在 LLM 驱动调用下模糊

NFR 残余「fork:true 继承全部上下文含敏感数据，用户显式 opt-in」。实际调用方是主 agent（LLM）生成，LLM 可自主决定传 fork:true，此时敏感数据继承是「LLM 自主 opt-in」非「用户显式 opt-in」。system prompt 警告对人类有效，对 LLM 自主调用约束力弱。

**建议**：残余接受理由补充「opt-in 主体含 LLM 自主调用；单用户威胁模型下危害有限；system prompt 警告对 LLM 有软约束」。非阻断。

## #9 index.ts — 2 gap

### gap #9-1 [K 中等] 一半职责（缓存 getSessionFile()）完全未分析 + 时序风险漏评

issues.md #9 明确两项职责：① session_start 挂 scan；② **session_start 缓存 ctx.sessionManager.getSessionFile() → SubagentService（供 #3 Resolver 的 mainSessionFile + #6 forkSource）**。NFR #9 全部 7 维度**只分析 reaper scan**，缓存 getSessionFile() 零提及。

**漏评时序风险**：若 session_start 早于主 session 文件创建，getSessionFile() 可能返回 undefined/空路径 → 缓存进 ctx → #6/#3 取到空 mainSessionFile → forkSource 为空 → fork 分流行为异常（取不到主历史或报错）。这是潜在 fork 链路 bug。

**建议**：NFR 补「缓存 getSessionFile()」分析——数据/稳定性维度验证 session_start 时序（主 session 文件已存在），或标注「依赖 pi SDK 保证 session_start 时 getSessionFile() 返回有效路径」作为⑤骨架验证项（与 #6 AC-6.10 衔接）。

### gap #9-2 [K 低] reaper 无 24h 软超时，与 #12 重建不对称

D-024 + AC-4.4/9.4：scan 孤儿判据 = 终态标记 且 无活 .alive，**无 24h 软超时**。对比 #12 重建（AC-12.3）有 startedAt+24h 软超时兜底。不对称后果：pid 复用时 reaper 读 .alive 探活返回活 → 不清 → 孤儿 worktree 永远不被 reaper 清。且 git worktree prune 只清 .git/worktrees 元数据，不清磁盘工作树文件。

**建议**：残余登记补「reaper 无 24h 超时（区别于 #12 重建），pid 复用孤儿 worktree 依赖 git worktree prune + 人工清理；接受理由：无数据丢失，仅磁盘占用」。

## #10 session-file-gc — gap #10-1 [K 低] ⚠️ 并发「残余: 无」对 pid 复用过于乐观

pid 复用同样适用于 GC：A 死后 pid 被 B 复用 → GC 读 A 的 .alive 探活返回活 → GC 跳过清 → A 的 .alive 孤儿残留（GC 无 24h 超时）。后果：.alive 孤儿文件磁盘残留。

**建议**：⚠️ 并发残余改写为「核心 B3 竞态无残余（isProcessAlive 守卫）；pid 复用 .alive 孤儿残留，依赖 #12 重建 24h 超时标记 crashed 后由下次 GC（探活死）清理」。

## #11 ADR-001 — gap #11-1 [K 低] ✅ 安全漏 ADR 修订与 #8 G5 口径一致性

ADR-001 决策 2 修订内容（fork:true 时上下文=主历史+task）实质记录了敏感数据继承语义，与 #8 AC-8.4 system prompt 是同一安全事实的两个文档载体。NFR ✅ 安全标「无安全面」未标注须口径一致，防两文档对敏感数据继承表述漂移。

**建议**：✅ 安全补「ADR 修订与 #8 AC-8.4 system prompt 同源（均记 fork 敏感数据继承），须口径一致」。
