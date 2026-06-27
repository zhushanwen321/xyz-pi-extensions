---
verdict: pass
must_fix: 0
---

# Monorepo 影响审查报告

## Summary
0 must-fix, 2 suggestions, 2 infos. Monorepo 结构健康：engine 层零 Pi 依赖，依赖方向单向清晰（engine → ports/persistence/session → service → adapters/projection → index），无运行时循环依赖，无新增 workspace 硬依赖，跨扩展耦合（`pi.__goalInit`）的消费者已同步更新且 changeset 覆盖完整。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| SUGGESTION | extensions/goal/src/service.ts:27 / projection/result.ts:13 | - | circular-dep | service.ts value-import `formatTaskList` from `./projection/prompts`，而 `projection/result.ts` type-import `ToolActionResult` from `../service` —— 形成 service↔projection 的 type-only 循环。运行时无影响（type import 编译后擦除），但违反 ports/adapters 分层（projection 应只依赖 engine/ports，不应反向依赖 service） | 把 `ToolActionResult` 类型下沉到 `engine/types.ts` 或 `ports.ts`，让 projection 只依赖 engine/ports，消除反向引用 |
| SUGGESTION | extensions/goal/src/index.ts:351, extensions/plan/src/compact.ts:79, extensions/coding-workflow/lib/tool-handlers.ts:502,527 | - | public-api | `GoalInitFn` 签名现在在 4 处重复定义（goal 导出 canonical 版本 + 3 处消费者 inline alias）。goal 已 export 单一 source of truth（API-1），但消费者为避免把 goal 变 hard dependency 仍用 inline alias，存在 drift 风险 | 已有 comment 说明设计权衡，可接受；建议补一个契约测试断言 inline alias 与 canonical 签名结构兼容，或抽到独立轻量 types 包 |
| INFO | extensions/goal/package.json:24-29 | 24 | workspace-dep | peerDependencies 声明 `@earendil-works/pi-tui`，但 `src/index.ts:25` 实际 import `@mariozechner/pi-tui`。此不一致为 pre-existing（main 上同样存在），非本次重写引入；coding-workflow 同样模式，疑为 monorepo 系统性命名约定 | 不阻塞本次审查；如系误植可在后续单独修 |
| INFO | .changeset/goal-architecture-rewrite.md | - | breaking-change | `__goalInit` 签名 breaking 变更（ctx 由 optional→required，budget 由 optional→required `| undefined`）。changeset 正确标注 goal=minor / coding-workflow=patch / plan=patch，且两消费者的 inline alias 与调用点已同步传 ctx | 无需动作；记录确认 changeset 覆盖完整 |

## 审查依据

**workspace-dep**：`extensions/goal/package.json` 无 `workspace:*` 引用，peerDependencies 仅含 Pi 运行时包；coding-workflow/plan 通过 duck-typed `pi.__goalInit` 可选耦合访问 goal，无新增包间硬依赖（by-design）。根 `pnpm-workspace.yaml` 配置 `extensions/*` + `shared/*`，未变。

**circular-dep（分层验证）**：
- `engine/` 纯净 —— grep 确认 budget.ts/goal.ts/task.ts/types.ts 仅 import sibling（`./types`、`./task`），零 `@mariozechner/@earendil/@sinclair` 引用。
- 依赖链单向：`ports.ts → engine/types`；`persistence.ts → engine + ports`；`session.ts → engine + persistence + ports`；`service.ts → engine + persistence + ports + projection/prompts + session`；`adapters/* → service + session + engine + persistence + projection + ports`；`projection/* → engine + ports + session + service(type)`。
- 唯一反向边：`projection/result.ts → service(type-only)`，见上表第 1 条 SUGGESTION。

**public-api**：`index.ts` 新增 export `GoalInitFn`（type）与 `GoalInitBudget`（interface），属向后兼容的新增。`__goalInit` 签名变更为 breaking，但已被 changeset + 消费者同步覆盖。tool schema / `/goal` 8 子命令 / 6 个事件 handler 保持不变（行为契约 AC-4）。

**missing-export / shared stub**：`shared/types/mariozechner/index.d.ts:159` 用 `[key: \`__${string}\`]: unknown` 通配符覆盖 `__goalInit`，无需为本次重写更新；`git diff main...HEAD -- shared/` 为空，确认 stub 未变且无需变。
