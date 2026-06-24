# 设计工作流（6 步）

> 从业务需求到执行计划的完整设计流程。6 个 skill 按顺序串联，每个独立可调用。
> **不修改现有 coding-workflow 的 5-phase gate 流程**——这是独立的「设计前序」工作流，
> 在编码实现之前完成设计决策。

## 流程总览

```
①澄清需求  →  ②系统设计  →  ③Issue拆分  →  ④非功能设计  →  ⑤代码架构  →  ⑥执行计划
 业务目标      系统目标      细节问题       副作用分析      代码链路       Wave编排
 不碰实现      架构建模      P0-P3+方案      7维度兜底      类方法时序      串并行DAG
```

每一步内部走 **6 步循环**（交互→追踪→gap分流→收敛→定稿+HTML→独立审查），**审查 APPROVED 后**才提示进入下一步。用户确认才跳转。用户可随时手动跳过或回退。

```
每一步内部：
  Step1 Grilling 提问+初稿 → Step2 独立追踪(gap) → Step3 F/K/D 分流
  → Step4 收敛复核 → Step5 定稿.md + 渲染.html → Step6 独立审查(APPROVED?)
                                                        │
                                            ┌──── CHANGES_REQUESTED → 回 Step3
                                            ↓
                                       ✅ 审查通过 → 提示「进入下一步？」
```

## 6 个 skill 速查

| 步骤 | Skill | 触发命令 | 产出文件（.md + .html） | 一句话目标 | 可跳过当 |
|------|-------|---------|------------------------|-----------|---------|
| ① | xyz-harness-design-clarity | `/xyz-harness-design-clarity` | `requirements` | 明确业务目标→路线→用例/数据流/UI-UX，**不考虑系统实现** | 纯技术重构无业务变更 |
| ② | xyz-harness-design-architecture | `/xyz-harness-design-architecture` | `system-architecture` | 业务目标→系统目标，统一语言/架构/模块/边界/领域模型/状态机 | 已有成熟的 system-design.md |
| ③ | xyz-harness-design-issues | `/xyz-harness-design-issues` | `issues` | 系统设计→具体问题，P0-P3 优先级 + 方案对比取舍 | 系统设计已足够细化到代码层 |
| ④ | xyz-harness-design-nfr | `/xyz-harness-design-nfr` | `non-functional-design` | issue 解决方案的副作用分析 + 缓解（安全/性能/并发/稳定性/兼容性/可观测性） | 纯功能性小改动无 NFR 风险 |
| ⑤ | xyz-harness-design-code-arch | `/xyz-harness-design-code-arch` | `code-architecture` | 工程目录/契约协议/包管理/API入口→最底层 类方法时序图 | 已有详细的 interface 契约 + 时序 |
| ⑥ | xyz-harness-design-execution | `/xyz-harness-design-execution` | `execution-plan` | Wave 拆分（每 wave≈一个 subagent 高度专注），依赖 DAG，串并行标注 | 单人直接实现无需编排 |

> 每步产出**两份**：`.md`（真相源）+ `.html`（可视化视图，浏览器双击即可打开）。

## 共享机制

所有 6 个 skill 共用一套验证有效的流程骨架：

- **Grilling 提问法** — 逐节点遍历设计树，每个问题附推荐答案；一次一个问题；能查代码就不问用户（移植自 grill-me/grilling）
- **交互与追踪分离** — 主 agent 做交互，独立 fresh-context subagent 做强制视角追踪
- **F/K/D gap 分类** — 事实(二次确认)/知识(直接问)/决策(方案对比)
- **独立收敛** — 连续追踪到无新 gap 才收敛，不靠主 agent 自判
- **定稿 + HTML 渲染** — 收敛后定稿 .md，并渲染自包含 .html（移植自 visual-explainer，Mermaid 图表直接渲染）
- **独立审查门（Review Gate）** — 定稿后派 fresh-context 审查 subagent 从 5 维（内部一致性/上游对齐/可执行性/完整性/可视化质量）评审，APPROVED 才交接

详见 `skills/xyz-harness-design-clarity/references/shared-loop.md`（6 个 skill 共享引用，6 步循环的单一真相源）和 `skills/xyz-harness-design-clarity/references/visual-deliverable.md`（HTML 渲染规范）。

## 审查门（Review Gate）的作用

每一步定稿后，**必须**经过独立审查 subagent 的 APPROVED 才能进入下一步。审查与追踪是两种不同的检查：

| | Step 2/4 追踪 | Step 6 审查 |
|---|---|---|
| 问什么 | 信息完不完整？有没有 gap？ | 质量行不行？能不能用？ |
| 视角 | 强制枚举 N 视角（找遗漏） | 全局质量 5 维（判好坏） |
| 输出 | gap 列表（F/K/D） | verdict: APPROVED / CHANGES_REQUESTED |

**审查不通过 → 审查意见当 gap 回 Step 3 处理 → 重新定稿 → 再审。** 不通过不交接。

## 与 coding-workflow 5-phase 的关系

```
[设计工作流]                          [coding-workflow 编码流程]
①~⑥ 设计阶段  ──── ⑥执行计划产出 ────→  Phase 1-5 (spec→plan→dev→test→pr)
(本指南，独立)                        (现有 gate 编排，自动)
```

- 设计工作流的 6 个 skill **不接入**现有 gate 编排，是用户主动发起的设计工具
- 设计工作流的产出（requirements/system-architecture/issues/nfr/code-architecture/execution-plan）**可以作为现有 Phase 1-2 的输入**——执行计划⑥完成后，如需自动 TDD 编码，可启动现有 coding-workflow 的 Phase 流程
- 两条工作流可以独立使用，也可以串联

## 产出目录约定

所有产出写入 `.xyz-harness/${yyyy-MM-dd}-${主题简短标题}/`（各 skill 的 LOCAL-OVERRIDE 块有详细说明）。不同主题使用不同子目录，禁止混放。

目录结构示例：

```
.xyz-harness/2026-06-24-order-system/
├── requirements.md          ← ① 真相源
├── requirements.html        ← ① 可视化
├── system-architecture.md   ← ②
├── system-architecture.html ← ②
├── issues.md / issues.html  ← ③
├── non-functional-design.md / .html  ← ④
├── code-architecture.md / .html      ← ⑤
├── execution-plan.md / .html         ← ⑥
└── changes/
    ├── tracing-round-1.md   ← 各阶段追踪记录
    ├── tracing-round-2.md
    ├── review-clarity.md    ← 各阶段审查报告
    ├── review-architecture.md
    └── ...
```

## 何时只用其中几步

- **纯业务需求**：①→②→③→⑥（跳过④⑤，系统设计直接到执行）
- **技术重构**：②→③→④→⑤→⑥（跳过①，无业务目标变更）
- **紧急修复**：③→⑥（跳过①②④⑤，直接问题到执行）
- **简单功能**：①→②→⑥（跳过③④⑤，系统设计足够指导执行）

每一步都独立可用，不必强制走完全部 6 步。
