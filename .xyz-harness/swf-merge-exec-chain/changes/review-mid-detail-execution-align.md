---
phase: mid-detail → execution alignment review
reviewer: independent
verdict: F (executable)
---

# 执行计划对齐审查报告 — swf-merge-exec-chain

## 审查范围

- 上游：`.xyz-harness/swf-merge-exec-chain/code-architecture.md` §4（时序图）、§6（test-matrix）
- 中游：`.xyz-harness/swf-merge-exec-chain/issues.md`、`non-functional-design.md`、`decisions.md`
- 下游：`.xyz-harness/swf-merge-exec-chain/execution-plan.md`
- 机器检查：`.xyz-harness/swf-merge-exec-chain/changes/machine-check-execution.md`（PASS，28 用例集合相等）

## 检查项结论

### 1. Wave 依赖 DAG 是否从时序图正确推导？

**结论：一致。**

`execution-plan.md` 的 DAG 与 `code-architecture.md` §8 的 issue DAG 完全同构：

| Wave | 对应 Issue | 前置依赖 | 与 §8 DAG 一致性 |
|------|-----------|---------|----------------|
| W0 包结构合并 | #1 | — | ✅ 同 #1 |
| W1 executeAndAwait | #2 | W0 | ✅ 同 #2 |
| W2 schemaEnv bridge | #3 | W0 | ✅ 同 #3 |
| W3 重复代码消除 | #5 | W0 | ✅ 同 #5 |
| W4 SAR 委托重写 | #4 | W1, W2, W3 | ✅ 同 #4（#2+#3+#5 汇合） |
| W5 依赖声明更新 | #6 | W0 | ✅ 同 #6 |
| W6 全量测试+契约验证 | #7 | W4, W5 | ✅ 同 #7（#4+#6 汇合） |

`code-architecture.md` §4 UC-3 时序图明确 SAR.run 需要：
- `executeAndAwait`（W1 提供委托目标）
- `schemaEnv` 注入（W2 提供 childEnv 桥接）
- `live/jsonl-to-agent-event` 删除 + `onEvent` 升级（W3 提供重复代码消除后的类型化 AgentEvent）

因此 W4 依赖 W1+W2+W3 是从时序图直接推导出的合成依赖，非人为添加。并行组 A（W1/W2/W3/W5 只依赖 W0）符合「改不同文件无冲突」的 refactor 约束。

### 2. Wave 切片与 issue 映射是否一致？

**结论：一一对应，无错位。**

| Wave | 覆盖 Issue | P 级 | 说明 |
|------|-----------|------|------|
| W0 | #1 | P0 | 方案 A cp 新建，旧包不动（D-004） |
| W1 | #2 | P1 | 方案 A 独立方法 |
| W2 | #3 | P1 | 方案 A RunOptions 扩展 |
| W3 | #5 | P1 | D-A7 分类执行 |
| W4 | #4 | P1 | 方案 A per-session 注入 |
| W5 | #6 | P1 | extension-dependencies.json 更新 |
| W6 | #7 | P2 | 全量回归 + 下游契约 |

与 `issues.md` 的 issue 列表、方案选择、验收标准逐项核对后无偏离。

### 3. 每个功能 Wave 是否被 P0/P1 issue 覆盖？

**结论：全部覆盖，无悬空 Wave。**

- W0（P0）由 #1 覆盖
- W1-W5（P1）分别由 #2、#3、#5、#4、#6 覆盖
- W6（P2 验收 Wave）由 #7 覆盖

没有未映射到 issue 的功能切片，也没有 P0/P1 issue 未被 execution-plan 消化。

### 4. 测试验收清单是否全量覆盖 code-arch §6 来源 A + B？

**结论：集合相等，但存在文字不一致。**

`code-architecture.md` §6 来源 A 共 18 条：
- UC-3：T3.1–T3.12（12 条）
- UC-4：T4.1–T4.3（3 条）
- UC-5：T5.1–T5.3（3 条）

来源 B 共 10 条代码测试：
- T3.13、T3.14、T3.15、T3.16、T3.17、T3.18、T3.19、T3.20、T3.21、T5.4

合计 **28 条**，`machine-check-execution.md` 已验证「验收清单 = test-matrix 全量，28 个用例集合相等」。

`execution-plan.md` 前言写「来源 A（18 条）+ 来源 B（11 条）= 29 条」，但清单表格实际只列了 28 条（18+10）。这个 11 是把 `non-functional-design.md` 中「验收方式=人工」的 onEvent 性能项也计入了 NFR 总条数，但清单本身明确说明该人工项「不进本清单」。**这是文字描述小瑕疵，不影响实际覆盖完整性。**

建议：执行计划前言改为「来源 A（18 条）+ 来源 B（10 条代码测试）= 28 条；另 1 项 onEvent 性能人工观测」，与清单和机器检查保持一致。

### 5. 测试层分组与 downstream coding-execute 是否匹配？

**结论：匹配，但命名上存在 mock/unit 混用。**

`execution-plan.md` 测试层标签：
- `mock`：T3.1–T3.11、T4.1–T4.3、T5.1–T5.3（unit 层，不依赖真实 spawn）
- `e2e` / `real`：T3.12（真实 spawn pi 全链）
- `integration`：T3.13、T3.15、T3.17、T3.18、T3.20、T3.21、T5.4
- `unit`：T3.14、T3.16、T3.19

`code-architecture.md` §6 中同一批用例的测试层标注为：
- 来源 A：mock / real
- 来源 B：unit / integration

二者在工程含义上等价：`mock` 即 unit（mock 层），`real` 即 e2e（真实 spawn）。机器检查已认可该映射，下游 coding-execute 可按 unit/integration/e2e 分层跑，无需调整。

建议：如果希望严格对齐 test-matrix 的命名，可把执行计划表格中的 `mock` 改为 `unit`，但当前不影响执行。

### 6. 与 decisions 是否矛盾？

**结论：无矛盾。**

逐项核对：

| 决策 | 内容 | 执行计划体现 | 一致性 |
|------|------|-------------|--------|
| D-000 | 合并为一包 | W0 创建 subagents-workflow | ✅ |
| D-001 | T1 不做 sync/并发池/通知/脚本 | W1-W6 范围仅到执行链统一 + 测试 | ✅ |
| D-002 | 新包版本 1.0.0 | W0 package.json 1.0.0 | ✅ |
| D-003 | AgentRegistry 统一 | W3 删 agent-discovery，用 execution/agent-registry | ✅ |
| D-004 | 旧包不动 | W0 验收 AC-1.4「旧两包代码原样保留不动」 | ✅ |
| D-005 | onEvent 透传 + 删 jsonl-to-agent-event | W2/W3/W4 覆盖 onEvent 升级 + live 删除 | ✅ |
| D-006 | timeoutMs 在 SAR 合并 | W4 AC-4.2 timeoutMs 合并 signal | ✅ |
| D-007 | AgentResult 双类型映射 | W1 AC-2.1/2.2 + W1 映射函数 | ✅ |
| D-008 | SAR 用 ctxModel 填底 | W4 AC-4.5 model 填底 | ✅ |
| D-009 | 双重记账 T2 处理 | 执行计划范围不含 record 生命周期改造 | ✅ |

没有遗漏决策，也没有反向实现。

## 判定

**F（可执行）**

执行计划与 code-architecture、issues、non-functional-design、decisions 全部对齐。发现的两个小瑕疵均为文字不一致，不影响 DAG、issue 映射、测试覆盖集合和下游 coding-execute 分层执行：

1. 前言「29 条」应改为「28 条代码测试 + 1 项人工观测」。
2. 表格中 `mock` 标签若与 coding-execute 的 `unit` 分层命名需统一，可改为 `unit`。

机器检查 PASS（28 用例集合相等），可直接进入 coding-execute 阶段。
