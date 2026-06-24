---
name: xyz-harness-design-code-arch
description: >-
  Use when the user says "代码架构", "code architecture", "详细设计",
  "接口契约", "时序图", "工程目录", "API 设计", or has finished
  non-functional-design.md and needs concrete code-level architecture.
  Produces code-architecture.md. Design Step 5 of 6.
  Not for system-level architecture (Step 2) or issue decomposition (Step 3).
  Not for writing actual code (that's the execution/coding phase). This designs
  the code structure and contracts, not the implementation.
---

## 核心目标

将设计结论转换为**具体代码架构**：工程目录规划、API 契约（签名表）、包模块管理、从 API 入口到最底层的**类方法时序图**。

> **时序图是本阶段核心产出。** 因为代码已细化到类方法时序，Step 6 的 Wave 依赖关系能直接从时序图推导。

## 执行流程

按 `references/shared-loop.md`（位于 design-clarity skill 的 references 目录）的 6 步循环执行。

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
用 `references/deep-module-vocabulary.md` 的 Module/Interface/Depth/Seam/Adapter 统一语言设计接口。
依赖按 4 类分类决定 port；接口满足可测性三原则（accept deps / return results / small surface）。
时序图按 `references/sequence-template.md`。初稿用 `references/deliverable-template.md`。

**Step 2（追踪）— 派 fresh-context subagent，按 3 视角追踪：**
契约完整性（每用例/功能有对应 API 契约？）/ 调用链闭合（每时序图入口到底层完整、异常路径覆盖？）/ 依赖健康（包依赖无环、无上帝对象 LOC<400？）。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 shared-loop.md。

**特有信号：** 时序图走不通（数据流需跨层穿透/调用链断裂）→ system-architecture.md 模型边界有问题 → 回 Step 2 调整。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 code-architecture.md；按 design-clarity skill 的 `references/visual-deliverable.md` 渲染 code-architecture.html（主角图：包依赖图+核心时序图）。**

**Step 6（审查）— 派 fresh-context 审查 subagent，5 维评审，报告写 `changes/review-code-arch.md`。APPROVED 才交接。**

## Phase Loop 机制

- 收敛失败 → 回 Step 1 调整架构/时序
- 时序图走不通 → 回 Step 2 系统设计调整模型边界
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 shared-loop 全流程（含 Step 6 审查 APPROVED）时声称完成。**

- [ ] code-architecture.md 存在，frontmatter 含 `verdict: pass`
- [ ] code-architecture.html 存在，包依赖图+时序图正确渲染
- [ ] `changes/tracing-round-{N}.md` 存在
- [ ] `changes/review-code-arch.md` 存在且 verdict: APPROVED
- [ ] 工程目录树存在，每目录标注职责+变化轴
- [ ] 包依赖图（Mermaid）无循环依赖
- [ ] 每关键功能有时序图（Mermaid sequenceDiagram，入口→底层），异常路径覆盖
- [ ] 方法签名表与时序图一致；Deep Module 词汇统一使用；接口满足可测性三原则

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/code-architecture.md` + `.html`
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

审查 APPROVED 后向用户交接（按 shared-loop.md Step 6 格式）：

```
✅ ⑤代码架构设计 已完成并通过独立审查。
   产出：code-architecture.md + code-architecture.html
   审查报告：changes/review-code-arch.md（verdict: APPROVED）
下一步：⑥执行计划 — Wave 拆分，依赖 DAG，串并行标注
调用：/xyz-harness-design-execution
是否现在进入下一步？
```

用户确认后才加载下一 skill。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
