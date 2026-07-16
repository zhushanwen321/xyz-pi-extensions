# xyz-pi-extensions

[Pi](https://github.com/badlogic/pi-mono) coding agent 的扩展插件集合。pnpm monorepo。

## 自研扩展

| 包名 | 说明 | 详情 |
|------|------|------|
| **coding-workflow** | 5 阶段编码工作流（spec → plan → dev → test → pr），门控 + review + retrospect | [→ README](./extensions/coding-workflow/README.md) |
| **goal** | `/goal` 目标驱动自主循环，任务追踪 + 证据验证 + 预算控制 | [→ README](./extensions/goal/README.md) |
| **subagent-workflow** | subagent + workflow 合并包：任务委派 + 多 Agent 编排（chain/parallel/scatter-gather/map-reduce），单包统一执行链 + 分层配额 | — |
| ~~**workflow**~~ | ⚠️ **DEPRECATED**（ADR-030）。已合并入 `subagent-workflow`，新项目请用 `@zhushanwen/pi-subagent-workflow` | [→ README](./extensions/workflow/README.md) |
| **context-engineering** | 渐进式上下文压缩（L0/L1/L2）+ recall 召回 | [→ README](./extensions/context-engineering/README.md) |
| **todo** | 轻量级三态任务清单，session 持久化 | [→ README](./extensions/todo/README.md) |
| **vision** | 多模态图片分析工具，会话隔离 | [→ README](./extensions/vision/README.md) |
| **statusline** | 自定义状态栏（上下文用量、Token 速度、套餐额度） | [→ README](./extensions/statusline/README.md) |
| **evolve-daily** | 每日进化数据采集 + `/evolve` 分析建议 | [→ README](./extensions/evolve-daily/README.md) |
| **unified-hooks** | 统一 hooks 管理器（edit 空白自动修复等） | [→ README](./extensions/unified-hooks/README.md) |
| **taste-lint** | 代码品味 ESLint 规则集（5 条自定义规则） | [→ README](./shared/taste-lint/README.md) |
| **types** | 共享类型定义（私有，不发布） | [→ README](./shared/types/README.md) |

## 第三方推荐插件

| 包名 | 说明 | 安装 |
|------|------|------|
| ~~**pi-subagents**~~ | ⚠️ **DEPRECATED**（ADR-030）。任务委派 + workflow 编排已合并入 `@zhushanwen/pi-subagent-workflow`，推荐改用 | `pi install npm:@zhushanwen/pi-subagent-workflow` |
| **pi-mcp-adapter** | MCP 协议适配器，连接 MCP 服务器并调用其工具 | `pi install npm:pi-mcp-adapter` |
| **coding-visualizer** | 生成可视化 HTML 页面（架构图、diff review、计划审查、数据表格） | `pi install npm:coding-visualizer` |
| **pi-annotate** | 视觉标注工具，在浏览器中选择元素并添加评论 | `pi install npm:pi-annotate` |
| **pi-rewind-hook** | Git 自动检查点，支持文件/对话回退恢复 | `pi install npm:pi-rewind-hook` |

均来自 [nicobailon](https://github.com/nicobailon)。

## 安装方式

### 正式安装（npm）

```bash
pi install npm:@zhushanwen/pi-<name>
```

### 本地开发测试（symlink）

```bash
ln -s $(pwd)/extensions/<name> ~/.pi/agent/extensions/<name>
```

修改代码后 `/reload` 即可生效。

### 临时测试（不修改配置）

```bash
pi -e ./extensions/<name>
```

> 注：`shared/` 下的包（taste-lint、types）为内部共享库，不作为扩展单独安装，由扩展在构建时引用。

## License

MIT
