# subagents 技术债治理计划

## Wave 依赖图

```
W1 ──┬──→ W2 ──→ W3
     │              ↓
     └──→ W4 ──→ W5 ──→ W6
```

- W1/W4：无依赖，可并行
- W2 依赖 W1（内联 EventBridge 后才能简化 session-runner）
- W3 依赖 W2（session-runner 简化后才能合并 factory）
- W5 依赖 W4（RecordStore 简化后才能改 notifier）
- W6 依赖 W3+W5（最后收尾验证）

---

## Wave 1：砍掉 EventBridge 层

**目标**：删除 `src/core/event-bridge.ts`（~160 行），usage 累积内联到 session-runner 的 `onEvent` 回调。

**改动范围**：
- 删除 `src/core/event-bridge.ts`
- 修改 `src/core/session-runner.ts`：`onEvent` 回调直接处理 SDK events（usage 累积 + turn 计数 + toolCall 收集 + error 检测）
- 修改 `src/core/session-factory.ts`：删除 `createEventBridge` import，`BuiltSession` 去掉 `bridge` 字段
- 修改 `src/core/output-collector.ts`：`collectResult` 直接从 session 取 usage/turns/toolCalls，不依赖 bridge 累积器

**保留的逻辑**：
- `isSdkEvent` guard → 移到 session-runner 内部函数
- `SdkEvent` duck-type → 移到 types.ts（session-runner 和 output-collector 共用）
- usage 累积逻辑 → 在 session-runner 的 `run()` 闭包内维护局部变量

**验证**：
- `pnpm --filter @zhushanwen/pi-subagents typecheck`
- `pnpm --filter @zhushanwen/pi-subagents test`
- 旧 `event-bridge.test.ts` 的用例迁移到 session-runner 测试或删除（如果已由集成测试覆盖）

**预估减少**：~160 行（删除文件）+ 净减少 ~30 行（内联后更简洁）

---

## Wave 2：简化 session-runner 的 RunHooks

**目标**：删除 `RunHooks` 接口和 `attachRunHooks` 函数，turnLimiter + signal-abort + schema enforcement 直接在 `run()` 内联。

**改动范围**：
- 修改 `src/core/session-runner.ts`：
  - 删除 `RunHooks` 接口
  - 删除 `attachRunHooks` 函数
  - `run()` 内直接创建 `turnLimiter`、`addEventListener`、维护 `schemaSteerCount`
  - `onTurnEnd` 闭包直接在 `run()` 内定义

**原因**：`attachRunHooks` 把三件事捆成一个接口，但 signal-abort 只是一行 `addEventListener`，不值得单独封装。

**验证**：typecheck + test 通过

**预估减少**：~50 行

---

## Wave 3：合并 session-factory 到 session-runner

**目标**：删除 `src/core/session-factory.ts`（~350 行），其逻辑合并到 session-runner 的 `run()` 和一个 `createSession` 内部函数。

**改动范围**：
- 删除 `src/core/session-factory.ts`
- 修改 `src/core/session-runner.ts`：
  - `SdkLike`、`AgentSessionLike`、`ResourceLoaderLike` 等 duck-type 接口移到 session-runner 内部（或 types.ts）
  - `createAndConfigureSession` → 内部函数 `createSession`
  - `buildAppendSystemPrompt`、`buildResourceLoader`、`applyToolFilter`、`getSubagentSessionDir` → 内部函数
  - `SessionFactoryContext` → 合并到 `SessionRunnerContext`
- 修改 `src/runtime/subagent-service.ts`：import 路径更新

**原因**：session-runner 是 session-factory 的唯一调用方。四步组装中步骤 1/2 都是一行包装函数，碎片化不必要。

**验证**：typecheck + test 通过

**预估减少**：~150 行（删除碎片化包装 + 合并上下文类型）

---

## Wave 4：RecordStore 单 Map + 过滤

**目标**：`RecordStore` 从三 Map（live/completed/bg）改为单 Map + 按 status/mode 过滤。

**改动范围**：
- 修改 `src/runtime/execution/record-store.ts`：
  - `live`/`completed`/`bg` → 单个 `records: Map<string, ExecutionRecord>`
  - `register` → 直接 set
  - `archive` → 不迁移，只更新 status（由 `completeRecord` 已设置），启动 linger 定时器（sync）或保留（bg）
  - `listRunning` → `filter(r => r.status === "running")`
  - `collectRecords` → 单 Map 值 + history merge
  - 删除 `enforceBgFifo`（或简化为对终态 record 的 TTL 清理）
  - `scheduleSyncExpire` → 对所有终态 record 统一 TTL

**原因**：live 和 bg 的区别只是 mode 字段（都是 running），分三个 Map 引入了不必要的迁移逻辑。

**验证**：typecheck + test 通过。特别注意 `listRunning`、`collectRecords`、`cancel` 的行为不变。

**预估减少**：~80 行

---

## Wave 5：砍掉 BgNotifier 滑动窗口，直接 notify

**目标**：`BgNotifier` 从滑动窗口合并改为直接发送。删除 pending 队列、timer、dedup TTL。

**改动范围**：
- 修改 `src/runtime/execution/notifier.ts`：
  - 删除 `pending` 数组、`dedup` Map、`timer`
  - `notify()` → 直接调 `host.sendMessage()`（构造 content + details）
  - 删除 `flushPendingNotifications`（公开方法保留为空操作兼容 `SubagentService.dispose`）
  - 保留 `buildLlmContent`（单条构造）

**原因**：用户几乎不会同时启动多个 background subagent 让它们同时完成。2000ms 延迟让通知不及时，dedup TTL 暗示系统可能重复触发（根因应修，不该用 TTL 兜底）。

**验证**：typecheck + test 通过。注意 `dispose` 和 `flushPendingNotifications` 的调用方兼容。

**预估减少**：~80 行

---

## Wave 6：收尾验证 + 文档更新

**目标**：全量验证 + 更新 ADR/CLAUDE.md。

**改动范围**：
- `pnpm -r typecheck`（全量）
- `pnpm --filter @zhushanwen/pi-subagents test`
- 更新 `docs/adr/001-subagent-architecture.md`：记录 EventBridge 合并、RecordStore 简化等决策
- 更新 `extensions/subagents/CLAUDE.md`（如有）
- 统计最终代码行数，确认目标达成

**不改代码**，纯验证 + 文档。

---

## 预估汇总

| Wave | 改动文件 | 减少行数 | 风险 |
|------|---------|---------|------|
| W1 | 4 文件删除/修改 | ~190 | 低：逻辑只是换位置 |
| W2 | 1 文件 | ~50 | 低：纯重构 |
| W3 | 2 文件删除/修改 | ~150 | 中：import 路径多处变化 |
| W4 | 1 文件 | ~80 | 中：状态迁移逻辑变化 |
| W5 | 1 文件 | ~80 | 低：删除未充分使用的功能 |
| W6 | 0 代码 | 0 | 无 |
| **合计** | | **~550** | |

从 ~10800 降到 ~10250。如果目标是 7500，还需要进一步砍：
- list-view 全屏 overlay（~700 行）→ 简化为 select 列表（~200 行），再省 ~500
- 合并 ModelConfigService 回 SubagentService，省 ~200
- 简化 execution-record 的投影函数（project/snapshot/toPersisted 三合一），省 ~100

这些放在 W6 之后的第二轮治理。
