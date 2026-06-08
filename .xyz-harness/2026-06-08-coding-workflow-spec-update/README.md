# @zhushanwen/pi-coding-workflow-v2

Coding-workflow 的 v2 独立实现，完全基于 Workflow Extension 编排 Review-Gate 与 Test-Fix Loop。

## 设计目标

- 将 Phase 1/2/3 的 Review-Gate 接入 Workflow Extension
- 将 Phase 4 的 Test-Fix Loop 接入 Workflow Extension
- 抽象统一的 Gate Pipeline（Review-Gate → Phase-Gate）
- 支持 Goal 自动注入、Retrospect 上下文注入

## 目录结构

```
.
├── .pi/workflows/          # workflow 脚本（4 个 phase 的 Review/Test-Fix）
├── src/
│   ├── agents/             # 11 个 reviewer/fix worker agent
│   ├── lib/
│   │   └── gates/          # Gate Pipeline 抽象
│   ├── types/              # Pi SDK stub 类型
│   └── index.ts            # 扩展入口
├── skills/                 # 4 个 SKILL.md（brainstorming/writing-plans/phase-dev/phase-test）
├── docs/adr/               # ADR-019
├── package.json
└── tsconfig.json
```

## Workflow 脚本

| 脚本 | 说明 |
|------|------|
| `phase1-review-gate.js` | 循环审查 spec.md，最多 3 轮 |
| `phase2-review-gate.js` | L1 单 agent / L2 串行双 agent |
| `phase3-review-gate.js` | 三阶段：阶段一 → 阶段一.五 → 阶段二循环 |
| `phase4-test-fix-loop.js` | core → noncore 串行 Test-Fix Loop |

## Gate Pipeline

```
coding-workflow-gate(tool)
    └── 按 PHASES[phase].gates 顺序执行 gate 链
        ├── review-gate  → 启动 workflow 脚本
        ├── test-fix-loop → 启动 Test-Fix Loop workflow
        └── phase-gate    → 脚本检查 + AI 防伪造
```

## 安装

```bash
pi install npm:@zhushanwen/pi-coding-workflow-v2
```

## 依赖

- `@zhushanwen/pi-workflow`（peer dependency）
- `typebox`
