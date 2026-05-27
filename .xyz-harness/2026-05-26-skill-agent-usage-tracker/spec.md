---
verdict: pass
---

# Skill & Agent Usage Tracker

## Background

Pi agent 拥有大量 skill 和 agent，但没有使用数据来指导管理决策。用户希望了解哪些 skill/agent 被高频使用、哪些几乎不用，以便做出删除、整合或新增的决策。

当前 Pi 的事件 API 提供了 `tool_call`、`before_agent_start` 等事件，可以无侵入地拦截 skill 文件读取和 agent 调用。

## Functional Requirements

### FR-1: Skill 使用计数

Extension 监听 `tool_call` 事件，当 `toolName === "read"` 时，检查读取路径是否匹配已知 skill 文件路径。匹配成功则递增该 skill 的计数器。

- 匹配规则：读取路径 `resolve` 后与 skill 的 `filePath` `resolve` 后进行精确匹配。Skill 的 `filePath` 就是 `baseDir + "/SKILL.md"`，单条规则即可覆盖
- 计数单位：skill 全文被读取到 session 中的次数（不是 description 被列出的次数）

### FR-2: Agent 使用计数

Extension 监听 `tool_call` 事件，当 `toolName === "subagent"` 时，从参数中提取所有 agent 名称并递增计数器：

- `agent` 字段（single 模式）
- `tasks[].agent`（parallel 模式）
- `chain[].agent`（chain 模式）

### FR-3: Skill 路径映射构建

Extension 在 `before_agent_start` 事件中从 `systemPromptOptions.skills` 获取当前 session 已加载的 `Skill[]` 列表，构建 `filePath → skillName` 的反向映射表。映射表存储在闭包变量中，每个 session 独立重建。

**时序保证**：Pi 运行时保证 `before_agent_start` 在该 turn 的所有 `tool_call` 之前触发。因此映射表在 `tool_call` 处理时一定已就绪。

**防御性 guard**：`tool_call` 处理中若映射表为空（理论上不应发生），跳过匹配并输出 `console.error` 日志。

### FR-4: 跨 session 持久化

使用计数持久化到 `~/.pi/agent/usage-stats.json`（`~` 通过 `os.homedir()` 解析），格式：

```json
{
  "skills": { "skill-name": 5 },
  "agents": { "general-purpose": 12 },
  "updatedAt": "2026-05-26T10:30:00Z"
}
```

- **写入策略（防竞争）**：每次写入前重新读取文件最新内容，在最新值基础上递增后写回。即 read-modify-write 每次都从磁盘读取最新状态，避免内存中的过期数据覆盖其他 session 的写入
- Extension 启动时（`session_start`）读取已有文件到内存
- 写入失败时输出 `console.error` 日志（含 error 对象），不阻塞 Pi 主流程
- **已知限制**：跨 Pi 进程（不同终端窗口各自启动 Pi）的极端并发场景下，仍可能丢失极少量计数（两次 read-modify-write 之间有窗口期）。单进程多 session 场景下无此问题（Node.js 单线程 + sync I/O 保证串行）。此限制可接受

### FR-5: 日志输出

Extension 在以下关键节点输出 `console.error` 日志：

- skill 路径匹配成功时：输出 skill name 和文件路径
- agent 计数递增时：输出 agent name
- 文件写入失败时：输出 error 对象和文件路径
- 文件读取/解析失败时：输出 error 对象

### FR-6: 分析 Skill（usage-analyzer）

提供独立 skill `usage-analyzer`，用于分析 `~/.pi/agent/usage-stats.json` 中的数据：

- 指导 agent 读取数据文件的路径和 JSON 结构
- 提供 4 个分析维度：使用频率排序、零使用检测、关联分析（标注为未来扩展）、时间趋势（标注当前只记录总计数的限制）
- 提供决策建议分类模板：删除候选、整合候选、保留、新增候选
- 同时覆盖 skill 和 agent 两类资源的分析

## Acceptance Criteria

- AC-1: Extension 安装后，Pi session 中 AI 读取某个 skill 的 SKILL.md 全文时，`usage-stats.json` 中该 skill 的计数 +1
- AC-2: AI 调用 subagent tool 并指定 agent name 时，`usage-stats.json` 中该 agent 的计数 +1（无论 single/parallel/chain 模式）
- AC-3: 多个 Pi session 各自独立计数，累加写入同一文件。单进程多 session 不互相覆盖。跨 Pi 进程极端并发场景下接受极少计数丢失（FR-4 已文档化此限制）
- AC-4: Extension 写入文件失败时，Pi 主流程不受影响，stderr 输出包含 error 信息的日志
- AC-5: `usage-analyzer` skill 被加载后，agent 能正确读取数据文件并按分析框架给出建议
- AC-6: Extension 不注册任何 tool、command、widget，纯被动采集

## Constraints

- 技术栈：TypeScript，Pi Extension API（`@mariozechner/pi-coding-agent`），typebox
- 运行环境：Pi 进程内执行，使用 `fs.readFileSync` / `fs.writeFileSync` 操作数据文件
- 扩展无自身 `node_modules`，所有依赖由 Pi 运行时提供
- 单文件上限 1000 行，单函数上限 80 行
- 数据文件路径固定为 `~/.pi/agent/usage-stats.json`
- Extension 放置于项目 `usage-tracker/` 目录
- Skill 放置于项目 `usage-analyzer/` 目录（包含 SKILL.md）
- 安装方式：Extension 通过 symlink 到 `~/.pi/agent/extensions/usage-tracker`；Skill 通过 symlink 到 `~/.pi/agent/skills/usage-analyzer`

## 业务用例

### UC-1: 分析 skill 使用模式，优化 skill 配置

- **Actor**: 用户
- **场景**: 用户积累了大量 skill，不确定哪些在用、哪些可以清理
- **预期结果**: 用户或 agent 加载 `usage-analyzer` skill，读取统计数据，获得高频/低频/零使用 skill 列表和管理建议

## Complexity Assessment

**Low**。核心逻辑是 3 个事件监听器 + 1 个 JSON 文件读写。Extension 预计 < 200 行。Skill 是纯 Markdown 内容，不含代码。
