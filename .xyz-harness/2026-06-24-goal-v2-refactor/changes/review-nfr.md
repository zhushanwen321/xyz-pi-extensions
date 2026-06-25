---
verdict: approved
reviewer: independent subagent (context-isolated)
artifact: non-functional-design.md (+ non-functional-design.html)
upstream: issues.md, system-architecture.md
downstream: code-architecture.md
prior_round: tracing-nfr-round-1.md (10 gaps: 2 F / 1 K / 4 D / 3 Missing)
method: 5 维度审查 + round-1 gap 闭合校验 + 矩阵 84 cell 三向核对（MD↔正文↔HTML）
---

# NFR 定稿审查报告

## 结论

**APPROVED**。5 维度均通过。round-1 tracing 的 10 个 gap 全部闭合。定稿达到可交接 code-architecture 的质量。

定稿最大的价值不是"补全了文档"，而是**通过代码取证发现并修正了上游的根本性事实错误**（budget 检查点函数名），这件事如果留到 code-architecture 才发现会返工。

---

## Round-1 Gap 闭合校验（10/10 闭合）

| Gap | 类型 | round-1 问题 | 定稿闭合方式 | 状态 |
|-----|------|-------------|-------------|------|
| F1 | 事实 | 时序"已确认"与正文"需确认"自相矛盾；persistState 被当成 Pi 事件 | Prototype 章节改为代码取证结论；明确列出 Pi 真实注册的 6 个事件，budget 检查挂在事件路径 persist 函数内 | ✅ 闭合 |
| F2 | 事实 | "persistState 单一检查点"与现状代码不符（事件路径走 persistAndUpdate，不走 service.persistState） | #5 数据章节 + HTML critical callout 显式修正：检查点在 persistAndUpdate，非 persistState；persistState 仅 command/tool 路径用 | ✅ 闭合（关键修正） |
| K1 | 知识 | 多 session 隔离未分析 | 运行时上下文显式声明单 session 假设 + 引用 CLAUDE.md 硬约束；#4 注明 per-session 重建 | ✅ 闭合 |
| D1 | 文档 | #2 矩阵⚠️ 与正文"无需迁移/无竞态"矛盾 | 矩阵 #2 改为 数据✅/并发✅/兼容性⚠️，与正文一致 | ✅ 闭合 |
| D2 | 文档 | #7 矩阵从 #5 复制（数据/并发/可观测⚠️） | 矩阵 #7 改为 性能✅/稳定性⚠️，正确反映正文真实维度 | ✅ 闭合 |
| D3 | 文档 | #10 prompt 假设 todo 存在，与 #7 降级交叉场景未定义 | #10 新增"交叉副作用（#7×#10）"章节 + 缓解（动态判断 __todoGetList） | ✅ 闭合 |
| D4 | 文档 | #1 可观测— 略过 task 可观测性丢失 | #1 可观测性影响改为"来源迁移到 todo/widget，有意的职责转移" | ✅ 闭合 |
| M1 | 漏项 | todo extension 新增导出的副作用未分析 | #7 稳定性章节注明 grep 零命中 + "属 todo extension 的代码改动 + 版本 bump" | ✅ 闭合 |
| M2 | 漏项 | **__goalInit tasks 废弃漏掉主力调用方 coding-workflow（最严重）** | #9 兼容性章节列出三方调用方 + file:line 取证（tool-handlers.ts:510-518/:530）+ inline alias drift 风险 | ✅ 闭合（最严重项） |
| M3 | 漏项 | GoalInitBudget.maxTurns 未同步清理 | #9"连带清理（#6）"章节 + index.ts:333 取证 | ✅ 闭合 |
| M4 | 漏项 | /goal abort 删除的兼容性未记录 | #1 兼容性章节显式列 "/goal abort 命令删除（commands.ts action 联合类型移除 abort）" | ✅ 闭合 |

无残余 gap。round-1 的连锁风险图（F2 → #5 → #6 兜底失效；M2 → coding-workflow 破坏）两条链路均在定稿中从根因层闭合。

---

## 五维度审查

### 维度 1：内部一致性 — PASS

**矩阵↔正文**：12 issue × 7 维度 = 84 cell 逐一核对，全部一致。每个⚠️ cell 在正文有对应章节，每个正文风险在矩阵有对应 cell。无"矩阵虚高"或"正文漏写"。

**persistState/persistAndUpdate 修正**：定稿内部全程一致使用"事件路径 = persistAndUpdate，command/tool 路径 = persistState"。该修正与上游 issues.md/system-architecture.md（均写 persistState）的**命名分歧**被正确地以 critical callout 浮出，而非掩盖。这是 NFR 应有的行为——用代码取证纠正上游事实错误。下游 code-architecture 拿到的是经取证的事实，不是上游的笔误。

**唯一观察（非阻塞）**：#1 矩阵标 性能✅，但正文 #1 无"性能影响"小节。✅=无风险，而删代码本身确无性能风险（自明），故不构成矛盾；若追求每 cell 可追溯，可补一行"代码删除，无性能影响"。属打磨项，不影响交接。

### 维度 2：上游对齐 — PASS

issues.md 的 12 个已决策方案（均方案 A）在 NFR 矩阵全部有行，7 维度 cell 无空缺。N/A cell 有统一理由（安全全 N/A：进程内单用户无注入面；性能多数 N/A：goal 低频无 QPS 压力）+ 单 session 假设声明。

issues.md 的"P3 延后项"（3 项：预警 flag 合并、budget.ts 拆分、prompts.ts 拆分）NFR 未覆盖——正确，这些是显式延后项，不在本轮决策范围。

决策引用（D21/D25/D-A3 等）在风险接受理由处正确引用，未滥用。

### 维度 3：可执行性 — PASS

下游 code-architecture 能直接据此设计。关键可执行要素齐备：

- **代码取证锚点**：#5/#9 均带 file:line（tool-handlers.ts:510-518、compact.ts:90、index.ts:333、event-adapter persistAndUpdate 路径），不是空泛建议。
- **检查点修正已交代**：critical callout 明确"#5 验收标准需修正——检查点在 persistAndUpdate，非 persistState。#4 拆分时 budget 检查逻辑随之迁移"。code-architecture 不会照搬上游错误的函数名。
- **数据迁移规则**：HTML 有统一迁移表（tasks/stallCount/maxTurns/maxStallTurns 四字段，反序列化忽略不 throw）。
- **降级路径**：HTML 有 __todoGetList/__planStart undefined 降级表，逐功能列明行为。
- **残余风险监控**：登记表 4 项均带监控方式。

**留给 code-architecture 的开放决策（合理）**：persistState（command/tool 路径）与 persistAndUpdate（事件路径）是否在 #4 拆分后统一为一个函数，属代码架构决策，NFR 不应代决。NFR 已用"#4 拆分后的等价函数"措辞留出空间，恰当。

### 维度 4：完整性 — PASS

逐项核对：每个⚠️均有缓解方案；每个无法消除的风险均显式进入残余风险登记表，附"接受理由"+"监控方式"两列。

最严重的残余风险"agent 不调 complete → goal 不终态"显式接受为 D21 代价，其兜底链（budget 检查在 persistAndUpdate）经 F2 闭合后已从根因层可靠。round-1 担心的"#6 兜底失效"连锁已不存在。

#4 残余风险标"无"，论据是"单线程 + 闭包可见性保证"——成立（已声明单 session 前提）。

### 维度 5：可视化质量 — PASS

风险矩阵热力图 84 cell 与 MD 矩阵逐格一致（已三向核对 MD↔正文↔HTML）。CSS 类正确：risk-ok 绿（✅）、risk-warn 琥珀（⚠️）、risk-na 灰（—）。图例完整，❌ 标注"本设计无此项"与正文一致（全表无❌ cell）。

HTML 的合成章节（关键副作用 critical callout、数据迁移表、降级策略表、残余风险登记表）均准确镜像 MD 内容，无信息丢失或新增未经核实的陈述。footer 正确声明 MD 为真相源。

---

## 非阻塞观察（供后续打磨，不影响 APPROVED）

1. **#1 性能✅ cell 无正文小节**：补一行"代码删除，无性能影响"可提升每 cell 可追溯性。
2. **persistState/persistAndUpdate 双函数命名**：定稿已澄清职责分工，但上游 issues.md #5 验收标准与 system-architecture §10/AC-7 仍写 persistState。建议 code-architecture 阶段同步修正上游文档的函数名，或在 code-architecture.md 中显式记录"上游 persistState 指代事件路径 persist 函数"的术语映射，避免下游 dev 阶段按字面 grep 落空。

---

## 给下游 code-architecture 的交接确认

- 可直接进入 Step 5（code-architecture）。
- 必读锚点：#5 critical callout（检查点函数修正）、#9 兼容性（三方契约 + inline alias drift）、#7×#10 交叉副作用（todo 缺失时 prompt 降级）。
- 上游术语映射需注意：上游 persistState ≡ NFR 定稿的 persistAndUpdate（事件路径）。
