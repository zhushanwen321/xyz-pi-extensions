# 交付物模板：code-architecture.md + code-architecture.html

> 时序图详细模板见 `sequence-template.md`。Deep Module 词汇见 `deep-module-vocabulary.md`。

## frontmatter

```yaml
---
verdict: pass
upstream: system-architecture.md, issues.md, non-functional-design.md
downstream: execution-plan.md
---
```

## 章节结构

```markdown
# 代码架构设计 — {主题}

## 1. 工程目录
（目录树 + 每目录职责 + 变化轴 + 依赖方向，见 sequence-template.md）

## 2. 包依赖图
（Mermaid graph + import 规则 + 循环依赖检测点）

## 3. API 契约

### 模块: {module-name}

#### 类: {ClassName}

| 方法 | 签名 | 返回 | 边界条件 | Spec/Issue 关联 |
|------|------|------|---------|----------------|

（按模块分组，所有公开方法）

## 4. 功能代码链路（时序图）

### 功能: {功能名}（关联 UC-N）

#### 时序图
（Mermaid sequenceDiagram — 入口到底层 + 异常路径）

#### 方法签名表
#### 数据流链
#### 关联（requirements/issues/nfr）

（每个关键功能一张）

## 5. Deep Module 设计决策

### 模块: {module}
- **Interface**: {入口方法}
- **Depth**: {deletion test 结论}
- **Seam**: {位置 + 有几个 adapter}
- **Port 决策**: {依赖分类 + 要不要 port}

## 6. 测试矩阵（Test Matrix）— [MANDATORY]

> bug 主要来自设计期未枚举的边界/异常/状态组合。本节把它们全部收口，
> 作为 ⑥Wave 的测试输入和实现期 TDD 的种子。TDD 只测 agent 想到的——
> 测试矩阵强制枚举 agent 易漏的。
>
> **两个来源（缺一不可）：**
> - **来源 A（功能用例）** — 从 §4 时序图每个 alt/else 推导（正常/边界/异常/状态/并发）
> - **来源 B（NFR 用例）** — 从④NFR「缓解项回灌登记表」中 `验收方式=代码测试` 的每条风险推导
>   （安全注入/越权/降级/日志契约等——这些通常不是时序图异常分支，但正是线上事故重灾区）

### 来源 A：功能用例（按 UC 归类）

#### UC-1: {用例名}（关联 §4.X 时序图）

| 用例 ID | 类型 | 测试层 | 场景 | 输入 | 预期 | 关联 AC |
|---------|------|--------|------|------|------|---------|
| T1.1 | 正常 | mock | 主流程 | {输入} | {预期} | AC-1.1 |
| T1.2 | 边界 | mock | min/max/空/单元素/满载 | {边界值} | {预期} | AC-1.1 |
| T1.3 | 异常 | mock | 时序图每个 alt/else 分支 | {异常输入} | {错误处理} | AC-1.2 |
| T1.4 | 状态 | mock | 状态机每条转换 + 终态不可逆 | {前置→触发} | {后置状态} | AC-1.3 |
| T1.5 | 并发 | real | check-then-act/幂等 | {并发场景} | {一致性结果} | AC-1.4 |
| T1.6 | e2e | mock | 入口=UI/API 边界的跨层贯穿(mock 依赖) | {端到端场景} | {全链预期} | AC-1.5 |
| T1.6r | e2e | real | 同 T1.6 真实后端/数据 | {端到端场景} | {全链预期} | AC-1.5 |

**类型必覆盖（每 UC 至少前 4 类；并发/e2e 当 NFR④ 标注或有 UI/API 边界时强制）：**
- **正常** — 主流程 happy path
- **边界值** — 等价类边界：min/max/0/空/null/单元素/满载
- **异常** — 时序图每个 alt/else = 一个异常用例，不许只写"错误处理"
- **状态转换** — 状态机每条边 + 终态不可逆性
- **并发** — NFR④ 标注竞态/幂等的 UC 强制，其余可选
- **e2e（端到端）** — 时序图入口=UI/API 边界的 UC 强制（跨层贯穿验证，补 "单层单测验不住"的口子；纯内部函数的 UC 可选）

**测试层（mock / real，每条必标）：** 按是否隔离真实依赖分层，见 lite 体系 `test-case-schema.md` 核心原则四。
- **mock**（隔离层）= mock 掉外部依赖，验被测单元/流程自身逻辑（单测天然 mock；mock 后端 API 的 E2E）
- **real**（真实层）= 不 mock 关键依赖，真实后端/数据/环境跑端到端
- 并发类（真实竞态 mock 不住）强制 `real`；e2e 类常拆 mock + real 两条（如 T1.6 mock / T1.6r real）；正常/边界/异常/状态类默认 `mock`
- **与来源 B「强制层级」的映射**：来源 B 的 `unit/integration/e2e` 是更细的 NFR 风险归属——`unit`≈mock 层，`integration/e2e`≈real 层。来源 A 用 mock/real 粗分（与 lite 对齐、供 ⑥验收清单按层分组），来源 B 保留细分（NFR 风险需精确归属执行层）。两列语义一致、粒度不同，不矛盾。

#### UC-2: ...（同结构）

### 来源 B：NFR 风险→用例映射表 — [MANDATORY]

> ④NFR「缓解项回灌登记表」中每条 `验收方式=代码测试` 的风险，**必须**在此生成 ≥1 条测试用例。
> 安全/性能/可观测/兼容类风险常不是时序图异常分支——若不单列，它们在⑤无人测试，
> 设计期识别的风险 = 实现期无人兜住 = 线上事故。

| ④缓解项 | 来源 Issue# | 维度 | 归属 UC | 验证断言 | **强制层级** | test-matrix 用例 ID |
|--------|------------|------|--------|---------|------------|-------------------|
| 输入参数化防注入 | #1 | 安全 | UC-1 | 恶意输入被拦截，返回 400 | **integration** | T1.7 |
| 横向越权检查 | #1 | 安全 | UC-2 | A 用户访问 B 订单返回 403 | **integration** | T2.5 |
| 幂等键防重复下单 | #2 | 并发 | UC-1 | 并发请求只生一单 | **integration** | T1.8 |
| 日志含 traceId | #3 | 可观测 | UC-1 | 响应日志结构化含 traceId 字段 | 任意 | T1.9 |

（④标 `验收方式=骨架约束` 的风险不进本表——由⑤骨架类型检查/编译 gate 兜住；④标 `运维项` 的不进代码层）

> **「强制层级」列（防 "unit 测验不住"）：** 安全/并发维度的风险，unit 测 mock 掉真实 DB/鉴权/并发上下文就验不住，**必须在设计期标强制 integration**（真实 DB + 真实参数化 + 真实并发）。可观测/兼容类默认"任意"（实现期定 mock 边界）。取值：`unit` / `integration` / `e2e` / `任意`。⑥测试验收清单据此决定用例归属哪个测试执行层。

### 覆盖完整性自检
- [ ] 每 UC 的正常/边界/异常/状态 4 类齐全（来源 A）
- [ ] **来源 A 每条标测试层（mock/real）；e2e 类用例 mock 层 + real 层各至少 1 条**（real 无环境标 `[需集成环境]` 不可省略）
- [ ] 时序图每个 alt/else 都映射到一条异常用例（§4 ↔ §6 双向可查）
- [ ] 状态机每条转换有对应状态用例
- [ ] NFR④ 标注并发风险的 UC 有并发用例（并标 real 层）
- [ ] **④每条 `验收方式=代码测试` 的缓解项，在本节有 ≥1 条对应用例（来源 B 双向映射）**
- [ ] **来源 B 每条用例 ID 不与来源 A 重复编号**（建议编号段区分，如 NFR 用例 T{UC}.6+）

## 7. 现有代码映射（refactor 场景，greenfield 标「无现有代码」跳过）

> refactor 场景：新设计的工程目录如何与现有代码共存/迁移。每项的 `move/delete/merge` 
> 对应 ⑥的 Prefactor Wave + 行为等价测试。greenfield 本节标「无现有代码」跳过。

### 模块映射

| 新目录模块 | 现有代码文件/函数 | 处置 | 行为等价测试要点 |
|-----------|------------------|------|----------------|
| modules/order/ | `src/order.ts`, `src/orderRepo.ts` | merge | 合并后订单 CRUD 行为不变 |
| modules/order/port.ts | （新建） | create | — |
| shared/types.ts | `src/types.ts` | move | 迁移后 import 全更新 |

（处置：keep / move / delete / merge / split）

## 8. 下游衔接

### 喂给 Step 6（执行计划）的部分
| 时序图 | 对应 Wave | 依赖的其他时序图 |
```

## 9. 骨架覆盖核验（MANDATORY）— 双向

> 对抗 orphan（§3 签名表写了但骨架没定义/没人引用）。Level 1 接线后调用链在代码里真实接上，
> 本表把 §3 签名表每个方法 ↔ 骨架定义双向对应，让遗漏变成**可见、可审计的决定**，不是沉默疏漏。
>
> **机器兜底**：check 脚本 ③f 验「§3 每方法在骨架有定义」（存在性硬检查）；
> 本表由 agent 人工填「文件:行 + 接线状态」（补脚本查不到的语义）。
> 下表以 TS 文件后缀（`.ts`）为例；Python 用 `.py`、Rust 用 `.rs`、Go 用 `.go`——按项目语言。

| §3 方法（模块.类.方法） | 骨架定义位置（文件:行） | 接线状态 | 备注 |
|------------------------|------------------------|---------|------|
| order.OrderController.createOrder | modules/order/controller.ts:12 | ✅ 接线完整 | 透传到 Service |
| order.OrderService.createOrder | modules/order/service.ts:8 | ✅ 接线(model+repo) | 叶子 throw（领域规则未写） |
| order.OrderModel.create | modules/order/model.ts:24 | ✅ 签名(叶子) | 纯领域逻辑，throw |
| payment.PaymentPort.charge | modules/payment/port.ts:5 | ✅ port 定义 | adapter 在 infra/ |
| infra.StripeAdapter.charge | infra/stripe-adapter.ts:18 | ✅ adapter 真引SDK | tsc 验 @types/stripe |

**接线状态：**
- `✅ 接线完整` — 方法体真实接线下游（`this.x.foo()`），tsc 实证调用链
- `✅ 签名(叶子throw)` — 叶子逻辑，方法体 `throw new NotImplementedError()`（纯计算/领域规则/IO 细节）
- `✅ adapter 真引SDK` — adapter 真引第三方 SDK（Tier 2 证伪）
- `❌ 未定义` — §3 有签名但骨架无对应定义（**终稿不允许**）
- `N/A` — refactor 迁移项，处置查 §7（不新建骨架文件）

**覆盖完整性自检：**
- [ ] §3 签名表每个公开方法在本表有对应行（无遗漏）
- [ ] 无 `❌ 未定义`（终稿硬阻断，check 脚本 ③f 兜底）
- [ ] 接线状态标注准确（叶子标叶子，非叶子标接线完整，不混）
