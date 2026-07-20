# 006 — Subagent RPC 通道错误边界重构

- **Status**: draft（待实施）
- **Date**: 2026-07-20
- **Scope**: `extensions/subagent-workflow/src/execution/`
- **Supersedes**: 无（补丁式修复的长期替代）

## 背景

subagent worker 在主进程等待 UI 响应期间退出，触发 `child.stdin.write()` EPIPE，无 try/catch、child.stdin 也无 'error' listener，错误冒泡为 uncaughtException，**整个父进程崩溃**。

崩溃栈：

```
Error: write EPIPE
  at writeStdinLine (stdin-writer.ts:104)
  at respond (stdin-writer.ts:45)
  at handleUiRequest (ui-request-queue.ts:141)
```

触发链：

1. subagent 子进程发起 `extension_ui_request`，主进程 `handleUiRequest` 卡在 `await handler(uiReq)`
2. 等待期间子进程退出/OOM/被杀 → stdin 管道写端关闭
3. handler resolve 后回到 `ui-request-queue.ts:141`，`signal?.aborted` 与 `child.stdin.destroyed` 两个守卫都来不及生效（child 'close' 是异步竞态；stream `destroyed` 标志置位有窗口期）
4. `respond` → `writeStdinLine` → `child.stdin.write()` 同步抛 EPIPE
5. `handleUiRequest` 的 try/catch（line 137–147）救不了：line 141 抛 EPIPE 被 catch 接住，catch 块 line 146 又调 `respond()` 再次 EPIPE，catch 内抛错无人接 → uncaughtException

## 根因（三个结构性缺陷）

1. **写入路径无统一防护**：`respond` / `sendPromptCommand` / `sendGetStateCommand` 各自直接 `child.stdin.write`，靠调用方记得检查 signal/destroyed，防护不一
2. **无持久 error listener**：child.stdin 从未挂 'error' listener，stream error 事件直接升级为 uncaughtException
3. **错误边界混淆**：`handleUiRequest` 用一个 try/catch 同时包"不可信的 handler 代码"和"会抛 EPIPE 的 write 代码"，catch 里又调 write → catch 内抛错 = uncaughtException

问题本质：**RPC 通道（stdin）是会随时失效的资源，但代码各处把它当成永久可用的管道**。

## 方案设计

### 核心：`ChildRpcChannel` 抽象

把"往子进程 stdin 写 RPC 命令"封装为**与 child 同生命周期的对象**，作为写入维度的单一真相源。

```typescript
// src/execution/rpc-channel.ts (新增)
export class ChildRpcChannel {
  private dead = false;          // 单一真相源：通道是否已断
  readonly pid?: number;

  constructor(private readonly child: ChildProcess) {
    this.pid = child.pid;
    child.on("close", () => { this.dead = true; });
    child.on("error", () => { this.dead = true; });
    // 关键：吸收 stdin stream error，防止 uncaughtException
    child.stdin?.on("error", (err) => {
      this.dead = true;
      const code = (err as NodeJS.ErrnoException).code;
      console.warn(`[subagents] stdin ${code ?? "error"} on pid ${this.pid} (child likely dead)`);
    });
  }

  get isDead(): boolean { return this.dead; }

  /** 写一行 JSON。永不抛错（total function），成功返回 true。 */
  write(line: string): boolean {
    if (this.dead) return false;
    if (!this.child.stdin || this.child.stdin.destroyed) { this.dead = true; return false; }
    try {
      const ok = this.child.stdin.write(line + "\n");
      if (!ok) console.warn(`[subagents] stdin backpressure on pid ${this.pid}`);
      return true;
    } catch (err) {
      this.dead = true;
      const code = (err as NodeJS.ErrnoException).code;
      console.warn(`[subagents] stdin write failed on pid ${this.pid} (${code ?? "unknown"})`);
      return false;
    }
  }
}
```

**关键性质**：

- `write()` 是 **total function**（永不抛），返回 boolean
- `dead` 标志一旦置 true 永不复位（子进程死了不会复活）
- 'error' listener 在构造时挂上，**保证 stream error 一定被吸收**——根治 uncaughtException
- `dead` 标志同步置位（close/error 事件 + write catch 三路），写入前 `isDead` 检查原子可靠

### 错误边界分离

`handleUiRequest` 重构：try 只包不可信的 handler 代码，write 移出 try，catch 内不再二次 write。

```typescript
// try 只包 handler（业务逻辑可能抛）
let result: UiResponse;
try {
  result = await handler(uiReq);
} catch (err) {
  console.error("[subagents] uiRequestHandler threw:", err);
  result = { cancelled: true };
}
// write 移出 try：channel.write 永不抛
if (signal?.aborted || channel.isDead) return;
channel.write(serializeUiResponse(id, result));
```

序列化（含循环引用/BigInt 降级）提取为 `serializeUiResponse` 纯函数，内部 try/catch 兜底，返回字符串（永不抛）。

## 设计决策与取舍

### D1：write 永不抛 vs throw

**选永不抛、返回 boolean**。子进程死亡是 RPC 通道的**常态退出**，不是异常；调用方对写失败的合理反应是降级（cancel dialog / 记录失败），不是崩溃。若 throw，每个调用方都要 try/catch，等于回到当前局面。

代价：非 EPIPE 的真实 bug（如坏数据）会被 warn 吞掉。但 RPC 通道断了不管什么原因，父进程都不该死——诊断靠 warn 日志，不靠崩溃。

### D2：为什么不用 child.killed / child.stdin.destroyed 作存活判断

- `child.killed` 只在父进程主动 `child.kill()` 后才 true；子进程自己崩溃/OOM/正常退出时为 false → **不可用**
- `child.stdin.destroyed` 与底层 fd 关闭有时序窗口 → **不可靠**
- 必须自维护 `dead` 标志（close/error 事件 + write catch 三路同步置位）

### D3：错误边界分离 — handler 错误 vs write 错误

当前代码两类错误混在一个 try/catch。重构后职责清晰：

- **handler 错误**（用户代码/UI 层抛错）→ try/catch，降级为 cancelled response
- **write 错误**（通道故障）→ channel.write 本身不抛，返回 false

write 移出 try，catch 内不再 write，彻底消除"catch 内再抛"的结构缺陷。

### D4：签名迁移一次性完成

`respond` / `sendPromptCommand` / `sendGetStateCommand` 从 `(child: ChildProcess, ...)` 改为 `(channel: ChildRpcChannel, ...)`。生产调用点仅 5 处（ui-request-queue.ts ×3、session-runner.ts ×1、get-state-handshake.ts ×1），一次性迁移，避免中间状态 typecheck 失败。

### D5：所有 child stream error 必须有吸收点

不只 stdin。subagent 子进程的 stdout/stderr 也是 stream，缺 error listener 同样会 uncaughtException。原则：**所有 child stream 的 error 事件都必须有吸收点**。

- stdin → ChildRpcChannel 构造时挂
- stdout/stderr → session-runner.ts 已挂 data listener 处补 error listener

## 实施波次

波次间串行依赖（后波基于前波 commit），每波派独立 subagent 内部提交，每波结束 typecheck + 测试必须绿。

| Wave | 内容 | 文件 | 性质 |
|------|------|------|------|
| **W1** 止血 | `writeStdinLine` 加 try/catch（EPIPE 降级 warn）；session-runner spawn 后 `child.stdin?.on("error", ...)` 吸收 stream error | stdin-writer.ts, session-runner.ts | 立即防崩溃，可独立部署 |
| **W2** 通道抽象 + 迁移 | 新增 `rpc-channel.ts`；stdin-writer 三函数签名 child→channel，writeStdinLine 并入 `channel.write`；session-runner 构造 channel（移除 W1 ad-hoc listener）；ui-request-queue + get-state-handshake 调用迁移；现有测试适配 | rpc-channel.ts(新), stdin-writer.ts, session-runner.ts, ui-request-queue.ts, get-state-handshake.ts | 长期方案落地 |
| **W3** 错误边界分离 | handleUiRequest 重构（try 只包 handler，write 移出）；序列化提取为 `serializeUiResponse` 纯函数 | ui-request-queue.ts, stdin-writer.ts | 根除结构性缺陷 |
| **W4** stream error 全覆盖 | session-runner 补 child.stdout/stderr 的 error listener | session-runner.ts | 防御性加固 |
| **W5** 契约测试 | 新增 `rpc-channel.test.ts`（write 各错误路径、dead 标志、error listener 吸收）；扩展竞态场景（handler throw / child 在 await 期间退出） | `__tests__/rpc-channel.test.ts`(新), 扩展现有 | 防回归 |

**W1 与 W2 的关系**：W1 是纯止血（立即解决 EPIPE 崩溃，不必等重构）；W2 引入 ChildRpcChannel 后，W1 在 session-runner 加的 ad-hoc listener 由 channel 构造时统一挂载，W1 的 writeStdinLine try/catch 被 `channel.write` 吸收。W1 代码在 W2 被重构掉，这是有意的增量（先止血再重构）。

## 验证标准

1. **契约**：`ChildRpcChannel.write()` 在 child 已死、stdin destroyed、EPIPE、其他 error 四种情况下都返回 false 且不抛
2. **回归**：现有 stdin-writer.test.ts / ui-request-handler.test.ts / ask-user-transit-e2e.test.ts / run-spawn-integration.test.ts 全绿
3. **新增场景**：handleUiRequest 在 `await handler` 期间 child 退出 → 不抛、不写、handler 结果被丢弃
4. **不回归**：run-spawn-integration.test.ts 的 "stdin.destroyed → 不抛" 用例仍通过
5. **全量门控**：`pnpm --filter @zhushanwen/pi-subagent-workflow typecheck` + `pnpm --filter @zhushanwen/pi-subagent-workflow test` 绿

## 不在本次范围

- stdout/stderr 的 data 处理逻辑（仅补 error listener，不改解析）
- ui-request-queue 的 L2 dialog 队列逻辑
- 子进程 watchdog / 超时机制
- 其他 extension 的 child 进程处理（仅 subagent-workflow）
