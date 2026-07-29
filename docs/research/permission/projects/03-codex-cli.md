# OpenAI Codex CLI 权限/审批机制调研报告

**调研日期**：2026-07-27 | **置信度**：高（本地 Rust 源码 + Simon Willison 等多源交叉验证）
**调研方式**：researcher subagent，本地源码（`~/GitApp/ai-agent/codex-cli/`）+ 官方文档交叉验证

---

## 核心心智模型（理解一切的前提）

Codex 将"这个 Agent 被允许做什么"拆分为 **两个正交的轴 (axis)**，外加一个可插拔的 **审查者 (reviewer)**：

1. **审批策略 (`AskForApproval`)** —— *什么时候* 拦截命令并向人类请求许可。
2. **权限/沙箱配置 (`PermissionProfile`，旧称为 `SandboxPolicy` / `SandboxMode`)** —— *操作系统级别强制执行* 的限制（可写文件、网络），在命令确实运行时适用。
3. **审批审查者 (`ApprovalsReviewer`)** —— *谁* 来回答审批请求：`user` 或 `auto_review`（一个 AI 子 Agent，代码名为 "guardian"）。

这两者是 **正交的**：你可以使用 `--sandbox danger-full-access --ask-for-approval untrusted`（操作系统授予完全访问权限，但人类审批每一个命令）。这种解耦是 Codex 设计的标志性特征。

关键洞察：由于 Pi 是一个没有操作系统沙箱的进程内 TS Agent，Codex 的轴 #2（操作系统沙箱）**不能直接移植**，但其 **轴 #1 + #3 + 命令分类逻辑** 是最直接可借鉴的设计。

---

## 1. 审批模式 (`ApprovalPolicy` / `AskForApproval`)

**来源：** `codex-rs/protocol/src/protocol.rs:913-937`，CLI 参数 `codex-rs/utils/cli/src/approval_mode_cli_arg.rs:9-31`，参数定义 `codex-rs/tui/src/cli.rs:60-62` 和 `codex-rs/exec/src/cli.rs:42-50`。

### 1a. `--ask-for-approval` / `-a` 的值

wire/CLI 枚举 `AskForApproval` (`protocol.rs:913`)：

| 值 | CLI 别名 | 含义 |
|---|---|---|
| `UnlessTrusted` | `untrusted` | 仅自动运行来自硬编码安全列表 (`is_known_safe_command`) 的"已知安全" **只读** 命令。**其他所有内容都会提示用户。** 最严格的交互模式。 |
| `OnRequest` | `on-request`（默认；别名 `on-failure`） | **由模型决定** 何时请求审批。安全命令自动运行；Agent 会为沙箱逃逸 / 网络访问 / 超出范围的写入 / 破坏性命令显式请求许可。 |
| `Granular(GranularApprovalConfig)` | `granular` | 细粒度的布尔开关，针对每种提示*类别*：`sandbox_approval`, `rules`, `skill_approval`, `request_permissions`, `mcp_elicitations`。当某类别为 `false` 时，该类别的提示被 **拒绝**，而不是显示。（标记为实验性 —— 参见 `protocol.rs:1676` 处的测试 `ask_for_approval_granular_is_marked_experimental`。） |
| `Never` | `never` | 从不提示。失败直接返回给模型；从不升级给用户。 |

`ApprovalModeCliArg` (`approval_mode_cli_arg.rs:9`) 仅暴露 **三个** 人类可用值：`untrusted` / `on-request` / `never`。`granular` 变体仅可通过 config/protocol 订阅，不能通过 `-a` flag 使用。

### 1b. `--full-auto` 和 `--dangerously-bypass-approvals-and-sandbox`

这些是 **便捷预设**，而不是枚举的额外值。

- **`--full-auto`** 已被 **废弃**。定义在 `codex-rs/exec/src/cli.rs:42-50`（`hide = true`，`conflicts_with dangerously_bypass_approvals_and_sandbox`）。在 `cli.rs:103-111` 处发出警告：`"warning: --full-auto is deprecated; use --sandbox workspace-write instead."`。确认方法：在 `exec/src/cli_tests.rs:79-83` 进行测试。在旧版本中，`--full-auto` 意味着 `--sandbox workspace-write --ask-for-approval on-request`。在 `cli/src/main.rs:3085-3106` 处的测试确认了该弃用警告。

- **`--dangerously-bypass-approvals-and-sandbox`**（别名为 `--yolo`）：一个布尔 flag (`codex-rs/utils/cli/src/shared_options.rs:42-49`)。跳过所有确认提示 **并** 禁用沙箱。文档字符串："极度危险。仅用于在受外部沙箱保护的环境中运行。"在 TUI 中，它与 `approval_policy` 冲突 (`tui/src/cli.rs:135-139`)。根据 `developers.openai.com/codex/security` 和社区指南，它大致等同于 `--sandbox danger-full-access --ask-for-approval never`，只是作为单个 flag，旨在用于 CI/容器场景。**置信度：** 沙箱+审批完全禁用的事实为高（源自 flag 文档字符串和源码）；在 `app-server`/子进程模式下完全禁用沙箱的 bug 已被追踪（GitHub issue #14068）。

- 此外还有 **`--dangerously-bypass-hook-trust`** (`shared_options.rs:51-54`)：针对 hook 的信任层，而非一般命令 —— 允许启用的 hook 在本次调用中无需持久化信任即可运行。

### 1c. 模式切换

- **CLI flag**：`--ask-for-approval`, `--sandbox`, `--dangerously-bypass-approvals-and-sandbox` (运行时，最高优先级)。
- **config.toml**：`approval_policy`, `sandbox_mode`, `approvals_reviewer`, `default_permissions` (`codex-rs/config/src/config_toml.rs:174, 200, 179, 208`)。
- **配置文件**：`--profile <name>` 加载 `$CODEX_HOME/<name>.config.toml`，并可以设置这些相同的字段 (`codex-rs/config/src/profile_toml.rs:32-34`)。
- **运行中 / 会话内 (TUI)**：权限弹出菜单允许在预设之间切换，并通过 `AppEvent::UpdateAskForApprovalPolicy` + `override_turn_context` 为下一次回合进行切换 (`tui/src/chatwidget/permission_popups.rs:241-275`)。这是运行时切换机制。

---

## 2. 沙箱机制（Codex 的标志性特征）

### 2a. 操作系统级别的后端

**来源：** `codex-rs/sandboxing/src/lib.rs:1-33`, `codex-rs/sandboxing/src/manager.rs:34-74`, `codex-rs/sandboxing/src/seatbelt.rs:21-30`, `codex-rs/sandboxing/src/landlock.rs`, `codex-rs/linux-sandbox/`。

`SandboxType` 枚举 (`manager.rs:34-40`)：`None`, `MacosSeatbelt`, `LinuxSeccomp`, `WindowsRestrictedToken`。

`get_platform_sandbox()` (`manager.rs:60-74`) 中的选择器：
- **macOS → Seatbelt** (`sandbox-exec`，硬编码为 `/usr/bin/sandbox-exec` 以防止 PATH 注入 — `seatbelt.rs:30`)。策略是用 **Seatbelt Scheme (.sbpl)** 编写的，从 `seatbelt_base_policy.sbpl` + `seatbelt_network_policy.sbpl` + `restricted_read_only_platform_defaults.sbpl` 构建。基础策略是 Chrome 风格的 **deny default**（默认拒绝），并显式允许特定的 sysctl/mach-lookups/PTY 等（在 `seatbelt_base_policy.sbpl:1-123` 中阅读）。**置信度：高。**
- **Linux → bubblewrap + seccomp (受管理路径)**，以及 `codex-rs/linux-sandbox/bwrap.rs` + `landlock.rs` 中的 **Landlock + seccomp (旧版路径)**。`landlock.rs:22-60` 处的辅助程序生成 `codex-linux-sandbox --use-legacy-landlock ...` argv。**网络被默认封禁**（Seccomp syscall 过滤）；`--allow-network-for-proxy` 仅允许代理循环回路径。
- **Windows → RestrictedToken / Elevated** (`WindowsSandboxLevel` 枚举，`config_types.rs:264-274`；默认 `Disabled`)。Windows 支持比 macOS/Linux 更新/可选。

与 Simon Willison 的分析 (https://simonwillison.net/2025/Nov/9/codex-sandbox-investigation/) 交叉验证："macOS = Apple Seatbelt … Linux = Landlock 用于严格的文件系统控制 + seccomp 用于基于 syscall 的网络封锁。" 注意 Willison（2025 年 11 月）没有提到 bubblewrap，但当前的源码同时包含两者 —— bubblewrap 是首选的受管理路径，landlock 是 `--use-legacy-landlock` 后备方案。**置信度：高（源码）。**

### 2b. 沙箱实际强制执行的内容（文件系统 + 网络）

抽象为 `PermissionProfile` (`codex-rs/protocol/src/models.rs:408-422`)：`Managed { file_system, network } | Disabled | External { network }`。旧的 `SandboxPolicy` (`protocol.rs:1000-1048`) 映射如下：

| `SandboxMode` / `SandboxPolicy` 变体 | 文件系统 | 网络 |
|---|---|---|
| `read-only` (默认) | **全盘读取**，**任何地方都没有写入** | 默认被封锁 (`network_access: false`) |
| `workspace-write` | 全盘读取；**写入仅在** `cwd` + `writable_roots` + `/tmp` + `$TMPDIR` (除非被排除) | 默认被封锁 |
| `danger-full-access` | 全盘读 + 写 | 已启用 |
| `external-sandbox` | 调用者说 FS 已在外部被沙箱化 | 可配置 |

**写入根目录保护 (关键细节)：** 可写根目录可以具有 **只读子路径** 和 **受保护的元数据名称** (`WritableRoot`, `protocol.rs:1055-1102`)。这会主动阻止写入 `.git/hooks` 和 `.codex`，即使它们位于工作空间下 —— 这是为了防止 Agent 通过 git hooks 或配置提升自身权限。方法 `is_path_writable()` (`protocol.rs:1069-1087`)。

**`workspace-write` 默认的可写根目录** 是在 `protocol.rs:1173-1230` (`get_writable_roots_with_cwd`) 中计算的：明确的 `writable_roots` + `cwd` + `/tmp` (Unix，除非 `exclude_slash_tmp`) + `$TMPDIR` (除非 `exclude_tmpdir_env_var`)。

### 2c. 沙箱与审批的关系

这是关键的设计耦合（阅读 `codex-rs/core/src/exec_policy.rs:634-750`，特别是 `render_decision_for_unmatched_command`）：

- 在 `read-only` 或 `workspace-write` 下，**不破坏边界的命令在沙箱内自动运行**，无需提示。Agent 可以自由读取文件并写入 `cwd`。
- 当命令 **需要更多权限**（写入沙箱外、网络访问、需要升级的破坏性命令）时，模型发出带有 `sandbox_permissions: "require_escalated"` (或 `"with_additional_permissions"`) 的命令，并附带 `justification` 和可选的 `prefix_rule` (`prompts/templates/permissions/approval_policy/on_request.md`)。这会 **触发审批提示**。
- 在 `OnRequest` 下且具有 **受限** 文件系统沙箱时，匹配安全列表的非危险、未升级命令即使在策略中没有明确规则，也会获得 `Decision::Allow` (`exec_policy.rs:715-733`) —— 沙箱本身是保护手段，不需要提示。
- 如果 `AskForApproval` 为 `Never` 且命令被启发式判定为危险，则该命令为 `Forbidden`，除非沙箱也被明确禁用，在这种情况下它运行 (`exec_policy.rs:684-702`)。

所以：**沙箱 = 细粒度自动执行的强制执行者；审批 = 沙箱逃逸的把关者。** 它们是互补的。

### 2d. 网络/写入策略差异

网络是通过 `NetworkSandboxPolicy` (`Restricted` 默认 / `Enabled`) 处理的独立轴，而 `NetworkAccess` (`Restricted`/`Enabled`, `protocol.rs:984-994`) 是旧的 wire 类型。一个 `workspace-write` + `network_access: true` 配置在运行命令时授予网络权限，但在 `--ask-for-approval on-request` 下，模型仍然 **必须声明意图** 并通过 `request_permissions` / 升级流程。细粒度的每主机规则（带有 `NetworkPolicyRuleAction::{Allow,Deny}` 的 `NetworkPolicyAmendment`）可以由 guardian 或通过用户提示 **持久化** (`protocol.rs:4050-4052`)。

---

## 3. 命令审查机制

### 3a. AST 解析，而非纯正则表达式（对于安全分类）

**来源：** `codex-rs/shell-command/src/bash.rs:1-101`, `codex-rs/core/src/exec_policy.rs:766-804`。

Codex 使用 **`tree-sitter-bash`** 进行真正的 AST 解析 (`bash.rs:3-6`, `bash.rs:13-20`)。对于 `bash -lc "..."` (或 `zsh -lc`/`sh -lc`) 调用，`parse_shell_lc_plain_commands` (`bash.rs:121`) 使用严格的 **允许列表** 遍历 AST：

- **`ALLOWED_KINDS`** (`bash.rs:36-50`)：仅 `program`, `list`, `pipeline`, `command`, `command_name`, `word`, `string`, `string_content`, `raw_string`, `number`, `concatenation`。
- **`ALLOWED_PUNCT_TOKENS`** (`bash.rs:52`)：仅 `&&`, `||`, `;`, `|`, `"`, `'`。
- 任何其他结构 —— **圆括号/子 shell、重定向 (`>`, `>>`, `<`)、命令替换 `$()`、花括号、反引号、变量赋值、控制流** —— 都会导致整个脚本被视为"不安全" (`bash.rs:67-77`)。通过 `bash_lc_unsafe_examples` 测试确认 (`is_safe_command.rs:707-743`)：`(ls)`, `ls > out.txt`, `ls && rm -rf /` 都是不安全的。

`commands_for_exec_policy` (`exec_policy.rs:766-804`) 中的三层回退：
1. `parse_shell_lc_plain_commands` (完整的 word-only AST 解析) → 如果成功，每个段落独立评估。
2. 在 Windows 上：`parse_powershell_command_into_plain_commands` (单独的 PowerShell AST 解析器，`codex-rs/shell-command/src/powershell.rs` + `command_safety/powershell_parser.rs`)。
3. `parse_shell_lc_single_command_prefix` (heredoc 感知的单命令回退，`bash.rs:128`) → 标记为 `used_complex_parsing = true`，这 **禁用自动修正建议** (`exec_policy.rs:289-290`)。
4. 原始 argv 回退。

所以在关键路径（AST 分类）中它是 **AST 优先，模式作为回退**。

### 3b. 基于策略的规则 (Starlark) —— 真正的配置层

**来源：** `codex-rs/core/src/exec_policy.rs:1-50, 234-471`。

在此之上，有一个 **Starlark 策略引擎** (`codex_execpolicy` crate)。规则从各层 `$CODEX_HOME/rules/` 和项目 `.codex/rules/` 中的 `*.rules` 文件加载 (`exec_policy.rs:574-631`)，加上管理员 `requirements.toml` 覆盖。规则语法（来自测试 `exec_policy.rs:806-820` 的示例）：`allow/prompt/forbid for prefix [...]`。规则产生三种决策之一：`Decision::{Allow, Prompt, Forbidden}`。

用户/Guardian 批准的规则 **持久化到磁盘** (`exec_policy.rs:376-471` 中的 `append_amendment_and_update` 和 `append_network_rule_and_update`)：一个新的 `allow for prefix [...]` 行被追加到 `default.rules`，并且内存中的策略是热重载的。这是"记住我的决定"机制 —— 请参阅第 4 节。

### 3c. AI 审查 (guardian / `auto_review`)

**来源：** `codex-rs/core/src/tools/approvals.rs:136-263`, `codex-rs/core/src/guardian/policy.md`, `codex-rs/protocol/src/config_types.rs:157-185`。

`ApprovalsReviewer` 可以是 `User`（默认）或 `AutoReview`（别名 `guardian_subagent`）。当为 `AutoReview` 时，升级的请求被路由到一个 **单独的、专门提示的子 Agent**（`approvals.rs:223-252` 中的 "guardian"），该 Agent：
- 收到一个 `GuardianApprovalRequest` (Shell / ExecCommand / ApplyPatch — `approvals.rs:28-112`)。
- 应用 **风险分类框架** (`guardian/policy.md`)，包含类别：数据外泄、凭据探测、持久性安全削弱、破坏性操作、低风险操作。每个操作都获得一个风险级别（`low`/`medium`/`high`/`critical`），并结合 `user_authorization` 进行批准/拒绝。
- 可以返回 `ReviewDecision::Approved`, `ApprovedForSession`, `ApprovedExecpolicyAmendment{...}` (持久化规则), `NetworkPolicyAmendment{...}` (持久化每主机规则), `Denied`, `Abort`, 或 `TimedOut` (`protocol.rs:4033-4065`)。

这是一个真正的 **第二意见 AI 审查者**，由不同的、安全侧重的提示词驱动。它 **不是** 主 Agent 的自我审查 —— 它是一个单独的子 Agent 调用。UI 标签："Approve for me" / 描述："Only ask for actions detected as potentially unsafe." (`tui/src/chatwidget.rs:474-475`)。**置信度：高。** 这是一个相对较新（2026 年）的功能，由 `Feature::GuardianApproval` 门控。

### 3d. 读取 vs 写入命令的区别

是的，非常明确。`is_safe_to_call_with_exec` (`is_safe_command.rs:67-173`) 硬编码了 **只读** 命令的安全列表：`cat, cd, cut, echo, expr, false, grep, head, id, ls, nl, paste, pwd, rev, seq, stat, tail, tr, true, uname, uniq, wc, which, whoami`，加上带有子检查的 `base64`/`find`/`rg`/`git`/`sed`，以确保没有带有副作用的 flag（例如，`find -delete/-exec` 是不安全的，`git branch -d` 是不安全的，`git --paginate` 是不安全的，但 `git status/log/diff/show/branch --list` 是安全的 — `is_safe_command.rs:175-295`）。这个安全列表是 **`UnlessTrusted` 审批策略的自动批准机制** (`exec_policy.rs:663-669`)。

还有一个单独的 `command_might_be_dangerous` 检查 (`codex-rs/shell-command/src/command_safety/is_dangerous_command.rs`，引用为 `command_might_be_dangerous`)，用于检测如 `rm`, `sudo`, 破坏性 git 操作等命令，并强制执行 `Prompt`（如果提示被禁用则为 `Forbidden`）—— 参见 `exec_policy.rs:677-702`。

---

## 4. 审批交互流程与决策持久化

**来源：** `codex-rs/core/src/tools/approvals.rs:180-307`, `codex-rs/tui/src/chatwidget/permission_popups.rs`, `codex-rs/protocol/src/protocol.rs:4033-4086`。

### 流程

1. 工具调用 (`Shell` / `ExecCommand` / `ApplyPatch`) 产生一个 `ApprovalAction` (`approvals.rs:28-56`)。
2. `resolve_tool_apporval` (`approvals.rs:180-263`) 首先运行 **权限请求 hooks** (`run_permission_request_hooks`) —— hooks 可以预先 `Allow` 或 `Deny` 而无需进一步路由。这是第三种决策来源。
3. 如果没有 hook 决策，则路由到配置的审查者：`Guardian` (AI 子 Agent) 或 `User` (TUI/IDE 弹出菜单)。
4. 审查者返回一个 `ReviewDecision`。

### 决策持久化（是的，它可以"记住决定"）

`ReviewDecision` 变体 (`protocol.rs:4033-4065`) 是关键：

| 决策 | 持久化作用域 |
|---|---|
| `Approved` | 仅此一次 |
| `ApprovedForSession` | 自动批准会话范围缓存中剩余的相同提示 |
| `ApprovedExecpolicyAmendment { proposed_execpolicy_amendment }` | **持久化一个 `allow for prefix [...]` 规则** 到 `default.rules` (磁盘 + 热重载内存)。跨会话存活。 |
| `NetworkPolicyAmendment { action: Allow/Deny }` | 为该主机持久化每主机网络规则 |
| `Denied` / `Abort` / `TimedOut` | 不执行，可选择继续/中止回合 |

所以用户有 **三个粒度**："yes once"（同意一次）、"yes for this session"（本次会话同意）、"yes and remember a rule forever"（同意并永远记住规则）。修正建议由引擎导出 (`exec_policy.rs:313-374`, `try_derive_execpolicy_amendment_for_prompt_rules` / `try_derive_execpolicy_amendment_for_allow_rules`) 并 **防范过度宽泛的前缀** —— 有一个 `BANNED_PREFIX_SUGGESTIONS` 列表 (`exec_policy.rs:52-99`)，阻止为 `python3`, `bash`, `sudo`, `git`, `node`, `perl` 等生成修正，测试函数 `prefix_rule_would_approve_all_commands` (`exec_policy.rs:899-920`) 验证建议的规则实际上是否会批准命令。

### TUI 用户体验

权限菜单 (`permission_popups.rs:11-160`) 显示三个内置预设（见第 6 节）加上当 `Feature::GuardianApproval` 开启时的可选 "Approve for me"。切换会发出 `override_turn_context(...)` + `UpdateAskForApprovalPolicy` + `UpdateActivePermissionProfile` + `UpdateApprovalsReviewer` (`permission_popups.rs:248-274`)。`Full Access` 需要确认 (`OpenFullAccessConfirmation`)，除非 `hide_full_access_warning` (`permission_popups.rs:307-323`)。

---

## 5. 工具粒度

**来源：** `codex-rs/core/src/tools/approvals.rs:28-56`, `codex-rs/protocol/src/protocol.rs:4033`。

三个具体的 `ApprovalAction` 变体显示了粒度：
- **`Shell`** — Shell 命令（上面描述的完整 AST + 策略 + 安全列表管道）。
- **`ExecCommand`** — exec-server 路径（有 `tty: bool` 区分）。
- **`ApplyPatch`** — 文件编辑补丁；由 `cwd` + `files` + `patch` 标识。审批要求 **每个文件路径** 都在可写根目录内；任何沙箱外的文件都会触发提示。

**MCP 工具** 通过 `AskForApproval::Granular` 中的 `mcp_elicitations` 开关 (`protocol.rs:951-953`) 和独立的 `skill_approval` 开关 (`protocol.rs:947-948`) 获得批准。所以 MCP 调用（可能调用任意服务器端代码）可以作为一类获得自己的批准控制。

注意 `--dangerously-bypass-approvals-and-sandbox` 影响所有这些 —— 它是 Agent 范围的，而不是针对每个工具的。

---

## 6. config.toml 权限配置

**来源：** `codex-rs/config/src/config_toml.rs:170-213, 560-580, 737-816`, `codex-rs/config/src/loader/mod.rs:773-800`。

`~/.codex/config.toml`（和项目 `.codex/config.toml`，以及 `requirements.toml` 中的管理员覆盖）中的关键字段：

```toml
approval_policy = "untrusted"          # | "on-request" | "never"   (config_toml.rs:174)
approvals_reviewer = "user"            # | "auto_review"            (config_toml.rs:179)
auto_review = { policy = "..." }       # guardian 的额外提示       (config_toml.rs:182-183)

sandbox_mode = "workspace-write"       # | "read-only" | "danger-full-access"  (config_toml.rs:200)
sandbox_workspace_write = {            # 仅当 sandbox_mode = workspace-write   (config_toml.rs:203)
  writable_roots = ["/abs/path"]
  network_access = false
  exclude_tmpdir_env_var = false
  exclude_slash_tmp = false
}

default_permissions = ":workspace"     # 新的配置文件系统；":workspace"/":read-only"/":danger-full-access" 或命名的 [permissions.<id>]  (config_toml.rs:208)
[permissions.<id>]                      # 命名的权限配置文件，可选 `extends`  (config_toml.rs:211-212)

[projects."/path/to/dir"]              # 每个目录信任决策              (config_toml.rs:425, 568-580)
trust_level = "trusted"                # | "untrusted"
```

**信任的项目目录**：带有 `trust_level = "trusted"` 或 `"untrusted"` 的 `[projects."<abs-path>"]` 会影响默认沙箱。如果目录有信任决策但没有明确的 `sandbox_mode`，它默认为 `workspace-write` (或 Windows 未沙箱化时的 `read-only`) (`config_toml.rs:751-768`)。`TrustLevel` 枚举是 `codex-rs/protocol/src/config_types.rs:575-581`。

### 内置预设（由 config + CLI 共享）

**来源：** `codex-rs/utils/approval-presets/src/lib.rs:28-61`。这些是面向用户的"模式"：

| 预设 ID | 标签 | `approval_policy` | 权限配置文件 |
|---|---|---|---|
| `read-only` | "Read Only" | `on-request` | `read_only()` (无写入，无网络) |
| `auto` | "Default" (Agent 模式) | `on-request` | `workspace_write()` (写入 cwd，无网络) |
| `full-access` | "Full Access" | `never` | `Disabled` (无沙箱) |

这与社区指南（搜索结果中的 "Suggest / Auto Edit / Full Auto"）相匹配，尽管 Codex 自身的标签是 "Read Only / Default / Full Access"。"Approve for me"选项 **不是一个单独的预设** —— 它是 `auto` 预设且 `approvals_reviewer = auto_review` (`permission_popups.rs:101-124`)。

---

## 7. 关于 Pi 四种模式的借鉴价值

Pi 期望的四种模式：**yolo / 自动 (AST+AI 审查) / 审批 (仅危险命令审批) / 严格审批 (全部审批)**。Pi 的约束是：**TS 进程内执行，无操作系统沙箱**。这意味着 Pi 不能依赖操作系统级别的文件系统/网络强制执行 —— 每个保护必须在软件/Agent 层面实现。

### Codex 可以直接映射到 Pi 的内容

| Pi 模式 | Codex 对应物 | 可借鉴内容 |
|---|---|---|
| **yolo (完全访问)** | `--dangerously-bypass-approvals-and-sandbox` / `full-access` 预设 (`Never` + `Disabled`) | 清晰的 1:1 映射。将其设为带有确认警告的显式模式（如 Codex 的 `OpenFullAccessConfirmation`）。 |
| **严格审批 (全部审批)** | `--ask-for-approval untrusted` (`UnlessTrusted`) —— 即"安全列表只读命令自动运行；其他所有内容提示" | 最接近的 Codex 等价物。Pi 可以采用相同的安全列表思路：自动运行硬编码的只读命令，其他所有内容提示。 |
| **审批 (仅危险命令审批)** | `--ask-for-approval on-request` (`workspace-write` 预设) —— Agent 自我约束 | Codex 让 **模型** 决定何时请求升级 (`require_escalated` + `justification`)。Pi 可以让 Agent 标记危险操作，加上一个软件危险启发式检测 (`command_might_be_dangerous`)。 |
| **自动 (AST+AI 审查)** | Codex 的 `auto_review` / guardian 子 Agent + AST 解析 | **最强大的借鉴。** Codex 的 guardian 是一个具有风险分类的真正独立的 AI 审查者。Pi 可以实现等效功能。 |

### Pi 必须重新设计的内容（因为没有操作系统沙箱）

1. **没有操作系统强制执行意味着沙箱轴 (#2) 无法携带 Pi 中的任何安全权重。** 在 Codex 中，`workspace-write` 沙箱 *保证* 命令不能在物理上写入 `cwd` 之外。Pi 没有这样的保证 —— 所以 Pi 的"自动"/"审批"模式必须 **将所有安全依赖于审批轴 + AI 审查 + 软件命令分类**，而不是文件系统边界。这是一个根本性的转变：Codex 的安全是 **纵深防御 (操作系统沙箱 → 审批 → 策略 → AI)**；Pi 的必须是 **审批/审查为主，软件分类为辅**。

2. **Pi 应该采用 Codex 的命令分类流水线**（最能直接借鉴的技术资产）：
   - **使用 tree-sitter-bash (或 TS 等价物) 进行 AST 解析**，带有严格的 ALLOWED_KINDS/ALLOWED_PUNCT 风格允许列表 —— 拒绝子 shell、重定向、替换作为"无法证明安全"。Codex 源码 `shell-command/src/bash.rs` 是一个可直接使用的蓝图。
   - **硬编码只读安全列表** (`is_safe_to_call_with_exec`) 用于"已知安全"类别 —— `ls`, `cat`, `grep`, `git status`, `rg` 等，带有针对命令特定的不安全 flag 的子检查。
   - **危险命令启发式检测** (`command_might_be_dangerous`) 用于 `rm`, `sudo`, 破坏性 git 操作等。
   - **可持久化的前缀规则** (Starlark `allow/prompt/forbid for prefix [...]`) —— 这让用户随着时间的推移建立一个不断增长的允许列表，且无需打开完整的 yolo 模式。带有针对过度宽泛前缀的 `BANNED_PREFIX_SUGGESTIONS` 防御是一个值得保留的巧妙保障。

3. **Pi 应该为"自动"模式采用 guardian/second-opinion AI 审查者模式** —— 一个单独的、具有安全侧重点提示词的子 Agent，应用风险分类（数据外泄 / 凭据探测 / 破坏性 / 安全削弱）。Codex 的 `guardian/policy.md` 是提示词设计的直接模板。关键细节：它是一个 **独立的子 Agent 调用**，而不是主 Agent 自我审查 —— 这避免了"被告同时担任法官"的问题。

4. **Pi 应该采用三状态决策持久化** (once / session / persistent-rule) —— `ReviewDecision` 枚举 (`Approved` / `ApprovedForSession` / `ApprovedExecpolicyAmendment`) 是一个干净、可推广的设计，用户会很欣赏。

5. **Pi 可以放弃**：操作系统沙箱后端 (seatbelt/landlock/bwrap)、seatbelt .sbpl 策略文件、每主机网络规则（没有操作系统网络命名空间来强制执行它们）、`external-sandbox` 概念以及 Windows 受限 token 工作 —— 所有这些都依赖于 Pi 不具备的操作系统原语。

6. **值得注意的不对称性**：Codex 的 `on-request`（Pi 的"审批"模式对应物）严重依赖 **沙箱** 来允许非危险命令自动运行，而不会用提示淹没用户。如果没有操作系统沙箱，Pi 的"审批"模式要么会频繁提示（烦人），要么必须更严重地依赖软件安全/危险分类来确定什么可以在无需提示的情况下运行。Pi 可能需要 **比 Codex 的 `UnlessTrusted` 更丰富的自动允许启发式检测**，以保持"审批"模式的可用性。

---

## 来源

本地源码（主要，绝对路径）：
- `~/GitApp/ai-agent/codex-cli/codex-rs/protocol/src/protocol.rs` (AskForApproval:913, SandboxPolicy:1000, ReviewDecision:4033, WritableRoot:1055)
- `~/GitApp/ai-agent/codex-cli/codex-rs/protocol/src/config_types.rs` (SandboxMode:86, ApprovalsReviewer:157, TrustLevel:575)
- `~/GitApp/ai-agent/codex-cli/codex-rs/protocol/src/models.rs` (PermissionProfile:408)
- `~/GitApp/ai-agent/codex-cli/codex-rs/core/src/exec_policy.rs` (命令审查引擎，render_decision_for_unmatched_command:634)
- `~/GitApp/ai-agent/codex-cli/codex-rs/shell-command/src/bash.rs` (tree-sitter AST 解析)
- `~/GitApp/ai-agent/codex-cli/codex-rs/shell-command/src/command_safety/is_safe_command.rs` (只读安全列表)
- `~/GitApp/ai-agent/codex-cli/codex-rs/core/src/tools/approvals.rs` (审批路由, guardian)
- `~/GitApp/ai-agent/codex-cli/codex-rs/core/src/guardian/policy.md` (AI 审查者风险分类)
- `~/GitApp/ai-agent/codex-cli/codex-rs/sandboxing/src/{lib.rs,manager.rs,seatbelt.rs,landlock.rs}` + `.sbpl` 文件 (操作系统沙箱后端)
- `~/GitApp/ai-agent/codex-cli/codex-rs/utils/cli/src/{shared_options.rs,approval_mode_cli_arg.rs,sandbox_mode_cli_arg.rs}` (CLI flags)
- `~/GitApp/ai-agent/codex-cli/codex-rs/exec/src/cli.rs:42-111` (--full-auto 弃用)
- `~/GitApp/ai-agent/codex-cli/codex-rs/utils/approval-presets/src/lib.rs:28-61` (内置预设)
- `~/GitApp/ai-agent/codex-cli/codex-rs/config/src/config_toml.rs` (config.toml 字段, ProjectConfig:568)
- `~/GitApp/ai-agent/codex-cli/codex-rs/tui/src/chatwidget/permission_popups.rs` (TUI 审批用户体验)
- `~/GitApp/ai-agent/codex-cli/codex-rs/prompts/templates/permissions/` (每模式 Agent 提示词)

网络（交叉验证）：
- [Agent approvals & security — ChatGPT Learn (官方)](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Codex security — OpenAI Developers](https://developers.openai.com/codex/security) (403 — 通过搜索片段验证)
- [OpenAI Codex CLI Sandbox Implementation Analysis — Simon Willison](https://simonwillison.net/2025/Nov/9/codex-sandbox-investigation/)
- [Codex CLI Sandbox Analysis — Agent Safehouse](https://agent-safehouse.dev/docs/agent-investigations/codex)
- [How to bypass Codex sandbox — Apidog](https://apidog.com/blog/bypass-codex-sandbox/)
- [Codex CLI skip permissions — AllThings.how](https://allthings.how/codex-cli-skip-permissions-how-to-bypass-approvals-and-sandbox/)
- [GitHub Issue openai/codex#4565 — forced tool approval on rm stall](https://github.com/openai/codex/issues/4565)
- [GitHub Issue openai/codex#14068 — app-server child sandbox with bypass flag](https://github.com/openai/codex/issues/14068)
- [GitHub Issue openai/codex#1254 — dangerously-auto-approve-everything discussion](https://github.com/openai/codex/issues/1254)

**矛盾/注意事项：** Simon Willison 2025 年 11 月的文章将 Linux 沙箱描述为 "Landlock + seccomp"，但当前的源码显示 `bubblewrap + seccomp` 是受管理路径，而 `Landlock` 是 `--use-legacy-landlock` 回退方案。当前权威的是本地源码（bubblewrap 优先，landlock 遗留）。社区报告的 `--dangerously-bypass-approvals-and-sandbox` 在 `app-server`/子进程模式下并不完全禁用沙箱的 bug（issue #14068）是真实的，但已追踪；它不影响设计意图。
