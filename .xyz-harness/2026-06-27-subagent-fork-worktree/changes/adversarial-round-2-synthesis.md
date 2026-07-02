---
phase: issues
adversary_round: 2
type: synthesis
---
# 对抗审查 R2 — 综合汇总（4 帧 diff 去重）

> 输入：adversarial-round-2-{impl,deps,reqs,acceptance}.md（4 异质 fresh subagent）。
> 去重聚类为可处置项，标 BLOCKING/MAJOR/MINOR + F(事实)/K(知识)/D(决策)。

## 综合发现（去重后）

### 🟥 BLOCKING（5 项，必处置）

| id | 来源帧 | 主题 | 类型 | 处置 |
|----|--------|------|------|------|
| **G1** | impl | **#6 createBranchedSession API 模型错误**（实例方法返回 string\|undefined + mutate self，非静态/构造函数）。#6/#1/#9 的 AC 基于错误 API 写。主 agent 已 pi 仓库复核确认。 | F | 必修：重写 #6 AC + #1 SdkLike 声明位置 + #9 mainSessionFile 线程 |
| **G2** | deps | **3 运行时循环**（#4↔#12 / #6↔#12 / #7↔#12）——#12 打包生产者(alive-store)+消费者(record-store 扩展)，但 #4/#6/#7 运行时调 #12 函数却声明在它之前。 | F | 必修：拆 #12 → #13 alive-store.ts（生产者，W2）+ #12 收缩（blocked_by {#2,#5}）|
| **G3** | acceptance | **安全关键 AC 用 grep 验证时序/故障/跨实例——零效**。AC-7.2 用 grep -n 行号验 D-017（最危险，fire-and-forget/死代码绕过）；AC-7.4/AC-12.5/AC-9.4 数据安全+跨实例无故障注入测试。 | F | 必修：~12 个行为 AC 升级为带断言的行为测试规范；标「机器门 vs 行为测试 vs 人审」 |
| **G4** | acceptance | **可机器验证 vs 人审边界未标**——团队若把 §11 grep 当机器门、其余当人审，时序/数据安全/跨实例全裸奔。系统性漏洞。 | K | 必修：每个 AC 标验证类型 |
| **G5** | reqs | **fork 敏感数据继承文档化零 AC**（D-007 rationale 明确要求，用户最该被告知却没被告知）。 | K | 必修：补 AC（#8 或 #11）|

### 🟧 MAJOR（4 项）

| id | 来源帧 | 主题 | 类型 | 处置 |
|----|--------|------|------|------|
| **M1** | reqs | **#12 镀金挤占核心排期**——用户原始意图未提双实例并发；D-021 拍板时未呈现「整个不做」第 4 选项（framing effect）。单实例下 #2 基础三分支已覆盖 UC-7。 | D | **需用户决策**：#12 降级 P2 / 拆独立排期 / 维持 P1 |
| **M2** | deps | #12 汇合 5 P1 deps → W5 关卡，标 P1 但调度可达性 P3。主并发正确性修复最后到。 | K | 随 G2 拆分后缓解（#12 收缩到 W4）|
| **M3** | impl | #4 ~280 LOC 严重低估（node_modules 软链+setupHook ~140 LOC 参考），诚实估算 ~450。#2 STATUS_PRIORITY 缺 key 第一次编辑即编译失败。#8 参数线程化 0 LOC+AC 只验 schema。 | K | 必修：修正 LOC 估算 + #2 AC 补 key + #8 补参数流 AC |
| **M4** | deps | #10 缺 blocked_by #12（AC-10.2 调 #12 函数）；#9 缺传递依赖。 | K | 必修：补依赖边（随 G2 拆分）|

### 🟨 MINOR（散项，实现期补）

- AC-12.7 漏 pid===process.pid / pid===1（acceptance）
- 负向 grep AC 可改名绕过（acceptance）——补正向 AC
- #2 record-store 被 #2→#12 触及两次（deps）——标预期返工
- UC-1.2/UC-2.3/UC-6 端到端漏 AC（reqs）

## 交叉验证（4 帧独立命中=高置信）

- **#12 是多重问题源**：impl(deps 链重)/deps(3 循环 hub)/reqs(镀金)/acceptance(AC-12.5 无验收) 四帧独立都指向 #12 → **拆分 #12（G2）+ 用户重判优先级（M1）是最高杠杆修复**。
- **API 模型错（G1）**：impl 独立命中 + 主 agent pi 仓库复核 → 高置信，必改。
- **AC 验证方法系统性（G3/G4）**：acceptance 深挖 + 跨 4 帧间接印证 → 高置信。

## 处置计划

1. **G1**（必修，F）：重写 #6 AC + #1/#9 调整——主 agent 直接修。
2. **G2**（必修，F）：拆 #12 → #13 alive-store.ts + #12 收缩——主 agent 直接修 + 更新 DAG/覆盖表。
3. **G3/G4**（必修，F/K）：升级 ~12 行为 AC 为测试规范 + 标验证类型——主 agent 直接修。
4. **G5/M3/M4**（必修，K）：补 fork 敏感数据 AC + 修 LOC + 补依赖边——主 agent 直接修。
5. **M1**（D，需用户）：#12 优先级——**ask_user**。

## 需用户决策项

**M1（#12 镀金）**是唯一 D 类（需用户拍板）。其余 G1/G2/G3/G4/G5/M3/M4 均 F/K 类（主 agent 据事实/知识直接修，不推翻已 confirmed 决策——G2 拆分是结构优化非推翻 D-021）。
