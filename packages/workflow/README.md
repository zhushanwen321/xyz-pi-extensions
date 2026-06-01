# workflow — Pi 多 Agent 编排引擎

基于 `worker_threads` 的通用多 Agent 编排引擎。用户编写 JS 脚本描述任务流程，扩展负责 Worker 隔离执行、agent 子进程调度、暂停/恢复、Token 预算控制。

## 安装

```bash
# 全局安装
ln -s /path/to/xyz-pi-extensions/workflow ~/.pi/agent/extensions/workflow

# 项目级安装
mkdir -p .pi/extensions
ln -s /path/to/xyz-pi-extensions/workflow .pi/extensions/workflow
```

安装后重启 Pi session 生效。

## 快速开始

### 1. 编写 Workflow 脚本

在 `.pi/workflows/` 或 `~/.pi/agent/workflows/` 下创建 JS 文件：

```javascript
// .pi/workflows/my-review.js
const meta = {
  name: "my-review",
  description: "批量代码审查流水线",
  phases: ["scan", "review", "report"],
};

(async () => {
  // agent() 调用 Pi 子进程执行任务，返回结果文本
  const files = await agent({
    prompt: `扫描 ${$WORKSPACE}/src/ 下所有 .ts 文件，列出文件路径`,
    schema: { type: "array", items: { type: "string" } },
  });

  // parallel() 并发执行多个 agent
  const reviews = await parallel(
    JSON.parse(files).map((f) => ({
      prompt: `审查文件 ${f} 的代码质量，关注 bug 和性能问题`,
      description: `审查: ${f}`,
    }))
  );

  // 汇总报告
  await agent({
    prompt: `将以下审查结果汇总为一份报告，写入 ${$WORKSPACE}/review-report.md：\n${reviews.join("\n---\n")}`,
  });

  return { status: "completed", files: JSON.parse(files).length };
})();
```

### 2. 运行

```
/workflow run my-review
/workflow run my-review --args directory="src/"
/workflow run my-review --tokens 50000
```

或让 AI 通过 tool 调用：

```
> 用 my-review workflow 审查 src/ 目录
（AI 自动调用 workflow-run tool）
```

## 核心 API

脚本运行在 Worker 线程中，以下全局函数/变量由运行时注入：

### `agent(opts)` → `Promise<string|object>`

Spawn 一个 Pi 子进程执行任务，返回结果。

```javascript
const result = await agent({
  prompt: "...",        // 必需：完整指令
  schema: { ... },      // 可选：JSON Schema，自动解析结构化输出
  model: "...",         // 可选：provider/model 格式
  description: "...",   // 可选：描述（显示在 TUI）
});
```

- `schema` 提供时，运行时会尝试 `JSON.parse` 输出并返回解析后的对象
- 失败时抛出 `Error`，由 Worker 捕获处理
- 已完成的调用在暂停/恢复时从 `callCache` 重放，不重新执行

### `parallel(calls)` → `Promise<Array>`

并发执行多个 agent 调用。受 `maxConcurrency` 设置限制。

```javascript
const results = await parallel([
  { prompt: "分析文件 A", description: "A" },
  { prompt: "分析文件 B", description: "B" },
  { prompt: "分析文件 C", description: "C" },
]);
```

### `pipeline(stages)` → `Promise<any>`

串行执行，前一步结果作为后一步输入。

```javascript
const report = await pipeline([
  (prev) => agent({ prompt: `分析代码并提取函数签名：${prev}` }),
  (prev) => agent({ prompt: `基于签名生成 API 文档：${prev}` }),
  (prev) => agent({ prompt: `审查文档完整性：${prev}` }),
]);
```

### 全局变量

| 变量 | 类型 | 说明 |
|------|------|------|
| `$ARGS` | `object` | 用户通过 `--args` 传入的参数 |
| `$WORKSPACE` | `string` | 项目工作区绝对路径 |
| `$BUDGET` | `object` | `{ usedTokens, usedCost, maxTokens?, maxTimeMs? }` |

## 命令参考

| 命令 | 说明 |
|------|------|
| `/workflow run <name> [--args key=val ...] [--tokens N] [--time N]` | 运行 workflow |
| `/workflow list` | 列出可用/运行中的 workflow |
| `/workflows` | 交互式面板（查看状态、暂停/恢复/中止） |
| `ctrl+p` | 暂停当前 focused workflow |
| `ctrl+r` | 重试当前 focused workflow 的失败节点 |
| `ctrl+s` | 中止当前 focused workflow |

## workflow-run Tool

AI 可以直接调用 `workflow-run` tool 启动 workflow：

```
> 用代码审查 workflow 分析 src/proxy/
（AI 调用 workflow-run tool，后台执行，不阻塞对话）
```

## 配置

在 `~/.pi/agent/settings.json` 中：

```json
{
  "workflow": {
    "maxConcurrency": 4
  }
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `maxConcurrency` | 4 | `parallel()` 同时运行的最大 agent 子进程数 |

## 适用场景

### 适合 workflow 的场景

| 场景 | 特征 | 示例 |
|------|------|------|
| **批量代码审查** | 多文件并发扫描、汇总报告 | `parallel()` 并发审查 N 个文件 |
| **批量文件重构** | 规则化修改、统一验证 | scan → transform → lint check |
| **文档生成流水线** | 多步串行处理 | 分析代码 → 生成文档 → 审查质量 |
| **多模型对比** | 同一任务用不同模型执行 | `parallel()` 分别调用不同 model |
| **数据分析管线** | 提取 → 转换 → 加载 | `pipeline()` 逐步传递结果 |
| **后台自动化** | 长时间运行、不阻塞对话 | `/workflow run xxx` 后继续对话 |

**共同特征**：任务明确、步骤确定、不需要与用户交互。

### 不适合 workflow 的场景

| 场景 | 原因 | 替代方案 |
|------|------|---------|
| **需求澄清/brainstorming** | 需要与用户反复对话 | 主线程 AI 直接对话 |
| **交互式调试** | 需要根据错误动态调整策略 | `/goal` + diagnose skill |
| **需要 ctx.compact() 的长流程** | Worker 无法调用 Pi API | coding-workflow 扩展 |
| **需要 Pi tool 注册的流程** | Worker 无法注册 tool | 主线程扩展 |

### 与其他扩展的对比

| 维度 | workflow | subagent | goal |
|------|----------|----------|------|
| **调度者** | 用户脚本（JS） | 主线程 AI | 主线程 AI |
| **执行模型** | Worker 线程 | 独立进程 | 主线程自主循环 |
| **编排能力** | `parallel()` + `pipeline()` | single / parallel / chain | 任务队列 |
| **交互性** | 无（纯自动） | 无（纯自动） | 高（用户可随时介入） |
| **持久化** | callCache + JSONL entries | 无 | session entries |
| **暂停/恢复** | 支持（Worker 级别） | 不支持 | 支持（goal 级别） |
| **跨会话恢复** | 支持（JSONL scan） | 不支持 | 支持 |
| **适用** | 确定性流水线 | 单次任务委派 | 长期目标追踪 |

## 错误处理

### 自动重试

agent 调用失败时自动重试 3 次，指数退避（1s → 2s → 4s）：

```
agent-call → 失败 → 等 1s → 重试 → 失败 → 等 2s → 重试 → 失败 → 等 4s → 重试 → 最终失败
```

### 手动重试

Workflow 失败后，通过 `/workflows` 面板或 `ctrl+r` 手动重试失败节点。

### 暂停/恢复

```
/workflow run my-review      ← 开始执行
ctrl+p                        ← 暂停（Worker 终止，callCache 保留）
/workflows → 选择 → Resume    ← 恢复（从断点继续，已完成的 agent 不重新执行）
```

### 跨会话恢复

Pi 重启后，`/workflows` 会检测到中断的 workflow 并提示恢复。

## _render 协议（GUI 兼容）

`workflow-run` tool 返回的 `details._render` 遵循项目 `_render` 协议，xyz-agent 可直接渲染：

```typescript
details._render = {
  type: "task-list",
  data: {
    title: "my-review",
    items: [
      { label: "扫描文件", status: "completed" },
      { label: "审查代码", status: "in_progress" },
      { label: "汇总报告", status: "pending" },
    ],
  },
};
```

## 文件结构

```
workflow/
├── index.ts            # 入口，re-export src/index.ts
├── package.json        # name + main
└── src/
    ├── index.ts        # 扩展工厂：注册 tool + command + events
    ├── state.ts        # 状态机（7态）、类型定义、序列化
    ├── orchestrator.ts # 编排器：Worker 生命周期、agent 调度、预算
    ├── agent-pool.ts   # Agent 池：spawn Pi 子进程、JSONL 解析
    ├── worker-script.ts# Worker 源码构建：注入 agent/parallel/pipeline
    ├── config-loader.ts# 配置读取 + workflow 发现 + meta 提取
    ├── execution-trace.ts # 执行追踪：callId 序列记录
    ├── budget.ts       # Token/时间预算计算
    ├── commands.ts     # /workflow 命令解析
    └── widget.ts       # TUI 状态面板渲染
```

## Demo 脚本

`.pi/workflows/demo.js` — 最小可用演示（2 个串行 agent 调用）。

`.pi/workflows/demo-coding-workflow.js` — xyz-harness 5 phase 流程的自动化版本（仅供参考，实际 coding-workflow 应使用主线程扩展以保留交互能力）。

## License

MIT
