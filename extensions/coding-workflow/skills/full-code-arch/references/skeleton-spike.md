# 代码骨架验证（Skeleton Spike）

> Step 7 引用。把 §3 签名表 + §4 时序图 + §1 工程目录落成**可编译的真实骨架代码**（Level 1：
> 调用链在代码里真实接上），物理验证设计假设。移植 recursive-skeleton skill 的顶层骨架机制
> （P2 顶层骨架 + 信息密度原则 + P4 停止点 + 强制类型检查/lint 验证，按项目语言）。

## 为什么需要骨架

前面 Step 1-5 全是纸面设计（.md + .html）。签名是否可用、调用链是否真闭合、依赖方向是否无环、
状态机能否落地、SDK 是否可行——**这些问题只有真实代码能回答**。骨架是设计与编码之间唯一的物理验证点：

- 时序图画得再漂亮，签名传不进去就作废
- 包依赖图看着无环，import 一写可能就环了
- 状态机枚举+终态，骨架不落成编译不过就不知道字段缺没缺
- **SDK 假设有这个 API，adapter 一真引才知道方法存不存在、签名对不对**（Level 1 新增的证伪点）

**代价前置**：骨架阶段发现签名/依赖/调用链/SDK 问题，回 Step 1 修纸面设计，成本可控；
到 ⑥第一个 Wave 写代码时才发现，⑤整张时序图作废，前面 ①②③④全受牵连。

## 骨架生成规范

派 fresh-context subagent 生成骨架，输入 = §3 签名表 + §4 时序图 + §1 工程目录 + §2 包依赖图。

### 按模块 DAG 划分并行生成（模块数 > 1 时）

> **与 ②③④ 的多 agent 动机不同**：那里是**对抗认知盲区**（换 context/换认知帧）。
> Step7 的并行是 **DAG 依赖划分**——模块在 §1/§2 已被设计为独立单元（§2 包依赖图强制
> `modules/* 不能互相 import`），是真正的并行工作单元。价值 = 大系统提速 + 故障定位更精确
> （哪几个 agent 报类型检查错就定位到哪几个模块，而非串行写完全骨架后才报错难定位）。

骨架生成按 §1 工程目录 + §2 包依赖图分两层（依赖 DAG）：

| 层 | 生成什么 | 派发 | 为什么这个顺序 |
|----|---------|------|---------------|
| **Tier 0 基础层** | `shared/`（types.ts, errors.ts — 跨模块共享类型）+ `infra/`（db.ts, logger.ts + 各模块的 adapter stub）| **先串行**（1 个 subagent）| 所有模块 import 它。Tier 0 不稳定 → Tier 1 各 agent 各自发明类型 → 冲突 |
| **Tier 1 模块层** | 每个 `modules/{module}/`（controller/service/model/repository/port）| **并行**（每模块 1 个 fresh subagent）| §2 强制 `modules/* 不能互相 import` → 模块间无写冲突 |

**Tier 0 先行固化共享类型（关键纪律）：** Tier 0 agent 从 §3 签名表的跨层共享类型 + §4 数据流链推导出全部共享类型（DTO、enum、result type、error type），一次写进 `shared/types.ts`。Tier 1 各 agent **只读不改 `shared/`**——若发现缺类型，标 gap 回主 agent 补 Tier 0，不自行往 shared/ 加（否则并发写冲突）。

**port/adapter 归属：** port interface 归属模块（`modules/A/port.ts`），adapter stub 归 infra（`infra/`）。Tier 0 agent 生成 infra stub 时需读**所有模块**的 port 清单（§5 Deep Module 标注的 seam）。

**触发条件（何时不并行，防过度设计）：**
- 模块数 ≤ 1（小系统/单模块改动）→ 不并行，单 agent 够
- §2 包依赖图有 `modules/* 互相 import`（循环依赖嫌疑）→ 不并行，先回 Step 2 修依赖图（并行前提不成立）
- 只有 1-2 个模块的 greenfield → 不并行

### 必须落地的

1. **所有类 + 方法签名 + 分层接线** — 参数类型、返回类型完整。方法体**按接线层级分层接线**（Level 1 骨架，见下「分层接线规则」），不再是全 `throw new NotImplementedError()`
2. **import 关系** — 按 §2 包依赖图

### 分层接线规则（Level 1：调用链在代码里真实接上）

> **为什么从 Level 0 升级**：Level 0 方法体全 throw，调用链靠 import 图 + Mermaid 时序图 + 注释表达——
> 类型检查器/编译器只验「模块间 import 可达」，看不到方法层真实调用，**调用链闭合 100% 靠 LLM 自查（最弱环）**，
> 异质 oracle（确定性编译器）的威力被浪费。Level 1 把调用链接进代码，让编译器实证：签名匹配、
> 调用链入口→底层可达、SDK 真存在。

| 层级 | 接线规则 | 编译器验证什么 |
|------|---------|-------------|
| **模块内调用** | 方法体写出对注入依赖的真实调用：`this.repo.save(order)` / `self.model.create(items)`（各语言形式见下表）。链路末端（叶子逻辑）末尾抛 not-implemented 异常满足返回类型 | 下游方法签名匹配、调用链代码可达（非仅 import） |
| **跨模块调用** | caller 依赖 port interface（`modules/A/port.ts` 的 `OrderRepositoryPort`），**不直接 import modules/B**（§2 依赖纪律）。实际接线在 adapter（`infra/`）层完成 | port interface 签名一致、adapter wire 到 port |
| **adapter 真引 SDK** | `infra/` 下 adapter 方法体**真引用第三方 SDK**（`this.stripe.charges.create({...})`），**不 throw**——让编译器对依赖声明验签，暴露「SDK 没装/没这方法/签名变了」 | Tier 2 证伪：依赖存在、方法存在、签名匹配 |

**「调用注入依赖」的各语言形式**（③e 接线密度检测按此）：

| 语言 | 接线形式 | 示例 |
|------|---------|------|
| TS/JS/Java | `this.x.foo()` | `this.repo.save(order)` |
| Python | `self.x.foo()` | `self.repo.save(order)` |
| Rust | `self.x.foo()` | `self.repo.save(order)` |
| Go | `receiver.x()`（receiver 名任意，常见 `s`） | `s.repo.Save(order)` |

**接线层级示例（Level 0 vs Level 1，以 TS 为例）**：

> 以下用 TypeScript 示意（类语法最直观）。Python(`self`)/Rust(`self`)/Go(receiver) 的接线
> 语义完全相同，只是 receiver 关键字不同——见上表。

```typescript
// ❌ Level 0（当前）—— 调用链没接，tsc 看不到 svc.createOrder 真被调
class OrderController {
  createOrder(dto: CreateOrderDto): OrderResult {
    throw new NotImplementedError();   // ← Controller 和 Service 没接上
  }
}

// ✅ Level 1 —— 模块内真接线，tsc 实证调用链闭合
class OrderController {
  constructor(private svc: OrderService) {}
  createOrder(dto: CreateOrderDto): OrderResult {
    return this.svc.createOrder(dto);   // ← 真接线，tsc 验签名匹配 + 返回类型
  }
}
class OrderService {
  constructor(private model: OrderModel, private repo: OrderRepository) {}
  createOrder(dto: CreateOrderDto): OrderResult {
    const order = this.model.create(dto.items);  // 真接线
    this.repo.save(order);                        // 真接线
    throw new NotImplementedError();              // 叶子逻辑不写（领域规则/持久化细节）
  }
}

// ✅ adapter 真引 SDK（Tier 2 证伪）
// infra/stripe-adapter.ts —— seam 处真接 SDK，不藏
class StripeAdapter implements PaymentPort {
  constructor(private stripe: Stripe) {}
  charge(req: ChargeReq): ChargeResult {
    return this.stripe.charges.create({          // ← 真引 SDK，tsc 对 @types/stripe 验签
      amount: req.amount,                         //   SDK 没装→cannot find module
      currency: req.currency,                     //   没这方法→Property does not exist
    });                                           //   签名变→类型错
    // 不写重试/幂等/降级（那是 ⑥Wave），adapter 只接调用 + 透传参数
  }
}
```
3. **类型契约** — 跨层共享类型（DTO、enum、result type）单独 `types.ts` / `types.py`，
   覆盖所有跨层调用
4. **状态机** — 枚举 + 终态字段（无业务逻辑，但状态值和终态约束要体现）
5. **port/adapter 占位** — §5 Deep Module 标注的 seam，port interface 落地，adapter 留 stub

### adapter 真引 SDK（Tier 2 证伪补回）

> **Level 1 的关键规则**：adapter 在骨架里**不 throw 占位**，而是真引用其 SDK。
> 这是设计与编码之间唯一能机器验证「外部 SDK 可行性」的点。

port 纪律不破坏（业务侧只依赖 `PaymentPort` interface，经构造注入），但 adapter 实现层**真引 SDK 不藏**。
代价：infra/ adapter 不再是纯 stub，需装依赖的类型/声明（TS 的 `@types/*`、Python 的 stub/类型注解、
Rust 的 crate、Go 的 module）。收益：类型检查器/编译器成为异质 oracle，在设计期就证伪三类 SDK
问题——这些以前要等 ⑥第一个 Wave 写代码才暴露：

| 证伪类型 | 检查器错误（TS 示例，其他语言等价） | 设计假设的什么错了 |
|---------|----------------------------------|------------------|
| 依赖没装 | `Cannot find module '@anthropic-ai/sdk'` | 设计假设了未纳入依赖清单的包 |
| 方法不存在 | `Property 'charges' does not exist on type 'Stripe'` | 设计假设了 SDK 版本里没有的 API |
| 签名不符 | 类型不匹配错误 | 设计假设的参数/返回类型与 SDK 实际不符 |

> 上表错误信息以 TS/tsc 为例。Python(mypy)/Rust(cargo)/Go(go build) 报不同的错误文本，但
> **证伪的语义相同**——依赖缺失、方法不存在、签名不符，各语言类型检查器都能逮。

**什么仍验证不了（诚实交代）**：SDK 运行时行为（AbortSignal 是否真的 abort、重试退避是否生效）需真跑代码，
超出骨架范围——属 ④prototype spike 或 ⑥集成测试。骨架只验「SDK 契约静态可行」。

### 高密度骨架原则（信息密度 > 文件数）

骨架不只是签名。**高价值骨架暴露 agent 不读代码就推不出的信息**——否则比没有更糟
（低密度骨架 = 假完成，给人「设计已落地」的错觉）。

> **Level 1 优先级**：数据流/失败路径/竞态信息**优先用接线代码表达**——
> `if (conflict) return this.handleConflict(orderId)` 真接线到下游方法（各语言等价：`self.handleConflict()` / `s.handleConflict()`），
> 比 `// 冲突时重试` 注释强（接线被类型检查器验证，注释不验证）。
> 注释只补**代码推不出**的（SDK 契约/不变式/时序约束/为何这样接）。接线能表达的就别只写注释。

对每个方法，骨架注释暴露以下任一（看是否适用）：

| 信息类型 | 骨架注释示例 | 何时该写 |
|----------|-------------|---------|
| 数据流 | `// client→controller→service→repo→db，order 状态 pending→paid` | 跨层穿透时 |
| 失败路径 | `// 幂等键冲突→返回已有 order；DB 不可用→503 重试` | 有多个失败分支 |
| SDK 契约 | `// AbortSignal 触发后必须 abort in-flight，否则泄漏` | 依赖外部 SDK 且契约非显然 |
| 竞态 | `// check-then-act，必须加锁或 CAS，否则重复下单` | NFR④标并发 |
| 不变式 | `// items 非空且 amount>0，否则抛 InvariantError` | 领域模型守卫 |

**不该写的**：纯计算/格式化函数（签名就是设计）、薄注册/shell 文件（直接填）。

### 停止点（何时停止加骨架）

骨架只到「签名 + 调用链 + 依赖方向」可验证即停，**不写实现逻辑**。停止判据：

> **Level 1 重定义**：「调用链」现在指**代码里的真实接线**（`this.x.foo()` / `self.x.foo()` / `receiver.x()`），不是 import 图。
> 停止 = 签名完整 + 每张时序图入口→底层在代码里接线可达 + 依赖方向无环。

| 条件 | 为什么停 |
|------|---------|
| 下一步要写方法体实现逻辑（非接线） | 已越过线 |
| 一张密集时序图已覆盖该块 | agent 能读图 |
| 是纯函数/薄 shell | 无抽象可暴露 |
| 继续加只是堆签名 | 无新设计信息 |
| 只剩类型检查/lint 待验证 | 结构已定 |

经验法则：**能写实现所用的字符数 < 骨架注释**，就停止骨架工作。

### 接线边界画线（防 Level 1 滑向实现）

> **Level 1 的核心风险**：方法体不再全 throw，有滑向「写实现逻辑」的诱惑。
> 硬纪律：**只接调用 + 透传参数，不写业务逻辑/数据组装**。

| ✅ 该写（接线层，编译器可验） | ❌ 不该写（实现层，throw/未实现） |
|----------------------------|--------------------------|
| `this.repo.save(order)` / `self.repo.save(order)` 调用 | `save()` 内部 SQL/ORM/序列化逻辑 |
| `this.model.create(items)` / `self.model.create(items)` 调用 | `create()` 内部不变式校验/领域规则逻辑 |
| `return this.svc.createOrder(dto)` 透传 | 数据组装 `combine(a, b, c)` 业务逻辑 |
| adapter `this.stripe.charges.create({...})` 调用 | 重试/幂等键/退避/降级逻辑 |
| `if (conflict) return this.handleConflict(id)` 分支接线 | 分支内的错误处理/转换实现 |
| `if (!items.length) throw new InvariantError()` 守卫接线 | 守卫后的业务处理逻辑 |

> 上表以 TS 语法为例。Python 把 `this.` 换 `self.`，Go 换 receiver 名——**接线语义不变，判别法不变**。

判别法：**写的是「谁调谁 + 传什么」，不是「怎么算」**。一旦开始写「怎么算」，就跨进了 ⑥Wave 的实现域。

## 强制验证 gate

[MANDATORY] 骨架生成后必须通过以下验证，任一失败 → 回 Step 1 修签名/目录/依赖，不带着错误交接 ⑥。

> **机器验证**：⑤Step 6 审查 subagent 阶段，CW gate 的代码架构检查会自动执行下面的 ③反模式检查（类型逃逸/TODO/god object/类型检查/②§11 grep，按骨架语言自动选检查器）。
> 机器检查 FAIL = review 直接 CHANGES_REQUESTED（硬阻断）。详见 `../../full-shared/references/review-agent.md`。

```bash
# 1. 类型/编译检查通过（证明签名自洽 + Level 1 接线调用链签名匹配）——按项目语言选：
npx tsc --noEmit          # TypeScript
mypy .                     # Python
cargo check                # Rust
go build ./...             # Go
javac -d <out> -sourcepath . *.java   # Java

# 2. lint 通过（无占位符/类型逃逸）——各语言的逃逸模式：
#    TS/JS: any / @ts-ignore / eslint-disable    Python: # type: ignore
#    Go: //nolint    Rust: #[allow]    通用: TODO
npx eslint <skeleton-files>          # TS/JS
ruff check .                          # Python
golangci-lint run                     # Go
```

- [ ] **类型/编译检查通过** — 签名、参数、返回类型自洽（Level 1 接线后编译器还验调用链签名匹配）。按项目语言：tsc/mypy/cargo/go build/javac
- [ ] **lint 通过** — 无占位符/类型逃逸（跨语言：TODO/eslint-disable/any/@ts-ignore/`# type: ignore`/`//nolint`/`#[allow]`；叶子逻辑用 not-implemented 异常）
- [ ] **包依赖无环** — import 关系与 §2 包依赖图一致，无循环（madge / 工具检测）
- [ ] **调用链代码接线可达（Level 1）** — 每张 §4 时序图的入口→底层，在骨架代码里真实接线可达（各语言形式 `this.x()`/`self.x()`/`receiver.x()`，非仅 import 图）。机器检查 ③e 验整体接线密度
- [ ] **adapter 真引 SDK** — 每个 `infra/*` adapter 方法真引用其 SDK（类型检查器/编译器对依赖声明验签，如 tsc 对 `@types/*`、mypy 对 stub、cargo 对 crate），不 throw 占位
- [ ] **§3 签名表每个方法在骨架有定义** — orphan 检查（设计写了但骨架没落地）。机器检查 ③f
- [ ] **NFR④ 并发字段落地** — 标并发风险的 UC，骨架已有幂等键/idempotency/锁字段

### 架构反模式检查（P1，机器检查自动执行）

> 类型检查器/编译器只验证"语法/结构对"，验证不了"架构语义对"。②的分层/aggregate 边界/Context Map 是 D-不可逆决策，
> 必须在骨架上机器验证，否则骨架 gate 给的是"假绿灯"。CW gate 的代码架构检查（check-code-arch）的 ③层自动跑这些检查：

- [ ] **②§11 grep 规则全过** — 执行 system-architecture.md §11 的 `grep -rn "{pattern}"` 验收清单（层级穿透/依赖方向）。规则从②动态读，不 hardcode。有输出 = 违反②架构决策
- [ ] **无 god object** — 每文件 LOC ≤ 600（骨架阈值，含注释；实现期回到 400）。`wc -l` 检测
- [ ] **无类型逃逸/占位符** — 跨语言：无 `any`/`@ts-ignore`/`eslint-disable`(TS)、无 `# type: ignore`(Py)、无 `//nolint`(Go)、无 `#[allow]`(Rust)、无 `TODO`。叶子逻辑用 not-implemented 异常，非叶子方法体用接线

> **为什么 600 不是 400？** 骨架的高密度注释（暴露数据流/失败路径/SDK契约/竞态/不变式）会撑大行数。
> 阈值放宽到 600 给注释空间；真正的实现代码回到 400（由实现期 lint 兜）。
> 阈值可在机器检查的 `GOD_OBJECT_THRESHOLD` 配置调整。

## 与 ④NFR prototype 的合并

④NFR 标记的「不确定性高的副作用」（并发死锁/缓存命中率），其相关 stub 方法**直接进本骨架验证**，
不再「一次性代码用完即删」。好处：

- prototype 验证与骨架合一，省一次重复设计
- 并发/幂等相关的 stub（锁字段、idempotency-key）留在骨架里，是 ⑥Wave 的天然起点

④NFR 只保留「标记哪些副作用需⑤骨架验证」的职责，不再产出独立 prototype 代码。

## 与 ⑥Wave 的衔接（叶子作用域映射）

骨架的每个**叶子作用域（leaf scope）** = ⑥一个 Wave 的填充单元。叶子作用域定义（移植
recursive-skeleton execution.md §1）：

- 有完整签名
- 有密集骨架注释说明它必须做什么
- 不依赖其他未实现单元（或依赖已填充）

骨架完成后，按叶子作用域归组：每个叶子 = 一个 Wave 的实现目标。⑥直接读骨架 + 时序图
推导 Wave DAG，无需重新设计。

## refactor 场景：现有代码迁移

若 §「现有代码映射」章节标了 `move / delete / merge / split` 项：

- **迁移骨架先行** — 这些项先做迁移骨架（把现有代码移到新位置），带**行为等价测试约束**
  （迁移前后行为不变，prefactor Wave 覆盖）
- 行为等价测试 = 迁移前抓取现有行为快照（调用+输出），迁移后比对

greenfield（无现有代码）跳过本节。

## 常见失败模式

| 失败 | 原因 | 防御 |
|------|------|------|
| 过度 scaffold 纯函数 | 把 `formatDate` 当成需要骨架 | 应用高密度判据——纯函数签名即设计 |
| 骨架腐烂 | 轮次间跳过类型检查/lint | [MANDATORY] 每轮验证 |
| 无限骨架循环 | 把脚手架当成交付物 | 停止判据 |
| 低密度骨架 | 只写签名不暴露数据流 | 信息密度原则 |
| 骨架漂离文档 | 骨架签名与 §3 签名表不符 | 生成时以 §3/§4 为准，不符则修骨架（设计是真相源） |
| **层级穿透**（domain import infra） | 类型检查能过但方向违规 | **②§11 grep 规则 + CW gate 代码架构检查 ③层** |
| **god object 未被发现** | 纸面写 LOC<400 但骨架超限 | **机器检查 `wc -l` > 600 硬阻断** |
| **假 Level 1（全 throw）** | 方法体退化回 Level 0 全 throw，调用链仍靠注释 | **接线边界画线表 + 机器检查 ③e 接线密度检测（整模块无 `this.` 接线 → FAIL）** |
| **越界写实现** | Level 1 接线滑向写业务逻辑/数据组装 | **接线边界画线表硬纪律：只接调用+透传，不写「怎么算」** |
| **adapter 藏 SDK** | adapter 仍 throw，Tier 2 SDK 证伪丢失 | **adapter 真引 SDK 规则 + 机器检查验证不 throw** |
| **orphan 方法未发现** | §3 签名表写了但骨架没定义 | **§9 覆盖核验表 + 机器检查 ③f** |
