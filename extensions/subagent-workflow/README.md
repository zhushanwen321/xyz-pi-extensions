# @zhushanwen/pi-subagent-workflow

Pi 的 subagent + workflow 合并包：任务委派 + 多 agent 编排（chain / parallel / scatter-gather / map-reduce），单包统一执行链 + 分层配额（ADR-030）。

## 内置 Agents

| Agent | 角色 | 是否执行 |
|-------|------|---------|
| `context-builder` | 模糊需求 → 可执行规格（meta-prompt） | 只写 what |
| `planner` | 已明确需求 → 有序实施步骤 | 只写 how |
| `explorer` | 代码库结构摸底（只读） | 不改文件 |
| `researcher` | 外部资料 / 竞品 / 文档调研 | 不改文件 |
| `worker` | 编码 / 修复 / 文件操作 | 可改文件 |
| `reviewer` | 代码质量审查、找 bug | 只读 |
| `oracle` | 需求对齐核验 | 只读 |
| `orchestrator` | **纯协调器**：拆解 + 委派，不直接执行 | 只协调 |
| `general-purpose` | 兜底，无角色假设 | 按需 |

## Orchestrator 协调器模式

主 agent 禁用 bash / read / write / edit 等执行工具，只保留协调类工具，被迫作为纯协调器：拆解任务 → 委派 subagent → 汇总结果。orchestrator agent 自身也可递归委派子 orchestrator，实现分层任务拆解（深度受 `Depth: N/10` 护栏保护）。

可用工具仅 4 个：`todo`、`goal_control`、`workflow`、`subagent`。

### 启动命令

```bash
# 方式一：CLI 工具白名单（临时验证最快）
pi --tools todo,goal_control,workflow,subagent

# 方式二：白名单 + 注入 orchestrator 的 system prompt（推荐，主进程也具备协调器视角）
pi --tools todo,goal_control,workflow,subagent \
   --append-system-prompt "$(cat ~/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/agents/orchestrator.md)"
```

> **依赖**：需先安装本包及相关扩展
> ```bash
> pi install npm:@zhushanwen/pi-subagent-workflow
> pi install npm:@zhushanwen/pi-todo
> pi install npm:@zhushanwen/pi-goal
> ```
> `--tools` 白名单按 tool 注册名匹配。注意 goal 扩展注册的 tool 名是 `goal_control`（非 `goal`）。

### 递归深度

系统内置 `n = 10` 深度护栏（fork 链 + 嵌套取 max），超过抛 `ForkDepthExceededError`。实测建议控制在 **3-4 层**以内——更深层会因上下文逐层压缩导致信息失真。

## 安装

```bash
pi install npm:@zhushanwen/pi-subagent-workflow
```

## License

MIT
