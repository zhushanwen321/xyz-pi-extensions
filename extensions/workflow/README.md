# workflow

多 Agent 编排引擎 — 用 JS 脚本描述任务流程，Worker 线程隔离执行，支持 `agent()` / `parallel()` / `pipeline()` API。

## 功能

- **脚本驱动**：在 `.pi/workflows/` 下写 JS 脚本定义流水线
- **三种编排 API**：`agent()`（单个）、`parallel()`（并发）、`pipeline()`（串行）
- **Worker 隔离**：每个 workflow 运行在独立 Worker 线程
- **暂停/恢复**：支持暂停/恢复，已完成的 agent 调用不重复执行
- **跨会话恢复**：Pi 重启后自动检测中断的 workflow
- **预算控制**：Token / 时间双预算
- **结构化输出**：agent 调用支持 `schema` 参数，通过 structured-output tool 保证 JSON 输出

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

## 架构

四层 + 共享域模型，依赖方向严格向下：

```
┌─────────────────────────────────────────┐
│  Factory (index.ts)                     │  纯胶水：事件注册 + 调用 register*
├─────────────────────────────────────────┤
│  Interface (src/interface/)             │  Pi API 表面：参数解析 → 调用 Engine → 格式化输出
├─────────────────────────────────────────┤
│  Engine (src/engine/)                   │  状态机 + Worker 协调 + agent 调度 + 预算
├─────────────────────────────────────────┤
│  Infrastructure (src/infra/)            │  子进程执行 / JSONL 解析 / 状态持久化 / 文件扫描
└─────────────────────────────────────────┘
          ↕ 所有层共享
┌─────────────────────────────────────────┐
│  Domain Model (src/domain/)             │  纯数据 + 状态机，零依赖
└─────────────────────────────────────────┘
```

依赖规则：Factory → Interface → Engine → Infrastructure。任何层 → Domain Model。反向禁止。

## 文件结构

```
workflow/
├── index.ts                              # Factory — 纯胶水，~150 行
└── src/
    ├── index.ts                          # 工厂入口
    ├── domain/
    │   └── state.ts                      # WorkflowInstance / 状态机（8 态） / 序列化
    ├── infra/
    │   ├── agent-pool.ts                 # 并发调度（enqueue / drain）
    │   ├── state-store.ts                # 状态持久化（rewrite 模式）
    │   ├── config-loader.ts              # workflow 脚本发现 + meta 提取
    │   ├── agent-opts-resolver.ts        # agent/skill/schema → runAgent opts
    │   ├── execution-trace.ts            # 执行追踪节点
    │   └── script-lint.ts                # 脚本静态 lint
    ├── engine/
    │   ├── orchestrator.ts               # 编排核心：状态机 + 协调
    │   ├── worker-manager.ts             # Worker 线程生命周期
    │   ├── agent-executor.ts             # agent 调用执行 + 重试
    │   ├── worker-script.ts              # Worker 运行时代码生成
    │   ├── orchestrator-events.ts        # 实时事件订阅 API
    │   ├── orchestrator-budget.ts        # Token/Cost/时间预算
    │   └── model-resolver.ts             # 模型解析（显式 > scene > 默认）
    └── interface/
        ├── tool-workflow.ts              # workflow tool (pause/resume/abort/status)
        ├── tool-workflow-run.ts          # workflow-run tool (name/mode/args)
        ├── tool-generate.ts              # workflow-generate tool (脚本生成)
        ├── tool-lint.ts                  # workflow-lint tool (静态检查)
        ├── commands.ts                   # /workflow + /workflows 命令
        └── views/
            ├── WorkflowsView.ts          # 全屏三级导航 TUI
            └── format.ts                 # 纯格式化函数
```

> **依赖说明**：workflow 现在依赖 `@zhushanwen/pi-subagents` 包进行进程内 agent 执行，替换了旧的 `spawn pi` 子进程模式。`infra/` 不再包含子进程管理和 JSONL 流式解析代码。
