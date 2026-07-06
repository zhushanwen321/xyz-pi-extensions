---
name: coding-closeout
description: >-
  Use when the user says "设计收尾", "design closeout", "沉淀设计", "归档主题",
  "归档 topic", "archive topic", or after coding-execute + 测试验收全绿，需要把稳定结论
  沉淀进长期文档 (ARCHITECTURE/PRODUCT/NFR/ADR/TEST-STRATEGY) 并归档 .xyz-harness/{topic}.
  设计→实施→沉淀闭环的最后一步。对应 CW action: closeout (status 流转到 closed 终态).
  Not for full-* phases themselves, not for 回顾执行质量 (那是 harness-retrospect),
  not for 需求澄清或编码实现。
---

# 设计收尾（Design Closeout）

> **对应 CW action: `closeout`**（coding-workflow tool）。本 skill 沉淀稳定结论进长期文档后，
> 调 `cw(action=closeout, topicId)` 通过 CW closeout gate（CW closeout 机器检查 + evidence 填充：
> closedAt / coverage / 完整 gateHistory）。status 流转到 `closed`（终态不可逆，D-009）。
> CW 返回 nextAction.action 为空 = 流程结束。

## 核心目标

把本次主题（`.xyz-harness/{topic}/`）经设计+实施验证的**稳定结论**沉淀进长期文档（位置跟随主配置，详见 coding-init「文档位置推断」），
让下一次设计能站在本次结论上继续，而非从零开始或重复发现已知问题。

> **闭合沉淀管道的最后一步。** ①-⑥产出 → 实施验证 → **closeout 沉淀** → 下次 coding-init 回读对账。
> 没有 closeout，①-⑥产出随 topic 归档流失，长期文档永远空或过时。

## 职责边界（防混淆）

| skill | 干什么 | 时机 |
|-------|--------|------|
| coding-init | 建长期文档**容器** + 回读验证 | 设计开始前 |
| ①-⑥ | 设计产出，写 `.xyz-harness/{topic}/` | 设计中 |
| **coding-closeout（本 skill）** | topic 产出**沉淀**进长期文档 + 归档 | 编码实施后 |
| xyz-harness-retrospect | 回顾**执行质量**（流程顺不顺） | 任意 |

closeout 沉淀**设计产出**（信息归位），retrospect 回顾**执行过程**（质量复盘），正交不合并。

## 显式不做（边界纪律）

1. **不进 design_status 7 阶段状态机**——closeout 在⑥之后、隔着外部实施时间，线性状态机表达不了"等外部完成"。用自己的 gate（ARCHIVED.md + closeout-report）。
2. **不自动触发**——沉淀是判断动作（选哪几条留），自动跑要么全留（噪音）要么漏留（流失）。手动 + ask_user 逐项确认。
3. **不重审代码好坏**——只沉淀**经代码验证**的约束（Step1 核对），不评判实现质量（那是 review/test 的活）。

## 触发与前置

**触发：** 用户手动 `/coding-closeout [topic]`。未指定 topic 则取 `.xyz-harness/` 下最近修改且无 `ARCHIVED.md` 的目录。

**前置校验（不满足则拒绝并提示）：**
1. `{topic}/execution-plan.md` 存在且 `verdict: pass`（full ⑥或 mid-detail-plan 产出均可）
2. 实施代码已存在：`{topic}/code-skeleton/` 有内容，或项目源码有对应改动（grep ⑥/mid 测试验收清单关键符号能命中）
3. 测试验收已执行：`{topic}/changes/test-results.json` 存在且 coding-execute 的执行收尾机器门 PASS（lite/mid 均适用）；若无此文件说明未经 coding-execute 机器门，需人肉确认测试验收清单全绿
4. `{topic}` 未被归档（无 `ARCHIVED.md`）

> **未实施的 topic 不允许 closeout**——否则沉淀的是纸面设计（如④缓解方案未落地），不是验证过的约束。
> 用户坚持（如原型放弃实施但仍想留设计）须 ask_user 显式确认「沉淀未验证设计」风险。

## 执行流程（轻量，不走 loop-skeleton 6 步）

归档动作，**不接入** loop-skeleton 追踪/审查机制——沉淀是确定性动作（查表分发 + ask_user 确认），套 6 步循环是过度工程。套用 coding-init 轻量范式：扫描 → 报告 → 逐项确认 → 执行。

### Step 1. 扫描 + 代码一致性验证（防腐烂闸门，本 skill 核心价值）

**1a. 扫描 topic 产出：** 列 `{topic}/` 下 6 个 deliverable + `code-skeleton/` + `changes/` + **`decisions.md`（决策账本，Step 2 抽 ADR 的权威源）**。

**1b. [核心] 代码一致性验证——只沉淀经代码验证的约束：**

读 ④`non-functional-design.md` 每条「缓解项」，到代码（`code-skeleton/` 或项目源码）找落地证据：

| ④约束类型 | 验证方式（grep） | 找到证据 | 找不到证据 |
|----------|-----------------|---------|-----------|
| 幂等 | `idempotency\|Idempotent\|幂等` | ✅ 可沉淀 | ❌ `[UNVERIFIED]` |
| 脱敏/PII | 字段名 + 脱敏函数 | ✅ | ❌ `[UNVERIFIED]` |
| 锁/并发 | 锁原语/事务注解 | ✅ | ❌ `[UNVERIFIED]` |
| 可观测埋点 | `log\|metric\|trace\|span` | ✅ | ❌ `[UNVERIFIED]` |

**`[UNVERIFIED]` 机制是防腐烂硬约束**——堵住"纸面约束沉淀进 NFR.md，代码根本没实现"的脱节。
所有 `[UNVERIFIED]` 项**不进 NFR.md**，记入 closeout-report.md 待补，交接时显式报告数量。

同时对 ②状态机/模块做代码核对（本次设计是否真落地，与 coding-init 回读验证方向互补）。

### Step 2. 沉淀分发（按规则表，每项 ask_user 确认）

核心 spec 见 `references/distill-rules.md`（沉淀规则表 + 提取判据）。主 agent 读规则表，
对 topic 产出逐项判断「提炼进哪 / 留 topic / 清理」，**每条提炼都 ask_user 确认**（沉淀是不可逆信息归位，须人拍板）。

**强制溯源：** 每条沉淀标注 `[from: {topic} §{章节}]`。缺溯源 = CW closeout 机器检查报错。
**去重：** 沉淀前 grep 目标文档现有 ID（如 NFR `S-1..S-N`），避免重复编号。
**文档位置：** 分发表中的 PRODUCT/ARCHITECTURE/NFR/TEST-STRATEGY/DESIGN-LOG 建在主配置（AGENTS.md/CLAUDE.md）所在目录，与 coding-init 一致；`docs/adr/` 路径相对项目根不变。

分发表（详见 distill-rules.md）：

| 源 | 提炼进 | 提取判据一句话 |
|----|--------|---------------|
| ①requirements | PRODUCT.md + CONTEXT.md | 产品级（去主题名仍成立）/ 领域术语 |
| ②system-arch | ARCHITECTURE.md | 当前代码结构映射（覆盖更新） |
| ③issues | `docs/adr/NNN-{slug}.md` | P0/P1 且 D-不可逆 的取舍 |
| ④nfr | **NFR.md** | 代码已验证的约束 + 残余风险 |
| ⑤code-arch | `docs/architecture/sequence/` | 跨主题复用核心时序图（≤3张） |
| ⑥execution | TEST-STRATEGY.md | 破坏即事故的基线用例 |

### Step 3. 清理 + 归档标记

**3a. 清理过程产物：**
- 删 `{topic}/changes/` 全部（tracing/review/backfeed/machine-check/consistency-final 全是过程产物）
- 删 `{topic}/*.html`（coding-visualizer 可重新生成，归档态不需可视化）
- **`decisions.md` 保留**（不清理）——它是本 topic 的决策审计链（append-only，含 revisit 记录）。Step 2 抽 ADR 只取 status=confirmed 的 D-不可逆决策，但 decisions.md 的完整历史（含 D-可逆决策、revisit 链）是归档态有价值的事后追溯材料，随 topic 保留

**3b. 归档标记：**
- 写 `{topic}/ARCHIVED.md`：一句话主题说明 + 沉淀去向清单（哪条进了哪个文件）
- 更新 `docs/DESIGN-LOG.md`：该 topic 状态 → `archived`，沉淀去向列填齐

### Step 4. 生成 closeout-report + 自跑机器检查

写 `{topic}/closeout-report.md`（frontmatter: `archived: true, unverified_count: N`）：
- 沉淀清单（每条：源 deliverable + 目标文档 + 溯源）
- `[UNVERIFIED]` 清单（待补约束，标④原 issue + 缺失证据）
- 清理记录

然后调 `cw(action=closeout, topicId)`——机器检查由 CW gate 在 `cw(action=closeout)` 调用时自动执行（归档完整性校验：ARCHIVED.md 存在、溯源标注齐全、清理记录完整）。gate FAIL（exit 1）修硬伤后重调 cw。

## 交接

```
✅ 设计收尾完成。{topic} 已归档（只读）。
   沉淀去向：
     PRODUCT.md ← 愿景/核心用户/非目标（{N}条）
     ARCHITECTURE.md ← 分层/状态机当前态
     ADR-{NN} ← 不可逆决策（{N}条）
     NFR.md ← 工程约束（{N}条，已代码验证）
     TEST-STRATEGY.md ← 基线用例（{N}条）
   ⚠️ [UNVERIFIED] 约束 {M} 条未沉淀（代码未落地），见 closeout-report.md。
      补齐代码后可重跑 /coding-closeout {topic} 补沉淀。

设计→实施→沉淀闭环已闭合。下次设计 /coding-init 会回读这些文档，检测是否过时。
```

## 何时跳过本步

- 纯原型/实验项目，topic 用完即弃，无需长期沉淀 → 跳过，直接删 topic 目录
- ⑥未完成或编码未实施 → 拒绝（前置校验失败）
- 已归档 topic 需补沉淀 `[UNVERIFIED]` 项 → 可重新打开归档态运行

## 标记说明

| 标记 | 含义 |
|------|------|
| `[UNVERIFIED]` | ④约束未在代码找到落地证据，不沉淀，记 closeout-report 待补 |
| `[from: {topic} §X]` | 沉淀溯源标记，每条沉淀必须带 |
| `[STALE]` | 长期文档与代码不一致（coding-init 回读时标；本 skill 沉淀时若发现也标注） |
