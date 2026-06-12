# Claude Code 注入提示词提取

来源：`~/.llm-simple-router/logs/2026-06-09/10/44157d43-7140-49c3-a06e-93bb287a6464.json`
提取时间：2026-06-09

## 文件索引

| 文件 | 内容 | 大小 |
|------|------|------|
| [system-prompts.md](./system-prompts.md) | 3 条 system message + system-reminder（身份/环境/行为规则/CLAUDE.md/ultracode） | 9.3KB |
| [tool-descriptions-core.md](./tool-descriptions-core.md) | 30 个核心工具的完整描述（Agent/Skill/Workflow/Bash/Read/Write/Edit 等） | 7.7KB |
| [tool-descriptions-mcp.md](./tool-descriptions-mcp.md) | 50 个 MCP 工具分组摘要（chrome-devtools/fetch/memory/MiniMax/PostgreSQL/web-search） | 4.0KB |
| [skill-list.md](./skill-list.md) | 56 个 skill 完整列表 + 带描述的热门 skill | 6.0KB |

## 注入层级

```
┌─ System Messages (3 条，不可见)
│  [0] billing header
│  [1] 身份声明
│  [2] 核心行为规则（7405 字符）
│
├─ system-reminder (注入在 user message 中)
│  [msg-0] CLAUDE.md 全文（global + project + rules）
│  [msg-4] skill 列表 + ultracode opt-in 确认
│
└─ Tools (81 个工具定义)
   核心工具：Agent, Skill, Workflow, Bash, Read, Write, Edit
   MCP 工具：chrome-devtools, fetch, memory, PostgreSQL, web-search, MiniMax
```

## 关键发现

### Ultracode 触发机制
- 用户在 prompt 中包含 `ultracode` 关键词
- system-reminder 确认："The user included the keyword 'ultracode', opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request."
- Ultracode 模式下：对所有实质性任务默认使用 workflow

### Structured Output 实现
- Claude Code 没有独立的 StructuredOutput 工具
- 内嵌在 `agent()` 函数中：传入 `schema` 参数时，agent 内部调用 StructuredOutput 工具
- 返回已解析的 JS 对象（不是字符串）

### Workflow 工具特点
- 支持 ESM 模块语法（`export const meta`）
- 禁止文件系统访问、`Date.now()`、`Math.random()`
- 支持 resume（基于 runId 的增量执行）
- 内置多种质量模式模板（adversarial verify、loop-until-dry 等）
