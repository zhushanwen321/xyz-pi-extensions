---
frame: coverage
round: 1
converged: false
gap_count: 2
---

# code-arch Step 2 追踪 — 覆盖帧（coverage）

> 视角：测试覆盖完整性（来源 A 功能 alt/else + 来源 B NFR 映射）。
> 审查人：主 agent（fresh 视角）。

## 审查方法
对照：code-architecture.md §6 test-matrix ↔ §4 时序图 alt/else（来源 A）↔ non-functional-design.md 缓解项回灌登记表 `验收方式=代码测试`（来源 B）↔ requirements UC+AC。

## Gaps

### CV-1 [K] 来源 A 缺 UC-3（fork+worktree 组合）的独立异常用例
- **location**: §6 UC-3
- **description**: §6 UC-3 只有 T3.1（正常）+ T3.2（边界 session 落主命名空间），**缺异常用例**。UC-3 = UC-1+UC-2 组合，组合态有独特异常：fork 成功但 worktree create 失败（或反之）——部分成功需回滚。时序图 UC-3 注释说"合并 UC-1/UC-2 即得不单独画"，但测试矩阵不能继承——组合态的部分失败是 UC-1/UC-2 单测覆盖不到的（单 UC 假设另一 UC 成功）。
- **evidence**: §6 UC-3 表仅 2 行（T3.1 正常 / T3.2 边界），无异常行；§4 UC-3 注释"合并即得不单独画"
- **fix_suggestion**: §6 UC-3 加 T3.3 异常：fork 成功(createBranchedSession)但 worktree create 失败（脏树）→ 需回滚已 branched session 或留 orphan（首版行为需明确）；T3.4 异常：worktree create 成功但 fork 降级失败 → worktree 已创建需 cleanup。**非 D-不可逆**（首版部分失败策略 = 抛错 + finalizeFailed，回滚逻辑属 ⑥实现，⑤标用例即可）。

### CV-2 [K] 来源 B 缺 GC 清 .alive 先探活（B3）的独立断言用例
- **location**: §6 来源 B 表
- **description**: 来源 B 表把"GC 清 .alive 先探活（B3，#10）"映射到 T5.2（同 reaper 安全网语义）。但 **GC（session-file-gc.walkAndClean）与 reaper（WorktreeManager.scan）是两个不同代码路径**：GC 清过期 session 文件（30天 TTL），reaper 清孤儿 worktree。B3 的断言"清 .alive 前先探活，isProcessAlive=true 不清"针对的是 GC 路径（walkAndClean），而 T5.2 的断言针对 reaper 路径（scan 不删活 worktree）。两者安全网语义相似但代码路径不同，T5.2 的 spy 断言验不到 GC 的 .alive 清理逻辑。
- **evidence**: non-functional-design.md:567 "GC 清 .alive 先探活（B3）| #10 | 故障注入测试 isProcessAlive=true 不清"；§3 session-file-gc.walkAndClean（GC）vs WorktreeManager.scan（reaper）是独立方法
- **fix_suggestion**: §6 来源 B 表把 B3 映射到独立用例 T6.3（或新 ID）：GC walkAndClean 故障注入——.alive 对应 pid 活时 .alive 不被 GC unlink。强制层级 integration。**非 D-不可逆**。

## 已验证无 gap 项（CONVERGED 子项）
- ✅ **来源 A 每 UC 正常/边界/异常/状态 4 类**：UC-1（6类含并发）/UC-2（6类含e2e+并发）/UC-4（5类）/UC-5（4类含e2e）/UC-7（8类全覆盖四分支）齐全；UC-3/UC-6 为组合/投影覆盖关键类（UC-3 见 CV-1 补充）
- ✅ **时序图每个 alt/else → 异常用例**：UC-1 alt(降级)→T1.2；UC-2 alt(脏树)→T2.2；UC-4 alt(patch失败)→T4.3；UC-5 alt(活态)→T5.2 — 全映射
- ✅ **状态机每条转换有状态用例**：UC-7 T7.1~T7.8 覆盖四分支全部状态转换（cancelled/finalized-done/finalized-failed/alive-活/都无-crashed/alive-死-crashed/>24h-crashed/禁裸赋值）
- ✅ **NFR④ 并发 UC 有并发用例**：UC-1 T1.6（createBranched mutate 不串台）/UC-2 T2.6（并发 worktree）
- ✅ **④每条 `验收方式=代码测试` 缓解项 ≥1 用例**：9 条全映射（来源 B 表）—— collectPatch保worktree→T4.3 / completeRecord兜底→T4.5 / reaper.alive守卫→T5.2 / 四分支矩阵→T7.1~7.7 / externalInstance→T7.4 / 两级降级→T1.2 / node_modules软链→T2.5 / status收口→T7.8（B3 见 CV-2 补独立）
- ✅ **来源 B 强制层级标注**：安全/并发维度标 integration（T4.3/T5.2/T7.x/T1.2/T2.5）；lint 类标任意（T7.8）
- ✅ **来源 B 用例 ID 不与来源 A 重复编号**：来源 B 复用同 UC ID（多维度覆盖同一功能用例），非重复

## 收敛判定
**CONVERGED=false**（2 个 K-gap，均为用例补遗，非覆盖逻辑错误）。回 Step 3 补用例后本帧即收敛。
