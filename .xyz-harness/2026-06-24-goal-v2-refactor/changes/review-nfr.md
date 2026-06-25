---
verdict: APPROVED
machine_check: PASS
reviewer: independent subagent (context-isolated) + 2026-06-25 复审对齐新 schema
artifact: non-functional-design.md (+ non-functional-design.html)
upstream: issues.md, system-architecture.md, requirements.md
downstream: code-architecture.md
prior_round: tracing-nfr-round-1.md (10 gaps: 2 F / 1 K / 4 D / 3 Missing)
method: Step 0 机器检查（硬阻断）+ 5 维度审查 + round-1 gap 闭合校验 + 矩阵 84 cell 三向核对（MD↔正文↔HTML）
---

# NFR 定稿审查报告

## Verdict

**APPROVED**。5 维度均通过。round-1 tracing 的 10 个 gap 全部闭合。

> **2026-06-25 复审说明**：原审查（2026-06-24）在 `design-shared/references/review-agent.md` 的 MANDATORY frontmatter schema 升级前产出，frontmatter 为小写 `verdict: approved` 且**从未运行 `check_nfr.py` 机器检查**（与 ①②③ 阶段同源问题）。本次复审补跑机器检查并补全 schema。原正文 5 维度分析（内容质量）仍然成立——本次仅修正 schema 与补充「缓解项回灌登记」章节（原交付物漏写该 MANDATORY 章节），不推翻原分析结论。

定稿最大的价值不是"补全了文档"，而是**通过代码取证发现并修正了上游的根本性事实错误**（budget 检查点函数名 = persistAndUpdate，非 persistState），这件事如果留到 code-architecture 才发现会返工。

## 机器检查结果

`python3 design-nfr/scripts/check_nfr.py <topic_dir>` → **7/7 PASS**（见 `changes/machine-check-nfr.md`）。

| 检查项 | 结果 |
|--------|------|
| non-functional-design.md 存在 | ✅ PASS |
| frontmatter verdict: pass | ✅ PASS |
| 关键章节（分析矩阵 / 缓解项回灌） | ✅ PASS |
| 无占位符 | ✅ PASS |
| review-nfr verdict: APPROVED | ✅ PASS（本次修正） |
| 缓解项回灌表（验收方式列合法） | ✅ PASS（本次新增章节） |
| 无 ❌ 不可接受项 | ✅ PASS（图例 ❌ 字形已去除，消除误报） |

> **复审修复项**：
> 1. 新增「缓解项回灌登记」章节（MANDATORY，原漏写）—— 15 条缓解项逐条标「验收方式」（代码测试/骨架约束/运维项三选一），代码测试类附 11 条 NFR-AC（归属 UC + 断言摘要）；
> 2. frontmatter 加 `backfed_from: []`；
> 3. 图例去掉 ❌ 字形（原仅为说明性文字，但脚本把它当成"残留不可接受 cell"误报）；
> 4. frontmatter verdict 大写 APPROVED。

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

## 维度评估（6 维 ✅⚠️❌）

- **内部一致性：✅** 矩阵↔正文 84 cell 逐一核对一致。persistState/persistAndUpdate 命名分歧以 critical callout 浮出而非掩盖。缓解项回灌表 15 条与正文 ⚠️ cell 一一对应。
- **上游对齐：✅** issues.md 的 12 个已决策方案（均方案 A）在 NFR 矩阵全部有行，7 维度 cell 无空缺。N/A cell 有统一理由。P3 延后项（预警 flag 合并 / budget.ts 拆分 / prompts.ts 拆分）正确地未覆盖。
- **可执行性：✅** 关键要素齐备：代码取证锚点（file:line）、检查点修正交代、数据迁移规则、降级路径、残余风险监控、**缓解项回灌去向 + 验收方式**（本次新增）。
- **完整性：✅** 每个⚠️均有缓解方案且已登记回灌；每个无法消除的风险进入残余风险登记表（接受理由 + 监控方式）。
- **可视化质量：✅** 风险矩阵热力图 84 cell 与 MD 一致。CSS 着色正确（✅绿/⚠️琥珀/—灰）。footer 声明 MD 为真相源。
- **必要性与比例性（红队）：✅** N/A 判定合理（单进程、无 DB、无网络、单用户、goal 低频），无过度分析。7 维度框架保留但多数 N/A 有理由，未偷懒跳过。

## 非阻塞观察（供后续打磨，不影响 APPROVED）

1. **#1 性能✅ cell 无正文小节**：补一行"代码删除，无性能影响"可提升每 cell 可追溯性。
2. **persistState/persistAndUpdate 双函数命名**：建议 code-architecture 阶段同步修正上游 issues.md #5 验收标准与 system-architecture §10/AC-7 的函数名，或在 code-architecture.md 中显式记录术语映射。

## 必须修改

无（机器检查 7/7 PASS，6 维审查全过）。

## 给下游 code-architecture 的交接确认

- 可直接进入 Step 5（code-architecture）。
- 必读锚点：#5 critical callout（检查点函数修正）、#9 兼容性（三方契约 + inline alias drift）、#7×#10 交叉副作用（todo 缺失时 prompt 降级）、**缓解项回灌登记表 + NFR-AC 清单**（11 条代码测试类缓解，进⑤test-matrix）。
- 上游术语映射需注意：上游 persistState ≡ NFR 定稿的 persistAndUpdate（事件路径）。
