# 03 — TUI/GUI/Headless 三模式 subagent 启动分流设计

> Topic: cw-2026-07-17-subagent-ask-user（feat-ask-user-time-limit 分支）
> 边界：subagent 启动模式分流架构（buildSpawnArgs / spawn stdio / W4 提示词 mode 守卫 / mode 穿透链路）。
> 不含：uiRequestHandler 业务实现（归 02）、协议格式（归 01）。

---

## 〇、前提勘误：用户任务描述中的技术不可行项

在进入设计前，必须先澄清三个技术现实——它们直接推翻任务描述里「TUI 模式用 `--mode tui` + stdio=inherit」的前提。

### E1：`--mode tui` 不是合法 CLI 值

Pi CLI 参数解析（`pi-mono/main/packages/coding-agent/src/cli/args.ts:80-84`）：

```ts
} else if (arg === "--mode" && i + 1 < args.length) {
    const mode = args[++i];
    if (mode === "text" || mode === "json" || mode === "rpc") {
        result.mode = mode;
    }
}
```

只接受 `text|json|rpc`。传 `--mode tui` 时 `tui` 不在白名单，**被静默忽略**（不设 `result.mode`，不报错）。后续 `resolveAppMode`（`main.ts:100-111`）见 `parsed.mode === undefined`，再判 stdin/stdout 是否 TTY。

**结论**：无法通过 `--mode tui` 让子进程进 TUI 模式。

### E2：TUI（interactive）模式触发条件 + 父子终端冲突

`resolveAppMode`（`main.ts:100-111`）：

```ts
function resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY): AppMode {
    if (parsed.mode === "rpc") return "rpc";
    if (parsed.mode === "json") return "json";
    if (parsed.print || !stdinIsTTY || !stdoutIsTTY) return "print";
    return "interactive";  // TUI
}
```

要让子进程进 `interactive`（TUI），需同时满足：不传 `--mode`、不传 `-p`、**子进程 stdin/stdout 都是 TTY**。后者只有 `stdio: "inherit"` 能做到（继承父进程的 TTY fd）。

**但父子 TUI 会抢终端**。InteractiveMode 启动时（`interactive-mode.ts`）：
- `process.stdin.setRawMode(true)` — 字符级输入
- alternate screen buffer（`\x1b[?1049h`）
- 持续 read stdin + write stdout 渲染帧

父 TUI 已在 raw mode + alternate screen 跑渲染循环。子进程 `stdio: "inherit"` 后：
- 父子共享同一对 stdin/stdout fd
- 子进程 `setRawMode(true)` 是幂等 noop（已是 raw），但两个进程都注册了 stdin data listener → **stdin 字节流被随机分配**（OS 调度决定哪个 read 先返回）
- 两个进程交替 write stdout → **画面交替闪烁/覆盖**
- alternate screen enter/leave 交叉 → 终端状态机错乱

实测可复现：任何「父 TUI 内 spawn 子进程 + stdio inherit + 子进程也进 InteractiveMode」的组合都会卡死终端。Pi 没有任何机制协调父子 TUI 的终端所有权。

### E3：Pi 的 suspend 机制不能用于「父挂起 + spawn 子进程」

`interactive-mode.ts:3525-3553` 的 `handleCtrlZ`：

```ts
private handleCtrlZ(): void {
    // ...
    this.ui.stop();                    // 停 TUI，恢复终端 normal mode
    process.kill(0, "SIGTSTP");        // 把整个进程组挂起到后台（shell job control）
    // SIGCONT 时 this.ui.start() 恢复
}
```

这是 **shell job control 语义**（SIGTSTP → shell 把进程组放到后台 → 用户手动 `fg` → SIGCONT）。它把**整个进程组**（含父 Pi）挂起——挂起状态下父进程无法 spawn 任何子进程。这是为「用户手动 Ctrl+Z 暂停 Pi 去跑其他 shell 命令」设计的，**不是编程式的「父 TUI 让出终端给子进程」**。

要让「父 TUI stop → spawn 子 TUI → 子退出 → 父 TUI resume」工作，需要 Pi 暴露：
- 编程式 `suspendRender()` / `resumeRender()` API（分离「停渲染」和「挂起进程」）
- 子进程退出回调里自动 resume

**Pi 当前没有这两个 API**（`InteractiveMode` 未导出 suspend/resume 的编程式接口，只有 action handler）。这是 Pi 核心改造，超出 subagent-workflow 扩展能力。

### 勘误小结

| 任务描述的前提 | 技术现实 | 影响 |
|---|---|---|
| subagent 用 `--mode tui` | `--mode tui` 被静默忽略（args.ts 白名单无 tui） | 不能用 `--mode tui` 触发子进程 TUI |
| stdio=inherit 让 subagent 自己渲染 ask_user | 父子 TUI 抢终端（raw mode + alternate screen 冲突） | 子进程不能跑 InteractiveMode |
| Pi suspend 机制可协调父子 TUI | suspend 依赖 SIGTSTP（shell job control），挂起整个进程组 | 不能编程式「父让出终端给子」 |

**本文档的修复方案不基于上述不可行前提**，而是给出当前 Pi 能力下的可行设计，并标注长期方向（需 Pi 核心改造）。

---

## 一、问题分析（直接引用 line 号）

### 问题 1：buildSpawnArgs 硬编码 `--mode rpc`，无 mode 参数

`session-runner.ts:331-361` `buildSpawnArgs`：

```ts
export function buildSpawnArgs(
  params: {
    model: string | undefined;
    thinkingLevel: string | undefined;
    // ... 无 mode 字段
    sessionDir: string;
    forkSource: string | undefined;
    skillPaths: string[] | undefined;
  },
  task: string,
): string[] {
  const args: string[] = ["--mode", "rpc", "-p", "--session-dir", params.sessionDir];
  //                                                  ^^^^^^^^^^^^^^ 硬编码 rpc
```

所有 subagent 都用 `--mode rpc`。调用点 `runSpawn:744-757`：

```ts
const spawnArgs = buildSpawnArgs(
  {
    model: `${opts.resolved.model.provider}/${modelId}`,
    thinkingLevel: opts.resolved.thinkingLevel,
    agentTools: opts.agentConfig?.tools,
    appendSystemPromptPath: tempPromptFile?.filePath,
    sessionDir,
    forkSource,
    skillPaths: skillPaths.length > 0 ? skillPaths : undefined,
    // ... 无 mode 传入
  },
  fullTask,
);
```

`runSpawn` 不持有 `ctx.mode`（SessionRunnerContext 无 mode 字段，见 `:188-205`），无法按父进程模式分流。

### 问题 2：spawn stdio 全 pipe，无 mode 分支

`session-runner.ts:755-760`：

```ts
const child = spawn(invocation.command, invocation.args, {
  cwd: spawnCwd,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],   // 硬编码全 pipe
  env: childEnv,
});
```

全 pipe 是 RPC/json mode 的正确选择（父进程需要接管 stdout 解析 JSON 流 + stdin 回写 RPC response）。但 stdio 选择没有按 mode 分支的代码路径——当前是「one size fits all」。

### 问题 3：W4 提示词注入无 mode 守卫

`session-runner.ts:706-708`：

```ts
// W4: ask_user RPC 使用指引
if (opts.agentConfig?.tools?.includes("ask_user")) {
  appendParts.push(ASK_USER_RPC_PROMPT);
}
```

注入条件只看 `agentConfig.tools` 是否含 `ask_user`，**不看父进程 mode**。后果：

| 父进程 mode | 子进程 ask_user 配置 | 当前行为 | 问题 |
|---|---|---|---|
| `rpc`（xyz-agent GUI） | 有 | 注入 RPC 文案 | ✅ 正确（GUI 会响应） |
| `tui`（纯 Pi TUI） | 有 | 注入 RPC 文案 | ⚠️ 文案说「转发到主 agent UI」——TUI 下 uiRequestHandler 是否注入取决于 02 的实现（当前 02 假设 TUI 不注入 → 子进程超时降级，但文案告诉 LLM「用户会回答」→ 误导） |
| `json` / `print`（headless） | 有 | 注入 RPC 文案 | ❌ 文案说「用户会回答」，实际 uiRequestHandler=undefined（02 D4）→ 子进程超时降级，LLM 俊等 |

### 问题 4：mode 无法穿透到 runSpawn

调用链（`subagent-tool.ts:316` → `subagent-actions.ts:146` → `subagent-service.ts:execute` → `runAndFinalize:552` → `runSpawn:631`）：

- `executeSubagent` 收到 `_ctx: ExtensionContext`（含 `ctx.mode`），但只透传 `_ctx?.model`（`subagent-tool.ts:316`），**丢弃 `ctx.mode`**
- `SubagentServiceSessionInit`（02 已规划加 `mode?: ExtensionMode`）→ `this.sessionMode`（02 已规划）
- `buildSessionRunnerContext`（`:962-975`）构造的 ctx **不含 mode**：

```ts
private buildSessionRunnerContext(overrideCwd?: string): SessionRunnerContext {
  return {
    cwd: overrideCwd ?? this.cwd,
    agentDir: this.modelService.getAgentDir(),
    skillDirs: [],
    mainCwd: this.cwd,
    mainSessionFile: this.getMainSessionFile?.() ?? undefined,
    onWorktreePid: (branch, pid) => this.worktreeManager.registerPid(branch, pid),
    uiRequestHandler: this.uiRequestHandler,
    // ... 无 mode
  };
}
```

`runSpawn` 签名 `(record, task, opts: RunOptions, ctx: SessionRunnerContext)` — `RunOptions` 和 `SessionRunnerContext` 都无 mode。

---

## 二、修复方案

### 2.1 mode 分流决策表（重新定义：spawn 策略 vs handler 策略 vs 提示词策略）

勘误后，mode 分流**不在 spawn args 层**（所有 mode 都走 `--mode rpc` + 全 pipe，因 E1/E2/E3），而在 **handler 注入层**（归 02）和 **W4 提示词层**（本设计）。mode 参数仍需穿透到 runSpawn，供 W4 守卫消费 + 未来扩展预留。

| 父进程 `ctx.mode` | 子进程 `--mode` | 子进程 stdio | uiRequestHandler（02 负责） | W4 提示词（本设计） | 用户可见行为 |
|---|---|---|---|---|---|
| `tui`（纯 Pi TUI） | `rpc` | `[pipe,pipe,pipe]` | **TUI 渲染 handler**（调 `ctx.ui.custom` 复用 AskUserComponent）⚠️ 见 2.6 | 注入 `ASK_USER_RPC_PROMPT` | 子进程 ask_user → 父 TUI 弹 ask_user 组件 → 用户回答 → 答案回写子进程 |
| `rpc`（xyz-agent GUI） | `rpc` | `[pipe,pipe,pipe]` | sidecar 转发 handler（02 负责） | 注入 `ASK_USER_RPC_PROMPT` | 子进程 ask_user → sidecar → GUI AskUserOverlay → 用户回答 |
| `json` / `print`（headless） | `rpc` | `[ignore,pipe,pipe]` ⚠️ 见 2.4 | undefined（02 D4） | **不注入** | 子进程 ask_user → 超时降级（disableAskUser） |
| `undefined`（边界） | `rpc` | `[pipe,pipe,pipe]` | undefined | **不注入**（保守） | 同 headless |

**关键结论**：
- **spawn args 层无分流**——所有 mode 都用 `--mode rpc`。`buildSpawnArgs` 的 `--mode` 仍是硬编码 `"rpc"`。
- **stdio 层仅一处微调**：headless（json/print）的 stdin 改为 `ignore`（子进程不会收到 RPC response，无需 pipe）。其余保持全 pipe。
- **mode 参数穿透的意义**：供 W4 守卫判断「父进程是否会响应 ask_user」+ headless 的 stdio 选择 + 未来 Pi 支持子进程 TUI 后的扩展点。

### 2.2 buildSpawnArgs：保留硬编码 `--mode rpc`，不加 mode 参数

**决策**：`buildSpawnArgs` 的 `--mode` 保持硬编码 `"rpc"`，**不新增 mode 参数**。

理由：
1. 当前所有 mode 都映射到 `--mode rpc`（E1/E2/E3 证明不能让子进程跑 TUI/json）。
2. 加一个 `params.mode` 字段但所有分支都返回相同的 `["--mode", "rpc", ...]`，是 dead parameter——误导读者以为有分流，实际没有。
3. 未来若 Pi 支持子进程 TUI 接管终端（长期方案，见六），届时再加 mode 参数 + 分支，有真实消费点。

**唯一调整**：headless 模式的 stdin 从 `pipe` 改为 `ignore`（见 2.4），但这在 `runSpawn` 的 spawn 调用处决策，不在 `buildSpawnArgs`。

### 2.3 spawn stdio 选择：按 mode 分支（仅 headless 特殊处理）

`runSpawn` 内 spawn 调用（`:755`）改为按 `ctx.mode` 选 stdio：

```ts
// headless（json/print）：子进程不会收到任何 RPC response（父进程无 handler），
//   stdin 用 ignore 避免子进程 stdin read 阻塞（pipe 但不写 = 子进程 read 挂起）。
// tui/rpc/undefined：全 pipe（父进程需要 stdin 回写 UI response + stdout 解析 JSON 流）。
const isHeadless = ctx.mode === "json" || ctx.mode === "print";
const stdioConfig = isHeadless
  ? ["ignore", "pipe", "pipe"] as const
  : ["pipe", "pipe", "pipe"] as const;

const child = spawn(invocation.command, invocation.args, {
  cwd: spawnCwd,
  shell: false,
  stdio: stdioConfig,
  env: childEnv,
});
```

**为什么 headless 用 `ignore` 而非 `pipe`**：
- 当前 `["pipe", "pipe", "pipe"]` 下，父进程创建了 stdin pipe 但从不写入（`handleUiRequest` 在 handler=undefined 时直接 return，不写 stdin）。
- 子进程的 rpc-mode.ts `attachJsonlLineReader(process.stdin, ...)` 持续 read stdin。pipe 对端有写句柄（父进程持有）但永不写 → 子进程 read 阻塞但不报错（不是 EOF）。
- 改 `ignore`（`/dev/null`）后，子进程 read 立即收到 EOF → rpc-mode 的 `process.stdin.on("end", ...)` 触发 shutdown。这更符合 headless 语义（一次性执行，无交互）。
- **风险**：若 headless 下子进程的 rpc-mode 在 stdin EOF 时立即退出，可能打断正在执行的 task。需验证（见风险 R2）。

**为什么 tui/rpc 保持全 pipe**：
- rpc（GUI）：父进程 sidecar handler 需要回写 UI response，stdin 必须 pipe。
- tui：父进程 TUI handler（02 实现）需要回写 UI response，stdin 必须 pipe。

### 2.4 W4 提示词 mode 守卫

`session-runner.ts:706-708` 改为：

```ts
// W4: ask_user 使用指引——仅当父进程会响应 ask_user 时注入。
//   tui/rpc：父进程有 uiRequestHandler（02 注入），ask_user 会得到响应。
//   json/print/undefined：父进程无 handler，ask_user 超时降级，注入文案反而误导 LLM 俊等。
const parentWillRespond = ctx.mode === "tui" || ctx.mode === "rpc";
if (opts.agentConfig?.tools?.includes("ask_user") && parentWillRespond) {
  appendParts.push(ASK_USER_RPC_PROMPT);
}
```

**为什么不需要 ASK_USER_TUI_PROMPT 新文案**：

任务描述要求「TUI 注入 ASK_USER_TUI_PROMPT（子 agent 自己的 TUI 渲染），RPC 注入 ASK_USER_RPC_PROMPT（RPC 转发）」。但根据 E2（子进程不能自己渲染 TUI），**TUI 模式下子进程仍是 `--mode rpc`**，子进程的 ask_user 走 `runRpcInteraction`（`ctx.ui.select` → extension_ui_request → 父进程）。

从**子进程 LLM 的视角**，tui 和 rpc 没有区别：
- 子进程都是 `--mode rpc`
- ask_user 都是 `ctx.ui.select` → extension_ui_request 到父进程
- 父进程如何呈现（TUI 组件 vs GUI overlay）对子进程不可见

`ASK_USER_RPC_PROMPT` 的文案描述的是「questions are forwarded via RPC to the main agent's UI, where the user will see them」——这对 TUI 和 GUI 都准确（「main agent's UI」在 TUI 下是父 TUI 的 ask_user 组件，在 GUI 下是 AskUserOverlay）。**无需 TUI 变体**。

新文案反而有害：若 ASK_USER_TUI_PROMPT 说「子 agent 自己的 TUI 渲染」（如任务描述建议），但实际子进程是 `--mode rpc`（不能自己渲染），LLM 会困惑于「文案说我自己渲染，但我的 ctx.mode 是 rpc」。

### 2.5 mode 穿透链路（复用 02 的 sessionMode）

02 已在 `SubagentServiceSessionInit` 规划 `mode?: ExtensionMode` 字段。本设计复用，把它穿透到 `SessionRunnerContext`：

```
index.ts session_start
  └─ service.initSession({ mode: ctx.mode })         ← 02 已设计
       └─ SubagentService.sessionMode = init.mode     ← 02 已设计
            └─ buildSessionRunnerContext()
                 └─ ctx.mode = this.sessionMode       ← 03 新增（SessionRunnerContext 加 mode 字段）
                      └─ runSpawn(record, task, opts, ctx)
                           ├─ W4 守卫读 ctx.mode      ← 03 新增
                           └─ stdio 选择读 ctx.mode   ← 03 新增
```

**为什么走 SessionRunnerContext 而非 RunOptions**：
- `mode` 是 **session 级**（父进程的运行模式，整个 session 不变），不是 per-call。
- `RunOptions` 是 per-execute 的（每次 `subagent` tool call 构造一次），放 session 级字段语义不对。
- `SessionRunnerContext` 由 `buildSessionRunnerContext` 构造，session 级复用，放 mode 语义正确。

**SessionRunnerContext 改动**（`session-runner.ts:188-205`）：

```ts
export interface SessionRunnerContext {
  cwd: string;
  agentDir: string;
  skillDirs: string[];
  mainCwd: string;
  mainSessionFile?: string;
  onWorktreePid?: (branch: string, pid: number) => void;
  uiRequestHandler?: (questions: ..., context?: string) => Promise<unknown>;
  /** 父进程 ExtensionMode（tui/rpc/json/print）。W4 提示词守卫 + headless stdio 选择消费。
   *  undefined 时按保守策略（不注入 W4、全 pipe stdio）。 */
  mode?: ExtensionMode;
}
```

`buildSessionRunnerContext`（`subagent-service.ts:962-975`）加一行：

```ts
private buildSessionRunnerContext(overrideCwd?: string): SessionRunnerContext {
  return {
    // ... 现有字段
    uiRequestHandler: this.uiRequestHandler,
    mode: this.sessionMode,   // ← 03 新增
  };
}
```

### 2.6 TUI 模式下 uiRequestHandler 的实现策略（接口约定，归 02）

本设计依赖但**不实现**：TUI 模式下父进程的 `uiRequestHandler` 必须能呈现 ask_user 交互。当前 02 的 D4 假设「TUI 下不注入 handler → 子进程超时降级」——**本设计推翻这个假设**（若 TUI 下要支持子 agent ask_user，必须注入 handler）。

TUI handler 的实现选项（供 02 参考，不属于本设计实现）：

**选项 A（推荐）**：父 TUI 用 `ctx.ui.custom` 复用 ask-user 扩展的 `AskUserComponent` 渲染。父进程是 TUI 模式，`ctx.ui.custom` 可用（ask-user 扩展的 `runTuiInteraction` 已证明）。handler 收到子进程的 `extension_ui_request` 后，调主 agent 的 `ctx.ui.custom` 弹出 AskUserComponent，用户在父 TUI 内交互，答案通过 `child.stdin.write` 回写子进程。

**选项 B**：父进程把 ask_user 请求通过 `pi.sendMessage` 转发回主 agent LLM，让主 agent 调用自己的 ask_user tool 呈现。问题：主 agent 在等 subagent 完成时不在 turn 循环，需要「subagent 挂起 + 主 agent 接管 turn + 答案回传」机制，复杂且无现成协议。

**选项 A 的问题**：`ctx.ui.custom` 同时只能渲染一个自定义组件（主 agent 的渲染槽位）。若主 agent 正在渲染其他组件（如 todo list widget），子 agent 的 ask_user 会冲突。需确认 Pi 的 `ctx.ui.custom` 是否支持嵌套/队列。**这是 02 实现时需验证的风险，不在本设计范围**。

---

## 三、关键决策点

### D1：为什么不加 mode 参数到 buildSpawnArgs

任务描述要求「buildSpawnArgs 增加 mode 参数（tui/rpc/json），根据 mode 选 args」。但 2.1 决策表证明：所有 mode 都映射到 `--mode rpc`（E1/E2/E3）。加 `params.mode` 但所有分支返回相同 args，是 dead parameter——违反「不加推测性功能」原则（CLAUDE.md 规则 7）。

mode 分流的真实消费点在 W4 守卫（2.4）和 stdio 选择（2.3），这两者都在 `runSpawn` 内部，读 `ctx.mode`（SessionRunnerContext），不需要经过 `buildSpawnArgs`。

**反向论证**：若未来 Pi 支持子进程 TUI（长期方案，见六），`buildSpawnArgs` 才需要 mode 参数（tui mode → 不传 `--mode` + `-p`）。届时加参数有真实分支，不是 dead code。现在加是过早抽象。

### D2：为什么 TUI 和 RPC 的 spawn 策略相同

E1/E2/E3 证明子进程不能跑 TUI。TUI 模式下要让子 agent 支持 ask_user，唯一可行路径是：
- 子进程 `--mode rpc`（与 GUI 相同）
- 子进程 ask_user → extension_ui_request → 父进程
- **父进程在 TUI 内渲染 ask_user**（而非 sidecar 转发）

从子进程视角，tui 和 rpc 的 spawn 完全相同。区别在父进程的 handler 实现（归 02）。因此 spawn 层不需要分流。

### D3：为什么 ASK_USER_RPC_PROMPT 不需要 TUI 变体

见 2.4。核心论点：子进程 LLM 无法区分「父 TUI 渲染」和「父 GUI 渲染」——两者都是「extension_ui_request 到父进程，父进程呈现」。`ASK_USER_RPC_PROMPT` 文案对两者都准确。

任务描述建议的 ASK_USER_TUI_PROMPT（「子 agent 自己的 TUI 渲染」）与实际架构（子进程 `--mode rpc`，不能自己渲染）矛盾，会产生 LLM 困惑。

### D4：为什么不加 forward 兜底（任务描述提到的「mode 分流基础上再加 forward 兜底」）

任务描述提到「为什么不在 mode 分流基础上再加 forward 兜底」。这里的「forward 兜底」应指：即使 mode 分流判断错误，也有一个 fallback 把 ask_user 转发到某处。

**不加 forward 兜底的理由**：
1. **掩盖 bug**：mode 分流是确定性逻辑（读 `ctx.mode` 字符串比较），没有「判断错误」的场景。加兜底会把「mode 未注入」这种配置 bug 静默吃掉，违反「失败要出声」（CLAUDE.md 规则 3）。
2. **语义模糊**：forward 到哪里？主 agent 的 ask_user tool（选项 B）需要主 agent 接管 turn，没有现成协议。sidecar（GUI 路径）在 TUI 下不存在。兜底目标不明确。
3. **02 的可观测性已覆盖**：02 设计的 `subagent:ui-request-missing-handler` appendEntry 会在 handler 缺失时记录，用户能看到信号。这比静默 forward 更健康。

### D5：headless 下 stdin 用 ignore 还是保持 pipe

选 `ignore`（2.3）。理由：
- headless 父进程无 handler，stdin pipe 永不写入 → 子进程 read 阻塞（非 EOF，不退出 stdin reader）。
- `ignore`（`/dev/null`）让子进程 stdin 立即 EOF → rpc-mode `process.stdin.on("end", ...)` 触发 shutdown。
- 风险 R2：若 headless 下子进程 task 还在跑，stdin EOF 提前触发 shutdown 会打断。需验证 rpc-mode 的 `onInputEnd` 是否真的立即 shutdown（见 `rpc-mode.ts:461-463` `onInputEnd = () => { void shutdown(); }`）。

**保守替代**：若 R2 验证不通过，headless 也保持 `["pipe", "pipe", "pipe"]`（现状），只改 W4 守卫。stdio 分支推迟到 R2 明确后再定。这个保守路径不影响 W4 修复（本设计核心）。

---

## 四、风险点

### R1：TUI 模式下 ctx.ui.custom 的渲染槽位冲突

2.6 选项 A 依赖父 TUI 的 `ctx.ui.custom` 渲染 AskUserComponent。若主 agent 此时正在用 `ctx.ui.custom` 渲染其他组件（如其他扩展的 widget），子 agent 的 ask_user 会抢占槽位。

**影响**：本设计不实现 handler（归 02），但依赖其可行性。若 02 实现时发现 `ctx.ui.custom` 不能并发，TUI 模式下子 agent ask_user 仍不可用，退化为 02 D4 的「超时降级」。

**缓解**：02 实现时验证 Pi 的 `ctx.ui.custom` 是否支持队列/嵌套。若不支持，TUI 模式的 ask_user 标记为「不支持」，W4 守卫改为 `ctx.mode === "rpc"` 才注入（TUI 也不注入，与 headless 同）。

### R2：headless 下 stdin=ignore 触发子进程提前 shutdown

2.3 的 headless stdio 改为 `["ignore", "pipe", "pipe"]`。子进程 rpc-mode 的 `process.stdin.on("end", onInputEnd)` 会在 stdin EOF（ignore 立即 EOF）时调 `shutdown()`——这可能打断正在执行的 task。

**验证方法**：读 `rpc-mode.ts:461-463` + `attachJsonlLineReader`（`jsonl.ts`）。若 `onInputEnd` 的 shutdown 会 `process.exit`，headless 下子进程根本跑不完 task——但当前实现 `["pipe", "pipe", "pipe"]` 下 stdin 不 EOF（pipe 对端有写句柄），所以现状没触发这个问题。改 `ignore` 会暴露。

**缓解**：若验证不通过，采用 D5 的保守路径（headless 保持全 pipe，只改 W4 守卫）。stdio 分支不影响 W4 修复的核心价值。

### R3：mode 未注入（sessionMode 为 undefined）的保守策略

`SessionRunnerContext.mode` 是 optional。若 02 的 `initSession` 没传 mode（如旧版本 SubagentService 不带 sessionMode 字段），`ctx.mode` 为 undefined。

**策略**（2.1 决策表）：undefined 按 headless 处理（不注入 W4、全 pipe stdio）。这是最保守的选择——宁可少注入提示词（LLM 看 tool 描述自行判断），也不误导 LLM「用户会回答」。

**风险**：若实际是 tui/rpc 但 mode 未注入，W4 不注入 → LLM 缺少 ask_user 使用指引。但 ask_user tool 自身的 description 已含使用指南（见 `ask-user/src/index.ts:96-112` promptGuidelines），W4 是增量提示，缺失不致命。

### R4：02 的 sessionMode 字段未实现时的回退

本设计复用 02 规划的 `SubagentServiceSessionInit.mode` + `this.sessionMode`。若 02 尚未实现，`buildSessionRunnerContext` 读 `this.sessionMode` 得 undefined → 走 R3 的保守路径。

**缓解**：本设计与 02 有实现顺序依赖。建议 02 先合入 sessionMode 字段（即使 handler 是 stub），03 再依赖它。或在 03 的 `initSession` 里直接加 `this.sessionMode = init.mode`（若 02 未合入，03 自行补）。

### R5：W4 守卫改变 LLM 行为

当前 headless 下注入 RPC 文案，LLM 会尝试 ask_user（然后超时）。改为不注入后，LLM 看 ask_user tool description 仍可能尝试调用（description 没说「headless 不可用」）。子进程 ask_user 的 headless 检查（`ask-user/src/index.ts:265-270` `ctx.mode !== "tui" && ctx.mode !== "rpc"` → disableAskUser）会兜底——第一次调用后 disable，后续不再试。

**结论**：W4 不注入 + ask_user 自身的 headless disable，行为正确（第一次尝试即 disable，LLM 收到 cancelled result）。比当前「注入文案 + 超时降级」更快失败。

---

## 五、代码变更清单

| 文件 | 函数/字段 | 改动类型 | 说明 |
|------|----------|----------|------|
| `extensions/subagent-workflow/src/execution/session-runner.ts:188-205` | `SessionRunnerContext` | 修改 | 新增 `mode?: ExtensionMode` 字段 |
| `session-runner.ts:706-708` | W4 提示词注入 | 修改 | 加 `parentWillRespond = ctx.mode === "tui" \|\| ctx.mode === "rpc"` 守卫 |
| `session-runner.ts:755-760` | spawn stdio | 修改 | headless（json/print）用 `["ignore","pipe","pipe"]`，其余全 pipe（⚠️ R2 未验证前可保守保持全 pipe） |
| `session-runner.ts` 顶部 import | `ExtensionMode` 类型 | 新增 | `import type { ExtensionMode } from "@mariozechner/pi-coding-agent"`（或 shared/types stub） |
| `extensions/subagent-workflow/src/execution/subagent-service.ts:962-975` | `buildSessionRunnerContext` | 修改 | 加 `mode: this.sessionMode` |
| `subagent-service.ts:111-119` | `SubagentServiceSessionInit` | 修改（若 02 未合入） | 加 `mode?: ExtensionMode` 字段（02 已规划，确认是否已加） |
| `subagent-service.ts:174` 附近 | `sessionMode` 字段 | 新增（若 02 未合入） | `private sessionMode?: ExtensionMode` |
| `subagent-service.ts` `initSession` | — | 修改（若 02 未合入） | `this.sessionMode = init.mode` |
| `extensions/subagent-workflow/src/index.ts:215-235` | `session_start` 的 `initSession` 调用 | 修改 | 加 `mode: ctx.mode`（02 已规划，确认） |
| `shared/types/mariozechner/index.d.ts` | `ExtensionMode` 导出 | 确认/补 stub | 若 tsc 报 `has no exported member 'ExtensionMode'`，补 stub |

**不改**：
- `buildSpawnArgs`（2.2 决策：保持硬编码 `--mode rpc`，不加 mode 参数）
- `ASK_USER_RPC_PROMPT` 文案（2.4 决策：TUI/RPC 共用，无 TUI 变体）
- `ExecuteOptions` / `RunOptions`（mode 是 session 级，走 SessionRunnerContext，不走 per-call options）
- `subagent-tool.ts` / `subagent-actions.ts`（mode 不从 tool 层透传，从 session_start 注入）

**不在本设计实现**（标注清楚）：
- TUI 模式 uiRequestHandler 的 `ctx.ui.custom` 渲染实现 → 02
- sidecar handler 的 sidecar 通道调用 → 02 + subagent 4
- Pi 核心支持子进程 TUI 接管终端 → 长期方案（见六），Pi 核心改造

---

## 六、长期方案（需 Pi 核心改造，不在本 topic 范围）

当前设计的局限：TUI 模式下子进程不能跑自己的 TUI（E1/E2/E3），只能走 RPC + 父 TUI 代渲染（2.6 选项 A）。这限制了子 agent 的 UI 隔离性——子 agent 的 ask_user 组件挤在父 TUI 的渲染槽位里。

**长期方向**：Pi 核心暴露编程式 TUI suspend/resume API：

```ts
// 假想的 Pi 核心 API（当前不存在）
interface InteractiveMode {
  /** 挂起 TUI 渲染（恢复终端 normal mode），返回恢复函数。不挂起进程。 */
  suspendRender(): () => void;
}
```

有了这个 API，TUI 模式下 subagent 启动可改为：
1. 父 TUI 调 `suspendRender()`（停渲染，恢复终端，进程继续跑）
2. spawn 子进程，**不传 `--mode`**，`stdio: "inherit"` → 子进程进 InteractiveMode
3. 子进程跑自己的 TUI，ask_user 走 `ctx.ui.custom` 自己渲染
4. 子进程退出后，父 TUI 调恢复函数 resume

这是任务描述理想中的「subagent 自己渲染 ask_user」。但依赖 Pi 核心改造，本 topic 不实现。本设计的 W4 守卫 + mode 穿透为这个长期方案预留了扩展点（届时 `buildSpawnArgs` 加 mode 参数，tui mode 映射到不传 `--mode` + inherit）。

---

## 七、假设清单（需其他 subagent / 用户确认）

1. **假设 02 会实现 `SubagentServiceSessionInit.mode` + `this.sessionMode`**——本设计复用。若 02 未实现，本设计需自行补字段（见变更清单的「若 02 未合入」分支）。

2. **假设 `ExtensionMode` 类型从 `@mariozechner/pi-coding-agent` 可导入**——基于 pi 源码 `packages/coding-agent/src/core/extensions/types.ts:299`。若 shared/types stub 缺失，需补 `export type ExtensionMode = "tui" | "rpc" | "json" | "print"`。

3. **假设 02 的 D4 假设（TUI 下不注入 handler）可被推翻**——本设计要求 TUI 模式注入 handler（2.6）。若 02 坚持 D4（TUI 不注入），则本设计的 W4 守卫应退化为 `ctx.mode === "rpc"` 才注入（TUI 也不注入，与 02 D4 一致）。**这个产品决策需与 02 owner 对齐**：TUI 下子 agent ask_user 是否需要支持？

4. **假设 headless 下 stdin=ignore 不触发子进程提前退出（R2）**——需验证 rpc-mode 的 `onInputEnd` 行为。若验证失败，采用 D5 保守路径（headless 保持全 pipe，只改 W4 守卫）。

5. **假设 TUI 模式下父进程 `ctx.ui.custom` 能渲染子 agent 的 ask_user（R1）**——需 02 实现时验证。若不支持并发渲染，TUI 模式 ask_user 退化为不支持。

6. **假设当前所有 subagent 都应走 `--mode rpc`**——基于 E1/E2/E3 的技术约束。若未来 Pi 支持子进程 TUI（长期方案），此假设失效，需重新评估 mode 分流。
