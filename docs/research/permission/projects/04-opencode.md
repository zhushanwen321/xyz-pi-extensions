# OpenCode 权限机制调研报告

**调研日期**：2026-07-27 | **置信度**：高（本地源码 v1+v2 双版本 + 官方文档双源佐证，v1/v2 差异处单独说明）
**调研方式**：researcher subagent，本地源码（`~/GitApp/ai-agent/opencode-anomaly/`，v2 重写版含 v1 legacy）+ 官方文档

---

## 重要前提：本地源码是 v2 重写版

本地 `~/GitApp/ai-agent/opencode-anomaly/` 是 OpenCode 的 **v2 重写**（纯 TypeScript，用 Effect 框架），不是早期 Go 版本。仓库里同时存在两套实现：
- **v1（legacy，位于 `packages/opencode/src/`）** — 当前文档站 (`opencode.ai/docs`) 描述的就是这套；功能最完整，含 bash AST 解析。
- **v2/core（位于 `packages/core/src/`）** — 新架构，权限三态模型已重写，但 **bash AST 审查尚未移植**（代码里有显式 TODO）。

下面分别标注来自哪套实现。置信度普遍很高（源码 + 官方文档双重佐证），只在 v1/v2 有差异处单独说明。

---

## 1. 权限决策三态模型（allow / ask / deny）— 置信度：高

**三态定义**（v1/v2 一致，`packages/schema/src/permission.ts:54`，`packages/core/src/v1/config/permission.ts:5`）：
- `"allow"` — 自动放行，无需审批
- `"ask"` — 弹窗等用户审批
- `"deny"` — 直接拦截，不让 LLM 调用

**多资源合并语义（v2 关键特色）**：一条 tool 调用可能涉及多个 resource（比如 bash 命令引用了多个外部目录），逐个评估后合并（`packages/core/src/permission.ts:155-162`）：

```ts
const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
const effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
```

即 **deny 优先 > ask > allow**。这与官方文档 "OpenCode denies the operation if any resource resolves to deny; otherwise it asks if any resolves to ask; otherwise it allows it" 完全吻合。

**默认决策（缺省规则集）**：当没有任何规则匹配时，`evaluate()` 返回 `{ effect: "ask" }`（`packages/core/src/permission.ts:80-85`）。但实际启动时 agent 都注入了 `defaults`（见第 5 节），所以用户体感默认是 allow。

**Reply（用户审批回复，三态）**（`packages/schema/src/permission.ts:40`）：
- `"once"` — 本次放行
- `"always"` — 记住决策（持久化粒度见第 7 节）
- `"reject"` — 拒绝，并可附 feedback 文本让 LLM 改方案

---

## 2. Agent frontmatter 权限定义（核心特色）— 置信度：高

### 2.1 完整结构

agent 配置 schema：`packages/core/src/v1/config/agent.ts:12-41`。frontmatter 支持字段（关键字段）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `"subagent" \| "primary" \| "all"` | primary=主对话 agent；subagent=被 task 工具调起；all=两者皆可 |
| `permission` | 见下 | 权限规则块（**v1 用单数 `permission`，v2 用复数 `permissions`**） |
| `tools` | `Record<string, boolean>` | **已废弃**，自动归一化为 permission（true→allow, false→deny） |
| `description` / `prompt` / `model` / `color` / `steps` / `hidden` | 各类型 | agent 元数据 |

### 2.2 permission 块语法（v1，对应当前文档）

schema：`packages/core/src/v1/config/permission.ts:17-36`。两种形式：

**简写（标量）**：
```json
{ "permission": "allow" }   // 等价于 { "*": "allow" }
```

**对象形式（按 tool 名 + 模式）**：
```json
{
  "permission": {
    "*": "ask",
    "bash": "allow",
    "edit": "deny",
    "bash": { "*": "ask", "git *": "allow", "git push *": "deny" }
  }
}
```

**已识别的 permission key**（`packages/core/src/v1/config/permission.ts:19-33`，全部走 `Rule` = Action | Object 除非特别注明只能 Action）：
- `read` / `edit`（涵盖 edit/write/patch）/ `glob` / `grep` / `list` / `bash` / `task` / `lsp` / `skill` — 支持 object 细粒度
- `todowrite` / `question` / `webfetch` / `websearch` / `doom_loop` — 只支持标量 Action
- `external_directory` — 支持 object
- **额外**：用 `Schema.StructWithRest` 允许任意未知 key（向后兼容，新工具自动可用）

**Markdown frontmatter 例子**（官方文档原文，`packages/web/src/content/docs/permissions.mdx:241-253`）：
```markdown
---
description: Code review without edits
mode: subagent
permission:
  edit: deny
  bash: ask
  webfetch: deny
---
Only analyze code and suggest changes.
```

### 2.3 规则内部转换：`fromConfig()`

配置对象 → 扁平 Ruleset（`packages/opencode/src/permission/index.ts:186-198`）：
- 标量 `{ bash: "allow" }` → `{ permission: "bash", action: "allow", pattern: "*" }`
- 对象 `{ bash: { "git *": "allow" } }` → `{ permission: "bash", pattern: "git *", action: "allow" }`
- pattern 走 `expand()` 展开 `~/`、`$HOME/`（`index.ts:178-184`）

v2 改名：v1 是 `{ permission, pattern, action }`，v2 是 `{ action, resource, effect }`（`packages/schema/src/permission.ts:57-62`）。语义等价。

### 2.4 通配符 `*` 匹配逻辑 — 置信度：高

`packages/core/src/util/wildcard.ts:3-14`（v1/v2 共用）：

```ts
function match(input, pattern) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern.replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // 转义正则元字符
    .replace(/\*/g, ".*")                   // * → 任意字符序列
    .replace(/\?/g, ".")                    // ? → 单个字符
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"  // 末尾 " *" 可选
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}
```

关键点：
- `*` 匹配**零或多个任意字符**（注意是 `.*`，即 greedy 全匹配）
- `?` 匹配**正好一个**字符
- 其他字符**字面匹配**（正则元字符自动转义）
- 路径分隔符 `\` 归一为 `/`
- 特殊优化：`"bash *"` 这种末尾带 ` *` 的，会变成可选分组，所以 `"git *"` 也能匹配裸 `"git"`
- `s` flag 让 `.` 也匹配换行；Windows 加 `i` 大小写不敏感

文档佐证（`permissions.mdx:93-99`）："`*` matches zero or more of any character, `?` matches exactly one character, all other characters match literally"。

### 2.5 last-match-wins — 置信度：高

核心实现就一行 `findLast()`（`packages/core/src/permission.ts:80`，`packages/opencode/src/permission/index.ts:32`）：

```ts
rulesets.flat().findLast((rule) =>
  Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)
) ?? { action, resource: "*", effect: "ask" }
```

- 把所有 ruleset **扁平化成一个数组**，从后往前找第一个同时匹配 action + resource 的规则
- **后写的规则覆盖先写的**
- 文档建议："put the catch-all `*` first, and more specific rules after it"（`permissions.mdx:91`）

**合并顺序**（agent 配置层面，`packages/opencode/src/agent/agent.ts:145-152`）：
```
Permission.merge(defaults, agentSpecificRules, userConfig)
```
即：`defaults` 在前 → agent 自己的规则在后（覆盖 defaults）→ 用户全局 `opencode.json` 的 permission 最后（最高优先级，能覆盖 agent 默认）。

注意 v1 的 `merge` 就是 `[...a, ...b, ...c]`（`packages/opencode/src/permission/index.ts:200-202`），靠数组顺序 + findLast 实现。

### 2.6 primary / sub-agent 权限继承 — 置信度：高

**默认**：subagent **不继承** parent 的权限，用自己的规则集。但有特例（`packages/opencode/src/agent/subagent-permissions.ts:14-27`）：

subagent 被 task 工具调起时，其 session 的 ruleset = parent 的 deny 规则 + parent 的 external_directory 规则 + subagent 自己的规则 + 默认补的 `todowrite: deny` / `task: deny`（除非 subagent 自己显式声明）。

注意文档还提了一条："Users can always invoke any subagent directly via the @ autocomplete menu, even if the agent's task permissions would deny it" — 即 task 工具的 deny 只限制 LLM 自动调起，不限制用户手动 @ 调用。

---

## 3. bash 命令审查机制 — 置信度：高

这是重点。**OpenCode v1 用 AST 解析（tree-sitter），不用 AI 审查**。

### 3.1 v1（当前文档版本，完整实现）

文件：`packages/opencode/src/tool/shell.ts`。流程：

1. **tree-sitter AST 解析**（`shell.ts:311-333`）：
   ```ts
   const { Parser } = await import("web-tree-sitter")
   // 加载 tree-sitter-bash.wasm 和 tree-sitter-powershell.wasm
   const bash = new Parser(); bash.setLanguage(bashLang)
   const ps = new Parser(); ps.setLanguage(psLang)
   ```
   依赖：`packages/opencode/package.json` 里 `"tree-sitter-bash": "0.25.0"`, `"tree-sitter-powershell": "0.25.10"`, `web-tree-sitter`。

2. **遍历 AST 收集审查对象**（`shell.ts:378-414`，`collect()` 函数）：
   - `commands(root)` = `node.descendantsOfType("command")` — 提取所有 command 节点
   - `parts(node)` — 遍历 command 子节点，过滤出 `command_name` / `word` / `string` / `raw_string` / `concatenation` 等
   - 对每个 command 提取两类信息：
     - **路径参数**：如果 cmd 在 `FILES` 集合里（如 cat/cp/vim），解析它的路径参数，判断是否 external_directory
     - **命令模式**：`scan.patterns.add(source(node))` 把命令文本加入待审批 patterns
     - **BashArity prefix**：`scan.always.add(BashArity.prefix(tokens).join(" ") + " *")` — 见 3.2

3. **生成权限请求**（`shell.ts:263-291`，`ask()` 函数）：
   ```ts
   if (scan.dirs.size > 0) {
     yield* ctx.ask({
       permission: "external_directory",
       patterns: globs,           // 每个外部目录一个 glob
       always: globs,
     })
   }
   yield* ctx.ask({
     permission: "bash",
     patterns: Array.from(scan.patterns),    // 命令文本（含管道/重定向完整表达式）
     always: Array.from(scan.always),        // BashArity prefix 供 "always" 记忆
   })
   ```

### 3.2 BashArity（命令前缀归约）— 置信度：高

文件：`packages/opencode/src/permission/arity.ts`。一个硬编码字典 `ARITY: Record<string, number>`，把命令前缀映射到"应该取前几个 token 当作人类可理解的命令"：
- `git: 2` → `git checkout main` 归约为 `git checkout`（取前 2 个 token）
- `npm: 2`, `npm run: 3` → `npm run dev` 取 3 个的
- `cat: 1`, `rm: 1`, `ls: 1` → 只取命令名

`prefix(tokens)` 函数（`arity.ts:2-9`）：从最长前缀开始倒序匹配，找到第一个有 arity 的，返回 `tokens.slice(0, arity)`；找不到就返回 `tokens.slice(0, 1)`（第一个 token）。

**用途**：当用户对 `git checkout -b feature && npm install` 选 "always" 时，OpenCode 会把每个子命令的 prefix（`git checkout *`、`npm install *`）记成 allow 规则，下次相同 prefix 自动放行。这是"AST 解析 + 启发式归约"的混合，**不是 AI 审查**。

### 3.3 v2 core（重写版，bash AST 尚未移植）— 置信度：高

`packages/core/src/tool/bash.ts:62-77` 有一连串显式 TODO：
```ts
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
```

当前 v2 bash 工具（`bash.ts:122-149`）：
- 只做**纯 token 扫描**（`shellTokens()` 正则切词，`bash.ts:79`）找 external 目录，且明确说 "this scan is advisory only"
- 权限请求直接用原始命令字符串：`permission.assert({ action: "bash", resources: [input.command], save: [input.command] })`
- **没有 AST，没有 BashArity**

### 3.4 有没有 AI 审查？— 置信度：高（确定没有）

grep 全仓 `ai.*review` / `classify.*command` / `llm.*permission` / `model.*approve` 在 permission 流程里**零命中**。所有匹配都是无关代码（code-mode preview、snapshot preview、provider 的 review 命令等）。

**官方 GitHub Issue #33585**（[anomalyco/opencode#33585](https://github.com/anomalyco/opencode/issues/33585)）证实这是社区已知缺口，issue 作者原话：
> "opencode's permission model is per-rule binary: allow (auto-approve), ask (prompt every time), or deny. In agentic sessions there's no middle ground — nothing inspects an actual bash command" to determine if it is safe.

该 issue 提议加一个 LLM classifier gating the would-auto-approve path，但**这是 feature request，尚未实现**。

---

## 4. 权限模式（yolo / auto / approve / strict）— 置信度：高

**OpenCode 没有用户期望的"四模式"体系，只有一个二元开关：`auto` mode（off=normal / on=auto）。** 没有 "strict"、"approve-only-dangerous" 之类的预设模式概念——粒度控制完全靠声明式规则。

### 4.1 CLI 标志

`packages/opencode/src/cli/cmd/tui.ts:108-110` 和 `run.ts:242-274`：

```ts
.option("auto", { describe: "auto-approve permissions that are not explicitly denied (dangerous!)" })
// 合并：
const auto = args.auto || args.yolo || args["dangerously-skip-permissions"]
```

**`--auto`、`--yolo`、`--dangerously-skip-permissions` 是同义词**（tui.ts:294, run.ts:274），都把 PermissionMode 设为 `"auto"`。

### 4.2 TUI 运行时切换

`packages/tui/src/context/permission.tsx:5-26`：PermissionMode = `"auto" | "normal"`，可在 command palette 切换（`app.tsx:947-949`："Enable/Disable auto-approve permissions"）。auto 激活时 prompt 旁显示 `auto` 指示器（文档 `permissions.mdx:38`）。

### 4.3 auto mode 如何生效（关键：客户端拦截，不是服务端 fallback）

`packages/tui/src/context/sync.tsx:190-200`：
```ts
case "permission.asked": {
  const request = event.properties
  if (permission.mode === "auto") {
    void sdk.client.permission.reply({
      requestID: request.id,
      reply: "once",     // 注意：只 reply "once"，不记 "always"
      directory, workspace,
    })
    break
  }
  // 否则把 request 加入 UI 队列等用户操作
}
```

即 **auto mode = 客户端收到 `permission.asked` 事件后立即自动回 `"once"`**。服务端的 ruleset 评估逻辑完全不变。

文档原话（`permissions.mdx:36`）："Auto mode only changes requests that would otherwise ask for approval. Explicit deny rules are still enforced." — 因为 deny 在 `evaluateInput()`（`permission.ts:155-162`）阶段就 throw `BlockedError` 了，根本不会 publish asked 事件。

### 4.4 默认行为 = "yolo"

OpenCode 默认 agent 是 `build`，其 ruleset 第一条是 `"*": "allow"`（`agent.ts:119-120`）。所以**默认就是 yolo**（文档 config 页也说 "By default, opencode allows all operations without requiring explicit approval"）。要"严格"必须切到 `plan` agent 或自己写 permission。

---

## 5. 内置 Agent 的默认权限 — 置信度：高

`packages/opencode/src/agent/agent.ts:119-136`，全局 defaults：
```ts
"*": "allow"
doom_loop: "ask"
external_directory: { "*": "ask", <whitelisted dirs>: "allow" }
question: "deny"          // 仅 build 改成 allow
plan_enter: "deny"        // 仅 build 改成 allow
plan_exit: "deny"         // 仅 plan 改成 allow
read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" }
```

内置 agents（`agent.ts:140-260`）：
- **build**（primary，默认）— 全开 + question/plan_enter allow
- **plan**（primary）— edit 全 deny（只允许写 `.opencode/plans/*.md`），task.general deny
- **general**（subagent）— 全开但 todowrite deny
- **explore**（subagent）— read-only：`*: deny` + 只 grep/glob/list/bash/read/webfetch/websearch allow
- **compaction / title / summary**（hidden）— `*: deny`

---

## 6. 审批交互流程 — 置信度：高

### 6.1 服务端 assert 流程（v2，`packages/core/src/permission.ts:197-218`）

```
tool 调用 permission.assert(input)
  → evaluateInput(input):
      1. 取 agent.permissions（缺省 = deny all）
      2. 若任一 resource 命中 deny → 直接 throw BlockedError（不询问）
      3. 合并 savedRules（持久化的 "always"）
      4. 逐 resource 评估，deny>ask>allow 合并
  → 若 effect="allow"：直接返回
  → 若 effect="ask"：创建 pending Deferred，publish Event.Asked，阻塞等待用户回复
  → 若 effect="deny"：throw BlockedError（带 relevant rules 给 LLM 看）
```

### 6.2 UI（TUI）

`packages/tui/src/routes/session/permission.tsx`：每个 `permission.asked` 事件渲染一个全屏 Prompt，三个按钮 `Allow once | Allow always | Reject`（`permission.tsx:405`）。

- **Allow once** → reply "once"
- **Allow always** → 进入二级确认页，列出"将记忆的 patterns"（`permission.tsx:138-175`），用户确认后 reply "always"
- **Reject** → 进入反馈输入页（`RejectPrompt`，`permission.tsx:443-522`），用户可写 feedback，reply "reject" + message

reject 时（`permission.tsx:431-434`）：服务端会**级联 reject 同 session 的所有 pending 请求**（`permission.ts:237-246`），并 throw `CorrectedError`（带 feedback）或 `DeclinedError`。

### 6.3 metadata 丰富展示

每个 permission 类型在 UI 有定制展示（`permission.tsx:194-381`）：edit 显示 diff、bash 显示 `$ command`、external_directory 列出 patterns、doom_loop 显示"continue after repeated failures"。

### 6.4 always 的级联自动放行

当用户对某请求选 "always"（`permission.ts:250-283`）：写入持久化 → 然后扫描所有同 session 的 pending 请求，凡是新规则集下评估为 allow 的，**自动 reply "always" 并 resolve**。这是"一次审批解锁一批等待"的优化。

---

## 7. 决策持久化（session 内 vs 跨 session）— 置信度：中（v1/v2 不一致，文档滞后）

### 7.1 v1（仅 session 内）

`packages/opencode/src/permission/index.ts:109-167`。`approved: PermissionV1.Rule[]` 存在 `InstanceState`（实例级内存 Map），进程退出即丢。文档（`permissions.mdx:196`）说 "always — approve future requests matching the suggested patterns (for the rest of the current OpenCode session)"，TUI 也明示（`permission.tsx:144,148`）"until OpenCode is restarted"。

### 7.2 v2（已持久化到 SQLite，跨 session）

`packages/core/src/permission/saved.ts` + `packages/core/src/permission/sql.ts`：有持久化 `permission` 表，schema：
```ts
PermissionTable = sqliteTable("permission", {
  id, project_id (FK→project), action, resource, ...Timestamps
}, uniqueIndex(project_id, action, resource))
```

`permission.ts:250-256`：用户 reply "always" 时调 `saved.add({ projectID, action, resources })` 写库；`savedRules()`（`permission.ts:131-135`）每次评估时 `saved.list({ projectID })` 读出转成 `{ effect: "allow" }` 规则合并进去。

**结论**：v2 已经把 "always" 持久化到**项目级数据库**（跨 session、跨重启），但官方 v2 文档（截至 2026-07）仍写"only within session"——**文档滞后于代码**。Pi 移植时按 v2 代码为准更合理。

注意 v2 持久化粒度是 **action + resource**（如 `bash` + `git status --porcelain`），不是 BashArity prefix（v2 还没移植 BashArity）。

---

## 8. 特殊权限类别 — 置信度：高

### 8.1 `external_directory`

触发条件：tool 访问的路径在 OpenCode 启动工作目录**之外**（`packages/core/src/tool/bash.ts:130-137`，`shell.ts:264-280`）。

- 默认 `"ask"`（`agent.ts:122`）
- pattern 是目录 glob（如 `~/projects/personal/**`）
- 通过 `external_directory` 规则授权的目录**继承 workspace 默认权限**（read 默认 allow，但可叠加 `edit: deny` 限制只读）
- v1 bash 用 AST 提取命令里的路径参数（`FILES` 集合里的命令如 cat/cp 才解析参数）；v2 只做 token 级 advisory 扫描

### 8.2 `doom_loop`

触发条件：**同一工具连续调用 3 次、input 完全相同**（`packages/opencode/src/session/processor.ts:29, 356-369`）：

```ts
const DOOM_LOOP_THRESHOLD = 3
const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)
if (recentParts.length === 3 && recentParts.every(part =>
  part.type === "tool" && part.tool === value.name &&
  JSON.stringify(part.state.input) === JSON.stringify(input)
)) {
  yield* permission.ask({ permission: "doom_loop", ... })
}
```

- 默认 `"ask"`（`agent.ts:121`）—— 即默认会拦下问用户"是否继续"
- `always` 模式记忆的 pattern 是 `[toolName]`（`processor.ts:377`）

### 8.3 其他非常规 key

- `question`（让 LLM 反问用户）/ `plan_enter` / `plan_exit`（进入/退出 plan 模式）— 这些是 OpenCode 把"非破坏性交互动作"也纳入了权限框架，不只是文件/命令

---

## 9. 工具/MCP/skill 粒度 — 置信度：高

| 维度 | 粒度 | pattern 匹配对象 |
|---|---|---|
| `read` | 文件路径 | 文件路径 glob（`.env` 默认 ask） |
| `edit` | 文件路径 | 涵盖 edit/write/apply_patch |
| `glob` | glob 模式 | glob 表达式 |
| `grep` | 正则 | 搜索正则 |
| `bash` | 命令 | **parsed command**（v1 是 AST 提取的命令表达式；v2 是原始字符串） |
| `task` | subagent 类型 | subagent 名（如 `general`） |
| `skill` | skill 名 | skill 名 |
| `lsp` | 非细粒度 | 整体 Action |
| `webfetch` | URL | URL pattern |
| `websearch` | 查询 | 查询文本 |
| `question` / `todowrite` / `doom_loop` | 非细粒度 | 整体 Action |

**MCP 工具**：v1 schema 没有专门的 `mcp` permission key（grep 未发现），MCP server 工具按其 tool name 走标准规则（未知 key 走 `Schema.StructWithRest` 兜底，配合 `"*": "allow"` 默认放行）。

---

## 对 Pi 四模式的借鉴价值分析

### 期望模式 ↔ OpenCode 能力对应

| Pi 期望模式 | OpenCode 是否有等价物 | 借鉴价值 |
|---|---|---|
| **yolo 完全访问**（当前默认） | **完全等价**：build agent + `"*": "allow"` defaults。`--auto`/`--yolo`/`--dangerously-skip-permissions` 是同义词 | 高 — 直接照搬"默认 allow-all + auto-approve-on-ask" |
| **自动模式**（AST + AI 审查每次） | **无等价物**。OpenCode 完全不做 AI 审查；AST 解析仅用于**提取审批 pattern**（external dir / BashArity prefix），不是安全判定 | **低（机制层面）/ 高（AST 工具链层面）** — 见下详述 |
| **审批模式**（仅危险命令审批） | **部分等价**：靠声明式规则实现，如 `{ "bash": { "*": "allow", "git push *": "ask", "rm *": "ask" } }` | 高 — 声明式规则 + last-match-wins 是天然适配 |
| **严格审批模式**（所有命令审批） | **完全等价**：plan agent 模式，或全局 `"*": "ask"` | 高 — 直接照搬 |

### 关键结论

1. **OpenCode 的声明式 agent-frontmatter 规则体系对 Pi 的"审批模式"（仅危险命令审批）借鉴价值极高**：
   - `allow/ask/deny` 三态 + object 语法 + 通配符 + **last-match-wins（findLast）** 完美匹配"白名单放行 + 黑名单拦截 + 中间灰区审批"的需求
   - `pi-permission-system` README 说"从 OpenCode 移植"是合理的——这套规则语法、合并语义、wildcard 实现（`packages/core/src/util/wildcard.ts`）几乎可以照抄
   - **特别值得借鉴**：deny>ask>allow 的多 resource 合并（一条命令引用多个文件时的决策），以及 always 的级联自动放行（一次审批解锁一批 pending）

2. **OpenCode 没有"自动模式（AST + AI 审查）"的等价物，Pi 这块必须自创**：
   - OpenCode 的 bash AST（tree-sitter）用途是**信息提取**（找 external 目录、生成 BashArity prefix），不是**安全判定**
   - GitHub Issue #33585 是社区明确提出的"加 LLM classifier"feature request，**截至 2026-07 未实现**
   - OpenCode 的"危险 vs 安全"判定完全靠**用户手写 pattern**（`rm *: deny`、`git push *: deny`），没有自动分类
   - **Pi 的 auto mode（AST 解析结构 + AI 判危险等级）是 OpenCode 缺失的那一环**，可以借 OpenCode 的 AST 工具链（tree-sitter-bash + BashArity prefix 提取）做输入预处理，但**判定逻辑（AI 审查）必须 Pi 自己实现**

3. **模式体系对应**：
   - OpenCode 只有 **2 态**（normal / auto），靠声明式规则表达 4 种模式中的 3 种（yolo/审批/严格）
   - Pi 的"4 模式"本质上是把 OpenCode 的"声明式规则 + auto 开关"重新打包成**预设档位**——可以理解为：Pi 模式 = OpenCode 的预设 ruleset 模板 + 是否启用 AI 审查
   - 建议架构：底层保留 OpenCode 风格的 `Rule[]` + `findLast` 评估引擎（统一），上层用 Pi 的 4 模式作为**预设 ruleset 生成器** + 一个 AI-gate hook（仅 auto 模式启用）

4. **特别值得注意的实现细节**（Pi 可直接抄）：
   - wildcard 末尾 `" *"` 转可选分组（`wildcard.ts:11`）——让 `"git *"` 匹配裸 `"git"`，体验好
   - v2 把 always 持久化到 SQLite（project_id + action + resource 唯一索引）——比 v1 的 session-only 更实用，Pi 应采用
   - doom_loop（连续 3 次相同 input 触发 ask）——非常实用的安全网，建议 Pi 也加
   - subagent 权限继承策略（继承 parent 的 deny + external_directory）——多 agent 场景必备
   - reject 时级联 reject 同 session 所有 pending + 带 feedback 文本（`CorrectedError`）——让 LLM 知道为什么被拒

---

## Sources

本地源码（核心证据）：
- `~/GitApp/ai-agent/opencode-anomaly/packages/schema/src/permission.ts` (v2 schema: Effect/Rule/Ruleset/Reply)
- `~/GitApp/ai-agent/opencode-anomaly/packages/core/src/permission.ts` (v2 评估引擎 + ask/assert/reply)
- `~/GitApp/ai-agent/opencode-anomaly/packages/core/src/permission/saved.ts` + `sql.ts` (v2 持久化)
- `~/GitApp/ai-agent/opencode-anomaly/packages/core/src/util/wildcard.ts` (通配符匹配)
- `~/GitApp/ai-agent/opencode-anomaly/packages/core/src/v1/config/permission.ts` (v1 配置 schema)
- `~/GitApp/ai-agent/opencode-anomaly/packages/core/src/v1/config/agent.ts` (agent frontmatter schema)
- `~/GitApp/ai-agent/opencode-anomaly/packages/opencode/src/permission/index.ts` (v1 服务 + fromConfig + merge)
- `~/GitApp/ai-agent/opencode-anomaly/packages/opencode/src/permission/arity.ts` (BashArity 字典)
- `~/GitApp/ai-agent/opencode-anomaly/packages/opencode/src/tool/shell.ts` (v1 bash AST 审查)
- `~/GitApp/ai-agent/opencode-anomaly/packages/core/src/tool/bash.ts` (v2 bash, TODO 未移植)
- `~/GitApp/ai-agent/opencode-anomaly/packages/opencode/src/agent/agent.ts` (内置 agent + defaults)
- `~/GitApp/ai-agent/opencode-anomaly/packages/opencode/src/agent/subagent-permissions.ts` (subagent 继承)
- `~/GitApp/ai-agent/opencode-anomaly/packages/opencode/src/session/processor.ts:29,356-379` (doom_loop 触发)
- `~/GitApp/ai-agent/opencode-anomaly/packages/opencode/src/config/agent.ts` (markdown agent 加载)
- `~/GitApp/ai-agent/opencode-anomaly/packages/tui/src/context/permission.tsx` + `sync.tsx:190-200` (auto mode 客户端拦截)
- `~/GitApp/ai-agent/opencode-anomaly/packages/tui/src/routes/session/permission.tsx` (审批 UI)
- `~/GitApp/ai-agent/opencode-anomaly/packages/web/src/content/docs/permissions.mdx` + `agents.mdx` (官方文档源)

官方文档与 GitHub：
- [OpenCode Permissions 官方文档](https://opencode.ai/docs/permissions/)
- [OpenCode Agents 官方文档](https://opencode.ai/docs/agents/)
- [OpenCode Config 官方文档](https://opencode.ai/docs/config/)
- [GitHub Issue #33585 — LLM Command-Approval Classifier (auto mode)](https://github.com/anomalyco/opencode/issues/33585) — 证实 OpenCode 当前无 AI 审查
- [GitHub Issue #7928 — Runtime Permission Mode Toggle](https://github.com/anomalyco/opencode/issues/7928)
- [GitHub Issue #9755 — Nested Permissions in Agent Markdown](https://github.com/anomalyco/opencode/issues/9755)
- [GitHub Issue #6856 — granular permissions discussion](https://github.com/anomalyco/opencode/issues/6856)
