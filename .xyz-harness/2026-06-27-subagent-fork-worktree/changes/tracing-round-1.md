---
phase: issues
role: A-coverage-reconstructor
---

# 追踪 Round 1 — 覆盖重建 diff（角色 A）

> 方法：先完整读 ② system-architecture.md 建 T_recon（防锚定），再读 issues.md 的「上游覆盖核验」表逐行 diff。已确认的决策（D-001~D-021）不当 gap。D-021 已把 §5「跨实例 crashed 误判」从「本轮不处理」反哺为「本轮纳入」——据此判定 #12 锚定合法。

## T_recon（独立重建覆盖表）

| 上游元素 | 轴 | 该对应什么 issue |
|---|---|---|
| §5 running→done（finalizeRecord 成功）| 状态 | #7 |
| §5 running→failed（finalizeRecord 失败）| 状态 | #7 |
| §5 running→cancelled（cancelBackground CAS 抢锁）| 状态 | #7 |
| §5 running→crashed（启动期重建检测无标记）| 状态 | #2（+ #12 四分支扩展）|
| §5 crashed 不经 tryTransition（重建推断态）| 状态 | #2 |
| §5 STATUS_PRIORITY + crashed（0/1/1/2/3）| 状态 | #2 |
| §5 crashed 三分支 + markReconstructedStatus（M3）| 状态 | #2（+ #12 扩四分支）|
| §5 已知盲区—跨 pi 实例 crashed 误判（D-021 反哺）| 状态 | #12 |
| §7 新增 SessionContextResolver（纯函数）| 模块 | #3 |
| §7 新增 WorktreeManager.create（含 node_modules 软链/setupHook/嵌套检测）| 模块 | #4 |
| §7 新增 WorktreeManager.cleanup（remove --force + branch -D 配对）| 模块 | #4 |
| §7 新增 WorktreeManager.scan（reaper 扫 pi-sub-* 孤儿）| 模块 | #4 |
| §7 新增 WorktreeManager.collectPatch（D-020 合并）| 模块 | #4 |
| §7 新增 WorktreeManager 私有 gitRun helper（D-019）| 模块 | #4 |
| §7 新增 FinalizedMarker（write/read）| 模块 | #5 |
| §7 修改 session-runner（fork 分流 + cwd 拆分 + createBranchedSession 优先）| 模块 | #6 |
| §7 修改 execution-record（crashed + markReconstructedStatus M3）| 模块 | #2 |
| §7 修改 record-store（STATUS_PRIORITY + 三分支）| 模块 | #2 |
| §7 修改 session-reconstructor（crashed 判定上移）| 模块 | #2 |
| §7 修改 session-file-gc（清理 .finalized）| 模块 | #10 |
| §7 修改 subagent-service（集成 + D-017 时序 + cancel cleanup）| 模块 | #7 |
| §7 修改 index.ts（session_start 挂 reaper + 缓存主 session 路径）| 模块 | #9 |
| §7 修改 subagent-tool（schema 加 fork/worktree/cwd）| 模块 | #8 |
| §7 修改 types.ts（ExecutionStatus + SdkLike + SessionRunnerContext）| 模块 | #1 |
| §7 集成点表 execute/finalizeRecord/finalizeFailed/cancelBackground | 模块 | #7 |
| §7 降级 worktree 嵌套检测（.git 文件检查，OS-6）| 模块 | #4 |
| **§4 模型 SubagentIdentityData forkDepth 写入守卫（构造器内守卫 M4）+ agent-registry/identity 实体改动** | 模块 | **应归属（写侧无 issue 覆盖）** |
| §4 模型 ExecutionRecord crashed + M3 | 模块 | #2 |
| §4 模型 WorktreeHandle（新增 VO，path+branch+baseCommit 不可变）| 模块 | #4（归属模糊）|
| §4 降级 patch 内容不建模（git 原生 diff）| 模块 | #4 |
| §8 pi CLI（客户-供应商，forkFrom/createBranchedSession/createAgentSession）| 边界 | #6（+#1 类型声明）|
| §8 git（遵奉者；②§8 表写「经 GitPort」但 D-019 已删 → 实为 gitRun helper）| 边界 | #4 |
| §8 ExtensionContext.sessionManager.getSessionFile() | 边界 | #9 |
| §10 D-014 SCR 纯函数化 | 挑战 | #3, #6 |
| §10 D-015 删 keepBranch | 挑战 | #4 |
| §10 crashed 不经 tryTransition 特化 | 挑战 | #2 |
| §10 D-017 三件套独立 try/catch + diff 先行 | 挑战 | #7 |
| §10 GAP-E5 cleanup 挂 finalizeRecord 内 | 挑战 | #7 |
| §9 泳道 fork+worktree 组合执行 | 兜底 | #6, #7 |
| §9 泳道 崩溃恢复（启动期检测）| 兜底 | #2, #9 |
| §11 AC-1~AC-11 | 兜底 | 对应 #1~#10 |
| §12 BC-1~BC-8 | 兜底 | #7/#11/#6/#2 |

## Diff 结果

### MISSING（漏项）

- **§4 SubagentIdentityData forkDepth 写入守卫（构造器内守卫 M4）+ agent-registry/identity 实体改动** — ②§4 声明 SubagentIdentityData「forkDepth 写入时校验 ≤10（构造器内守卫，M4）」，是实体模块的写侧改动。但：(a) §7 修改模块表未列 agent-registry/identity 实体；(b) issues.md 无任何 issue 的 AC 覆盖「写 forkDepth 字段」或「M4 构造器守卫」。#3（SCR，纯函数）只能做读侧预校验（AC-3.5），无法拥有实体写侧守卫。写侧全链路无 AC。**[K]** 主 agent 把「读 parent depth+1」当整个不变式，未识别 §4 把校验显式放在写侧构造器（M4，与已覆盖的 M3 对称）。

### PHANTOM（脱锚）

无。#1~#12 均能在 ② 查到根（#12 锚定 §5 已知盲区，D-021 反转处置合法）。

### MISMATCH（虚覆盖）

- **§4 SubagentIdentityData forkDepth 校验 ↔ #3** — 兜底表标 ✅「SCR 读 parent identity depth+1」，但 §4 不变式是写侧构造器守卫（M4），#3 纯函数只能读侧预校验，无法拥有实体写侧守卫。只覆盖读侧、写侧空缺。**[K]**（与 MISSING 同源，读/写两侧混淆）

- **§7 WorktreeManager.create 的 node_modules 软链 + setupHook ↔ #4** — 标 ✅ 但 #4 的 9 条 AC 无一验证 node_modules 软链或 setupHook（§7 create 明文子行为）。AC 偏重「不存在」负向证明，漏 create 的正向功能契约。开发者可过全部 AC 却不实现软链，monorepo worktree subagent 即坏。**[K]**

- **§4 WorktreeHandle（新增 VO）↔ #4/#1** — §4 升格为核心模型（与 M3/M4 同级）但类型定义归属 + 不可变不变式在 #1/#4 之间模糊，无显式 AC。**[K]**（低置信，TS readonly 可保证）

## 结论

gap 总数：4（MISSING 1 + PHANTOM 0 + MISMATCH 3）。全部 K（知识盲区），无 F/D。不阻断但建议处理 2 条：forkDepth 写侧守卫 + WorktreeManager.create 正向 AC。

**附带观察（② 自身陈旧，非 issues.md gap）**：②§8 边界表 L246 仍写 git「经 GitPort」与 D-019 矛盾（② 内部不一致，主 agent 覆盖表已正确按 D-019）；②§7 新增模块表未含 alive-store.ts（D-021 文档漂移）。

---
phase: issues
role: B-anomaly-hunter
---

# 追踪 Round 1 — 异常猎杀（角色 B）

> 失败帧。假设 issues.md 是错且不全。逐 issue 找未覆盖的「会坏」面。已确认决策（D-001~D-021）不当 gap 重报。

## 未处理清单

| # | issue/元素 | 未覆盖面 | 类型 | 说明 |
|----|-----------|---------|------|------|
| B1 | #6 fork 分流 | 并发时序：fork 读源 session.jsonl 时主 agent 正在 compaction 写入（脏读/撕裂读）| K | decisions.md 开放问题第 4 条明确列「fork 与 compaction 写入交错 → 原子快照或只取 compaction 后路径」，但 issues.md #6/#3 全文无任何 AC 或方案处理此竞态。createBranchedSession(leafId)/forkFrom 都需读源文件，主 agent compaction（SDK event 已证实存在）正改写同一文件时读到半写状态 → 子 agent 继承损坏/截断历史。长会话必发生 compaction，非边缘。issues.md 当它不存在。 |
| **B2** | **#7 finalizeRecord D-017 时序** | **状态机死角：collectPatch 失败降级后 cleanup 仍删 worktree = 改动永久丢失** | **F** | AC-7.4 说 collectPatch 失败 → result 不含 patch，completeRecord+archive 仍执行。但 §7 集成点表③ cleanup（remove --force + branch -D）紧跟 finalizeRecord。顺序 = collectPatch 失败降级 → archive → cleanup 删 worktree = patch 没生成 + worktree 被删 + 分支 -D = 改动彻底丢失且不可恢复。与「subagent 结果优先」自相矛盾（patch 是 worktree subagent 的核心交付物）。**数据丢失黑洞，阻断。** |
| B3 | #12 alive-store 四分支 | 并发时序：writeAliveMarker/removeAliveMarker 竞态 + GC 误清活 .alive | K | #6 写入点 prompt 前、#7 删除点 finalize 收尾，窗口=整个运行期。实例 A GC（#10）按 TTL 清 .alive——若误清活 record 的 .alive（mtime 老化）→ 实例 A 下次 reconstructAll 读不到 .alive → 误判 crashed。AC-12.6 只验 grep 命中，无 AC 验「不误清活 record 的 .alive」。 |
| B4 | #12 isProcessAlive(pid) | 异常路径：process.kill(pid,0) Windows 跨平台语义 + pid≤0 边界 | F | AC-12.3 写 ESRCH/EPERM。但 Windows process.kill 语义不同；pid≤0（系统进程/进程组）语义危险。pi 跨平台（darwin/linux/win），#12 把 POSIX errno 当普适。无 AC 约束 pid 边界（pid≤0 拒绝）。 |
| B5 | #4 WorktreeManager.create | 边界值：无 node_modules 仓库（非 monorepo）的软链行为 + setupHook 无 AC | K | 与角色 A MISMATCH #2 同源。AC-4.1~4.9 全漏 create 正向功能。 |
| B6 | #4 collectPatch git diff | 边界值：空 patch（subagent 只读）+ 二进制文件改动（git diff 输出 "Binary files differ" 非 unified diff）| K | AC-4.3 验 git diff 产出 patch 文本。但空 patch → 主 agent git apply 空文件行为未定义；二进制 → git apply 失败。§4 降级说「git 原生 unified diff 文本」未覆盖空/二进制边界。 |
| **B7** | **#2/#12 四分支 + __external** | **状态机死角：__external 不在 ExecutionStatus 联合类型** | **F** | AC-12.5 说「__external 只读」。但 STATUS_PRIORITY/ExecutionStatus 只 running/done/failed/cancelled/crashed——__external 非成员。SubagentRecord.status 类型 ExecutionStatus 塞 "__external" 是类型谎言。list-view/format 对未知 status 无 default 兜底 → TUI 显示破损。#1 加 crashed 但没加 __external。**类型契约裂缝，阻断。** |
| **B8** | **#9 index.ts reaper scan** | **并发时序：scan 清孤儿 worktree 与实例 B 跨实例不可见内存 running record 的竞态 → 删活 worktree** | **F** | AC-9.1 验 session_start 含 scan。但 scan 扫 pi-sub-* 孤儿清理——「孤儿」判据未定义。若判据是「无对应 running record」——实例 A 内存 running record 实例 B 看不到（S1 盲区）→ 实例 B scan 把实例 A 正在跑的 worktree 当孤儿清掉 → 子 agent 工作目录被 rm -rf → 子 agent 崩溃 + 改动全丢。比 crashed 误判（只读错）严重一个量级（删数据）。**最危险破坏性竞态，阻断。** |
| B9 | #7 removeAliveMarker 与 finalize 成对 | 异常路径：completeRecord/archive 抛错逃逸 detached .catch → ③ 全跳过 → .alive 残留 + 无 .finalized → 误判 crashed | F | D-017 只包三件套 try/catch，completeRecord(①)/archive(②) 非三件套。若它们抛错 → 逃逸 → ③ FinalizedMarker.write + cleanup + removeAliveMarker 全跳过 → record 卡 running + 无 .finalized + 残留 .alive → 下次判 crashed。#7 无 AC 覆盖 completeRecord/archive 自身抛错路径。 |
| B10 | #1 types.ts SdkLike 返回 unknown | 边界值：createBranchedSession 返回 unknown，session-runner 传给 createAgentSession 类型契约为零 | K | AC-1.4 说「非裸 any 强转」。但返回 unknown，session-runner 拿 unknown 传 createAgentSession——要么强转（违反 AC-1.4）要么断言。类型契约半开。 |
| B11 | #2 crashed reason 不区分来源 | 边界值：crashed reason 固定字符串，但四分支「都无→pid 死」与「真崩溃」共享同一 reason | F | AC-2.4 验 reason 固定。但 #12 四分支：pid 死/无 .alive→crashed。两种 crashed 来源（kill -9 vs pid 复用 24h 超时）共享 reason。debug 无法区分。 |
| B12 | #6 createBranchedSession 降级 | 异常路径：「不可用」降级判定标准（抛错 vs undefined vs 方法不存在）未定 | K | AC-6.3 验降级 forkFrom。但「不可用」指抛错？返回 falsy？方法不存在？三种需三种检测。降级逻辑写错→永远降级（体积爆炸）或永不降级（坏了一直崩）。 |

## 删除测试结论（伪 issue 猎杀）

| issue | 删除测试 | 判定 |
|-------|---------|------|
| #1 types.ts | 不加 crashed → 编译失败 | 真 issue（P0 站得住）|
| #2 状态机三分支 | 不做 → kill-9 会话重建显示 done（BC-7 现状 bug）| 真 issue（修复现状错误）|
| #3 SessionContextResolver | 不做 → fork 解析散落 | 真 issue（架构支点）|
| #4 WorktreeManager | 不做 → 无 worktree 隔离（G2 落空）| 真 issue（G2 承重）|
| #5 FinalizedMarker | 不做 → crashed 检测无对照标记 | 真 issue |
| #6 session-runner fork 分流 | 不做 → fork 不工作（G1 落空）| 真 issue |
| #7 SubagentService 集成 | 不做 → 端到端不通 | 真 issue（汇合点）|
| #8 subagent-tool schema | 不做 → 用户无法传参 | 真 issue（P2 合理）|
| #9 index.ts reaper | 不做 → 崩溃残留 worktree 不清（UC-5）| 真 issue，**但孤儿判据高危（B8）** |
| #10 session-file-gc .finalized | 不做 → 文件残留（卫生）| 边缘真 issue（P2 合理）|
| #11 ADR-001 修订 | 不做 → 文档与代码不一致 | 伪 issue 倾向（纯文档，删了不影响运行时；保留为防维护者误读，降级为文档 follow-up）|
| #12 跨实例 pid 探活 | 不做 → 双实例并发误判 crashed（D-021）| 真 issue（D-021 拍板），**但依赖链最重 + 新竞态面（B3/B4/B7）**，风险最高 |

**无纯伪 issue**（删了零影响）。#11 最接近伪，保留为文档 follow-up。所有 issue 至少一个承重理由。

## 结论

**gap 总数：16（角色 A 4 + 角色 B 12）**
- F（factual，源码/文档硬证矛盾）：6（A 无；B2, B4, B7, B8, B9, B11）
- K（knowledge，未覆盖盲区）：10（A MISSING/MISMATCH×3；B1, B3, B5, B6, B10, B12）
- D（决策分歧）：0（无已确认决策被新证据推翻；不标 REVISIT）

**阻断判定：阻断**
- **B2**（collectPatch 失败 + cleanup 删 worktree = 数据丢失黑洞）— #7 方案 A best-effort 降级通向不可恢复数据销毁，与「结果优先」自相矛盾。
- **B8**（reaper scan 跨实例删活 worktree）— 最危险破坏性竞态，#9 无孤儿判据 AC，双实例场景删实例 A 活工作目录。
- **B7**（__external 不在 ExecutionStatus 联合类型）— 类型契约裂缝，消费方 switch 缺分支，TUI 显示破损。

B2/B8/B7 须在 #7/#9/#1/#12 方案或 AC 补齐前不得 converged。B1（compaction 竞态）在 decisions.md 列出但 issues.md 零覆盖，按覆盖核验纪律应阻断或显式标延后+理由。
