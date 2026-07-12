---
verdict: fail
must_fix: 1
---

## Summary
1 must-fix, 2 suggestions, 4 infos.

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | shared/types/mariozechner/index.d.ts | 15-29 | breaking-change | stub 新增 `ExtensionContext.mode: ExtensionMode` 字段，但实际安装的 SDK `@mariozechner/pi-coding-agent@0.73.1` 的 `createContext()` 运行时实现（`node_modules/.pnpm/@mariozechner+pi-coding-agent@0.73.1.../dist/core/extensions/runner.js:377-439`）**完全没有设置 `mode` 属性**，`ExtensionMode` 类型也不存在于 SDK 的 `.d.ts`（`dist/core/extensions/types.d.ts:207` 的 `ExtensionContext` 无 `mode`）。这导致 4 个 extension 中的 `ctx.mode === "rpc"` 判断在运行时永远为 `undefined === "rpc"` → false。最严重的是 ask-user（`extensions/ask-user/src/index.ts:197`）把 headless 守卫从 `!ctx.hasUI` 改为 `ctx.mode !== "tui" && ctx.mode !== "rpc"`，TUI 模式下 `undefined !== "tui"` 为 true，会**误把 ask-user 工具在正常 TUI 会话中禁用**（运行时回归）。注释（index.ts:234-236）声称"hasUI 在 TUI 和 RPC 模式都为 true"，但 SDK 注释明确说"hasUI: false in print/RPC mode"，与代码注释矛盾。 | 二选一：(A) 升级 `@mariozechner/pi-coding-agent` 到真实提供 `ctx.mode` 的版本，并同步 stub；(B) 若 SDK 0.73.1 是当前 target，删除 stub 中的 `mode` 字段，改回用 `ctx.hasUI` 做 headless 判定，RPC 分支用其他机制（如 try/catch `ctx.ui.custom` 或显式 env/flag）区分。无论哪种，需确认 SDK 版本与运行时行为一致后再合并。 |
| SUGGESTION | extensions/subagent-workflow/package.json | 46-48 | workspace-dep | subagent-workflow 新增的 `slug` 字段扩散到 6 个公开类型（`ExecutionRecord`、`SubagentToolDetails`、`ExecuteOptions`、`SubagentListItem`、`SubagentRecord`、`RecordSnapshot`，见 `extensions/subagent-workflow/src/execution/types.ts:307/368/396/449/504/571`），其中 4 个为必填（非 `?`），构成对包外消费者的 breaking change（虽然 changeset 标 `minor`）。当前 monorepo 内无其他包 import 这些类型（deprecated 的 `extensions/subagents/` 有独立 `types.ts`，不受影响），但 npm 外部消费者构造这些对象时会编译失败。 | 若 semver 严格遵守，应将 `slug` 设为可选（`slug?: string`）或升级 changeset 为 `major`；若确认无外部直接构造这些 record 的场景，可保留现状但 changeset 应注明 breaking。 |
| SUGGESTION | .changeset/ask-user-gui-rpc.md | 1 | workspace-dep | ask-user 的 GUI 协议接入与另 3 个 extension 是同一批 rollout，但拆成两个 changeset 文件（`gui-protocol-rollout.md` + `ask-user-gui-rpc.md`）。两者都会生成独立的 minor 发布，发布顺序无关但语义上是一个原子功能单元。这不是错误，但合并发布时需注意两个 changeset 不能漏掉其中一个。 | 可选：合并为单个 changeset 文件便于追踪；或保留拆分但在 PR 描述注明两个 changeset 必须一起发布。 |
| INFO | extensions/ask-user/package.json, extensions/goal/package.json, extensions/todo/package.json, extensions/subagent-workflow/package.json | - | workspace-dep | 4 个 extension 新增的 `@xyz-agent/extension-protocol` 依赖版本完全一致（都是 `^0.2.0`），声明位置统一（`dependencies` 字段，非 `peerDependencies`/`devDependencies`）。 | 无需修复，记录为一致性确认。 |
| INFO | pnpm-lock.yaml | 1144-1146, 3494-3495 | lockfile | `@xyz-agent/extension-protocol@0.2.0` 已正确 resolve（integrity hash 已记录），4 个 importer（ask-user/goal/todo/subagent-workflow）的 specifier 均为 `^0.2.0` 且 resolved version 为 `0.2.0`。lockfile 中无 floating/未锁定版本。 | 无需修复，记录为 lockfile 一致性确认。 |
| INFO | extensions/subagent-workflow/src/interface/gui-adapter.ts (已删除) | - | public-api | 删除的 `gui-adapter.ts` 在整个 monorepo 内零残留引用（`grep -rn "gui-adapter" extensions/` 无输出）。所有调用方已迁移到新模块 `gui-mappers.ts`（本地状态映射）+ `@xyz-agent/extension-protocol`（协议原语）。导入链无循环引用：`gui-mappers.ts` 只 import 外部包类型，被 `helpers.ts`/`tool-workflow.ts`/`tool-workflow-script.ts`/`subagent-actions.ts`/`subagent-tool.ts`/`index.ts` 单向消费。 | 无需修复，记录为迁移完整性确认。 |
| INFO | extension-dependencies.json | - | workspace-dep | 4 个 extension 之间的依赖关系本次未变化（无新增/删除/重命名 extension）。`@xyz-agent/extension-protocol` 是外部 npm 包，按约定不需在 `extension-dependencies.json` 中声明（该文件只管 extension 之间的运行时依赖）。4 个 extension 之间无相互 package 依赖（dependencies/peerDependencies/devDependencies 中均无彼此的 `@zhushanwen/pi-*` 包）。 | 无需修复，记录为 extension-dependencies.json 无需更新。 |
