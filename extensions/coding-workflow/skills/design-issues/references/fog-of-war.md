# Fog of War 决策图

> 移植自 Matt Pocock 的 decision-mapping skill。核心理念：
> **issue 不是一次性列完的静态清单，而是带依赖边的决策图，
> 逐个 agent session 解决、边做边发现新 issue。**

## 核心概念

### Fog of War（战争迷雾）

决策地图**故意在前沿之外不完整**。你的任务是调查前沿、逐个解决 issue、把前沿推进。
push back the fog of war, one node at a time.

在某个时刻，前沿已被推得足够远，通往终点的路径清晰可见——此时不再需要新 issue，
决策图视为「done」。

```
[已解决]     [前沿(正在解决)]    [迷雾(未探索)]
  #1 ✅ ──── #3 🔍 ──────── #5 ?
              │                #6 ?
              #4 🔍            #7 ? (可能不存在)
```

### Issue = 决策图节点

每个 issue 是图上的一个节点，有：
- **编号** `#{N}`
- **状态**: resolved(✅) / investigating(🔍) / fog(?)
- **Blocked by**: 依赖的其他 issue（图的边）
- **类型**: Research(查文档) / Prototype(写代码验证) / Discuss(对话决策)

### 依赖边 = Wave 编排的依据

issue 之间的 `blocked_by` 边，直接成为 Step 6（执行计划）Wave 编排的依据：
- 无依赖的 issue → 可并行（同一 Wave）
- 有依赖的 issue → 串行（不同 Wave，blocked_by 先做）

## 决策图文件格式

`issues.md` 本身就是决策图。结构：

```markdown
# Issue 决策图 — {主题}

## 地图总览

（Mermaid graph — 节点=issue，边=blocked_by，颜色/标注=状态）

```mermaid
graph LR
  #1[P0: 数据模型]:::resolved --> #3[P1: API层]:::investigating
  #2[P0: 认证模块]:::resolved --> #3
  #3 --> #5[? 状态机边界]:::fog
  #4[P2: 缓存]:::resolved
  classDef resolved fill:#90EE90
  classDef investigating fill:#FFD700
  classDef fog fill:#D3D3D3
```

## Issues

### #1: {标题} ✅
（已解决，按 issue-template.md 格式，含方案对比+决策）

### #3: {标题} 🔍
（正在解决）

### #5: {标题} ?
（迷雾中——已知存在但未展开。可能解决 #3 后才发现具体内容）

## 后续迭代（P3 延后项）

- #8 [P3]: {延后的 issue} — 延后理由
```

## 推进原则

1. **从 P0 开始** — 阻塞项必须先解决，否则后续都建立在不稳固的基础上
2. **按依赖顺序推进** — 先解决无依赖或依赖已解决的 issue
3. **解决一个可能发现多个** — 这是正常的，不是倒退。新发现的 issue 加入图，标注 blocked_by
4. **前沿清晰即停** — 当通往终点的路径清晰（剩余 issue 都是 P2/P3 或已可推导），不需要再强行枚举

## 与传统清单的区别

| 传统清单 | Fog of War 决策图 |
|---------|------------------|
| 一次性列完所有 issue | 边解决边发现 |
| 静态优先级 | 动态——解决 #3 可能改变 #5 的 P 级 |
| 线性顺序 | DAG（有依赖边的图）|
| 完成即结束 | 前沿清晰即停，迷雾中的不强求 |

## 何时跳过决策图

如果 system-architecture.md 已经足够细化（所有挑战都有明确方案，无根本性选择未决），
initial 追踪后可能**无 fog of war**——没有未解决的 issue。

此时建议直接进入 Step 4（非功能性设计），决策图记录为「无未决 issue，已收敛」。
