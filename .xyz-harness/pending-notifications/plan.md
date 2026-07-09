---
scope_ensemble_overlap: not_triggered
reuse_ensemble_overlap: not_triggered
test_ensemble_overlap: not_triggered
reconstruct_blind_spot: not_triggered
---

# Pending Notifications Extension 实现计划

## 业务目标

创建 `pending-notifications` extension，实现跨 extension 的异步操作注册/查询机制，解决 workflow/subagent 运行时 goal 持续注入消息的悖论。

成功标准：
- Workflow 启动时注册 pending notification，goal 的 `before_agent_start` 检测到后注入等待消息
- Subagent background 模式启动时注册 pending notification，goal 同样检测并等待
- Pi 重启后自动将所有未关闭的 pending notification 标记为 expired
- 每个 pending notification 有 1 小时过期时间，防止永久残留

约束：不修改 Pi 核心 API，纯 extension 实现。不做：不支持 request/response 式查询（只支持 EventBus 广播 + entry 读取）。

## 技术改动点

**新建文件**：
- `extensions/pending-notifications/index.ts` — 扩展入口（re-export src/index.ts）
- `extensions/pending-notifications/src/index.ts` — 扩展工厂函数，注册 EventBus 监听 + entry 管理 + 查询工具

**修改文件**：
- `extensions/workflow/src/engine/launcher.ts` — 在 `runAndWait` 启动时 emit `pending:register`，完成/失败/超时时 emit `pending:unregister`
- `extensions/subagents/src/runtime/subagent-service.ts` — 在 `execute` 启动时 emit `pending:register`，在 `runAndFinalize` 完成时 emit `pending:unregister`
- `extensions/goal/src/adapters/event-handlers/before-agent-start.ts` — 从 session entries 读取 pending notifications，如有则注入等待消息

**复用说明**：
- EventBus 机制（`pi.events.emit/on`）— 复用 Pi 现有的扩展间通信
- Custom Entry（`pi.appendEntry`）— 复用 Pi 现有的状态持久化机制
- 无新增共享模块，各 extension 通过 EventBus 松耦合通信

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1   | extensions/pending-notifications/index.ts, extensions/pending-notifications/src/index.ts | - | - | 核心：创建 pending-notifications extension |
| W2   | extensions/workflow/src/engine/launcher.ts, extensions/subagents/src/runtime/subagent-service.ts, extensions/goal/src/adapters/event-handlers/before-agent-start.ts | W1 | - | 集成：workflow/subagent 注册 + goal 查询 |

## 单测用例清单（AC 级）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1     | pending-notifications/src/index.ts:session_start | session_start 事件，entries 有 1 个 register 无 unregister | registry.size === 1, status === "active" | 正常 |
| U2     | pending-notifications/src/index.ts:session_start | session_start 事件，entries 有 register + unregister 对 | registry.size === 0（已注销） | 正常 |
| U3     | pending-notifications/src/index.ts:session_start | session_start 事件，entries 有 register 但 expiresAt < now | 自动补 unregister entry, status === "expired" | 边界 |
| U4     | pending-notifications/src/index.ts:session_start | session_start 事件，entries 有 register 但 sessionId 不同 | 自动补 unregister entry, status === "expired" | 边界 |
| U5     | pending-notifications/src/index.ts:event:register | emit("pending:register", {id:"w-1", type:"workflow", name:"test"}) | registry 有 "w-1", appendEntry 被调用 | 正常 |
| U6     | pending-notifications/src/index.ts:event:register | emit("pending:register", {id:"w-1"}) 重复注册 | 忽略重复，registry 不变 | 边界 |
| U7     | pending-notifications/src/index.ts:event:unregister | emit("pending:unregister", {id:"w-1"}) | registry.get("w-1").status !== "active", appendEntry 被调用 | 正常 |
| U8     | pending-notifications/src/index.ts:event:unregister | emit("pending:unregister", {id:"nonexistent"}) | 忽略，不报错 | 异常 |
| U9     | pending-notifications/src/index.ts:tool | pending_notifications({action:"count"}) 当前有 1 个 active | 返回 "1 pending operation(s)" | 正常 |
| U10    | pending-notifications/src/index.ts:tool | pending_notifications({action:"list"}) 当前有 2 个 active | 返回列表包含两个通知 | 正常 |
| U11    | pending-notifications/src/index.ts:session_shutdown | session_shutdown 事件，当前有 2 个 active | 所有 active 标记 cancelled, 补 unregister entry | 正常 |
| U12    | launcher.ts:runAndWait | 正常完成 workflow | emit register 后 emit unregister(reason:"completed") | 正常 |
| U13    | launcher.ts:runAndWait | workflow 失败抛异常 | emit register 后 emit unregister(reason:"failed") | 异常 |
| U14    | launcher.ts:runAndWait | workflow 超时 | emit register 后 emit unregister(reason:"expired") | 边界 |
| U15    | subagent-service.ts:execute | background subagent 启动 | emit register(id 以 "subagent-" 为前缀, type:"subagent") | 正常 |
| U16    | subagent-service.ts:execute | background subagent 完成 | emit unregister(id 以 "subagent-" 为前缀, reason:"completed") | 正常 |
| U17    | before-agent-start.ts | entries 有 1 个活跃 workflow | 返回 goal-context-waiting 消息 | 正常 |
| U18    | before-agent-start.ts | entries 无活跃通知 | 返回正常 contextInjectionPrompt | 正常 |
| U19    | before-agent-start.ts | entries 有 workflow + subagent 各 1 个 | 返回等待消息包含两者 | 边界 |

## E2E 用例清单

| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|--------|------|------|------|---------|
| E1     | Workflow 运行时 Goal 注入等待消息 | mock | Goal active, workflow 脚本存在 | 1. 启动 goal 2. 调用 coding-workflow 3. 观察 goal 注入消息 | Goal 注入 "Waiting for async operations" 消息 | vitest (mock EventBus + entries) |
| E1-r   | Workflow 运行时 Goal 注入等待消息 | real | 完整 Pi 环境 + goal + workflow | 1. /goal Fix bug 2. 调用 workflow 3. 观察 TUI | Goal 显示等待提示 | 手动验证 |
| E2     | Workflow 完成后 Goal 恢复正常注入 | mock | Goal active, workflow 刚完成 | 1. workflow 完成 2. 观察 goal 注入消息 | Goal 注入正常 contextInjectionPrompt | vitest (mock EventBus + entries) |
| E3     | Pi 重启后自动清理 expired | mock | entries 有 1 小时前的 register 无 unregister | 1. 触发 session_start 2. 检查 registry | 自动补 unregister, status=expired | vitest |

## 覆盖率 gate

- gate 命令：`pnpm --filter @zhushanwen/pi-pending-notifications test --coverage`
- 阈值：增量覆盖率 ≥ 60%
- gate 位置：列为开发阶段的独立 todo（isVerification=true）

## 实现步骤

1. [W1] 创建 pending-notifications extension
   - 写 U1-U11 失败测试
   - 实现 index.ts（EventBus 监听 + entry 管理 + 查询工具）
   - 测试通过
   - 提交

2. [W2] 集成到 workflow/subagents/goal
   - 写 U12-U19 失败测试
   - 修改 launcher.ts（runAndWait 注册/注销）
   - 修改 subagent-service.ts（execute 注册/注销）
   - 修改 before-agent-start.ts（查询并注入等待消息）
   - 测试通过
   - 提交

3. [验证] 运行 E2E 用例
   - E1 mock 测试通过
   - E2 mock 测试通过
   - E3 mock 测试通过
   - E1-r 手动验证通过
