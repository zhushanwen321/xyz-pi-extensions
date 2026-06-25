---
name: design-code-arch
description: >-
  Use when the user says "代码架构", "code architecture", "详细设计",
  "接口契约", "时序图", "工程目录", "API 设计", or has finished
  non-functional-design.md and needs concrete code-level architecture.
  Produces code-architecture.md + code-skeleton/ (可编译骨架代码). Design Step 5 of 6.
  Not for system-level architecture (Step 2) or issue decomposition (Step 3).
  This designs the code structure and contracts AND validates them via a
  compilable skeleton (Step 7) — it does not write the implementation bodies,
  which belong to the execution/coding phase.
---

## 核心目标

将设计结论转换为**具体代码架构**：工程目录规划、API 契约（签名表）、包模块管理、从 API 入口到最底层的**类方法时序图**。**并通过 Step 7 代码骨架验证，物理验证设计假设可编译、调用链可达。**

> **时序图是本阶段核心产出。** 因为代码已细化到类方法时序，Step 6 的 Wave 依赖关系能直接从时序图推导。
>
> **骨架验证（Step 7）是设计与编码之间唯一的物理验证点。** 签名/调用链/依赖方向在纸面看着对，
> 落成可编译代码才知道真不真——代价前置到这里，比到 ⑥第一个 Wave 才发现时序图作废便宜得多。

## 执行流程

按 `design-shared/references/loop-skeleton.md`（共享参考目录）的 6 步循环执行。**（loop-method.md 的方法论仅 clarity 首次 read，本阶段无需 read。）**

**Step 1（交互+初稿）— Grilling 遍历代码契约树：**

```
代码架构（根：工程目录 + 契约 + 时序）
├── 工程目录 → 从 system-architecture §7 模块划分推导（每目录=一变化轴）
├── API 契约 → 从 requirements 用例推导入口
│   └── 类.方法 → 签名(参数/返回/边界) → Deep Module 检验(deletion test)
├── 功能时序图 → 从 requirements 用例走端到端路径
│   └── 入口→底层调用链 + 异常路径(每边界条件一个 alt/else)
└── 包依赖图 → 循环依赖检测
```

遍历纪律：先定工程目录（根）——目录决定模块边界，方法签名和时序图在骨架内展开。
**签名设计时标注每个方法的接线层级**（模块内直调 / 跨模块 port / adapter 真引 SDK），供 Step 7 分层接线——
哪些方法该真接线下游、哪些是叶子（throw）、哪些 adapter 该真引 SDK，在签名表就标清。
用 `references/deep-module-vocabulary.md` 的 Module/Interface/Depth/Seam/Adapter 统一语言设计接口。
依赖按 4 类分类决定 port；接口满足可测性三原则（accept deps / return results / small surface）。
时序图按 `references/sequence-template.md`。初稿用 `references/deliverable-template.md`。

**[MANDATORY] test-matrix 是 ⑤的核心产出之一**（与工程目录/契约/时序图并列）。**两个来源，缺一不可：**
- **来源 A（功能用例）** — 沿 §4 时序图每个 alt/else 逐个枚举异常用例——AI 最易漏、bug 最多发处。
- **来源 B（NFR 用例）** — 从④NFR「缓解项回灌登记表」中 `验收方式=代码测试` 的每条风险生成 ≥1 用例。安全/性能/可观测/兼容风险常不是时序图异常分支，若不单列会在⑤被遗漏、最终无人测试——正是线上事故重灾区。
产出按 `references/deliverable-template.md` §6。

**Step 1 必问决策点（代码答不了，逐个 ask_user；其余 = agent 自决）：**

1. **工程目录粒度/边界（歧义时）** — 按变化轴拆有多种合理方案时，问用户倾向哪种 + 为什么。模块边界不可逆，影响后续所有开发。【D-不可逆】
2. **API 契约抽象深度** — Deep Module（窄深，可测）vs 易用性（宽浅）。"为可测性收窄，还是为易用性放宽？"是用户偏好。【D-不可逆】
3. **包依赖严格度** — 是否允许反向依赖特例 / 循环检测严格度。问用户"严格边界 vs 务实例外"的偏好。【D】
4. **异常路径覆盖深度** — 时序图异常路径覆盖到什么程度（每边界条件 vs 只关键路径）。取决于用户对"鲁棒性 vs 交付速度"的权衡。【D】

> 时序图调用链推导、签名表语法、Deep Module 词汇应用 = agent 自决。

**Step 2（追踪）— 派 fresh-context subagent，按 5 视角追踪：**
契约完整性（每用例/功能有对应 API 契约？**NFR④ 回灌到契约的字段（如 idempotency-key）是否在签名表体现？**）/ 调用链闭合（每时序图入口到底层完整、异常路径覆盖？）/ 依赖健康（包依赖无环、无上帝对象 LOC<400？）/ **测试覆盖完整性（每 UC 正常+边界+异常+状态 4 类齐全？时序图每个 alt/else 有对应异常用例（来源A）？**NFR④ `验收方式=代码测试` 的每条缓解项在 §6 来源B 有 ≥1 对应用例（非仅并发）？**）** / **搭便车闭环（②搭便车清单每项是否有⑤代码架构落点？无落点的是否已回流②打回？）**。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**特有信号：** 时序图走不通（数据流需跨层穿透/调用链断裂）→ system-architecture.md 模型边界有问题 → 回 Step 2 调整。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 code-architecture.md；派 fresh subagent 渲染 code-architecture.html（机制见 loop-skeleton.md Step 5b）（主角图：包依赖图+核心时序图）。**

**Step 6（审查）— 派 fresh-context 审查 subagent（按 design-shared/references/review-agent.md 规范，先跑 `scripts/check_code_arch.py` 机器检查——含 P1 骨架反模式，FAIL 硬阻断），6 维评审（含红队维度），报告写 `changes/review-code-arch.md`（frontmatter 含 verdict + machine_check）。APPROVED 才进 Step 7。**

**Step 7（骨架验证）— 派 fresh-context subagent 生成可编译骨架代码，物理验证 Step 1-5 的设计假设。**

> **[MANDATORY] 骨架验证是本阶段的强制 gate。** 通过才能交接 ⑥。详见 `references/skeleton-spike.md`。

**机制：**
1. **按模块 DAG 划分生成**（模块数 > 1 时；≤1 或 §2 有 `modules/* 互相 import` 循环嫌疑时不并行，单 agent 够）——详见 `references/skeleton-spike.md`「按模块 DAG 划分并行生成」：
   - **Tier 0 基础层先串行**（1 subagent）：`shared/`（types.ts/errors.ts，从 §3 跨层共享类型 + §4 数据流链一次固化）+ `infra/`（含各模块 adapter stub）
   - **Tier 1 模块层并行**（每 `modules/{module}/` 一个 fresh subagent）：§2 强制 `modules/* 不能互相 import` → 无写冲突。**Tier 1 只读不改 `shared/`**，发现缺类型标 gap 回主 agent 补 Tier 0
   - 读取 = §3 签名表 + §4 时序图 + §1 工程目录 + §2 包依赖图，生成到 `code-skeleton/`
2. 骨架 = 所有类/方法签名/参数/返回类型 + **分层接线**（Level 1：模块内真接线 `this.x.foo()` + adapter 真引 SDK，方法体不再全 throw，见 `references/skeleton-spike.md`「分层接线规则」）+ import 关系 + 类型契约 + 状态机枚举 + port/adapter 占位
3. **高密度骨架原则**——骨架注释暴露数据流/失败路径/SDK 契约/竞态/不变式（agent 不读代码推不出的信息），不只堆签名
4. **停止点**——签名+调用链+依赖方向可验证即停，不写实现逻辑。Level 1 下「调用链」= 代码里真实接线，**接线边界画线**见 `references/skeleton-spike.md`「接线边界画线（防 Level 1 滑向实现）」——硬纪律：只接调用+透传参数，不写业务逻辑/数据组装

**强制验证（移植 recursive-skeleton [MANDATORY]）：**
- [ ] `tsc --noEmit` / `cargo check` / `mypy` 类型检查通过（签名自洽 + Level 1 接线调用链签名匹配）
- [ ] `eslint` / lint 通过（无 `any` / `eslint-disable` / `TODO` 占位）
- [ ] 包依赖无环（import 与 §2 包依赖图一致）
- [ ] **调用链代码接线可达**（Level 1：每张 §4 时序图入口→底层在骨架代码里真实 `this.x.foo()` 接线，非仅 import 图）
- [ ] **adapter 真引 SDK** — 每个 `infra/*` adapter 方法真引用其 SDK（tsc 对 `@types/*` 验签），不 throw 占位
- [ ] **§3 签名表每个方法在骨架有定义**（orphan 检查，`check_code_arch.py` ③f）
- [ ] NFR④ 标并发的 UC，骨架已有幂等键/idempotency/锁字段

**失败处理：** 验证失败 → 回 Step 1 修签名/目录/依赖/时序图，不带着错误交接 ⑥。

**搭便车核对（改动7）：** 骨架验证时强制核对 ②搭便车清单每项的真实工作量。若 ⑤发现某项远超 ②预期（搭便车变主工程），必须回流 ②重新确认范围（带⑤骨架的真实代码证据），不能默默扩大范围。

**吸纳 ④prototype：** ④NFR 标记的高不确定性副作用（并发/缓存），其 stub 方法直接进骨架验证，不再「用完即删」。

## Phase Loop 机制

- 收敛失败 → 回 Step 1 调整架构/时序
- 时序图走不通 → 回 Step 2 系统设计调整模型边界
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- **骨架验证失败（签名/调用链/依赖不可编译）→ 回 Step 1 修纸面设计**，不带着错误交接
- **反哺触发上游修订**（详见 loop-skeleton.md Step 6b）→ 上游 .md 更新后，本阶段可能需重新对齐 → 回 Step 2 重追踪
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED + Step 7 骨架验证通过）时声称完成。**

- [ ] code-architecture.md 存在，frontmatter 含 `verdict: pass`
- [ ] code-architecture.html 存在，包依赖图+时序图正确渲染
- [ ] `changes/tracing-round-{N}.md` 存在
- [ ] `changes/review-code-arch.md` 存在且 verdict: APPROVED
- [ ] 工程目录树存在，每目录标注职责+变化轴
- [ ] 包依赖图（Mermaid）无循环依赖
- [ ] 每关键功能有时序图（Mermaid sequenceDiagram，入口→底层），异常路径覆盖
- [ ] **test-matrix 章节存在**（deliverable-template §6），来源 A 每 UC 覆盖正常/边界/异常/状态 4 类
- [ ] **时序图每个 alt/else 异常分支映射到 ≥1 条异常用例**（§4↔§6 双向可查）
- [ ] **§6 来源 B（NFR 风险→用例映射表）存在**，④每条 `验收方式=代码测试` 的缓解项有 ≥1 对应用例（双向可查）
- [ ] 方法签名表与时序图一致；Deep Module 词汇统一使用；接口满足可测性三原则
- [ ] **`code-skeleton/` 骨架代码存在，`tsc`/`eslint`（或等价）全过**（Step 7 gate）
- [ ] **每张时序图入口→底层调用链在骨架代码接线可达（Level 1：`this.x.foo()` 真实接线，非仅 import）**
- [ ] **adapter 真引 SDK** — `infra/*` adapter 不全 throw，真引用第三方 SDK（tsc 验 `@types/*`）
- [ ] **§9 骨架覆盖核验表存在且无 `❌ 未定义` / 无空行**（§3 签名 ↔ 骨架定义双向可查）
- [ ] **无 `any`/`eslint-disable`/`TODO` 占位**（非叶子方法体用接线，叶子逻辑用 `not implemented` 异常）
- [ ] **NFR④ 标并发的 UC，骨架已有幂等/锁字段**
- [ ] **②搭便车清单每项有⑤落点或已回流②打回**（追踪视角「搭便车闭环」）

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/code-architecture.md` + `.html`
- **骨架代码：** `.xyz-harness/${主题}/code-skeleton/`（Step 7 产出，可编译骨架，⑥Wave 的起点）
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

**Step 7 骨架验证通过后**向用户交接（按 loop-skeleton.md Step 6 格式）：

```
✅ ⑤代码架构设计 已完成并通过独立审查 + 骨架验证。
   产出：code-architecture.md + code-architecture.html + code-skeleton/（可编译骨架）
   审查报告：changes/review-code-arch.md（verdict: APPROVED）
   骨架验证：tsc/eslint 通过，调用链全可达
下一步：⑥执行计划 — Wave 拆分（从骨架叶子作用域推导），依赖 DAG，串并行标注
调用：/design-execution
是否现在进入下一步？
```

用户确认后才加载下一 skill。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
