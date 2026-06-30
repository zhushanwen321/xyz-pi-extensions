---
review_date: 2026-06-20
reviewer: review-extension-api
target: feat-subagent-workflow-enhance (PR #66) vs main
verdict: block
must_fix:
  - "subagents: config.json 被 .gitignore 排除，npm pack 不含该文件，运行时 loadBuiltinConfig() catch 兜底 fallback.model='' → resolveModelForAgent 5 级 fallback 全失效 → pi install 后首次执行 subagent tool 必抛 'No available model'"
  - "changeset 声明 workflow「改用 subagents 进程内执行 / 移除 spawn / 新增 pi-subagents 硬依赖」，但代码仍走 spawn AgentPool、零 import pi-subagents、package.json 与 extension-dependencies.json 均无该依赖；版本说明与实现不符，会误导用户安装"
---

# 扩展接口审查报告 — PR #66

## Summary

本次审查覆盖 5 个扩展的 Pi 接口合规性与向后兼容性：`subagents`（新）、`workflow`（重构）、`unified-hooks`（变更）、`ask-user` / `model-switch`（package.json 微调）。

**接口合规性整体良好**：registerTool 的 schema 全部用 `Type.Object()` + `StringEnum()`；execute 返回 `{content, details}` 且 details 有明确 interface；错误一律 `throw new Error()`（未出现错误成功模式）；`pi.extensions` 一律为 `["./index.ts"]`；handler 签名统一 `(event, ctx)` 两参数；type:module / keywords:pi-package 齐全。SDK 契约测试（`sdk-contract.test.ts`）覆盖了命令注册名、handler 参数数、tool schema 存在性、notifier sendMessage 选项。

**但存在两个阻断性问题**：
1. `subagents` 的 builtin `config.json` 因 `.gitignore` 规则不会进入 npm 包，导致默认 fallback model 为空字符串，新装用户首次执行 subagent 必失败。
2. `changeset` 对 workflow 2.0 的 breaking change 描述与代码实现矛盾（代码仍 spawn、未依赖 subagents），发布说明会误导下游。

## Findings

| # | 类别 | 严重度 | 位置 | 问题 | 建议 |
|---|------|--------|------|------|------|
| 1 | resource-containment | **must-fix** | `extensions/subagents/config.json` + `.gitignore:6` + `src/runtime/config/config.ts:37` | `.gitignore` 显式排除 `extensions/subagents/config.json`（注释「应在 ~/.pi/agent/...」将其定位为运行时用户文件），但 `package.json` 的 `files` 列出 `config.json` 且 `config.ts` 的 `loadBuiltinConfig()` 在 `BUILTIN_CONFIG_PATH=<pkg>/config.json` 读取它作为「代码默认值单一真相源」。`npm pack --dry-run` 实测**不含 config.json**。运行时走 catch 分支 → `fallback:{model:""}` → `resolveModelForAgent` 第 5 级 `lookupModel("")` 因 `indexOf("/")<=0` 返回 undefined → 全链路抛 `No available model`。注释「兜底，保证总有一个 model」被违反。 | 二选一：(a) 取消 `.gitignore` 对该文件的忽略并提交一份含合理 fallback model（如 `anthropic/claude-sonnet-4.5`）的 config.json；(b) 若坚持 config.json 仅作运行时用户配置，则删除 `files` 中的 `config.json`、删除 `loadBuiltinConfig()` 的磁盘读取，把 builtin 默认值内联进代码（带非空 fallback model）。推荐 (b)——与 .gitignore 的语义一致。 |
| 2 | backward-compat | **must-fix** | `.changeset/feat-subagent-enhance.md` vs `extensions/workflow/src/engine/{agent-call-handler,agent-call-handler,model-resolver}.ts` + `extensions/workflow/package.json` | changeset 声明 workflow「改用 subagents 进程内执行，移除 spawn 子进程模型；新增 `@zhushanwen/pi-subagents` 硬依赖」。实测：(a) `grep -rn "@zhushanwen/pi-subagents" src/` 零命中；(b) `agent-pool.ts` 仍 spawn pi 子进程；(c) `model-resolver.ts` 注释自述「Spawn 架构回归后」；(d) workflow `package.json` 无 pi-subagents 依赖；(e) `extension-dependencies.json` 也无 workflow→subagents 边。即 workflow 与 subagents 实为两个独立包，changeset 的 breaking 描述虚假。 | 修订 changeset：workflow 2.0 真实 breaking 仅为「移除 model-switch scene→model 解析（静默失效）+ sendCompletionNotification 改 triggerTurn」。删除「移除 spawn / 新增 pi-subagents 硬依赖」的不实陈述。`major` bump 仍可保留（model-switch 移除确为 breaking）。 |
| 3 | resource-containment | suggestion | `extensions/subagents/package.json` files | `npm pack --dry-run` 实测把 `mocks/pi-tui.ts`(11.4kB)、`mocks/pi-ai.ts`、`mocks/typebox.ts`、`vitest.config.ts` 全部打进包。这些是 vitest alias 指向的测试桩，运行时从不 import（`src/` 下 grep `mocks/` 零命中），纯属发布物冗余，违反「files 只含分发资源」约定。 | 从 `files` 移除 `mocks/` 与 `vitest.config.ts`（测试配置本就不该发布）。`agents/` 暂保留，见 #5。 |
| 4 | resource-containment | suggestion | `extensions/subagents/agents/*.md`（7 文件）+ `src/runtime/model-config-service.ts:81-87` | 默认 agent 发现目录是 `getAgentDir()`=`~/.pi/agent`（用户目录），**不是包内 `agents/`**。`resolveAgentDirs()` 仅在 discovery.json 的 agentDirs 非空时才覆盖默认。包内随发的 7 个 agent .md 在 `pi install` 后不会被自动发现（除非宿主写 discovery.json 指向包路径或用户手动拷贝），即「开箱不可用」。ADR-028 是有意解耦，但随发文件却无默认接入路径，属设计缝隙。 | 二选一：(a) 随包发一份默认 `discovery.json` 指向包内 `agents/`（注意它同样会被 .gitignore 规则误伤，需处理）；(b) 若 agent .md 仅为「参考样例」，从 `files` 移除并在 README/CHANGELOG 说明用户需手动放置。推荐明确文档化。 |
| 5 | details-type | suggestion | `extensions/subagents/src/tools/subagent-tool.ts:155,165,176` | execute 回调末尾三处 `as unknown as void` 把 `{content,details}` 强转成 `Promise<void>`，绕过类型检查。理由注释说是为绕 `registerTool(unknown)` 的 TS2307。但新 stub 已把 registerTool 精确化，且项目刚新增 `taste/no-unsafe-cast` 规则专门标记此类断言——这三处既无 eslint-disable 也无运行时 guard。 | 用 `satisfies` 或为 execute 定义精确返回类型（如 `AgentToolResult<SubagentToolDetails>`），让编译器校验 content/details 形状，消除 `as unknown as void`。 |
| 6 | tool-schema | info | `extensions/subagents/src/tools/subagent-tool.ts` SubagentParams | `task` 在 schema 中为 Optional，描述明确「omit only when polling with backgroundId」，execute 内 `if(!params.task) throw`。这是规范的「Optional + 运行时校验」模式，符合 checklist（条件必填不写成 schema 必填）。 | 无需改动，记录为正向样例。 |
| 7 | pi-manifest | info | `extensions/subagents/package.json` | `pi.extensions:["./index.ts"]`、`type:module`、`keywords` 含 `pi-package`、`main:index.ts`、顶层 `index.ts` 正确 re-export `src/index.ts`。无 skills 目录故无 `pi.skills`。全合规。 | 无。 |
| 8 | backward-compat | info | `extensions/unified-hooks/src/hooks/tool-error-handler.ts` + `src/index.ts` | tool-error-handler 的 `HookContext` 为新增 export（additive）；session_start 状态由 `console.warn` 改 `ctx.ui.notify`+`appendEntry`，是内部实现切换非公共 API 变更，changeset 已记录。handler 仍 `(event, ctx)` 两参数。 | 无。向后兼容。 |
| 9 | backward-compat | info | `extensions/workflow/src/engine/model-resolver.ts` | `resolveModel` 从「显式 model > scene advisor > undefined」简化为「仅显式 model || undefined」。scene→model 解析（依赖 model-switch）彻底删除——这是 workflow 2.0 唯一真实 breaking（已纳入 #2 的 changeset 修订）。函数签名保持 async 不变，调用点零改动。 | 无（已记录在 changeset）。 |
| 10 | backward-compat | info | `extensions/workflow/src/engine/error-handlers.ts` + `orchestrator.ts` | `ErrorHandlerContext` 字段顺序调整、`cleanupAllTempFiles` 调用点在 error-handlers 内重排（handleScriptError 重试前清理、最终失败先 cleanup 再 deleteRunPool）。这些是 orchestrator 内部重构，`WorkflowOrchestrator` 的公开方法（run/pause/resume/abort/list/getInstance）签名未变。`isStaleContextErrorMsg`/`STALE_CONTEXT_PATTERNS` 改为从 `agent-call-handler.ts` re-export 保持向后兼容（注释已说明为 tests 导入）。 | 无。 |
| 11 | pi-manifest | info | `extensions/ask-user/package.json` / `extensions/model-switch/package.json` | ask-user 新增 `@earendil-works/pi-tui`+`@sinclair/typebox` 到 devDependencies（测试用）；model-switch 新增 `test` script。均不触及公共 API 或 pi manifest。 | 无。 |
| 12 | backward-compat | info | `extension-dependencies.json` | 新增 `@zhushanwen/pi-subagents` 条目（dependsOn structured-output，runtime 类型，reason 准确：schema 契约引用 tool 名不 import）；移除 workflow→model-switch（optional）边。两处变更与代码一致。注意：**未**新增 workflow→subagents 边，与代码一致（佐证 #2：changeset 的硬依赖声明是错的）。 | 无。 |

## 结论

代码层面的 Pi 扩展接口合规性达标（schema、handler 签名、错误模式、manifest、details 接口均符合 `[MANDATORY]` checklist，且配有 SDK 契约测试）。**阻断点全在「契约一致性」而非接口形状**：

- **#1 是运行时阻断**：新包 `pi-subagents` 首次安装即不可用（无默认 model），属发布阻断级。
- **#2 是发布说明阻断**：changeset 与代码矛盾，若按现状发布，npm 上的 workflow 2.0 说明会误导所有下游用户误装 pi-subagents、误以为 spawn 已移除。

修复 #1 与 #2 后即可放行。#3–#5 建议同 PR 内顺带处理（不阻断）。

---

*审查范围：`git diff main...HEAD`，重点 extensions/{subagents,workflow,unified-hooks,ask-user,model-switch} 的 package.json / index.ts / src/index.ts / src/commands / src/tools / 关键 runtime 与 engine 模块。*
