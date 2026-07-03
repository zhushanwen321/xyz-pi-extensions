# Subagents spawn 迁移 — 待跟进项

> 来源：`feat-subagent-fork-worktree` 分支 code review（PR #75）
> 原则：完成一项删一项，全部清空后删除本文件。

---

## M1 方案 B：切换到 pi `--mode rpc` 恢复运行时 steer

### 背景

spawn 迁移后，`runSpawn` 用 `pi --mode json`（single-shot 模式）启动子进程。该模式发完 prompt 即退出，`stdio: ["ignore","pipe","pipe"]`，**无 stdin 命令通道**。

后果：`turnLimiter` 的 `steer` 回调是 no-op（`session-runner.ts:342`）。in-process 模式下，达 `maxTurns` soft limit 时会通过 `session.steer(WRAP_UP_MESSAGE)` 注入收尾提醒（让 agent 诚实总结已完成/未完成/下一步）。spawn 模式下此能力丢失。

### 当前补偿（方案 A，已落地）

启动时通过 `--append-system-prompt` 预置 `WRAP_UP_HINT`（`turn-limiter.ts` 导出，`session-runner.ts` appendParts 追加）。这是预防性提醒，语义弱于原来的精确时点提醒——agent 可能过早或过晚收尾，无法表达"已到 maxTurns"这个精确时点。

### 长期方案（方案 B）

切换到 `pi --mode rpc`：

- **RPC mode 支持运行时注入**：stdin 持续读 JSON-RPC 命令，含 `steer`/`prompt`/`follow_up`/`abort`（pi-mono `modes/rpc/rpc-mode.ts:385-672`，steer 在 L414）。
- **pi 自带 `RpcClient`**（`modes/rpc/rpc-client.ts`）：封装了 `start()`/`steer()`/`abort()`/`onEvent()`，用 `stdio:["pipe","pipe","pipe"]` spawn `pi --mode rpc`——可参考或复用。
- **事件流同源**：RPC mode 输出也是 `session.subscribe((event) => output(event))`，与 json mode 同一事件源/序列化。subagents 的 `parseSpawnLine`/`handleSdkEvent` 累积逻辑可原样复用。

### 改造点

1. **session id 推导**：RPC mode **不在首行写 `{type:"session"}` header**（json mode 在 `print-mode.ts:112-117` 写）。subagents 当前依赖 header 推导 `sessionFile`/alive marker/identity append。需改用 RPC `get_state` 命令拿 session id。
2. **stdin 管理**：`runSpawn` 的 `stdio` 从 `["ignore","pipe","pipe"]` 改为 `["pipe","pipe","pipe"]`，维护 JSON-RPC 帧写入。
3. **steer 恢复**：`turnLimiter.steer` 回调改为 `rpcClient.steer(WRAP_UP_MESSAGE)`，恢复精确的 turn_end 注入语义。
4. **schema enforcement steer**：旧 in-process 模式还有 schema enforcement steer（漏调 structured-output 时提醒），spawn 后改为 task 内 MANDATORY 指令（`formatSchemaInstruction`）。切 RPC 后可恢复 steer 路径（可选）。

### 验证点

- `get_state` 返回的 state 是否含足够字段还原 `deriveSessionFilePath` 所需的 `id`+`timestamp`+`cwd`（未深入验证）。
- RPC mode 的 shutdown 语义与 subagents 的 dispose/abort 路径兼容性。

### 紧迫性

不阻塞合并。方案 A 已提供预防性补偿，工具描述已诚实告知 LLM "no graceful wrap-up"。方案 B 的核心价值是恢复精确时点的收尾总结，对长任务 / 高 maxTurns 场景的可恢复性有实际意义。

---

## N2：cancel CAS / dispose flush 编排覆盖无归属

`execute-integration.test.ts`（已删）原有 12 用例覆盖 cancel CAS、dispose flush、onUpdate 回流等编排路径。删除后部分场景迁移到 `execute-nesting.test.ts`，但 cancel CAS / dispose flush 的编排覆盖在 spawn 模型下可能仍有空洞。

- **调查**：确认 `execute-nesting.test.ts` + `run-spawn-integration.test.ts` 是否已覆盖 cancel CAS（signal abort → child.kill → finalizeRecord）和 dispose flush（dispose → abortRunningControllers → 所有 bg controller abort）。
- **补缺**：如发现空洞，在 `run-spawn-integration.test.ts` 或 `subagent-service.test.ts` 补用例。
