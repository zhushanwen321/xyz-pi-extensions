# xyz-pi-extensions

[Pi](https://github.com/badlogic/pi-mono) coding agent 的扩展插件集合。pnpm monorepo。

## 自研扩展

| 包名 | 说明 | 详情 |
|------|------|------|
| **coding-workflow** | 5 阶段编码工作流（spec → plan → dev → test → pr），门控 + review + retrospect | [→ README](./packages/coding-workflow/README.md) |
| **goal** | `/goal` 目标驱动自主循环，任务追踪 + 证据验证 + 预算控制 | [→ README](./packages/goal/README.md) |
| **workflow** | 多 Agent 编排引擎，JS 脚本驱动，agent / parallel / pipeline API | [→ README](./packages/workflow/README.md) |
| **context-engineering** | 渐进式上下文压缩（L0/L1/L2）+ recall 召回 | [→ README](./packages/context-engineering/README.md) |
| **todo** | 轻量级三态任务清单，session 持久化 | [→ README](./packages/todo/README.md) |
| **vision** | 多模态图片分析工具，会话隔离 | [→ README](./packages/vision/README.md) |
| **statusline** | 自定义状态栏（上下文用量、Token 速度、套餐额度） | [→ README](./packages/statusline/README.md) |
| **evolve-daily** | 每日进化数据采集 + `/evolve` 分析建议 | [→ README](./packages/evolve-daily/README.md) |
| **skill-state** | 自动 skill 执行追踪，状态机生命周期管理 | [→ README](./packages/skill-state/README.md) |
| **unified-hooks** | 统一 hooks 管理器（edit 空白自动修复等） | [→ README](./packages/unified-hooks/README.md) |
| **claude-rules-loader** | 加载 `.claude/rules/` 到 Pi system prompt | [→ README](./packages/claude-rules-loader/README.md) |
| **taste-lint** | 代码品味 ESLint 规则集（5 条自定义规则） | [→ README](./packages/taste-lint/README.md) |
| **types** | 共享类型定义（私有，不发布） | [→ README](./packages/types/README.md) |

## 第三方推荐插件

| 包名 | 说明 | 安装 |
|------|------|------|
| **pi-subagents** | 任务委派：single / parallel / chain / async 模式，subagent 可复用 session | `pi install npm:pi-subagents` |
| **pi-mcp-adapter** | MCP 协议适配器，连接 MCP 服务器并调用其工具 | `pi install npm:pi-mcp-adapter` |
| **visual-explainer** | 生成可视化 HTML 页面（架构图、diff review、计划审查、数据表格） | `pi install npm:visual-explainer` |
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
ln -s $(pwd)/packages/<name> ~/.pi/agent/extensions/<name>
```

修改代码后 `/reload` 即可生效。

### 临时测试（不修改配置）

```bash
pi -e ./packages/<name>
```

## License

MIT
