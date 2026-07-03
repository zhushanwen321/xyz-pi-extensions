---
phase: issues
adversary_round: 2
frame: requirements-traceability
verdict: MAJOR
---
# 对抗审查 R2 — 需求回溯

> 认知帧：站在「付钱要 fork+worktree 这个功能的用户」立场，以 requirements.md 为唯一准绳，
> 戳 issues.md 的 12 issue 是否真覆盖 UC-1~UC-7 + F1~F7 + 用户原始意图（fork 继承上下文 + worktree 隔离）。

## TL;DR

- **UC 主流程覆盖良好**：UC-1~UC-7 的正常路径都有 issue 承接（#1~#9 分工清晰）。
- **3 处真漏需求（MAJOR）**：
  1. **fork 敏感数据继承文档化**（D-007 明确要求 + 用户原始意图核心安全关切）— 全 12 issue **零 AC 承接**，是最严重的漏。
  2. **UC-1 AC-1.2**（主 session 为空/未 flush 时降级 from-scratch 不崩溃）— 无 issue AC。
  3. **UC-6 端到端 /list 可见性**（G3 核心可观测性目标）— 只有间接 sessionDir 编码 AC，无「worktree subagent 完成后 /list 真看到它」的直接验收。
- **#12 镀金定性（诚实评估）**：用户原始意图（消息 1 = fork 上下文 + worktree 隔离）**从未提双 pi 实例并发**。#12 解决的是「双实例共享 session 目录」这个 agent 自造的边缘场景。D-021 虽 ask_user 拍板，但用户拍板时面对的是 3 方案技术对比（pid 探活/心跳/仲裁），**未被呈现「这个场景用户根本不会遇到，可整个不做」这个选项**。连锁成本跨 8 issue + 4 决策，挤占 #7（用户真正要的端到端集成）的排期。建议 #12 降级 P2 或拆出独立排期，不阻塞 fork+worktree MVP。
- **MVP 可行性**：fork（G1）+ worktree（G2）完全可在 **不做 #12** 的情况下先交付 — #12 是「双实例并发才触发」的观测性增强，单实例（绝大多数用户）UC-1~UC-6 全部正常。当前架构把 #12 钉死在 #7 之后（blocked_by #2/#4/#5/#6/#7），等于让所有用户的 MVP 为一个边缘场景让路。

## UC 覆盖矩阵

> 来源：requirements.md AC-1.1~AC-7.2（共 18 条验收标准）× issues.md AC（trace 标注 + 实质覆盖）。

| UC | 验收标准 | 对应 issue / AC | 状态 |
|----|---------|----------------|------|
| UC-1 fork 继承上下文 | AC-1.1 [正常] fork:true 子 agent 首次 prompt messages 非空含主历史 | #3 AC-3.1（shouldFork）+ #6 AC-6.1/AC-6.4（createBranchedSession + restore） | ✅ 覆盖 |
| UC-1 | AC-1.2 [异常] 主 session 为空→降级 from-scratch 不崩溃 | **无 issue AC**（grep「降级为 from-scratch」「主 session 为空」「未 flush」零命中） | ❌ **漏** |
| UC-1 | AC-1.3 [边界] fork 嵌套第 11 层被拒绝 | #3 AC-3.5（读侧 depth>10）+ #6 AC-6.8（写侧 M4 守卫） | ✅ 覆盖（读写双侧） |
| UC-2 worktree 隔离 | AC-2.1 [正常] worktree:true 子 agent bash cwd=worktreePath | #4 AC-4.1（WorktreeHandle + cwd） | ✅ 覆盖 |
| UC-2 | AC-2.2 [异常] working tree 脏→拦截+可操作提示 | #4 AC-4.9（但措辞模糊：「拒绝 or 警告，依实现」— 未强制「可操作提示」） | ⚠️ 弱覆盖 |
| UC-2 | AC-2.3 [边界] 并发 2 个 worktree subagent branch/path 不冲突 | **无明确 issue AC**（AC-7.7 只验并发池优先级，非 branch/path 唯一性；recordId+timestamp 唯一性在问题描述提了但无验收） | ❌ **漏** |
| UC-3 组合 | AC-3.1 [正常] fork+worktree 子 agent 既有主历史又 cwd=worktreePath | #6 AC-6.2（forkSource+effectiveCwd+sessionDir）+ #7 AC-7.1（worktree create 前置） | ✅ 覆盖 |
| UC-3 | AC-3.2 [边界] session 落主 cwd 目录，collectRecords 能扫到 | #6 AC-6.5（sessionDir 用 mainCwd）+ #3 AC-3.6（间接） | ⚠️ 间接（无 collectRecords 端到端扫到验证，见 UC-6） |
| UC-4 patch 清理 | AC-4.1 [正常] 有改动→非空 patch + worktree+branch 已删 | #4 AC-4.2/AC-4.3 + #7 AC-7.2/AC-7.4 | ✅ 覆盖（D-022 补强数据安全） |
| UC-4 | AC-4.2 [异常] 无改动→空 patch 但清理正常 | #4 AC-4.12（空改动→空 patch） | ✅ 覆盖 |
| UC-4 | AC-4.3 [边界] cleanup 失败不阻断 finalize | #7 AC-7.3/AC-7.9（三件套独立 try/catch + 兜底） | ✅ 覆盖 |
| UC-5 reaper | AC-5.1 [正常] kill -9 重启后残留 pi-sub-* 被清扫 | #9 AC-9.1（session_start 挂 scan）+ #4 AC-4.4 | ✅ 覆盖 |
| UC-5 | AC-5.2 [边界] 正在运行的 worktree 不被误清 | #4 AC-4.4（D-024 终态+无活 .alive 判据）+ #9 AC-9.4 | ✅ 覆盖（D-024 强化） |
| UC-6 /list 可见 | AC-6.1 [正常] worktree subagent 完成后 /list 看到 status=done | **无直接 issue AC**（AC-6.5 验 sessionDir 编码是间接前提；无「collectRecords 真返回该 record + status 正确」端到端验收） | ❌ **漏（端到端）** |
| UC-6 | AC-6.2 [边界] fork+worktree 组合 session 落主 cwd，list 可见 | 同上，#6 AC-6.5 间接，无 /list 端到端 | ❌ **漏（端到端）** |
| UC-7 崩溃标记 | AC-7.1 [正常] kill -9 后崩溃 subagent /list 显示 crashed | #2 AC-2.1/AC-2.2（三分支检测）+ #5 AC-5.2 | ✅ 覆盖 |
| UC-7 | AC-7.2 [边界] 正常完成写 .finalized 重启后仍 done | #2 AC-2.2（.finalized→done/failed）+ #5 AC-5.1 | ✅ 覆盖 |

**矩阵小结**：18 条 AC 中 12 条 ✅ 覆盖、2 条 ⚠️ 弱/间接覆盖、**4 条 ❌ 漏**（AC-1.2 / AC-2.3 / AC-6.1 / AC-6.2）。漏的 4 条里 3 条是异常/边界/端到端，1 条（UC-6 端到端）是 G3 核心可观测性目标。

## 镀金检测

### #12 跨实例 crashed 误判 — 镀金定性（诚实评估）

**用户原始意图（requirements.md G1/G2/G3 + 消息 1）**：
- G1 = fork 继承上下文
- G2 = worktree 隔离
- G3 = fork+worktree 可组合 + **可观测性完整**（/subagents list 可见 + pi resume 不污染）

**用户从未表达的需求**：「我会同时开两个 pi 实例共享同一个 session 目录」。

**#12 解决的问题**：多 pi 实例并发共享同一 session 目录（D-004 主 cwd 编码）时，实例 B 启动期 reconstructAll 把实例 A 内存 running 的 subagent 误判 crashed。

**镀金判定**：
1. **场景来源**：这个「双实例共享目录」场景是 D-004（session 存主 cwd 编码目录）**自己制造的架构后果**，不是用户场景。用户要的是「session 别污染 pi resume」（D-004 的正面价值），副作用是「多实例共享目录会误判」——这是 agent 在解决自己架构选择的副作用。
2. **用户拍板的代表性问题**：D-021 是 ask_user 拍板，但拍板时呈现的是 **3 方案技术对比**（pid 探活 vs 心跳 vs 仲裁），必问决策点 #3 让用户在「怎么做」里选。**用户从未被呈现「这个场景你根本不会遇到，可以整个不做」这个第四选项**。这是典型的 framing effect — 把「要不要做」伪装成「怎么做」。
3. **连锁成本 vs 用户价值**：#12 自身在 scope 注记里诚实承认「连锁真实工程成本跨 8 issue（#1/#2/#4/#6/#7/#9/#10/#12 的 AC 增量）+ 4 决策（D-021~D-024）+ 3 阻断 F-gap 修复」。一个用户没要的边缘场景，消耗了 8 个 issue 的 AC 增量 + 4 个决策的讨论带宽。
4. **挤占核心排期**：#7（SubagentService 集成）是 fork+worktree 端到端跑通的汇合点，是用户真正要的。但 #7 的 AC 被 #12 反哺塞进了 AC-7.8（removeAliveMarker）、AC-6.7（writeAliveMarker）、AC-9.4（scan 遵守 D-024）、AC-10.2（GC 清 .alive）等——**用户的核心集成 issue 被边缘场景的连锁需求污染**。
5. **MVP 不需要它**：单实例（绝大多数用户）下，#2 的基础三分支检测已完整覆盖 UC-7（崩溃标记）。#12 只在「双实例并发」时才有差异。把 #12 钉死在 #7 之后（blocked_by #2/#4/#5/#6/#7），意味着所有用户必须等边缘场景做完才能拿到 fork+worktree MVP。

**结论**：#12 是 **agent 自造的镀金需求**（解决自己架构选择的副作用，非用户场景）。即使 D-021 是 ask_user 拍板，拍板过程存在 framing 缺陷（未呈现「不做」选项）。建议：#12 降级 P2 或拆出独立排期，**不阻塞 fork+worktree MVP**；当前 #7 AC 里被 #12 反哺塞入的 alive-marker 相关 AC（AC-6.7/AC-7.8/AC-9.4/AC-10.2）应标注为「#12 触发，可后置」，让 #7 的核心集成路径（fork 分流 + worktree create/cleanup + D-017 时序）先干净交付。

> 注：D-024（reaper 孤儿判据用 .alive 防跨实例删活 worktree）虽由 #12 触发，但其「破坏性竞态（删数据）比 crashed 误判（只读错状态）严重一个量级」的论证成立。若 #12 降级，D-024 的安全网应有替代实现（如 reaper 仅清「有终态标记」的 worktree，对「无标记」的保守不动），不能因 #12 降级而丢失删除安全守卫。

## 漏需求

### 漏-1（高危）：fork 敏感数据继承文档化 — 零 AC 承接

**来源**：D-007 rationale 明确「敏感信息全量继承需文档化（fork 继承主 agent 全部上下文含敏感数据，由用户显式 opt-in）」。requirements.md 数据清单也标「内部（含可能凭证，fork 全量继承，文档化）」。

**现状**：grep issues.md 全文，**零 AC** 要求文档说明：
- fork 会继承主 agent 全部上下文（含凭证/密钥/敏感对话）
- 这是用户显式 opt-in 的行为（fork:true 才触发）
- 敏感数据会落子 session.jsonl（独立存储，但内容含主 agent 敏感历史）

**最接近但不够的 AC**：
- AC-8.3 只覆盖 worktree 非安全隔离（D-008），不覆盖 fork 敏感数据
- AC-11.2 只覆盖「fork 上下文继承语义（主历史+task）」，是功能语义非安全警告

**为什么高危**：fork 是本需求的核心卖点（G1）。用户用 fork 是为了「子 agent 带着主 agent 上下文干活」，但这意味着主 agent 对话里的 API key、私密信息、凭证会全量复制进子 session。若不文档化 + opt-in 明示，用户在不知情下 fork 会导致敏感数据扩散到子 session 文件（且子 session 有 30 天 TTL 独立留存）。这是用户付钱要的功能里**最该文档化却完全没文档化**的安全项。

**建议**：#11（ADR-001 修订 + 文档）加一条 AC：「system prompt/文档明示 fork:true 会全量继承主 agent 上下文含敏感数据，需用户显式 opt-in；与 worktree 非安全隔离警告（AC-8.3）并列」。或 #8 加 fork 参数的 schema 文档 AC。

### 漏-2（中危）：UC-1 AC-1.2 主 session 为空降级 — 无 AC

**来源**：requirements.md AC-1.2「主 session 为空时，降级为 from-scratch 启动，不崩溃」+ UC-1 替代流程「主 session 未 flush（无 assistant message）→ 降级为普通 from-scratch 启动 + 警告」。

**现状**：grep「降级为 from-scratch」「主 session 为空」「未 flush」在 issues.md **零命中**。#3（Resolver）/ #6（session-runner）的 AC 都假设 forkSource 有效，无「forkSource 取不到/源空」的异常 AC。

**为什么中危**：这是 fork 的 graceful degradation——用户调 fork:true 但主 agent 还没 flush（常见：主 agent 首条消息后立即 fork），若不降级会崩溃或抛错。UC-1 异常流程明确要求降级 + 警告，issue 层却无验收，实现时极易漏。

**建议**：#6 加 AC「fork:true 但 mainSessionFile 为空/无 assistant message entry → 降级 create（非 forkFrom）+ 返回警告（不崩溃）」。

### 漏-3（中危）：UC-2 AC-2.3 并发 worktree 唯一性 — 无明确 AC

**来源**：requirements.md AC-2.3「并发 2 个 worktree subagent，branch/path 不冲突」+ UC-2 异常流程「并发多个 worktree subagent → branch/path 名带 recordId+timestamp 保证唯一」。

**现状**：#4 问题描述提到「recordId+timestamp 保证唯一」，但 **无 AC 验证**。AC-7.7（并发池优先级）是不同关注点。

**为什么中危**：并发开 2 个 worktree subagent 时，若 branch 名 `pi-sub-<recordId>` 或 path 撞了，`git worktree add` 会失败。UC-2 明确要求不冲突，issue 无验收则实现可能用单一 recordId（撞）或漏 timestamp。

**建议**：#4 加 AC「并发 2 次 create → branch 名 + worktree path 均唯一（含 recordId + timestamp），git worktree add 不报冲突」。

### 漏-4（中危）：UC-6 /list 端到端可见性 — 无直接 AC

**来源**：requirements.md AC-6.1「worktree subagent 完成后，/list 能看到它（status=done）」+ AC-6.2「fork+worktree 组合 session 落主 cwd 目录，list 可见」。这是 G3「可观测性完整」的核心验收。

**现状**：issues.md 无 AC 直接验证「RecordStore.collectRecords 真返回 worktree/fork subagent record 且 status 正确」。现有 AC-3.6/AC-6.5 验证「sessionDir 用 mainCwd 编码」——这是 list 可见的**前提条件**，但不是**端到端验证**。编码对了不代表 collectRecords 扫描 + reconstructAll + STATUS_PRIORITY 组合后真能在 /list 输出正确 status。

**为什么中危**：G3 是用户三大目标之一（可观测性）。用户付钱要「能看见所有 subagent 状态」，但 issue 层只验了存储编码（手段），没验 list 输出（目的）。#2 验 crashed 检测、#7 验 finalize 时序，但「worktree subagent done 后 /list 真显示 done」这个端到端断言没人守。

**建议**：#7（集成汇合点）加端到端 AC「fork+worktree subagent 正常完成后，RecordStore.collectRecords 返回该 record 且 status=done（端到端验证 sessionDir 编码 + reconstructAll + STATUS_PRIORITY 组合正确）」。

## 发现

| # | 问题 | 严重度 | 说明 |
|----|------|--------|------|
| R2-1 | fork 敏感数据继承文档化零 AC 承接 | **高** | D-007 明确要求 + 用户核心安全关切，全 12 issue 无 AC。fork 全量继承主 agent 上下文（含凭证）却无文档/opt-in 明示，敏感数据静默扩散到子 session。建议 #11 或 #8 补 AC。 |
| R2-2 | #12 跨实例 crashed 误判是镀金需求 | **高** | 用户原始意图从未提双实例并发；#12 解决的是 D-004 架构选择的副作用非用户场景。D-021 拍板有 framing 缺陷（未呈现「不做」选项）。连锁跨 8 issue + 4 决策挤占 #7 核心集成排期。建议降级 P2 或独立排期，不阻塞 MVP。 |
| R2-3 | UC-1 AC-1.2 主 session 为空降级无 AC | 中 | fork 的 graceful degradation（主 agent 未 flush 时降级 from-scratch）无 issue 验收，实现易漏。建议 #6 补 AC。 |
| R2-4 | UC-2 AC-2.3 并发 worktree 唯一性无 AC | 中 | 并发 worktree 的 branch/path 唯一性（recordId+timestamp）在问题描述提了但无验收。建议 #4 补 AC。 |
| R2-5 | UC-6 /list 端到端可见性无直接 AC | 中 | G3 可观测性核心目标只验了 sessionDir 编码（手段）没验 /list 输出（目的）。建议 #7 补端到端 AC。 |
| R2-6 | AC-4.9 clean 校验措辞模糊 | 低 | UC-2 AC-2.2 要求「拦截 + 可操作提示」，AC-4.9 写「拒绝 or 警告，依实现」——未强制可操作提示（用户需知道 commit/stash）。建议收紧措辞。 |
| R2-7 | #12 反哺污染 #7 核心 AC | 中 | #7（用户真正要的集成汇合点）的 AC-6.7/AC-7.8/AC-9.4/AC-10.2 被 #12 的 alive-marker 连锁塞入，核心路径与边缘场景耦合。建议标注 #12 触发的 AC 可后置，让 #7 核心先干净交付。 |

## 阻断判定

**verdict: MAJOR**

**不 BLOCKING 的理由**：UC-1~UC-7 主流程（正常路径）覆盖良好（12/18 AC ✅），fork+worktree 核心能力（G1/G2）的 issue 链路（#1→#3/#4→#6→#7）完整可交付。漏的 4 条 AC 是异常/边界/端到端，可在实现期补 AC 而非推翻 issue 划分。

**MAJOR 的理由**：
1. **漏-1（fork 敏感数据文档化）是用户安全关切的真空** — D-007 明确要求却零 AC，这不是边界 case 是核心功能的文档化义务，付钱用户有权知道 fork 会扩散敏感数据。
2. **#12 镀金挤占核心排期** — 用户没要的边缘场景钉死在 #7 之后，让所有用户的 MVP 为它让路，违反「用户核心需求优先」原则。需重新排期（降级或独立化）。

**放行条件（修复后可升 APPROVED）**：
1. 补漏-1：#11 或 #8 加 fork 敏感数据继承文档化 AC（opt-in 明示 + 安全警告）。
2. 处理 #12：要么降级 P2 / 拆独立排期不阻塞 #7，要么在 issues.md 显式记录「#12 是 D-004 副作用驱动的增强，单实例 MVP 不依赖它」的排期备注。
3. 补漏-2/3/4：#6 加 AC-1.2 降级 AC、#4 加并发唯一性 AC、#7 加 /list 端到端 AC。
4. 收紧 AC-4.9 措辞（强制可操作提示）。

