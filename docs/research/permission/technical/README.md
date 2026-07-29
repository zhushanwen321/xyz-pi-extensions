# Pi Permission "自动模式"技术方案

**日期**：2026-07-27 | **状态**：待用户确认
**前置调研**：[technical/01-pi-llm-invocation.md](./01-pi-llm-invocation.md) + [technical/02-llm-output-format.md](./02-llm-output-format.md) + [technical/03-bash-ast-libraries.md](./03-bash-ast-libraries.md)

---

## 用户明确的四档模式定义

| 模式 | 严格等级 | 行为 |
|---|---|---|
| **yolo** | 最低 | 完全无防护 |
| **自动** | 中 | 安全命令规则直接放行 + 非安全命令过 AI 审查 + AI 认为安全放行 / AI 认为非安全人工审批 + 用户可自定义安全/非安全规则 |
| **审批** | 高 | 自动模式去除 AI（规则匹配后，安全的放行，非安全的直接人工审批） |
| **严格** | 最高 | 全部审批 |

本文聚焦"自动模式"的技术实现方案。

---

## 核心架构：三层判断管道

```
工具调用进入
    │
    ▼
┌─────────────────────────────────────────┐
│ 层 1：AST 结构检查（快速、确定性）        │
│ web-tree-sitter 解析 bash 命令           │
│ ├── 含危险结构（命令替换/重定向/子shell）│
│ │   → 标记"需进一步判断"，进入层 2       │
│ └── 干净的 SimpleCommand[]               │
│     → 提取命令，进入层 2                  │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 层 2：规则匹配（快速、确定性）            │
│ 内置 + 用户自定义规则                     │
│ ├── 命中 deny 规则 → 拦截（结束）         │
│ ├── 命中 allow 规则（安全白名单）→ 放行   │
│ └── 无匹配 → 进入层 3                    │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 层 3：AI Classifier（慢、概率性）         │
│ streamSimple 调最便宜模型                 │
│ ├── risk=low → 放行                       │
│ ├── risk=high → 拦截，转人工审批          │
│ ├── risk=medium 或失败 → 人工审批         │
│ └── 与用户审批框 Racing（零延迟）         │
└─────────────────────────────────────────┘
```

**关键设计**：
- **AST 是第一层快速 gate**：命令替换/重定向/子 shell 等危险结构立即标记，不浪费 AI token
- **规则是第二层**：内置只读白名单（Codex 式）+ 用户自定义规则，命中即决断
- **AI 只处理灰区**：结构干净但不在白名单的命令，才调 AI。减少 AI 调用次数和成本
- **Racing 设计**：AI 与用户审批框并发，AI 快则自动决断，AI 慢或失败则用户审批（fail-safe）

---

## 技术选型（三件调研结论汇总）

| 决策点 | 选型 | 理由 |
|---|---|---|
| **bash AST** | `web-tree-sitter` (0.26.11) + `tree-sitter-bash.wasm` | 纯 wasm 零编译跨平台，能力最强，与 Codex/Claude Code/OpenCode 同款 grammar。见 [03-bash-ast-libraries.md](./03-bash-ast-libraries.md) |
| **LLM 调用** | `getApiProvider(api).streamSimple()` 直接调 | 同进程，继承主进程 provider，无需 spawn 子进程。见 [01-pi-llm-invocation.md](./01-pi-llm-invocation.md) |
| **输出格式** | JSON system prompt + 解析容错 + fallback | 比 structured-output 省 token（~250 vs 几千），fail-safe 到 "ask"。见 [02-llm-output-format.md](./02-llm-output-format.md) |
| **Classifier model** | `"auto"` 选最便宜模型（glm-4-flash 等） | 风险判断不需强模型，temperature=0 |
| **只读白名单** | 移植 Codex `is_safe_command.rs` | 24 个纯只读命令 + base64/find/rg/git/sed 的 flag 子检查 |

---

## 各层实现细节

### 层 1：AST 结构检查

**依赖**：`web-tree-sitter` + `tree-sitter-bash`（提供 .wasm）

**核心逻辑**（移植 Codex `bash.rs` 的白名单策略，~80 行 TS）：
```typescript
const ALLOWED_KINDS = new Set([
  "program", "list", "pipeline", "command", "command_name",
  "word", "string", "string_content", "raw_string", "number", "concatenation",
]);

function analyzeBashCommand(command: string): {
  clean: boolean;           // 是否只有白名单结构
  commands: string[][];     // 提取的 SimpleCommand[]（每个是 token 数组）
  dangerousStructures: string[];  // 检测到的危险结构
} {
  const tree = parser.parse(command);
  const root = tree.rootNode;
  const dangerous: string[] = [];

  // 遍历所有节点
  const queue = [root];
  while (queue.length) {
    const node = queue.shift()!;
    if (!ALLOWED_KINDS.has(node.type)) {
      dangerous.push(node.type);  // command_substitution / file_redirect / subshell / ...
    }
    // 提取 command 的 tokens
    if (node.type === "command") {
      // 收集 command_name + word/string 子节点
    }
    queue.push(...node.namedChildren);
  }

  return {
    clean: dangerous.length === 0 && !root.hasError,
    commands: extractedCommands,
    dangerousStructures: dangerous,
  };
}
```

**决策**：
- `clean: true` → 进入层 2（规则匹配）
- `clean: false` → 命令含替换/重定向/子shell → **跳过规则，直接进入层 3（AI 判断）**。理由：这些结构本身就增加风险，让 AI 评估

**注意**：非 bash 工具（read/write/edit/mcp）跳过层 1，直接进层 2。

### 层 2：规则匹配

**规则来源**（last-match-wins，借鉴 OpenCode + pi-permission-system）：
1. 内置只读白名单（Codex 式，自动 allow）
2. 内置危险规则（permission-gate 10 类，自动 ask/deny）
3. 用户自定义 allow 规则
4. 用户自定义 deny 规则

**内置只读白名单**（层 1 判定 clean 后才查）：
```typescript
const READONLY_SAFE = new Set([
  "cat", "cd", "cut", "echo", "expr", "false", "grep", "head", "id",
  "ls", "nl", "paste", "pwd", "rev", "seq", "stat", "tail", "tr", "true",
  "uname", "uniq", "wc", "which", "whoami",
]);

// 带 flag 子检查的命令
function isSafeWithOptions(command: string[]): boolean {
  const [cmd, ...args] = command;
  switch (cmd) {
    case "base64": return !args.some(a => a === "-o" || a === "--output" || a.startsWith("--output="));
    case "find": return !args.some(a => ["-exec","-execdir","-ok","-okdir","-delete","-fls","-fprint","-fprint0","-fprintf"].includes(a));
    case "rg": return !args.some(a => a === "--pre" || a === "--hostname-bin" || a === "--search-zip" || a === "-z");
    case "git": return isSafeGitCommand(args);  // git status/log/diff/show/branch --list
    case "sed": return args.length <= 2 && args[0] === "-n" && /^\d+(,\d+)?p$/.test(args[1] ?? "");
    default: return READONLY_SAFE.has(cmd);
  }
}
```

**决策**：
- 命中 allow（白名单或用户规则）→ **放行**（结束）
- 命中 deny（用户规则）→ **拦截**（结束）
- 命中 ask（用户规则）→ 进入层 3 前先弹审批框
- 无匹配 → 进入层 3

### 层 3：AI Classifier

**调用方式**：`streamSimple` 直接调（见 [01-pi-llm-invocation.md](./01-pi-llm-invocation.md)）

**System prompt**（~150 token）：
```
你是 AI coding agent 的权限风险分类器。给定一个工具调用，判断其风险等级并返回 JSON。

风险等级：
- low: 只读、无副作用（ls/cat/grep/git status/读取文件）
- high: 破坏性、不可逆、影响系统安全（rm -rf/写系统目录/强制推送/执行远程脚本）
- medium: 介于两者之间（写工作区文件/普通 bash/网络请求）

决策：low→allow, high→deny, medium或不确定→ask
只返回 JSON：{"risk_level":"low"|"medium"|"high","outcome":"allow"|"ask"|"deny","reasoning":"简短理由","confidence":0.0-1.0}
```

**Racing 设计**（pi-permission-system 的零延迟设计）：
```typescript
async function autoModeDecide(context: ToolInvocationContext): Promise<Decision> {
  // 层 1+2 已完成，进入层 3
  const controller = new AbortController();

  // Lane A: 用户审批框（同时弹出）
  const userPromise = showApprovalDialog(context);

  // Lane B: AI classifier（并发跑）
  const classifierPromise = classifyRisk(context, { signal: controller.signal });

  const winner = await Promise.race([
    classifierPromise.then(r => ({ source: "ai", result: r })),
    userPromise.then(d => ({ source: "user", decision: d })),
  ]);

  if (winner.source === "user") {
    controller.abort();  // 用户先决策，取消 AI
    return winner.decision;
  }

  // AI 先返回
  const { outcome } = winner.result;
  if (outcome === "ask") {
    // AI 不确定，fallback 到还在等待的用户框
    return await userPromise;
  }
  closeApprovalDialog();  // AI 决断，关闭用户框
  controller.abort();
  return outcome === "allow" ? Decision.ALLOW : Decision.ASK_HUMAN;
}
```

**fail-safe 策略**：
- AI 超时/网络错误/JSON 解析失败 → outcome = "ask" → 用户审批
- AI 判 low 但 `autoApproveLowRisk: false` → 升级为 ask → 用户审批
- AI 判 high 但 `autoDenyHighRisk: false` → 升级为 ask → 用户审批

---

## 模式间的差异（同一套引擎，不同层启用/禁用）

| 层 | yolo | 自动 | 审批 | 严格 |
|---|---|---|---|---|
| 层 1（AST） | 跳过 | ✅ | ✅ | 跳过（全部审批，不需要分析） |
| 层 2（规则 allow） | 全部放行 | ✅ | ✅ | ❌（忽略 allow 规则，全部 ask） |
| 层 2（规则 deny） | ❌（忽略 deny） | ✅ | ✅ | ✅（deny 仍生效） |
| 层 3（AI） | 跳过 | ✅ | ❌（去除 AI） | 跳过 |
| 用户审批 | 不弹 | AI 判非安全时弹 | 非安全命令弹 | 全部弹 |

**实现**：模式只是这三层的开关组合，底层引擎统一。

---

## 开放问题（需用户决策）

### Q1：AST 解析放在哪个包？

**选项 A**：放在新建的 `extensions/permission/` 包内（自包含）
**选项 B**：放在 `shared/` 下作为共享模块（如 `shared/bash-analyzer/`），未来其他扩展可复用

**推荐 A**（自包含），理由：AST 分析目前只有 permission 用，不过度设计共享层。未来有需求再提取。

### Q2：AST 库依赖体积 5.7MB 是否接受？

`web-tree-sitter` (4.4MB) + `tree-sitter-bash.wasm` (1.3MB) 会进 permission 扩展的 `node_modules`。

**取舍**：
- 接受：能力最强，与 Codex/Claude Code 同款技术栈
- 不接受：退而用 shell-quote（42KB）做第一层粗筛，但命令替换/子shell 有盲区，更多命令会落到 AI 层（增加 AI 成本）

**推荐接受**。5.7MB 对 coding agent 扩展可接受，且 wasm 是一次性下载。

### Q3：AI Classifier 是否需要 transcript 上下文？

Claude Code 的 YoloClassifier 会把"整段对话 transcript + 当前 action"发给 classifier，判断"是否超出用户意图"（scope escalation）。

**取舍**：
- 不带 transcript：省 token（~250 token total），但 AI 只能基于命令本身判断风险
- 带 transcript（最近 N 轮）：AI 能理解上下文（如用户说"删除 tmp 目录"时 `rm -rf tmp/` 是合理的），但 token 成本高

**推荐 MVP 不带 transcript**（纯命令判断），后续迭代可加。理由：permission 主要是命令本身的危险性判断，scope escalation 是更复杂的问题，先不做。

### Q4：是 fork pi-permission-system 还是新建？

**选项 A**：fork pi-permission-system（MasuRii 的 npm 包），加四档模式 + AST + 中文 UI
**选项 B**：在 xyz-pi-extensions 新建 `extensions/permission/`，借鉴 pi-permission-system 的设计但自己实现

**推荐 B**（新建），理由：
1. pi-permission-system 用 `@earendil-works/pi-ai`，xyz-pi-extensions 部分包用 `@mariozechner/pi-ai`（alias），混用易乱
2. pi-permission-system 的 AI Classifier 用旧版事件名（`event.type === "text"`），需改
3. 新建可以更干净地集成 AST + 四档模式，不被 pi-permission-system 的历史包袱约束
4. xyz-pi-extensions 有成熟的扩展开发规范（docs/standards.md）、质量门控、changeset 流程

### Q5：MVP 范围？

**推荐 MVP 分两阶段**：
- **阶段 1（MVP）**：四档模式 UI + 层 2（规则引擎，内置 Codex 白名单 + 用户自定义）+ 层 3（AI Classifier）。**暂不做 AST**，命令解析用 shell-quote 做粗筛 + 命令名提取。
- **阶段 2**：补 AST（web-tree-sitter），替换 shell-quote 粗筛。

**理由**：阶段 1 快速验证四档模式的产品价值，AST 是工程优化（减少 AI 调用），可以后补。但如果用户要"自动模式"一上来就对标 Codex 安全等级，则直接做阶段 2。

---

## 下一步

待用户确认以下决策后进入实现：
1. Q1-Q5 的选择
2. 是否同意三层管道架构
3. MVP 范围（阶段 1 还是直接做阶段 2）

确认后用 EnterPlanMode 出详细实施计划。
