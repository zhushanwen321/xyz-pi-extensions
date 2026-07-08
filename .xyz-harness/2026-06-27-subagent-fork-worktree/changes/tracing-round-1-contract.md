---
frame: contract
round: 1
converged: false
gap_count: 3
---

# code-arch Step 2 追踪 — 契约帧（contract）

> 视角：契约完整性 + 调用链闭合。
> 审查人：主 agent（fresh 视角，逐条对照源码 + decisions + issues）。
> 注：5 组并行 fresh subagent 因环境超时未产出，按 SKILL「轻量项目降级」由主 agent 串行执行四认知帧；重建帧不降级（独立执行，见 reconstruct.md）。

## 审查方法
逐条对照：①code-architecture.md §3 签名表 + §4 时序图 ↔ ②issues.md #1-#13 方法清单 + AC ↔ ③decisions.md D-016/D-017/D-018/D-022 ↔ ④源码 session-runner.ts/subagent-service.ts/types.ts。

## Gaps

### CC-1 [K] RunOptions 缺 fork/worktree 透传字段
- **location**: §3 session-runner + §4 时序图
- **description**: 现有 `run()` 入参 `RunOptions`（session-runner.ts:81-100）**无 fork/worktree/mainSessionFile/parentForkDepth 字段**。源码确认 session-runner.ts 全文 0 处 fork/worktree（grep 无命中）。fork/worktree 意图必须从 `SubagentService.execute()` → `run()` → `createAndConfigureSession()` 透传，但 §3 只标了 `createAndConfigureSession` 改动，**未标 RunOptions 需扩字段**。意图数据有两条路径可选：(a) RunOptions 扩 fork/worktree/parentForkDepth（per-task），(b) SessionRunnerContext 扩（per-session）。fork/worktree 是 per-task（每次 execute 不同），应进 RunOptions；mainSessionFile/mainCwd 是 per-session（buildSessionRunnerContext 一次），应进 SessionRunnerContext。§3 已正确把 mainCwd/mainSessionFile 放 SessionRunnerContext，但 RunOptions 的 fork/worktree/parentForkDepth 透传缺失。
- **evidence**: session-runner.ts:81-100 RunOptions 定义无 fork/worktree；:258-307 createAndConfigureSession 只用 ctx.cwd（无 fork 分流）；subagent-service.ts:316-326 run() 调用只传 resolved/agentConfig/appendSystemPrompt/skillPath/schema/maxTurns/graceTurns/signal/onEvent（无 fork/worktree）
- **fix_suggestion**: §3 session-runner 表加一行 `RunOptions ✎ 加 fork?:boolean / worktree?:boolean / parentForkDepth?:number`；§4 时序图 Tool→Svc→Runner 调用标注 fork/worktree 经 RunOptions 透传。**非 D-不可逆**（agent 自决：意图数据走 RunOptions 是唯一合理选择，SessionRunnerContext 是 session 级缓存放 per-task 意图会污染）。

### CC-2 [K] ExecuteOptions 缺 fork/worktree/cwd 透传链
- **location**: §3 subagent-tool + subagent-service
- **description**: §3 标了 StartParam 加 fork?/worktree?/cwd?（#8），但**未标 ExecuteOptions（types.ts:283-309）需对应加字段**——SubagentService.execute(opts: ExecuteOptions) 从 opts 读 fork/worktree/cwd 传给 run()。当前 ExecuteOptions 无这些字段（types.ts 确认）。透传链断裂：StartParam(subagent-tool) → ??? → ExecuteOptions(subagent-service) → RunOptions(session-runner)。中间 ExecuteOptions 缺字段会让 opts.fork 在 TS 编译报错。
- **evidence**: types.ts:283-309 ExecuteOptions 无 fork/worktree/cwd；subagent-service.ts:172 execute(opts: ExecuteOptions) 内 resolveIdentity/createRecordForMode 均未读 fork/worktree
- **fix_suggestion**: §3 subagent-service 表加 `ExecuteOptions ✎ 加 fork?/worktree?/cwd?`（types.ts），与 StartParam 对齐。链路：StartParam → 映射 → ExecuteOptions → 映射 → RunOptions。**非 D-不可逆**。

### CC-3 [K] record.worktreeHandle 字段声明缺失
- **location**: §3 types.ts + ExecutionRecord
- **description**: §3 标了 `SubagentRecord.worktreeHandle?` 投影字段，但 **ExecutionRecord（types.ts:210-244，运行期状态对象）需加 worktreeHandle 字段**才能在 execute→finalizeRecord 间传递 handle（create 时回填，cleanup 时读）。§3 只标了投影（SubagentRecord），未标运行期载体（ExecutionRecord）。时序图 UC-2 标"record.worktreeHandle = handle"但 §3 无对应字段声明。
- **evidence**: types.ts:210-244 ExecutionRecord 无 worktreeHandle；时序图 UC-2 step "record.worktreeHandle = handle" 引用了未声明字段
- **fix_suggestion**: §3 types.ts 表加 `ExecutionRecord.worktreeHandle?: WorktreeHandle`（运行期载体，finalize 后可清）；投影 SubagentRecord.worktreeHandle? 保留（list 显示 path）。**非 D-不可逆**。

## 已验证无 gap 项（CONVERGED 子项）
- ✅ SdkLike 鸭子类型（D-016/D-018）：§3 正确区分 forkFrom（静态，SdkLike.SessionManager 块）+ createBranchedSession（实例，AgentSessionLike.sessionManager 块），与 issues.md:143 R2 F-6 修正一致
- ✅ D-017 finalizeRecord 时序：§3/§4 正确 ⓪collectPatch→①completeRecord→②archive→③finalized+cleanup，D-022（collectPatch 失败跳过 cleanup）明确标注
- ✅ NFR④ 回灌契约字段：recordId 白名单（§3 WorktreeManager.create 标了）/ fork 路径日志（§3 session-runner 标了）/ fork 继承敏感数据（§3 subagent-tool 标了）三项骨架约束均体现
- ✅ 每 issue 方法覆盖：§3 覆盖 #1-#13 全部核心方法（types/execution-record/record-store/SCR/WorktreeManager/finalized-marker/alive-store/session-runner/subagent-service/subagent-tool/index/session-file-gc）
- ✅ 时序图调用链闭合：§4 每 UC 时序图箭头在 §3 签名表有定义
- ✅ 接线层级标注：§3 每方法标了 [模块内]/[跨模块]/[adapter 真引SDK]

## 收敛判定
**CONVERGED=false**（3 个 K-gap，均为透传字段声明缺失，非设计矛盾）。回 Step 3 修订后本帧即收敛。
