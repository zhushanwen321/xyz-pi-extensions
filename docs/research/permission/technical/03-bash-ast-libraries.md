# Bash AST / 命令判断开源库选型

**调研日期**：2026-07-27 | **置信度**：高（researcher 实测 6 个库，含本地解析验证）
**调研方式**：researcher subagent，npm registry + GitHub API + 本地安装验证

---

## 核心结论

**首选 `web-tree-sitter` (0.26.11) + `tree-sitter-bash.wasm`**：纯 wasm 零编译跨平台，能力最强（与 Codex/Claude Code/OpenCode 同款 tree-sitter-bash grammar），TS 类型完整，OpenCode 已验证可行。体积 5.7MB 对 coding agent 扩展可接受。

**次选 `shell-quote` (1.10.0)**：仅当决定"MVP 先做快速危险字符筛查"时作为第一层 gate。42KB 极小，但识别不了命令替换/子 shell（`echo $(rm -rf /)` 是盲区），不能单独用。

**明确不要选**：`sh-syntax`（Cmd 变体数据不可遍历，只能 validation 不能结构判定）、`bash-parser`（8 年停滞）、原生 `tree-sitter` Node 绑定（Node 24 编译失败硬伤）。

---

## 一、候选库对比表

| 库 | 最新版 | 周下载量 | last publish | GH stars | 维护 | license | 运行时 | 体积 | TS 类型 | 完整 AST | 能力 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **`tree-sitter-bash`** + `tree-sitter` (原生) | 0.25.1 / 0.25.0 | 3.08M / 3.16M | 2025-12 / 2025-06 | 322★ | 活跃 | MIT | 原生 `.node`(6 平台 prebuilds) | 19.8MB | 有 | 是(CST) | 最强 |
| **`web-tree-sitter`** + `tree-sitter-bash.wasm` | 0.26.11 / 0.25.1 | 5.80M / 3.08M | 2026-07-12 / 2025-12 | (同 tree-sitter 主仓) | 活跃 | MIT | **纯 wasm，零编译** | 4.4MB + 1.3MB wasm | 有 | 是(CST) | 强 |
| **`sh-syntax`** (mvdan/sh wasm 封装) | 0.6.0 | 422K(月 1.55M) | 2026-07-08 | 60★ | 活跃 | MIT | 纯 wasm | 836KB | 有(完整) | 部分 | 中(结构浅) |
| **`shell-quote`** | 1.10.0 | **71.2M** | 2026-07-10 | 59★ | 活跃 | MIT | 纯 JS，零依赖 | 42KB | 有 | 否(tokenizer) | 弱 |
| **`bash-parser`** (vorpaljs) | 0.5.0 | 13K | **2017-06**(8 年前) | 230★ | 停滞 | MIT | 纯 JS，21 依赖 | ~? | 无 | 是(AST) | 强但弃 |
| `mvdan-sh`(npm) | 0.10.1 | 147K | 2022-05(4 年前) | (mvdan/sh 8925★) | npm 停滞 | BSD-3 | 纯 JS | 1.47MB | 无 | 是 | 中 |

---

## 二、关键库详细分析

### 1. `web-tree-sitter` + `tree-sitter-bash.wasm`（首选）

- **npm**：`web-tree-sitter` 0.26.11（2026-07-12，很新），MIT，零依赖。OpenCode v1 用的方案。
- **体积**：`web-tree-sitter` 4.4MB + `tree-sitter-bash.wasm` 1.3MB ≈ 5.7MB
- **加载方式**：
  ```typescript
  import { Parser, Language } from "web-tree-sitter";
  await Parser.init();  // 加载 runtime wasm
  const wasmPath = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
  const bash = await Language.load(wasmPath);
  const parser = new Parser();
  await parser.setLanguage(bash);
  const tree = parser.parse('echo $(pwd) | grep foo > out');
  const root = tree.rootNode;  // rootNode 是属性(0.22+)
  ```
- **能力**（与原生 tree-sitter-bash 完全相同，同一份 grammar）：

  | 结构 | 识别 | 节点 kind |
  |---|---|---|
  | `ls -la` | ✅ | `command`/`command_name`/`word` |
  | `ls \| grep foo` | ✅ | `pipeline` |
  | `echo x > file` / `cat < in` / `cmd >> out` | ✅ | `redirected_statement` + `file_redirect` |
  | `echo $(pwd)` | ✅ | `command_substitution` |
  | `` echo `pwd` `` | ✅ | `command_substitution` |
  | `(cmd1; cmd2)` | ✅ | `subshell` |
  | `cmd1 && cmd2` / `\|\|` | ✅ | `list` |
  | `cmd1; cmd2` | 部分 | 无独立节点（flat） |
  | `FOO=bar cmd` | ✅ | `variable_assignment` + `variable_name` |
  | heredoc `cat <<EOF` | ✅ | `heredoc_start`（malformed 出 ERROR） |
  | `cmd &` | 部分 | 无专门 background 节点 |

- **错误处理**：malformed 输入 `rootNode.hasError === true`，部分插入 `ERROR` 节点。**不 throw**，适合"解析失败=不安全"的白名单策略（Codex 做法）。

- **Pi 适用性优势**：
  1. **零编译、零原生依赖、跨平台**（wasm 在 Node/macOS arm64/Linux x64 都能跑）
  2. npm install 无需 install script，不受 npm RFC #868（将默认禁 install script）影响
  3. API 与原生版兼容
  4. OpenCode 已验证可行

- **Pi 适用性劣势**：
  1. 体积大（5.7MB vs shell-quote 42KB）
  2. 异步加载（`Parser.init()` + `Language.load()` 是 async，首次有 wasm 编译开销 ~几十 ms）
  3. wasm 文件路径定位需用 `require.resolve`，打包要把 `.wasm` 当 asset

### 2. `shell-quote`（次选，仅作第一层 gate）

- **npm**：1.10.0（2026-07-10），MIT，零依赖，**周下载 7120 万**（npm top 级）
- **体积**：42KB
- **能力**（README 原文声明）：
  > parse does not currently do command substitution or arithmetic expansion. It was written primarily to extract the immediate tokens from a string ... it does not handle all edge cases.
  - 能识别操作符 token：`|`、`>`、`<`、`&&`、`||`、`;`、`&` 作为 `{op: '|'}` token
  - **命令替换 `$(...)` 和反引号不解析**（原样保留为字面）
  - 是 tokenizer 不是 AST，无嵌套结构

- **安全 CVE 历史**：CVE-2026-9277（≤1.8.3，1.8.4 修复，1.10.0 已含修复）。Pi 只用 parse 不用 quote，风险低。

- **适合场景**：作为**第一层快速 gate**——扫到 `|`/`>`/`&&`/`&` 立即标"需确认"，剩下的"看似简单"命令再用 tree-sitter 精确判定。或 MVP 阶段先用，后续升级 tree-sitter。

- **不适合单独用的原因**：对 `echo $(rm -rf /)` 这类命令替换盲区是安全漏洞。

### 3. `tree-sitter-bash` + `tree-sitter`（原生 Node 绑定，不推荐）

- 能力与 wasm 版完全相同
- **硬伤**：
  1. **Node 24 原生编译失败**（researcher 实测 `npm install tree-sitter` gyp ERR）
  2. 版本对齐脆弱（tree-sitter-bash@0.25.1 要 tree-sitter ^0.25.0，但 0.25.1 publish 失败）
  3. npm RFC #868 将默认禁 install script，原生绑定的 `install: node-gyp-build` 受影响
  4. Pi 扩展通过 `pi install` 分发，**不能假设用户有 C++ 工具链**

### 4. `sh-syntax`（有隐藏陷阱，不推荐）

- 0.6.0（2026-07-08），MIT，mvdan/sh 的 wasm 封装，体积小（836KB）
- **关键陷阱（researcher 实测发现）**：`parse()` 返回的 AST 中，`Stmt.Cmd` 变体数据是"空壳"——`Object.keys(cmd)` 只有 `Pos`/`End`，访问 `cmd.Op`/`cmd.Args`/`cmd.Stmts` 全是 `undefined`
- **后果**：能检测语句数、重定向、后台、能否解析，**不能**区分管道 vs 子 shell vs `&&`/`||`
- 定位是 parse + format（shfmt），不是结构遍历。ESLint 规则用它做格式化，不做 AST 查询

### 5. `bash-parser` / `mvdan-sh`（不推荐）

- `bash-parser`：0.5.0，**2017 年发布，8 年未更新**，21 个依赖（含老旧 babylon），无 TS 类型
- `mvdan-sh` npm：0.10.1，2022 年发布，4 年未更新，被 `sh-syntax` 取代

---

## 三、核心问题回答

### Q1：是否真的需要完整 AST？还是 shell-quote + 正则就够？

**判断：需要接近完整 AST 的能力，shell-quote + 正则不够。**

| 危险结构 | shell-quote | 正则补丁 | 完整 AST(tree-sitter) |
|---|---|---|---|
| 管道 `\|` | ✅(op token) | ✅ | ✅(`pipeline`) |
| 重定向 `>` `<` `>>` | ✅(op token) | ✅ | ✅(`file_redirect`) |
| `&&` `\|\|` `;` | ✅(op token) | ✅ | ✅(`list`) |
| `&`(后台) | ✅(op token) | ✅ | 部分 |
| 命令替换 `$(...)` | **❌**(字面) | 正则易误判（引号内、嵌套、转义） | ✅(`command_substitution`) |
| 反引号 `` `...` `` | **❌** | 正则易误判（引号内） | ✅ |
| 子 shell `(...)` | 部分 | 正则极易误判（引号、`$()`、算术） | ✅(`subshell`) |
| heredoc `<<EOF` | ❌ | 正则可行 | ✅(`heredoc_*`) |
| env 前缀 `FOO=bar cmd` | 部分 | 正则可行 | ✅(`variable_assignment`) |
| **引号内伪危险**（`echo "rm -rf \| > /"`） | 能正确分开引号 | **正则会误报** | 天然正确（引号是 `string` 节点） |
| **嵌套**（`echo $(cat <(grep x)) \| tee > f`） | 完全 flat | 正则无法处理嵌套 | 天然递归 |

**关键**：正则的致命伤是 (a) 引号/转义内的伪危险字符会误报，(b) 嵌套结构无法正确处理，(c) 每加一种危险结构都要加正则且互相干扰。tree-sitter 的白名单 kind 遍历（Codex 做法）最稳健，代码极简（~60 行核心逻辑）。

### Q2：tree-sitter Node 绑定 vs wasm，哪个更适合 Pi？

**选 wasm**。

| 维度 | 原生绑定 | wasm |
|---|---|---|
| 能力 | 相同 | 相同 |
| 跨平台分发 | 依赖 prebuilds | **天然跨平台** |
| 构建/安装 | **Node 24 编译失败**(实测) | **零编译** |
| 体积 | 19.8MB | 5.7MB |
| Pi `pi install` 友好度 | 低（用户可能缺工具链） | **高**（纯文件复制） |

**核心理由**：Pi 扩展通过 `pi install` 分发到用户机器，不能假设用户有 C++ 工具链。wasm 方案"拷贝即用"。

### Q3：是否可以"不用 AST，只用规则匹配 + AI 审查"？

**可以，但有安全等级权衡**：
- pi-permission-system 就是这个路线（wildcard 字符串匹配 + AI Classifier）
- 优点：实现简单，无 5.7MB 依赖
- 缺点：wildcard 匹配对 `rm -rf --no-preserve-root /`（flag 变体）、`$(rm -rf x)`（命令替换）不可靠
- **如果选这条路**：必须依赖 AI Classifier 兜底（所有非明确安全的命令都过 AI），但 AI 有判断失误风险，且每次调用都有成本

**推荐**：AST + 规则 + AI 三层，AST 做第一层快速筛除明显危险结构（命令替换/重定向/子 shell），规则做第二层（Codex 式只读白名单），AI 做第三层（剩余灰区判断）。这样 AI 只处理"看起来安全的命令"，减少 AI 调用次数和误判面。

---

## 四、Codex 参考实现（可直接移植）

Codex CLI 的 `codex-rs/shell-command/src/bash.rs` 的 `try_parse_word_only_commands_sequence` 是最佳参考，核心逻辑 ~60 行：

```rust
// 白名单 node kinds（只能出现这些，否则判 too-complex）
const ALLOWED_KINDS: &[&str] = &[
    "program", "list", "pipeline", "command", "command_name",
    "word", "string", "string_content", "raw_string", "number", "concatenation",
];
// 白名单标点（只能这些操作符）
const ALLOWED_PUNCT_TOKENS: &[&str] = &["&&", "||", ";", "|", "\"", "'"];
// 任何其他结构（子 shell/重定向/命令替换/控制流/env 赋值）→ 整个脚本判 "unsafe"
```

**TS 移植到 web-tree-sitter 约 60-80 行**。逻辑：
1. 解析命令为 AST
2. 遍历所有节点，检查 kind 是否在白名单
3. 遇到非白名单 kind → 返回 `{ safe: false, reason: "too-complex" }`
4. 全部白名单 → 提取 SimpleCommand[]，返回 `{ safe: true, commands: [...] }`

**Codex 只读白名单**（`is_safe_command.rs:67-173`，自动放行的命令）：
- 纯只读（24 个）：`cat cd cut echo expr false grep head id ls nl paste pwd rev seq stat tail tr true uname uniq wc which whoami`
- 带 flag 子检查：`base64`（禁 -o/--output）、`find`（禁 -exec/-delete/-fls 等）、`rg`（禁 --pre/--search-zip）、`git`（is_safe_git_command 子检查）、`sed`（只允许 `sed -n {N}p`）

---

## 五、Top 2 推荐

### 🥇 首选：`web-tree-sitter` + `tree-sitter-bash.wasm`

**取舍**：体积偏大（5.7MB）、API 略繁琐（异步 init + wasm 路径定位），换得**最强能力 + 零编译跨平台 + 与 Codex/Claude Code/OpenCode 同款技术栈**。

**实施要点**：
1. `Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"))` 定位 wasm
2. 打包时把 `.wasm` 标为 asset，不被 bundler 当 JS
3. 首次 `Parser.init()` 异步，启动时预热一次
4. 移植 Codex 的 `ALLOWED_KINDS` 白名单逻辑（~60-80 行 TS）

### 🥈 次选：`shell-quote`（仅作第一层 gate 或 MVP）

**取舍**：42KB、零依赖、Battle-tested（71M 周下载），换来的是能力盲区（命令替换/子 shell 识别不了）。

**适合场景**：
- 作为 tree-sitter 的前置快速 gate（扫到操作符立即标记，省 AST 解析）
- MVP 阶段先用，后续升级 tree-sitter

**不推荐单独用**：对 `echo $(rm -rf /)` 盲区是安全漏洞。

---

## Sources

npm registry (实测 API):
- [shell-quote](https://registry.npmjs.org/shell-quote) (v1.10.0, 2026-07-10)
- [bash-parser](https://registry.npmjs.org/bash-parser) (v0.5.0, 2017-06-22)
- [tree-sitter](https://registry.npmjs.org/tree-sitter) (v0.25.0, 2025-06-02)
- [tree-sitter-bash](https://registry.npmjs.org/tree-sitter-bash) (v0.25.1, 2025-12-02)
- [web-tree-sitter](https://registry.npmjs.org/web-tree-sitter) (v0.26.11, 2026-07-12)
- [sh-syntax](https://registry.npmjs.org/sh-syntax) (v0.6.0, 2026-07-08)

GitHub (实测 API):
- [tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) (322★)
- [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) (26441★)
- [ljharb/shell-quote](https://github.com/ljharb/shell-quote) (59★)
- [vorpaljs/bash-parser](https://github.com/vorpaljs/bash-parser) (230★, 最后 push 2024-06)
- [un-ts/sh-syntax](https://github.com/un-ts/sh-syntax) (60★, 2026-07 活跃)
- [mvdan/sh](https://github.com/mvdan/sh) (8925★, 上游活跃)
- [node-tree-sitter issue #268](https://github.com/tree-sitter/node-tree-sitter/issues/268) (Node 24 编译失败)
- [node-tree-sitter issue #286](https://github.com/tree-sitter/node-tree-sitter/issues/286) (npm RFC #868)

Codex 参考实现:
- `~/GitApp/ai-agent/codex-cli/codex-rs/shell-command/src/bash.rs`（ALLOWED_KINDS:36-50, ALLOWED_PUNCT_TOKENS:52）
- `~/GitApp/ai-agent/codex-cli/codex-rs/shell-command/src/command_safety/is_safe_command.rs:67-173`（只读白名单）
