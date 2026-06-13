---
verdict: pass
parent:
  topic_dir: ../..
  spec: ../../spec.md
  manifest: ../../manifest.yaml
priority: P0
subsystem: brainstorming-phase
---

# Brainstorming Phase — 子系统 Spec

## Background

当前 brainstorming skill（`xyz-harness-brainstorming`）是按 L0（小型问题）设计的 10 步 checklist。它对中型、大型问题存在系统性不足：
- 无法自动识别问题规模
- 单 spec 无法覆盖跨模块需求
- 缺乏子系统分解方法论
- 缺乏接口合约定义
- gate 流程硬编码在 `executeGateTool` 中，6 件事混在一次调用

本 spec 定义 brainstorming 阶段的改造：**复杂度感知 + 流程分流 + gate 拆解 + 递归 topicDir 支持**。

## Functional Requirements

### FR-B1: 复杂度评估（complexity-assess 操作）

在 init 之后、skill-inject 之前，自动评估问题复杂度等级（L0/L1/L2）。

**输入：**
- 用户原始需求文本
- 项目结构（来自 Step 1 Quick Overview）
- 涉及的模块/文件范围

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
  reasoning: string;  // 为什么是这个等级
}
```

**规则：** 任一维度命中 L2 则整体 L2；任一维度命中 L1 则整体 L1。就高不就低。

### FR-B2: 子问题分解（decompose 操作）

L1/L2 时，在系统级 spec 之前执行子问题分解。

**输入：**
- 用户需求 + 复杂度评估结果
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
6. **推导执行波次**：拓扑排序 → 并行分组

**约束：**
- 同层子系统数 ≤ 8
- 叶子节点 spec ≤ 500 行
- 嵌套深度建议 ≤ 3 层（gate 警告但不阻断）

### FR-B3: 系统级 spec

L1/L2 时，分解后先写系统级 spec（父 topicDir 的 spec.md）。

**内容结构：**

```markdown
---
verdict: pass
parent: null  # 或指向更上层
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

### FR-B4: 接口合约定义（contract-define 操作）

L1/L2 时，在子系统 spec 之前定义子系统间的接口合约。

**产出：** `api-contracts.md`

**每个合约段包含：**
- 提供方子系统名
- 消费方子系统名列表
- 数据模型（TypeScript 接口）
- API 签名（函数签名 + 行为契约）
- 约束（性能、错误处理、线程安全等）

**合约必须在子系统 spec 之前确定。** 子系统 spec 引用合约中的接口定义，不能自行发明。

### FR-B5: 递归 spec 流程

L1/L2 时，子系统按执行波次（wave）逐批走 brainstorming 流程。

**流程：**

```
系统级 spec 通过
  → derive_waves(manifest) → [["A"], ["B", "C"], ["D"]]
  → wave 1: A 走 brainstorming 10 步 → spec 通过
  → wave 2: B, C 并行走 brainstorming → spec 通过
  → wave 3: D 走 brainstorming → spec 通过
  → 所有子系统通过 → 父级 spec_approved
```

**关键约束：**
- 子系统的 brainstorming 复用 L0 的 skill（xyz-harness-brainstorming）
- 子系统 spec 的 frontmatter 包含 `parent` 反向引用
- 子系统 spec 引用 `api-contracts.md` 中已定义的接口
- 子系统的 Assumption Audit 只检查自己的模块范围（不爆炸）

### FR-B6: Gate 拆解

将当前 `coding-workflow-gate(phase=1)` 中混合的 6 件事拆成独立可调用的原子操作。

**当前问题：** 一次 gate 调用中发生了 6 件事：

| # | 做了什么 | 应拆成的操作 |
|---|---------|------------|
| 1 | Phase Gate 脚本检查（文件存在性 + YAML） | `gate-check` |
| 2 | Review-Gate 循环（多轮内容审查） | `review-loop` |
| 3 | Anti-fraud 审查（防伪造检查） | `review-dispatch` |
| 4 | Review verdict 解析 | 合入 review-loop 和 review-dispatch |
| 5 | Retrospect steer 生成 | `retrospect` |
| 6 | 状态更新 + widget 刷新 | 编排层职责 |

**拆分后的 brainstorming phase pipeline（L0）：**

```
skill-inject(brainstorming)
  → [AI 执行 Step 1-9]
  → review-loop(phase=1, maxRounds=3)     # 多轮内容审查
  → gate-check(phase=1)                    # 文件存在性 + YAML
  → review-dispatch(phase=1)               # 防伪造
  → retrospect(phase=1)                    # 回顾
  → phase-transition()                     # 进入下一 phase
```

**拆分后的 brainstorming phase pipeline（L1/L2）：**

```
complexity-assess()
  → decompose()                            # 生成 manifest + children/
  → skill-inject(brainstorming-L1/L2)      # 系统级 skill
  → [AI 写系统级 spec + api-contracts]
  → gate-check(system-spec)                # 系统级文件检查
  → contract-check()                       # 合约一致性
  → for wave in derive_waves(spec):
      → parallel: for subsystem in wave:
          → skill-inject(brainstorming)    # 复用 L0 skill
          → [AI 写子系统 spec]
          → review-loop(subsystem-spec)
          → gate-check(subsystem-spec)
          → review-dispatch(subsystem-spec)
  → aggregate-status()                     # 汇总子系统状态
  → retrospect(system-spec)                # 系统级回顾
  → phase-transition()                     # 进入 plan phase
```

### FR-B7: 依赖约束执行

L1/L2 时，gate-check 在检查子系统前必须验证依赖约束。

**规则：**
- 子系统的 spec gate 要求所有 `depends_on` 中的子系统已 `spec_approved`
- 子系统的 dev gate 要求所有 `dev_depends_on` 中的子系统已 `dev_complete`
- 如果依赖不满足，返回明确的错误信息指出阻塞在哪个子系统

**实现：** gate-check.py 增加依赖检查逻辑，或由编排引擎在调用 gate-check 前检查 manifest。

### FR-B8: 合约一致性检查（contract-check 操作）

L1/L2 时，在系统级 spec gate 中验证合约一致性。

**检查项：**
1. `api-contracts.md` 中每个 `##` 标题在 `manifest.contracts` 中有对应条目
2. 每个 contract 的 provider 在 `manifest.children` 中存在
3. 每个 contract 的 consumers 在 `manifest.children` 中存在
4. 子系统 spec 的 `frontmatter.contract_section` 指向 `api-contracts.md` 中存在的锚点

## Acceptance Criteria

### AC-B1: 复杂度评估

- [ ] 给定一个小型需求（单文件改动），评估结果为 L0
- [ ] 给定一个中型需求（跨 3 个模块），评估结果为 L1
- [ ] 给定一个大型需求（跨子系统 + 数据迁移），评估结果为 L2
- [ ] 评估结果包含每个维度的评分和整体 reasoning

### AC-B2: 子问题分解

- [ ] L0 时不触发 decompose，直接走现有流程
- [ ] L1 时 decompose 生成 manifest.yaml + api-contracts.md 骨架
- [ ] L2 时 decompose 生成 manifest.yaml + api-contracts.md + 多级 children/
- [ ] 自动检测循环依赖并在 gate-check 时报错
- [ ] derive_waves 输出的波次满足依赖顺序

### AC-B3: 递归 spec

- [ ] L0：单 spec.md，扁平 topicDir
- [ ] L1：系统级 spec + 子系统 spec，1 级 children/
- [ ] L2：多级 children/，子系统 spec 引用 api-contracts.md
- [ ] 子系统 spec 的 frontmatter 包含 parent 反向引用
- [ ] 叶子节点的 gate-check 与当前行为一致（子系统不知道自己是子系统）

### AC-B4: Gate 拆解

- [ ] `gate-check` 可独立调用，传入 topicDir + phase，返回结构化 JSON
- [ ] `review-loop` 可独立调用，传入 topicDir + phase，返回 rounds/verdict
- [ ] `review-dispatch` 可独立调用，传入 topicDir + phase，返回 review 文件路径
- [ ] `retrospect` 可独立调用，传入 topicDir + phase，返回 steer 内容
- [ ] 现有 `coding-workflow-gate(phase=1)` 仍然可用，内部调用拆分后的 pipeline

### AC-B5: 依赖和合约

- [ ] 子系统 spec gate 检查 depends_on 的状态
- [ ] 合约锚点一致性在系统级 gate 中检查
- [ ] 循环依赖在 manifest 加载时检测

## Constraints

- brainstorming skill 的 L0 流程（Step 1-9）保持不变
- L1/L2 的增量步骤作为独立的 skill 或 skill 变体
- 不改动现有的 19 个 skills 内容（xyz-harness-brainstorming 等的 SKILL.md 文本不动）
- 复杂度评估是建议性的，用户可以 override

## Decisions

### D-B1: 复杂度评估由 AI 在 init 时完成，不是硬编码脚本

复杂度判断需要语义理解（"这个需求跨几个模块"），脚本无法做到。AI 在 init 后的第一轮对话中评估，结果写入 manifest。

### D-B2: L1/L2 的 skill 变体通过参数区分，不创建新 SKILL.md

现有 xyz-harness-brainstorming SKILL.md 不改。编排引擎在 inject skill 时注入额外的上下文指令（如"这是一个 L1 问题，以下是你需要额外完成的步骤"）。保持 skill 文件稳定。

### D-B3: manifest.yaml 是递归的，不是扁平的

每个有 children 的 topicDir 都有自己的 manifest.yaml。叶子节点没有 manifest.yaml（与当前 L0 topicDir 兼容）。

### D-B4: api-contracts.md 用 Markdown + TypeScript 代码块，不用独立 schema 文件

合约是人类可读的文档，不是机器校验的 schema。用 Markdown 的 `##` 锚点作为合约段 ID，用 TypeScript 接口描述数据模型。

### D-B5: 依赖检查在编排引擎层执行，不在 gate-check.py 中

gate-check.py 负责文件/YAML 检查（确定性）。依赖检查涉及读取多个 manifest（非确定性），由编排引擎在调用 gate-check 之前完成。

## 业务用例

### UC-B1: L0 小型问题（现有行为不变）

用户说"修复登录按钮样式" → init → complexity-assess = L0 → skill-inject(brainstorming) → 10 步 → spec.md → gate pipeline → 通过。

### UC-B2: L1 中型问题

用户说"添加插件热加载，涉及调度器、插件管理器、文件监控、API" → init → complexity-assess = L1 → decompose → manifest(4 个子系统) → 系统级 spec → api-contracts → 按 wave 做子系统 spec → 全部通过。

### UC-B3: L2 大型问题

用户说"构建完整权限体系——多租户、RBAC、审计日志" → init → complexity-assess = L2 → decompose → 多级 children（multi-tenant 下有 schema-isolation 和 connection-routing）→ 系统架构 spec → 依赖拓扑 → 按 wave 逐批 spec。

### UC-B4: 单独调试 gate-check

开发者不启动 workflow，直接调用 `coding-workflow-gate-check`，传入已有 topicDir + phase=1，得到结构化检查结果。

### UC-B5: 跳过某个 gate 步骤

开发者修改 phase 配置，移除 review-loop，只保留 gate-check + review-dispatch。pipeline 按配置执行。

## Complexity Assessment

- **领域复杂度**: L1 — brainstorming 流程改造，引入复杂度分级和递归结构
- **存储复杂度**: L1 — manifest.yaml + api-contracts.md，无 DB
- **数据流复杂度**: L2 — 子系统间有依赖拓扑 + 状态传播 + 合约一致性
- **API 复杂度**: L1 — 新增 4 个原子操作 tool
- **非功能性复杂度**: L1 — 向后兼容约束

整体：**L2**
