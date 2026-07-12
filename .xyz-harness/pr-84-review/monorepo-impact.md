---
verdict: pass
must_fix: 0
---

# PR #84 Monorepo Impact Review

**Base:** `origin/main` (ca86484a) → **HEAD:** feat-ask-user-gui (14 commits, 64 files)
**Scope:** 给 4 个扩展 (ask-user / subagent-workflow / todo / goal) 引入 `@xyz-agent/extension-protocol@^0.2.0` + GUI 协议 + RPC 生命周期控制。
**验证手段:** `npx tsc --noEmit` 4 个扩展全过；`vitest run` 共 1509 tests 全过 (ask-user 297 / goal 287 / subagent-workflow 855 / todo 70)。

## Summary

PR 引入 `@xyz-agent/extension-protocol@0.2.0` 作为**外部 npm 依赖**（非 workspace 包），用于将 4 个扩展的 TUI 渲染抽象为可序列化的 GUI 协议（`GuiComponent` / `GuiRenderResult`），并给 subagent-workflow 增加 RPC 模式的 `/subagents cancel` / `/workflows` 生命周期控制。

monorepo 健康度良好：

1. **workspace 依赖正确** — 4 个 package.json 均声明 `@xyz-agent/extension-protocol: ^0.2.0`，pnpm-lock.yaml 同步解析到 0.2.0。该包是外部 npm 库（非 workspace package，根 `pnpm-workspace.yaml` 只列 `extensions/*` + `shared/*`），因此不需要 `workspace:*` 协议。`shared/` 下无 package 依赖它。
2. **extension-dependencies.json 无需更新** — 该文件追踪的是 runtime pi-extension 依赖（其他 `@zhushanwen/pi-*` 扩展）。`extension-protocol` 的 package.json 无 `pi` 字段（不是 pi extension，只是带 `main`/`exports` 的 npm 库），正确地未被列入。
3. **无循环依赖** — `extension-protocol@0.2.0` 的 `dist/index.mjs` 不 import 任何 `@zhushanwen/*` / `@mariozechner/*` / `@earendil-works/*` 符号（零依赖，符合协议包设计）。消费方（4 个扩展）→ protocol 是单向边，无环。
4. **公共 API 向后兼容** — 4 个扩展的入口 `index.ts` 均只 `export default`，未 re-export protocol 类型或删除的 `gui-adapter.ts` 内部类型，外部消费者看不到形状变化。`GoalControlDetails.__gui__`、`WorkflowNotifyDetails.__gui__`、`SubagentToolResult.__gui__` 全部为新增可选字段（非破坏）。
5. **`slug` 字段从 optional 变 required 的「破坏性变更」经核实是安全的** — 详见下方 Finding-1 分析：所有构造点已同步、旧持久化记录兜底空串、独立 fork 的 `subagents` 扩展不受影响。
6. **类型 stub 同步** — `shared/types/mariozechner/index.d.ts` 新增 `ExtensionMode` 和 `ExtensionContext.mode`，与 `extension-protocol` 的 `GuiContext.mode` 字面量集合（`"tui" | "rpc" | "json" | "print"`）完全一致。
7. **changeset 充分** — 3 个 changeset 覆盖 4 个包的 minor bump；`gui-protocol-rollout.md` 明确解释了 slug 字段的语义和向后兼容策略。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|---|---|---|---|---|---|
| INFO | `extensions/subagent-workflow/src/execution/types.ts` | 309, 370, 398, 451, 506, 573 | breaking-change | `slug` 字段在 6 个内部领域类型上从 optional 变成 required（`ExecutionRecord` / `ExecuteOptions` / `SubagentToolDetails` / `SubagentListItem` / `SubagentRecord` / `RecordSnapshot`）。这是字面意义上的 breaking change。但：(a) 这些类型不被 entry `index.ts` re-export，外部包无法 import；(b) `extensions/subagents/`（已弃用的前身）已 fork 独立的 `src/types.ts`，不 import subagent-workflow（已 grep 确认 `from.*subagent-workflow` 为空）；(c) 所有内部构造点（`execution-record.ts:169`、`record-store.ts:253,333`、`session-runner.ts:670`、`mapToExecuteOptions`）均同步赋值；(d) 旧持久化记录反序列化兜底 `""`（`session-reconstructor.ts:439`，并有专门测试「旧文件 identity 无 slug → 兜底空串」）。changeset 已按 internal-types 惯例标 minor。 | 无需修复。记录为 INFO——未来若有人把 `ExecuteOptions`/`ExecutionRecord` 提升到 public exports 需重新评估。 |
| INFO | `extensions/subagent-workflow/src/interface/gui-adapter.ts` | — (整文件删除) | public-api | 删除了本地 stub `gui-adapter.ts`（136 行，定义 `GuiContext` / `GuiComponent` / `isGuiCapable` 等），替换为 `from "@xyz-agent/extension-protocol"`。该文件未被 `src/index.ts` re-export（entry 只 `export default`），且 `grep "gui-adapter" src/index.ts` 为空，是纯内部重构。 | 无需修复。 |
| INFO | `extensions/subagent-workflow/src/execution/types.ts` | 492-494 (`SubagentToolResult` union) | public-api | `SubagentToolResult` 的 3 个 union 分支同时新增 `__gui__?: GuiRenderResult` 和 start 分支新增 `slug: string`。start 分支的 `slug` 是 required，但该 union 类型仅由 `subagent-tool.ts` 的 `adapter()` 构造，构造处已透传 slug（`subagent-actions.ts`）。`__gui__` 为可选。 | 无需修复。 |
| INFO | `extensions/ask-user/package.json`, `extensions/goal/package.json`, `extensions/subagent-workflow/package.json`, `extensions/todo/package.json` | dependencies 块 | workspace-dep | 4 个 package.json 均把 `@xyz-agent/extension-protocol` 放在 `dependencies`（而非 `peerDependencies`）。该包是纯类型+helper 库、零传递依赖、版本固定到 `^0.2.0`，作为常规 dependency 合理（extension 安装时自动带上，无需宿主提供）。pnpm-lock.yaml 4 个 importer 块同步记录解析到 0.2.0。 | 无需修复。若未来 protocol 发生 breaking 变更想锁定宿主版本，可考虑改 peerDependencies。 |
| INFO | `shared/types/mariozechner/index.d.ts` | 15-17, 27-28 | public-api | 新增 `ExtensionMode = "tui" \| "rpc" \| "json" \| "print"` 和 `ExtensionContext.mode: ExtensionMode`。与 `@xyz-agent/extension-protocol` 的 `GuiContext.mode` 字面量集合完全对齐。`hasUI` 注释澄清为「true in TUI and RPC modes」——修正了 subagents.ts 旧代码用 `!ctx.hasUI` 误判 RPC 为不可交互的 bug（此 PR 已改为 `ctx.mode !== "tui"`）。 | 无需修复。 |
| SUGGESTION | `pnpm-lock.yaml` | 741-756, 892-934, 1756-1784 | workspace-dep | lockfile 中出现多处 `libc: [glibc]` / `libc: [musl]` 行被删除（针对 `@mariozechner/clipboard-linux-*` / `@rolldown/binding-linux-*` / `lightningcss-linux-*` 等 optional 平台包）。这与本 PR 无功能关系，是 pnpm 版本变化（或不同环境重新 lock）产生的格式漂移。 | SUGGESTION：若非有意，可单独提交 lockfile 重新生成，避免 diff 噪音。若 CI 跑 `pnpm install --frozen-lockfile` 通过则可忽略。 |
| SUGGESTION | `.changeset/gui-protocol-rollout.md` | — | public-api | changeset 只声明了 `@zhushanwen/pi-subagent-workflow` / `pi-todo` / `pi-goal` 三个包的 minor。`@zhushanwen/pi-ask-user` 在另一个 changeset (`ask-user-gui-rpc.md`) 单独声明 minor。两个 changeset 都 bump subagent-workflow？——实际 `ask-user-gui-rpc.md` 只 bump ask-user，`gui-protocol-rollout.md` bump 另外 3 个，无重复。 | 无需修复，确认无 changeset 冲突。 |

## 备注

- `extension-dependencies.json` 的 schema 字段是 `package`（npm 包名）+ `type`（`runtime` / `optional` / `package`）。由于 `extension-protocol` 不是 pi extension，不参与 pi 的 extension 加载顺序，无需在此声明。
- `subagent-workflow-rpc-lifecycle.md` 和 `gui-protocol-rollout.md` 同时 minor-bump `pi-subagent-workflow` 是合法的——changesets 会合并为单个 minor bump（不会变成 major）。
- 4 个扩展的 `main` 均为 `.ts` 源码（Pi 直跑 TS），无 build step，因此 `extension-protocol` 的 `dist/*.mjs` 在运行时由 Pi 的 TS loader 正常解析。
