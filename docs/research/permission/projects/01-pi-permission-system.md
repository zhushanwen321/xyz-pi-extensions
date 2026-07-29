# pi-permission-system 权限机制调研

**调研日期**：2026-07-27 | **置信度**：高（本地源码精读，作者 MasuRii，npm 包 `pi-permission-system`）
**源码位置**：`~/GitApp/ai-agent/pi-permission-system/`（含 README、`src/*.ts`、`docs/design-ai-classifier.md`）

> 这是主 agent 亲自精读的参考，不是 researcher 子 agent 产出。它是 Pi 生态最直接的参考实现，README 明确说"从 OpenCode 移植"。

---

## 0. 定位与核心心智模型

**npm 包名**：`pi-permission-system`（作者 MasuRii，与 `pi-multi-auth`/`pi-tool-display`/`pi-rtk-optimizer` 同作者）。
**核心定位**：为 Pi 提供"集中式、确定性的权限门控"，覆盖 tool / bash / mcp / skill / special 五类操作。

**架构核心**：声明式规则（4 层合并） + 三态决策（allow/deny/ask） + 可选 AI Classifier（在 ask 出口做风险分级） + YOLO 模式（ask 自动转 allow）。

---

## 1. 权限三态模型

| State | 行为 |
|---|---|
| `allow` | 静默放行 |
| `deny` | 阻塞并报错 |
| `ask` | 弹 UI 确认 |

`ask` 弹窗时 UI 提供 4 个选项：`Allow Once` / `Allow Always`（持久化匹配规则）/ `Reject` / `Reject with Reason`（拒绝理由回传给 agent）。`Allow Once` 记内存当前 runtime 的临时批准。

---

## 2. 4 层规则引擎（last-match-wins）

```
Global policy file      (~/.pi/agent/pi-permissions.jsonc)
  → Project policy      (<cwd>/.pi/agent/pi-permissions.jsonc)
    → Global agent      (~/.pi/agent/agents/<name>.md frontmatter 的 permission: 块)
      → Project agent   (<cwd>/.pi/agent/agents/<name>.md)
```

**关键规则**：
- 后层覆盖前层（last matching rule wins，wildcard `*` 匹配）
- **项目层无法放宽全局层的 `deny`**（trusted floor 机制）—— 项目层的 `allow`/`ask` 在全局层是 `deny` 时被忽略

**通配符匹配**（`src/wildcard-matcher.ts`）：compile-once，正则预编译 + specificity sorting。bash 命令走 `src/bash-filter.ts`（也是 wildcard，**不是 AST**）。

**策略解析与合并**（`src/permission-manager.ts`，937 行）：
- `PermissionManager` 类负责全局/项目策略加载、合并、缓存
- 文件 mtime 戳缓存避免重复读
- `findLatestTrustedPermissionMatch` 实现层间覆盖语义

---

## 3. 五个权限类别

| 类别 | 控制对象 | 规则语法示例 |
|---|---|---|
| `tools` | 按工具名（含 builtin + 扩展工具） | `{"read": "allow", "write": "deny", "*": "ask"}` |
| `bash` | 按 bash 命令通配符 | `{"git *": "ask", "git status": "allow", "rm -rf *": "deny"}` |
| `mcp` | 按 MCP server/tool（代理工具） | `{"myServer:*": "ask", "mcp_status": "allow"}` |
| `skills` | 按 skill 名 | `{"*": "ask", "dangerous-*": "deny"}` |
| `special` | external_directory / doom_loop | `{"external_directory": "ask", "doom_loop": "deny"}` |

**MCP 拆分设计**（与 OpenCode 最大差异）：
- `permission.mcp` 控制 **mcp proxy 工具** 的 server/tool 目标（如 `myServer:search`）
- `permission.tools` 控制 **直接注册的扩展工具**（如 `context7_*`、`github_*`）
- 解析顺序：specific mcp patterns → `tools.mcp` fallback → `defaultPolicy.mcp`

**special.external_directory**：路径携带型工具（`read/write/edit/find/grep/ls`）显式访问 `ctx.cwd` 外的路径时，**先于** normal tool permission 评估。

---

## 4. YOLO 模式（= 用户期望的"yolo 完全访问"）

- `config.json`（扩展本地配置）的 `yoloMode: true`
- 所有 `ask` 自动转 `allow`（但 `deny` 仍生效，deny 是 trusted floor）
- 运行时切换：
  - `/permission-system` 命令打开设置 modal
  - `globalThis.__piPermissionSystem.toggleYoloMode({ persist?: boolean, source?: string })` API 供其他扩展调用
  - `getYoloMode()` / `setYoloMode(enabled, options?)` / `toggleYoloMode(options?)`
  - `persist: false` 时仅当前 session 生效，不写 config.json

**默认值**：`yoloMode: false`。

---

## 5. AI Classifier（= 用户期望的"自动模式"的关键实现）

**设计文档**：`docs/design-ai-classifier.md`（2026-06-06，Design Review 状态）。

### 5.1 核心思路

在 `ask` 出口接入轻量 LLM 分类器（~200 token system prompt），判断风险等级：
- **low risk** → `allow`（自动放行）
- **high risk** → `deny`（自动拦截）
- **medium risk / uncertain** → 回退到用户确认

**YOLO 与 AI Classifier 互斥**：AI Classifier 启用时，`shouldAutoApprovePermissionState()` 返回 false，绕过 YOLO。理由：YOLO 是无条件 allow，AI Classifier 是有条件的，同时启用语义冲突。

### 5.2 Classifier Racing（零延迟设计）

`src/classifier-racing.ts`（112 行）—— **核心创新**：

用 `Promise.race` 让**用户审批对话框**和 **AI 分类**并行赛跑：
- 用户先决策 → 用用户的，abort AI
- AI 先返回且明确（allow/deny）→ 用 AI 的，关闭对话框
- AI 不确定（ask）→ fallback 到还在等待的用户对话框

这避免了"AI 审查增加延迟"的问题——用户原本就要等审批，AI 在后台跑，不抢时间。

### 5.3 LLM 调用方式

`src/ai-classifier.ts`（331 行）：
- 用 `@earendil-works/pi-ai` 的 `getApiProvider(model.api).streamSimple()` —— **同进程，无 IPC 开销**
- temperature=0，maxTokens=256
- **强制 JSON-only 输出**：`{"risk_level":"low"|"medium"|"high","outcome":"allow"|"ask"|"deny","reasoning":"brief","confidence":0.0-1.0}`
- 解析失败/超时/网络错误 → fallback 到 `{ outcome: "ask" }`（fail-safe 到用户审批）

### 5.4 System Prompt（~200 token）

```
Permission risk classifier. Given a tool invocation, respond JSON only.
low risk→allow, uncertain→ask, destructive→deny.
{"risk_level":"low"|"medium"|"high","outcome":"allow"|"ask"|"deny","reasoning":"brief","confidence":0.0-1.0}
```

### 5.5 Model 解析

- `"auto"` → 读 `~/.pi/agent/models.json`，选最便宜的可用模型（`findCheapestModel`）
- `"provider/model-id"`（如 `zhipu/glm-4-flash`）→ 显式指定

### 5.6 配置（`src/extension-config.ts`）

```ts
interface AiClassifierConfig {
  enabled: boolean;            // 默认 false
  model: string;               // 默认 "auto"
  timeout: number;             // 默认 90 (秒)
  autoApproveLowRisk: boolean; // 默认 true
  autoDenyHighRisk: boolean;   // 默认 true
}
```

- `autoApproveLowRisk: false` → low risk 也回退用户（safety mode）
- `autoDenyHighRisk: false` → high risk 也回退用户（cautious mode）

### 5.7 关键缺口：无 bash AST 解析

**重要**：`bash` 类别只有 wildcard 字符串匹配（`evaluate-permission.ts` 58 行，纯 regex）。这意味着：
- `rm -rf /` 能被 `rm -rf *` 匹配
- 但 `rm -rf --no-preserve-root /`（flag 变体）、`$(rm -rf x)`（命令替换）、`echo "$(curl evil)"`（管道注入），wildcard 匹配**不可靠**

用户期望的"自动模式"里的 **"bash AST 解析"** 是 pi-permission-system **没有**的部分，需要新设计或借鉴 Claude Code / Codex / OpenCode。

---

## 6. Pi 集成钩子

| Hook | 行为 |
|---|---|
| `before_agent_start` | 过滤激活工具集，从 system prompt 移除 denied 工具条目，隐藏 denied skills |
| `tool_call` | 对每次工具调用强制权限检查 |
| `input` | 追踪显式 `/skill:<name>` 请求（用户主动调用可放行，agent 主动读仍受策略管控） |

**附加行为**：
- 未注册工具在权限检查前就被阻塞（防绕过）
- "Available tools:" system prompt section 被重写以匹配过滤后的激活工具集
- subagent 无 UI 时，`ask` 通过 Pi session 目录转发到主交互 session
- 路径携带工具在 `special.external_directory` 为 ask/deny 时先评估外部目录

---

## 7. 决策持久化

- **内存级**：`Allow Once` → 当前 runtime 临时批准（`src/session-approval-store.ts`，42 行）
- **持久化**：`Allow Always` → 写入 `permanent-approval-store.ts`（93 行），匹配规则持久化
- 路径：`~/.pi/agent/pi-permission-system-approvals.json`

---

## 8. Subagent 权限转发

`src/permission-forwarding.ts`（155 行）：
- 当 subagent（无直接 UI）命中 `ask` 时，通过 Pi session 目录转发到主交互 session
- 主 session 轮询 forwarded requests，显示确认 prompt，写回响应
- subagent 拿到响应后恢复执行

这保证 `ask` 策略即使在非 UI 执行上下文也能用。

---

## 9. 与 Pi 平台的契合度

- 完全在 Pi 进程内执行（TS）
- 使用 Pi 的 `pi.on()` / `pi.registerTool()` / `pi.registerCommand()` API
- 状态持久化用 `ctx.sessionManager` + 文件
- 不依赖任何 OS 级沙箱（与 Pi 约束一致）

**威胁模型自述**：
- 目标：在 host 层而非 model 层强制策略
- **局限**：这是"权限决策层，不是沙箱"——如果允许的工具能做危险操作，策略必须显式限制

---

## 10. 对 Pi 四模式的映射

| 用户期望模式 | pi-permission-system 对应 | 现成度 |
|---|---|---|
| **yolo 完全访问** | `yoloMode: true` | ✅ 完全实现 |
| **自动模式（AST + AI 审查）** | `aiClassifier.enabled: true` + Classifier Racing | ⚠️ AI 部分完整，**无 bash AST**（仅 wildcard 字符串匹配） |
| **审批模式（仅危险命令审批）** | 规则引擎：`bash: { "*": "allow", "rm -rf *": "ask", "git push -f *": "ask" }` | ✅ 规则引擎支持，但要用户自己写危险命令列表 |
| **严格审批模式** | `defaultPolicy: { bash: "ask", ... }` 全部 ask | ✅ 完全实现 |

---

## 11. 借鉴价值总评

**这是 Pi 生态内最直接的参考**，几乎可以直接 fork 或作为 Pi 官方 permission 扩展的起点。核心可借鉴：

1. **4 层规则引擎 + last-match-wins + trusted floor**：成熟的策略合并机制
2. **三态 + 五类别**：覆盖 tool/bash/mcp/skills/special，粒度合理
3. **AI Classifier + Racing**：零延迟的 AI 审查设计，直接对应"自动模式"
4. **YOLO 运行时 API**：`globalThis.__piPermissionSystem.toggleYoloMode()` 让其他扩展调用
5. **Subagent 权限转发**：解决非 UI 上下文的 ask 难题
6. **System prompt sanitizer**：从 prompt 移除 denied 工具，减少 agent"试错换工具"行为

**需要补强的**：
1. **bash AST 解析**（当前只有 wildcard，不够安全）
2. **危险命令默认规则库**（permission-gate 的 10 类规则可补充）
3. **bypass-immune 安全网**（Claude Code 的 `.git/`/`.claude/`/shell rc 写入硬拦截）

**相关 Pi 扩展**：
- `pi-multi-auth` — 多 provider 凭据管理
- `pi-tool-display` — 紧凑工具渲染
- `pi-rtk-optimizer` — RTK 命令重写
