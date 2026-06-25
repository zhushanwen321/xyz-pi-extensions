# 代码骨架验证（Skeleton Spike）

> Step 7 引用。把 §3 签名表 + §4 时序图 + §1 工程目录落成**可编译的真实骨架代码**，
> 物理验证设计假设。移植 recursive-skeleton skill 的顶层骨架机制（P2 顶层骨架 + 信息密度原则 +
> P4 停止点 + 强制 tsc/eslint 验证）。

## 为什么需要骨架

前面 Step 1-5 全是纸面设计（.md + .html）。签名是否可用、调用链是否真闭合、依赖方向是否无环、
状态机能否落地——**这些问题只有真实代码能回答**。骨架是设计与编码之间唯一的物理验证点：

- 时序图画得再漂亮，签名传不进去就作废
- 包依赖图看着无环，import 一写可能就环了
- 状态机枚举+终态，骨架不落成编译不过就不知道字段缺没缺

**代价前置**：骨架阶段发现签名/依赖/调用链问题，回 Step 1 修纸面设计，成本可控；
到 ⑥第一个 Wave 写代码时才发现，⑤整张时序图作废，前面 ①②③④全受牵连。

## 骨架生成规范

派 fresh-context subagent 生成骨架，输入 = §3 签名表 + §4 时序图 + §1 工程目录 + §2 包依赖图。

### 必须落地的

1. **所有类 + 方法签名** — 参数类型、返回类型完整（方法体 `throw new NotImplementedError()`
   或 `raise NotImplementedError()`，不写实现逻辑）
2. **import 关系** — 按 §2 包依赖图
3. **类型契约** — 跨层共享类型（DTO、enum、result type）单独 `types.ts` / `types.py`，
   覆盖所有跨层调用
4. **状态机** — 枚举 + 终态字段（无业务逻辑，但状态值和终态约束要体现）
5. **port/adapter 占位** — §5 Deep Module 标注的 seam，port interface 落地，adapter 留 stub

### 高密度骨架原则（信息密度 > 文件数）

骨架不只是签名。**高价值骨架暴露 agent 不读代码就推不出的信息**——否则比没有更糟
（低密度骨架 = 假完成，给人「设计已落地」的错觉）。

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

| 条件 | 为什么停 |
|------|---------|
| 下一步要写方法体实现 | 已越过线 |
| 一张密集时序图已覆盖该块 | agent 能读图 |
| 是纯函数/薄 shell | 无抽象可暴露 |
| 继续加只是堆签名 | 无新设计信息 |
| 只剩 `tsc`/`eslint` 待验证 | 结构已定 |

经验法则：**能写实现所用的字符数 < 骨架注释**，就停止骨架工作。

## 强制验证 gate

[MANDATORY] 骨架生成后必须通过以下验证，任一失败 → 回 Step 1 修签名/目录/依赖，不带着错误交接 ⑥。

> **机器验证**：⑤Step 6 审查 subagent 会跑 `scripts/check_code_arch.py {topic_dir}` 自动执行下面的 ③反模式检查（any/TODO/god object/tsc/②§11 grep）。
> 脚本失败 = review 直接 CHANGES_REQUESTED（硬阻断）。详见 design-clarity 的 `references/review-agent.md`。

```bash
# 1. 类型检查通过（证明签名自洽）
npx tsc --noEmit          # TS
cargo check                # Rust
mypy .                     # Python

# 2. lint 通过（无 any / eslint-disable / SKIP_LINT 占位）
npx eslint <skeleton-files>
```

- [ ] **类型检查通过** — 签名、参数、返回类型自洽
- [ ] **lint 通过** — 无 `any`、无 `eslint-disable`、无 `TODO` 占位（用 `not implemented` 异常）
- [ ] **包依赖无环** — import 关系与 §2 包依赖图一致，无循环（madge / 工具检测）
- [ ] **调用链可达** — 每张 §4 时序图的入口→底层，在骨架里 import 真实可达
- [ ] **NFR④ 并发字段落地** — 标并发风险的 UC，骨架已有幂等键/idempotency/锁字段

### 架构反模式检查（P1，脚本自动执行）

> tsc 只验证"语法/结构对"，验证不了"架构语义对"。②的分层/aggregate 边界/Context Map 是 D-不可逆决策，
> 必须在骨架上机器验证，否则骨架 gate 给的是"假绿灯"。脚本 `check_code_arch.py` 的 ③层自动跑这些检查：

- [ ] **②§11 grep 规则全过** — 执行 system-architecture.md §11 的 `grep -rn "{pattern}"` 验收清单（层级穿透/依赖方向）。规则从②动态读，不 hardcode。有输出 = 违反②架构决策
- [ ] **无 god object** — 每文件 LOC ≤ 600（骨架阈值，含注释；实现期回到 400）。`wc -l` 检测
- [ ] **无 `any`/`eslint-disable`/`TODO`/`@ts-ignore`** — 方法体用 `throw new NotImplementedError()` 占位

> **为什么 600 不是 400？** 骨架的高密度注释（暴露数据流/失败路径/SDK契约/竞态/不变式）会撑大行数。
> 阈值放宽到 600 给注释空间；真正的实现代码回到 400（由实现期 lint 兜）。
> 阈值可在脚本顶部 `GOD_OBJECT_THRESHOLD` 调整。

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
| 骨架腐烂 | 轮次间跳过 `tsc`/`eslint` | [MANDATORY] 每轮验证 |
| 无限骨架循环 | 把脚手架当成交付物 | 停止判据 |
| 低密度骨架 | 只写签名不暴露数据流 | 信息密度原则 |
| 骨架漂离文档 | 骨架签名与 §3 签名表不符 | 生成时以 §3/§4 为准，不符则修骨架（设计是真相源） |
| **层级穿透**（domain import infra） | tsc 能过但方向违规 | **②§11 grep 规则 + check_code_arch.py ③层** |
| **god object 未被发现** | 纸面写 LOC<400 但骨架超限 | **check_code_arch.py `wc -l` > 600 硬阻断** |
