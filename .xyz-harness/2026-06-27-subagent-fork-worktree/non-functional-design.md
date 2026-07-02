---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
backfed_from: []
---

# 非功能性设计 — subagent fork 上下文 + worktree 隔离

> 评估 issues.md 13 个 issue 已决策方案对系统的副作用，并设计缓解。
> 7 维度（详见 nfr-dimensions.md）：系统安全 / 业务数据安全 / 性能 / 并发控制 / 稳定性·高可用 / 兼容性 / 可观测性。
> 取舍原则（继承 requirements.md）：优先长期、合理的架构设计，提供高可扩展性，较少考虑成本。
> 决策约束来自 decisions.md D-001~D-026（D-不可逆：D-001/002/003/004/005/006/009/014）。

## 分析矩阵

> 图例：✅ 无风险 / ⚠️ 有风险已缓解 / 不可接受（需回退，本轮无此项）/ — 不适用+理由
> 写量规则：✅ 维度只写一行理由；⚠️ 维度按 nfr-dimensions.md 4 字段模板展开。

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|------|------|------|------|--------|--------|--------|
| #1 types.ts 扩展 | A 增量 | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #2 状态机基础 | A markReconstructed | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| #3 SessionContextResolver | A 纯函数 | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #4 WorktreeManager | A 单类 gitRun | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | — | ⚠️ |
| #5 FinalizedMarker | A 独立类 | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #6 session-runner 分流 | A 内分流 | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| #7 SubagentService 集成 | A 三件套 try/catch | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| #8 subagent-tool schema | A 三参数 | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #9 index.ts reaper | A session_start 挂 | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ | ✅ |
| #10 session-file-gc | A 增 glob | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| #11 ADR-001 修订 | A 修订 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #12 跨实例 crashed 协调 | A pid 探活 | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| #13 alive-store | A 独立模块 | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ |

**矩阵观察**：13 issue 全部为 ✅ 或 ⚠️（无可接受性问题）——所有 ⚠️ 均有缓解方案或标记残余风险。高密度风险集中在 #4 WorktreeManager（外部 git 副作用 + 数据安全）与 #7 SubagentService 集成（时序 + 故障处理），符合"最重新模块 + 汇合点"预期。

---

## 详细分析

### Issue #1: types.ts 基础类型扩展 — 方案 A 增量扩展

#### ⚠️ 安全
**风险**: forkFrom/createBranchedSession 声明到 SdkLike（types.ts:526-529）扩大了类型契约面，若声明为 `any` 会让恶意/错误调用绕过类型检查。
**影响范围**: SdkLike.SessionManager 接口（被 session-runner 持有 ctx.sdk 消费）。
**缓解方案**: D-016 已定沿用鸭子类型约定——声明返回 `unknown`（非 any），session-runner 侧收窄（AC-1.6 shape check，非裸 any 强转）。SubagentRecord.externalInstance 是投影标志（boolean），无注入面。
**残余风险**: 无。返回 unknown 强制消费方收窄，类型契约收紧而非放宽。

#### ⚠️ 数据
**事务边界**: types.ts 是纯类型声明，无运行时数据操作。
**并发场景**: 无（编译期产物）。
**迁移方案**: ExecutionStatus 加 crashed 是联合类型扩展（新增成员），消费方 switch 须补 crashed 分支——STATUS_PRIORITY（#2）须同次补 key 否则 Record<ExecutionStatus> 编译失败（AC-2.1 结构化断言）。
**回滚策略**: 类型回滚=git revert，无数据迁移。
**残余风险**: 无。同次编辑补 key 约束（AC-2.1）防漏。

#### ✅ 性能
纯类型声明，编译期消除，零运行时开销。

#### ✅ 并发
类型层无并发面。

#### ✅ 稳定性
类型扩展不破坏现有运行时（crashed 是新增非替换）。

#### ⚠️ 兼容性
**API 变更**: ExecutionStatus 联合类型新增成员 crashed 是 **breaking change**（消费方 switch 缺分支 → 编译失败）。
**数据兼容**: 无（无存量数据带 crashed，旧 session.jsonl 无此 status）。
**客户端影响**: 仓库内所有 ExecutionStatus 消费方（list-view/format/STATUS_PRIORITY）须补 crashed 分支。
**灰度/回滚**: 编译期强制全仓同步——不兼容灰度（要么全改要么编译失败），这是优势（防遗漏）。
**残余风险**: 无。编译器强制同步。

#### ✅ 可观测性
crashed 终态本身是可观测性增强（D-006 目标），types.ts 声明是其基础。

---

### Issue #2: 状态机基础 — 方案 A markReconstructedStatus 收口

#### ✅ 安全
状态机收口（markReconstructedStatus 不裸赋值）是安全增强，无注入面。

#### ⚠️ 数据
**事务边界**: reconstructAll 三分支检测（.cancelled/.finalized/都无）涉及 2 次磁盘读（tombstone + finalized），非原子。
**并发场景**: 重建期 sidecar 文件被并发写（实例 A 正在 finalize 写 .finalized，实例 B 正在 reconstructAll 读）→ B 可能读到 finalizing 中间态。但 finalized 是 best-effort writeFileSync（单次写），读到=完整或读到无，无撕裂。
**迁移方案**: 现有 session.jsonl 重建显示 done（误判 kill-9），本次三分支重分类为 crashed（BC-7 变更）。存量 session 无 .finalized 标记 → 全部重分类为 crashed（首次启动后）。这是预期行为（BC-7）。
**回滚策略**: 回滚=恢复旧 reconstructAll，但 crashed 终态已在 #1 类型层，无法局部回滚。
**残余风险**: 三分支检测的「都无→crashed」在跨实例场景误判（实例 A 活态无标记）→ 由 #12（D-021 pid 探活）解决，#2 先实现基础三分支。

#### ✅ 性能
reconstructAll 已是启动期单次遍历，加 2 次 sidecar 读（readCancelledTombstone + readFinalized）增量小（文件小、best-effort）。

#### ⚠️ 并发
**竞态场景**: crashed 是重建推断态，不经 tryTransition（特化决策）——这是对的（进程已死无内存 record 竞争）。但 markReconstructedStatus 收口若被运行期路径误调，会绕过 CAS。M3 约束：markReconstructedStatus 仅重建专用，静态规则禁 record-store 外 `.status=` 裸赋值（AC-2.2/2.3）。
**幂等策略**: reconstructAll 幂等（重复扫描结果一致，sidecar 读取确定性）。
**锁策略**: 无锁（重建是只读推断 + 单点写 status 经收口方法）。
**分布式考虑**: 跨实例重建由 #12 处理（pid 探活），#2 基础三分支假设单实例。
**残余风险**: 无（markReconstructedStatus 收口 + 静态规则守卫）。

#### ✅ 稳定性
三分支检测是崩溃恢复的基础（D-006 目标），增强稳定性。

#### ⚠️ 兼容性
**API 变更**: STATUS_PRIORITY 加 crashed key 是 **编译期 breaking change**（`Record<ExecutionStatus, number>` 强制全 key，缺 crashed 编译失败）——但这恰是编译器防遗漏的优势（强制全仓同步补 key，AC-2.1 结构化断言守卫）。
**数据兼容**: 无（无存量数据带 crashed，旧 session.jsonl 无此 status）。
**客户端影响**: 仓库内所有 ExecutionStatus 消费方（list-view/format/STATUS_PRIORITY）须补 crashed 分支。
**灰度/回滚**: 编译期强制全仓同步——不兼容灰度（要么全改要么编译失败），这是优势（防遗漏）。
**残余风险**: 无。编译器强制同步。

#### ⚠️ 可观测性
**日志**: crashed reason 固定 "process killed (no finalized marker)"（§5 Reason 表）——建议 reconstructAll 对每个 crashed 记结构化日志（session id + 推断路径），便于排查。
**指标**: 建议加 crashed 计数指标（崩溃率 = crashed/total）。
**追踪**: 无跨服务链。
**告警**: crashed 是单 subagent 故障非系统级，不告警（reaper 清孤儿）。
**审计**: crashed 是重建推断，审计价值低（非用户操作）。
**缓解**: crashed reason 日志 + 计数指标 → 回灌运维项/⑤契约。

---

### Issue #3: SessionContextResolver — 方案 A 纯函数

#### ⚠️ 安全
**风险**: SessionContextResolver 解析 fork 意图（含 mainSessionFile 路径），若 mainSessionFile 来自不可信输入可路径遍历。
**影响范围**: resolveSessionContext 入参 {fork, worktree, cwd, mainCwd, mainSessionFile}。
**缓解方案**: mainSessionFile 来自 ctx.sessionManager.getSessionFile()（#9 缓存，pi SDK 内部产出，非用户输入）。forkSource 是 SDK 路径非用户可控。AC-3.3/3.4 grep 验零副作用（不调 execFileSync/spawn）。深度校验 ≤10（D-007）防资源耗尽。
**残余风险**: 无。输入源是 SDK 受控路径。**注**：effectiveCwd（含用户可控 cwd）仅作只读参数传 createAgentSession（非用于构建文件系统路径），sessionDir 用 mainCwd 编码（AC-3.6），故 cwd 路径遍历无文件系统影响。

#### ✅ 数据
纯函数零 IO（D-014），不碰数据。

#### ✅ 性能
纯函数，无 IO，纳秒级。

#### ✅ 并发
纯函数无共享状态，天然线程安全。

#### ✅ 稳定性
纯函数无外部依赖，永不抛（除输入校验，如 depth>10 拒绝）。

#### ✅ 兼容性
新模块，无旧消费方。返回纯数据意图，session-runner 消费。

#### ✅ 可观测性
纯函数，可观测性由消费方（session-runner）承载。

---

### Issue #4: WorktreeManager — 方案 A 单类 + 私有 gitRun

#### ⚠️ 安全
**风险**: gitRun helper 用 execFileSync("git", args, options) 直接调 git CLI（options 含 cwd 字段），args 若含用户输入可命令注入（git 参数注入）。
**影响范围**: create（branch 名 pi-sub-<recordId>）/ collectPatch（baseCommit）/ cleanup（worktree path + branch）。
**缓解方案**: recordId 是系统生成（非用户输入）；baseCommit 来自 create 时的 git rev-parse（受控）；branch 名 `pi-sub-<recordId>` 带系统生成 id。execFileSync（非 shell=true）本身防 shell 注入，args 数组传参。但须确保 recordId 不含 shell 元字符（建议正则白名单 `^[\w-]+$`）。嵌套检测（.git 文件检查）防路径逃逸。
**残余风险**: recordId 生成若可预测+含特殊字符 → 低风险（recordId 是内部 id），建议加白名单校验（回灌⑤契约 + 建议补③issue AC-4.14「create 含非法字符 recordId → 抛错拒绝」，见缓解项回灌登记）。

#### reaper worktree→session 映射可行性（D-024 落地前提）

D-024 孤儿判据「worktree 关联 session 有终态标记」需映射链：`git worktree list` 返回的 branch 名 `pi-sub-<recordId>` → 解析 recordId → 在 sessionsDir 定位 `<recordId>.jsonl` → 读 `.cancelled`/`.finalized` sidecar。**注**：crashed 不是 sidecar 文件（crashed 是重建推断态，无对应磁盘标记），孤儿判据准确表述为「record 已达终态（有 .cancelled / 有 .finalized / 或重建判定 crashed）且无活 .alive」。此映射链可行性依赖 recordId↔sessionFile 命名约定稳定（sessionsDir 由 mainCwd 编码，record.id==sessionId），回灌⑤骨架验证 scan stub 映射链。

#### ⚠️ 数据
**事务边界**: worktree 生命周期（create→运行→collectPatch→cleanup）跨多次 git 调用，非原子。**D-022 关键**：collectPatch 失败时 cleanup 必须跳过（保留 worktree+分支），否则 patch 未生成+worktree 删除+branch -D = 改动彻底丢失（数据黑洞）。
**并发场景**: 并发 2 个 worktree subagent → branch/path 名带 recordId+timestamp 保证唯一（AC-2.3）。git worktree add 本身原子（git 保证）。
**迁移方案**: 无存量 worktree 数据（新功能）。
**回滚策略**: worktree 失败回退主 cwd 或 fail hard（UC-2 异常）。cleanup 失败→孤儿留 reaper（#9）。
**残余风险**: collectPatch 部分成功（diff 出错但 patch 已部分写）→ best-effort 写空 patch+警告（UC-4 异常），改动可能丢失——这是 UC-4 已接受的降级。

#### ⚠️ 性能
**预期负载**: git worktree add 是磁盘密集（copy working tree），大 repo（node_modules 除外）耗时 O(repo 大小)。
**关键路径延迟**: create 阻塞 subagent 启动 → P99 取决于 repo 大小。node_modules 软链避免全量复制（D-002 参考第三方 ~140 LOC 实现）。
**扩展性瓶颈**: 大 repo（>1GB working tree）create 慢；LFS repo 全量 checkout。OS-8 已排除 sparse checkout。
**优化方案**: node_modules 软链（已有）+ setupHook（.env 等 gitignore）。worktree 复用（同 branch 多次）未做（YAGNI）。
**残余风险**: 大 repo create 延迟 → 标记需⑤骨架验证（node_modules 软链是否生效）。

#### ⚠️ 并发
**竞态场景**: D-024（B8）跨实例 reaper scan 误删实例 A 活 worktree——reaper 看不到 A 内存 running record，误判孤儿。**这是最危险破坏性竞态（删数据）**。
**幂等策略**: cleanup 幂等（worktree 已删则 git 报错被 try/catch 吞）。
**锁策略**: 无跨实例锁（D-004 共享目录架构）。靠 .alive sidecar 作活证据（#13）。
**分布式考虑**: 多 pi 实例共享 session 目录（D-004）→ reaper scan 孤儿判据 = 终态标记 且无活 .alive（D-024），绝不删活 .alive 的 worktree（AC-4.4 故障注入测试）。
**残余风险**: pid 复用（A 死后 pid 被 B 复用，.alive 的 pid 探活返回活）→ 靠 startedAt+24h 软超时兜底（#12，概率正确非确定）。

#### ⚠️ 稳定性
**故障场景**: git CLI 不可用（未装/PATH 丢失）→ 所有 worktree 操作失败。
**降级方案**: worktree:true 时 git 不可用 → fail hard（报错）或降级主 cwd（UC-2 异常，D-待定报错优先）。非 worktree 不受影响。
**熔断/限流**: 无（worktree 操作非高频）。
**重试策略**: git worktree add 失败不重试（一次性，回退或 fail hard）。
**SLA 影响**: worktree 隔离是可选增强，降级不影响核心 subagent 能力。
**残余风险**: git 偶发失败（磁盘满/权限）→ fail hard 或孤儿留 reaper，可接受。

#### — 兼容性（不适用）
WorktreeManager 是全新模块（D-002），无旧消费方。POSIX-only（OS-7 首版排除 Windows）——写降级理由：跨平台兼容由 OS-7 排除，首版 POSIX-only。

#### ⚠️ 可观测性
**日志**: create/cleanup/scan/collectPatch 各自记结构化日志（recordId + worktree path + git 命令 + 耗时 + 成功/失败）。
**指标**: 建议 worktree create/cleanup 成功率 + 耗时分布 + 孤儿清扫计数。
**追踪**: 无跨服务链。
**告警**: cleanup 失败率高（>阈值）告警（孤儿累积信号）。
**审计**: 无（worktree 是临时资源，非持久数据）。
**缓解**: 结构化日志 + 成功率指标 → 回灌运维项。

---

### Issue #5: FinalizedMarker — 方案 A 独立类

#### ✅ 安全
sidecar 文件操作（writeFileSync/readFileSync）路径=sessionFile+".finalized"，sessionFile 是 SDK 受控路径，无注入面。

#### ⚠️ 数据
**事务边界**: D-017 时序下 .finalized 在 ③ 最后写（写时 record 已 completeRecord+archive，磁盘落终态）。**真窗口是 ①completeRecord+②archive 之后、③ writeFileSync 之前**——此时无 .finalized 但磁盘 record 已 done/failed。三分支检测（§5:118-129）在「都无」分支**恒判 crashed，不读 recon.status**，故此窗口内 record 被误判 crashed（应为 done/failed）。
**并发场景**: 实例 A 写 .finalized，实例 B readFinalized → B 可能读到 finalizing 中间态。但 writeFileSync 单次写，读到=完整或读到无。
**迁移方案**: 无存量 .finalized（新增），首次启动后所有旧 session 无标记→crashed（BC-7 预期）。
**回滚策略**: .finalized 是 best-effort，删除无影响（重建判 crashed）。
**残余风险**: ①②③ 之间的窗口极短（archive 与 writeFileSync 之间）+ 纯显示误差（record 磁盘完整，crashed 误判可接受）。**注**：原稿「UC-7 降级 recon stopReason」兜底对此窗口不成立——三分支不读 recon.status，recon 推导被丢弃，此窗口无兜底（接受 crashed 误判）。

#### ✅ 性能
单文件 readFileSync/writeFileSync，纳秒级，best-effort。

#### ✅ 并发
sidecar 读写在 reconstructAll 单线程遍历内，无并发写竞争（finalize 时 record 已终态）。

#### ✅ 稳定性
best-effort IO（错误静默），失败不影响重建（无 .finalized→crashed 是安全降级）。

#### ✅ 兼容性
新 sidecar 类型，GC（#10）对称清理。.cancelled/.finalized 互斥（BC-4）。

#### ✅ 可观测性
.finalized 存在性是 crashed 检测的可观测信号本身。

---

### Issue #6: session-runner fork 分流 — 方案 A createAndConfigureSession 内分流

#### ⚠️ 安全
**风险**: fork:true 时 createAgentSession 的 sessionManager 是 mutate 后的 forked 实例（createBranchedSession 原地改 sessionId/sessionFile/fileEntries），若 mutate 不完整会串台（子 agent 写到主 session）。
**影响范围**: createAndConfigureSession 的 sessionManager 传递。
**缓解方案**: AC-6.1 grep 验证传 createAgentSession 的是 createBranchedSession 返回的 mutate 后同一实例；AC-6.4 集成测试断言 session.messages 含主历史（证明 fork 生效非串台）。forkDepth≤10 守卫（M4）。
**残余风险**: 无。mutate 同一实例 + 集成测试断言。

#### ⚠️ 数据
**事务边界**: createBranchedSession 原地 mutate this.sessionId/sessionFile/fileEntries（session-manager.ts:1286-1341）——这是 pi SDK 行为，subagents 侧需确保 mutate 后实例不泄露给其他路径。
**并发场景**: fork 读主 session 时主 agent 正在 compaction → 交错（UC-1 异常）。createBranchedSession 取 compaction 后路径（D-018 体积控制），SDK 快照读。
**迁移方案**: 无。
**回滚策略**: createBranchedSession 抛错→降级 forkFrom（AC-6.3 故障注入）→ forkFrom 抛错→finalizeFailed。
**残余风险**: fork 与 compaction 交错 → AC-6.9 SDK 快照读 + 标注人审（压力测试可选）。

#### ⚠️ 性能
**预期负载**: fork 全量复制（forkFrom）O(source entries)，嵌套 fork 线性累积爆 token/磁盘。
**关键路径延迟**: createBranchedSession 优先（只取 leaf→root，体积更小，D-018）缓解。
**扩展性瓶颈**: 嵌套 fork 深度=10 时 token/磁盘压力。
**优化方案**: createBranchedSession 优先 + forkFrom 降级（D-018）+ depth≤10 守卫（D-007）。
**残余风险**: 10 层嵌套 fork 仍可能 token 压力 → depth 守卫硬截断（>10 拒绝）。

#### ✅ 并发
fork 分流在 createAndConfigureSession 单调用内，无并发竞争（每 subagent 独立 session）。**前提**：每次 fork 调用独立 `SessionManager.open()` 实例，createBranchedSession 的原地 mutate 不跨 subagent 共享实例（安全维度 AC-6.1/6.4 守卫）。

#### ⚠️ 稳定性
**故障场景**: createBranchedSession 不可用（pi 版本低/方法缺失）→ 降级 forkFrom（AC-6.3，两级降级：createBranched→forkFrom）。forkFrom 源损坏→抛错→finalizeFailed（UC-1 异常）。主 session 空→降级 from-scratch（UC-1 替代，属 fork 源不可用场景非降级链第三级）。
**降级方案**: 两级降级 createBranchedSession→forkFrom（issues.md #6 问题描述仅两级，AC-6.3 覆盖）；fork 源完全不可用→finalizeFailed 或 from-scratch（UC-1 替代流程，独立于降级链）。
**熔断/限流**: 无。
**重试策略**: 不重试（fork 失败=fail）。
**SLA 影响**: fork 失败降级为普通 subagent（仍可用）。
**残余风险**: 无（降级链完整）。

#### ⚠️ 兼容性
**API 变更**: SessionRunnerContext.cwd → effectiveCwd + mainCwd 是 breaking（消费方读 .cwd 须改）。mainSessionFile 新增字段（由 #9 接入）。
**数据兼容**: session header.cwd 语义不变（effectiveCwd），存储目录用 mainCwd（D-004）。
**客户端影响**: Runtime/Core 消费 SessionRunnerContext 的代码须同步改。
**灰度/回滚**: 编译期强制同步（typescript）。
**残余风险**: 无。

#### ⚠️ 可观测性
**日志**: fork 分流记录（shouldFork + 用了 createBranchedSession/forkFrom/from-scratch 哪条路径 + forkDepth）。
**指标**: fork 使用率 + 各路径占比 + depth 分布。
**追踪**: 无。
**告警**: depth 接近 10 告警（资源压力信号）。
**审计**: 无。
**缓解**: fork 路径日志 → 回灌⑤契约。

---

### Issue #7: SubagentService 集成 — 方案 A 三件套独立 try/catch

#### ✅ 安全
集成层无新注入面（参数来自 tool schema #8，类型校验过）。

#### ⚠️ 数据
**事务边界**: finalizeRecord 时序 ⓪collectPatch→①completeRecord→②archive→③finalized+cleanup（D-017）。**D-022 关键**：collectPatch 失败→cleanup 跳过保 worktree。archive 必须在副作用写之前（防 record 卡 running）——「副作用写」特指 ③（.finalized sidecar 写 + cleanup），不含 collectPatch 的 patch 文件写（patch 写是 ⓪，必须先于 completeRecord 以进 record.result）。
**并发场景**: cancelBackground 与 finalizeRecord 竞争（同 record）→ 现有 CAS（cancelBackground 抢锁）保护。worktreeHandle==null 守卫跳过非 worktree run。
**迁移方案**: 无。
**回滚策略**: completeRecord/archive 抛错→③finalized/cleanup 仍 best-effort（B9 修复，包外层兜底 try/catch），防 record 卡 running+无 .finalized→误判 crashed。
**残余风险**: 三件套都失败（极端）→ record 卡 running + 无 finalized → #2 重建判 crashed（安全降级）。

#### ⚠️ 性能
**预期负载**: collectPatch（git diff --cached）在 finalize 路径，阻塞 record 终态。
**关键路径延迟**: git diff 耗时取决于改动量，大改动 patch 生成慢。
**扩展性瓶颈**: 无（finalize 是单 subagent 收尾，非高频并发）。
**优化方案**: collectPatch best-effort（失败降级不阻断）。
**残余风险**: 大 patch 生成延迟 → best-effort 跳过可接受（patchFailed 记录）。

#### ⚠️ 并发
**竞态场景**: cancelBackground CAS 与 finalizeRecord 竞争 → 现有 tryTransition CAS 保护（BC-4 cancelled tombstone 优先，不写 finalized）。
**幂等策略**: finalizeRecord 幂等（record 终态后再次调用被 tryTransition 拒）。
**锁策略**: CAS 乐观锁（execution-record.ts:491 现有）。
**分布式考虑**: 跨实例由 #12 externalInstance 投影（不操作不标 crashed）。
**残余风险**: 无（CAS + 投影标志）。

#### ⚠️ 稳定性
**故障场景**: 三件套（collectPatch/finalized/cleanup）任一抛错 → 独立 try/catch 只记日志不阻断其他（D-017 best-effort）。
**降级方案**: collectPatch 失败→保 worktree + patchFailed 记录（D-022）；finalized 失败→重建时判 crashed（安全）；cleanup 失败→孤儿留 reaper（#9）。
**熔断/限流**: 无。
**重试策略**: 无重试（best-effort 单次）。
**SLA 影响**: finalize 三件套失败不阻断结果回传（AgentResult 已完成）。
**残余风险**: 无（D-017 + D-022 完整降级链）。

#### ✅ 兼容性
集成层沿用现有 sync/bg 入口（BC-1），fork/worktree 是前置/后置增强不改分叉。

#### ⚠️ 可观测性
**日志**: finalizeRecord 三件套各自成功/失败 + 耗时；patchFailed 记录 worktree 路径（供恢复）。
**指标**: finalize 成功率 + 各件失败率 + patchFailed 计数。
**追踪**: 无。
**告警**: patchFailed 或 cleanup 失败率高告警。
**审计**: 无。
**缓解**: 三件套日志 + 失败率指标 → 回灌运维项。

---

### Issue #8: subagent-tool schema — 方案 A 三参数

#### ⚠️ 安全
**风险**: fork:true 继承主 agent 全部上下文含敏感数据（API keys/secrets/对话历史），用户需显式 opt-in。worktree 非安全隔离（bash 可 cd 逃逸，D-008）。
**影响范围**: subagent-tool startParam schema + system prompt 文档。
**缓解方案**: AC-8.4（G5 修复 D-007）system prompt 明确「fork:true 继承全部上下文含敏感数据，用户显式 opt-in；对不可信场景慎用」+「worktree 只隔离 git 工作树非安全隔离」（D-008）。
**残余风险**: 无（文档化诚实表达能力边界，OS-3/OS-4 已排除技术隔离）。**注**：opt-in 主体含 LLM 自主调用（LLM 可自主决定传 fork:true）；单用户威胁模型下危害有限（继承的是用户自己的上下文）；system prompt 警告对 LLM 有软约束。

#### ✅ 数据
schema 层无数据操作。

#### ✅ 性能
schema 校验纳秒级。

#### ✅ 并发
schema 无并发面。

#### ✅ 稳定性
schema 扩展（新增可选参数，默认 false）不破坏现有调用。

#### ✅ 兼容性
新增可选参数（fork/worktree/cwd 默认 false/undefined），向后兼容。

#### ✅ 可观测性
schema 层无可观测性需求（由消费方承载）。

---

### Issue #9: index.ts — session_start 挂 reaper + 缓存主 session 路径

> #9 两项职责：① session_start 挂 reaper scan；② session_start 缓存 `ctx.sessionManager.getSessionFile()` → SubagentService（供 #3 Resolver mainSessionFile + #6 forkSource）。两者下文分别分析。

#### 职责②：缓存 getSessionFile()（fork 链路数据源）

#### ✅ 安全
getSessionFile() readonly（§8 边界），返回主 session 路径，无注入面。

#### ⚠️ 数据
**事务边界**: 缓存值供 #3 Resolver（forkSource）+ #6（createBranchedSession 源）。**时序风险**：若 session_start 早于主 session 文件创建，getSessionFile() 可能返回 undefined/空路径 → 缓存进 ctx → #6/#3 取到空 mainSessionFile → forkSource 空 → fork 分流异常（取不到主历史或报错）。
**缓解方案**: 依赖 pi SDK 保证 session_start 时 getSessionFile() 返回有效路径（session_start 语义=主 session 已就绪）。AC-6.10（buildSessionRunnerContext.mainSessionFile）+ AC-9.2 断言 #6 能取到该字段。
**残余风险**: pi SDK 若 session_start 时序变化 → 标注⑤骨架验证（验证 session_start 时主 session 文件存在）。

#### ✅ 性能
getSessionFile() 是内存读，纳秒级。

#### ✅ 并发
缓存值在 session_start 单次写入，后续只读。

#### ✅ 稳定性
缓存失败→#6 用占位先跑通（reaper/缓存补齐是完善，非核心执行路径）。

#### ✅ 兼容性
session_start handler 已有（index.ts:62），新增缓存沿用模式。

#### ✅ 可观测性
缓存命中/未命中记日志。

---

#### 职责①：reaper scan

#### ✅ 安全
reaper scan（git worktree list）只读 + 清孤儿，路径来自 git 输出受控。

#### ✅ 数据
reaper 清孤儿 worktree，D-024 孤儿判据守卫防删活。

#### ⚠️ 性能
**预期负载**: session_start 是 pi 启动期，reaper scan（git worktree list + 对照 records）阻塞启动。
**关键路径延迟**: scan 耗时取决于孤儿 worktree 数量（通常 0）。pi-sub-* 前缀过滤限定范围。
**扩展性瓶颈**: 大量孤儿（长期未清理）→ scan 慢。但 reaper 本身是清理机制，孤儿只会减不会增。
**优化方案**: scan best-effort（失败记日志不阻断 session_start，UC-5 异常）。
**残余风险**: 首次启动大量孤儿 → 一次性扫描延迟，可接受。

#### ⚠️ 并发
**竞态场景**: D-024（B8）跨实例 reaper 误删活 worktree（与 #4 同源，reaper 调 WorktreeManager.scan 共用孤儿判据）。
**幂等策略**: scan 幂等（清过的孤儿不再存在）。
**锁策略**: 无跨实例锁，靠 .alive 守卫。
**分布式考虑**: 多实例 session_start 各自跑 reaper → 都遵守 D-024 判据，不删活 .alive 的 worktree（AC-9.4 故障注入）。
**残余风险**: 同 #4（pid 复用 → 软超时兜底）。

#### ⚠️ 稳定性
**故障场景**: reaper scan 失败（git 不可用/权限）→ 记日志不阻断 session_start（UC-5 异常），下次启动再扫。
**降级方案**: best-effort 跳过，不阻断启动。
**熔断/限流**: 无。
**重试策略**: 不重试（下次启动再扫）。
**SLA 影响**: 不阻断 pi 启动。
**残余风险**: 持续 scan 失败 → 孤儿累积，但 git worktree prune 最终清元数据。

#### ✅ 兼容性
session_start handler 已有（index.ts:62），新增挂载沿用模式。

#### ✅ 可观测性
reaper 扫描结果记日志（清了几个孤儿）。

---

### Issue #10: session-file-gc — 方案 A 增 glob

#### ✅ 安全
GC 清理 sidecar 文件，路径来自 walkAndClean 遍历 sessionsDir，受控。

#### ✅ 数据
清理 .finalized + .alive sidecar，对称 .cancelled。B3 修复：清 .alive 前先 readAliveMarker+isProcessAlive（防误清活 record 的 .alive 致误判 crashed）。

#### ✅ 性能
walkAndClean 已是定期遍历，增 glob 增量小。

#### ⚠️ 并发
**竞态场景**: GC 清 .alive 时实例 A 正 running（.alive 存在 + pid 活）→ 误清致 A 重建误判 crashed（B3）。
**幂等策略**: GC 幂等（清过的不再存在）。
**锁策略**: 无，靠 isProcessAlive 守卫。
**分布式考虑**: 跨实例 GC → 都遵守先探活后清（AC-10.2 故障注入）。
**残余风险**: 核心 B3 竞态无残余（isProcessAlive 守卫）；pid 复用情况 .alive 孤儿残留（A 死后 pid 被 B 复用 → GC 探活活 → 跳过清），依赖 #12 重建 24h 超时标记 crashed 后由下次 GC（探活死）清理。

#### ✅ 稳定性
GC 是卫生项，失败不影响核心（孤儿累积但不阻断）。

#### ✅ 兼容性
GC 增 glob 对称现有 .cancelled 清理，模式一致。

#### ✅ 可观测性
GC 清理计数记日志。

---

### Issue #11: ADR-001 决策 2 修订 — 方案 A 修订

#### ✅ 安全
文档修订无安全面。

#### ✅ 数据
无数据操作。

#### ✅ 性能
无。

#### ✅ 并发
无。

#### ✅ 稳定性
文档一致性增强。

#### ⚠️ 兼容性
**API 变更**: ADR-001 决策 2「task=全部输入」→「fork:true 时=主历史+task；fork:false 保持原行为」。这是契约文档修订，非代码 breaking。
**数据兼容**: 无。
**客户端影响**: 维护者读 ADR 须注意 fork 分支（防误读旧契约）。
**灰度/回滚**: 文档可随时回滚。
**残余风险**: 无。**注**：ADR 修订与 #8 AC-8.4 system prompt 同源（均记 fork 敏感数据继承），须口径一致防两文档漂移。

#### ✅ 可观测性
无。

---

### Issue #12: 跨实例 crashed 协调 — 方案 A pid 探活

#### ✅ 安全
pid 探活（process.kill(pid,0)）零信号，不操作目标进程，无注入面。

#### ⚠️ 数据
**事务边界**: 四分支检测（.cancelled/.finalized/.alive+活pid/都无）涉及多次磁盘读+pid 探活，非原子。
**并发场景**: 实例 A 写 .alive，实例 B 探活 → B 读到 .alive + pid 活 → running-elsewhere（externalInstance:true，不操作不标 crashed）。
**迁移方案**: 无。
**回滚策略**: pid 探活失败（异常）→ 保守判死（isProcessAlive 返回 false）→ crashed。
**残余风险**: pid 复用（A 死后 pid 被 B 复用）→ .alive.startedAt + 24h 软超时兜底（AC-12.3），概率正确非确定。

#### ✅ 性能
pid 探活（process.kill 0）纳秒级，readAliveMarker 单文件读。

#### ⚠️ 并发
**竞态场景**: 跨实例 reconstructAll + .alive 写入交错 → 读到 .alive 中间态。但 writeAliveMarker 单次写，读到=完整或读到无。**启动窗口竞态**：实例 B 的 reconstructAll 在 A 的 writeAliveMarker 创建文件之前运行（合法窗口：session 存在，.alive 在 prompt 前 session-runner.ts:461 写）→ B 无 .alive 也无 .finalized/.cancelled →「都无」分支 → **crashed**（误判），下次扫描（.alive 现存在）→ externalInstance。同一跨实例记录在扫描间分类**翻转 crashed→externalInstance**——可接受（crashed 是保守安全降级，最终收敛到 externalInstance）。
**幂等策略**: reconstructAll 幂等。
**锁策略**: 无，靠 pid 探活 + externalInstance 投影。
**分布式考虑**: D-004 共享目录 → pid 探活是跨实例活性证据（D-023 externalInstance 投影不污染 ExecutionStatus）。
**残余风险**: pid 复用 → 软超时兜底。

#### ⚠️ 稳定性
**故障场景**: process.kill 跨平台异常（Windows）→ AC-12.5 try/catch 返回 false（保守判死）。pid=1（init）→ 文档标注已知限制；pid===process.pid（不探活自己→false，AC-12.5 覆盖）。
**降级方案**: 探活异常→保守判 crashed（安全降级，宁可误判 crashed 不误判 running）。
**熔断/限流**: 无。
**重试策略**: 不重试（探活是瞬时判断）。
**SLA 影响**: 跨实例并发正确性（D-021 目标）。
**残余风险**: Windows pid 探活限制 → AC-12.5 文档标注（首版 POSIX-only，OS-7）。

#### ⚠️ 兼容性
**API 变更**: SubagentRecord 投影加 externalInstance?: boolean 是非 breaking（可选字段）。record-store reconstructAll 四分支扩展（消费方透明）。
**数据兼容**: 无（投影字段运行时计算，不持久化）。
**客户端影响**: TUI list 须渲染 externalInstance 标注（"running (other instance)"）。
**灰度/回滚**: 可选字段兼容灰度。
**残余风险**: 无。

#### ⚠️ 可观测性
**日志**: 四分支检测路径日志（哪分支 + pid 探活结果 + externalInstance 标注）。
**指标**: running-elsewhere 计数 + pid 复用兜底触发计数。
**追踪**: 无。
**告警**: pid 复用兜底频繁触发告警（pid 复用率高=系统异常）。
**审计**: 无。
**缓解**: 四分支日志 + pid 复用计数 → 回灌运维项。

---

### Issue #13: alive-store — 方案 A 独立模块

#### ✅ 安全
.alive sidecar（pid+id+startedAt 单行 JSON），路径=sessionFile+".alive"，SDK 受控。isProcessAlive 零信号探活无副作用。

#### ⚠️ 数据
**事务边界**: writeAliveMarker 与 session 创建非原子——session 创建后 prompt 前写（session-runner.ts:461）。若进程死在写 .alive 之前 → 无 .alive → 重建判 crashed（但此时 session 已存在，是正确 crashed）。
**并发场景**: 实例 A 写 .alive，实例 B 读 → 单次写，读到=完整或读到无。
**迁移方案**: 无存量 .alive（新增）。
**回滚策略**: .alive 是 best-effort，删除无影响（重建判 crashed 是安全降级）。
**残余风险**: writeAliveMarker 与 prompt 之间窗口（进程死）→ 正确 crashed（session 已存在无 .alive）。**writeAliveMarker 自身抛错**（磁盘满/权限）按设计静默吞噬（best-effort IO）→ .alive 从未写入 → 跨实例观察者误判 crashed 整个运行期（best-effort 降级可接受，与 tombstone-store/finalized-marker 范式一致）。

#### ✅ 性能
单文件 read/write/remove + pid 探活，纳秒级，best-effort。

#### ✅ 并发
单写入者无写写竞争（单 subagent 一个 .alive）。**注**：跨实例读写竞争由消费者分析（#12 reconstructAll / #4 reaper / #10 GC 均跨实例读 .alive，其竞争处理见各 issue 并发维度）。

#### ✅ 稳定性
best-effort IO（错误静默），对称 tombstone-store/finalized-marker 范式。

#### ✅ 兼容性
新 sidecar 类型，GC（#10）对称清理。与 .cancelled/.finalized 三件对称。

#### ✅ 可观测性
.alive 存在性是跨实例活性证据本身（#12 探活载体）。

---

## 缓解项回灌登记（Mitigation Rollback）

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|---------|------|
| recordId 白名单校验 `^[\w-]+$` | #4 | 安全 | ⑤契约 + 建议补③issue AC | WorktreeManager.create 内 recordId 校验 + 建议 #4 AC-4.14「非法 recordId→抛错」 | 骨架约束 | 已落（骨架 worktree-manager.ts 已实现校验，Wave 2D 单测 T2.3 验）`[6c 终检修订]` |
| collectPatch 失败保 worktree（D-022） | #7 | 数据 | ③issue #7 AC-7.4（已在 issues.md） | 故障注入测试 cleanup callCount==0 | 代码测试 | 已在 #7 |
| completeRecord/archive 抛错兜底（B9） | #7 | 稳定性 | ③issue #7 AC-7.9（已在 issues.md） | 故障注入测试 finalized/cleanup 仍执行 | 代码测试 | 已在 #7 |
| reaper 孤儿判据 .alive 守卫（D-024） | #4/#9 | 并发 | ③issue #4 AC-4.4 / #9 AC-9.4（已在 issues.md） | 跨实例故障注入测试不删活 worktree | 代码测试 | 已在 #4/#9 |
| GC 清 .alive 先探活（B3） | #10 | 并发 | ③issue #10 AC-10.2（已在 issues.md） | 故障注入测试 isProcessAlive=true 不清 | 代码测试 | 已在 #10 |
| 四分支 sidecar 矩阵测试（D-021） | #12 | 并发 | ③issue #12 AC-12.2（已在 issues.md） | 四分支 5 种 sidecar 组合单测（两 crashed 子路径共享终态，reason 不同） | 代码测试 | 已在 #12 |
| externalInstance 投影类型测试（D-023） | #1/#12 | 数据 | ③issue #1 AC-1.5 / #12 AC-12.4（已在 issues.md） | 类型测试断言 status 不含 __external | 代码测试 | 已在 #1/#12 |
| fork 继承敏感数据文档化（G5 D-007） | #8 | 安全 | ③issue #8 AC-8.4（已在 issues.md） | system prompt 警告（与 #11 ADR-001 修订口径一致） | 骨架约束 | 已在 #8 |
| fork 两级降级链测试（createBranched→forkFrom） | #6 | 稳定性 | ③issue #6 AC-6.3（已在 issues.md，两级非三级） | 故障注入降级测试（AC-6.3 覆盖两级；AC-6.6 是 fork:false 默认路径非降级） | 代码测试 | 已在 #6 |
| crashed reason 结构化日志 + 计数指标 | #2 | 可观测 | 运维项 | reconstructAll crashed 日志 + 指标 | 运维项 | 待落 |
| WorktreeManager 结构化日志 + 成功率指标 | #4 | 可观测 | 运维项 | create/cleanup/scan 日志 + 成功率 | 运维项 | 待落 |
| finalizeRecord 三件套日志 + patchFailed 计数 | #7 | 可观测 | 运维项 | 三件套日志 + patchFailed 指标 | 运维项 | 待落 |
| pid 复用兜底触发计数指标 | #12 | 可观测 | 运维项 | 24h 软超时触发计数 | 运维项 | 待落 |
| fork 路径日志（createBranched/forkFrom/from-scratch + depth） | #6 | 可观测 | ⑤契约 | session-runner fork 分流日志 | 骨架约束 | 待落 |
| node_modules 软链生效验证 | #4 | 性能 | ③issue #4 AC-4.10/4.11（已在 issues.md） | 集成测试断言 node_modules/.bin 存在 | 代码测试 | 已在 #4 |
| status 收口静态规则（禁裸赋值） | #2 | 并发 | ③issue #2 AC-2.2/2.3（已在 issues.md） | 静态扫描禁 `.status=` 裸赋值 | 代码测试 | 已在 #2 |

**回灌去向统计**：
- **③issue（即时承诺）**：12 条缓解已在 issues.md 对应 AC（双向可查，Step2 回灌重建器核对）
- **⑤契约（延期承诺）**：2 条（recordId 白名单 + fork 日志），由 ⑤code-arch §6 来源B 接住
- **运维项**：4 条（日志/指标配置，不进开发 issue）

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| pid 复用（A 死后 pid 被 B 复用，.alive 探活返回活） | 跨实例误判 running-elsewhere（A 实际已死却显示 running），最坏持续 24h（隐形僵尸 record）直到软超时触发 | D-021 用户拍板：pi 进程长生命周期下复用窗口极小；startedAt+24h 软超时兜底（AC-12.3），概率正确非确定正确；三方案都有时序竞态，A 改动最小 | pid 复用兜底触发计数指标 + externalInstance record 年龄分布指标（让 24h 僵尸可观测） |
| reaper 无 24h 软超时（区别于 #12 重建），pid 复用时孤儿 worktree 不被 reaper 清 | pid 复用场景孤儿 worktree 磁盘残留（git worktree prune 只清 .git 元数据不清工作树文件） | 无数据丢失，仅磁盘占用；reaper 与 #12 重建不对称是设计取舍（reaper 是回收卫生，#12 是状态正确性） | 孤儿 worktree 磁盘占用监控 + 定期人工清理 |
| collectPatch 部分成功（diff 出错 patch 部分写） | worktree 改动可能丢失（patch 不完整） | UC-4 异常已接受降级：best-effort 写空 patch+警告，改动可能丢失；D-022 保 worktree 供手动恢复兜底（collectPatch 完全失败时） | patchFailed 计数指标 |
| Windows pid 探活限制（process.kill 行为差异） | Windows 下跨实例 crashed 检测不准 | OS-7 首版 POSIX-only，文档声明；AC-12.5 Windows 异常 try/catch 返回 false 保守判死；pid=process.pid（不探活自己→false）/ pid=1（文档标注已知限制）已由 AC-12.5 覆盖 | 文档标注（无监控，首版不支持 Windows） |
| fork 与 compaction 交错（fork 读源时主 agent compaction） | fork 取到不完整/交错历史 | AC-6.9 createBranchedSession 取 compaction 后路径 + SDK 快照读；压力测试标注人审 | fork 失败/降级计数 |
| 10 层嵌套 fork token 压力 | 极端嵌套场景 token/磁盘累积 | D-007 depth≤10 硬截断（>10 拒绝）；createBranchedSession 优先体积控制（D-018） | depth 分布指标（接近 10 告警） |
| 跨实例 crashed↔externalInstance 分类翻转（实例 B 在 A 写 .alive 前扫描 → crashed，下次扫描 → externalInstance） | 同一跨实例记录在扫描间分类不稳定 | crashed 是保守安全降级（宁可误判 crashed 不误判 running），最终收敛到 externalInstance；翻转窗口短（A 写 .alive 在 prompt 前 session-runner.ts:461） | externalInstance 翻转计数指标 |

## 需⑤骨架验证的副作用（标记登记）

| 副作用 | 来源 | 验证什么 | 预期结论方向 | stub 进⑤骨架 |
|--------|------|---------|-------------|-------------|
| createBranchedSession mutate 后实例不串台 | #6 | fork:true 时传 createAgentSession 的 sessionManager 是 mutate 后同一实例，子 agent 写独立 session 不污染主 | session.messages 含主历史且写入落子 session（AC-6.4 集成测试） | session-runner fork 分流 stub（createBranchedSession 调用） |
| WorktreeManager node_modules 软链 + setupHook | #4 | create 后 worktree 内 node_modules 可用 + setupHook 执行 | node_modules/.bin 存在 + setupHook 副作用发生（AC-4.10） | WorktreeManager.create stub（软链+setupHook 调用） |
| recordId 白名单 `^[\w-]+$` 防注入 | #4 | recordId 含 shell 元字符时 create 拒绝 | 含特殊字符 recordId 抛错（AC-4.x 骨架约束） | WorktreeManager.create 内 recordId 校验 stub |
| fork 路径两级降级链（createBranched→forkFrom） | #6 | createBranchedSession 抛错时降级 forkFrom（issues.md #6 仅两级设计，AC-6.3 覆盖） | mock createBranchedSession reject → 断言走 forkFrom | session-runner 降级 try/catch stub |
