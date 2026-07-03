---
phase: issues
adversary_round: 2
frame: impl-feasibility
verdict: BLOCKING
---
# 对抗审查 R2 — 实现可行性

> 站在「真正要去写这段代码的工程师」立场，用真实源码戳方案是否真能落地。
> 审查 agent 只读，本报告由主 agent 据其返回内容落盘。关键发现已主 agent 复核（F-1 经 pi 仓库 session-manager.ts:1286-1341 确认）。

## 发现（逐条，附源码证据）

| # | issue | 实现可行性问题 | 严重度 | 证据 |
|---|-------|--------------|--------|------|
| F-1 | #6 | **createBranchedSession 被错误建模为静态/构造函数**——它是 `SessionManager` 的**实例方法**，返回 `string\|undefined`（新 session 文件**路径**）而非 SessionManager；且**原地 mutate** this.sessionId/sessionFile/fileEntries。issues.md #6 AC-6.1/6.3/6.4/6.10 基于错误返回类型/调度模型写——工程师照字面写 `sdk.SessionManager.createBranchedSession(leafId)`（静态）会 TS 编译失败。正确链路：`SessionManager.open(mainSessionFile, sessionDir)` → 实例 `.createBranchedSession(leafId)` → 把**同一 mutate 后的实例**传 createAgentSession。 | **BLOCKING** | pi session-manager.ts:1286-1341（实例方法 + 返回 string\|undefined + mutate this.sessionId/sessionFile/fileEntries L1338-1341）|
| F-2 | #6/#9 | **mainSessionFile 线程缺失**：fork 需 `SessionManager.open(mainSessionFile)` 加载主 session 条目，但当前 `buildSessionRunnerContext`（subagent-service.ts:486-498）返回 `cwd: this.cwd` 无 mainSessionFile。#9/AC-9.2 说缓存 getSessionFile() 但未明确 #6 依赖 #9 先把 mainSessionFile 接入 SessionRunnerContext。跨文件连锁未列 #6「修改」清单。 | **MAJOR** | subagent-service.ts:486-498（无 mainSessionFile 字段）；index.ts:62-85（只缓存 getSessionId 非 getSessionFile）|
| F-3 | #4 | **~280 LOC 严重低估**：node_modules 软链 + setupHook 参考第三方 pi-subagents/worktree.ts:177-188,270-313（~140 LOC 仅软链+钩子）。对照 record-store（242 LOC，最近模拟器）、tombstone-store（72 LOC，单一职责）。加 clean 校验/嵌套检测/scan+D-024 活性守卫/collectPatch，诚实估算 ~400-500 LOC。 | MAJOR | 第三方 worktree.ts LOC 对照 |
| F-4 | #2 | **STATUS_PRIORITY 缺 crashed key = 第一次编辑即编译失败**：record-store.ts:29-34 是 `Record<ExecutionStatus, number>` 4 key，#1 加 crashed 后该 Record 类型要求全 key 在——#2 必须**同一次编辑**补 crashed key（AC-2.1 grep "crashed" 命中不足以证明 key 补齐）。且 reconstructAll（record-store.ts:169-214，~45 行）在 #2→#12 间被触及两次。 | MAJOR | record-store.ts:29-34, 169-214 |
| F-5 | #12 | alive-store ~40 LOC 合理，但 D-021 连锁真实成本跨 8 issue + 4 决策 + 3 阻断（scope-note 已记）。process.kill(pid,0) ESRCH/EPERM + 24h 软超时逻辑另加 ~25 LOC 未计入。 | MINOR | tombstone-store 72 LOC 对照 |
| F-6 | #1 | **SdkLike.createBranchedSession 声明位置错误**：forkFrom 是静态（types.ts:526-529 已有静态块），createBranchedSession 是**实例方法**应进 AgentSessionLike.sessionManager 实例端鸭子类型（appendCustomEntry types.ts:486-491 是实例端先例）。AC-1.1/1.4「SdkLike.SessionManager 声明」会误导工程师加错接口。 | MINOR | types.ts:486-491（实例端）vs 526-529（静态端）；session-manager.ts:1286（实例方法）|
| F-7 | #8 | **参数线程化 0 LOC 估算 + AC 只验 schema**：fork/worktree/cwd 要穿 startHandler→service.execute→buildSessionRunnerContext→SessionRunnerContext→resolveSessionContext（4 文件）。AC-8.1 只 grep schema 含字段，不验参数流。 | MINOR | subagent-actions.ts:142-165；types.ts:283-309 |

## 已验证为真（issues.md 这些方面准确）
- `createAgentSession({sessionManager})` 自动 restore 历史（sdk.ts:178,187-189）✅
- `forkFrom(sourcePath, targetCwd, sessionDir?)` 是静态（session-manager.ts:1434）全量复制 ✅
- SessionManager.create/open/forkFrom/getSessionFile/getSessionId 均存在（session-manager.ts:1385,1396,1434,904,888）✅
- `ctx.sessionManager.getSessionFile()` 可用（index.ts:77,84 已用 getSessionId）✅
- tombstone-store 范式是 finalized-marker/alive-store 真实模板 ✅
- STATUS_PRIORITY + tryTransition CAS 模型（execution-record.ts:491-498）✅

## 阻断判定
**BLOCKING #6**（唯一 fork 实现入口，AC 模型错误的 API 返回类型/调度结构）。F-1/F-2 必须解决：重写 #6 AC 反映 `SessionManager.open(mainSessionFile)` → 实例 `.createBranchedSession(leafId)` → 传 mutate 后实例给 createAgentSession；mainSessionFile 线程化明确列入 #6/#9 修改项。非阻断需修 LOC/scope：#4 (~280→~450)、#2 STATUS_PRIORITY key、#8 参数线程。
