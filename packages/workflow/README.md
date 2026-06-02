# workflow

多 Agent 编排引擎 — 用 JS 脚本描述任务流程，Worker 线程隔离执行，支持 `agent()` / `parallel()` / `pipeline()` API。

## 功能

- **脚本驱动**：在 `.pi/workflows/` 下写 JS 脚本定义流水线
- **三种编排 API**：`agent()`（单个）、`parallel()`（并发）、`pipeline()`（串行）
- **Worker 隔离**：每个 workflow 运行在独立 Worker 线程
- **暂停/恢复**：支持暂停/恢复，已完成的 agent 调用不重复执行
- **跨会话恢复**：Pi 重启后自动检测中断的 workflow
- **预算控制**：Token / 时间双预算

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/workflow \
      ~/.pi/agent/extensions/workflow

# npm 方式（正式）
pi install npm:@zhushanwen/pi-workflow
```

## 使用

### 编写 Workflow 脚本

在 `.pi/workflows/` 下创建 `.js` 文件：

```javascript
const meta = { name: "my-review", description: "批量代码审查" };

(async () => {
  const files = await agent({ prompt: "扫描 src/ 下所有 .ts 文件" });
  const reviews = await parallel(
    JSON.parse(files).map(f => ({ prompt: `审查 ${f}` }))
  );
  await agent({ prompt: `汇总报告：\n${reviews.join("\n")}` });
})();
```

### 运行

```
/workflow run my-review
/workflow run my-review --tokens 50000
/workflows    # 交互式面板
```

或让 AI 通过 `workflow-run` 工具调用。

## 文件结构

```
workflow/
├── index.ts
└── src/
    ├── index.ts            # 入口 — 工具、命令、事件注册
    ├── orchestrator.ts     # Worker 生命周期、agent 调度
    ├── agent-pool.ts       # Pi 子进程池
    ├── worker-script.ts    # Worker 运行时注入
    ├── state.ts            # 状态机（7 态）
    ├── budget.ts           # 预算计算
    ├── commands.ts         # 命令解析
    ├── config-loader.ts    # 配置 + workflow 发现
    ├── execution-trace.ts  # 执行追踪
    ├── tool-generate.ts    # 工具参数生成
    └── widget.ts           # TUI 状态面板
```
