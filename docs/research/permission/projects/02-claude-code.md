# Claude Code 权限（Permission）机制调研报告

**调研日期**：2026-07-27 | **置信度**：整体高（本地反编译源码 + 官方文档双源交叉验证）。唯一不确定项：`auto` 模式最新公开 API 细节（标注为「research preview」）。
**调研方式**：researcher subagent，本地源码（`~/GitApp/ai-agent/claude-code-source-code/`）+ 官方文档交叉验证

---

## 0. 双源对照与关键发现（先看这个）

| 项 | 本地反编译源码（`claude-code-source-code`） | 官方文档（code.claude.com, 2026-07） | 一致性 |
|---|---|---|---|
| 权限模式数 | 内部 8 种（含 `auto`/`bubble`/`delegate`/`dontAsk`） | 公开 4 种核心 + `auto`(preview) + 几个未文档化 | 一致（文档是子集） |
| `auto` 模式 | ANT-only，受 `feature('TRANSCRIPT_CLASSIFIER')` 开关 | **已公开为 research preview**："auto-approves tool calls with background safety checks" | 一致；源码印证实现 |
| bash 命令审查 | **tree-sitter AST**（`TREE_SITTER_BASH` feature flag）+ legacy shell-quote fallback + YoloClassifier LLM | 文档只说 "background safety checks"，未提 AST | 源码独家 |
| 规则来源数 | 8 个（`userSettings`/`projectSettings`/`localSettings`/`flagSettings`/`policySettings`/`cliArg`/`command`/`session`） | 5 个 scope + cliArg + managed | 一致 |

**核心数据源路径**：
- 反编译源码根：`~/GitApp/ai-agent/claude-code-source-code/src/`
- 权限核心目录：`src/utils/permissions/`（26 个文件，核心 `permissions.ts` 1486 行）
- bash 审查：`src/tools/BashTool/bashPermissions.ts`（2621 行）+ `bashSecurity.ts`（2592 行）
- 编排：`src/services/tools/toolExecution.ts`（1745 行）
- 教学版注释（最有价值的速查）：`~/GitApp/ai-skills/learn-claude-code/s03_permission/README.md`（行 156-230 的「深入 CC 源码」附录）

---

## 1. 权限模式（Permission Modes）

### 1.1 完整模式列表

源码定义在 `src/types/permissions.ts:16-38`：

```typescript
// 对外公开（external）5 种
EXTERNAL_PERMISSION_MODES = ['acceptEdits','bypassPermissions','default','dontAsk','plan']
// 内部（含 ANT-only）额外 2 种
InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
```

`settings.json` 的 `defaultMode` 枚举（官方 JSON Schema 实测）：

| 模式 | 含义 | 公开? | UI 符号 |
|---|---|---|---|
| **`default`** | "Manual" — 只读自动放行，所有写/bash/网络都弹审批 | 公开 | (无) |
| **`acceptEdits`** | 自动批准文件编辑 + 常见文件系统命令（mkdir/touch/mv/cp）；bash 仍需审批 | 公开 | `⏵⏵` |
| **`plan`** | 只读规划模式；Edits 被阻止直到用户 approve plan | 公开 | `⏸` |
| **`bypassPermissions`** | 跳过所有审批（== `--dangerously-skip-permissions`） | 公开 | `⏵⏵`(红) |
| **`auto`** | "Everything, with background safety checks" — 用 LLM classifier 后台审查每条工具调用 | **research preview** | `⏵⏵`(黄) |
| `dontAsk` | 未在 allow 列表的工具自动拒绝（而非询问） | 文档化但少用 | `⏵⏵`(红) |
| `bubble` | 子 Agent 专用：权限弹窗冒泡到父 Agent | 仅内部 | — |
| `delegate` | agent team lead 协调专用（实验性、UNDOCUMENTED） | 仅内部 | — |

### 1.2 如何切换模式

| 切换方式 | 细节 | 源码/文档 |
|---|---|---|
| **Shift+Tab 循环** | 循环顺序见 `getNextPermissionMode()`（`utils/permissions/getNextPermissionMode.ts:34-79`）。外部用户：`default → acceptEdits → plan → (bypass?)→ default`；ANT 用户跳过 acceptEdits/plan 直接到 `auto` | 官方文档 + 源码 |
| **`--permission-mode <mode>`** CLI flag | 启动时指定；解析在 `permissionSetup.ts:689-744` `initialPermissionModeFromCLI()` | 官方文档 |
| **`--dangerously-skip-permissions`** | 等价于 `bypassPermissions`；**只有启动时带此 flag 才能进入**，中途无法切进去（`isBypassPermissionsModeAvailable` 守卫，`permissionSetup.ts:939,1415`） | 官方文档 |
| **settings.json `defaultMode`** | 持久化默认模式 | 官方 schema |
| **VS Code / Desktop UI 选择器** | 输入框旁的模式选择器 | 官方文档 |
| **`/permissions` 命令** | 查看和管理所有规则（不直接切模式，但可改规则） | 官方文档 |

### 1.3 模式闸门优先级（重要，Pi 可借鉴）

`hasPermissionsToUseToolInner()`（`permissions.ts:1158-1319`）的决策顺序：

1. 整个工具被 **deny rule** → `deny`
2. 整个工具被 **ask rule** → `ask`
3. `tool.checkPermissions()` 工具自检
4. 工具返回 `deny` → `deny`
5. 工具要求 `requiresUserInteraction()` 且返回 `ask` → `ask`
6. **内容相关 ask rule**（如 `Bash(npm publish:*)`）→ `ask`（**不可被 bypass 绕过**）
7. **safety check**（写 `.git/`、`.claude/`、`.vscode/`、shell 配置）→ `ask`（**不可被 bypass 绕过**，`decisionReason.type==='safetyCheck'`）
8. 若 `bypassPermissions` 模式 → `allow`
9. 整个工具被 **allow rule** → `allow`
10. `passthrough` → 转为 `ask`

**关键安全设计**：步骤 6、7 是 bypass-immune（免疫绕过），意味着即使在 yolo/bypass 模式下，显式 ask 规则和保护路径写入仍会弹窗。官方文档也确认 bypassPermissions 仍会拦截 `rm -rf /` 这类极端操作。

置信度：**高**（源码 + 官方文档双向确认）。

---

## 2. 权限规则定义（settings.json）

### 2.1 `permissions` 对象结构

源码 `src/utils/settings/settings.ts:571-579` + 官方 JSON Schema：

```jsonc
{
  "permissions": {
    "allow":      ["<规则字符串>"],   // 自动放行，不弹窗
    "deny":       ["<规则字符串>"],   // 完全禁止
    "ask":        ["<规则字符串>"],   // 强制弹窗确认
    "defaultMode": "default|acceptEdits|plan|bypassPermissions|auto|dontAsk",
    "disableBypassPermissionsMode": "disable",  // 企业可禁用 bypass
    "disableAutoMode": "disable",                 // 禁用 auto 模式（feature gated）
    "additionalDirectories": ["/abs/path"]        // 扩展工作区范围
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": false,
    "allowUnsandboxedCommands": false,
    "network": {...}, "filesystem": {...},
    "excludedCommands": ["bazel:*"],              // 不走沙箱的命令（仅便利，非安全边界）
    "autoAllowBashIfSandboxed": true,             // 沙箱内 bash 自动放行
    "enableWeakerNestedSandbox": false,
    "ripgrep": {...}
  }
}
```

### 2.2 规则语法（实测官方文档逐字引用）

格式统一为 `ToolName` 或 `ToolName(content)`，解析器在 `permissionRuleParser.ts:93-133`。content 支持三种匹配：
- **exact**：`Bash(npm run build)`
- **prefix（旧 `:*` 语法）**：`Bash(npm:*)` → 匹配 `npm` 开头
- **wildcard（新 `*` 语法）**：`Bash(npm run *)` → 转 regex `^npm run .*$`（`shellRuleMatching.ts:90-154`）

转义：`\*` 匹配字面星号，`\\` 匹配字面反斜杠；括号用 `\(` `\)` 转义。

各工具规则示例（官方文档原文）：

| 工具 | 规则示例 | 说明 |
|---|---|---|
| **Bash** | `Bash` / `Bash(*)` / `Bash(npm run build)` / `Bash(npm run test *)` / `Bash(npm:*)` / `Bash(git commit *)` / `Bash(git push *)` / `Bash(aws s3 ls)` / `Bash(curl http://github.com/ *)` / `Bash(rm *)` / `Bash(run_in_background:true)` / `Bash(timeout 30 npm test)` / `Bash(git status && npm test)` / `Bash(FOO=bar rm -rf tmp/)` | 支持 `*` 通配、`:*` 前缀、`&&`/`;` 复合命令、env 前缀 |
| **PowerShell** | `PowerShell(Get-ChildItem *)` / `PowerShell(Remove-Item *)` | Windows 对等 |
| **Read** | `Read(./.env)` / `Read(~/.ssh/**)` / `Read(src/**)` / `Read(*.env)` / `Read(**/.env)` / `Read(~/Documents/*.pdf)` | **glob 通配**（`**` 跨目录） |
| **Edit** | `Edit(src/**)` / `Edit(/src/**/*.ts)` / `Edit(**/src/**)` / `Edit(docs/**)` | glob 通配 |
| **Write / NotebookEdit** | `Write(docs/**)` | 文档说"接受但永不匹配文件检查"（Write 权限由 Edit 控） |
| **WebFetch** | `WebFetch(domain:example.com)` / `WebFetch(domain:*.example.com)` / `WebFetch(domain:github.com)` / `WebFetch(domain:*)` | **域名通配**专用语法 |
| **WebSearch** | （文档无示例，应仅支持 `WebSearch` 整工具级） | — |
| **MCP** | `mcp__*`（所有 MCP）/ `mcp__puppeteer`（整 server）/ `mcp__puppeteer__*`（某 server 全工具）/ `mcp__puppeteer__puppeteer_navigate`（单工具）/ `mcp__github__get_*`（工具名通配） | **`mcp__<server>__<tool>` 命名空间** |
| **Agent** | `Agent(model:opus)` / `Agent(isolation:worktree)` / `Agent(Explore)` / `Agent(my-custom-agent)` | 子 agent 类型/模型控制 |
| **Cd** | `Cd(~/code/*)` / `Cd(**/node_modules)` | 工作目录切换 |

### 2.3 是否支持正则/glob

- **Bash**：支持 `*` 通配（转 regex）和 `:*` 前缀；**不支持完整正则**（`shellRuleMatching.ts:90-154`，特殊字符会被 escape）
- **Read/Edit/Write**：支持 **glob**（`**`、`*`），路径级
- **WebFetch**：域名级通配（`*.example.com`）
- 复合 bash 命令会先 `splitCommand` 拆成子命令，每个子命令分别匹配（`bash/commands.ts:85,265`）

置信度：**高**。

---

## 3. Bash 命令审查机制（重点）

这是最复杂的部分，源码独家信息：

### 3.1 三层叠加（不是单一机制）

`bashToolHasPermission()`（`bashPermissions.ts:1663-2621`）的审查链：

**层 1 — AST 解析（tree-sitter）** — `bashPermissions.ts:1670-1806`
```typescript
// tree-sitter WASM 解析，产生 SimpleCommand[] 或 'too-complex'
let astRoot = injectionCheckDisabled ? null
  : feature('TREE_SITTER_BASH_SHADOW') && !shadowEnabled ? null
  : await parseCommandRaw(input.command)
let astResult = astRoot ? parseForSecurityFromAst(input.command, astRoot)
                        : { kind: 'parse-unavailable' }
```
- 结果有三种：`simple`（干净拆分）、`too-complex`（含命令替换/扩展/控制流，无法静态分析）、`parse-unavailable`（WASM 未加载）
- `too-complex` → 走 deny 检查后 fallback 到 `ask`（不降级 deny）
- 注释明确：「tree-sitter 产生干净的 SimpleCommand[]（引号已解析、无隐藏替换）或 too-complex —— 正是我们判断 splitCommand 输出是否可信所需的信号」

**层 2 — 语义检查** — `bashSecurity.ts` 的 `checkSemantics()`
- 检测 zsh builtins、`eval`、`exec` 等"词法正常但语义危险"的命令
- 命中 → `ask`（除非有 deny rule）

**层 3 — legacy shell-quote fallback** — `bashPermissions.ts:1811+`
- tree-sitter 不可用时，用 `tryParseShellCommand`（shell-quote 库）
- 解析失败（malformed syntax）→ `ask`

**层 4 — 规则匹配** — `bashPermissions.ts:1183` `checkCommandAndSuggestRules()`
- 把命令拆成子命令（`splitCommand`），strip wrappers/env vars 后逐一匹配 allow/deny/ask 规则

### 3.2 是否有 AI 审查

**有，是核心特色**。两个独立 classifier：

**A. YoloClassifier（auto 模式专用）** — `yoloClassifier.ts:1012-1495` `classifyYoloAction()`
- 把「整段对话 transcript + 当前 action」发给一个**独立的 side_query LLM**（`sideQuery`，temperature=0，带 thinking）
- 用强制 tool_use（`YOLO_CLASSIFIER_TOOL`）要求结构化输出 `{shouldBlock, reason}`
- **两阶段**：stage 1（fast model）→ stage 2（thinking model），由 GrowthBook `isTwoStageClassifierEnabled()` 控制
- 触发顺序（`permissions.ts:620-686` 经教学版附录总结）：先模拟 acceptEdits → 查安全工具白名单 → 最后才调 classifier
- **失败回退**：连续拒绝太多次 → `denialTracking.ts` `shouldFallbackToPrompting` 回退到人工审批；API 出错 → fail-closed（block）

**B. BashClassifier（bash 专用，`BASH_CLASSIFIER` feature）** — `bashClassifier.ts`（外部 stub，ANT 内部实现）
- `classifyBashCommand(command, cwd, descriptions, behavior)` 返回 `{matches, confidence, reason}`
- 支持 `prompt:` 前缀的语义规则（`createPromptRuleContent`），用 LLM 判断命令是否匹配自然语言描述
- 在审批对话框**显示的同时后台并发跑**（`interactiveHandler.ts:433-530` `executeAsyncClassifierCheck`），若 classifier 判定安全则**自动批准**（race condition，谁先返回谁赢）

### 3.3 危险命令默认规则

`dangerousPatterns.ts` 定义**危险 allow-rule 前缀**（auto 模式进入时会被自动 strip）：

```typescript
CROSS_PLATFORM_CODE_EXEC = [
  'python','python3','node','deno','tsx','ruby','perl','php','lua',  // 解释器
  'npx','bunx','npm run','yarn run','pnpm run','bun run',            // 包运行器
  'bash','sh','ssh',                                                  // shell
]
DANGEROUS_BASH_PATTERNS = [
  ...CROSS_PLATFORM_CODE_EXEC,
  'zsh','fish','eval','exec','env','xargs','sudo',
  // ANT-only: 'gh','curl','wget','git','kubectl','aws','gcloud'...
]
```

这些不是硬 deny，而是「这类 `Bash(python:*)` allow 规则会让人用解释器跑任意代码、绕过 classifier」，所以在 auto 模式入口被剥离。另外还有内置的安全路径检查（`.git/`、`.claude/`、`.vscode/`、`~/.ssh/`、shell rc 文件）→ 强制 `ask`，bypass-immune。

置信度：**高**（源码逐行核实）。

---

## 4. 审批交互流程

### 4.1 UI 形态

主入口 `handleInteractivePermission()`（`hooks/toolPermission/handlers/interactiveHandler.ts:57-531`）：
- 往 confirm 队列 push 一个 `ToolUseConfirm` 条目（`interactiveHandler.ts:92`）
- 回调：`onAbort` / `onAllow(updatedInput, permissionUpdates, feedback?, contentBlocks?)` / `onReject(feedback?, contentBlocks?)` / `recheckPermission` / `onUserInteraction`

### 4.2 是否支持「本次/永久/拒绝」

- **本次允许/拒绝**：`onAllow` / `onReject` 不带 `permissionUpdates`
- **永久允许**：`onAllow` 带 `permissionUpdates`（`PermissionUpdate[]`，类型 `addRules`/`replaceRules`/`removeRules`，destination 可选 `userSettings`/`projectSettings`/`localSettings`/`session`/`cliArg`）→ 通过 `persistPermissionUpdates()` 持久化到对应 settings.json
- 永久规则建议由 `shellRuleMatching.ts:189-228` 的 `suggestionForExactCommand` / `suggestionForPrefix` 自动生成（默认写 `localSettings`）

### 4.3 决策如何持久化

`PermissionUpdate` 类型（`types/permissions.ts:98-131`）支持 6 种操作：`addRules`、`replaceRules`、`removeRules`、`setMode`、`addDirectories`、`removeDirectories`。`applyPermissionUpdates()` + `persistPermissionUpdates()`（`permissions.ts:1408` 附近）写回 JSON 文件。

### 4.4 是否支持 free-text 拒绝理由回传给 agent

**支持**，且设计很完整。`onReject(feedback?, contentBlocks?)`（`interactiveHandler.ts:183-203`）：
- `feedback` 是自由文本，`contentBlocks` 可含图片
- 调 `ctx.cancelAndAbort(feedback, undefined, contentBlocks)`（`interactiveHandler.ts:202`）
- 拒绝原因作为 `tool_result`（content `"Error: <feedback>"` 或 `Permission denied.`）注入回 messages，**agent 能看到理由并调整**
- 同样支持 `onAllow` 带 `feedback`（`interactiveHandler.ts:154-182`），允许时也能附加反馈
- `PermissionAskDecision` 类型（`types/permissions.ts:199-226`）有 `contentBlocks?: ContentBlockParam[]`，专门用于「用户粘贴图片作为反馈」

### 4.5 并发 race（高级设计）

审批对话框显示时，同时并发跑：
1. **本地用户交互**（onAllow/onReject）
2. **Bridge 权限响应**（claude.ai 远程，CCR）
3. **Channel 权限 relay**（Telegram/iMessage，KAIROS feature）
4. **Hook 决策**（`ctx.runHooks`）
5. **Bash classifier 自动批准**（`executeAsyncClassifierCheck`）

用 `createResolveOnce(resolve)` + `claim()` 原子 check-and-mark 保证「谁先响应谁赢，只 resolve 一次」（`interactiveHandler.ts:70`）。200ms grace period 防误触取消 classifier（`interactiveHandler.ts:115`）。

置信度：**高**。

---

## 5. 工具粒度

每个工具实现自己的 `checkPermissions()`，返回 `PermissionResult`（4 种 behavior：`allow`/`deny`/`ask`/`passthrough`）。粒度差异：

| 工具 | 权限粒度 | 关键文件 |
|---|---|---|
| **Read** | 路径 glob；保护路径（`.env`、`.ssh`、`.git`）强制 ask | `tools/FileReadTool/` + `utils/permissions/pathValidation.ts`（16KB） |
| **Write/Edit** | 路径 glob；`.git/`/`.claude/`/`.vscode/`/shell rc 写入 bypass-immune ask | `tools/FileEditTool/`、`tools/FileWriteTool/` |
| **Bash** | 最复杂：AST + 语义 + 规则 + 双 classifier；复合命令拆分逐个审查 | `tools/BashTool/`（15 个文件） |
| **PowerShell** | 与 Bash 对等的独立审查链 | `tools/PowerShellTool/powershellPermissions.ts` |
| **WebFetch** | 域名级 `WebFetch(domain:x)` | `tools/WebFetchTool/preapproved.ts` |
| **WebSearch** | 整工具级 | `tools/WebSearchTool/` |
| **Glob/Grep** | 只读，默认放行 | — |
| **MCP** | `mcp__server__tool` 命名空间，server 级 / tool 级 / 通配 | 见下节 |
| **Agent（子 agent）** | `Agent(model:*)` / `Agent(isolation:worktree)`；子 agent 权限模式 = `bubble`（冒泡到父） | `tools/AgentTool/forkSubagent.ts:50` |
| **TodoWrite/Task\*** | 内部协调工具，不参与审批 | — |

置信度：**高**。

---

## 6. Hooks 机制（PreToolUse 介入权限）

### 6.1 Hook 如何拦截

编排入口 `checkPermissionsAndCallTool()`（`toolExecution.ts:599`），流程（`toolExecution.ts:800-946`）：

1. **Zod schema 验证** + **validateInput()**（`toolExecution.ts:614-733`）
2. **`runPreToolUseHooks()`** 异步迭代（`toolExecution.ts:800-862`）
   - 每个 hook 返回 `{type:'hookPermissionResult', hookPermissionResult}` 或 `{type:'hookUpdatedInput', updatedInput}` 等
3. **`resolveHookPermissionDecision()`**（`toolExecution.ts:921-931`）协调 hook 决策 + 正常管线
4. 进入 `hasPermissionsToUseToolInner()`

### 6.2 Hook 可返回的权限决策（官方文档逐字）

`hookSpecificOutput.permissionDecision` 四值（官方 hooks 文档 + 源码）：

| 值 | 行为 |
|---|---|
| `"allow"` | 直接放行，**跳过后续权限检查** |
| `"deny"` | 阻止，reason 回传给 Claude |
| `"ask"` | 强制弹用户审批 |
| `"defer"` | 交给下一个 hook 或正常流程 |

精确 JSON 输出（官方原文）：
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Database writes are not allowed"
  }
}
```
也可用 **exit code 2**（blocking error，stderr 回传给 Claude）。

### 6.3 能否拦截

**能**。PreToolUse hook 是权限管线的一等公民，可在 `hasPermissionsToUseToolInner` 之前就拍板 allow/deny。但官方文档警告：「`if` 匹配器是 best-effort，某些 bash 命令 fail-open；硬性 allow/deny 应该用 permission 系统，不要用 hook」。另有 `PermissionRequest` 和 `PermissionDenied` 两个 hook 事件分别响应审批框弹出和 classifier 拒绝。

置信度：**高**。

---

## 7. MCP 工具权限

### 7.1 命名与作用域

`services/mcp/mcpStringUtils.ts:19-67`：
- MCP 工具全名 = `mcp__<serverName>__<toolName>`（server 名做 `normalizeNameForMCP` 归一化）
- **权限匹配用全名**（`getToolNameForPermissionCheck()`，`mcpStringUtils.ts:60-67`），**防止** MCP 工具（如也叫 `Write`）与 builtin 同名工具规则串扰

### 7.2 规则形式（官方文档）

- `mcp__*` — 所有 MCP server 所有工具
- `mcp__puppeteer` — 整个 puppeteer server
- `mcp__puppeteer__*` — puppeteer server 所有工具
- `mcp__puppeteer__puppeteer_navigate` — 单个工具
- `mcp__github__get_*` — 工具名通配

### 7.3 管控方式

MCP 工具走与 builtin **完全相同**的 allow/deny/ask 管线（用全名匹配）。另有 `enabledMcpjsonServers` / `disabledMcpjsonServers`（settings 顶层）控制整个 server 的加载。MCP 工具的 `isDestructive` 由其 `annotations.destructiveHint` 决定（`Tool.ts:405`，仅 UI 展示，不参与决策）。

置信度：**高**。

---

## 8. 对 Pi 四模式的借鉴价值（映射分析）

### 8.1 映射表

| 用户期望的 Pi 模式 | Claude Code 对应机制 | 直接可借鉴度 |
|---|---|---|
| **yolo 完全访问**（Pi 当前默认） | `bypassPermissions` 模式（`--dangerously-skip-permissions`） | **高**。注意 CC 即使 bypass 也保留两道安全网：(a) 内容相关 ask 规则 bypass-immune；(b) safety check（`.git/`/`.claude/`/shell rc）bypass-immune；(c) `rm -rf /` 等极端操作仍拦截。Pi yolo 建议至少保留 (c)。 |
| **自动模式**（bash AST + AI 审查） | `auto` 模式 + YoloClassifier + BashClassifier | **高，核心参考**。CC 的 auto 模式正是"每次调用走 classifier"。见 8.2。 |
| **审批模式**（仅危险命令审批） | `default` 模式 + 规则系统（allow/deny/ask）+ classifier 后台 race | **高**。`default` 模式 = 只读放行、其他询问；配合 allow 规则（如 `Bash(npm run test:*)`）实现"非危险自动放行、危险才问"。 |
| **严格审批模式**（所有命令审批） | `default` 模式不删 allow 规则，或 `dontAsk` 的反面 | **中**。CC 没有专门的"严格"模式；最接近的是 `default` 模式 + 不配任何 allow 规则（所有 bash/写都问）。Pi 可直接做成独立模式。 |

### 8.2 自动模式（Pi 重点）该抄什么

CC auto 模式的工程细节，Pi 可直接借鉴：

1. **AST 解析优先，LLM 兜底** — CC 用 tree-sitter（Pi 可用 shell-quote / `bash-parser`）；AST 太复杂（命令替换/控制流）才升级到 LLM classifier，省 token。
2. **classifier 用独立 side_query** — 不污染主对话；temperature=0；强制 tool_use 结构化输出（`{shouldBlock, reason}`）；带 thinking（CC 用两阶段 fast→thinking）。
3. **classifier 输入 = transcript + 当前 action** — 让 classifier 看上下文判断"是否超出用户意图"（scope escalation 检测）。
4. **三层回退** — acceptEdits 模拟放行 → 安全工具白名单 → classifier → 拒绝太多次回退到人工审批。
5. **race 设计** — 审批框弹出时后台并发跑 classifier，若 classifier 判安全则自动批准（用户无需等）；`resolveOnce + claim` 保证原子。
6. **危险 allow 规则剥离** — 进入 auto 模式时，strip 掉 `Bash(python:*)`/`Bash(node:*)` 这类"等于任意代码执行"的宽 allow（`dangerousPatterns.ts`）。
7. **fail-closed** — classifier API 失败默认 block（而非放行），但有 `transcriptTooLong` 等确定性错误时回退正常审批。

### 8.3 Claude 有、Pi 不需要 / 暂可不做的

- **8 个规则来源 + 企业 policy** — Pi 用户量小，前 3 个 scope（user/project/local）+ cliArg 足够。
- **Bridge（claude.ai 远程审批）+ Channel（Telegram/iMessage relay）** — 多端审批 race，Pi 单端足够。
- **bubble / delegate / team 模式** — 多 agent 协调，Pi 当前不需要。
- **GrowthBook feature flag 全家桶**（TRANSCRIPT_CLASSIFIER / TREE_SITTER_BASH_SHADOW / BASH_CLASSIFIER）— CC 用它灰度，Pi 直接全量。
- **PowerShell 独立审查链** — Pi 若不重点支持 Windows 可省。
- **`prompt:` 语义规则**（用 LLM 判断命令是否匹配自然语言描述）— 较超前，Pi 后期再做。

### 8.4 Claude 没有、Pi 需要新设计的

- **独立的「严格审批模式」枚举值** — CC 没有这个概念，靠"default + 无 allow 规则"间接实现。Pi 可做成一等公民（如 `strict` 模式，所有工具调用强制 ask，bypass allow 规则）。
- **更细的"本次/永久/始终拒绝"三选项 UI** — CC 的 `PermissionUpdate` 支持但 UI 较隐式；Pi 可显式做成分级菜单。
- **审批决策的审计日志/可解释性** — CC 有 `permissionExplainer.ts`（riskLevel: LOW/MEDIUM/HIGH）但未在 UI 强暴露；Pi 可直接展示 risk 等级。
- **Pi 当前是 yolo 默认** — CC 的 default 是 manual，bypass 需要显式 flag 且有 root/sudo 拒绝、warning 对话框、managed settings 禁用等多重守卫。Pi 把 yolo 设为默认是更激进的选择，建议至少加上 CC 的「首次使用 warning + 极端命令（`rm -rf /`）硬拦截」。

---

## Sources

官方文档（code.claude.com，2026-07）：
- [Choose a permission mode](https://code.claude.com/docs/en/permission-modes)
- [Configure permissions](https://code.claude.com/docs/en/permissions)
- [Configure permissions (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Settings](https://code.claude.com/docs/en/settings)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [JSON Schema (schemastore)](https://www.schemastore.org/claude-code-settings.json)

第三方交叉验证：
- [Claude Code Auto Mode Explained (developersdigest)](https://www.developersdigest.tech/blog/claude-code-auto-mode-explained)
- [Inside Claude Code architecture (penligent)](https://www.penligent.ai/hackinglabs/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/)
- [Claude Code Harness guide (hidekazu-konishi)](https://hidekazu-konishi.com/entry/claude_code_harness_and_environment_engineering_guide.html)
- [Claude Code 权限配置指南 (smzdm)](https://post.smzdm.com/p/apq8rd00)
- [权限规则优先级 Qiita](https://qiita.com/kk__777/items/3cb1c28565ff19d5a35a)

本地源码（绝对路径，反编译/分析版）：
- `~/GitApp/ai-agent/claude-code-source-code/src/types/permissions.ts`（441 行，类型与模式枚举）
- `~/GitApp/ai-agent/claude-code-source-code/src/utils/permissions/permissions.ts`（1486 行，核心决策 `hasPermissionsToUseToolInner` 在 1158-1319）
- `~/GitApp/ai-agent/claude-code-source-code/src/utils/permissions/yoloClassifier.ts`（1495 行，`classifyYoloAction` 在 1012）
- `~/GitApp/ai-agent/claude-code-source-code/src/utils/permissions/shellRuleMatching.ts`（228 行，通配/前缀匹配）
- `~/GitApp/ai-agent/claude-code-source-code/src/utils/permissions/permissionRuleParser.ts`（198 行，规则字符串解析）
- `~/GitApp/ai-agent/claude-code-source-code/src/utils/permissions/dangerousPatterns.ts`（80 行，危险 allow 前缀）
- `~/GitApp/ai-agent/claude-code-source-code/src/utils/permissions/getNextPermissionMode.ts`（102 行，Shift+Tab 循环）
- `~/GitApp/ai-agent/claude-code-source-code/src/tools/BashTool/bashPermissions.ts`（2621 行，`bashToolHasPermission` 在 1663）
- `~/GitApp/ai-agent/claude-code-source-code/src/tools/BashTool/shouldUseSandbox.ts`（153 行）
- `~/GitApp/ai-agent/claude-code-source-code/src/services/tools/toolExecution.ts`（1745 行，`checkPermissionsAndCallTool` 在 599，PreToolUse 在 800-862）
- `~/GitApp/ai-agent/claude-code-source-code/src/hooks/toolPermission/handlers/interactiveHandler.ts`（537 行，审批 UI + race）
- `~/GitApp/ai-agent/claude-code-source-code/src/services/mcp/mcpStringUtils.ts`（107 行，MCP 命名空间）
- `~/GitApp/ai-agent/claude-code-source-code/src/utils/settings/settings.ts`（permissions/sandbox schema 在 560-609）
- `~/GitApp/ai-skills/learn-claude-code/s03_permission/README.md`（教学版 + 「深入 CC 源码」附录在 156-230 行，含 file:line 索引）

**z.ai / ZCode 国内版**：搜索显示 z.ai 国内版（ZCode）文档（zcode.z.ai/cn/docs/configuration）主要讲模型/套餐连接（BigModel、GLM-5.2），**没有独立的 permission 系统文档**，其权限机制沿用 Claude Code 公开设计，无独特可参考点。
