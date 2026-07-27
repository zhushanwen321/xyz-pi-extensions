# ZCode 权限管理机制调研报告

**调研日期**：2026-07-27 | **置信度**：源码级发现（高）+ 官方文档确认（高）。ZCode 本地只有 Electron 客户端 + bundled JS（minified），真正的 agent 决策跑在后端 `zcode.z.ai`，所以"决策如何产生"部分依赖文档+协议观察（中）。
**调研方式**：researcher subagent，Electron bundled JS 反向 + 官方文档 + 真实 payload 三源验证

---

## 0. 关键结论先行

ZCode 的权限机制是 **"模式（mode）+ Hook 协议 + UI 审批"** 三层结构，**没有本地 bash AST 解析、没有沙箱**。它高度继承自 Claude Code（hook 字段名几乎一一对应），但在其上加了：5 档执行模式 UI、`PermissionRequest` hook 事件、多后端 CLI 适配（codex/claude/gemini/opencode/glm）。

---

## 1. 权限模式（置信度：高，源码+文档双重确认）

### 1.1 内部规范化后的 4 种 mode（源码确认）

文件 `~/GitApp/ZCode/app/out/wakaru-test/host/entry.js` 中的 `toZCodeMode` 函数把所有外部 mode 名归一化：

```
case "plan":                                    -> "plan"
case "yolo" | "bypassPermissions" | "dontAsk":  -> "yolo"
case "auto":                                    -> "auto"
case "build" | "default" | "acceptEdits" | "autoEdit": -> "build"
```

- **`build`**（默认）: "Default coding mode with permission checks for risky actions."（源码 `Py` 数组，entry.js）
- **`plan`**: "Read, inspect, and plan without mutating the workspace."（只读）
- **`yolo`**: "Allow tool execution without interactive permission prompts."（全自动）
- **`auto`**: 内部存在，UI 默认不暴露给 GLM provider

### 1.2 UI 暴露的 5 档（官方文档确认，https://zcode.z.ai/cn/docs/safety-confirm）

| UI 模式 | 行为 | 对应内部 mode |
|---|---|---|
| **Default（默认）** | "使用 ZCode Agent 的默认确认策略" | `build` |
| **Confirm Before Changes（变更前确认）** | "每次修改文件或执行命令前都先确认" | `build`（严格） |
| **Auto-Edit Files（自动编辑文件）** | "编辑自动执行，命令等操作仍需确认" | `auto`/`acceptEdits` |
| **Plan（计划模式）** | "先制定计划，确认后再开始实施" | `plan` |
| **Full Access（完全访问）** | "尽量自动执行，减少确认" | `yolo` |

### 1.3 切换方式（文档确认）
- 输入框附近的"执行模式选择器"
- 快捷键 **Shift+Tab** 循环切换（与 Claude Code 一致）
- 每个会话独立设置，hook payload 里带 `mode` 和 `permission_mode` 字段

### 1.4 多后端 mode 标签（源码确认，entry.js `getModeDisplayLabel`）
ZCode 支持多后端 CLI，每个后端有自己的 mode 命名，ZCode 统一映射：
- **claude**: auto/default/acceptEdits/plan/dontAsk/bypassPermissions
- **codex**: read-only/auto/agent/full-access/agent-full-access
- **gemini**: default/autoEdit/yolo/plan
- **opencode**: build/plan
- **glm（ZCode 自家）**: default/yolo/plan

---

## 2. 权限规则定义结构（置信度：高，源码确认）

文件 `~/GitApp/ZCode/app/out/host/chunk-J3IIA4Z2.js` 定义了 RPC 决策 schema：

```js
Pm = enum(["allow", "deny", "escalate", "modify"])   // 最终决策
Yy = enum(["allow", "deny", "ask"])                   // 规则行为
Xy = object({ toolName: string, ruleContent: string.optional() })
Qy = object({
  type: literal("addRules"),
  behavior: Yy,                  // allow/deny/ask
  rules: array(Xy).min(1)
})
$t = object({
  decision: Pm,                  // allow/deny/escalate/modify
  reason: string.optional(),
  modifiedInput: unknown.optional(),
  permissionUpdates: array(Qy).optional()   // 动态加规则
})
```

**要点**：
- 规则三元组 **allow / deny / ask**（与 Claude Code 一致）
- 规则粒度是 **`toolName` + `ruleContent`**（ruleContent 是自由字符串，可能是 glob 或命令前缀，源码未细化）
- **`escalate`** 和 **`modify`** 是 ZCode 自创：escalate = 升级到人工审批，modify = 改写命令后放行（对应 `modifiedInput`）
- **`permissionUpdates` / `addRules`** 允许审批时动态加规则（"always allow" 的实现机制）

---

## 3. Bash 命令审查（置信度：高 — 确认无本地 AST）

**源码扫描结果**：在所有 bundled JS（`~/GitApp/ZCode/app/out/**/*.js`）中**未找到** `tree-sitter`、`bash-parser`、`shell-parser`、`commandParser`、`parseShell`、`dangerouslySkipPermissions` 等任何关键字。

**结论**：ZCode **本地不做 bash AST 解析，也没有内置 AI 命令审查**。命令风险判断有两种途径：
1. **后端 agent 自行判断**（GLM agent 服务跑在 zcode.z.ai，决定何时发 `permission_request`）— 机制不透明
2. **PreToolUse hook**（用户自写脚本，本地 subprocess）— 这是用户自定义 bash 审查的唯一入口

`~/.zcode/cli/plugins/demo-plugin/hooks/pre-tool-use.sh` 就是一个示例：从 stdin 读 JSON，grep `tool_name` 是否为 bash，用户可在此自行实现 AST/正则/AI 审查。

---

## 4. 审批交互流程（置信度：高，源码+文档+真实 payload）

### 4.1 流程（文档 https://zcode.z.ai/cn/docs/safety-confirm）
1. Agent 触发需授权动作 → **任务暂停，输入区阻塞**
2. 弹出请求，显示具体命令/文件改动/工具调用
3. 用户决策；拒绝则中止或回到可调整状态
4. 权限请求与任务绑定，切换标签页回来仍保留 pending 状态

### 4.2 决策选项（源码 entry.js + 文档）
Renderer 文件 `~/GitApp/ZCode/app/out/renderer/assets/index-I0xDt3Dv.js` 定义了 5 类选项分类（`fX` 函数）：

| 分类 | 触发词 | 对应 chat 事件 |
|---|---|---|
| **allowOnce** | "allow"/"allow once"/"approve" | `chat.permission.approve` |
| **allowAlways** | "always allow"/"approve always" | `chat.permission.approveAlways` |
| **rejectOnce** | "deny"/"reject" | `chat.permission.deny` |
| **rejectAlways** | "always deny"/"always reject" | `chat.permission.denyAlways` |
| **custom** | 其他文本 | （走 modifiedInput/freeText） |

**作用域**（`allowAlways` 的细分）：
- **Allow for session（允许本会话）** → `chat.permission.allowForSession`
- **Allow for project（始终允许本项目）** → `chat.permission.allowForProject`

### 4.3 决策持久化（源码确认）
通过 `permissionUpdates: [addRules]` 把"always allow/deny"动态写入规则库（`toolName + ruleContent`），后续同类型操作不再询问。Hook 协议里也叫 `updatedPermissions`（新）/`permissionUpdates`（旧）。

### 4.4 Free-text 拒绝理由（源码确认存在）
Renderer 里有 `freeTextPlaceholder`、`customInputPlaceholder`、`requiresInput` 字段，且识别正则 `/(其他|其它|自定义|自行|自己|补充|填写|填入|输入|other|custom|free\s*text|specify|write\s*in)/i`（entry.js `f0e`）。最后一个选项可被标记为 `requiresInput`，用户能填自由文本，通过 `modifiedInput`/`reason` 回传。**文档没明说，但源码确认机制存在**。

---

## 5. 工具粒度（置信度：高，源码+文档）

**matcher 是大小写敏感的正则**，匹配 tool name（`diagnosing-hooks/SKILL.md` 第 27-31 行）：
- 工具事件（PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure）匹配 **tool name**：`Bash`、`Read`、`Write`、`Edit`、`Agent` 等
- 别名：`Task` ↔ `Agent`，`Write`/`Edit` ← `ApplyPatch`
- matcher 语法（官方 hooks 文档）：
  - 空/`*` → 匹配全部
  - 纯字母数字下划线 + `|` → 精确名字列表（如 `Write|Edit`）
  - 含其他字符 → 当作 JavaScript 正则
- **不匹配 glob 路径** — matcher 只针对 tool name，不针对文件路径。文件路径限制在 `ruleContent` 里表达（具体语法源码未暴露）。

---

## 6. 与 Claude Code 的异同（置信度：高）

### 6.1 直接继承自 Claude Code
- **Hook 协议字段名**几乎一致。真实 payload（`~/.zcode/hooks/payload-dump-*.log`）里同时有 `mode`/`permission_mode`、`sessionId`/`session_id`、`transcriptPath`/`transcript_path`、`hookEventName`/`hook_event_name` — ZCode 同时给 camelCase + snake_case 别名，与 Claude Code 完全兼容。
- **PreToolUse / PostToolUse / SessionStart / UserPromptSubmit / Stop** 事件同名同义
- **退出码约定**：0 = pass，2 = block/deny，其他非零 = error（与 Claude Code 一致）
- **Shift+Tab 循环模式**
- **`bypassPermissions` / `acceptEdits`** 等模式名直接借用

### 6.2 ZCode 自创/改造
1. **`PermissionRequest` hook 事件**（Claude Code 没有）— 只在"本该弹给用户"时触发，可自动 allow/deny 交互式提示，但不能覆盖 plan-mode 的硬性写禁令
2. **5 档执行模式 UI**（Default/ConfirmBeforeChanges/AutoEdit/Plan/FullAccess）— Claude Code 只有 4 档（default/acceptEdits/plan/bypassPermissions）
3. **`escalate` / `modify` 决策** + **`modifiedInput`**（改写命令后放行）— Claude Code 只有 allow/deny
4. **`addRules` + `permissionUpdates`** 动态规则库 — 显式化了"always allow"的数据结构
5. **多后端适配**：`toZCodeMode` 把 codex/claude/gemini/opencode/glm 的 mode 名统一归一化
6. **Allow for session / Allow for project** 两个 always 作用域细分

---

## 7. 沙箱（置信度：高 — 确认无）

**源码扫描结果**：
- 未找到 `landlock`、`seccomp`、`bubblewrap`/`bwrap`、`firejail`、`sandbox-exec`、`seatbelt` 等任何系统级沙箱技术
- `index.js` 里的 `sandbox: !0` 是 **Electron renderer sandbox**（`contextIsolation: !0, nodeIntegration: !1, sandbox: !0`），是浏览器进程隔离，不是 coding-agent 文件/网络/进程沙箱
- `sandboxMode` 和 `approvalPolicy` 是 **pass-through 配置字段**，出现在多后端 CLI 的 RPC schema 里（`chunk-AR4VZYUL.js`、`chunk-J3IIA4Z2.js`）— 用来传给后端 CLI（如 codex 自己有 workspace 沙箱），ZCode 本体不实现

**结论**：ZCode **没有自带沙箱**。文档也只建议"在可控工作区使用 yolo"，把沙箱责任推给用户/后端 CLI。

---

## 8. Hook 协议（置信度：高，官方文档 + 源码）

7 个事件（`MU` 数组，entry.js；与 `zcode-configuration-guide/SKILL.md` 一致）：
`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`

**PreToolUse 输出 schema**（官方 hooks 文档，`hookSpecificOutput`）：
- `permissionDecision`: `"allow" | "ask" | "deny"`
- `permissionDecisionReason`: string
- `updatedInput`: 完整替换 tool input（非 patch）
- `additionalContext`: 注入对话的上下文

**PermissionRequest 输出 schema**：
- `decision.behavior`: `"allow" | "deny"`
- `decision.message`、`updatedInput`、`updatedPermissions`

**配置位置**（`zcode-configuration-guide/SKILL.md`）：
- 用户级：`~/.zcode/cli/config.json` 的 `hooks` 键（必须 `hooks.enabled: true` 才生效）
- 工作区级：`<repo>/.zcode/config.json` 的 `hooks` 键
- 插件级：`<plugin>/hooks/hooks.json`（有插件 hook 时 runner 自动启用）

本地实例 `~/.zcode/cli/config.json` 注册了 PreToolUse matcher `"bash"`，但 `~/.zcode/hooks/` 下 463 条 dump 全是 SessionStart（说明该用户长期跑 yolo，PreToolUse-bash 要么没触发要么被 yolo 跳过 — 这一点源码未给出明确答案，置信度中）。

---

## 9. 对 Pi 四模式的借鉴价值

用户期望 Pi 支持四种模式。下面把 ZCode 机制逐模式对照：

### 9.1 yolo 完全访问（Pi 当前默认）
- **ZCode 对应**：`yolo` mode / Full Access UI
- **借鉴价值（高）**：ZCode 的 yolo 仍保留 PreToolUse hook 钩子（即使不弹审批，hook 仍可记录/拦截）。Pi 可借鉴 — yolo 不等于"无 hook"，只是"无人工审批"。
- **注意**：ZCode 文档反复警告 yolo 要在"可控工作区/沙箱"用，但 ZCode 自己没沙箱。Pi 应考虑内置沙箱而非只靠口头警告。

### 9.2 自动模式（每次请求都走 bash AST 解析 + AI 审查）— **ZCode 无直接对应**
- **ZCode 对应**：**没有**。ZCode 本地无 bash AST，无内置 AI 命令审查。
- **最接近的拼法**：`build` mode + 用户自写 PreToolUse hook（在 hook 里调 AST 解析器 + AI）。demo-plugin 的 `pre-tool-use.sh` 就是这个套路，但 ZCode 不提供现成 AST/AI 能力。
- **借鉴价值（中低）**：ZCode 这里给的是"框架（hook 协议）"而非"实现"。Pi 要做自动模式，得**自己实现 AST + AI 审查**，ZCode 能借鉴的是：
  - hook 的 stdin/stdout JSON 协议设计（`tool_name` + `tool_input` 进，`permissionDecision` + `updatedInput` 出）
  - `modify` 决策（改写命令后放行）— 这是 ZCode 比 Claude Code 多的有用能力，Pi 的"自动模式"可用来"自动脱敏/改写危险命令"
  - `escalate` 决策（自动判断拿不准时升级到人工）— Pi 的"自动模式"遇到模糊命令可 escalate 到"审批模式"

### 9.3 审批模式（仅危险命令需人工审批）
- **ZCode 对应**：`build` mode（Default）/ Auto-Edit Files
- **借鉴价值（高）**：
  - ZCode 的"risky actions 才询问"正是此模式。风险判定在后端 agent（不透明），Pi 可做得更透明（AST + 规则表）
  - **5 类决策选项**（allowOnce/allowAlways-session/allowAlways-project/rejectOnce/rejectAlways）+ **free-text custom** 是非常好的 UX 范本，Pi 直接抄
  - **`addRules` 动态规则库**：用户审批时勾"always allow"，系统自动生成 `toolName + ruleContent` 规则，下次自动放行 — Pi 应实现这个，避免反复问同样问题

### 9.4 严格审批模式（所有命令都需审批）
- **ZCode 对应**：`Confirm Before Changes`（变更前确认）
- **借鉴价值（高）**：
  - ZCode 的"每次修改文件或执行命令前都先确认"
  - 借鉴点：任务暂停 + 输入区阻塞（防用户在审批期间继续追加指令造成竞态）；权限请求与任务绑定（切标签页回来仍 pending）

### 9.5 跨模式的架构借鉴
| ZCode 机制 | Pi 是否值得引入 | 理由 |
|---|---|---|
| 7 事件 hook 协议（尤其 PreToolUse/PermissionRequest 分离） | **强烈推荐** | PreToolUse = 每次都跑；PermissionRequest = 只在本该弹用户时跑。分离后"自动模式"hook 不会污染"审批模式"hook |
| mode 归一化层（`toZCodeMode`） | 推荐 | Pi 未来若支持多后端，统一 mode 名是必要的 |
| `allow/deny/ask` + `escalate/modify` 五元决策 | 推荐 | 比纯 allow/deny 表达力强，escalate/modify 正好服务"自动模式" |
| matcher = tool name 正则 | 推荐 | 简单够用，但 Pi 若要按文件路径/glob 限制，需在 ruleContent 里扩展（ZCode 没做这层） |
| 5 档 UI 模式 | 看情况 | Pi 只有 4 档，不必照搬 5 档；但"Default/AutoEdit"细分有参考价值 |
| 无沙箱 | **不要学** | ZCode 把沙箱甩给用户/后端是缺陷。Pi 应自建沙箱（macOS 用 sandbox-exec，Linux 用 bubblewrap） |
| 无本地 bash AST | **不要学** | Pi 的"自动模式"核心卖点就是 AST+AI，必须自建 |

---

## Sources

官方文档：
- [ZCode 安全操作确认（safety-confirm）](https://zcode.z.ai/cn/docs/safety-confirm)
- [ZCode Agent 文档](https://zcode.z.ai/cn/docs/agents)
- [ZCode Hooks 文档（英文）](https://zcode.z.ai/en/docs/hooks)
- [ZCode 配置 / 连接模型与套餐](https://zcode.z.ai/cn/docs/configuration)
- [ZCode Q&A](https://zcode.z.ai/cn/docs/qa)
- [ZCode Changelog](https://zcode.z.ai/changelog)
- [ZCode 官网](https://zcode.z.ai/)

本地源码/配置（绝对路径）：
- `~/GitApp/ZCode/app/out/wakaru-test/host/entry.js` — `toZCodeMode`、`Py`（mode 列表）、`getModeDisplayLabel`（多后端 mode 标签）、permission_request 事件构造、f0e free-text 正则
- `~/GitApp/ZCode/app/out/host/chunk-J3IIA4Z2.js` — `Pm`（allow/deny/escalate/modify）、`Yy`（allow/deny/ask）、`Qy`（addRules）、`$t`（决策+permissionUpdates）
- `~/GitApp/ZCode/app/out/main/chunk-AR4VZYUL.js` — `jb`/`rk`（mode 枚举全集）、sandboxMode/approvalPolicy RPC schema
- `~/GitApp/ZCode/app/out/renderer/assets/index-I0xDt3Dv.js` — 审批 UI（allowOnce/allowAlways/rejectOnce/rejectAlways/custom 分类、chat.permission.* 事件）
- `~/.zcode/cli/config.json` — 运行时 hooks 配置实例（PreToolUse matcher "bash"）
- `~/.zcode/hooks/payload-dump-*.log` — 真实 hook payload（确认 mode/permission_mode 字段）
- `~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/0.1.0/skills/zcode-configuration-guide/SKILL.md` — 配置位置/作用域/优先级
- `~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/0.1.0/skills/diagnosing-hooks/SKILL.md` — hook schema、7 事件、matcher 规则、12 大坑
- `~/.zcode/cli/plugins/demo-plugin/hooks/pre-tool-use.sh` — bash 拦截 hook 示例

第三方参考：
- [Claude Code 权限模式文档](https://code.claude.com/docs/zh-CN/permission-modes)
- [Claude Code 细粒度权限文档](https://code.claude.com/docs/zh-CN/permissions)
