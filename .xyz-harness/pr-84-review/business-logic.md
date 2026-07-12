---
verdict: pass
must_fix: 0
---

## Summary
0 must-fix, 3 suggestions, 4 infos.

本次 RPC lifecycle + GUI 协议迁移的业务逻辑整体正确。四个扩展（ask-user / subagent-workflow / todo / goal）的 RPC 分支判别（`ctx.mode === "rpc"`）、`__gui__` 附件条件（`isGuiCapable(ctx)` 或等价的 mode 检查）、以及生命周期操作的错误恢复路径均完整。纯函数解析器（`parseSubagentRpcCommand` / `parseWorkflowRpcCommand`）的边界覆盖（空串 / 缺 id / 未知 action）实现正确。未发现影响数据一致性或功能正确性的 MUST_FIX 缺陷。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| SUGGESTION | extensions/subagent-workflow/src/interface/subagents.ts | 30-36 | 异常路径 | `/subagents` RPC cancel 分支直接调 `service.cancel(parsed.recordId)` 无 try/catch。`cancel()` 内部 `assertReady()` 在 service 被 session_shutdown 并发 dispose 时会抛错（"subagents service disposed"）。对比同 PR 的 `/workflows` RPC 分支（commands.ts L78-87）对 `pauseRun/resumeRun/abortRun` 做了 try/catch + notify 兜底，此处不一致。极端竞态下用户会看到未捕获异常而非友好提示。 | 给 `service.cancel()` 调用包 try/catch，catch 内 `ctx.ui.notify(msg, "error")`，与 `/workflows` RPC 分支保持一致。 |
| SUGGESTION | extensions/subagent-workflow/src/interface/helpers.ts | 113 | 边界渲染 | `notifyDone` 构造 list-tree label 时，slug 为 undefined 产生中间双空格：`${name} ${slug ?? ""} ${runId.slice(0,8)}` → `"build  abcdefgh"`（helpers-gui.test.ts L129-131 把它固化为期望值，但这是把 bug 写进测试）。`tool-workflow.ts` buildWorkflowGui L170 同模式同样有此问题。两个 list-tree 渲染入口 label 格式不收敛。 | 用 `[name, slug, runId.slice(0,8)].filter(Boolean).join(" ")` 拼接，自动消除空段产生的多余空格。 |
| SUGGESTION | extensions/subagent-workflow/src/interface/tool-workflow.ts | 188-195 | 语义映射 | pause/resume/abort/retry-node/skip-node 的 GUI stats-line severity 恒为 `"ok"`。虽然 details 仅在操作成功时存在（失败走 textResult → details: undefined → withGui 返回 undefined），"ok" 在技术上成立，但 `abort` 是破坏性终止操作，用绿色 "ok" 与用户对"中止"的语义预期不符；pause 也非"成功完成"。 | abort 用 `"warn"`，pause 用 `"warn"`，resume/skip-node/retry-node 保留 `"ok"`；或在 stats-line item 的 label 上区分（如 "aborted" 而非 "abort"）。 |
| INFO | extensions/subagent-workflow/src/interface/gui-mappers.ts | 42-57 | 状态映射 | `mapRunStatus("pending")` 命中末尾 fallback 返回 `"done"`。workflow 的 RunStatus（running/paused/done）和 subagent 的 ExecutionStatus（running/done/failed/cancelled/crashed）域模型中均无 "pending" 状态，该分支仅为防御性兜底，实际链路不会触发。gui.test.ts L40 将其固化为期望值。 | 无需修改；如想更稳健可把 fallback 改 `"running"`（未知状态倾向"进行中"更安全），但无实际触发路径。 |
| INFO | extensions/subagent-workflow/src/interface/subagent-actions.ts | 293-301 | 协议一致性 | `buildGuiComponent` 的 list 分支构造 TreeItem 时未设 `depth` 字段（protocol TreeItem.depth 可选）。todo 的 buildGui（model.ts L96）显式设 `depth: 0`。两处 list-tree 生成风格不统一。功能不受影响（前端对 undefined depth 有默认处理）。 | 可加 `depth: 0` 保持 monorepo 内 list-tree 构造风格统一；非必须。 |
| INFO | extensions/subagent-workflow/src/interface/subagents.ts | 31-35 | UX 反馈粒度 | `/subagents` RPC cancel 直接用 `service.cancel()` 的 boolean 返回值给通用文案（"not found or already finished"）。同域的 tool cancelHandler（subagent-actions.ts L206-232）做了 findRecord → mode 检查 → CAS，能给出三档精确错误（id 不存在 / mode 不支持 / 刚 finalize）。RPC 命令路径反馈粒度较粗。 | 可接受——命令路径面向 GUI 按钮（已选中的 record id 必然有效），粗粒度提示已足够；如需对齐可复用 cancelHandler 逻辑。 |
| INFO | extensions/ask-user/src/index.ts | 143-164 | 竞态语义 | RPC 模式下若 signal 在 select 进行中被 abort（goal 取消 / compact），`askUserInteract` 的 select 返回 undefined → 返回 null → `runRpcInteraction` 返回 `{ cancelled: true }` → 走"User cancelled"文案。与 step 3 的"Agent aborted"文案（select 前已 abort 的入口检查）区分开，但 select 进行中的 abort 被归入"用户取消"语义。 | 影响：LLM 看到的文案略有误导（用户未主动取消却显示 cancelled）。由于 ask-user 的 cancelled 和 aborted 对 LLM 的后续行为指引基本一致（都不假定答案、不重试），实际影响小。如需精确区分，需让 askUserInteract 区分 user-cancel 与 signal-abort（当前 select 通道不区分）。 |
