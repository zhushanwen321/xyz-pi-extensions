---
verdict: pass
---

# Non-Functional Design — Workflow Extension 整体重构

## 1. 稳定性

**改动影响：** 本次是架构重构，不改运行时行为（workflow 脚本执行逻辑不变）。风险点在于新旧切换（Wave 4 Task 29）——切换前旧代码可用，切换后新代码必须无缝接管。

**风险缓解：**
- 渐进式迁移：Wave 1-3 产出新代码（与旧代码并存编译），Wave 4 才切换 factory，Wave 5 删旧码。任何 Wave 出问题可回退到上一个 Wave 的状态。
- 每个 Wave gate 验证 typecheck + test 通过才进入下一 Wave。
- 错误恢复逻辑（Worker 重试、stale-context 检测、budget 超限）行为不变，测试覆盖完整（domain-models.md §测试不变式清单 10 项）。
- `replaceRuntime`（G5-001）是新增操作，需重点测试原子性（旧 runtime 释放 + 新 runtime 绑定不可中断）。

**为什么这样设计：** 渐进式迁移比 big-bang rewrite 安全得多。新旧并存期间虽然代码冗余，但保证了任何时刻都有一个可工作的版本。

## 2. 数据一致性

**数据存储：** workflow run 状态持久化到 Pi session JSONL（`pi.appendEntry("workflow-state", serializedState)`）。Session 目录由 Pi 平台管理。

**并发控制：**
- 每个 run 有独立的 `RunRuntime`（worker/gate/controller），runs 之间不共享运行时资源。
- `ConcurrencyGate`（per-run 实例）控制单 run 内的 agent 并发（maxConcurrency=4，D-13），FIFO 队列保证公平。
- 状态变更通过 `WorkflowRun` 方法封装（transition/assignRuntime/releaseRuntime/replaceRuntime），engine 模块不直接打洞赋值（AC-3）。
- A4 原子性：`releaseRuntime()` 先 cleanup（worker.terminate + controller.abort），cleanup 成功后才置 runtime=undefined。如果 cleanup 抛错，status 未变。

**JSONL 格式变更（D-5）：** 新格式不向后兼容旧 session。旧 run 历史无法在新版本恢复。这是可接受的代价——workflow run 是短生命周期执行实例，历史价值低。`JsonlRunStore.loadAll()` 遇到旧格式返回空（而非崩溃）。

**为什么这样设计：** 强制旧格式兼容会拖累新模型设计（需要维护 deserialize 的双路径）。破坏性变更是方案 C 授权的，用户明确接受。

## 3. 性能

**文件扫描：** `WorkflowScriptRegistryImpl.loadAll()` 扫描 `.pi/workflows/` + `~/.pi/agent/workflows/` + `.pi/workflows/.tmp/`。60s TTL 缓存，按 workspaceRoot 分桶。扫描结果缓存在内存，invalidate() 手动失效。

**Worker 线程：** 每 run 一个 Worker 线程（node:worker_threads），执行用户脚本。Worker 内通过 postMessage 与主线程通信（agent 调用、return、error、log）。消息序列化开销可接受（agent 调用本身是 spawn 子进程，比序列化贵得多）。

**pi 子进程：** 每次 agent 调用 spawn 新 pi 进程（`SubprocessAgentRunner.run()` → `runPiProcess()`）。进程不复用。24h 安全超时防止僵尸进程。

**为什么这样设计：** Worker 线程隔离用户脚本（防止脚本崩溃影响主进程），pi 子进程隔离 agent 执行（每个 agent 独立上下文）。两层隔离保证了故障 containment。

## 4. 业务安全

**Skill 文件作为 AI 指令：** workflow extension 自带 `skills/workflow-script-format/SKILL.md`，在 AI 调用 `workflow-script { action: "generate" }` 时通过 `pi.sendUserMessage(..., {deliverAs: "steer"})` 自动注入。这确保 AI 生成的脚本符合格式规范。

**脚本执行安全：** 用户 workflow 脚本在 Worker 线程内执行，只有 `agent()`/`parallel()`/`pipeline()` 等注入的全局函数可用。但 Worker 内可以 `require()` Node.js 内置模块——这是设计约束（脚本格式 SKILL.md 声明），用户脚本自行负责不执行危险操作。workflow extension 不做沙箱隔离（VM sandbox 风险大无收益，D-7 保留现状）。

**rpc 降级（D-11）：** `tool-workflow.ts` 中 run action 的 approval 确认（向用户发消息）留在 Interface 层 `helpers.confirmTmp()` 函数中。ApprovalPolicy 不再是独立类，现状本就是 1 个 Set + 2 行代码，过度建模为 domain 值对象 + port 是伪抽象（D-12）。

**为什么这样设计：** 安全边界在 Worker 线程 + 子进程两层隔离。脚本格式规范通过 skill 自动注入引导 AI 正确生成，而非运行时强制。

## 5. 数据安全

**敏感信息处理：** workflow extension 不直接处理敏感信息。agent 调用的 prompt/schema 由用户脚本提供，经 `SubprocessAgentRunner` 传给 pi 子进程。prompt 可能通过 `--append-system-prompt` 注入临时文件（`systemPromptFiles`），这些文件在 run 结束时由 Engine `lifecycle` 函数清理（temp file cleanup）。

**文件操作权限：**
- 只写入 `.pi/workflows/`（脚本保存）和系统 temp 目录（agent prompt 注入文件）。
- 脚本删除（`workflow-script { action: "delete" }`）有运行中检查（`isRunning(name)` 拒绝删除正在运行的脚本）。
- JSONL 持久化由 Pi 平台的 `pi.appendEntry` 管理，extension 不直接操作文件系统。

**为什么这样设计：** 文件操作范围最小化。temp 文件在 run 生命周期内创建 + 清理，不长期残留。删除操作有防误删保护（运行中拒绝）。
