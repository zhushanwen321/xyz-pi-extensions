---
phase: issues
adversary_round: 2
type: convergence
---

# 对抗审查 R2 — 收敛复核（4 帧 gap → 修复）

> 输入：adversarial-round-2-{impl,deps,reqs,acceptance}.md（4 异质 fresh subagent）+ synthesis.md。
> 用户决策：M1 #12 维持 P1 但拆 #13（D-025）；AC 全部升级行为测试规范（D-026）。

## 修复总表

| gap id | 来源帧 | 严重度 | 类型 | 处置 | 落地 |
|--------|--------|--------|------|------|------|
| **G1** | impl | BLOCKING | F | ✅ 修复 | #6 AC-6.1/6.4 重写（createBranchedSession 实例方法 + mutate self）；#1 AC-1.1 SdkLike 声明位置（静态 forkFrom / 实例 createBranchedSession）；#9 AC-9.2/6.10 mainSessionFile 线程 |
| **G2** | deps | BLOCKING | F | ✅ 修复 + D-025 | 拆 #12 → #13 alive-store.ts（blocked_by #1）+ #12 收缩（blocked_by #2/#5/#13）；#4/#6/#7/#10 改 blocked_by #13；3 循环全消；#12 W5→W4 |
| **G3** | acceptance | BLOCKING | F | ✅ 修复 + D-026 | ~12 行为/时序/数据安全 AC 升级为带断言行为测试（故障注入/spy/多实例集成/4分支 sidecar 矩阵/类型测试）；AC-7.2 删 grep -n 改 spy+await |
| **G4** | acceptance | BLOCKING | K | ✅ 修复 | 每个 AC 标「机器门(grep) vs 行为测试 vs 人审」三类 |
| **G5** | reqs | BLOCKING(需求) | K | ✅ 修复 | #8 AC-8.4 fork 敏感数据继承安全文档化（D-007）|
| M1 | reqs | MAJOR | D | ✅ 用户决策 | #12 维持 P1 + 拆 #13（D-025）|
| M2 | deps | MAJOR | K | ✅ 随 G2 | #12 收缩 W5→W4 |
| M3 | impl | MAJOR | K | ✅ 修复 | #4 LOC ~280→~450；#2 AC-2.1 STATUS_PRIORITY key 同次编辑补；#8 AC-8.1 参数流端到端测试 |
| M4 | deps | MAJOR | K | ✅ 修复 | #10→#13 缺失边补；#9→#13 传递 |
| MINOR | 多帧 | MINOR | K | ✅ 修复 | AC-12.5 补 pid===process.pid/pid===1；负向 grep AC 补正向；#2 record-store 触及两次标预期返工；UC-1.2/2.3/6 端到端 |

## 验证

- **机器检查**：9/9 PASS（13 issue 全检测，blocked_by 无幽灵，P 级一致，覆盖核验表 55 行无待补）
- **决策账本**：D-025（拆 #13）、D-026（AC 升级）已 append，均 D-可逆 ask_user confirmed
- **覆盖核验表**：§5/§7 加 #13 行；依赖语义更新
- **架构反哺**：§5 盲区 / §7 alive-store / §8 gitRun 已在 R1 backfeed 更新（#13 拆分是 issue 层结构，架构正文 alive-store 已记）

## 结论

**converged**。对抗审查 R2 的 5 BLOCKING + 4 MAJOR + MINOR 全部修复。核心改进：
1. **G1**：createBranchedSession API 模型从错误（静态/构造函数）修正为正确（实例方法+mutate）——避免实现期翻车（主 agent pi 仓库复核确认）。
2. **G2**：#12 拆 #13 解 3 运行时循环——依赖图从声明有效但运行时矛盾变为真无环。
3. **G3/G4**：AC 验证方法系统性升级——grep 不再被误用验时序/故障/跨实例，每 AC 标验证类型。
4. **G5**：fork 敏感数据继承安全文档化补齐——用户最该被告知却原漏的项。

对抗审查的价值：前次对齐+红队审查 APPROVED 但漏了这些——实现可行性（API 模型错）、依赖编排（运行时循环）、验收破坏（grep 验时序零效）三帧的认知盲区是正交的，单次审查无法覆盖。4 帧并行 + 用户决策是必要的纵深。
