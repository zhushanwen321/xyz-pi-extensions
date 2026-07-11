---
verdict: CHANGES_REQUESTED
reviewer: execution-align (Wave 依赖 + 测试闭环)
date: 2026-07-10
---

# Execution Plan 审查报告 — Wave 依赖 + 测试闭环

## Step 0: 机器检查

`machine-check-execution.md` 不存在，无 PASS/FAIL 硬阻断。直接进入认知帧审查。

---

## Step 1: 认知帧审查结果

### 总判: CHANGES_REQUESTED

发现 1 个阻断问题 + 2 个建议改进。

---

## 阻断问题

### B-1: Wave 0 与 Wave 1 的并行约束声称不成立

**位置**: execution-plan.md §并行约束 + §Wave 0 + §Wave 1

**声称**:
> Wave 0 和 Wave 1 可并行（不改同文件：Wave 0 改 subagent-service.ts sync 分支 + types.ts + subagent-tool.ts；Wave 1 改 concurrency-pool.ts）

**实际文件影响**:
- Wave 0 文件影响: `subagent-tool.ts`, **`subagent-service.ts`**, `types.ts`, `subagent-actions.ts`, `tool-render.ts`
- Wave 1 文件影响: **`concurrency-pool.ts`**, **`subagent-service.ts`**

**冲突**: 两个 Wave 都修改 `subagent-service.ts`。Wave 0 删除 resolveMode/sync 分支/PRIORITY_SYNC/notifier 引用; Wave 1 将 `pool.acquire(priority)` 改为 `pool.acquire(depth)`。虽然改的是不同函数（execute vs runAndFinalize），但同文件并行写入在 git merge 层面有冲突风险，调度器层面也无法安全并行。

**建议**: 两种修正方案（任选一）:
1. **串行化**: Wave 1 depends on Wave 0（或反过来），调度表改为串行
2. **拆分 Wave**: 将 Wave 1 中 `subagent-service.ts` 的 acquire 调用改动移入 Wave 0 或 Wave 3，保持 Wave 1 只改 `concurrency-pool.ts`

---

## 审查维度逐项

### 维度 1: Wave 依赖 DAG 与 code-arch 时序图一致性

**结果**: PASS（逻辑一致）

| DAG 依赖 | code-arch 时序图对应 | 一致性 |
|----------|---------------------|--------|
| W0→W2 | §3.1 时序图：sync 删除后简化通知路径 | 一致 |
| W2→W3 | §3.1 finalizeRecord emitPendingUnregister 后，W3 统一 record 生命周期 | 一致 |
| W0→W4 | 回归验证需要 W0 完成 | 一致 |
| W1→W4 | §3.2 并发池分层配额时序图 | 一致 |
| W1 ∥ W0 | **不一致** — 见 B-1 | **FAIL** |

### 维度 2: 测试验收清单全量

**结果**: PASS

**来源 A（功能用例）**:

| code-arch §6.2 来源 A 测试 | 覆盖点 | 对应用例 ID | 落地 Wave |
|---------------------------|---------|------------|----------|
| 分层配额 - 顶层 | depth=0 | T1.1 | W1 |
| 分层配额 - 嵌套 | depth=N | T1.2 | W1 |
| 分层配额 - 保底 | depth>=maxConcurrent | T1.3 | W1 |
| 分层配额 - FIFO | 纯 FIFO 出队 | 无独立 ID（被 T1.1~T1.3 隐含覆盖） | W1 |
| 通知合并 - pending:unregister | 事件触发+payload | T2.1+T2.2 | W2 |
| sync 删除 - wait 参数删除 | tool schema | T0.3 | W0 |
| sync 删除 - mode 固定 | execute 返回 mode="background" | T0.1（隐含） | W0 |

**来源 B（NFR 用例）**:

| NFR M-编号 | 测试 | 用例 ID | 落地 Wave | 覆盖? |
|-----------|------|---------|----------|-------|
| M-4 | 分层配额 debug 日志 | T-NFR-1 | W1 | ✅ |
| M-5 | 保底 1 槽位单测 | T-NFR-2 | W1 | ✅ |
| M-6 | 排队超时 warn 日志 | T-NFR-3 | W1 | ✅ |
| M-7 | emitPendingUnregister payload | T-NFR-4 | W2 | ✅ |
| M-9 | 容忍额外字段 | T-NFR-5 | W2 | ✅ |
| M-10 | WorkflowRun 同步在 finalizeRecord 内 | T-NFR-6 | W3 | ✅ |
| M-11 | WorkflowRun 同步不走异步回调 | T-NFR-7 | W3 | ✅ |
| M-12 | dispose() 路径终态化 | T-NFR-8 | W3 | ✅ |
| M-13 | finalizeRecord 入口 debug 日志 | T-NFR-9 | W3 | ✅ |

**M-1~M-3/M-8 无独立测试 ID 的理由**:
- M-1（全量搜索 sync 残留）: 由 T0.2 + T0.3 验收标准覆盖（grep + 测试全绿）
- M-2（session replay 兼容）: 由 T0.2 回归测试隐含覆盖
- M-3（agent .md 文档清理）: 非测试项，是实现任务
- M-8（pending-notifications 适配新 payload）: 由 T2.1 + T2.2 覆盖

### 维度 3: 每个 Wave 的 test-matrix 用例 ID 完整性

**结果**: PASS

| Wave | 声明覆盖的 ID | 实际应覆盖 | 完整? |
|------|-------------|-----------|-------|
| W0 | T0.1~T0.3 | T0.1~T0.3 | ✅ |
| W1 | T1.1~T1.3 | T1.1~T1.3, T-NFR-1~T-NFR-3 | ⚠️ 见 S-1 |
| W2 | T2.1~T2.3 | T2.1~T2.3, T-NFR-4~T-NFR-5 | ⚠️ 见 S-1 |
| W3 | T3.1~T3.3 | T3.1~T3.3, T-NFR-6~T-NFR-9 | ⚠️ 见 S-1 |
| W4 | 全量回归 | 全量回归 | ✅ |

### 维度 4: 并行约束正确性

**结果**: FAIL — 见 B-1

| 并行声称 | 同文件? | 正确? |
|---------|--------|-------|
| W0 ∥ W1 | 是（subagent-service.ts） | **FAIL** |
| W2 after W0 | — | ✅ |
| W3 after W2 | — | ✅ |
| W4 after all | — | ✅ |

### 维度 5: dependsOn/parallelGroup 一致性

**结果**: PASS（无矛盾，但 parallelGroup 未使用）

- 调度表: Wave 0/1 标注并行组 A，Wave 2 标注并行组 B，Wave 3 标注并行组 C
- 测试验收清单: dependsOn 正确（T2.x→T0.2, T3.x→T2.1），但 parallelGroup 列全部为 "—"
- **建议**: 测试清单的 parallelGroup 应与调度表对齐（T0.x→A, T1.x→A, T2.x→B, T3.x→C）

---

## 建议改进

### S-1: Wave 声明覆盖的 test ID 应包含 NFR 用例

Wave 1/2/3 的「覆盖的 test-matrix 用例 ID」只列了功能用例（T1.1~T1.3 等），未列 NFR 用例（T-NFR-1~T-NFR-9）。虽然这些 NFR 用例在测试验收清单中已正确分配到对应 Wave，但 Wave 描述中的声明不完整。

**建议**: 在每个 Wave 的「覆盖的 test-matrix 用例 ID」中补充对应的 NFR ID:
- Wave 1: 补 T-NFR-1, T-NFR-2, T-NFR-3
- Wave 2: 补 T-NFR-4, T-NFR-5
- Wave 3: 补 T-NFR-6, T-NFR-7, T-NFR-8, T-NFR-9

### S-2: 测试验收清单 parallelGroup 未填充

测试验收清单的 `parallelGroup` 列全部为 "—"，但调度表已定义并行组（A/B/C）。应填充以保持一致性。

---

## 总结

| 维度 | 判定 |
|------|------|
| 1. DAG vs 时序图一致性 | **FAIL**（B-1: W0/W1 同文件并行） |
| 2. 测试验收清单全量 | PASS |
| 3. Wave test-matrix 覆盖完整性 | PASS（有改进建议 S-1） |
| 4. 并行约束正确性 | **FAIL**（B-1） |
| 5. dependsOn/parallelGroup 一致性 | PASS（有改进建议 S-2） |

**最终判定**: **CHANGES_REQUESTED** — B-1 必须修复后才能进入编码执行。
