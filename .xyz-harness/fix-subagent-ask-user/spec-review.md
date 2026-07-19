# Spec Review：fix-subagent-ask-user

> 方法：禁读重建。派 fresh explorer subagent 从源头（objective + clarifyRecords + ADR-033）重建 spec，与初稿 diff。发现 6 个缺口。

## 审查方法

不直接读 spec 初稿找漏洞（容易顺着初稿思路走）。派 fresh subagent 只给源头信息，让它重建 spec 应有的 FR/AC，然后 diff。diff 出的差异是初稿遗漏的真问题。

## 审查发现（6 条）

### SR-1 [major/completeness] 响应侧协议格式错未单列为 FR（根因 1b）

`isRpcResponse`（spawn-event-adapter.ts:57-68）也期望 JSON-RPC 2.0 格式（`jsonrpc+id+result/error`），与根因 1 对称。spec FR-10 涵盖了 stdin 回写格式，但 FR 未单列 `isRpcResponse` 的修正。session-runner.ts:440/464/482 回写 `{jsonrpc:'2.0',id,result}` 也错（Pi rpc-mode.ts:743-756 只认 `type:extension_ui_response` + id）。

**修复**：补 FR——`isRpcResponse` 重写为 `{type:'response',command,success,data|error}`；`respond()` 回写 `{type:'extension_ui_response',id,value|confirmed|cancelled}`。

### SR-2 [major/completeness] TC-W2 假测试修复未显式列为 FR

现有 `ui-request-handler.test.ts:21-24` 的 mock 用 `jsonrpc:'2.0'` + `params.marker:'ASK_USER'` + `params.questions`，编码了错误协议。测试绿但生产红。spec 的 AC 隐含 TC-W2 修复，但无对应 FR。

**修复**：补 FR——TC-W2 mock 必须换成 Pi 真实格式样本（`{type:extension_ui_request,id,method:select,title:\0XYZ_ASK_USER...,options:[...]}`），断言改为 channel/channelPayload。

### SR-3 [major/completeness] existingService 复用路径的 handler 重注入缺失

`index.ts:206` `existingService ?? new SubagentService`。`/resume` `/fork` 复用 existingService 时，`new` 分支的 setter 不触发，handler 仍是 undefined（或上次的）。`warnedMissingHandlerSessions` 也不清空。

**修复**：补 FR——无论 new 还是 existing，session_start 都必须调 `service.setUiRequestHandler(createUiRequestHandlerForMode(...))`。

### SR-4 [major/reasonableness] L2 队列 pending 请求在子进程退出时的 abort 缺失

L1 `createUiRequestQueue` 有 AbortController + `child.on(close/error)`，L2 `DialogGlobalQueue` 设计未提。子进程退出时 L2 里该 child 的 pending dialog Promise 会永挂 + 内存泄漏。

**修复**：补 AC——L2 入队项带 signal（或 child 引用），child close 时把 L2 中该 child 的 pending 全部 reject 为 cancelled。

### SR-5 [minor/reasonableness] fire-and-forget 的 ack 不产生 wire bytes

TUI 下 fire-and-forget 回 `{ack:true}` 容易被误实现为回写 stdin ack 行。Pi fire-and-forget method（notify/setStatus/setWidget/...）rpc-mode.ts:151-160 是同步 output 后立即返回，不注册 pending，父端不回任何行。

**修复**：补 AC——TUI 下 fire-and-forget 不写任何 stdin 行（ack 仅 handler 返回值层面占位）。

### SR-6 [minor/reasonableness] headless 下 ask_user 闭环

W4 不注入但子进程 agentConfig.tools 仍含 ask_user。子进程 LLM 仍可能调 ask_user → 父 headless 不注入 handler → missing-handler 兜底。ask-user/index.ts:247 有 `ctx.mode!=='tui'&&!=='rpc'` → disableAskUser 自身兜底，但 spec 未显式记录这个二层防护。

**修复**：补 AC/说明——headless 下 ask_user 调用走 missing-handler 兜底（appendEntry + 回 cancelled），且 ask-user 扩展自身的 disableAskUser 二次防护。确认两层都生效。

## 审查结论

源头的 5 根因 + 两维度架构覆盖了主路径。6 个缺口中 SR-1/2/3/4 是 major（必须进 plan），SR-5/6 是 minor（实现时注意即可）。所有缺口都会在 plan 阶段的 dev-plan.json 中体现为对应 Wave 的 task。
