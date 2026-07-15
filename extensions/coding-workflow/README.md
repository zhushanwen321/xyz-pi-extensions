# coding-workflow

5 阶段编码工作流编排（spec → plan → dev → test → pr），自动 Gate Pipeline + Workflow 驱动 Review-Gate + Test-Fix Loop + Retrospect + Compact。

## 功能

- **Gate Pipeline**：可配置的 gate 链，按 phase 配置执行（review-gate → phase-gate）
- **Workflow 驱动 Review-Gate**：Phase 1/2/3 通过 Workflow Extension 的 `agent()`/`parallel()` 执行循环审查 + 自动修复
- **Test-Fix Loop**：Phase 4 的 core/noncore 串行测试修复循环（最多 10 轮 + 增量策略）
- **降级策略**：Workflow Extension 缺失时自动降级到 `runSingleAgent` 串行执行
- **Goal 自动注入**：Phase 2 硬编码 L1 任务，Phase 3 从 plan.md 动态构建
- **Retrospect 上下文注入**：gate 通过后 steer 包含关键交付物摘要
- **Compact**：阶段切换时自动压缩上下文
- **配套 skills**：内置 xyz-harness 全套技能（brainstorming、writing-plans、phase-dev、phase-test 等）
- **配套 agents**：11 个专用 agent（reviewer / fix-worker / coordinator）

## 安装

```bash
# npm 方式（正式）
pi install npm:@zhushanwen/pi-coding-workflow

# 可选：workflow extension（启用并行审查能力）
pi install npm:@zhushanwen/pi-subagent-workflow
```

## 使用

通过 `coding-workflow-gate` 和 `coding-workflow-phase-start` 工具由 AI 自动调度，或手动使用命令：

| 命令 | 说明 |
|------|------|
| `/coding-workflow` | 启动工作流 |
| `/coding-workflow-status` | 查看当前状态 |
| `/coding-workflow-abort` | 中止工作流 |

## Gate Pipeline 架构

每个 phase 声明自己的 gate 链配置：

| Phase | Gates | 说明 |
|-------|-------|------|
| 1 (Spec) | review-gate → phase-gate | Workflow 循环审查 spec.md |
| 2 (Plan) | review-gate → phase-gate | L1 单 agent / L2 串行双 agent |
| 3 (Dev) | review-gate → phase-gate | 三阶段：conformance → simulated-data → review-fix loop |
| 4 (Test) | test-fix-loop → phase-gate | core → noncore 串行，各 10 轮 |
| 5 (PR) | phase-gate | 仅脚本检查 |

### Review-Gate Workflow（Phase 1/2/3）

通过 `pi.__workflowRun` 启动 `.pi/workflows/phase{N}-review-gate.js`：
- Phase 1：单 agent 循环审查 spec.md，最多 3 轮
- Phase 2：L1 单 agent / L2 串行双 agent（plan + BL review），最多 3 轮
- Phase 3：三阶段嵌套（conformance → simulated-data → 5 reviewer 并行 + fix-worker）

### Test-Fix Loop（Phase 4）

通过 `pi.__workflowRun` 启动 `.pi/workflows/phase4-test-fix-loop.js`：
- 核心 case 先执行（最多 10 轮），全部 passed 后执行非核心 case
- 增量策略：第 2 轮起只重跑 fixed + depends_on 下游
- Stagnation 检查：连续 3 轮 failed 不降 → 强制退出

## 文件结构

```
coding-workflow/
├── index.ts                # 入口 — 工具、命令、事件注册
├── lib/
│   ├── gates/              # Gate Pipeline 抽象
│   │   ├── gate.ts         # Gate/GateContext/GateResult 接口
│   │   ├── review-gate.ts  # Review-Gate（workflow 驱动 + 降级）
│   │   ├── phase-gate.ts   # Phase-Gate（脚本检查）
│   │   └── test-fix-loop.ts # Test-Fix Loop Gate（workflow 驱动 + 降级）
│   ├── gate-runner.ts      # 门控脚本执行
│   ├── helpers.ts          # PhaseConfig + 辅助函数
│   ├── process-manager.ts  # 子进程管理
│   ├── review-dispatcher.ts# Anti-fraud review + Retrospect steer（含上下文注入）
│   ├── review-gate-impl.ts # runSingleAgent 降级实现
│   ├── skill-resolver.ts   # Skill 发现
│   ├── subagent.ts         # Subagent 工具封装
│   └── render-helpers.ts   # TUI 渲染
├── agents/                 # 专用 agent（reviewer / fix-worker / coordinator）
├── skills/                 # xyz-harness 全套 skills
├── scripts/
│   └── gate-check.py       # 门控检查 Python 脚本
└── commands/               # 命令模板
```

## Agent 文件

| Agent | Phase | 职责 |
|-------|-------|------|
| `spec-requirements-reviewer` | 1 | 审查 spec.md 完整性、一致性、清晰度 |
| `plan-requirements-reviewer` | 2 | 审查 plan.md 可行性、交付物完整性（L1/L2 共用） |
| `plan-bl-requirements-reviewer` | 2 | L2 业务逻辑覆盖度审查 |
| `spec-plan-conformance-reviewer` | 3 | 规格符合性 + 业务逻辑审查 |
| `simulated-data-generator` | 3 | 生成 JSON fixture 模拟数据 |
| `fallow-reviewer` | 3 | 包装 fallow CLI 的代码质量审查 |
| `review-sync-fix-worker` | 3 | 汇总 reviewer + 判断退出 + 按文件分组 |
| `file-fix-subagent` | 3 | 串行修复同一文件的所有 must_fix |
| `test-execute-coordinator` | 4 | 构造 test-execute JSON、分派 Wave |
| `test-fix-worker` | 4 | 分析失败 + 修复 + 更新状态 |
| `test-case-subagent` | 4 | 执行测试 case、更新结果 |

## 降级策略

Workflow Extension（`@zhushanwen/pi-subagent-workflow`）是可选依赖：

| 状态 | Review-Gate | Test-Fix Loop |
|------|------------|---------------|
| 已安装 | `pi.__workflowRun` 驱动 workflow 脚本 | `pi.__workflowRun` 驱动 workflow 脚本 |
| 未安装 | `runSingleAgent` 串行审查 | `runSingleAgent` 串行测试修复 |
