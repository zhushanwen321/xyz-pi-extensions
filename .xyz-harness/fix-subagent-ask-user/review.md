# Code Review：fix-subagent-ask-user

> 审查方法：派 general-purpose reviewer subagent 对 git diff 990fdc5a0..HEAD 的核心实现文件做代码级审查。

## 审查范围

核心实现文件（不含测试）：spawn-event-adapter.ts / session-runner.ts / subagent-service.ts / dialog-queue.ts / host-mode.ts / ui-interaction-model.ts / ui-channels.ts / ui-request-handler-factory.ts / ui-request-observability.ts / index.ts

## 发现

### Critical

#### C1: L2 队列子进程清理路径（SR-4）完全没接通 → 全局死锁隐患

`rejectChildDialogs` / `EnqueueOptions.child` 从未在生产代码调用：
- `ui-request-handler-factory.ts:63` enqueue 没传 opts.child
- `dialog-queue.ts:214` rejectChildDialogs 全仓只有测试在调，生产零调用
- `session-runner.ts:408-409` L1 的 child.on("close") 只清 L1 自己，没通知 L2

**后果**：子进程在 dialog 等 L2 时退出 → L2 里的项永不 settle → processing 永远 true → 所有其他子进程的 dialog 永久阻塞 → 全局 dialog 通道中毒。

当前潜伏（defaultDialogForward stub 秒返回 cancelled），但 Stage 4 接入真实 await 用户输入后立刻变生产事故。**本 PR 全部意义是为 Stage 4 铺路，必须修**。

**修复**：方案 A——session-runner createUiRequestQueue 的 onClose 里调 dialogQueue.rejectChildDialogs({pid: child.pid})，factory 的 enqueue 传 { child: { pid: child.pid } }。

### Major

#### M1: DialogGlobalQueue.enqueue 的 fire-and-forget 死分支 + 注释矛盾

`dialog-queue.ts:167-170` 有 fire-and-forget 分支，但唯一调用方 factory 已在 enqueue 前判 isDialogMethod，这个分支永远走不到。文件头注释（:19-20）说「本队列内不重复判断 method」与实现（L167 重复判断）矛盾。JSDoc（:148-152）也说「内部按 method 分流」进一步误导。

**修复**：删 L167-170 死分支，JSDoc 改为「调用方必须只对 dialog 类调 enqueue」。

### Minor

- **m1**：respond 的 [R2] 注释错位（说 stringify 在调用方完成，实际在本函数）。改注释为「UiResponse 只携带原始类型，stringify 不会抛」。
- **m2**：notifyMissingHandler 已 public 但零调用（W3 TODO）。接通或标 @internal。
- **m3**：index.ts 同时 setUiRequestHandler + initSession({uiRequestHandler}) 重复。保留一个。
- **m5**：buildExtensionUiRequest 的 `as string[]` 不安全断言。加元素类型过滤。
- **m6**：processNext 末尾 void this.processNext() 多余（幂等但误导）。删掉或统一推进点。

## 未发现问题的文件

- host-mode.ts / ui-interaction-model.ts / ui-channels.ts / ui-request-observability.ts：干净。
- subagent-service.ts 注释精简未丢「为什么」。
- SR-3 existingService 无条件调 setUiRequestHandler：满足。

## 总结

核心架构（两维度正交、L1+L2 两级队列、method 分类、channel 注册表）正确。C1 是组装端到端时漏掉的清理线，必须在本 PR 修。M1 是死代码 + 注释矛盾。minor 是注释纠偏和类型收紧。
