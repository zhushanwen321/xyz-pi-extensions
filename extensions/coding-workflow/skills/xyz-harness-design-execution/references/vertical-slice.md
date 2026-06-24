# Tracer Bullet 垂直切片

> 移植自 Matt Pocock 的 to-issues skill。核心理念：
> **每个 Wave 是端到端可验证的窄路径（垂直切片），不是水平分层切片。**

## 为什么垂直切片

### 水平切片是反模式（移植 tdd）

**错误做法（水平）：**
```
Wave 1: 所有数据库层（所有 model + repository）
Wave 2: 所有 service 层（所有 service）
Wave 3: 所有 controller 层（所有 API）
Wave 4: 所有前端页面
```

问题：
- Wave 1 产出一堆没有 caller 的 model，**测的是想象的而非实际的行为**
- Wave 1 完成时无法端到端验证（没有 API 入口）
- Wave 间耦合——Wave 2 依赖 Wave 1 的所有 model，一个改了全连锁

### 垂直切片（tracer bullet）

**正确做法（垂直）：**
```
Wave 1: 创建订单（model → repository → service → controller → 测试）
         ↑ 端到端窄路径，切穿所有层，可独立验证
Wave 2: 查询订单（复用 Wave 1 的基础设施）
Wave 3: 取消订单（复用 Wave 1-2）
```

每个 Wave：
- 切穿**所有**集成层（schema → API → 逻辑 → 测试）
- 完成后**可独立 demo 或验证**
- 是一个 subagent 可高度专注完成的粒度

## 垂直切片规则

1. **每个 Wave 切穿所有层** — 不是「先做后端再做前端」，是「先做一条端到端窄路径」
2. **完成后可验证** — 每条切片交付后能独立 demo 或测试
3. **先 prefactor 再切片** — 如果有让实现更容易的前置重构，先做一个 prefactor Wave
4. **窄但完整** — 路径要窄（聚焦一个功能），但要完整（覆盖该功能的所有层）

## 从时序图推导 Wave

Step 5 的 code-architecture.md 已有每个功能的类方法时序图。推导 Wave：

1. 每个功能的时序图 = 一个 Wave 候选（因为它是一个端到端路径）
2. 看时序图间的依赖：功能 B 的时序图调用了功能 A 的方法 → Wave(B) blocked_by Wave(A)
3. 无调用依赖的功能 → 可并行（同一 Wave）
4. 同一文件被多个时序图修改 → 不能并行（冲突），必须串行

```
时序图「创建订单」→ Wave 1（无依赖）
时序图「查询订单」→ Wave 1（无依赖，与创建并行——如不改同文件）
时序图「取消订单」→ Wave 2（依赖创建订单的 model）
时序图「支付订单」→ Wave 2（依赖创建订单的 model）
时序图「退款」    → Wave 3（依赖支付订单）
```

## Prefactor Wave

如果某些重构能让后续 Wave 更容易（"make the change easy, then make the easy change"），
先做一个 prefactor Wave：

- 提取共享模块
- 调整目录结构
- 引入 port / adapter 骨架

Prefactor Wave 不交付业务功能，但为后续 Wave 铺路。

## P 级与 Wave 的映射

issues.md 的 P0-P3 直接影响 Wave 排序：

| P 级 | Wave 策略 |
|------|----------|
| P0 | 最前的 Wave（prefactor 或 Wave 1），阻塞项 |
| P1 | 前几个 Wave，核心路径 |
| P2 | 中后段 Wave，可与 P1 并行（无文件冲突时）|
| P3 | 标注「后续迭代」，不纳入本次 Wave 编排 |
