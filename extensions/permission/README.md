# @zhushanwen/pi-permission

Pi permission 扩展 — 四档权限模式（yolo / auto / approve / strict）+ 三层安全管道（AST 结构分析 + 规则匹配 + AI Classifier），为 bash 工具调用提供可配置的安全门。

## 功能

- **四档权限模式**：从「完全放行」到「全部审批」的渐进式安全策略
- **三层管道**（auto 模式）：AST 结构分析 → 规则匹配 → AI 风险分类 + 用户审批竞速
- **内置危险规则**：12 条 builtin-danger 规则（rm -rf、curl|sh、chmod 777 等高危模式）
- **白名单快速放行**：24+5 条 Codex 安全命令白名单（ls/git status/echo 等）
- **用户自定义规则**：OpenCode wildcard 语法，last-match-wins 语义
- **AI Classifier**：auto 模式下用 LLM 评估未知命令风险（low/medium/high）
- **用户审批 UI**：TUI（自定义 Component）/ RPC（select 对话框）/ headless（fail-closed deny）
- **Reject-with-Reason**：用户拒绝时可输入真实理由（回传 agent 辅助理解）
- **statusline 集成**：TUI 底部显示当前权限模式标签
- **fail-closed**：任何异常路径 → block（绝不静默放行）

## 安装

```bash
# npm 方式（唯一正式方式）
pi install npm:@zhushanwen/pi-permission

# 本地开发（symlink）
ln -s /path/to/xyz-pi-extensions-workspace/feat-permission-and-auto-mode/extensions/permission \
      ~/.pi/agent/extensions/permission
```

## 配置

配置文件位置：`~/.pi/agent/permission-config.json`（首次运行自动创建默认配置）。

可通过 `PI_CODING_AGENT_DIR` 环境变量覆盖基础路径。

### 配置结构

```json
{
  "mode": "yolo",
  "enabled": true,
  "classifier": {
    "enabled": true,
    "model": "auto",
    "timeout": 90,
    "autoApproveLowRisk": true,
    "autoDenyHighRisk": true
  },
  "userRules": []
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `mode` | `"yolo"` | 当前权限模式（yolo/auto/approve/strict） |
| `enabled` | `true` | 扩展是否启用（false=完全放行，等同 yolo 但保留配置） |
| `classifier.enabled` | `true` | 是否启用 AI 层（auto 模式自动 true） |
| `classifier.model` | `"auto"` | AI 模型（`auto` 选最便宜，或 `provider/model-id`） |
| `classifier.timeout` | `90` | AI 分类超时秒数 |
| `classifier.autoApproveLowRisk` | `true` | 低风险是否自动放行（false=转人工） |
| `classifier.autoDenyHighRisk` | `true` | 高风险是否自动拦截（true=强制 deny） |
| `userRules` | `[]` | 用户自定义规则数组 |

## 四档模式

按严格等级从低到高：

### YOLO（默认）

完全无防护，所有工具调用放行。不跑任何层。适合受信任的隔离环境（如 dev container）。

### Auto

安全命令规则直接放行 + 非安全命令过 AI 审查 + AI 认为安全放行 / AI 认为非安全人工审批。

三层管道：
1. **AST 结构分析**（层 1）：tree-sitter-bash 解析命令，检测危险结构（subshell、command_substitution、file_redirect 等）
2. **规则匹配**（层 2）：白名单 + builtin-danger + user rules，last-match-wins
3. **AI Classifier + 用户审批竞速**（层 3）：AI 评估风险等级，同时弹出用户审批；AI 先返回时按 outcome 分支（allow/deny/ask）

### Approve

自动模式去除 AI，规则匹配后安全放行、非安全直接人工审批。无 AI 调用，适合无网络/无 API key 环境。

### Strict

全部审批。不跑 AST/规则/AI，所有工具调用都弹出用户审批。

## 切换模式

```
/permission              显示当前模式和可用模式列表
/permission yolo         切换到 yolo 模式
/permission auto         切换到 auto 模式
/permission approve      切换到 approve 模式
/permission strict       切换到 strict 模式
/permission status       显示详细配置
```

## 内置规则

### 白名单（builtin-safe）

Codex safelist 移植，24 条无条件安全命令 + 5 条条件安全命令（带 flag 子检查）：
- 无条件：`ls`、`pwd`、`echo`、`cat`、`git status`、`git diff`、`git log` 等
- 条件：`git add <safe-path>`、`npm install`（无危险 flag）等

命中白名单 → 直接 `allow`（不跑规则/AI）。

### 危险规则（builtin-danger）

12 条正则规则，匹配高危命令模式：
- `rm -rf /`、`rm -rf ~`
- `chmod 777`
- `curl ... | sh` / `wget ... | sh`
- `dd of=/dev/...`
- 等等

builtin-danger 的 pattern 是 RegExp 源字符串（含 `\b`/`\s`），用 `new RegExp(pattern, 'i')` 编译。

## 自定义规则

在 `permission-config.json` 的 `userRules` 数组添加：

```json
{
  "userRules": [
    {
      "id": "deny-rm-star",
      "tool": "bash",
      "pattern": "rm *",
      "action": "deny",
      "source": "user",
      "description": "deny all rm commands"
    },
    {
      "id": "allow-ls",
      "tool": "bash",
      "pattern": "ls *",
      "action": "allow",
      "source": "user"
    }
  ]
}
```

### 规则字段

| 字段 | 说明 |
|------|------|
| `id` | 唯一 id（用户规则建议 `user-<n>`） |
| `tool` | 工具名匹配（`bash` 精确匹配，`*` 通配所有工具） |
| `pattern` | 命令匹配（OpenCode wildcard：`*` 跨任意字符，`?` 单字符） |
| `action` | 决策动作（`allow` / `deny` / `ask`） |
| `source` | 规则来源（用户规则固定 `user`） |
| `description` | 可选描述 |

### 匹配语义

- **拼接顺序**：`[...builtin-danger, ...userRules]`（builtin 在前，user 在后）
- **last-match-wins**：多条规则匹配时，最后一条胜出（user 可覆盖 builtin）
- **no-match → ask**：无匹配返回 `ask`（交下游 AI/人工，不静默 deny）

## AI Classifier

auto 模式下层 3 用 LLM 评估未知命令风险：

- **模型**：`classifier.model`（`auto` 自动选最便宜，或指定 `provider/model-id`）
- **输出**：`risk_level`（low/medium/high）+ `outcome`（allow/deny/ask）+ `reasoning` + `confidence`
- **override**（WT7 偏差补丁）：
  - `low + allow + autoApproveLowRisk=false` → 强制 `ask`（转人工）
  - `high + allow + autoDenyHighRisk=true` → 强制 `deny`（即使 AI 说放行）
- **Racing**：AI 分类与用户审批并行；AI 先返回时按 outcome 分支（allow/deny 关闭对话框，ask 等用户）

## statusline 集成

session_start 时注册权限 footer，在 TUI 底部显示当前模式标签：

```
[pi-permission] Auto · enabled AST + rules + AI classifier
```

模式标签：YOLO / Auto / Approve / Strict（对应 yolo/auto/approve/strict）。

## 已知限制

- **Footer 单例覆盖**：Pi 只有一个 footer 槽位。本扩展的 footer 会覆盖（或被覆盖）其他扩展的 footer，最典型的冲突是 **`@zhushanwen/pi-statusline`**（两者都注册 footer）。若同时安装，后注册者覆盖前者。要同时显示两者，需自行 fork 合并 footer 渲染逻辑。可用 `grep -r "setFooter" ~/.pi/agent/extensions/` 排查冲突。
- **TUI Reject-with-Reason**：当前 RPC 分支已完整接入 `ctx.ui.input` 采集拒绝理由；TUI 分支因 pi-tui Input 组件集成成本较高，暂保留简化 deny（固定文案），后续迭代补齐内联文本输入。
- **headless 模式**：json/print 模式无交互 UI，所有审批请求 fail-closed deny（不阻塞自动化流程，但 strict/approve 模式下无法放行）。
- **wasm 加载**：AST 分析依赖 tree-sitter-bash wasm，加载失败时 fail-closed（clean=false, parseError=true）。
- **并发**：tool_call handler 用 approvalChain 串行化（Pi 不保证 handler 串行，但权限检查涉及共享 UI 对话框）。

## 架构

```
tool_call event
     │
     ▼
yolo / disabled? ──yes──→ allow（快速路径）
     │ no
     ▼
strict? ──yes──→ 用户审批
     │ no
     ▼
bash? ──yes──→ AST 结构分析
     │              │
     │              ├─ clean=false →（auto: 层3 / approve: 审批）
     │              └─ clean=true  → argv 提取
     │
     ▼
规则匹配（层 2）
     │
     ├─ allow → 放行
     ├─ deny  → 拒绝
     └─ ask   →（auto: 层3 Racing / approve: 审批）

层 3 Racing（auto 模式）：
  AI Classifier  ──┐
                   ├─ race → AI 赢按 outcome / 用户赢按 decision
  用户审批 UI   ──┘
```

## 设计原则

- **fail-closed**：任何异常 → block（绝不静默放行）
- **checkPermission 永不 throw**：caller（tool_call handler）依赖此契约
- **deps 注入**：所有外部依赖（AST/规则/AI/UI）通过 CheckPermissionDeps 注入，便于测试 mock
- **session 隔离**：config 在 session_start 重建的闭包，每 session 独立
- **纯函数核心**：checkPermission / runLayer2 / applyAutoApproveOverrides 都是纯函数

## 开发

```bash
# 类型检查
pnpm --filter @zhushanwen/pi-permission typecheck

# 测试
pnpm --filter @zhushanwen/pi-permission test

# 测试监听模式
pnpm --filter @zhushanwen/pi-permission test:watch
```

## License

MIT
