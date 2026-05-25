---
verdict: pass
---

# Ad-hoc Workflow Generation

## Background

Workflow Extension 当前只能运行预先生成的 `.js` 脚本文件。用户需要一种方式：用自然语言描述任务，AI 生成 workflow 脚本并执行。执行后可选择性保存为固定 workflow，供后续复用。

## Outcomes

用户可以用自然语言描述任务（如"批量审查 src/ 下的代码"），AI 自动生成 workflow 脚本或复用已有脚本，展示给用户确认后执行。成功标准：用户不需要手写 JS 脚本，也不需要知道 workflow 文件名，就能通过一次 `/workflow <描述>` 完成自动化任务。

## Functional Requirements

### FR1: `/workflow <prompt>` 智能路由

**FR1.1** 当用户输入 `/workflow <自然语言描述>` 且不是已知子命令（run/list/abort/save）时，命令 handler：
1. 调用 config-loader 获取所有可用 workflow 列表（saved + tmp，包含 name + description + source + path）
2. 通过 `api.sendUserMessage()` 将用户原始输入和完整 workflow 列表传回 AI

**FR1.2** AI 收到消息后判断：
- 匹配优先级：精确匹配 name → 匹配 description 关键词 → AI 语义判断
- 如果 ≥1 个已有 workflow（saved + tmp 均参与匹配）与用户意图匹配，AI 可 read 匹配 workflow 的脚本内容评估适配度，列出匹配项让用户选择：执行已有 workflow 或新建
- 如果无匹配，AI 直接生成新 workflow

**FR1.3** 所有 workflow 执行前必须让用户确认。确认机制：AI 展示脚本路径后自然停顿等待用户下一轮输入。用户确认（如"执行"、"OK"、"继续"）后 AI 调用 `workflow-run`。

### FR2: `workflow-generate` Tool

**FR2.1** 新增 `workflow-generate` tool，参数：
- `name`: string（必需，AI 生成的短名称，如 `batch-review-src`）
- `script`: string（必需，完整 JS 脚本内容）
- `description`: string（可选，用途描述，用于 list 展示）

**FR2.2** Tool 行为：
1. 验证 script 包含 `const meta = { name, description, phases }` 导出
2. 验证 name 不与已有 saved/tmp workflow 冲突——冲突时直接报错，让 AI 更换名称重试（与 FR3.3 统一策略）
3. 对 script 做 `new Function(script)` 语法校验（不执行），失败时返回 `{ isError: true, content: "语法错误: ..." }`
4. 自动创建 `.pi/workflows/.tmp/` 目录（如不存在）
5. 写入 `.pi/workflows/.tmp/{name}.js`
6. 返回 `{ content: [{ text: "脚本已生成: .pi/workflows/.tmp/{name}.js" }], details: { path, name, status: "ready" } }`

**FR2.3** AI 收到返回后展示脚本路径给用户，等用户确认后调用 `workflow-run`。

### FR3: `/workflow save` 命令

**FR3.1** `/workflow save <tmp-name>` — 将 `.pi/workflows/.tmp/{name}.js` 移动到 `.pi/workflows/{name}.js`

**FR3.2** `/workflow save <tmp-name> --as <new-name>` — 保存并重命名

**FR3.3** 如果目标文件已存在，拒绝并提示冲突（与 FR2.2 统一：生成/保存均不做静默重命名）

**FR3.4** 保存不影响正在运行的 workflow（文件移动不阻塞 Worker）

**FR3.5** 保存到 `.pi/workflows/`（项目级），不操作 `~/.pi/agent/workflows/`（用户级 workflow 由用户手动管理）

### FR4: 临时 workflow 存储

**FR4.1** 临时 workflow 存放在 `.pi/workflows/.tmp/` 子目录

**FR4.2** Session 结束时不自动删除临时 workflow

**FR4.3** config-loader 扫描时同时覆盖 3 个目录：`.pi/workflows/`、`~/.pi/agent/workflows/`、`.pi/workflows/.tmp/`

**FR4.4** 扫描结果标记 `source: "saved" | "tmp"`（`.pi/workflows/` 和 `~/.pi/agent/workflows/` 均为 `"saved"`）

**FR4.5** 同名 workflow 去重优先级：`.pi/workflows/.tmp/` > `.pi/workflows/` > `~/.pi/agent/workflows/`。高优先级覆盖低优先级（list 中只显示一个条目，标记为最高优先级的 source）

### FR5: `/workflow list` 展示增强

**FR5.1** 用标签方式展示，统一格式：

```
[saved] demo          — demo workflow with 2 agent calls
[saved] batch-review  — batch code review pipeline
[tmp]   review-src    — review all .ts files in src/
```

**FR5.2** 每个 workflow 显示 `[source]` 标签 + name + description

### FR6: `/workflows` 交互面板增强

**FR6.1** 显示 `[tmp]`/`[saved]` 标签区分来源

**FR6.2** 选中某个 workflow 后显示操作选项：
- `Run` — 执行（展示脚本路径，需用户确认）
- `Save`（仅 tmp workflow）— 调用 `/workflow save` 命令的同一逻辑（复用 commands.ts 的 save handler）
- `Delete` — 删除脚本文件（如果 workflow 正在运行则拒绝删除，返回提示）

**FR6.3** 删除操作检查：如果目标 workflow 有 running 状态的实例，拒绝删除并提示先 abort

## Decisions

| 决策 | 选择 | 原因 | 替代方案 |
|------|------|------|---------|
| 路由机制 | `api.sendUserMessage()` 传 workflow 列表给 AI | 扩展命令 handler 无法直接调用 LLM，需要回到 AI 上下文 | 命令 handler 内嵌 AI 调用（扩展不应直接依赖 LLM） |
| 语法校验 | `new Function(script)` | 只检查语法不执行，Worker 中用 `eval` 模式，`new Function` 与 Worker 行为一致 | `node --check`（需要 spawn 子进程，增加延迟） |
| 冲突策略 | 统一拒绝+报错 | 避免 `-2` 后缀导致的意外行为，让 AI 明确知道冲突并做出有意义的重命名 | 自动追加后缀（用户不知道实际名称是什么） |
| 确认机制 | AI 展示路径后自然停顿 | Pi 扩展无模态 confirm API，自然停顿是最简单可靠的方式 | `ctx.ui.confirm()`（不确定是否可用） |
| 临时文件清理 | 不自动删除 | 用户可能事后想保存，自动删除会造成数据丢失 | Session 结束时清理（可能丢失有用脚本） |
| 保存范围 | 仅保存到 `.pi/workflows/` | 用户级路径是全局共享的，扩展不应自动修改 | 同时支持保存到用户级（增加复杂度，收益低） |
| 面板 Save 实现 | 复用 commands.ts save handler | 同一逻辑只实现一次，避免两个代码路径 | 面板独立实现（代码重复，行为可能不一致） |

## Acceptance Criteria

**AC1** 用户输入 `/workflow 批量审查 src/ 下的代码`，AI 收到可用 workflow 列表 + 用户原始 prompt，AI 判断后生成新 workflow 脚本，展示路径 `.pi/workflows/.tmp/{name}.js`，用户确认后执行

**AC2** 用户输入 `/workflow 批量审查代码`，如果已有匹配的 `batch-review` workflow，AI 列出匹配项（含 name、description、source 标签）让用户选择复用或新建

**AC3** 新生成的 workflow 脚本写入 `.pi/workflows/.tmp/{name}.js`，`/workflow list` 中显示为 `[tmp]` 标签

**AC4** 用户执行 `/workflow save review-src-abc`，文件从 `.tmp/` 移动到 `.pi/workflows/`，`/workflow list` 中变为 `[saved]` 标签

**AC5** 用户执行 `/workflow save review-src-abc --as batch-review-v2`，保存并重命名

**AC6** 所有 workflow 执行前，AI 展示脚本路径（如 `.pi/workflows/.tmp/batch-review-src.js`），自然停顿等待用户确认

**AC7** `workflow-generate` tool 拒绝不包含 `const meta = { name, description, phases }` 的脚本，返回 isError + 错误信息

**AC8** 正在运行的 workflow 执行 `/workflow save` 不影响运行中的 Worker

**AC9** `workflow-generate` 名称冲突时返回错误，AI 更换名称后重试成功

**AC10** `.pi/workflows/.tmp/` 目录不存在时，`workflow-generate` 自动创建

## Constraints

- 所有改动限于 `workflow/` 扩展内的现有文件 + 1 个新增 tool
- 临时目录 `.pi/workflows/.tmp/` 需要在首次写入时自动创建（mkdir -p）
- `workflow-generate` 的语法校验用 `new Function(script)` 而非 `require()`
- 不改变现有 `workflow-run` tool 的行为
- 不改变 `worker_threads` 执行模型
- `/workflow <prompt>` 的智能路由依赖 `api.sendUserMessage()`
- 错误处理：IO 错误（磁盘满、权限不足）由 tool 的 throw 机制自然传递给 AI

## Verification

- **类型检查**：`npx tsc --noEmit` 通过
- **ESLint**：`npx eslint workflow/src/ --quiet` 通过
- **手动验证**：
  1. `/workflow 批量审查代码` → AI 收到 workflow 列表 → 新建或复用 → 展示路径 → 用户确认 → 执行
  2. `/workflow save <name>` → 文件从 .tmp 移到 .pi/workflows/
  3. `/workflow list` → 显示 [tmp]/[saved] 标签
  4. `workflow-generate` name 冲突 → 报错

## Complexity Assessment

**L2** — 单 Pi 扩展内的功能增强，但涉及 4-5 个文件改动（commands.ts 路由逻辑较复杂、config-loader 新增扫描、widget 增强交互、index.ts 新增 tool、state.ts 可能需要 source 字段）。智能路由的 workflow 列表传递和 sendUserMessage 拼接有一定复杂度。
