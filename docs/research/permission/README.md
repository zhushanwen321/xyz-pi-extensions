# Pi Permission 功能调研：竞品权限机制综合分析

**调研日期**：2026-07-27 | **分支**：`feat-permission-and-auto-mode`
**调研范围**：pi-permission-system（Pi 生态直接参考）、Claude Code、Codex CLI、OpenCode、ZCode
**调研方式**：4 个 researcher subagent 并行调研（每个一个项目）+ 主 agent 精读 pi-permission-system 源码

---

## TL;DR（先看结论）

1. **用户期望的四种模式（yolo / auto / approve / strict）在五个竞品里都能找到对应物**，但没有任何一个产品把这四档做成"预设模式"——多数靠"声明式规则 + 几个开关"间接表达。**Pi 把它们做成显式四档是一等公民设计，比所有竞品都更清晰**。

2. **"自动模式（AST + AI 审查）"是所有竞品的共同缺口**：
   - Claude Code 有（auto 模式 + 双 classifier），但是 ANT-only feature flag
   - Codex 有（guardian 子 Agent），但是 2026 新功能
   - **pi-permission-system / OpenCode / ZCode 都没有**（pi-permission-system 有 AI Classifier 但无 bash AST；OpenCode 的 AST 只做信息提取不做安全判定；ZCode 完全没有）
   - 这是 Pi 可以做出差异化的核心卖点

3. **最该直接借鉴的三块**：
   - **pi-permission-system 的 4 层规则引擎 + AI Classifier Racing**（Pi 生态同构，几乎可照抄）
   - **Codex 的 tree-sitter bash AST 严格白名单 + 只读安全列表 + guardian 风险分类**（自动模式的技术蓝图）
   - **OpenCode 的声明式 frontmatter 规则 + wildcard 匹配 + doom_loop**（审批模式的规则表达）

4. **Pi 无 OS 沙箱是根本约束**：Codex 的安全模型深度依赖 OS 沙箱（seatbelt/landlock）做"软命令自动放行"的兜底。Pi 必须把这部分安全责任转移到"AI 审查 + 软件命令分类 + 审批"上，不能照搬 Codex 的"沙箱内自动放行"假设。

5. **目录归档**：5 份项目详细报告在 [`projects/`](./projects/)，本文件是综合分析与设计建议。

---

## 一、横向对比总表

### 1.1 权限模式体系

| 产品 | 模式数 | 模式列表 | 切换方式 | 是否有"自动模式" |
|---|---|---|---|---|
| **pi-permission-system** | 2 开关 | `yoloMode` (on/off) + `aiClassifier.enabled` (on/off) | `/permission-system` modal / 运行时 API | ⚠️ AI Classifier 有，但无 bash AST |
| **Claude Code** | 5 公开 + 3 内部 | default / acceptEdits / plan / bypassPermissions / **auto**(preview) + dontAsk/bubble/delegate | Shift+Tab / CLI flag / settings / UI | ✅ auto 模式（YoloClassifier + BashClassifier，ANT-only） |
| **Codex CLI** | 3 预设 × 2 轴 | 预设：read-only / auto / full-access；轴：approval_policy × sandbox_mode | CLI flag / config.toml / TUI 弹出菜单 | ✅ guardian（auto_review 子 Agent，2026 新功能） |
| **OpenCode** | 2 态 | normal / auto（`--auto`=`--yolo`=`--dangerously-skip-permissions`） | CLI flag / TUI command palette | ❌ 无（Issue #33585 是 feature request） |
| **ZCode** | 5 档 UI | Default / ConfirmBeforeChanges / AutoEdit / Plan / FullAccess | UI 选择器 / Shift+Tab | ❌ 无本地 AST/AI（决策在后端，不透明） |

**关键观察**：
- **Claude Code 的 `default` 模式 = 只读自动放行 + 其他全审批**，最接近用户期望的"审批模式"
- **Codex 的 `untrusted`（UnlessTrusted）= 只读白名单自动放行 + 其他全审批**，最接近"严格审批模式"
- **没有任何产品有显式的"严格审批模式"枚举**——都靠"default + 无 allow 规则"间接实现。Pi 做成显式模式是改进

### 1.2 bash 命令审查机制（核心差异化）

| 产品 | AST 解析 | AI 审查 | 只读白名单 | 危险命令检测 |
|---|---|---|---|---|
| **pi-permission-system** | ❌ 仅 wildcard 字符串 | ✅ AI Classifier（ask 出口，Racing） | ❌ | ⚠️ 靠用户写 pattern |
| **Claude Code** | ✅ tree-sitter（严格，too-complex 升级 LLM） | ✅ 双 classifier（YoloClassifier + BashClassifier） | ⚠️ dangerousPatterns（auto 模式剥离宽 allow） | ✅ safety check（.git/.claude/shell rc） |
| **Codex CLI** | ✅ tree-sitter（ALLOWED_KINDS 严格白名单） | ✅ guardian 子 Agent（风险分类） | ✅ is_safe_to_call_with_exec（硬编码只读列表） | ✅ command_might_be_dangerous |
| **OpenCode** | ✅ v1 tree-sitter（仅信息提取，非安全判定）/ ❌ v2 未移植 | ❌ 无 | ❌ | ⚠️ 靠用户写 pattern |
| **ZCode** | ❌ 无本地 AST | ❌ 无本地 AI（后端不透明） | ❌ | ❌ 后端不透明 |

**关键观察**：
- **Codex 的 tree-sitter bash AST 是最严格的设计**：`ALLOWED_KINDS` + `ALLOWED_PUNCT_TOKENS` 白名单，任何子 shell/重定向/命令替换/控制流都标记为"不安全"。这是 Pi "自动模式"最该抄的技术蓝图
- **Claude Code 的"AST 太复杂才升级到 LLM"是省 token 的关键设计**：能用 AST 静态分析就不用 LLM，只有 too-complex 才调 classifier
- **pi-permission-system 的 wildcard 字符串匹配是最大短板**：`rm -rf --no-preserve-root /`（flag 变体）、`$(rm -rf x)`（命令替换）匹配不可靠

### 1.3 决策持久化粒度

| 产品 | 本次 | 会话级 | 持久化规则 | 跨 session |
|---|---|---|---|---|
| **pi-permission-system** | ✅ Allow Once（内存） | ⚠️ runtime 临时批准 | ✅ Allow Always（approvals.json） | ✅ |
| **Claude Code** | ✅ onAllow 不带 updates | ✅ destination=session | ✅ PermissionUpdate（user/project/local settings） | ✅ |
| **Codex CLI** | ✅ Approved | ✅ ApprovedForSession | ✅ ApprovedExecpolicyAmendment（default.rules） | ✅ |
| **OpenCode** | ✅ reply "once" | ⚠️ v1 session-only / ✅ v2 SQLite | ✅ reply "always" | ⚠️ v1 ❌ / ✅ v2 |
| **ZCode** | ✅ allowOnce | ✅ allowForSession | ✅ allowForProject（addRules） | ✅ |

**关键观察**：
- **三档持久化（once/session/persistent）是业界共识**，Pi 应直接采用
- **Codex 的 `BANNED_PREFIX_SUGGESTIONS` 防护**很关键：阻止为 `python/bash/sudo/git` 这类过宽前缀生成 allow 规则（否则等于任意代码执行）

### 1.4 安全网（bypass-immune）

| 产品 | 极端命令硬拦截 | 保护路径 | doom_loop | 外部目录 |
|---|---|---|---|---|
| **pi-permission-system** | ⚠️ 仅 deny 规则 | ✅ external_directory special | ✅ doom_loop special | ✅ |
| **Claude Code** | ✅ `rm -rf /` 即使 bypass 也拦 | ✅ .git/.claude/.vscode/shell rc（bypass-immune） | ❌ | ✅ additionalDirectories |
| **Codex CLI** | ✅ command_might_be_dangerous | ✅ .git/hooks/.codex（WritableRoot 保护） | ❌ | ✅ writable_roots |
| **OpenCode** | ⚠️ 靠 deny 规则 | ⚠️ 靠规则 | ✅ doom_loop（连续 3 次相同 input） | ✅ external_directory |
| **ZCode** | ❌ 后端不透明 | ❌ | ❌ | ❌ |

**关键观察**：
- **Claude Code 的 bypass-immune 安全网最完善**：即使 yolo 也保留两道防线（内容相关 ask 规则 + safety check）
- **OpenCode 的 doom_loop（连续 3 次相同 input 触发 ask）是非常实用的安全网**，建议 Pi 必加
- **Pi 当前 yolo 默认 + 无安全网是最激进的设计**，建议至少加 CC 的"极端命令硬拦截 + 保护路径"

---

## 二、用户期望四模式 × 竞品映射

### 2.1 yolo 完全访问（Pi 当前默认）

| 维度 | 最佳借鉴 | 说明 |
|---|---|---|
| 模式语义 | Claude Code `bypassPermissions` / Codex `full-access` / OpenCode `--yolo` / ZCode FullAccess | 所有产品都有，语义一致 |
| **安全网（必加）** | Claude Code bypass-immune | **Pi 当前 yolo 无任何安全网，这是缺陷**。建议至少加：(a) `rm -rf /` 等极端命令硬拦截；(b) `.git/`/`.claude/`/shell rc 写入强制 ask；(c) OpenCode doom_loop |
| 切换 | pi-permission-system 运行时 API | `globalThis.__piPermissionSystem.toggleYoloMode()` 已实现，可让其他扩展调用 |
| 警告 | Codex `OpenFullAccessConfirmation` | 首次切 yolo 弹确认对话框 |

### 2.2 自动模式（每次请求都走 bash AST + AI 审查）— **Pi 核心差异化**

| 维度 | 最佳借鉴 | 说明 |
|---|---|---|
| **bash AST 解析** | **Codex `shell-command/src/bash.rs`** | 严格白名单（ALLOWED_KINDS + ALLOWED_PUNCT），子 shell/重定向/替换标记 too-complex。**Pi 用 TS 库（shell-quote / bash-parser / tree-sitter-wasm）复刻** |
| **只读白名单** | **Codex `is_safe_to_call_with_exec`** | 硬编码只读命令（ls/cat/grep/git status）+ per-command 不安全 flag 子检查（find -delete 不安全） |
| **AI 审查** | **pi-permission-system AI Classifier + Codex guardian** | pi-permission-system 的 Racing 设计（用户审批 + AI 并发赛跑，零延迟）+ Codex 的风险分类 prompt（数据外泄/凭据探测/破坏性/安全削弱） |
| **AST→LLM 升级** | **Claude Code** | AST too-complex 才调 LLM，省 token。Pi 应采用此分层 |
| **fail-closed** | Claude Code + pi-permission-system | AI API 失败默认 block（不放行），超时/JSON 解析失败 fallback 到用户审批 |
| **独立子 Agent** | **Codex guardian** | AI 审查用独立子 Agent（独立 prompt + temperature=0），避免"被告当法官" |
| 决策增强 | ZCode `escalate` / `modify` | escalate = AI 拿不准时升级到审批模式；modify = 改写命令后放行（自动脱敏） |

**这是 Pi 最该投入的设计重点**。综合最佳实践，Pi 自动模式的技术栈建议：
```
bash 命令 → Codex 风格 AST 严格白名单
  ├── simple（干净拆分）→ 只读白名单匹配 → allow / 进入规则匹配
  ├── too-complex（含替换/控制流）→ 升级到 AI Classifier
  └── parse-unavailable → fallback 到 AI Classifier

AI Classifier（pi-permission-system Racing 设计）
  ├── 输入：toolName + command + path + cwd + agentName + 近期 transcript
  ├── 输出：{risk_level, outcome, reasoning, confidence}
  ├── 低风险 → allow（autoApproveLowRisk）
  ├── 高风险 → deny（autoDenyHighRisk）
  ├── 中风险/不确定 → escalate 到审批模式（用户对话框已并发打开）
  └── 失败/超时 → fallback 到用户审批（fail-closed）
```

### 2.3 审批模式（仅危险命令需人工审批）

| 维度 | 最佳借鉴 | 说明 |
|---|---|---|
| **规则引擎** | **pi-permission-system 4 层 + OpenCode声明式** | pi-permission-system 的 4 层合并（global/project/agent/project-agent）+ trusted floor（项目层不能放宽全局 deny）已成熟。OpenCode 的 frontmatter 语法 + last-match-wins + wildcard 匹配可补充 |
| **危险命令默认库** | **permission-gate 10 类规则** | Delete/Privilege/Permissions/Device/Git destructive/Git clean/Git restore/Network exec/GitHub CLI 等 10 类默认规则，用户可 add/rm |
| **审批 UX** | **ZCode 5 类选项** | allowOnce / allowAlways-session / allowAlways-project / rejectOnce / rejectAlways + free-text 拒绝理由 |
| **动态规则** | **ZCode addRules + Codex BANNED_PREFIX** | 审批时勾"always allow"自动生成规则；但禁止为 python/bash/sudo 等过宽前缀生成 allow |
| 拒绝理由回传 | Claude Code + OpenCode | 拒绝理由作为 tool_result 注入回 agent，让 agent 调整方案 |
| 级联自动放行 | OpenCode | 一次 always 审批后，扫描同 session pending，新规则下 allow 的自动 resolve |

### 2.4 严格审批模式（所有命令都需审批）

| 维度 | 最佳借鉴 | 说明 |
|---|---|---|
| 模式语义 | Codex `untrusted`（UnlessTrusted）/ ZCode ConfirmBeforeChanges | 所有命令审批，只读白名单可自动放行（可选） |
| 实现机制 | pi-permission-system `defaultPolicy: { bash: "ask", ... }` | 全部 ask，已支持 |
| UX 细节 | ZCode 任务暂停 + 输入区阻塞 | 审批期间防用户追加指令造成竞态；权限请求与任务绑定 |

---

## 三、Pi 的特殊约束与设计影响

### 3.1 无 OS 沙箱（根本约束）

Codex 的安全模型深度依赖 OS 沙箱：
- `workspace-write` 沙箱**物理保证**命令不能写入 `cwd` 外
- 沙箱内命令自动放行（无需提示），沙箱外/破坏边界才审批
- 网络默认封禁（seccomp syscall 过滤）

**Pi 是 TS 进程内执行，无 OS 沙箱**。这意味着：
- ❌ 不能照搬 Codex 的"沙箱内自动放行"假设
- ❌ 不能用 OS 级文件系统/网络隔离做兜底
- ✅ 必须把安全责任全部压到"AI 审查 + 软件命令分类 + 审批"上
- ⚠️ Pi 的"审批模式"会比 Codex 更频繁提示（因为没有沙箱兜底自动放行非危险命令），必须靠更强的软件分类（只读白名单 + AST）减少提示

### 3.2 进程内执行 + 多 session

- 模块级 `let` 变量被所有 session 共享，必须用闭包或 `session_start` 重建
- pi-permission-system 已处理此问题（状态存在 ctx.sessionManager + 文件）
- Subagent 无 UI 时的 ask 转发（pi-permission-system 的 `permission-forwarding.ts`）是必备能力

### 3.3 当前 yolo 默认是最激进选择

- Claude Code default = manual（bypass 需显式 flag + 多重守卫）
- OpenCode default = yolo（与 Pi 一致）
- Codex default = on-request（需审批）
- ZCode default = build（risky 才问）

**Pi 把 yolo 设为默认是更激进的选择**，建议：
- 至少加 CC 的"首次使用 warning + 极端命令硬拦截"
- 或考虑把默认改为"审批模式"（risky 才问），yolo 作为可选

---

## 四、推荐的 Pi Permission 架构（综合最佳实践）

### 4.1 四档模式预设（上层）

```
strict（严格审批）
  └─ defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" }
  └─ 所有命令审批，仅只读白名单（ls/cat/grep/git status）自动放行（可选开关）

approve（审批模式，仅危险命令审批）
  └─ 内置危险命令规则库（permission-gate 10 类）→ ask
  └─ 其他默认 allow
  └─ 用户可 add/rm 危险命令 pattern

auto（自动模式，AST + AI 审查）— Pi 核心差异化
  └─ bash → Codex 风格 AST 严格白名单
  └─ too-complex / 非bash → pi-permission-system AI Classifier（Racing）
  └─ 低风险 allow，高风险 deny，中风险 escalate 到审批
  └─ fail-closed（失败 fallback 用户审批）

yolo（完全访问，Pi 当前默认）
  └─ 全部 allow
  └─ 保留 bypass-immune 安全网（极端命令 + 保护路径 + doom_loop）
```

### 4.2 底层统一引擎（保持 pi-permission-system 架构）

- **4 层规则引擎**：global policy → project policy → global agent → project agent（last-match-wins + trusted floor）
- **三态决策**：allow / deny / ask
- **五类别**：tools / bash / mcp / skills / special
- **持久化三档**：once（内存）/ session（runtime）/ always（文件，带 BANNED_PREFIX 防护）

四档模式本质上是**预设 ruleset 生成器 + 是否启用 AI 审查**，底层规则引擎统一。

### 4.3 必加的安全网（跨所有模式）

借鉴 Claude Code + OpenCode：
1. **极端命令硬拦截**：`rm -rf /` / `dd if=/dev/zero of=/dev/sda` 等，即使 yolo 也拦
2. **保护路径写入 ask**：`.git/` / `.pi/` / shell rc 文件
3. **doom_loop 检测**：同工具连续 3 次相同 input → ask（OpenCode）
4. **external_directory guard**：路径携带工具访问 cwd 外 → ask（pi-permission-system 已有）

---

## 五、实施路径建议（短期 vs 长期）

### 短期方案（快速落地，基于 pi-permission-system）

1. **fork 或依赖 pi-permission-system**，加上四档模式预设 UI
2. **补齐危险命令默认规则库**（从 permission-gate 移植 10 类规则）
3. **加 bypass-immune 安全网**（极端命令 + 保护路径 + doom_loop）
4. **加首次 yolo warning**

**性质**：短期方案，绕过"无 AST"的短板，靠规则库 + 安全网兜底。三个月后回来看会想补 AST。

### 长期方案（架构正确，做差异化）

1. **自建 bash AST 解析模块**（TS 库：shell-quote / bash-parser / tree-sitter-wasm），复刻 Codex 的严格白名单
2. **自建只读命令白名单 + 危险命令启发式**（Codex `is_safe_to_call_with_exec` + `command_might_be_dangerous`）
3. **AI Classifier 升级**：借鉴 Codex guardian 的风险分类 prompt + Claude Code 的 transcript 上下文输入
4. **决策增强**：加 ZCode 的 `escalate` / `modify` 决策（modify 可自动脱敏危险命令）
5. **模式归一化层**（ZCode `toZCodeMode`）：为未来多后端适配留接口

**性质**：长期方案，"自动模式"做出真正的差异化竞争力。AST + AI 是其他 Pi 扩展都没有的能力。

### 决策建议

**推荐长期方案**，理由：
1. "自动模式（AST + AI）"是用户明确期望，也是唯一能做出差异化的点
2. 短期方案绕过 AST，"自动模式"就退化成"AI 审查"（pi-permission-system 已有），无差异化
3. AST 模块是一次性投入，复刻 Codex 蓝图工作量可控
4. Pi 生态内无竞品（pi-permission-system 无 AST，permission-gate 只是简化版）

如果资源紧张，可以**分阶段**：先落地短期方案的四档 UI + 安全网，再迭代补 AST + AI 升级。

---

## 六、开放问题（需用户决策）

1. **默认模式**：保持 yolo 默认（当前），还是改为 approve 默认（更安全）？
2. **是否引入 OS 沙箱**：macOS sandbox-exec / Linux bubblewrap 做文件系统隔离？这会大幅提升安全性但增加复杂度
3. **fork pi-permission-system 还是自建**：fork 省力但受制于上游；自建可控但工作量大
4. **自动模式的 AI 成本**：AI Classifier 每次工具调用都调 LLM，成本谁承担？（pi-permission-system 用最便宜模型 + 200 token prompt，但仍是成本）
5. **模式切换 UX**：Shift+Tab 循环（CC/ZCode 风格）vs 命令 palette（OpenCode 风格）vs 设置 modal（pi-permission-system 风格）？

---

## 详细报告索引

| 项目 | 文件 | 核心价值 |
|---|---|---|
| pi-permission-system | [projects/01-pi-permission-system.md](./projects/01-pi-permission-system.md) | Pi 生态直接参考，4 层规则引擎 + AI Classifier Racing，无 bash AST |
| Claude Code | [projects/02-claude-code.md](./projects/02-claude-code.md) | 双 classifier + bypass-immune 安全网 + race 设计，auto 模式是 ANT-only |
| Codex CLI | [projects/03-codex-cli.md](./projects/03-codex-cli.md) | tree-sitter AST 严格白名单 + guardian 子 Agent + 三态持久化，OS 沙箱 deepest |
| OpenCode | [projects/04-opencode.md](./projects/04-opencode.md) | 声明式 frontmatter 规则 + wildcard 匹配 + doom_loop，v1 有 AST（信息提取用）v2 未移植 |
| ZCode | [projects/05-zcode.md](./projects/05-zcode.md) | 5 档 UI + escalate/modify 决策 + PermissionRequest hook，无本地 AST/AI |
