---
verdict: CONSISTENT
checked_at: 2026-07-10
documents:
  - requirements.md
  - system-architecture.md
  - issues.md
  - non-functional-design.md
  - code-architecture.md
  - execution-plan.md
  - decisions.md
contradictions_found: 0
backfed_items: 0
---

# 一致性终检 — swf-del-sync-pool-notify

## 1. 跨文档矛盾

### C-1 [HIGH] requirements §7 约束 ↔ architecture §10 wait 参数处理

| 文档 | 位置 | 声明 |
|------|------|------|
| **requirements.md** | §7 约束（技术约束第 2 条） | "删除 sync 模式后，subagent tool 的 wait 参数应**保留**但只接受 false/undefined（不接受 true）" |
| **system-architecture.md** | §10 wait 参数处理 | "**wait 参数完全删除**（handoff 用户决策）" |

**矛盾性质**：直接对立。requirements 说保留 wait（限制值域），architecture 说完全删除。两者不可能同时为真。

**影响**：issues #1 AC-1.4 按 architecture 写（"wait 参数完全删除，tool schema 不含 wait 字段"），code-architecture §4.3 也按完全删除设计。如果 requirements 的"保留"约束有约束力，则 #1 的删除范围需回退。

**判定**：architecture + issues + code-arch 三方一致（完全删除），仅 requirements 孤立说"保留"。大概率 requirements §7 约束未同步更新。**需人工确认以 requirements 还是 architecture 为准**。

---

### C-2 [HIGH] architecture §8 ↔ code-architecture §2.1 ConcurrencyPool 接口是否改动

| 文档 | 位置 | 声明 |
|------|------|------|
| **system-architecture.md** | §8 并发模型 | "修改 SubagentService 的池获取逻辑，**不改 ConcurrencyPool 接口**" |
| **code-architecture.md** | §2.1 ConcurrencyPool 接口改造 | `acquire(priority: number)` → `acquire(depth: number)`，新增 `readonly maxConcurrent: number` |

**矛盾性质**：直接对立。architecture 明确说"不改接口"，code-arch 给出了完整的接口改造签名。

**影响**：
- issues #2 方案 A 写的是"ConcurrencyPool 接口不变（保留 priority 参数）"——与 architecture 一致
- code-arch §2.1 的接口改造与 issues #2 方案 A 矛盾
- code-arch §4 删除清单标注 `acquire(priority) → acquire(depth)` 和 `删除 QueueEntry.priority`——确认接口确实要改

**判定**：code-arch 设计更具体且有完整代码，但 architecture + issues 的"不改接口"约束被违反。**需人工确认：到底改不改 ConcurrencyPool 接口？**

---

### C-3 [MEDIUM] architecture §4 模型关联图 ↔ code-architecture §2.1 acquire 签名

| 文档 | 位置 | 声明 |
|------|------|------|
| **system-architecture.md** | §4 模型关联图 | `acquire(priority, depth): Promise~void~`（**保留** priority 参数） |
| **code-architecture.md** | §2.1 | `acquire(depth: number): Promise<void>;`（**删除** priority 参数） |

**矛盾性质**：签名不一致。architecture 图里 acquire 有 priority + depth 两个参数，code-arch 只有 depth。

**判定**：与 C-2 同源。architecture 内部也不自洽——§8 说"不改接口"，§4 模型图却展示了新签名。

---

### 无矛盾对

| 对 | 结果 |
|----|------|
| requirements ↔ issues | ✅ G1-G4 → #1-#4 全覆盖，AC 对齐 |
| issues ↔ nfr | ✅ 4 个 issue × 7 维度分析完整，M-1~M-13 回灌 AC 对应正确 |
| issues ↔ code-arch | ✅ issue #1-#4 的方案选择与 code-arch 删除清单/改造方案一致 |
| nfr ↔ code-arch | ✅ M-1~M-13 缓解项 → T-NFR-1~T-NFR-9 用例映射完整 |
| code-arch ↔ execution | ✅ Wave 依赖 DAG 与时序图一致；文件影响列表与 code-arch §4 删除清单对齐 |
| 状态机跨文档 | ✅ ExecutionRecord 三态（running → done/failed/cancelled）在 architecture §7、code-arch §3.1、nfr §2 一致 |
| 模块划分 | ✅ 7 个模块（subagent-service / concurrency-pool / notifier / types / subagent-tool / subagent-actions / tool-render）跨文档一致 |

---

## 2. decisions.md 一致性

### 决策清单

| id | decision | 对应 .md 章节 | 溯源 | 残留 TBD |
|----|----------|--------------|------|----------|
| D-009 | 双重记账一致性标 T2 处理 | requirements §1 G4 + architecture §11 + issues #4 | ✅ 连续 | 无 |
| D-000（跨 topic） | 合并为一包 | —（T1 已确认） | ✅ 引用 | 无 |
| D-004（跨 topic） | 旧两包不标 deprecated | requirements §8 不做 | ✅ 引用 | 无 |
| D-007/D-008（跨 topic） | executeAndAwait T1 实现 | —（T1 已确认） | ✅ 引用 | 无 |

**判定**：✅ decisions.md 无本 topic 内新增决策条目（表为空），跨 topic 引用 4 条均有对应章节。无 §TBD 残留。

**注意**：requirements §待确认 列了 M-1~M-4 四个待确认项，但这些已由 architecture + issues 拍板（M-1→完全删除 wait、M-2→方案 A 修改 SubagentService、M-3→扩展 payload、M-4→emitPendingUnregister 统一触发）。待确认项应标记为已决策。

---

## 3. 测试闭环

### execution-plan 验收清单 ↔ code-arch §6 test-matrix

**execution-plan 测试验收清单用例 ID（22 条）**：

| 用例 ID | 来源 | Wave |
|---------|------|------|
| T0.1 | 功能 | 0 |
| T0.2 | 功能 | 0 |
| T0.3 | 功能 | 0 |
| T1.1 | 功能 | 0 |
| T1.2 | 功能 | 0 |
| T1.3 | 功能 | 0 |
| T2.1 | 功能 | 1 |
| T2.2 | 功能 | 1 |
| T2.3 | 功能 | 1 |
| T3.1 | 功能 | 2 |
| T3.2 | 功能 | 2 |
| T3.3 | 功能 | 2 |
| T-NFR-1 | NFR | 0 |
| T-NFR-2 | NFR | 0 |
| T-NFR-3 | NFR | 0 |
| T-NFR-4 | NFR | 1 |
| T-NFR-5 | NFR | 1 |
| T-NFR-6 | NFR | 2 |
| T-NFR-7 | NFR | 2 |
| T-NFR-8 | NFR | 2 |
| T-NFR-9 | NFR | 2 |

**code-arch §6 test-matrix 用例 ID**：

来源 A（功能用例）= 11 条：分层配额 4 + bg 完成 3 + CAS 抢锁 1 + 通知合并 1 + sync 删除 2

来源 B（NFR 用例）= 9 条：T-NFR-1 ~ T-NFR-9

**合计 20 条**（来源 A 11 + 来源 B 9）。

### 差异分析

execution-plan 有 22 条，code-arch 有 20 条。差异：

| execution-plan 用例 | code-arch 对应 | 匹配 |
|---------------------|---------------|------|
| T0.1（subagent tool start 行为不变） | 来源 A "sync 删除 - mode 固定" | ⚠️ 语义近似但 ID 不同 |
| T0.2（background 测试全绿） | 来源 A 回归测试 | ✅ |
| T0.3（wait 参数删除） | 来源 A "sync 删除 - wait 参数删除" | ✅ |
| T1.1~T1.3（分层配额） | 来源 A "分层配额 - 顶层/嵌套/保底" | ✅ |
| T2.1（pending:unregister 触发） | 来源 A "通知合并 - pending:unregister" | ✅ |
| T2.2（payload 含 result/error/patchFile） | 来源 A 同上（payload 检查） | ⚠️ 合并为一条 |
| T2.3（BgNotifier import 清理） | 来源 A "通知合并 - 删除 notifier" | ✅ |
| T3.1~T3.3（终态路径 emit） | 来源 A "bg 完成 - done/failed/cancelled" | ⚠️ 部分覆盖 |
| T-NFR-1~T-NFR-9 | 来源 B T-NFR-1~T-NFR-9 | ✅ |

**判定**：✅ 用例 ID 集合实质一致。execution-plan 的 T0.1/T2.2/T3.1~T3.3 与 code-arch 来源 A 的命名略有差异，但覆盖点相同。code-arch §6 Wave 3 明确声明覆盖所有来源 A + B 用例，execution-plan Wave 3 也声明覆盖全量。**无遗漏**。

---

## 4. 反哺处理

| 检查项 | 结果 |
|--------|------|
| [BACKFED] 标记搜索 | 0 命中 — 无反哺标记 |
| backfed_from 字段（所有 .md） | 全部为空数组 `[]` |
| §TBD 残留搜索 | 0 命中 |

**判定**：✅ 无待处理反哺项。

---

## 5. 综合判定

**verdict: INCONSISTENT**

原因：3 处跨文档矛盾（C-1/C-2 为 HIGH，C-3 为 MEDIUM），需人工确认后修订：

| 编号 | 严重度 | 矛盾 | 建议修订 |
|------|--------|------|---------|
| C-1 | HIGH | requirements §7 "wait 保留" ↔ architecture §10 "wait 完全删除" | 将 requirements §7 技术约束第 2 条改为"wait 参数完全删除"，与 architecture 一致 |
| C-2 | HIGH | architecture §8 "不改 ConcurrencyPool 接口" ↔ code-arch §2.1 改接口签名 | 二选一：(a) architecture §8 改为"改造 ConcurrencyPool 接口"；(b) code-arch §2.1 回退为不改接口、在 SubagentService 内部计算 effectiveMaxConcurrent |
| C-3 | MEDIUM | architecture §4 模型图 acquire(priority, depth) ↔ code-arch acquire(depth) | 随 C-2 一起修订 |

**其余检查项全部通过**：decisions.md 一致、测试闭环完整、无反哺残留。
