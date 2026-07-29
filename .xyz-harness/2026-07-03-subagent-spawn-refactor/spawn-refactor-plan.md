# Subagent 执行模型改造：in-process → spawn

> 架构级改造 plan。不走 lite-plan（范围守门 5 条全中，非 lite）；不走完整 design 6 阶段（本 session 已完成需求澄清 + 源端/目标端架构建摸）。直接产出聚焦改造 plan。

## 1. 背景（为什么换）

- **空白行 bug**：3 轮渲染层实验全部失败（Step1 renderCall 多行 / Step2 布局对齐 / Step3 数据源 displayItems 对齐 nicobailon）。渲染层已彻底排除。
- nicobailon（spawn）在同一 pi 0.80.2 环境无此问题 → 根因在执行模型：in-process 模式下 subagent 的 tool 调用在父 pi 进程内执行，干扰父 session 的 ToolExecutionComponent 渲染状态机（contentBox 在 isPartial 期间的 diff/ghost）。
- **spawn 本身是长期更对的架构**，与本次 bug 无关也应做：进程隔离（subagent 崩溃不拖垮父）、对齐官方示例、消除整类 in-process 干扰、并发/资源隔离更干净。

## 2. 架构决策

| # | 决策 | 依据 |
|---|------|------|
| AD-1 | spawn `pi --mode json`，**不开** `--no-session` | 已确认 `--mode` 与 `--no-session` 是独立 flag（`cli/args.ts`） |
| AD-2 | **保留 session 持久化** | 不丢 background 崩溃恢复 + `/subagents list` 历史 + session 重建 |
| AD-3 | stdout JSON 事件流 = in-process subscribe 的同源事件 | `modes/print-mode.ts:106` 每个 event `JSON.stringify(event)\n`；header 行含 session 文件路径（:115） |
| AD-4 | 事件翻译层（handleSdkEvent）+ 累积层（updateFromEvent）**原样复用** | 事件 schema 同源，只换传输介质（stdout 替代 in-process callback） |

## 3. Keep / Replace / New（文件级）

**Keep（零改动）：**
- `core/execution-record.ts` — ExecutionRecord + updateFromEvent + getEventLog + getDisplayItems + collectResult（累积目标不变）
- `tui/*` — 渲染层（Step3 的 displayItems + formatToolCall 直接对接）
- `core/agent-registry.ts`、`core/model-resolver.ts`
- `runtime/execution/*` — worktree-manager、concurrency-pool、notifier、record-store、alive/finalized/tombstone stores

**Replace：**
- `core/session-runner.ts` 的 `run()`（L514-749）→ `runSpawn()`：构造 args + spawn + pump stdout → adapter → updateFromEvent + abort/exit/超时
- `subagent-service.ts` `runAndFinalize`：调用点从 `run()` 切到 `runSpawn()`，删除 getSdk/forkSessionFrom 依赖

**New：**
- `core/pi-invocation.ts` — `getPiInvocation(args)`：定位 pi 二进制（照搬 nicobailon，处理 bun/$bunfs、node/bun generic runtime、pi-in-PATH 三分支）
- `core/spawn-event-adapter.ts` — stdout JSON line → SdkEvent/AgentEvent：薄适配层，复用现有 handleSdkEvent switch 逻辑；额外解析 header 行提取 sessionFile
- `core/temp-prompt.ts` — `writePromptToTempFile`（照搬 nicobailon，--append-system-prompt 需文件路径）

**Delete：**
- `core/session-runner.ts` 内 session-factory 合并段（getSdk/createAndConfigureSession/forkSessionFrom/subscribe/dispose）—— in-process SDK 编排整体废弃

## 4. 关键张力与取舍

| 张力 | 决策 | 理由 |
|------|------|------|
| 持久化 vs `--no-session` | **保留持久化**（AD-2）| 恢复 + 历史不能丢 |
| fork 继承父上下文 | **完整保留**：spawn 加 `--fork <mainSessionFile>` + 环境变量 `PI_SUBAGENT_FORK_DEPTH` 传 depth 基线 | pi CLI `--fork` 接受 path（`resolveSessionPath`→`forkSessionOrExit`）；depth 护栏在父进程 spawn 前经 `resolveSessionContext` 检查，原样复用 |
| schema steer 循环 | **改为 task 内 MANDATORY 指令**（对齐 nicobailon formatSchemaInstruction）| spawn 无 steer 通道；structured-output tool 在子进程仍可用 |
| maxTurns/graceTurns | **事件层计数 turn_end + kill 进程**实现 | pi CLI **无** `--max-turns` flag（已验证）；spawn-event-adapter 计 turn_end，超限 `proc.kill("SIGTERM")`，保留 turn-limiter 语义 |
| turn-limiter steer/abort | abort=`proc.kill`；steer 删除 | spawn 模型无 steer；abort 通过信号 |

## 5. Wave 拆分（垂直切片）

| Wave | 内容 | blocked_by | 可并行 |
|------|------|-----------|--------|
| **W1 基座** | `pi-invocation.ts` + `temp-prompt.ts` + `spawn-event-adapter.ts`（纯函数 + stdout 解析，独立单测，不接 runtime） | — | W1 内三文件无依赖，可并行 |
| **W2 执行器** | `runSpawn()` + turn-count-kill maxTurns + 接 subagent-service 替换 run() 调用 | W1 | — |
| **W3 外围适配** | 删 session-factory 段、schema 改指令注入、turn-limiter 退化（kill-based）、fork 完整保留（`--fork` + env depth） | W2 | — |
| **W4 验收清理** | 删死代码、typecheck、现有测试适配、**实跑验证空行消失 + background 恢复 + list 历史 + structured-output 回归** | W3 | — |

## 6. 验收标准

- ✅ **空行消失**：用户实跑 sync subagent，对比改造前后（核心目标）
- ✅ background 模式仍可崩溃恢复（alive/finalized/tombstone 流程不变）
- ✅ `/subagents list` 仍显示历史（session.jsonl 持久化保留）
- ✅ sync subagent 功能等价：read/bash/edit/structured-output 正常
- ✅ maxTurns 仍生效（事件计数 + kill）
- ✅ typecheck 通过 + 现有测试适配（session-runner/session-factory 测试重写为 spawn 版）

## 7. 风险

| 风险 | 缓解 |
|------|------|
| stdout JSON 事件 schema 与 in-process 不完全一致 | W1 单测对照真实 `pi --mode json` 输出（抓一份 fixture） |
| header 行 sessionFile 解析失败 → 持久化恢复断 | 回退：spawn 完成后从 sessions dir 按 startedAt+agent 匹配 |
| 子进程崩溃/被 kill 的 stderr/exitCode 路径 | spawn-event-adapter 捕获 close(code)+stderr，映射为 AgentResult.error |
| fork depth 跨进程传递 | 环境变量 `PI_SUBAGENT_FORK_DEPTH=<effectiveDepth>`；子进程 subagents 扩展初始化 forkDepthAls 时读取此变量作为基线 |
| `proc.kill` 在 Windows 的信号差异 | 首期 macOS/Linux 优先；Windows 用 taskkill 兜底（后续） |

## 实现步骤

1. **W1**：新建 `pi-invocation.ts`/`temp-prompt.ts`/`spawn-event-adapter.ts`，各写单测（invocation 三分支、stdout JSON 解析含 header、错误行容忍）
2. **W2**：实现 `runSpawn()`（spawn + pump + turn-count-kill + collectResult），改 `subagent-service.runAndFinalize` 调用点，单测 mock spawn
3. **W3**：删 session-factory 段 + getSdk import；schema 指令注入 task；turn-limiter 改 kill；fork 完整保留（spawn `--fork <mainSessionFile>` + env `PI_SUBAGENT_FORK_DEPTH` + 子进程初始化读取）
4. **W4**：删死代码、typecheck、适配/重写 session-runner & session-factory 测试为 spawn 版、用户实跑验收四项
