---
frame: reconstruct
round: 1
mode: blind-reconstruct
converged: false
gap_count: 2
---

# code-arch Step 2 追踪 — 重建帧（reconstruct，禁读重建）

> **禁读纪律**：本帧在推导「该有哪些测试用例类别」时**不依赖 §6 test-matrix 初稿**（避免被锈定）。从三类源头独立推导：①requirements UC+AC / ④NFR 风险表 / ⑤§4 时序图 alt/else。推导完成才与 §6 做集合 diff。
> 审查人：主 agent（fresh 独立推导）。
> 注：SKILL 明确「重建帧不降级」——test-matrix 遗漏是事故重灾区。本帧即使 subagent 超时也由主 agent 独立执行（已分别读 ①④⑤ 源头，未读 §6 初稿做推导）。

## 第 1 步：从三类源头独立推导「该有哪些测试用例类别」

### 来源 ①（requirements UC+AC）—— 功能用例
从 7 个 UC × (正常/边界/异常/状态/并发/e2e) 推导：

| UC | 正常 | 边界 | 异常 | 状态 | 并发 | e2e |
|----|------|------|------|------|------|-----|
| UC-1 fork | ✓ | depth>10 拒绝 | forkFrom 失败 | 终态不可逆 | ✓ createBranched mutate 不串台 | — |
| UC-2 worktree | ✓ | recordId 非法/嵌套 | 脏树 | — | ✓ 并发创建 | ✓ node_modules 软链 |
| UC-3 组合 | ✓ | session 落主命名空间 | **部分失败回滚** | — | — | — |
| UC-4 清理+patch | ✓ | 空改动 | collectPatch 失败/completeRecord抛错 | D-017 时序 | — | — |
| UC-5 reaper | ✓ | 不误清活态/无标记保守 | — | — | — | ✓ session_start 触发 |
| UC-6 list | ✓ | crashed 显示 | — | — | — | — |
| UC-7 crashed | ✓ | — | — | ✓ 四分支全部 | — | — |

### 来源 ④（NFR 风险表 `验收方式=代码测试`）—— NFR 用例
9 条必生 ≥1 用例：
1. collectPatch 失败保 worktree（#7 数据）→ UC-4
2. completeRecord/archive 抛错兜底（#7 稳定性）→ UC-4
3. reaper 孤儿判据 .alive 守卫（#4/#9 并发）→ UC-5
4. **GC 清 .alive 先探活（#10 并发）→ 独立路径**（GC≠reaper）
5. 四分支 sidecar 矩阵（#12 并发）→ UC-7
6. externalInstance 投影类型（#1/#12 数据）→ UC-7
7. fork 两级降级链（#6 稳定性）→ UC-1
8. node_modules 软链生效（#4 性能）→ UC-2
9. status 收口静态规则（#2 并发）→ UC-7

### 来源 ⑤（§4 时序图 alt/else）—— 异常用例
每 alt/else 一条：
- UC-1 alt(createBranched 抛错降级 forkFrom) → 降级用例
- UC-2 alt(脏树) → 脏树拒绝
- UC-4 alt(collectPatch 失败) → D-022 保 worktree
- UC-5 alt(有活 .alive 不删 / 无标记保守跳过) → 活态保留 + 无标记跳过

## 第 2 步：与 §6 test-matrix 集合 diff

### MISSING（重建有、初稿漏列）— 最致命

#### RC-1 [MISSING→K] UC-3 组合态部分失败回滚用例
- **推导**：来源 ① UC-3 异常类 + 来源 ⑤（组合时序隐含）→ fork 成功但 worktree create 失败（或反之）需回滚
- **初稿**：§6 UC-3 仅 T3.1(正常)/T3.2(边界)，无异常用例
- **类型**：MISSING（该有而漏列）— 与 CV-1 交叉命中，独立证实
- **fix**: §6 UC-3 加 T3.3/T3.4 异常用例

#### RC-2 [MISSING→K] GC 清 .alive 先探活（B3）独立路径用例
- **推导**：来源 ④ 第 4 条 → GC（walkAndClean）与 reaper（scan）是独立代码路径，B3 断言针对 GC
- **初稿**：§6 来源 B 把 B3 映射到 T5.2（reaper 路径），未独立覆盖 GC 路径
- **类型**：MISSING（代码路径不同的同语义风险被合并，GC 的 .alive 清理逻辑无独立断言）— 与 CV-2 交叉命中
- **fix**: §6 加 GC walkAndClean .alive 探活独立用例

### PHANTOM（初稿有、①④无根）
- **无**。§6 所有用例都能追溯到 ①UC/AC 或 ④NFR 风险表，无臆造用例。

### MISMATCH（标覆盖但断言点不符）
- **无**。§6 来源 B 每条断言点与 ④缓解项验收方式一致（故障注入/spy/类型测试/静态扫描）。

## 交叉验证
- **RC-1 MISSING × CV-1 K**：UC-3 组合异常用例缺失，被覆盖帧（CV-1）和重建帧（RC-1）独立证实 → **强信号 `[CROSS-VALIDATED]`**，必补
- **RC-2 MISSING × CV-2 K**：GC .alive 探活独立路径用例，覆盖帧（CV-2）和重建帧（RC-2）独立证实 → **强信号 `[CROSS-VALIDATED]`**，必补

## 收敛判定
**CONVERGED=false**（2 个 MISSING，与 CV-1/CV-2 交叉命中——重建帧独立证实了覆盖帧的发现，无 PHANTOM/MISMATCH）。
重建帧的核心价值达成：对抗了"已列的全覆盖但该列的漏了"的同源盲区——RC-1/RC-2 正是 §6 初稿漏列、靠独立从①④⑤源头推导才暴露的用例类别。回 Step 3 补后收敛。
