---
verdict: pass
parent: null
children:
  - name: spec-clarify-phase
    status: spec_approved
  - name: atomic-operations
    status: spec_approved
  - name: orchestrator
    status: spec_approved
---

# coding-workflow 拆分重构 — 系统级 Spec

## Background

coding-workflow 是一个 5-phase 编码工作流扩展（~2500 行 TS + 827 行 Python + 19 skills + 18 agents）。所有逻辑耦合在单体 extension 中：编排、执行、基础设施混在一起。

本次重构的核心目标是 **拆成原子操作 + 声明式编排 + 复杂度感知**。

本 spec 是系统级 spec，定义整体架构、子系统边界和全局约束。每个子系统的具体设计见 `children/` 下的子 spec。

## 子系统边界

| 子系统 | 职责 | 产出目录 |
|--------|------|---------|
| **spec-clarify-phase** | spec-clarify 流程的复杂度分级（L0/L1/L2）、流程分流、递归 topicDir 结构设计 | `children/spec-clarify-phase/` |
| **atomic-operations** | 原子操作提取为独立 tool（含 gate 拆解的详细接口定义），共享基础设施模块化 | `children/atomic-operations/` |
| **orchestrator** | pipeline 执行器、依赖拓扑调度、状态传播、wave 自动推导 | `children/orchestrator/` |

## 全局约束

### GC-1: 不新增 extension

所有改动在 `extensions/coding-workflow/` 目录内完成。不创建新 extension。

### GC-2: 不新增依赖

仅使用现有依赖（typebox, js-yaml, Pi SDK）。

### GC-3: skills 和 agents 不动

19 个 skills 和 18 个 agents 只改归属目录，内容零改动。

### GC-4: 向后兼容

现有的 3 个 tool（gate/init/phase-start）保持注册。新增原子操作 tool 是增量暴露。

### GC-5: gate-check.py 不拆分

827 行 Python 脚本保持原样。后续可单独优化。

### GC-6: 递归 topicDir 结构

系统支持无限嵌套的子系统 topicDir。任何有 `manifest.yaml` 的目录就是一个 topicDir，`children/` 下可嵌套更多 topicDir。

### GC-7: 依赖声明和调度策略

子系统间通过 `manifest.yaml` 声明依赖关系。编排引擎从依赖图自动推导执行顺序（拓扑排序）。自动检测循环依赖。

**调度策略因阶段而异：**
- **spec-clarify 阶段**：`derive_order` → 一维串行序列（严格串行，因为需要人机交互）
- **dev/test 阶段**：`derive_waves` → 二维并行波次（纯代码执行，无依赖的子系统可并行）

调度策略选择由阶段性质决定，不由配置决定。

### GC-8: 正反向关联

- **正向**：manifest.yaml 的 `children` 列表 + `depends_on` + `contracts`
- **反向**：子系统 spec.md 的 frontmatter.parent 字段
- **合约**：`api-contracts.md` 定义子系统间接口，manifest.yaml 的 `contracts` 索引

## 系统级数据模型

### manifest.yaml Schema

```yaml
name: string                    # topic 名称
slug: string                    # 目录名
parent:                         # 反向引用（根节点为 null）
  path: string                  # 相对于自身的父目录
  name: string
status: string                  # 状态枚举
children:                       # 子系统列表
  - name: string
    path: string                # 相对于父 topicDir
    status: string
    depends_on: string[]        # spec 阶段依赖
    dev_depends_on: string[]    # dev 阶段依赖（可选，默认 = depends_on）
    priority: P0 | P1 | P2
    contract_sections:          # 该子系统参与的合约
      - provides: string        # api-contracts.md 中的锚点
      - consumes: string[]
contracts:                      # 合约索引
  - id: string
    file: string                # api-contracts.md 中的锚点
    provider: string            # 提供方子系统名
    consumers: string[]         # 消费方子系统名列表
```

### 状态枚举

```
pending → spec_in_progress → spec_approved → plan_in_progress → plan_approved
→ dev_in_progress → dev_complete → test_in_progress → test_complete → pr_complete
```

### 依赖传播规则

```
子系统 spec gate PASS
  → manifest.children[name].status = "spec_approved"

所有子系统 spec approved 且依赖满足
  → 父级 gate-check(system-spec) 允许 PASS

子系统 dev gate PASS
  → manifest.children[name].status = "dev_complete"

所有子系统 dev complete
  → 父级 integration test 可以开始
```

## 接口合约

### spec-clarify-phase → atomic-operations

spec-clarify-phase 定义每个 phase 需要**哪些**原子操作和**什么顺序**。atomic-operations 负责实现这些操作。

**合约接口**：

```typescript
interface OperationSpec {
  id: string;                    // 操作 ID
  inputSchema: object;           // typebox schema
  outputSchema: object;          // typebox schema
  invocation: "pipeline" | "interactive" | "management";  // 触发方式
  phaseUsage: Record<number, {
    inPipeline: boolean;         // 是否在自动化 pipeline 中
    position?: number;           // pipeline 中的位置（仅 inPipeline=true 时）
    triggerPoint?: string;       // 交互阶段中的触发点描述（仅 invocation=interactive 时）
  }>;
}
```

### spec-clarify-phase → orchestrator

spec-clarify-phase 定义 pipeline 配置的结构。orchestrator 负责执行。

**合约接口**：

```typescript
interface PipelineConfig {
  phase: number;
  pipeline: StepConfig[];
}

interface StepConfig {
  operation: string;             // 操作 ID
  args?: Record<string, unknown>;
  on_fail: "return" | "retry" | "warn_continue";
  max_retries?: number;
}
```

### atomic-operations → orchestrator

atomic-operations 实现统一的 Operation 接口。orchestrator 通过这个接口调用。

**合约接口**：

```typescript
interface Operation {
  readonly id: string;
  execute(ctx: OperationContext): Promise<OperationResult>;
}

interface OperationResult {
  passed: boolean;
  data?: Record<string, unknown>;
  fixGuidance?: string;
  duration_ms: number;
  token_usage?: UsageStats;
}
```

## 复杂度分级

### GC-9: 复杂度感知分流

系统入口（init 操作）评估问题复杂度，决定使用哪套流程模板：

| 维度 | L0 (小型) | L1 (中型) | L2 (大型) |
|------|----------|----------|----------|
| 涉及模块数 | 1 | 2-5 | >5 或跨子系统 |
| 接口变更 | 无或简单 | 模块间 | 子系统间 + 外部 |
| 数据模型 | 不变 | 局部变更 | 新实体 + 迁移 |
| 非功能需求 | 无 | 性能或安全 | 性能 + 安全 + 可观测 |
| topicDir 结构 | 扁平 | 1 级 children | 2+ 级 children |

- **L0**：当前 spec-clarify 流程不变（10 步 brainstorming skill），扁平 topicDir
- **L1**：增加子问题分解 + 模块级 spec + api-contracts
- **L2**：系统架构 spec + 子系统独立 spec + 依赖拓扑 + 风险分级

## 业务用例

### UC-1: L0 小型问题（不变）

直接走 `/coding-workflow "修复登录按钮样式"`，扁平 topicDir，当前流程。

### UC-2: L1 中型问题

`/coding-workflow "给 dag-executor 添加插件热加载"` → 自动评估为 L1 → decompose 生成 manifest.yaml + children/ → 按 derive_order 顺序逐个做子系统 spec（串行）。

### UC-3: L2 大型问题

`/coding-workflow "构建完整的权限体系"` → 自动评估为 L2 → 系统架构 spec → 多级子系统 → 依赖拓扑 → 按 derive_order 逐个完成子系统 spec（串行，每完成一个 compact）。

### UC-4: 单独调试原子操作

不启动 workflow，直接调用 `coding-workflow-gate-check`，传入 topicDir + phase。

### UC-5: 调整 phase pipeline

修改 phase 配置（未来 YAML；当前 TypeScript 数组），改变操作的顺序或跳过某些操作。

## Complexity Assessment

整体：**L1** — 跨 3 个子系统、有依赖拓扑、需要接口合约、涉及状态传播机制。spec-clarify 阶段严格串行，无需并行波次调度，复杂度可控。
