---
converged: false
phase: nfr
round: 1
scope: core+integration (#1/#2/#4/#6/#7)
viewpoints: [副作用覆盖性, 缓解可行性]
---

# 正向追踪 Round 1 — 核心模块 + 集成族 (#1/#2/#4/#6/#7)

> 2 fresh subagent 视角（副作用覆盖性 + 缓解可行性）。对照 issues.md AC + decisions.md D-014/017/018/022/024 + system-architecture §5/§7/§9/§12 + 源码 record-store.ts/subagent-service.ts/session-runner.ts。

## 总结

5 个 gap 全为 minor（1 F 文档自洽 + 3 K 分析完整性 + 1 D 措辞澄清），**无阻断性 gap**，**无"标缓解实际不可行"**，**无漏掉的维度风险**（7 维度全覆盖）。核心阻断性风险（D-022/D-024/串台/STATUS_PRIORITY）的缓解均经源码核验可落地。

| Issue | gap 数 | 类型 | 严重度 | 阻断? |
|-------|--------|------|--------|-------|
| #1 types.ts | 0 | — | — | 否 |
| #2 状态机 | 1 | F (文档自洽：STATUS_PRIORITY "非 breaking" vs 编译失败) | minor | 否 |
| #4 WorktreeManager | 2 | K (reaper 映射链未说明) + K (recordId 白名单落地弱) | minor | 否 |
| #6 session-runner | 1 | K (并发 ✅ 需补"每次 fork 独立 open 实例"前提) | minor | 否 |
| #7 SubagentService | 1 | D ("副作用写"边界措辞需澄清) | minor | 否 |

## #1 types.ts — CONVERGED（0 gap）

7 维度评估准确。安全（D-016 unknown 非 any + AC-1.6 shape check）落地清晰；兼容性（crashed 是联合类型 breaking，编译期强制同步是优势）正确。

## #2 状态机 — gap-2-F1 [F] STATUS_PRIORITY 兼容性"非 breaking"与编译失败矛盾

**描述**：#2 兼容性维度写「STATUS_PRIORITY 加 crashed key 是**非 breaking**（Record 扩展，消费方排序自动含新 key）」。但 #1 数据维度 + AC-2.1 + 源码 record-store.ts:29（`Record<ExecutionStatus, number>` 强制全 key）明确：缺 crashed key = TS 编译报错。这是 compile-time breaking change，"自动含新 key"只在 key 已补齐前提下成立，而补齐本身就是必须同步的 breaking 编辑。

**建议**：修正 #2 兼容性维度为「编译期 breaking（强制同次补 key），这是编译器防遗漏的优势而非劣势」；与 #1 数据维度、AC-2.1 措辞统一。文档自洽性问题，不改变决策/AC。

## #4 WorktreeManager — 2 K gap

### gap-4-K1 [K] reaper worktree→session 映射链可行性未说明（D-024 落地前提）

D-024 孤儿判据「worktree 关联 session 有终态标记」需要映射链：`worktree branch 名(pi-sub-<recordId>)` → `recordId` → `sessionFile(<sessionsDir>/<recordId>.jsonl)` → 读 sidecar。NFR 并发/数据维度未说明此链可行性。且「.crashed」不是 sidecar 文件（crashed 是重建推断态），孤儿判据实际应是「.cancelled/.finalized/重建判 crashed」。

**建议**：#4 数据/并发维度补「worktree→session 映射可行性」说明；修正「.crashed」表述。

### gap-4-K2 [K] recordId 白名单仅回灌⑤骨架、无③issue AC（落地强度偏弱）

recordId 是 create 关键入参（进 branch 名/path），git 参数注入（如 recordId=`--upload-pack=...`）可经 args 数组发生（execFileSync 不防 argv 注入，只防 shell 注入）。缓解（白名单）正确，但纯靠⑤骨架约束而③issue #4 无对应 AC，落地强度弱于同族缓解（D-022 有 AC-7.4、D-024 有 AC-4.4 均行为测试）。

**建议**：补 #4 AC-4.14「create 含非法字符 recordId（如 `;rm`/`--upload-pack`）→ 抛错拒绝」。

## #6 session-runner — gap-6-K1 [K] 并发 ✅ 需补"每次 fork 独立 open 实例"前提

并发维度标 ✅ 理由「每 subagent 独立 session 无竞争」，但遗漏交叉点：createBranchedSession 原地 mutate 同一 SessionManager 实例（session-manager.ts:1286-1341）。这个 ✅ 是有条件的（条件=每次 fork 独立 open 实例，非复用），未点明条件读起来像无条件无风险。

**建议**：#6 并发维度补一句「✅ 前提——每次 fork 调用独立 `SessionManager.open()` 实例，createBranchedSession 原地 mutate 不跨 subagent 共享实例」。

## #7 SubagentService — gap-7-D1 [D] "副作用写"边界措辞需澄清

数据维度「archive 必须在副作用写之前」的「副作用写」指代模糊：collectPatch（⓪）会写 patch 文件到磁盘（早于 archive②），这也是磁盘副作用。但 D-017 设计意图是 patch 必须先于 completeRecord 才能进 result。"副作用写"应特指 ③（.finalized + cleanup），不含 collectPatch 的 patch 文件写。

**建议**：#7 数据维度补一句澄清：「'archive 在副作用写之前'特指 ③（.finalized sidecar 写 + cleanup），不含 collectPatch 的 patch 文件写（patch 写是 ⓪，必须先于 completeRecord 以进 result）」。

## 关键核验结论（视角2 重点项）

- **D-022 collectPatch 失败保 worktree（#7）**：缓解可行，AC-7.4 真实可执行（callCount==0 + 目录存在 + patchFailed 标志），非"标缓解不可行"。✅
- **D-024 reaper 孤儿判据（#4）**：判据本身可行（.alive 守卫 + AC-4.4 故障注入），但映射链是前提需补说明。⚠️
- **createBranchedSession mutate 串台（#6）**：安全维度 AC-6.1/6.4 缓解可行（断言 messages 含主历史），并发维度 ✅ 需补前提。⚠️
- **STATUS_PRIORITY 同次补 key（#2）**：AC-2.1 正确（结构化断言 + 同次编辑），兼容性"非 breaking"措辞需修。⚠️
