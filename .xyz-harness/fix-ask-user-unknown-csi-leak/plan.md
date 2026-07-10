---
scope_ensemble_overlap: not_triggered   # 0 条判据命中，明确 lite
reuse_ensemble_overlap: not_triggered   # 2 改动点，未触发
test_ensemble_overlap: not_triggered    # 2 改动点，未触发
reconstruct_blind_spot: not_triggered   # 1 Wave，未触发
---

# ask-user 未知控制序列泄漏修复 实现计划

## 业务目标

修复 ask-user freeform/comment 编辑器 `handleEditorInput` 的 fallback 分支把未识别控制序列（OSC/DA/DCS/APC/unknown CSI）的可见残渣泄漏进 `editorText` 的 bug。

**根因**：`parseKey(data)` 返回 `undefined` 时，代码假设 `data` 是多字符粘贴，执行 `for (const c of cleaned) if (c >= " ") state.draftText += c`，把 ESC 开头的未识别控制序列里的可见字符（`[`、`]`、数字、字母）当成文本追加。pi-mono-fix 源码调研证实：`StdinBuffer` 只拼接/拆分序列不过滤内容，`TUI.handleInput` 仅消费**配对请求-响应**（OSC11/cell size，且需 pending 标志），未配对的自发序列（终端主动发的 OSC 11 主题响应、DA1/DA2 设备属性响应、tmux/SSH 注入的 OSC/CSI）直达 `focusedComponent.handleInput` → fallback 分支泄漏。

**成功标准**：
1. 在 freeform/comment 编辑器中，向 component 投递任意 ESC 开头的未识别控制序列（OSC-BEL / OSC-ST / DA1 / DA2 / DCS / APC / unknown CSI），`editorText` 保持不变（无可见残渣追加）。
2. 现有 C-PASTE-1~7（bracketed paste 完整保留）、C-ARROW-1/2（方向键不泄漏）、C-KEYMAP-*（modifier 不泄漏）回归测试全绿，行为零退化。
3. 纯文本/emoji/中文粘贴行为不变（仍正确追加）。

**约束**：
- 不改 D-005 决策（复用 SDK parseKey 不自建解析），本次是给 parseKey 盲区补一道独立硬防线，与 parseKey 正交。
- 不改 `handleInput` 路由语义、不改 QuestionState 数据模型、不改公共契约。
- **关键边界假设**：依赖 `StdinBuffer.extractCompleteSequences` 把 `a\x1b]11;r\x07b` 这类混合输入拆分成 `a` / `\x1b]11;r\x07`（完整 OSC）/ `b` 三个独立序列分三次 emit（源码 stdin-buffer.ts 证实）。因此 fallback 收到的 `data` 要么是纯控制序列（ESC 开头）、要么是纯文本/粘贴，不会出现"控制序列夹在文本中间"的单次调用。守卫只需判 `data` 整体是否 ESC 开头，无需扫描内部。

**不做**：
- 不重构 handleEditorInput 分层架构（控制序列硬过滤前置）——那是长期方案，本次最小修复。
- 不处理裸 `\x1b`（parseKey 返回 `"escape"` 命中前面分支，不进 fallback）。
- 不改 Pi 核心（tui/stdin-buffer）——那是只读调研对象。

## 技术改动点

- 修改 `extensions/ask-user/src/component.ts` — `handleEditorInput` 的 `keyId === undefined` fallback 分支入口新增 ESC 开头硬守卫：`data.startsWith("\x1b") && !data.includes("\x1b[200~") && !data.includes("\x1b[201~")` 为真时直接 `return`（整体丢弃，不提取可见残渣）。排除 bracketed paste 标记（`\x1b[200~`/`\x1b[201~`）以保证 C-PASTE-6/7 粘贴行为不退化。原 `cleaned = data.replace(...)` + printable 提取逻辑保留，只在该守卫之后执行。

测试基础设施改动（随 W1 一起改，非被测功能代码，不列入改动点）：`__tests__/fixtures.ts` 新增未知控制序列常量（OSC-BEL / OSC-ST / DA1 / DA2 / DCS / APC / unknown CSI 各 1，注释标注"模拟终端自发序列，parseKey 返回 undefined"）；`__tests__/component-keymap.test.ts` 新增 C-CSI-* 回归用例矩阵（见单测清单 U1-U16）。

复用检查：grep 确认 ask-user 内无现成 ESC 序列过滤工具（`startsWith.*\x1b` / `isEscape` / `stripCsi` 全 0 命中），不可复用，新建内联守卫。守卫逻辑仅 1 行条件判断，不抽象为工具函数（YAGNI，单处使用）。

## Wave 拆分与依赖

| Wave | 改动文件（功能代码） | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1   | extensions/ask-user/src/component.ts | [] | g1 | 单 Wave：守卫实现 + 测试同提交（TDD，测试先红后绿）。fixtures.ts/component-keymap.test.ts 是测试基础设施，随 W1 一起改但不列入 changes（非功能代码） |

## 单测用例清单（AC 级）

> 所有用例前置：`openFreeform([singleQ])` 打开 freeform 编辑器（导航到 Other + Enter），验证 editorLine（含 `█` 的行）。`editorText` 不可直接观测，通过渲染 editorLine 断言。

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | component.ts:handleEditorInput | 投递 `\x1b[99~`（unknown CSI），再投 `a`、`b` | editorLine 含 `ab`，不含 `[` / `9` / `~` | 边界 |
| U2 | component.ts:handleEditorInput | 投递 `\x1b]11;rgb:aa/bb/cc\x07`（OSC-BEL 终止），再投 `x` | editorLine 含 `x`，不含 `]` / `1` / `r` / `g` / `b` | 异常 |
| U3 | component.ts:handleEditorInput | 投递 `\x1b]11;rgb:aa/bb/cc\x1b\\`（OSC-ST 终止，ESC\\ 而非 BEL），再投 `y` | editorLine 含 `y`，不含 `]` / `r` / `g` / `b` | 异常 |
| U4 | component.ts:handleEditorInput | 投递 `\x1b[>0c`（DA2 响应），再投 `m` | editorLine 含 `m`，不含 `[` / `>` / `0` / `c` | 异常 |
| U5 | component.ts:handleEditorInput | 投递 `\x1b[?6c`（DA1 响应），再投 `n` | editorLine 含 `n`，不含 `[` / `?` / `6` | 异常 |
| U6 | component.ts:handleEditorInput | 投递 `\x1bP>|tmux 3.4\x1b\\`（DCS XTVersion 响应），再投 `d` | editorLine 含 `d`，不含 `P` / `>` / `t` / `m` / `u` / `x` | 异常 |
| U7 | component.ts:handleEditorInput | 投递 `\x1b_Gi=31\x1b\\`（APC Kitty graphics 响应），再投 `e` | editorLine 含 `e`，不含 `_` / `G` / `i` | 异常 |
| U8 | component.ts:handleEditorInput | 投 `\x1b[0~`（unknown func），再投 `\x1b[1;2;3~`（unknown func2），再投 `ab` | editorLine 含 `ab`，不含 `[` / `0` / `~` / `;` | 边界 |
| U9 | component.ts:handleEditorInput | 投 `\x1bOZ`（unknown SS3），再投 `f` | editorLine 含 `f`，不含 `O` / `Z` | 异常 |
| U10 | component.ts:handleEditorInput（回归：纯文本不退化） | 投 `hello` | editorLine 含 `hello` | 正常 |
| U11 | component.ts:handleEditorInput（回归：emoji 不退化） | 投 `fix the 🐛 bug` | editorLine 含 `fix the 🐛 bug`、含 `🐛` | 正常 |
| U12 | component.ts:handleEditorInput（回归：中文不退化） | 投 `你好` | editorLine 含 `你好` | 正常 |
| U13 | component.ts:handleEditorInput（回归：bracketed paste 不退化） | 投 `\x1b[200~hello\x1b[201~` | editorLine 含 `hello`，不含 `[200~` / `[201~` | 边界 |
| U14 | component.ts:handleEditorInput（回归：bracketed paste 跨 chunk 不退化） | 投 `\x1b[200~foo `，再投 ` bar\x1b[201~` | editorLine 含 `foo  bar`，不含 `[200~` / `[201~` | 边界 |
| U15 | component.ts:handleEditorInput（回归：方向键不退化） | 投 `RIGHT` 三次 + `a` | editorLine 含 `a`，不含 `[` / `C` | 边界 |
| U16 | component.ts:handleEditorInput | openComment（multiQWithComment Q1 选 A 进 comment），投 `\x1b[99~`，再投 `ab` | 文本行含 `ab`，全文本不含 `[9` | 异常 |

## E2E 用例清单

> ask-user 是 TUI 组件，无浏览器/CDP E2E 栈。项目测试栈探测：vitest（`pnpm --filter @zhushanwen/pi-ask-user test`），无 playwright/cypress 配置，无 TEST-STRATEGY.md。E2E 语义在本 extension = 组件集成测试（真实 AskUserComponent 实例 + 真实 handleInput 路由 + 真实 parseKey SDK 调用，仅 TUI 渲染层用 stubTheme/mockTui 隔离），用 vitest 跑。judgeByExpected 重算基准 = 渲染输出的 editorLine 文本断言。

| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|--------|------|------|------|---------|
| E1 | OSC11 响应（未配对）投递到活跃编辑器不泄漏 | mock | openFreeform([singleQ]) | handleInput(`\x1b]11;rgb:1/2/3\x07`); handleInput(`a`); render(60) | editorLine 含 `a`，不含 `]`/`r`/`g`/`b`/`1` | `pnpm --filter @zhushanwen/pi-ask-user test` (vitest, requiresScreenshot=false) |
| E2 | DA2 + unknown CSI 连续投递不泄漏 | mock | openFreeform([singleQ]) | handleInput(`\x1b[>0c`); handleInput(`\x1b[99~`); handleInput(`ok`); render(60) | editorLine 含 `ok`，不含 `[`/`>`/`0`/`c`/`9`/`~` | 同上 |
| E3-r | 真实 Pi session 注入未配对 OSC11 响应，编辑器无乱码渗入 | real | [需集成环境] 真实终端 + ask_user 工具触发 freeform 编辑器（Other→Enter） | ask_user 活跃时，外部向终端注入 OSC11 响应字节流（模拟 tmux 主题同步 `\x1b]11;rgb:..\x07`），然后键入文本 | editorText 仅含键入文本，无 `]`/`rgb`/数字残渣 | [需集成环境] 手动：启动 pi → 触发 ask_user freeform → 用 `printf '\x1b]11;rgb:1/2/3\x07'` 向 tty 注入 → 键入字符 → 目视编辑器无乱码。无自动化 real 栈（TUI 组件库无浏览器/CDP E2E），降级手动验证 |

## 覆盖率 gate

- gate 命令：`pnpm --filter @zhushanwen/pi-ask-user test`（vitest，项目无单独 coverage 脚本；ask-user package.json 仅 `test: vitest run`）
- 增量算法：本次改动集中在 component.ts handleEditorInput 单分支，由 U1-U16（16 条）+ E1/E2 覆盖该分支的 drop / append 两条路径。项目历史无 coverage 阈值配置（无 .nycrc/vitest coverage config），按 lite 默认 ≥60% 增量分支覆盖——16 条用例对单分支的 drop(true)/drop(false→append) 两态 + 各类序列形态的覆盖远超该阈值。
- 阈值：增量分支覆盖率 ≥ 60%

## 实现步骤

1. [W1] TDD 红：先在 `fixtures.ts` 新增 OSC-BEL/OSC-ST/DA1/DA2/DCS/APC/UNKNOWN-CSI 常量；在 `component-keymap.test.ts` 新增 U1-U16 + C-CSI-* 用例（复制现有 C-ARROW-1 结构改输入/断言）。运行 `pnpm --filter @zhushanwen/pi-ask-user test` 确认 U1-U9/U16 红（当前泄漏可见残渣），U10-U15 绿（回归保护）。
2. [W1] TDD 绿：在 `component.ts` handleEditorInput 的 `keyId === undefined` 分支，`const cleaned = ...` **之前**插入守卫：`if (data.startsWith("\x1b") && !data.includes("\x1b[200~") && !data.includes("\x1b[201~")) return;`（注释说明：未识别控制序列整体丢弃，依赖 StdinBuffer 序列拆分保证 data 整体性，排除 bracketed paste 标记防 C-PASTE 退化）。运行全量测试确认 U1-U16 + 既有 254 用例全绿。
3. [W1] typecheck：`pnpm --filter @zhushanwen/pi-ask-user typecheck` 零错误；`pnpm -r lint`（若 ask-user 触发）零错误。
4. [W1] 提交：`git add -A && git commit -m "fix(ask-user): drop unrecognized escape sequences in editor fallback"`（英文 commit，pre-commit hook 自动跑 tsc/eslint/vitest）。
