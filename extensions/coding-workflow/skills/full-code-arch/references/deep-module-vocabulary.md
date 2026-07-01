# Deep Module 词汇表

> 移植自 Matt Pocock 的 codebase-design skill。设计**深模块**的核心词汇与原则。
> 在代码架构设计（Step 5）中统一使用这些术语——不要替换为「组件/服务/API/边界」。
> 一致的语言是全部意义所在。

## 词汇表

**Module（模块）** — 任何有 interface 和 implementation 的东西。刻意尺度无关：函数、类、包、跨层切片。*避免*：unit、component、service。

**Interface（接口）** — caller 要正确使用模块必须知道的一切：类型签名，以及不变式、顺序约束、错误模式、必需配置、性能特征。*避免*：API、signature（太窄——只指类型层表面）。

**Implementation（实现）** — 模块内部的代码体。区别于 **Adapter**：一个东西可以是小 adapter 大 implementation（Postgres 仓库），或大 adapter 小 implementation（内存 fake）。

**Depth（深度）** — interface 处的 leverage：caller（或测试）每学一个单位 interface 能行使的行为量。**深模块** = 大量行为藏在小组件后面；**浅模块** = interface 几乎和 implementation 一样复杂。

**Seam（缝隙）** — 可以不改原地就改变行为的地方；模块 interface 所在的*位置*。（Michael Feathers）。*避免*：boundary（与 DDD 的 bounded context 重载）。

**Adapter（适配器）** — 在 seam 处满足 interface 的具体物。描述*角色*（填什么槽），不是实质（里面是什么）。

**Leverage（杠杆）** — caller 从 depth 获得的好处：每学一个单位 interface 获得更多能力。一个 implementation 在 N 个调用点和 M 个测试中回报。

**Locality（局部性）** — 维护者从 depth 获得的好处：变更、bug、知识、验证集中在一处而非散布到 caller。修一次，处处修。

## Deep vs Shallow

```
深模块 = 小 interface + 大 implementation:

┌─────────────────────┐
│   Small Interface   │  ← 少方法，简参数
├─────────────────────┤
│                     │
│  Deep Implementation│  ← 复杂逻辑隐藏
│                     │
└─────────────────────┘

浅模块 = 大 interface + 小 implementation（避免）:

┌─────────────────────────────────┐
│       Large Interface           │  ← 多方法，复杂参数
├─────────────────────────────────┤
│  Thin Implementation            │  ← 只是透传
└─────────────────────────────────┘
```

设计 interface 时问：
- 能减少方法数吗？
- 能简化参数吗？
- 能在里面藏更多复杂度吗？

## 原则

- **Depth 是 interface 的属性，不是 implementation 的。** 深模块内部可由小的可 mock 可替换的部件组成——只是它们不是 interface 的一部分。模块可以有**内部 seam**（实现私有，自己测试用）和**外部 seam**（interface 处）。
- **Deletion test（删除测试）。** 想象删掉模块。复杂度消失 = 它是透传。复杂度在 N 个 caller 重新出现 = 它在承担复杂度。
- **Interface 即测试面。** Caller 和测试穿过同一个 seam。想测到 interface 之外，模块形状可能错了。
- **一个 adapter 意味着假设 seam。两个 adapter 意味着真 seam。** 除非真有东西在 seam 两侧变化，否则不引入 seam。

## 可测性三原则（移植 tdd）

1. **接受依赖，不要创建依赖。**
   ```typescript
   // 可测
   function processOrder(order, paymentGateway) {}
   // 难测
   function processOrder(order) { const gateway = new StripeGateway(); }
   ```

2. **返回结果，不要产生副作用。**
   ```typescript
   // 可测
   function calculateDiscount(cart): Discount {}
   // 难测
   function applyDiscount(cart): void { cart.total -= discount; }
   ```

3. **小表面积。** 方法少 = 需要的测试少。参数少 = 测试 setup 简单。

## 4 类依赖 → Port 决策

| 类别 | 特征 | 要不要 port | 测试策略 |
|------|------|-----------|---------|
| **In-process** | 纯计算，内存状态，无 IO | 不要 | 直接测，无 adapter |
| **Local-substitutable** | 有本地替身（PGLite/内存 FS） | 内部 seam | stand-in 跑测试 |
| **Remote but owned** | 自己的远程服务 | 要 port | in-memory adapter（测）+ HTTP adapter（产）|
| **True external** | 第三方不可控 | 要 port | mock adapter |

### Seam 纪律

- 一个 adapter = 假设 seam。两个 adapter = 真 seam。除非至少两个 adapter（通常产+测），否则不引入 port。
- 内部 seam vs 外部 seam：深模块可以有内部 seam（私有）和外部 seam（interface 处）。不要因测试用了就把内部 seam 暴露到 interface。

## 被拒绝的表述

- **Depth = implementation 行数 / interface 行数**（Ousterhout）：奖励 padding implementation。我们用 depth-as-leverage。
- **Interface = TypeScript `interface` 关键字**：太窄——interface 包括 caller 必须知道的一切事实。
- **Boundary**：与 DDD 的 bounded context 重载。说 seam 或 interface。
