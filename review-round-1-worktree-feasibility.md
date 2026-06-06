# Review Loop + Worktree-Run 在 coding-workflow 各阶段的可行性分析

## 一、当前架构概览

### coding-workflow 运行模型

coding-workflow 是 Pi extension，5 阶段顺序执行（Spec → Plan → Dev → Test → PR）。核心调度机制：

1. **主 agent**（Pi 会话）编排流程，通过 `coding-workflow-gate` 工具触发 gate 检查
2. **Gate 工具**三步走：运行 Python 脚本检查交付物 → dispatch review subagent（独立 Pi 进程）→ 解析 review 结果
3. **Review subagent** 通过 `runSingleAgent()` 启动独立 Pi 进程（`child_process.spawn`），加载 `xyz-harness-gate-reviewer` skill 做 anti-fraud 审查
4. Phase 3 (Dev) 的 content review 由 `expert-reviewer` skill 在主 agent 编排下完成

### 已有的 worktree 基础设施

| Skill | 作用 |
|-------|------|
| `create-worktree` | 在 bare repo workspace 中创建隔离 worktree（独立分支 + 目录） |
| `merge-worktree` | 完成合并流程：验证 → PR → merge → 发布 → 清理 |
| `code-review-worktree` | 多维度并行 code review，支持 harness/standalone 模式自动检测 |

项目本身就在 bare+worktree 结构下工作（当前 worktree: `feat-coding-workflow-recheck`）。

## 二、Review Loop 概念映射

用户提到的 "parent-orchestrated review loop" 是一种模式：
- **Parent** = 主编排 agent，负责调度和最终决策
- **Reviewer** = 独立 context 的审查 agent，只读不写
- **Worker** = 执行修复的 agent
- **Loop** = reviewer 发现问题 → worker 修复 → reviewer 再审 → 直到无 blocker

当前 coding-workflow **已有** review loop 的雏形：
- Gate 工具的 retry 机制（`maxGateRetries = 10`）
- Gate fail → 主 agent 修复 → 重新 gate → 循环直到 pass

但**缺失**：
- 没有多轮 review loop（gate review 只跑一次 anti-fraud check，不是 parent-orchestrated 模式）
- 没有 fresh-context reviewer（当前 gate reviewer 是 subagent，但只有一轮）
- 没有 fix worker 的隔离执行

## 三、各阶段逐一分析

### Phase 1 (Spec) + Phase 2 (Plan) — 文档阶段

| 维度 | 分析 |
|------|------|
| **review loop 价值** | 中等。spec/plan 是文档，当前已有 expert-reviewer skill 做 content review。引入多轮 review loop 可以提升 spec 质量（reviewer 发现遗漏 → 补充 → 再审） |
| **worktree 隔离** | **无意义**。spec/plan 阶段产出的是 `.xyz-harness/{topic}/spec.md` 和 `plan.md`，不涉及代码变更。reviewer 只需要读文件、写 review 文件。在独立 worktree 中做这件事没有任何收益——worktree 的核心价值是隔离代码变更（git diff、编译、测试），文档阶段不需要这些 |
| **建议** | 引入 review loop（多轮 reviewer），但**不用 worktree**。用现有的 subagent 模式即可——reviewer subagent 读取文档、输出 review，主 agent 根据反馈修改 |

### Phase 3 (Dev) — 编码阶段

| 维度 | 分析 |
|------|------|
| **review loop 价值** | **最高**。这是代码变更最密集的阶段，当前有 expert-reviewer + 5 维度 review（BLR, standards, robustness, integration, taste），但只有一轮。多轮 loop 能捕获更多问题 |
| **worktree 隔离** | **有意义但有代价**。详见下方分析 |
| **当前已有机制** | `code-review-worktree` skill 已经支持多维度并行 review，但它是独立 skill，未被 coding-workflow 的 gate 流程集成 |

#### Dev 阶段 worktree 隔离的利弊

**利：**
1. Reviewer 在干净 worktree 中工作，不受主 agent 的未提交变更污染
2. Fix worker 可以在隔离 worktree 中修改，不破坏主 worktree 的当前状态
3. 天然支持 rollback（删除 fix worktree 即可）
4. 与 `code-review-worktree` skill 现有架构一致

**弊：**
1. **合并复杂度**：fix worker 在 worktree A 修复，需要 merge 回主 worktree B。如果主 agent 在等待 review 期间也做了修改，会有冲突
2. **性能开销**：每个 review cycle 创建/销毁 worktree + 安装依赖（`pnpm install`）= 分钟级延迟
3. **状态同步**：coding-workflow 的状态（`WorkflowState`）存在 session entries 中，worktree 中的新 Pi 进程看不到主 session 的状态
4. **文件产出路径**：review 文件（`changes/reviews/*.md`）需要写回主 worktree 的 `.xyz-harness/` 目录。worktree 隔离后需要明确的路径映射

### Phase 4 (Test) — 测试阶段

| 维度 | 分析 |
|------|------|
| **review loop 价值** | 中等。测试执行结果验证，当前 gate 已检查 test_execution.json 的完整性。可以引入 reviewer 检查测试质量（覆盖率、边界条件） |
| **worktree 隔离** | **部分有意义**。如果 reviewer 需要运行测试验证结果真实性，需要干净环境。但当前 gate-reviewer 只做 anti-fraud 静态检查（不运行测试），所以目前不需要 |

### Phase 5 (PR) — 发布阶段

| 维度 | 分析 |
|------|------|
| **review loop 价值** | 低。主要是收集 PR 证据和 CI 结果 |
| **worktree 隔离** | 无意义。PR 阶段不产生代码变更 |

## 四、技术可行性：worktree-run 的实现路径

### 路径 A：Pi 内置 subagent tool（如果支持 worktree 参数）

当前 `subagent.ts` 的 `runSingleAgent()` 通过 `child_process.spawn` 启动独立 Pi 进程，`cwd` 参数控制工作目录。**Pi 的 subagent tool 本身没有 `worktree: true` 选项**——这是 Pi 核心的功能，不是 extension 能控制的。

当前代码：
```typescript
// subagent.ts - runSingleAgent
const procResult = await pm.spawn(invocation.command, invocation.args, {
    cwd,  // ← 只是指定工作目录，不创建 worktree
    signal,
    processRegistry,
});
```

### 路径 B：Extension 自己管理 worktree

coding-workflow extension 可以在 review dispatch 时：
1. 调用 `create-worktree.sh` 创建临时 worktree
2. 将 reviewer subagent 的 `cwd` 指向新 worktree
3. Review 完成后，读取 review 文件，删除 worktree

**需要改造的地方：**

| 改造点 | 工作量 | 风险 |
|--------|--------|------|
| `review-dispatcher.ts` 添加 worktree 创建逻辑 | 中 | 低 |
| 引入 `create-worktree.sh` 脚本路径 | 小 | 无 |
| Review 文件路径映射（worktree → 主 worktree） | 中 | 中（路径不一致） |
| Fix worker 的 worktree 管理 | 大 | 高（合并冲突处理） |
| 状态同步机制 | 大 | 高（跨 session 状态） |

### 路径 C：SKILL 层面指导（最轻量）

不改 extension 代码，在 SKILL.md 中指导主 agent：
1. Dev 阶段的 review step，主 agent 先 `git stash` 或 `git commit` 当前变更
2. 分派 reviewer subagent（在当前 worktree 中，但 context 隔离）
3. Reviewer 只读不写，输出 review 结果到指定路径
4. 主 agent 根据 review 修复

这本质上是**context 隔离而非 worktree 隔离**，已经接近当前架构。

## 五、结论与建议

### 1. Review Loop：适合引入，但按阶段分级

| 阶段 | Review Loop 模式 | Worktree 隔离 |
|------|-----------------|---------------|
| Spec | 多轮 reviewer（文档质量），现有 subagent 模式 | ❌ 不需要 |
| Plan | 多轮 reviewer（plan 可行性），现有 subagent 模式 | ❌ 不需要 |
| Dev | **强烈推荐** parent-orchestrated review loop | ⚠️ 可选，代价较高 |
| Test | 单轮 reviewer（测试质量），现有 subagent 模式 | ❌ 不需要 |
| PR | 不需要 | ❌ 不需要 |

### 2. Worktree-Run：现阶段不建议引入

理由：
- **投入产出比低**：只有 Dev 阶段有真实收益，但实现复杂度高（合并、状态同步、路径映射）
- **现有机制够用**：`code-review-worktree` skill 已支持多维度 review，可作为独立工具使用
- **更好的替代**：先实现 context 隔离的 review loop（不改 extension 代码），验证效果后再考虑 worktree 隔离

### 3. 推荐的渐进式方案

**第一步（低成本，高收益）：** 在 gate 流程中增加 review loop
- Gate pass 后，分派 expert-reviewer 做 content review
- 如果 reviewer 发现 MUST_FIX，主 agent 修复后重新 gate
- 这只是 SKILL.md 层面的指导变更 + gate 工具的小幅扩展

**第二步（中成本，中收益）：** 集成 `code-review-worktree`
- Dev 阶段使用 `code-review-worktree` skill 替代当前的单一 expert-reviewer
- 获得多维度并行 review 能力
- 不需要 worktree 隔离——在当前 worktree 中分派多个 reviewer subagent

**第三步（高成本，视情况）：** Dev 阶段的 worktree 隔离
- 仅在第二步验证后、确有场景需要时才做
- 需要改造 `review-dispatcher.ts` + `subagent.ts`
- 需要处理合并策略和状态同步
