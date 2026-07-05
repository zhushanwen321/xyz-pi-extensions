# Wave 拆分模型

> lite-plan 写 plan.md 的「Wave 拆分与依赖」章节前 read 本文件。
> coding-execute 按 Wave 派 subagent 前 read 本文件。

## 核心原则：垂直切片

每个 Wave = **一个可独立验证的垂直切片**，切穿所有相关层（schema → 逻辑 → 测试），不是水平切片（先写完所有 schema，再写所有逻辑）。

```
✅ 垂直切片（正确）          ❌ 水平切片（错误）
Wave 1: 用户注册全链路       Wave 1: 所有数据库 schema
  - user.model.ts              Wave 2: 所有 API 路由
  - user.service.ts            Wave 3: 所有业务逻辑
  - user.test.ts               Wave 4: 所有测试
Wave 2: 用户登录全链路
  ...
```

**为什么垂直切片**：每个 Wave 完成后可独立跑测试验证，失败能精确定位到哪个切片。水平切片的 Wave 之间强耦合，最后一个 Wave 才能跑通，失败定位困难。

## Wave 拆分步骤

### 1. 从技术改动点推导 Wave 边界

读 plan.md「技术改动点」清单（文件级）。按**业务功能**聚合文件：

- 同一个业务功能涉及的文件 → 同一个 Wave
- 不同业务功能 → 不同 Wave
- 公共基础设施（被多个功能依赖）→ 独立 Prefactor Wave，排最前

### 2. 推导依赖（blocked_by）

从代码调用关系推导：

- 功能 B 调用功能 A 的接口 → `Wave(B) blocked_by Wave(A)`
- 功能 B 和 A 修改**同一文件** → 必须串行（一个 blocked_by 另一个）
- 功能 B 和 A 修改**不同文件**且无调用关系 → 可并行

> 依赖判定看的是「文件影响集」+「调用关系」，不是主观感觉。两 Wave 改同一文件 = 必须串行。

### 3. 划分并行组

```
| Wave | 改动文件       | 依赖  | 并行组 | 说明              |
|------|---------------|-------|--------|-------------------|
| W0   | types.ts      | -     | -      | Prefactor：公共类型 |
| W1   | auth.ts,test  | W0    | G1     | 登录功能           |
| W2   | profile.ts    | W0    | G1     | 资料功能（与W1不冲突→同组可并行）|
| W3   | order.ts      | W1    | G2     | 下单依赖登录        |
```

- **同并行组** = 改动文件无交集 + 无调用依赖 → 可同时派 subagent 并行实现
- **不同并行组**或有 blocked_by → 必须串行（等上游 Wave 完成后再派）

### 4. 整体回归由 CW test 阶段承担（不使用验收 Wave）

plan.json 的 wave 只装功能开发（每个 wave 都有 `changes` 代码改动）。**整体回归测试（全量单测 + E2E + 覆盖率 gate）由 CW test 阶段承担**——test gate 用 testCase.status（每条 E* 用例 judgeByExpected 重算 actual vs expected）+ 覆盖率判定，不依赖一个「验收 Wave」概念。

> 历史背景：早期 design-workflow 用「末尾验收 Wave」做整体回归闸门，引入 CW 状态机后 test 阶段接管了这职责（更强：机器重算 + 覆盖率 gate，而不是依赖 agent 声明「验收 Wave 跑过了」）。验收 Wave 作为 plan.json 里 `changes: []` 的 wave 残留被 dev gate 错误地一视同仁（要求 committed ≠ null，但验收 Wave 没代码可 commit），故取消。
>
> 「逐 Wave 测试通过 ≠ 整体可用」的差距由 test 阶段的 E2E 用例覆盖（mock + real 两层各 ≥1 条），不需要单独的验收 Wave。

### 5. Wave 间根因传播（执行期纪律）

Wave 表是 plan 期产物，但执行期常发现「不同 Wave 踩同一个坑」。拆分时预判哪些 Wave **共享同一类机制风险**（都依赖异步时序 / 都改同一份共享状态 / 都触碰同一契约边界），在 Wave 表标注。执行时前序 Wave 定位的根因，必须抽象到模式层（「所有 session 建立/激活路径都需主动拉取」）作为后续同类型 Wave 的设计输入——不能停在具体路径（「selectSession 需主动拉取」），否则后续 Wave 设计时不会自动带上，二次返工。

> 实测案例：W1 修 selectSession 时序，W2 预创建 session 遇完全相同的 broadcast 时序问题。根因归类停在具体路径 = Wave 间根因无法传播。详见 execution-flow.md「失败定位纪律」第 3 点。

## 并行安全性自检

派并行 subagent 前 [MANDATORY] 逐条核对：

- [ ] 同并行组的 Wave 改动文件**完全无交集**（git diff 比对文件路径列表）
- [ ] 同并行组的 Wave 无调用依赖（A 不 import B 的新代码，反之亦然）
- [ ] 每个 Wave 有独立的测试文件（测试不共享 fixture 文件，或 fixture 是只读的）
- [ ] 每个 implementer subagent 工作在独立 worktree（per-subagent cwd 隔离）

任一不满足 → 降级为串行（逐 Wave 派 subagent，上一个完成再派下一个）。

## 何时只有单 Wave

小功能常常只有一个 Wave（单文件改动）。此时：
- 不需要并行编排，单 subagent 串行执行
- Wave 表只列 W1（功能），无需额外验收 Wave（整体回归由 CW test 阶段承担）

## 模型

```
实现顺序（按并行组调度）：

  G1: [W1 subagent] ┐
      [W2 subagent] ┤  同组并行（不同 worktree）
                    ↓ 全部完成
  G2: [W3 subagent]    blocked_by G1，串行
                    ↓
  全功能 Wave committed → CW dev gate 通过
                    ↓
  CW test 阶段（跑 E* 用例 + 覆盖率 gate）→ 全绿 → goal complete
```
