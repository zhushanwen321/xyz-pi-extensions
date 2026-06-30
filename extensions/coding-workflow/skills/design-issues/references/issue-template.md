# Issue 模板（P0-P3 优先级 + 方案对比）

> 每个 issue 的标准结构。P 级采用 MoSCoW 语义——决定做不做、先后顺序。

## Issue 结构

```markdown
## #{N}: {问题标题}

**P 级**: P0 / P1 / P2 / P3
**类型**: 架构 / 模块 / 模型 / 流程
**Blocked by**: #{N}, #{N}（依赖的其他 issue，无则「无」）
**推荐强度**: Strong / Worth exploring / Speculative

### 问题描述

{这个 issue 是什么。具体说清楚要解决的问题。}
关联 system-architecture.md 的哪个章节/挑战。

### 为什么是这个 P 级

- **P0（必须先做，阻塞）**: {不做则后续 issue 无法推进 / 核心目标无法达成}
- **P1（核心）**: {业务目标的关键路径}
- **P2（重要）**: {提升质量但不阻塞核心}
- **P3（可延后）**: {后续迭代处理，标注延后理由}

### 方案对比

> P0/P1 issue 强制 ≥ 2 个方案对比。P2/P3 可只给推荐方案 + 一句理由。
> 复杂的根本性 issue 用并行 subagent 发散（见 DESIGN-IT-TWICE 机制）。

#### 方案 A: {方案名}

**改动**:
- 架构: {如何改}
- 模块: {新增/修改/删除哪些}
- 模型: {数据结构如何变}
- 流程: {业务/数据流程如何改}

**优点**: {基于系统性质，不是「简单」}
**缺点**: {真实的代价}
**适用场景**: {什么情况下这个方案最优}

#### 方案 B: {方案名}

（同上结构）

#### 方案 C: {方案名}（如有）

（同上结构）

### 取舍决策

**选择**: {方案 X}
**理由**: {基于系统性质。优先考虑长期、合理的架构设计，提供高可扩展性。
较少考虑成本问题。}

**放弃方案的理由**:
- 方案 Y: {为什么不选——基于系统性质，不是「暂时不做」}

### 验收标准

> 每 issue 的 AC 必须 trace 回 clarity 的 UC AC，并补充本 issue 方案特有的维度。

- [ ] AC-{N}.1 [正常]（trace: UC-{M} AC-{M}.X）: {条件}
- [ ] AC-{N}.2 [边界]: {min/max/空/单元素}
- [ ] AC-{N}.3 [异常]: {时序图对应 alt 分支}
- [ ] AC-{N}.4 [并发]（当 NFR④ 标注时）: {竞态/幂等条件}
```

## P 级定义（MoSCoW 语义）

| P 级 | MoSCoW | 含义 | 对 Wave 编排的影响 |
|------|--------|------|-------------------|
| **P0** | Must (first) | 阻塞项——不做则后续无法推进 | 在最前的 Wave，无依赖前置 |
| **P1** | Must | 核心目标的关键路径 | 前几个 Wave，依赖 P0 |
| **P2** | Should | 重要但非关键 | 中后段 Wave，可与 P1 并行（如无文件冲突）|
| **P3** | Could / Won't (this round) | 可延后到后续迭代 | 标注「后续迭代」，不在本次 Wave 编排 |

## 推荐强度（移植 improve-codebase-architecture）

| 强度 | 含义 |
|------|------|
| **Strong** | 有充分依据，强烈推荐此方案 |
| **Worth exploring** | 方向合理，但需进一步验证（可能触发 prototype）|
| **Speculative** | 探索性的，不确定是否值得 |

## DESIGN-IT-TWICE 机制（复杂 issue 强制发散）

对于**根本性架构选择**（如「DDD 四层 vs 三层」「统一入口 vs 双入口」），
强制用并行 subagent 发散，避免锚定在第一个方案。

### 何时用

- issue 涉及核心模型/分层/状态机的根本性选择
- 第一个想到的方案明显不一定是最优（Ousterhout: "your first idea is unlikely to be the best"）

### 流程

1. 主 agent 写问题空间说明（约束 + 依赖分类 + 粗略代码 sketch）
2. 派 3+ subagent 并行，每个给**不同设计约束**（radically different 的来源——约束不同，不是改名分身）：
   - Agent 1: 「最小化 interface——1-3 个入口，最大化 leverage」
   - Agent 2: 「最大化灵活性——支持多种用例和扩展」
   - Agent 3: 「优化最常见 caller——让默认情况 trivial」
3. 每个 subagent 按**固定 slot 表**产出（结构化，不是自由文档）：

   | slot | 内容 | 约束 |
   |------|------|------|
   | **interface sketch** | 接口签名/入口形状（伪代码或类型） | 1 块 |
   | **使用示例** | 1 个 caller 视角的真实调用片段 | 1 个 |
   | **trade-off** | 3 条取舍点（每条：得 X / 付 Y） | 3 条 |
   | **hidden-cost** | 背后藏了什么（隐含约束/耦合/技术债） | 1 行 |
   | **其他权衡**（开放兜底） | slot 之外的真 radically different 权衡 | 可空 |

   > slot 化只是**结构化产出**，不压创新——§2 约束不同才保证 radically different，开放 slot 兜底防 slot 太死。
4. 主 agent 收敛 = **逐 slot diff**（不是读 3 篇自由文档）：同 slot 横向对比 3 方案。给用户决策时**用同一 slot 表**呈现 3 方案差异，再给 opinionated 推荐（最终选定仍必须 ask_user，见 SKILL.md Step1 决策点 #3）。

详见 system-architecture skill 的 codebase-design 词汇引用。
