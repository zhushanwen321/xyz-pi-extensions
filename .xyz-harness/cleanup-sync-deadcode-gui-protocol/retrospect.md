# Retrospect: cleanup-sync-deadcode-gui-protocol

## 目标

清理 pi-subagents-workflow 中 sync 模式残留死代码，删除废弃 _render 协议，适配新 GUI 协议（__gui__）。

## 执行摘要

3 个 Wave 全部完成，2 次 commit：

| Wave | 内容 | Commit |
|------|------|--------|
| W1 | 清理 sync 死代码（syncCancelHint、注释、错误消息） | 8476e51 |
| W2+W3 | 删除 _render + 新建 gui-adapter.ts + 适配 __gui__ | f5da47c |

## 关键决策

### 1. GuiContext 用 hasUI 而非 mode

`ExtensionContext` 没有 `mode` 字段（SDK stub 未声明）。用 `hasUI === false` 判断 RPC 模式，语义等价。

### 2. pending-notifications 的 __gui__ 适配方式

bg-notify 消息由 pending-notifications 扩展发送，不是 subagents-workflow。选择在 pending-notifications 中捕获 `isRpcMode` 并直接构造 __gui__（内联，不依赖 gui-adapter.ts），避免跨包依赖。

### 3. sessionState 存 ctx

notifyDone 需要 GuiContext，但 onRunDone 回调由 engine 层调用，无 ctx。方案：session_start 时将 ctx 存入 sessionState，makeDeps 时传入。

## 遗留项

- gui-adapter.ts 是 stub 实现，待 `@xyz-agent/extension-protocol` 包可用后替换 import
- workflow-script tool 未加 __gui__（它的 details 结构简单，优先级低）
- overlay 组件（/subagents、/workflows）无 GUI 协议适配（它们用 ctx.ui.custom，RPC 模式下不工作，属 P4 范畴）

## 数据

- 文件变更：7 文件，+354/-83 行
- 测试：687 passed（subagents-workflow）+ 29 passed（pending-notifications）
- typecheck：零错误
