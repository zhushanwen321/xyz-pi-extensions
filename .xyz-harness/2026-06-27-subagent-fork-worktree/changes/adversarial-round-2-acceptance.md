---
phase: issues
adversary_round: 2
frame: acceptance-sabotage
verdict: BLOCKING
---
# 对抗审查 R2 — 验收破坏

> 站在「试图让坏代码通过验收的狡猾开发者」立场，戳每个 AC 能否被「符合 AC 但实际坏了」的代码钻空子。
> 审查 agent 只读，本报告由主 agent 据其返回内容落盘。

## AC 钻空子清单（节选高危）

| AC | 钻空子方式 | 严重度 | 加固建议 |
|----|-----------|--------|---------|
| **AC-7.2**（grep -n collectPatch\|completeRecord\|archive 行号顺序）| **最危险**：行号顺序≠执行顺序。`void wm.collectPatch();`（fire-and-forget 不 await，line 100）→ completeRecord(line 200) 先于 git diff 完成执行 → patch 没进 result 就 freeze；或 `if(false){collectPatch()}` 死代码。grep -n 全过，D-017 核心不变式（patch 先于 freeze）实破 | **BLOCKING** | 删 grep -n。单测 spy collectPatch/completeRecord 断言 completeRecord 调用时 collectPatch 已 resolved；或集成测试断言 record.result 含 patch 路径 |
| **AC-7.4**（collectPatch 失败→cleanup 跳过，D-022 数据黑洞）| **数据安全不变量零机器验证**。开发者 cleanup 无条件执行，collectPatch 失败时 worktree+分支被删→用户改动永久丢失。无故障注入测试 | **BLOCKING** | 故障注入单测：mock collectPatch reject → 断言（a）cleanup callCount==0（b）worktree 目录仍存在（c）record.result.patchFailed===true + 含 worktree 路径 |
| **AC-12.3**（reconstructAll 四分支 pid 探活）| grep readAliveMarker\|isProcessAlive 可由注释/死分支满足；开发者把探活放 markReconstructedStatus("crashed") **之后**（顺序错）。grep 命中但四分支逻辑实破 | **BLOCKING** | 单测矩阵：4 种 sidecar 组合（无标记/.cancelled/.finalized/.alive+活pid/.alive+死pid）→ 断言各自 status；断言 readAliveMarker 在 markReconstructedStatus 之前 |
| **AC-12.5**（running-elsewhere: externalInstance:true, findRecord miss, cancel 无效, TUI 标注）| **#12 存在的全部理由，零机器验证**。多部分行为需多实例集成测试。grep 无能为力 | **BLOCKING** | 多实例集成测试：实例 A 写 .alive（活 pid mock）→ 实例 B reconstructAll → 断言 status===running && externalInstance===true；实例 B cancel 对 A 无效；TUI 含 "other instance" |
| **AC-9.4**（scan 遵守 D-024 孤儿判据，跨实例不删活 worktree）| 最危险破坏性竞态（跨实例删活工作目录）却无故障注入测试。开发者 scan 无视 .alive 直接清所有 pi-sub-* → 删实例 A 活 worktree | **BLOCKING** | 故障注入集成测试：实例 A 活 .alive + 活 pid → 实例 B scan → 断言 A 的 worktree 仍存在（remove callCount==0）|
| AC-1.2（ExecutionStatus 含 crashed）| grep 无机器验证方式。`// crashed TODO` 注释 或死字符串 `const _="crashed"` 即过，ExecutionStatus 联合类型实际没加 | MAJOR | TS 类型测试断言 |
| AC-1.1/AC-8（grep forkFrom\|createBranchedSession types.ts 命中）| JSDoc 注释或独立死类型 grep 命中但 SdkLike.SessionManager 块内真没声明 → TS 错被 as any 绕 | MAJOR | grep 带上下文（-A20 SessionManager 块内）或类型测试 |
| AC-3.3/3.4（grep SCR 无 pi import / 无 IO）| **动态拼接绕过**：`ctx.sdk["fork"+"From"]()` —— `sdk[` 非 `sdk.`，`"fork"+"From"` 非字面，**两条 grep 都不命中**；间接 IO（注入 helper 干 IO）。Core 零 Pi 依赖铁律实质被破 | BLOCKING | grep 无力。SCR 单测零 mock 全过 + 静态分析（dependency-cruiser 禁 SCR→pi/fs 边）|
| AC-2.1/2.2/2.3（grep crashed + 全路径经 markReconstructedStatus）| grep crashed 可由注释满足；「全经收口」是覆盖性质 grep 无法证明——开发者调一次 markReconstructedStatus 在死分支，其它路径裸赋值 record.status="crashed"，M3 不变式实破 | BLOCKING | STATUS_PRIORITY 结构化对象 + 单测 5 key；markReconstructedStatus 设 status 唯一写点（private setter）+ 静态规则禁文件内其它 `record.status=` |
| AC-6.4（fork 时 messages 含主历史）| 行为（历史 restore）grep 无法验证。开发者 createBranchedSession 返回空 sessionManager，messages 空 | BLOCKING | 集成测试：fork:true → 断言 session.messages.length>0 且含主 agent 已知消息 |
| AC-4.10（node_modules 软链 + setupHook 执行，正向契约）| 未指定自动验证。setupHook() 调用但不 await 或包 if(false)。无集成测试则破 | MAJOR | 集成测试：真实 create → 断言 node_modules/.bin 存在 + setupHook 副作用 |
| AC-4.12（空改动→空 patch；二进制→binary-skipped）| 行为边界无 grep。开发者对二进制不检测直接塞损坏 patch | MAJOR | 单测：空 git diff→patch===""；二进制→result 含 binary-skipped |
| AC-6.10（createBranchedSession 降级 try/catch 非存在性检测）| grep 区分不出 try/catch vs 存在性检测。开发者写 `if(!sdk.createBranchedSession)` （AC 禁的写法）| MAJOR | eslint 自定义规则禁存在性判断；单测 mock 抛错验证降级 |
| AC-12.7（isProcessAlive pid≤0 拒绝）| 守了 pid≤0 漏 pid===process.pid（自查永远 alive）和 pid===1（init 永远 alive→pid 复用永久误判 running-elsewhere）| MINOR | AC 补：pid===process.pid 返回 false；pid===1 文档标注 |

## 负向 AC 过度 / 正向不足

- **#4 负向 AC 堆叠**（AC-4.6/4.7/4.8 全「grep/find X 无输出」）：改名绕过（keepBranch→retainBranch、GitPort→GitRunner、PatchCollector→DiffCollector）保留相同伪 seam 却过 grep。正向功能（create 的 node_modules 软链/setupHook）虽标「正向契约」但未绑定集成测试，仍人审。
- **#7 正向时序靠 grep -n**（AC-7.2）：D-017 最常引用的数据完整性不变量用行号 grep——「正向时序」被「负向 grep 思维」污染。
- **比例倒挂**：~11 个负向 grep AC（易验证的「不存在」类）+ 6 个「命中即过」正向 grep AC，对比 ~14 个行为/时序/数据安全 AC **无自动测试规范**（难验证的反而没有测试）。

## 时序 / 行为 AC 不可验证（核心系统性漏洞）

issues.md 把大量行为 AC 的「验证方法」暗示为 grep（AC-7.2 明写 grep -n，§11 AC-9 也是 grep -n）。这些 AC 读起来像可机器验证，实则 grep 对**时序/故障/跨实例/覆盖性质零效**。**「可机器验证」与「只能人审」的边界在 issues.md 未标注**——团队若把 §11 grep 当机器门、其余当人审，则时序/数据安全/跨实例全部裸奔。

| AC | 类型 | grep 为何无力 | 修法 |
|----|------|-------------|------|
| AC-7.2 | 时序（patch 先 freeze）| 行号≠执行顺序 | spy + await 链断言 |
| AC-7.3 | 结构（三件套独立 try/catch）| grep try 计数≠独立 | 三组故障注入 |
| AC-7.4 | 行为+数据安全 | 看不出时序/条件 | 故障注入 + 目录存在性 |
| AC-7.9 | 行为 | 同上 | 故障注入 |
| AC-12.3 | 时序+行为 | grep 命中≠正确分支/顺序 | 4 种 sidecar 矩阵单测 |
| AC-12.5 | 跨实例行为 | 需多实例集成 | 多实例集成测试 |
| AC-9.4/AC-4.4 | 破坏性竞态 | 看不出 scan 检查 .alive | 故障注入 + worktree 存在性 |
| AC-2.2/2.3 | 覆盖性质 | grep 无法证明覆盖/不存在 | 静态规则 + status private setter |

## 遗漏关键验收

- **#11 ADR 修订**：核心功能（BC-2 文档化）**无任何可机器验证 AC**。AC-11.1/11.2 自然语言「含说明」，grep 验证是剧场。应标「人审 checklist」。
- **#8 参数流**：AC-8.1 只 grep schema 含字段，**无 AC 验证 fork/worktree/cwd 从 tool 流到 service 流到 runner**。开发者加死参数过 AC，#7 永远收不到 fork=true。
- **#12 跨实例正确性**：#12 存在的唯一理由（AC-12.5）无测试规范——**核心价值无验收**。
- **fork 历史恢复（G1）**：AC-6.4 行为 AC 无测试。G1（子 agent 继承主上下文）是三大业务目标之一，无机器保障。

## 阻断判定
**BLOCKING**——阻断对象是 **issues.md 的 AC 验证方法集**（非架构本身，架构 APPROVED）。安全最关键不变量（D-017 时序、D-022 数据安全、#12 跨实例、crashed 终态）的 AC 指定 grep 为验证方法，而 grep 对时序/故障/跨实例/覆盖性质零效。狡猾开发者可同时：crashed 作注释 + collectPatch fire-and-forget 过行号 grep 实破时序 + cleanup 无条件执行致失败时删用户 worktree + 跨实例代码从不正确写 .alive——**全部通过机器门**。AC-7.2 用 grep -n 验证 D-017（最常引用数据完整性不变量）是主动错误的验证方法，给虚假信心。

**撤销路径（bounded）**：~10 个行为/时序/数据安全 AC（AC-7.2/7.3/7.4/7.9、AC-12.3/4/5、AC-9.4/4.4、AC-2.2/2.3、AC-6.4）验证方法从 grep 升级为**带具体断言的行为测试**（故障注入/spy/多实例集成/4 分支 sidecar 矩阵）；每个 grep AC 标「机器门 vs 行为测试 vs 人审」三类；AC-12.7 补 pid===process.pid/pid===1；补 #8 端到端参数流 AC、#11 人审 checklist。
