# ADR-001: Subagent 架构与使用模型

> 状态：accepted（Decision 2 revised 2026-06-28）
> 日期：2026-05-21
> 修订：2026-06-28 — Decision 2 新增 fork 继承模式；新增 Decision 6（D-007/D-008/D-018）

## 背景

Pi coding agent 的 subagent 工具是一个 `examples/extension`（非核心模块），通过 `child_process.spawn` 启动独立 `pi --mode json` 进程实现任务委派。它的核心价值有三个：

1. **上下文隔离**：将子任务从主 agent 的对话历史中剥离，控制 token 消耗
2. **并行执行**：多个独立子任务可以在 background 模式下并发运行
3. **模型专精**：不同 agent 绑定不同模型，分析类任务用 GLM-5.1，简单任务用 DS-Flash

但它引入了一个不可消除的张力：**上下文隔离是功能（控制成本）也是限制（信息不自动流动）**。

## 决策 1: 进程隔离模型

### 选择了什么

subagent = `spawn("pi", ["--mode", "json", "-p", "--no-session", ...])`。

subagent 是一个独立操作系统进程，拥有独立的对话历史、独立的文件系统视图（除了同一个 cwd）、独立的模型调用。主 agent 和 subagent 之间唯一的通信通道是：

- **下行**：主 agent → subagent = task prompt（字符串参数）
- **上行**：subagent → 主 agent = stdout JSON 事件流（`message_end`、`tool_result_end`）

### 为什么不选其他方案

| 替代方案 | 问题 |
|---------|------|
| 同进程内线程/协程 | 上下文无法隔离，token 累计到同一个窗口 |
| 共享内存 IPC | Pi 运行时不支持，扩展 API 无此能力 |
| REST/gRPC 服务 | 引入网络延迟和认证复杂度，overkill |
| 文件系统握手（写文件等读） | 没有可靠的"完成"信号，轮询浪费 |

### 决策代价

1. **上下文断裂**：subagent 没有对话历史，不知道主 agent 之前做了什么。必须通过 task prompt 显式传递
2. **环境隔离**：subagent 进程不一定承载主进程的所有环境变量（`spawn` 默认继承 `process.env`，但 systemd/launchd 启动的进程可能不完整）
3. **单向通信**：subagent 无法"暂停并询问"主 agent。执行中遇到歧义只能猜测或失败
4. **无共享文件锁**：两个进程可能同时写同一个文件，Pi 的 `withFileMutationQueue` 只在进程内有效

## 决策 2: 上下文传递协议

### 选择了什么（修订：fork 继承模式）

task prompt 是**可选输入**。上下文传递有两种模式：

**模式 A：显式传递（默认，非 fork）**

task prompt = subagent 的全部上下文输入。主 agent 构造 task prompt 时必须包含：

```
1. 任务背景（为什么做、在整体目标中的位置）
2. 相关文件路径（完整路径，不要让 subagent 自己 find）
3. 已知信息（主 agent 已经确认的发现）
4. 约束条件（不动哪些文件、遵循什么规范）
5. 产出预期（需要什么输出、什么格式）
```

不需要传递的信息（subagent 自动获得或不需要）：

- 项目 CLAUDE.md — subagent 通过 resourceLoader 自动加载（确认：`--no-session` 不影响 `--no-context-files` 才是控制开关）
- 完整对话历史 — subagent 的任务是独立、自包含的
- 主 agent 的推理过程 — 只需要结论和决策

**模式 B：fork 继承（`fork: true`）**

subagent 通过 Pi SDK 的 `createBranchedSession` / `forkFrom` 继承主 agent 的完整会话上下文（对话历史、session entries）。task prompt 变为增量指令——只需描述子任务差异，无需重复背景。

继承内容：

- 主 agent 的对话历史（通过 branched session 拷贝）
- Session entries（通过 session manager 继承）
- 环境变量（`fork` 模式继承 `process.env`，含 secrets——见安全约束）

不继承的内容：

- 文件系统写入（fork 模式共享 cwd，worktree 模式隔离到临时目录）
- 子进程状态（subagent 是新进程，不共享内存）

### 为什么修订

原始决策假设 subagent 始终是"全新启动的 pi 进程"。fork 能力引入后，subagent 可以选择性继承主 agent 上下文，消除了"上下文整理"开销的硬性要求。这改变了 task prompt 的语义：

- 非 fork：task = 全部输入（原始行为不变）
- fork：task = 增量指令（上下文已继承）

### 决策代价

- **非 fork 路径代价不变**：主 agent 每次派发前有"上下文整理"开销
- **fork 路径新代价**：
  - 继承完整对话历史意味着 subagent 的 token 消耗更大（上下文窗口被历史占据）
  - fork 模式继承环境变量包括 secrets（API keys、tokens），worktree 隔离仅限文件系统层面
  - fork 深度有限制（D-007：最大 10 层），超限抛出 `ForkDepthExceededError`
  - fork 会话创建有两级降级（D-018），但两级均失败时任务直接失败，无法回退到非 fork 模式

## 决策 3: Background 模式与自动注入

### 选择了什么

`background: true` → subagent 异步运行 → 完成后自动注入到主对话 → 主 agent 无需轮询。

注入机制：Pi 的 backgroundJob 管理器追踪子进程退出，通过 `session.prompt()` 注入结果作为新用户消息，触发主 agent 的下一轮。

### 为什么不轮询

轮询（`sleep N && collect_subagent`）的代价：
- 浪费 token（每轮检查的对话输出）
- 浪费时间（sleep 时间不好预估——太短频繁检查，太长空转）
- 不可靠（sleep 可能超时、collect_subagent 可能因为竞态返回空）

### 决策代价

1. **主 agent 必须在启动 background subagent 后立即 stop**：如果继续说话，注入的结果可能插入到对话的意外位置
2. **嵌套 subagent 不可靠**：subagent 内部再 `background: true` 派发子子 agent 时，子子的完成结果走 Pi 的 background injection 通道，但这个通道在 `runSingleAgent` 的 spawn 子进程中不存在（它是通过主 Pi 进程的 session manager 注入的）
3. **并行编排必须分批次**：主 agent 启动 batch 1 → stop → auto-inject → 主 agent 启动 batch 2 → stop → ...
4. **collect_subagent 的唯一合法用途**：列出活跃 jobs，判断是否还有 running 的——不是为了取结果

## 决策 4: Subagent 能力边界

### 选择了什么

subagent 的可用工具集由其 agent 定义文件（`~/.pi/agent/agents/<name>.md`）的 `tools` frontmatter 控制；如果不指定，继承 Pi 默认工具集（包括 subagent 工具本身）。

CLAUDE.md 中额外约束：
- 禁止嵌用 subagent 工具（原因见决策 3 代价 2）
- 禁止调外部 API（环境变量传递不可靠）
- 先产出初稿再补充（模型可能"等待异步结果"——外搜索工具在 subagent 内的行为不可预测）

### 为什么不由框架层面禁用

subagent 工具是扩展实现，不是 Pi 核心。它无法：
- 在 spawn 时过滤掉某些工具（工具集在 agent 定义中控制）
- 在 spawn 时注入环境变量（inherit 是默认行为，但没有白名单机制）
- 拦截模型的函数调用请求（扩展不参与模型推理循环）

因此这些约束**只能通过 prompt 工程实现**：写在 CLAUDE.md（系统提示词层，subagent 自动加载） + task prompt（用户消息层，部分 model 更关注这一层）。

### 决策代价

- prompt 约束是软性的——模型可能不遵守
- 需要双重保障（CLAUDE.md + task prompt）增加构造复杂度
- 新增约束时需要考虑"subagent 能否看到这条规则"

## 决策 5: Model 选择策略

### 当前策略

| 复杂度 | 首选 | 备选 | 判断依据 |
|--------|------|------|---------|
| high（架构设计、多文件重构） | router-openai/glm-5.1 | router-openai/ds-pro, router-anthropic/kimi-for-coding | max thinking, 最长上下文 |
| medium（代码审查、单模块重构） | router-anthropic/ds-flash | router-anthropic/kimi-for-coding | high thinking, 快速响应 |
| low（文件查找、格式化） | router-openai/glm-5-turbo | router-openai/ds-flash | high thinking, 低延迟 |

### 已知差异

- **GLM-5.1**：分析能力强，但可能选择"等搜索结果再写"的策略（导致无产出）
- **DS-Flash**：执行速度快，但复杂推理可能跳过细节
- **Kimi**：视觉分析强，但通用编程能力不如 GLM-5.1

### 尚未解决

- 如何让 subagent 在完成时报告"我实际用了多少轮"和"我提前结束了还是跑满了"——当前只能从 stdout 事件流解析 `message_end.stopReason`，但部分模型不填充这个字段
- 如何在 task prompt 中告知 subagent "你最多有 N 轮"——当前没有轮数限制机制

## 决策 6: Fork/Worktree 架构（2026-06-28 新增）

### D-007: Fork 深度硬限

**决策**：`MAX_FORK_DEPTH = 10`。fork=true 且 `parentForkDepth >= 10` 时抛出 `ForkDepthExceededError`，拒绝创建子会话。

**依据**：无界 fork 链会导致会话文件爆炸（每个 branched session 拷贝父级历史）和进程数失控。10 层是经验阈值——正常工作流不会超过 3 层（主 agent → subagent → sub-subagent），10 层留足余量同时防止滥用。

**实现**：`session-context-resolver.ts` 纯函数检查，零副作用。

### D-008: Worktree 命名与隔离

**决策**：`worktree: true` 时，subagent 使用 `os.tmpdir() + '/pi-sub-${recordId}'` 作为独立 cwd，而非在主 cwd 内创建子目录。

**依据**：

1. **隔离性**：tmpdir 天然跨进程隔离，不需要 git worktree add（避免污染 bare repo 的 worktree 列表）
2. **清理性**：tmpdir 重启后自动清理，不残留；subagent 产出的临时文件不干扰主 agent 的工作目录
3. **兼容性**：不依赖 git（纯文件系统操作），非 git 项目也可用

**代价**：tmpdir 内的文件对主 agent 不可见（需要显式拷贝回主 cwd）。subagent 完成后的产出物必须通过 task prompt 约定的输出机制传回。

### D-018: 两级降级链

**决策**：fork 会话创建采用两级降级策略：

```
优先级 1: sdk.createBranchedSession(forkSource, cwd, sessionDir)
    ↓ 失败
优先级 2: sdk.forkFrom(forkSource, { cwd, sessionDir })
    ↓ 失败
抛出 Error（合并两级错误消息）
```

**依据**：`createBranchedSession` 是原地 mutate 方式，体积更小、速度更快（SDK 原生支持）。`forkFrom` 是 fallback 实现，兼容性更广但开销更大。两级保证在 SDK 版本差异下最大兼容性。

**代价**：

- 两级均失败时任务直接失败，不会回退到非 fork 模式（因为 fork=true 是显式意图，静默降级会丢失上下文继承）
- 错误消息合并两级失败原因，但日志中只打印 fallback 路径的 console.log，排查时需注意

---

## 已知限制（非 Pi Extension 可修复）

| 限制 | 根因 |
|------|------|
| subagent 内部嵌套 subagent 结果不注入 | background injection 通道绑在主 Pi session，不在 spawn 子进程内 |
| subagent 无法暂停并反问主 agent | 单向通信，没有交互式通道 |
| 跨进程文件写冲突无保护 | `withFileMutationQueue` 是进程内机制 |
| subagent 看不到主 agent 的对话历史 | 进程隔离的必然结果 |
| 无法在一个 subagent 内靠 task prompt 实现严格的轮数限制 | pi-agent-core 没有 maxTurns 参数暴露到 CLI |
