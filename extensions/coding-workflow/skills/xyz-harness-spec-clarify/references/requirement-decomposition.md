# 需求拆解：从模糊描述到分层澄清清单

Round 1 Step 3。在 complexity-assess 之后、Clarifying Questions 之前，按已确定的复杂度层级拆解需求。

**执行时机：** 必须在 complexity-assess（Step 2）之后——复杂度决定拆解发生在哪个层级。

**要解决的失败模式：** "一股脑丢出 20 个问题"（用户疲劳）、"顺着一个点深挖到底"（遗漏其他方面）、"把所有细节都试图在 Phase 1 澄清"（过度澄清，违反 YAGNI）。

## 复杂度决定拆解层级

拆解的粒度和层级由 complexity-assess 的结果决定：

| 复杂度 | 拆解层级 | 说明 |
|--------|---------|------|
| **L0** | 单层拆解 | 直接对整个需求做 Decomposition Map，走单一 clarify 流程 |
| **L1/L2** | 两层拆解 | 系统级先 `decompose`（划分子系统 → manifest + children + api-contracts，这是**不同的操作**）；每个子系统内部再各自做 Requirement Decomposition |

**关键区分：decompose ≠ Requirement Decomposition**
- `decompose`（A10 操作）：把大需求划分子系统，产出 manifest/children/api-contracts 骨架
- Requirement Decomposition（本文件）：在一个 clarify 范围内（整个需求或单个子系统）拆成方面，产出 Decomposition Map

L1/L2 时两者是包含关系：先 decompose 划分子系统，子系统内部再用本方法拆解方面。

## 两个大方向（引导，非强制清单）

拆解围绕两个大方向，每个方向内的细分由 AI 根据需求**动态决定**——不是固定必查项。

### 方向 A：需求（Requirement）

回答"做什么"。以下是一个**参考池**，AI 根据需求性质从中选用相关项，也可自行增加特殊方面（如安全合规、法务约束）。不强求全覆盖。

| 细分 | 含义 | 典型不清晰点 |
|------|------|-------------|
| User Story | 用户故事 / 核心使用场景 | 谁用？核心路径？交互流程？ |
| 验收标准（AC）| 完成判据 / 可量化标准 | 什么叫"完成"？如何验证？ |
| 业务规则 | 校验、约束、状态流转 | 哪些规则必须满足？状态怎么转？ |
| 边界场景 | 异常、边界、非主路径 | 并发？失败回滚？空数据？ |
| 角色与权限 | 参与者及其能做的操作 | 谁有权限？权限粒度？ |
| 数据生命周期 | 数据产生/流转/归档/删除 | 数据从哪来？怎么变更？多久清理？ |
| 非功能需求 | 性能/可用性/安全/合规 | QPS？可用性 SLA？合规要求？ |
| 集成依赖 | 与外部系统的交互 | 依赖哪个外部服务？同步还是异步？ |

### 方向 B：技术（Technical）

回答"怎么做"。同样是**参考池**，按需选用。

| 细分 | 含义 | 典型不清晰点 |
|------|------|-------------|
| 技术方案选型 | 选什么技术/框架/存储 | 用 SQL 还是 NoSQL？同步还是异步？ |
| 技术架构划分 | 系统怎么切分、模块职责 | 模块边界？依赖关系？分层？ |
| 具体技术点细节 | 某个具体技术点的实现 | 某个算法/协议/数据结构怎么实现？ |
| 接口契约 | API、协议、数据格式 | 对外接口？错误码？ |
| 数据存储设计 | 表结构、索引、迁移策略 | 核心表？索引？历史数据怎么处理？ |
| 错误处理策略 | 重试/降级/熔断/补偿 | 失败重试几次？降级方案？ |
| 部署运维 | CI/CD、监控、配置管理 | 怎么部署？监控指标？配置在哪？ |

**动态拆分原则：** 简单需求可能只拆 2-3 个方面，复杂需求可能 7-8 个。只拆与当前需求相关的，不强凑数、不强求全覆盖。

**子系统级拆解（L1/L2）：** 当处于子系统收敛循环时，Requirement Decomposition 只覆盖该子系统的范围。编排引擎通过 extraContext 注入子系统边界 + api-contracts.md，拆解时只拆该子系统涉及的方面。

## 清晰度标注

每个拆出的方面标注当前状态：

- `clear` — 用户已描述明确，或 Quick Overview 中代码已验证
- `unclear` — 有方向但细节缺失
- `unknown` — 需求中完全没提，需判断是否要澄清

## 优先级判定：Must-Now vs Defer-Ext

对每个 `unclear`/`unknown` 项判定澄清时机。核心是一个**反向问题**：

> 是否存在一个良好的抽象（策略模式 / 插件接口 / 配置驱动），使得"现在不确定"和"以后确定"的**实现成本差异很小**？是 → 可延后。

| 类别 | 判定标准 | 处理 |
|------|---------|------|
| **Must-Now** | 影响架构决策 / 阻塞核心流程追踪 / 不可逆或高成本逆转 | Round 1 必须澄清 |
| **Must-Now-Abstract** | 架构级但具体实现可变 | 现在只定抽象边界（接口/扩展点），实现延后 |
| **Defer-Ext** | 实现层细节，存在扩展点兜底 | 标记 `[DEFERRED-EXT]`，plan 阶段补扩展点，不阻塞收敛 |

判定示例：
- 选 SQL 还是 NoSQL → **Must-Now**（决定整个数据层走向）
- 支持哪几种支付方式 → **Defer-Ext**（策略接口兜底，先实现一种）
- 核心实体的状态枚举 → **Must-Now**（阻塞状态机追踪）
- 具体校验规则完整列表 → **Defer-Ext**（配置驱动，可后补）

判定由 AI 做初步标记，用户在 review 拆解图时可推翻。判定依据写进 Note 列，便于追溯。

### Defer-Ext 项的跨 Phase 传递

Defer-Ext 项标记 `[DEFERRED-EXT]` 后，记录到 `clarification.md` 的 Deferred Items 章节，包含"需要什么扩展点"。**传递机制：**

- spec.md 生成时（convergence-loop.md Step 11），Deferred Items 章节**原样复制**进 spec.md 的 "Deferred / 扩展点" 章节
- plan phase（Phase 2）读取 spec.md 时，必须检查 Deferred 章节，为每个 `[DEFERRED-EXT]` 项设计扩展点（策略接口 / 插件机制 / 配置驱动）
- gate-check 校验：spec.md 若有 Deferred 项，plan.md 必须有对应的扩展点设计（跨 phase 约束）

这样 Defer-Ext 不会在 phase 切换后丢失——它从 clarification.md 流入 spec.md，再约束 plan.md。

## 澄清顺序：概要 → 详细

按以下 Pass 分层澄清，**先骨架后血肉**：

```
Pass 0: 拆解 + 优先级标注（产出 Decomposition Map）
Pass 1: Must-Now 的技术架构层（选型/划分）→ 定骨架
Pass 2: Must-Now 的需求核心（核心 User Story / 验收标准）→ 定核心行为
Pass 3: Must-Now 的剩余（业务规则 / 接口契约 / 技术细节）→ 补充约束
Deferred: 所有 Defer-Ext 项 → 写入 clarification.md 的 Deferred 章节
```

- Pass 内部每个方面"先问大的、再问小的"
- 跨 Pass 不回头（Pass 2 不再深挖 Pass 1 已定的事）
- "一次一个问题"原则不变

### Decomposition Map 展示策略

Decomposition Map 产出自后，**一次性展示给用户**（完整表格），让用户确认：
1. 拆解方向是否正确（有没有遗漏的大方面）
2. 优先级判定是否合理（哪些 Must-Now、哪些 Defer-Ext）

这与"一次一个问题"不冲突——Map 是**整体概览确认**（一次展示），Step 4 的提问是**逐个深入**（一次一个）。用户确认 Map 后，AI 才开始按 Pass 逐个提问。

## 产出物：Decomposition Map

拆解结果写入 `clarification.md` 开头（Round 1 创建文件骨架时写入），格式：

```markdown
## Decomposition Map
- Complexity: {L0/L1/L2}

### A. Requirement
| Aspect | Sub-type | Clarity | Priority | Note |
|--------|----------|---------|----------|------|
| 订单创建流程 | User Story | unclear | Must-Now | 核心路径 |
| 支付方式支持 | AC | unknown | Defer-Ext | 先接口兜底 |

### B. Technical
| Aspect | Sub-type | Clarity | Priority | Note |
|--------|----------|---------|----------|------|
| 存储选型 | 选型 | unclear | Must-Now | 决定数据层 |
| 模块边界 | 架构划分 | unclear | Must-Now-Abstract | 定接口延后实现 |
```

这张 Map 是 Round 2+ 收敛循环的起点：追踪时发现新的 `unknown` 方面补充进来；Defer-Ext 项的扩展点设计留给 plan 阶段。

## 拆分示例：不同复杂度的动态粒度

拆分粒度随需求复杂度变化。以下是两个示例，展示从一句话需求到 Decomposition Map 的过程。

### 示例 1：L0 简单需求

**原始需求：** "给订单列表加一个导出 Excel 的按钮"

Quick Overview 发现：项目已有订单列表页、已有后端导出能力（CSV），前端用 Vue + 某组件库。

拆分结果（只拆 3 项，因为大部分已 clear）：

| Aspect | Sub-type | Clarity | Priority | Note |
|--------|----------|---------|----------|------|
| 导出触发方式 | User Story | clear | — | 点击按钮，复用现有导出入口 |
| 导出格式 | AC | unclear | Must-Now | 是真 Excel(.xlsx) 还是 CSV 改名？影响依赖 |
| 导出范围 | AC | unknown | Defer-Ext | 全量/筛选/分页——先做全量，分页配置化延后 |

### 示例 2：L1 中等需求

**原始需求：** "做一个优惠券系统"

Quick Overview 发现：项目是电商后端，已有订单/商品模块，无任何优惠相关代码。

拆分结果（拆 7 项，交叉覆盖需求与技术）：

| Aspect | Sub-type | Clarity | Priority | Note |
|--------|----------|---------|----------|------|
| 券类型支持范围 | User Story | unknown | Must-Now-Abstract | 先定券类型抽象（满减/折扣/立减接口），具体类型策略化延后 |
| 核发与核销流程 | User Story | unclear | Must-Now | 阻塞核心路径 |
| 叠加与互斥规则 | 业务规则 | unknown | Defer-Ext | 规则引擎化，先实现单券，叠加配置化延后 |
| 券状态机 | 业务规则 | unclear | Must-Now | 阻塞状态机追踪 |
| 存储选型 | 选型 | clear | — | 项目已用 Postgres，复用 |
| 与订单模块的耦合边界 | 架构划分 | unclear | Must-Now | 决定模块怎么切 |
| 失效与回收策略 | 数据生命周期 | unknown | Defer-Ext | 定时任务兜底，具体规则后补 |

**对比要点：** L0 拆 3 项且大部分 clear，只澄清 1 个 Must-Now 问题就收敛；L1 拆 7 项，Must-Now/Abstract 占主导，把实现细节大量 Defer-Ext。这正是"动态拆分"的体现——粒度由需求复杂度和 Quick Overview 的已有信息共同决定。
