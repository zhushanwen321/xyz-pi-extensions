# Aggregated Review Report — PR #66 pre-merge

**分支**：`feat-subagent-workflow-enhance` vs `main`
**日期**：2026-06-20
**审查维度**：业务逻辑 / 类型安全 / 扩展接口 / Monorepo 影响 / 测试覆盖

## Summary

- **Must-fix（去重后）：5 项**
- **Suggestions：8 项**
- **Infos：5 项**
- **整体判定**：代码工程质量高（tsc 0 errors、生产代码 0 explicit any、1063 测试全绿、SDK 契约齐全、orchestrator 重构行为等价已验证）。**阻断点全部集中在「发布契约一致性」而非代码正确性**——config.json 发布即坏、changeset 与代码矛盾、两个零测试的纯逻辑内核。修完这 5 项即可合入。

## Must-Fix Issues（阻断合并）

| # | 文件 | 维度 | 描述 | 修复方向 | 同源命中 |
|---|------|------|------|----------|----------|
| **MF1** | `extensions/subagents/src/core/event-bridge.ts:140-163` | 业务逻辑 + 测试 | `message_end` 把 `msg?.usage` 与 `stopReason==="error"/"aborted"` 当互斥分支（usage 命中即 return）。携带 usage 的错误响应（LLM provider 常见）跳过 `lastError` 设置 → errored session 被判 `success=true` → **错误结果回传父 agent**，破坏成功/失败契约 | 把 usage 累积与 error 检测改为非互斥：先累积 usage，再独立判断 stopReason 设 lastError | 业务逻辑 MF1；测试 MF2 |
| **MF2** | `extensions/subagents/config.json` + `.gitignore:6` + `package.json` | 扩展接口 | `.gitignore` 排除 config.json，但 files 列出它、`config.ts` 的 `BUILTIN_CONFIG_PATH` 读它。`npm pack --dry-run` 实测不含 → 走 catch → `fallback.model=""` → `resolveModelForAgent` 第 5 级 `lookupModel("")` 返回 undefined → **pi install 后首次执行 subagent tool 必抛 `No available model`** | 二选一：(a) 提交带合理 fallback model 的 config.json 并从 .gitignore 移除；(b) 删 files/config.json + 内联默认值（带非空 model）。推荐 (b)——配置本就不应跨环境分发 | 扩展接口 MF1 |
| **MF3** | `.changeset/feat-subagent-enhance.md` | Monorepo + 扩展接口 | workflow 2.0 的 6 条 BREAKING 描述 **5 条与代码相反**：grep `pi-subagents` 零命中、agent-pool 仍 spawn、被声明删除的文件仍被引用。major bump（1.1.1→2.0）无架构级变更支撑。真实 breaking 仅 2 项局部行为（resolveModel 删 scene + sendCompletionNotification 改 triggerTurn） | 重写 changeset：workflow 从 `major` 降为 `minor`；BREAKING 描述改为真实的 2 项；删除"请安装 pi-subagents 迁移"的误导指引 | monorepo MF1+MF2；扩展接口 MF2 |
| **MF4** | `extensions/subagents/src/core/model-resolver.ts`（206 行） | 测试 | 5 级 fallback `resolveModelForAgent` + `inferCategory` + `availableThinkingLevels` **零测试**。作者注释明示"duck-typed，可 mock"。模型解析是系统大脑，且与 MF1 的 error 路径强相关 | 新增 `src/__tests__/model-resolver.test.ts`：覆盖 5 级 fallback 优先级、未知 agent、空 model 列表、thinkingLevel 映射 | 测试 MF1 |
| **MF5** | `extensions/subagents/src/tools/subagent-tool.ts:207,239,245` | 类型安全 + 扩展接口 | 3 处 `{ content, details } as unknown as void`。根因：本地别名 `SubagentExecuteCb` 返回类型声明 `Promise<void>`（line 49），实现实际返回 `AgentToolResult<SubagentToolDetails>`。**本 PR 自己引入的 `taste/no-unsafe-cast` 规则正抓这 3 处**——上线第一天自己的规则在自己的代码上报 warning | 修 4 行：把 `SubagentExecuteCb` 返回类型从 `Promise<void>` 改为 `Promise<AgentToolResult<SubagentToolDetails>>`，删除 3 处双重断言。零运行时行为变化，tsc 已验证通过 | 类型安全 MF1；扩展接口 S3 |

> **注**：monorepo MF3（extension-dependencies.json 依赖关系未声明）实质是 MF3 的镜像——报告自述"保持不变是对的"，修法与 MF3 相同，不单列。

## Suggestions（不阻断，建议同 PR 顺带）

| # | 文件 | 维度 | 描述 | 修复方向 |
|---|------|------|------|----------|
| S1 | `extensions/subagents/src/core/session-factory.ts:307-324` | 业务逻辑 | `applyToolFilter` 白名单全失配时 `setActiveToolsByName([])` 静默剥夺全部工具 | 全失配时抛错或回退到不限制 |
| S2 | `extensions/subagents/src/infra/agent-pool.ts:218,272` | 业务逻辑 | signal 的 abort listener 正常完成时不摘除，随调用数线性泄漏 | finally 中 `signal.removeEventListener` |
| S3 | `extensions/subagents/src/runtime/execution/history-store.ts:154-161` | 业务逻辑 | `recent()` 去重 if/else 两分支都 `byId.set`，"cancelled 优先"是死代码 | 对照 record-store 的正确实现修正 |
| S4 | `extensions/unified-hooks/src/hooks/tool-error-handler.ts:35` | 业务逻辑 | `ctx.ui.notify` 无空值判断，headless 会话 NPE | 加 `ctx.ui?.notify` 守卫 |
| S5 | `extensions/subagents/package.json` files | 扩展接口 | `mocks/`（12.3kB）+ `vitest.config.ts` 被 npm pack 打入，运行时从不引用 | 从 files 移除（仅 dev/test 用） |
| S6 | `extensions/subagents/agents/*.md` | 扩展接口 | 随发的 agent 定义默认不被发现（默认 agentDir 是 `~/.pi/agent`） | 文档说明或调整 discovery 默认值 |
| S7 | `extensions/subagents/src/core/event-bridge.ts` | 测试 | `isSdkEvent` + `createEventBridge` 事件映射零测试（与 MF1 合并补） | 新增 `src/__tests__/event-bridge.test.ts` |
| S8 | `extensions/subagents/src/infra/agent-pool.ts` timeoutMs | 测试 | `worker-script.test.ts` 只验字段透传，未验 AgentPool 真触发 abort | 补行为测试 |

## Infos（记录，不修）

- buildEnvBlock 同步 git 状态、background 执行脱离 session_shutdown、model-resolver 删 scene 解析（有意回归）、config maxConcurrent 无类型校验、cancelBackground durationMs=0
- `taste/no-silent-catch` 在 session-factory.ts:243、subagent-tool.ts:138 各 1 处 warning（错误处理品味，非类型安全范畴）

## 修复优先级建议

1. **MF2 + MF5**（代码层，最小改动，各自 ~4 行）——先修，解锁类型/发布正确性
2. **MF1**（event-bridge 错误路径，成功/失败契约根因）——修代码 + 补 MF7 测试
3. **MF4**（model-resolver 测试）——与 MF1 测试一起补
4. **MF3**（重写 changeset）——最后做，发布前确认

## 维度报告索引

- [business-logic.md](./business-logic.md) — verdict: fail (1 MF)
- [type-safety.md](./type-safety.md) — verdict: APPROVE_WITH_MINOR_FIX (1 MF)
- [extension-api.md](./extension-api.md) — verdict: block (2 MF)
- [monorepo-impact.md](./monorepo-impact.md) — verdict: FAIL (3 MF，去重后并入 MF3)
- [test-coverage.md](./test-coverage.md) — verdict: fail (2 MF)
