---
phase: code-arch
step: 6b
round: 1
backfeed_entries: 1
backfeed_type: "事实性细化（非矛盾，D-可逆 agent-opinionated）"
upstream_affected: "system-architecture.md（§5/§6 SCR 签名细化）"
---

# 反哺检查 — code-arch（⑤ Step 6b）

> 骨架物理验证后、交接前。回扫①-④上游：⑤定稿 + 骨架是否引入与上游矛盾的结论。
> 骨架常证伪②的分层/领域边界/模块划分假设——本轮重点查 SCR 纯函数落地、SDK 契约、四分支时序。
> 审查人：主 agent（fresh-context backfeed subagent 超时未产出，主 agent 自查）。

## 反哺纪律
- 只改事实性矛盾（非风格）
- D-不可逆矛盾须 ask_user（本轮无）
- 同步 decisions.md
- 只改内容不改 phase 状态
- 反哺后回流（上游 .md 更新后本阶段对齐）

## 反哺条目

### BF-1 [事实性细化，非矛盾] SCR.resolveSessionContext 入参签名细化
- **发现**：⑤骨架的 `resolveSessionContext(input: ResolveInput, agentDir: string)` 把 `agentDir` 作为第二参数（构建 sessionDir 路径用）。②system-architecture.md §6 的 SCR 接口契约未显式列 `agentDir` 参数（只描述返回 sessionDir 路径）。骨架物理验证发现：sessionDir 路径拼接（`agentDir/subagents/<encoded-cwd>/sessions`）需要 agentDir 输入——纯函数无法从上下文获取（D-014 零副作用，不读 ctx.agentDir）。
- **是否矛盾**：**否**——是细化，非推翻。②描述了 SCR 返回 sessionDir，⑤骨架落实了"sessionDir 怎么算出来"（需 agentDir 入参）。D-014（纯函数）不变——agentDir 是显式入参不是副作用。
- **反哺去向**：②system-architecture.md §6 SCR 接口契约补注"resolveSessionContext 入参含 agentDir（sessionDir 路径拼接用，纯函数显式入参非副作用）"。
- **分类**：D-可逆，agent-opinionated（签名细化，非架构决策）
- **是否需 ask_user**：否（非 D-不可逆，agent 自决签名）

## 已验证无矛盾项（骨架物理验证证实上游结论）

| 上游结论 | 骨架验证 | 状态 |
|---------|---------|------|
| D-014 SCR 真纯函数（零 Pi 依赖零副作用） | 骨架 session-context-resolver.ts：无 pi import / 无 execFileSync/writeFileSync/spawn/readFileSync/forkFrom/sdk.（②§11 AC-2 grep 过） | ✅ 证实 |
| D-018 createBranchedSession 实例 mutate + 返回文件路径 | 骨架 session-runner.ts:49 `sm.createBranchedSession(sm.getSessionId())` 原地 mutate 同一实例，传 createAgentSession | ✅ 证实 |
| D-016 SdkLike 鸭子类型（forkFrom 静态 / createBranchedSession 实例） | 骨架 types.ts:113 forkFrom 在 SdkLike.SessionManager 块（静态），:131 createBranchedSession 在 SessionManagerInstance 块（实例） | ✅ 证实（位置正确，R2 F-6） |
| D-017 finalizeRecord 时序 ⓪①②③ + D-022 patchOk 守卫 | 骨架 subagent-service.ts:48 finalizeRecord ⓪collectPatch→①completeRecord→②archive→③finalized+[patchOk]cleanup+removeAlive | ✅ 证实 |
| D-019 无 GitPort，gitRun 内联 | 骨架 worktree-manager.ts:122 私有 gitRun（execFileSync），无 git-port.ts 文件 | ✅ 证实 |
| D-020 collectPatch 是 WorktreeManager 方法 | 骨架 worktree-manager.ts:101 collectPatch 方法，无 patch-collector.ts 文件 | ✅ 证实 |
| D-021 四分支 pid 探活（isProcessAlive 保守判死） | 骨架 alive-store.ts:70 isProcessAlive（EPERM=活，其他=死保守），record-store.ts 四分支接线 | ✅ 证实 |
| D-023 externalInstance 独立字段（不污染 ExecutionStatus） | 骨架 types.ts:141 SubagentRecord.externalInstance?:boolean，record-store.ts:67 分支3 标 externalInstance:true | ✅ 证实 |
| D-024 reaper .alive 守卫（不删活 worktree） | 骨架 worktree-manager.ts:82 scan 内 `if (alive && isProcessAlive(alive.pid)) continue` 跳过活态 | ✅ 证实 |

## 收敛判定
**entries: 1**（BF-1 签名细化，非矛盾）。骨架物理验证**证实了上游 9 项关键决策**（D-014/D-016/D-017/D-018/D-019/D-020/D-021/D-023/D-024），无 D-不可逆矛盾，无需 ask_user。

## 回流处理
BF-1 是②system-architecture.md 的事实性细化（SCR 签名补 agentDir 参数注）。**不阻断⑤交接**——⑤骨架已用正确签名（含 agentDir），②的描述性文字补注即可（非决策变更）。本阶段交接后，②的补注可后续补（非紧急，因⑤骨架已是真相源）。
