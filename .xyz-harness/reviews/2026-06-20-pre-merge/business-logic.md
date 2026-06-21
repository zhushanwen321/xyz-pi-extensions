---
verdict: fail
must_fix: 1
---

# 业务逻辑审查报告 — feat-subagent-workflow-enhance (PR #66)

审查范围：`git diff main...HEAD` 中 `extensions/subagents/`、`extensions/workflow/`、`extensions/unified-hooks/`、`shared/taste-lint/` 的 `.ts`/`.mjs` 源码。排除文档、测试、配置、`.xyz-harness/`、`.agents/`。

## Summary

本分支新增进程内 subagent 运行时（`extensions/subagents/`），重构 workflow orchestrator（拆分到 `engine/` + `infra/`），并修改 unified-hooks 的错误通知路径。整体架构清晰：状态机收尾用 `tryTransition` CAS 抢锁、sync/background 共用 `runAndFinalize`、event-bridge 作为唯一事件翻译层。并发池对 `maxConcurrent=0` 做了下限保护，turn-limiter 对 `maxTurns<=0` 做了禁用处理，cancel/finalize 竞态用 CAS 互斥解决得比较干净。

但发现 **1 个 MUST_FIX**：`event-bridge.ts` 的 `message_end` 处理把 "有 usage" 与 "error/aborted" 当作互斥分支，导致**携带 usage 的错误响应被静默判为成功**——这直接破坏了 subagent 的成功/失败契约，错误结果会被当作 done 回传给父 agent。另有 4 个 SUGGESTION 和若干 INFO。

重构回归风险：workflow orchestrator 拆分后行为与原实现等价（`handleWorkerExit` 的 `currentWorker !== exitedWorker` 守卫、budget 累加含 cacheRead/cacheWrite、retry 间真实计费等均有显式注释和测试覆盖）。唯一的回归是 `engine/model-resolver.ts` 删除了 scene→model 解析（`opts.scene` 现被忽略），但是有意为之并已记录。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|------|------|------|------|------|---------|
| MUST_FIX | `extensions/subagents/src/core/event-bridge.ts` | 140-163 | 错误判定 | `message_end` 先判 `msg?.usage` 命中即 `return`（L143→L153），导致同时携带 `usage` 与 `stopReason==="error"/"aborted"` 的事件跳过 `lastError` 设置与 error 事件转发。下游 `session-runner.run()` 用 `built.bridge.lastError` 判 success（`if (built.bridge.lastError) success=false`），此时 lastError 为 undefined → success 保持 true → **errored session 被判为 done**，空/残缺结果回传父 agent。LLM provider 的错误响应常带 usage（token 已计费），此路径非边缘。 | 把 usage 累积与 error 判定改为非互斥：先无条件累积 usage（若存在），再独立检查 `stopReason`；或去掉 L153 的 early return，让 error 分支在 usage 之后继续判断。`updateFromEvent` 侧 `totalTokens` 累积也要保证 error+usage 时不漏算。 |
| SUGGESTION | `extensions/subagents/src/core/session-factory.ts` | 307-324 | 工具过滤 | `applyToolFilter` 当 `allowed.length < allTools.length` 即调 `setActiveToolsByName(allowed)`。若 agent frontmatter 的 `tools` 白名单全部失配（拼写错误、工具被重命名/卸载），`allowed=[]`，`0 < allTools.length` 成立 → `setActiveToolsByName([])` → agent 被剥夺全部工具，无法行动，却仍以空结果被判 done。 | `allowed.length === 0` 时跳过 `setActiveToolsByName` 并发警告（或 throw），避免静默清空工具集。 |
| SUGGESTION | `extensions/workflow/src/infra/agent-pool.ts` | 218-221, 272-276 | 资源泄漏 | `enqueue` 注册 `signal.addEventListener("abort", onAbort, {once:true})`，`run` 内再注册 `signal.addEventListener("abort", () => controller.abort(), {once:true})`。`{once:true}` 仅在事件触发时自动移除；调用正常完成（未 abort）时两个 listener 永不摘除。orchestrator 的 `runAbortController` 跨一次 run 内所有 agent 调用存活，listener 随 agent 调用数线性堆积（一次 run N 个调用 → 2N 个闭包挂在同一 signal 上）。 | 在 `run()` resolve 前后（或 `.finally`）对非 aborted 路径 `signal.removeEventListener`；或将外部 signal 桥接到一次性内部 controller 后即解绑。 |
| SUGGESTION | `extensions/subagents/src/runtime/execution/history-store.ts` | 154-161 | 死代码/逻辑反转 | `recent()` 去重：`if (sameEndedAt && existing.status !== "cancelled" && r.status === "cancelled") { byId.set(r.id, r); } else { byId.set(r.id, r); }` —— 两个分支都执行 `byId.set(r.id, r)`，"cancelled 优先"意图从未生效，已存在的 cancelled 总被后写覆盖（与 `record-store.collectRecords` 里正确的 `continue` 实现不一致）。 | `existing.status === "cancelled" && r.status !== "cancelled"` 时 `continue`（保留现有 cancelled），其余 last-writer-wins。 |
| SUGGESTION | `extensions/unified-hooks/src/hooks/tool-error-handler.ts` | 35 | 空指针 | 本次将 `console.warn(msg)` 改为 `ctx.ui.notify(msg, "warn")`，但无 `ctx.ui` 存在性判断。本地声明的 `HookContext` 断言 `ui` 必有，但在无 UI/headless 会话中 `ctx.ui` 可能为 undefined → `ctx.ui.notify` 抛 TypeError（事件处理器内）。`index.ts` 的 `session_start` hook 有同样模式。 | `ctx.ui?.notify(msg, "warn")`，或回退到 `console.warn`。 |
| INFO | `extensions/subagents/src/core/session-factory.ts` | 360-400 | 阻塞 I/O | `buildEnvBlock` 用 `execFileSync` 同步 spawn git（2s timeout），靠模块级 `branchCache` 按 cwd 缓存。同 cwd 仅首次阻塞；但不同 cwd 的并发首 session 会串行阻塞事件循环。缓存本身是进程级 `Map`（跨 session 共享），对 git branch 这类准静态数据可接受。 | 可接受现状；若关注并发首启动延迟，改 `execFile`（异步）+ Promise 缓存。 |
| INFO | `extensions/subagents/src/runtime/subagent-service.ts` | 113-125, 250-290 | 生命周期 | `dispose()` 不 abort 运行中的 background controller，detached `runAndFinalize` 在 session_shutdown 后继续跑，仍会调 `pi.appendEntry` / `history.append` / `store.archive`（store/notifier 已 `_disposed` 会短路 notify，但 history 写入仍执行）。设计上 background 是 detached，但 shutdown 后 pi 引用可能失效。 | 可接受（detached 语义）；若需严格，dispose 时遍历 live background records 调 `controller.abort()`。 |
| INFO | `extensions/workflow/src/engine/model-resolver.ts` | 18-21 | 行为回归 | 相对 main 删除了 scene→model 解析（`@zhushanwen/pi-model-switch` 的 `resolveModelForScene`），`opts.scene` 现被忽略。属有意回归（注释说明 "spawn 架构回归后"），但使用 `agent({scene:"..."})` 的工作流静默丢失模型选择。 | 确认无下游工作流依赖 scene；若依赖，在 release notes 标注 breaking。 |
| INFO | `extensions/subagents/src/runtime/config/config.ts` | 50, 128 | 配置校验 | `parsed.maxConcurrent ?? 4` 仅处理 undefined。若 JSON 写成非数字（`"abc"`），传入 `DefaultConcurrencyPool` 后 `Math.max(1, NaN)=NaN`，`this._active < NaN` 恒 false → acquire 永久排队死锁。负数被 `Math.max(1, ...)` 兜住，无碍。 | `loadGlobalConfig` 中对 `maxConcurrent` 做 `Number.isFinite` 校验，非法值回退默认。 |
| INFO | `extensions/subagents/src/runtime/subagent-service.ts` | 271-285 | 指标准确性 | `cancelBackground` 合成的 `cancelledResult.durationMs: 0`，导致 cancelled record 的耗时统计恒为 0（`completeRecord` 写入 `agentResult`，`project` 不读 durationMs，但持久化/通知路径若用此值会失真）。 | `durationMs: Date.now() - record.startedAt`。 |

## 附录：已验证无问题的重点项

- **并发池竞态**（`concurrency-pool.ts`）：JS 单线程下 acquire 的 check+increment 天然原子；release 的 splice+resolve 不改 active 语义正确；`active>0` 下界防下溢；`maxConcurrent=0` 经 `Math.max(1,...)` 兜底。
- **cancel/finalize 竞态**（`subagent-service.ts`）：`tryTransition` CAS 抢锁 + background `.then` 检查 `status !== "cancelled"`，cancel 与 detached 完成两条路径互斥，无双 notify / 双 history 写入。
- **turn-limiter 边界**（`turn-limiter.ts`）：`maxTurns<=0` → `limit=Infinity` 禁用；`graceTurns<=0` → steer 后下一 turn 即 abort；steer/abort 各仅一次。
- **workflow orchestrator 重构等价性**：`handleWorkerExit` 增加 `currentWorker !== exitedWorker` 守卫防旧 worker exit 误删新 worker；`pause` 保留 controller（`terminateWorker(runId, true)`）让 pause→resume 间 retry 仍能写 callCache；budget 累加含 cacheRead/cacheWrite 四项（对齐 agent-pool contextTokens）；`checkBudget` 的 `maxTokens>0` 守卫防 `maxTokens===0` 误判。
- **event-bridge tool 配对**（`event-bridge.ts`）：`pendingTools` Map 用 toolCallId 回填 end 缺失的 args，thinking_delta 先于 text_delta 判断，均正确。
