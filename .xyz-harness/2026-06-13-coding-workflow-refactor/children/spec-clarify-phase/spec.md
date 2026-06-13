---
verdict: pass
parent:
  topic_dir: ../..
  spec: ../../spec.md
  manifest: ../../manifest.yaml
priority: P0
subsystem: spec-clarify-phase
---

# Spec-Clarify Phase — 子系统 Spec

## Background

当前 Phase 1 的执行 skill（`xyz-harness-brainstorming`）是按 L0（小型问题）设计的 10 步 checklist。它对中型、大型问题存在系统性不足：
- 无法自动识别问题规模
- 单 spec 无法覆盖跨模块需求
- 缺乏子系统分解方法论
- 缺乏接口合约定义
- gate 流程硬编码在 `executeGateTool` 中，6 件事混在一次调用

本 spec 定义 **spec-clarify** 阶段（即 Phase 1）的改造：**复杂度感知 + 流程分流 + 递归 topicDir 支持**。

> **命名说明**：阶段概念名从 "brainstorming" 改为 "spec-clarify"，更准确反映其实际行为——需求澄清 + spec 编写 + 验证。执行层的 skill 名（`xyz-harness-brainstorming`）保持不变，不动 SKILL.md 内容。

### 核心认知：两阶段模型

spec-clarify 阶段由**性质完全不同的两个阶段**组成，必须明确区分：

| | 交互阶段（Interactive） | 自动化阶段（Automated） |
|---|---|---|
| **内容** | brainstorming 10 步 + 用户确认 | review + gate + retrospect |
| **执行者** | AI + 用户，多轮对话 | 代码自动执行，无需用户参与 |
| **耗时** | 不确定，取决于需求复杂度和讨论深度 | 可预测（几分钟） |
| **可中断** | 随时可以暂停，下次继续 | 不可中断 |
| **可跳过** | 否——跳过意味着 spec 质量失控 | 否——跳过意味着质量门失效 |

**自动化 pipeline 只作用于自动化阶段。** 交互阶段是一个人类主导的多轮对话过程，每一步都需要用户输入才能继续。把它建模成 pipeline 是根本性的设计错误——pipeline 意味着自动串行执行，但 brainstorming 的每一步都需要人类判断。

**并行在 spec-clarify 中不存在。** 即使 L1/L2 有多个子系统，每个子系统的 spec 也必须一个接一个地完成——后一个子系统依赖前一个产出的合约和上下文。并行只可能在自动化阶段（如并行 review），但交互阶段严格串行。

### 操作分类模型

spec-clarify 中的操作分为三类，不能混淆：

| 类型 | 触发方式 | 执行者 | 示例 |
|------|---------|--------|------|
| **自动化操作** | pipeline 自动触发 | 代码 | gate-check, review-loop, retrospect, contract-check, dependency-check |
| **交互驱动操作** | 交互对话中由 AI/用户决策触发 | AI + Code | decompose, contract-define, complexity-assess |
| **管理操作** | 系统状态变更时触发 | 代码 | init, skill-inject, phase-transition |
| **辅助操作** | 编排引擎内部调用，不暴露为独立 Tool | 代码 | aggregate-status (ManifestStore), commit (phase-transition 内), compact (phase-transition 内) |

**交互驱动操作**的关键特征：
- 触发时机由对话进程决定（不是 pipeline 自动触发）
- 执行包含 AI-step 和 Code-step 的混合
- 不可跳过、不可延迟到自动化阶段
- 不在 StepConfig pipeline 中声明——它们嵌在交互阶段的对话流中

## Functional Requirements

### FR-SC0: L0 流程（显式声明）

L0（小型问题）的流程与当前行为完全一致，此处显式声明以明确分叉点。

```
init(slug)
  → skill-inject("xyz-harness-brainstorming")   # 注入 L0 skill 内容

  ═══ 交互阶段（多轮人机对话）═══
  → [Step 1: Quick Overview]                    # AI 快速浏览项目
  → complexity-assess()                        # 基于 Quick Overview 结果评估，结果 = L0，写入 state
  → [Step 2-4: 提问 → 方案 → 设计]              # 每步需要用户参与
  → [Step 5: Assumption Audit]                  # AI 验证 + 用户确认
  → [Step 6: 写 spec.md]                        # AI 写文档
  → [Step 7: 六要素检查 + 歧义标记]              # AI 自检 + 用户确认
  → [Step 8: 术语 + ADR]                        # AI 扫描 + 用户确认
  → [Step 9: 用户审阅 spec]                     # 用户最终确认
  → [用户确认通过]
  ═══ 交互阶段结束 ═══

  ═══ 自动化阶段（pipeline）═══
  → gate-check(phase=1, scope="deliverables")       # Stage 1: 结构合规
  → review-loop(phase=1)                             # Stage 2: 多维度审查
    - D1: 真实性（引用验证）
    - D2: 完整性（六要素 + AC）
    - D3: 一致性（术语 + 引用）
    - D4: 充分性（用例覆盖 + 边界条件）[mayNeedUser]
    → 如有 NEEDS_USER: 退回用户澄清（局部 Q&A，不是重新 brainstorming）
  → gate-check(phase=1, scope="reviews")            # Stage 3: 审查文件合规
  → retrospect(phase=1)                              # Stage 4: 回顾
  → phase-transition()                               # compact → Phase 2
  ═══ 自动化阶段结束 ═══
```

**关键点：**
- 交互阶段和自动化阶段的分界线是**用户确认 spec 通过**
- complexity-assess 在 Step 1 Quick Overview 之后执行，评估需要项目结构信息
- skill-inject 注入的是原封不动的 `xyz-harness-brainstorming` skill 内容
- 自动化阶段中的 gate-check、review-loop、retrospect、phase-transition 是**跨 phase 共用的原子操作**，其接口定义在 `atomic-operations` 子系统中
- review-loop 是多维度审查（真实性、完整性、一致性、充分性），每个维度独立 subagent、增量收敛
- review-loop 的充分性维度（mayNeedUser=true）可能触发退回用户澄清——这是局部 Q&A，不是重新 brainstorming 全流程
- **交互阶段不在 pipeline 中**——它是 AI 和用户之间的多轮对话，不是可自动串行的操作

### FR-SC1: 复杂度评估（complexity-assess 操作）

在 init + skill-inject 之后、brainstorming Step 2（提问）之前，评估问题复杂度等级（L0/L1/L2）。

**触发时机**：`init → skill-inject → [Step 1: Quick Overview 完成] → complexity-assess → [Step 2: 提问]`

complexity-assess 必须在 Quick Overview 之后，因为评估需要项目结构信息。必须在 Step 2 提问之前，因为复杂度决定了后续走 L0 还是 L1/L2 流程。

**输入：**
- 用户原始需求文本
- 项目结构（来自 Step 1 Quick Overview 的产出）
- 涉及的模块/文件范围（Quick Overview 中的观察）

**评估维度：**

| 维度 | L0 | L1 | L2 |
|------|-----|-----|-----|
| 涉及模块数 | ≤ 1 | 2-5 | >5 或跨子系统 |
| 接口变更 | 无或简单 | 模块间接口 | 子系统间 + 外部 API |
| 数据模型 | 不变 | 局部新增/修改 | 新实体 + 数据迁移 |
| 非功能需求 | 无 | 1 项（性能或安全） | 2+ 项 |
| 已有约束 | 无 | 需兼容现有模式 | 需跨团队协调 |

**输出：**
```typescript
interface ComplexityAssessment {
  level: "L0" | "L1" | "L2";
  dimensions: {
    modules: { score: "L0" | "L1" | "L2"; detail: string };
    interfaces: { score: "L0" | "L1" | "L2"; detail: string };
    dataModel: { score: "L0" | "L1" | "L2"; detail: string };
    nonFunctional: { score: "L0" | "L1" | "L2"; detail: string };
    constraints: { score: "L0" | "L1" | "L2"; detail: string };
  };
  reasoning: string;
}
```

**规则：** 任一维度命中 L2 则整体 L2；任一维度命中 L1 则整体 L1。就高不就低。

**分工：**
- `[AI-step]` AI 分析需求文本和项目结构，对每个维度给出评分和 reasoning
- `[Code-step]` 代码将评分写入 state（`state.complexity`），决定后续 pipeline 分支

### FR-SC2: 子问题分解（decompose 操作）

L1/L2 时，在系统级 spec 之前执行子问题分解。

**输入：**
- 用户需求 + 复杂度评估结果（L1 或 L2）
- 项目结构

**输出：**
- `manifest.yaml`：子系统列表 + 依赖关系
- `children/` 目录结构
- `api-contracts.md`：子系统间接口合约（骨架）

**分解方法论：**

1. **识别领域边界**：按业务领域划分子系统（不按技术层）
2. **定义子系统职责**：每个子系统一句话描述
3. **识别跨系统接口**：子系统 A 需要从子系统 B 获得什么
4. **建立依赖拓扑**：A 依赖 B → B 必须先 spec 通过
5. **分配优先级**：P0（阻塞性）/ P1（重要）/ P2（可推迟）
6. **推导执行顺序**：拓扑排序 → 串行序列（derive_order）

**分工：**
- `[AI-step]` 分析需求，识别领域边界，划分子系统，定义职责和依赖关系，确定优先级。产出结构化的分解方案（文本）
- `[Code-step]` 解析 AI 产出的分解方案，创建 `children/` 目录结构，写入 `manifest.yaml` 骨架（子系统名 + 路径 + 优先级），写入 `api-contracts.md` 空模板（带 `##` 锚点占位），运行循环依赖检测
- `[Code-step]` 如果 AI 的分解结果导致循环依赖，返回错误让 AI 重新分解

**约束：**
- 同层子系统数 ≤ 8
- 叶子节点 spec ≤ 500 行
- 嵌套深度建议 ≤ 3 层（gate 警告但不阻断）
- **子系统执行顺序 = 依赖拓扑排序，严格串行，不并行**（见 D-SC8）

### FR-SC3: 系统级 spec

L1/L2 时，分解后先写系统级 spec（父 topicDir 的 spec.md）。

**分工：**
- `[AI-step]` 编写系统级 spec 内容（架构决策、子系统边界、全局约束、数据流总览、风险分级、验收标准、业务用例）
- `[Code-step]` 验证 spec 的 YAML frontmatter 格式，验证 children 列表与 manifest 一致

**内容结构：**

```markdown
---
verdict: pass
parent: null
children:
  - name: subsystem-a
    status: spec_in_progress
  - name: subsystem-b
    status: pending
---

# 系统级 Spec

## 架构决策          ← 整体架构选型、技术栈
## 子系统边界        ← 每个子系统的职责一句话定义
## 全局约束          ← 性能/安全/兼容性约束，所有子系统必须遵守
## 数据流总览        ← 子系统间的数据流向（引用 api-contracts.md）
## 风险分级          ← P0/P1/P2 标注
## 验收标准          ← 系统级 AC（通常是端到端的）
## 业务用例          ← 用户视角的端到端场景
```

### FR-SC4: 接口合约定义（contract-define 操作）

L1/L2 时，在子系统 spec 之前定义子系统间的接口合约。

**分工：**
- `[AI-step]` 为每个子系统间接口编写合约内容：数据模型（TypeScript 接口）、API 签名（函数签名 + 行为契约）、约束（性能、错误处理等）
- `[Code-step]` 将 AI 产出的合约段写入 `api-contracts.md` 对应的 `##` 锚点位置，验证每个合约段的 provider/consumer 在 manifest.children 中存在

**产出：** `api-contracts.md`

**每个合约段包含：**
- 提供方子系统名
- 消费方子系统名列表
- 数据模型（TypeScript 接口）
- API 签名（函数签名 + 行为契约）
- 约束（性能、错误处理、线程安全等）

**合约必须在子系统 spec 之前确定。** 子系统 spec 引用合约中的接口定义，不能自行发明。

### FR-SC5: 递归 spec 流程（严格串行 + compact）

L1/L2 时，子系统按依赖拓扑排序后**逐个串行**走 spec-clarify 流程。不存在并行。

**为什么不能并行：**
1. brainstorming 是纯人机交互流程——同一时间只有一个交互线程，用户不可能同时和两个子系统 brainstorming
2. 后一个子系统的 spec 依赖前一个子系统产出的合约和实现细节——信息依赖决定了串行顺序
3. 每个子系统完成后必须 compact——上下文必须清理，否则多个子系统的讨论历史会撑爆 context window

**L1/L2 完整流程：**

```
init(slug)
  → skill-inject("xyz-harness-brainstorming", extraContext=system-level)

  ═══ 交互阶段：系统级讨论 ═══
  → [Step 1: Quick Overview]
  → complexity-assess()                          # 结果 = L1 或 L2
  → [多轮人机对话：讨论大方向、识别子系统边界]
  → decompose()                                  # 生成 manifest + children/ + api-contracts.md 骨架
  → [多轮人机对话：定义接口合约]
  → contract-define()                            # AI 编写合约内容 → 写入 api-contracts.md
  → [多轮人机对话：系统级 spec 内容]
  → [用户确认系统级 spec]
  ═══ 系统级交互阶段结束 ═══

  ═══ 自动化阶段：系统级检查 ═══
  → gate-check(system-spec, scope="deliverables")      # 系统级结构合规
  → review-loop(system-spec)                           # 多维度审查
  → gate-check(system-spec, scope="reviews")           # 审查文件合规
  ═══ 系统级自动化阶段结束 ═══

  ═══ 子系统串行循环（按依赖拓扑排序）═══
  → derive_order(manifest) → ["A", "B", "C", "D"]  # 拓扑排序，纯串行
  → for subsystem in order:
      → dependency-check(subsystem)               # 验证 depends_on 已 spec_approved
      → skill-inject("xyz-harness-brainstorming", extraContext=subsystem)

      ═══ 交互阶段：子系统 brainstorming ═══
      → [多轮人机对话：该子系统的 10 步 brainstorming]
      → [用户确认子系统 spec]
      ═══ 子系统交互阶段结束 ═══

      ═══ 自动化阶段：子系统检查 ═══
      → gate-check(subsystem-spec, scope="deliverables")
      → review-loop(subsystem-spec)
      → gate-check(subsystem-spec, scope="reviews")
      → retrospect(subsystem-spec)              # 子系统级回顾（轻量级）
      ═══ 子系统自动化阶段结束 ═══

      → commit(subsystem-deliverables)           # git add + commit 子系统所有产出
      → compact()                                 # 清理上下文，为下一个子系统做准备
  ═══ 子系统循环结束 ═══

  ═══ 自动化阶段：收尾 ═══
  → manifestStore.aggregateStatus(topicDir)      # 汇总子系统状态（ManifestStore 方法）
  → retrospect(system-spec)                      # 系统级回顾
  → phase-transition()                           # 进入 plan phase
  ═══ 自动化阶段结束 ═══
```

**关键约束：**
- 子系统复用 L0 的 skill（`xyz-harness-brainstorming`），编排引擎注入额外上下文
- 子系统 spec 的 frontmatter 包含 `parent` 反向引用
- 子系统 spec 引用 `api-contracts.md` 中已定义的接口
- 子系统的 Assumption Audit 只检查自己的模块范围（不爆炸）
- **每个子系统完成后必须 compact**——保留 spec 文档，清理对话历史
- **compact 后 AI 失去前序子系统的对话记忆**——但 spec 文档已保留，后续 phase 可通过文件获取所有信息
- **derive_order 返回的是纯串行序列**，不是并行波次。即使两个子系统互相不依赖，也串行执行——因为共享同一个交互线程（用户）

### FR-SC6: 依赖约束执行

L1/L2 时，gate-check 在检查子系统前必须验证依赖约束。

**规则：**
- 子系统的 spec gate 要求所有 `depends_on` 中的子系统已 `spec_approved`
- 子系统的 dev gate 要求所有 `dev_depends_on` 中的子系统已 `dev_complete`
- 如果依赖不满足，返回明确的错误信息指出阻塞在哪个子系统

**实现：** 编排引擎在调用 gate-check 前检查 manifest（D-B5）。不在 gate-check.py 中增加逻辑。

**串行执行保证：** `derive_order` 使用拓扑排序确定子系统执行顺序。依赖约束在**编排引擎层**保证——只在前序子系统 spec_approved 后才开始下一个子系统的 brainstorming。这比 gate 时检查更早、更安全。

### FR-SC7: 合约一致性检查（contract-check 操作）

L1/L2 时，在系统级 spec gate 中验证合约一致性。

**检查项：**
1. `api-contracts.md` 中每个 `##` 标题在 `manifest.contracts` 中有对应条目
2. 每个 contract 的 provider 在 `manifest.children` 中存在
3. 每个 contract 的 consumers 在 `manifest.children` 中存在
4. 子系统 spec 的 `frontmatter.contract_section` 指向 `api-contracts.md` 中存在的锚点

**分工：**
- `[Code-step]` 全部由代码完成（锚点匹配 + 引用完整性），无需 AI 判断

## Acceptance Criteria

### AC-SC0: L0 Pipeline

- [ ] L0 问题走完 FR-SC0 定义的 pipeline，行为与当前 `coding-workflow-gate(phase=1)` 一致
- [ ] complexity-assess 对 L0 问题返回 L0
- [ ] L0 pipeline 不创建 manifest.yaml、children/、api-contracts.md

### AC-SC1: 复杂度评估

- [ ] 给定一个小型需求（单文件改动），评估结果为 L0
- [ ] 给定一个中型需求（跨 3 个模块），评估结果为 L1
- [ ] 给定一个大型需求（跨子系统 + 数据迁移），评估结果为 L2
- [ ] 评估结果包含每个维度的评分和整体 reasoning
- [ ] 用户可以手动 override 评估结果

### AC-SC2: 子问题分解

- [ ] L0 时不触发 decompose，直接走 FR-SC0 流程
- [ ] L1 时 decompose 生成 manifest.yaml + api-contracts.md 骨架
- [ ] L2 时 decompose 生成 manifest.yaml + api-contracts.md + 多级 children/
- [ ] 自动检测循环依赖并返回错误让 AI 重新分解
- [ ] derive_order 输出一维数组（拓扑排序），不含并行波次
- [ ] derive_order 结果满足依赖顺序——被依赖的子系统排在前面

### AC-SC3: 递归 spec

- [ ] L0：单 spec.md，扁平 topicDir
- [ ] L1：系统级 spec + 子系统 spec，1 级 children/
- [ ] L2：多级 children/，子系统 spec 引用 api-contracts.md
- [ ] 子系统 spec 的 frontmatter 包含 parent 反向引用
- [ ] 叶子节点的 gate-check 与当前行为一致（子系统不知道自己是子系统）
- [ ] **子系统严格串行**——同时只有一个子系统处于交互阶段
- [ ] **每个子系统完成后 compact**——compact 后 spec 文档仍在磁盘，对话历史已清理
- [ ] **子系统自动化阶段包含 retrospect**——轻量级回顾，产出 children/{name}/changes/reviews/{name}_retrospect.md
- [ ] **compact 后 AI 能正确开始下一个子系统的 brainstorming**——通过注入子系统 spec 的 extraContext 恢复上下文
- [ ] **derive_order 返回一维数组**，不是二维波次
- [ ] **系统级回顾**在所有子系统完成后执行——回顾覆盖整体分解和各子系统执行情况

### AC-SC4: 依赖和合约

- [ ] 子系统 spec gate 检查 depends_on 的状态
- [ ] 合约锚点一致性在系统级 gate 中检查
- [ ] 循环依赖在 manifest 加载时检测

## Tool 设计策略

### D-SC7: 原子操作的 Tool 暴露策略

日常流程和独立调试使用不同的 Tool 入口：

| 场景 | Tool 名称 | 参数 | 说明 |
|------|----------|------|------|
| **日常流程** | `coding-workflow-init` | slug | 保留现有，内部自动编排 pipeline |
| **日常流程** | `coding-workflow-gate` | phase | 保留现有，内部按 pipeline 配置依次调用原子操作 |
| **日常流程** | `coding-workflow-phase-start` | （无） | 保留现有，触发 phase 切换 |
| **独立调试** | `coding-workflow-run-op` | action + 操作特定参数 | 新增，用于单独调用任意原子操作 |

**`coding-workflow-run-op` 参数定义：**

```typescript
const RunOpParams = Type.Object({
  action: StringEnum([
    "complexity-assess",
    "decompose",
    "contract-define",
    "contract-check",
    "dependency-check",
    "review-loop",
    "gate-check",
    "retrospect",
    "phase-transition",
    "skill-inject",
    "test-fix-loop",
    "skill-inject",
    "test-fix-loop",
    // 不暴露: init（需要 workflow 未激活状态）
    // 不暴露: aggregate-status（改为 ManifestStore.aggregateStatus() 内部调用）
  ]),
  topicDir: Type.String({ description: "工作目录路径" }),
  phase: Type.Optional(Type.Number({ description: "Phase 编号，部分操作需要" })),
  maxRounds: Type.Optional(Type.Number({ description: "review-loop 最大轮数，默认 3" })),
});
```

**不把 5 个原子操作收口为 1 个 Tool 的原因：**
1. 日常流程中 AI 通过 `coding-workflow-gate` 和 `coding-workflow-init` 触发编排，不需要知道原子操作的存在
2. `run-op` 仅用于开发调试和手动执行，AI 不会在日常流程中主动选择它
3. 每个 action 的参数完全不同，收口成 union schema 增加理解成本

**不使用 "Infra" 标签的原因：**
gate-check、dependency-check、contract-check 都是 Tool，只是内部不调 AI。它们和 review-loop 在 Tool 这个维度上是平等的，区别仅在于内部是否有 AI 调用。在可视化中用视觉手段（如填充色深浅）区分，不引入新的分类维度。

## Constraints

- `xyz-harness-brainstorming` SKILL.md 内容零改动（GC-3）
- L1/L2 的增量步骤通过编排引擎的参数注入实现，不创建新 SKILL.md 文件
- 复杂度评估是建议性的，用户可以 override
- 递归深度软限制 3 层
- Tool 总数：现有 3 个 + 新增 1 个 `run-op` = 4 个，不新增其他 Tool
- **交互阶段不可自动化**——brainstorming 的每一步都需要用户参与，不能作为 pipeline step
- **子系统 spec 严格串行**——同一时间只能有一个子系统处于交互阶段
- **每个子系统完成后必须 compact**——spec 文档保留到磁盘，对话历史清理
- **子系统级 retrospect 是轻量级的**——只覆盖该子系统的 brainstorming 执行质量（不重复系统级回顾的范围）。产出到 children/{name}/changes/reviews/ 下
- **commit 是管理操作**——subsystem-spec 完成后 git add + commit 所有产出文件（spec.md、reviews/），确保磁盘状态与 git 状态一致。不是独立原子操作，是 compact 前的标准化步骤。同时写入 `children/{name}/.state.json` 记录子系统状态

## Decisions

### D-SC1: 复杂度评估由 AI 在 Quick Overview 后完成

复杂度判断需要语义理解（"这个需求跨几个模块"），脚本无法做到。AI 在 Step 1 Quick Overview 完成后、Step 2 提问前评估，结果写入 state。评估依赖 Quick Overview 获得的项目结构信息。

### D-SC2: L1/L2 的 skill 变体通过参数注入，不创建新 SKILL.md

现有 `xyz-harness-brainstorming` SKILL.md 不改。编排引擎在 inject skill 时注入额外的上下文指令（如"这是一个 L1 问题，以下是你需要额外完成的步骤"）。保持 skill 文件稳定。

### D-SC3: manifest.yaml 是递归的，不是扁平的

每个有 children 的 topicDir 都有自己的 manifest.yaml。叶子节点没有 manifest.yaml（与当前 L0 topicDir 兼容）。

### D-SC4: api-contracts.md 用 Markdown + TypeScript 代码块，不用独立 schema 文件

合约是人类可读的文档，不是机器校验的 schema。用 Markdown 的 `##` 锚点作为合约段 ID，用 TypeScript 接口描述数据模型。

### D-SC5: 依赖检查在编排引擎层执行，不在 gate-check.py 中

gate-check.py 负责文件/YAML 检查（确定性）。依赖检查涉及读取多个 manifest（非确定性），由编排引擎在调用 gate-check 之前完成。

### D-SC8: 子系统 spec 严格串行，不并行

即使两个子系统互相不依赖（理论上可以并行），spec-clarify 阶段也不并行执行它们。原因：

1. **共享交互线程**：用户同一时间只能和一个子系统 brainstorming。并行意味着用户要同时回答两个子系统的问题，这在认知上不现实。
2. **信息依赖实际存在**：即使 manifest 中没有显式 depends_on，后讨论的子系统总能从前一个子系统已确定的 spec 中获得更精确的上下文（"原来接口长这样"）。
3. **上下文管理**：每个子系统完成后 compact 是硬性要求。如果并行，无法确定 compact 的时机。
4. **质量 > 速度**：spec 阶段的正确性远比速度重要。一个错误的 spec 会导致后续所有 phase 的返工。

`derive_order` 返回的是一维数组（如 `["A", "B", "C"]`），不是二维波次数组（如 `[["A"], ["B", "C"]]`）。波次调度的概念在 spec-clarify 阶段不存在，只在后续 dev/test phase 中可能使用。

### D-SC9: Compact 是子系统间的硬性要求

每个子系统 spec 完成后必须 compact：
- **保留**：spec.md 文件、manifest.yaml、api-contracts.md（磁盘上的文件不受 compact 影响）
- **清理**：该子系统 brainstorming 的对话历史、中间讨论、临时笔记
- **目的**：为下一个子系统腾出 context window，避免上下文膨胀导致后续 brainstorming 质量下降
- **代价**：compact 后 AI 失去该子系统的对话记忆，但 spec 文档已完整保留在磁盘。后续 phase 通过读取文件获取信息，不依赖对话历史

### D-SC10: derive_order 替代 derive_waves

spec-clarify 阶段不需要波次调度。`derive_order` 是一个简单的拓扑排序，返回一维数组。它和 `derive_waves` 的区别：

| | derive_order（spec-clarify 用） | derive_waves（dev/test 用） |
|---|---|---|
| 返回类型 | `string[]`（一维） | `string[][]`（二维波次） |
| 并行性 | 严格串行 | 波次内可并行 |
| 适用场景 | 需要人机交互的阶段 | 纯代码执行的阶段 |

### D-SC6: Gate 拆解的详细接口定义在 atomic-operations 子系统中

本 spec 只声明 spec-clarify phase 使用哪些原子操作和什么顺序。原子操作的输入输出 schema、重试策略、降级行为等细节由 `atomic-operations` 子系统定义。

## 业务用例

### UC-SC1: L0 小型问题（现有行为不变）

用户说"修复登录按钮样式" → init → skill-inject(brainstorming) → Quick Overview → complexity-assess = L0 → 10 步交互 → spec.md → 自动化 pipeline（gate + review + retrospect）→ 通过。

### UC-SC2: L1 中型问题

用户说"添加插件热加载，涉及调度器、插件管理器、文件监控、API" → init → skill-inject → Quick Overview → complexity-assess = L1 → 交互讨论子系统边界 → decompose → manifest(4 个子系统) → 交互讨论合约 → contract-define → 交互写系统级 spec → 系统级自动化检查通过 → 按 derive_order 顺序逐个做子系统 brainstorming（串行：调度器 → 插件管理器 → 文件监控 → API，每个完成后 commit + compact）→ 全部子系统通过 → 系统级回顾 → phase-transition。

### UC-SC3: L2 大型问题

用户说"构建完整权限体系——多租户、RBAC、审计日志" → init → skill-inject → Quick Overview → complexity-assess = L2 → 交互讨论整体架构 → decompose → 多级 children（multi-tenant 下有 schema-isolation 和 connection-routing）→ 交互讨论跨子系统合约 → contract-define → 交互写系统架构 spec → 系统级自动化检查 → 按 derive_order 逐个完成子系统 spec（串行，每完成一个 commit + compact）→ 全部通过 → 回顾 → phase-transition。

**时间线**：可能需要数天完成所有子系统 spec。每个子系统 spec 可能 1-2 小时。中间可以随时暂停——spec 文档已保存在磁盘，下次直接从下一个子系统继续。

### UC-SC4: 单独调试原子操作

开发者不启动 workflow，直接调用 `coding-workflow-gate-check`，传入已有 topicDir + phase=1，得到结构化检查结果。

### UC-SC5: 跳过某个 pipeline 步骤

开发者修改 phase 配置，移除 Phase 1 的 review-loop，只保留 gate-check + retrospect。pipeline 按配置执行。

### UC-SC6: 用户 override 复杂度

AI 评估为 L0，用户说"这个其实涉及 3 个模块，请按 L1 处理" → state.complexity 更新为 L1 → 走 L1 pipeline。

## Complexity Assessment

- **领域复杂度**: L1 — spec-clarify 流程改造，引入复杂度分级和递归结构
- **存储复杂度**: L1 — manifest.yaml + api-contracts.md，无 DB
- **数据流复杂度**: L1 — 子系统间串行执行 + 状态传播 + 合约一致性（移除了并行波次调度，复杂度从 L2 降到 L1）
- **API 复杂度**: L1 — 新增 complexity-assess/decompose/contract-define/contract-check 4 个操作
- **非功能性复杂度**: L1 — 向后兼容约束 + compact 必须保留 spec 文档

整体：**L1**

> 注：上一个版本将数据流复杂度评为 L2 是因为假定了并行波次调度。修正为严格串行后，数据流复杂度显著降低——只需处理线性序列的状态传播，不需要处理并行竞态和合并。
