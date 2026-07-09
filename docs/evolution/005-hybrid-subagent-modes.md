# 005: 混合 Subagent 模式（in-process + spawn）

> 状态：draft（决策前探索）
> 日期：2026-06-14
> 关联：ADR-025（in-process 决策）、ADR-027（L1+L2 持久化）

## 背景

ADR-025 将 agent 执行从 spawn 子进程改为 in-process `createAgentSession()`。这个决策对 coding agent 的主力场景（高频、短生命周期、需完整工具集）是正确的，但它有一个根本性短板：**运行中的 background agent 无法跨进程恢复（L3）**。

前面的分析得出结论：in-process 和 spawn **不是二选一，而是按 agent 配置选择**。本文档分析如何在不推翻 ADR-025 的前提下，引入 spawn 作为可选执行后端，形成混合模式。

## 目标

- in-process 保持默认（覆盖 90% 场景）
- 显式标记的 agent 可走 spawn（长跑任务、不可信代码、需跨重启恢复）
- 两种模式共享同一套 agent 定义、模型解析、配置体系
- 不引入维护两套代码的负担

## 两种模式的边界

| 维度 | in-process（默认） | spawn（可选） |
|------|------------------|--------------|
| 启动延迟 | 毫秒级 | 1-3s（重新加载 SDK） |
| 工具集 | 复用主进程全部工具 | 仅子进程 resourceLoader 加载的 |
| 上下文 | 可 fork 主 session、共享运行时对象 | 仅 task prompt 字符串 |
| 嵌套 subagent | 可行 | 不可靠 |
| 进程隔离 | 弱 | 强（崩溃不传染） |
| 跨进程恢复（L3） | **不可** | **可**（pid + jsonl） |
| steer/abort | 进程内直接调用 | 需 IPC 通道 |
| 适用场景 | coding 主力、工具密集、需快速响应 | 长跑后台、不可信代码、跨重启任务 |

## 设计：按 agent 配置分流

### 配置 schema 扩展

`AgentConfig.isolation` 当前只支持 `"worktree"`。扩展为联合类型：

```ts
// types.ts
export interface AgentConfig {
  // ... 既有字段 ...
  isolation?: "worktree" | "process";
}
```

- `undefined`（默认）→ in-process，原地运行
- `"worktree"` → in-process，但在 git worktree 副本中（既有实现）
- `"process"` → spawn 独立子进程

### 分流点

`run-agent.ts` 已有基于 `isolation` 的 worktree 分流（第 77-82 行）。spawn 分流加在同一位置：

```ts
// run-agent.ts（伪代码，示意分流结构）
if (agentConfig?.isolation === "process") {
  return runAgentViaSpawn(opts, ctx);  // 新后端
}
// 既有 in-process 逻辑（含 worktree 分流）...
```

分流在 `buildContext()` 之后、`createAndConfigureSession()` 之前，保证模型解析、agent 发现、并发控制等共用逻辑不被绕过。

## spawn 后端的最小实现边界

参考第三方 `pi-subagents` 的 `async-execution.ts` + `pi-spawn.ts`，spawn 后端需要以下组件：

### 1. 进程启动（`spawn-runner.ts`）

```ts
import { spawn } from "node:child_process";

// 核心调用
const proc = spawn(process.execPath, [piCliPath, runnerScript, configPath], {
  cwd: ctx.cwd,
  detached: true,    // 关键：脱离父进程，父进程死后子进程存活
  stdio: ["pipe", "pipe", "pipe"],
});
proc.unref();  // 不阻止父进程退出
```

**关键点**：
- `detached: true` + `unref()` 让子进程独立于主 Pi 进程存活
- 主进程重启后，子进程仍在跑，可通过 pid 追踪状态
- 通信通过 jsonl 文件（非 stdout），避免管道断开丢失数据

### 2. 配置传递（jsonl 握手，非命令行参数）

task prompt、agent 配置、模型等通过临时 jsonl 文件传递（避免命令行长度限制 + 敏感信息不暴露在进程列表）：

```ts
const configPath = path.join(runDir, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  task: opts.task,
  agent: opts.agent,
  model: resolved.model,
  thinkingLevel: resolved.thinkingLevel,
  cwd: ctx.cwd,
  // ... 其他配置
}));
```

### 3. 子进程入口（`spawn-child.ts`）

子进程的入口脚本，读取 config.json，调用 in-process 的 `runAgent`（复用既有逻辑），把结果写入 result.jsonl：

```ts
// spawn-child.ts（子进程内运行）
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const { runAgent } = await import("@mariozechner/pi-coding-agent");
// 复用 session-factory 的 createAndConfigureSession
const result = await runAgent(config);
fs.writeFileSync(resultPath, JSON.stringify(result));
```

**关键决策**：子进程入口复用 `session-factory.ts` 的 `createAndConfigureSession`，而非重新实现。这样工具过滤、event-bridge、session 落盘（L2）等逻辑只需维护一份。

### 4. pid + 状态追踪（`spawn-tracker.ts`）

```ts
interface SpawnRecord {
  pid: number;
  agentId: string;      // "spawn-N"
  agent: string;
  startedAt: number;
  configPath: string;
  resultPath: string;
  status: "running" | "done" | "failed" | "crashed";
}
```

- pid 写入 `~/.pi/agent/subagents/<encoded-cwd>/spawn/<agentId>.json`
- 主进程重启后，扫描该目录，用 `process.kill(pid, 0)` 探活
- pid 不存在 → status 改 "crashed"，读取已写入的 result.jsonl 判断是否部分完成

### 5. 跨进程恢复（L3 核心）

这是 spawn 模式相对于 in-process 的唯一不可替代能力。恢复流程：

```
主进程启动 → session_start
  → 扫描 spawn/ 目录
  → 对每个 SpawnRecord：
      - process.kill(pid, 0) 成功 → 仍 running，纳入 runtime._spawnRecords
      - 失败 → 读 result.jsonl
          - 存在且完整 → status=done
          - 不存在 → status=crashed
```

恢复后，`/subagents list` 能看到跨重启的 spawn agent，`backgroundId` 轮询能拿到结果。

## 与 in-process 后端的代码复用

| 组件 | in-process | spawn | 复用方式 |
|------|-----------|-------|---------|
| 模型解析（resolveModelForAgent） | ✅ | ✅ | 完全复用 |
| agent 发现（AgentRegistry） | ✅ | ✅ | 完全复用 |
| 工具过滤（filterTools） | ✅ | ✅ | 子进程内复用 |
| session 创建（createAndConfigureSession） | ✅ | ✅ | 子进程内复用 |
| event-bridge | ✅ | ❌ | spawn 用 jsonl 替代 |
| 并发池（ConcurrencyPool） | ✅ | ❌ | spawn 进程隔离，不需池 |
| widget 实时状态 | ✅ | 部分 | spawn 通过 pid 轮询模拟 |
| L1 history 持久化 | ✅ | ✅ | 子进程完成后写同一 history.jsonl |
| L2 session 落盘 | ✅ | ✅ | 子进程内 SessionManager.create |

**复用率约 70%**。增量代码集中在进程启动、pid 追踪、jsonl 通信、恢复扫描。

## 两种模式的 AgentResult 统一

spawn 后端完成后，需把子进程产出的结果转换回 `AgentResult`（与 in-process 一致）：

```ts
// spawn-backend.ts
async function collectSpawnResult(record: SpawnRecord): Promise<AgentResult> {
  const raw = JSON.parse(fs.readFileSync(record.resultPath, "utf-8"));
  return {
    text: raw.text,
    turns: raw.turns,
    durationMs: raw.durationMs,
    success: raw.success,
    error: raw.error,
    sessionId: raw.sessionId,
    sessionFile: raw.sessionFile,  // 子进程落盘的 session 文件
    toolCalls: raw.toolCalls,
  };
}
```

子进程的 session 文件（L2）也写入同一 `~/.pi/agent/subagents/<encoded-cwd>/sessions/`，与 in-process 模式共享查看入口。

## 配置示例

agent 定义文件 `~/.pi/agent/agents/long-runner.md`：

```markdown
---
name: long-runner
model: router-openai/glm-5.1
isolation: process
description: 长跑后台任务（索引构建、批量处理），支持跨重启恢复
---

You are a long-running task executor...
```

使用时与普通 agent 无区别：

```ts
// 主 agent 调用（LLM 无感知差异）
const result = await runtime.runAgent({
  task: "索引整个 monorepo 的调用关系",
  agent: "long-runner",
});
```

`runtime.runAgent` 内部根据 `agentConfig.isolation === "process"` 分流到 spawn 后端，调用方无感知。

## 实现路径（建议分阶段）

### 阶段 1：spawn 后端骨架（不接 L3 恢复）

- `spawn-runner.ts`：进程启动 + detached
- `spawn-child.ts`：子进程入口，复用 createAndConfigureSession
- `spawn-backend.ts`：runAgentViaSpawn，产出 AgentResult
- AgentConfig.isolation 扩展为 `"worktree" | "process"`
- run-agent.ts 分流

**验证**：agent 标记 `isolation: process` 后能跑通，结果正确，session 文件落盘。

### 阶段 2：L3 恢复

- `spawn-tracker.ts`：pid 持久化到 jsonl
- `runtime.restoreSpawnRecords()`：session_start 扫描恢复
- `/subagents list` 合并 spawn records（第五个数据源）
- `backgroundId` 轮询支持 spawn agent

**验证**：启动 spawn agent → kill 主 Pi → 重启 → `/subagents list` 看到 running → 完成后拿到结果。

### 阶段 3：工具隔离确认

- 文档化 spawn agent 的工具限制（子进程只看 resourceLoader 加载的）
- 提供 `agentConfig.spawnTools` 显式声明子进程可用工具
- 测试扩展工具/MCP 在 spawn 模式下的可用性

## 决策点（需用户确认）

1. **是否实现 L3？** L3 是 spawn 模式的核心价值。如果不需要跨进程恢复，spawn 相比 in-process 的优势只剩进程隔离（崩溃不传染）+ 资源隔离（CPU/内存独立）。这两个能力对 coding agent 场景价值有限——可改用 worktree 隔离 + 限制 maxTurns 实现"防失控"，不必引入 spawn。

2. **spawn 后端是否纳入 @zhushanwen/pi-subagents？** 还是作为独立扩展？纳入则增加 ~500 行代码 + 进程管理复杂度；独立则保持 subagents 包聚焦 in-process。

3. **是否参考第三方 pi-subagents 的实现？** 它的 `async-execution.ts` + `stale-run-reconciler.ts` 已解决了 pid 追踪、孤儿进程清理、stale 检测等问题。可以 fork 其 spawn 相关模块作为起点，而非从零实现。

## 反模式警告

- **不要让 spawn 成为默认**。spawn 的启动延迟（1-3s）对高频 coding 任务是灾难。默认必须是 in-process。
- **不要在 spawn 子进程内加载主进程的全部扩展**。子进程应该最小化加载（只加载 agent 需要的工具），否则失去进程隔离的意义。
- **不要用 stdout 通信**。stdout 在父进程崩溃时数据丢失。必须用 jsonl 文件持久化中间结果。
- **不要省略 pid 探活的边界情况**。pid 会被操作系统复用——`process.kill(pid, 0)` 成功不代表还是原来的子进程。需配合 startTime + command line 校验。

## 结论

混合模式在架构上是 in-process 的自然扩展，不与 ADR-025 冲突。分阶段实现（先骨架后 L3）能控制复杂度。但**是否值得做的关键在于 L3 的实际需求频率**——如果"跨重启恢复运行中的 subagent"是真实痛点，则值得投入；如果只是理论能力，in-process + L1/L2 持久化已经覆盖绝大多数场景。

建议：先完成 in-process 路线的 L1/L2（已由 ADR-027 完成），观察实际使用中是否频繁遇到"希望 background agent 跨重启存活"的场景。若确认是真实需求，再启动 spawn 后端实现。
