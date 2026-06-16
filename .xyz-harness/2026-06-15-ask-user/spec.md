---
verdict: pass
---

# ask-user extension

## Background

Pi coding agent 缺少一个"既支持单问题深度交互、又支持多问题批量澄清"的结构化问答工具。当前已安装的 `pi-ask-user`(edlsh, v0.11.1) 功能最全但实现臃肿（1795 行单体 index.ts、大量 `as any`、overlay/inline 双模式增加复杂度）；`pi-askuserquestion`(ghoseb) 多问题 Tab 体验好但功能精简（无分屏预览、无评论）。

本扩展**替换 pi-ask-user**，以 pi-askuserquestion 的分层架构为基础，融合两者优点：自适应单/多问、纯 inline 渲染、分屏 Markdown 预览、内联编辑器、可选评论。工具名沿用 `ask_user` 保证项目内 4 个已硬编码引用该名的 skill 零修改兼容。

### 包信息

- **npm 包名**：`@zhushanwen/pi-ask-user`
- **工具名**：`ask_user`
- **目录**：`extensions/ask-user/`
- **许可**：MIT

## Functional Requirements

### FR-1: 工具注册

注册 `ask_user` tool，含 `name`/`label`/`description`/`promptSnippet`/`promptGuidelines`/`parameters`/`execute`/`renderCall`/`renderResult`。

- `promptSnippet`：一句话提示模型在歧义/决策点使用
- `promptGuidelines`：使用禁忌（何时该问、何时不该问、一次问几个）

### FR-2: 参数 schema（questions 数组）

```typescript
{
  questions: Array<{
    question: string;        // 完整问题文本
    header?: string;         // Tab 标签，≤12 字符（schema Optional；多问题时运行时必填，缺失→isError）
    context?: string;        // 问题前的上下文摘要
    options: Array<{         // 2-4 个选项（schema 强制 minItems:2, maxItems:4）
      label: string;         // 选项标签（同时也是返回给 LLM 的值）
      description?: string;  // 选项说明，显示在 label 下方 + 分屏预览中
    }>;
    multiSelect?: boolean;   // 默认 false。true=多选 checkbox
    allowComment?: boolean;  // 默认 false。true=选中后追加自由文本评论
  }>;                        // 1-4 个问题（schema 强制 minItems:1, maxItems:4）
}
```

**约束**：
- 每个问题始终自动附加一个 "Other"（自由输入）选项，不在 options 数组中声明
- `header`：schema 层 Optional（typebox 无法表达条件必填）；多问题（questions.length > 1）时运行时校验必填，缺失返回 isError
- 校验（返回 **isError:true**，LLM 可重试修正）：
  - question 文本在数组内唯一
  - 同问题内 option label 唯一
  - 多问题时每个 question 必须有非空 header

### FR-3: 自适应渲染（纯 inline）

通过 `ctx.ui.custom()` 渲染，**不使用 overlay**（不传 `options.overlay`）。

**单问题（questions.length === 1）**：
- 不渲染 Tab bar
- 直接渲染问题视图
- 答完即提交（无 Submit tab）。`allowComment: true` 时选中后先进入评论输入行，评论 Enter 后才提交

**多问题（questions.length > 1）**：
- 顶部渲染 Tab bar：每个问题一个 tab（`header` 标签）+ 末尾 `✓ Submit` tab
- 激活 tab 高亮（`bg("selectedBg")`）；已确认 tab 显示 `■`；未答 `□`
- `←/→` 切 tab；Submit tab 汇总所有答案，全答完后 Enter 提交

### FR-4: 问题视图（单问题渲染单元）

每个问题的渲染包含：

1. **问题文本**：word-wrap 到内容宽度，`theme.fg("text")`
2. **上下文**（如有）：`theme.fg("muted")`，Markdown 渲染（`safeMarkdownTheme()` 降级纯文本）
3. **选项列表**：
   - 单选：`> 1. label` 光标高亮（`theme.fg("accent")`），`Enter` 确认
   - 多选：`[✓]/[ ]` checkbox，`Space` toggle，`Enter` 确认
   - 选项 description：缩进显示在 label 下方，`theme.fg("muted")`
   - "Other" 行始终为最后一项：`Space/Tab` 打开内联编辑器
4. **分屏预览**（宽终端 ≥84 列时）：左选项列表 + 右 Markdown 详情预览（当前聚焦选项的完整 description）。窄终端降级单列（description 缩进显示在选项下）
5. **内联编辑器**（Other 模式激活时）：选项列表下方就地展开 `Editor`，不切模式。`Enter` 保存、`Esc` 返回
6. **可选评论**（question 级 `allowComment: true` 且已选中选项时）：选中选项后**不立即提交**，显示评论输入行（可 `Enter` 跳过，输入文本后 `Enter` 附上评论）。此"选中后停顿"流程统一单问题与多问题场景，解决单问题"答完即提交无机会输评论"的路径断裂。评论作为答案的补充返回给 LLM。
   - **组件**：复用 Other 自由文本的同一 `Editor` 实例（组件持有单个 Editor，按当前模式——Other/评论——切换文本）。避免双 Editor 的焦点与状态混乱
   - **触发时机**：单选 `Enter` 确认后、多选 `Enter` 确认后（非 toggle 即时）→ 进入评论输入行。多选需显式 `Enter` 确认选择后才进入评论，避免每 toggle 一次就弹评论行
   - **评论输入行渲染**：选项列表下方显示 `Your comment (optional):` + Editor 就地展开（同 Other 编辑器的布局）
   - **编辑/清除已输入评论**：切回该问题的 tab，若已有 commentValue，光标默认停在评论行，`Enter`（空）清除 commentValue（同 Other 空 Enter 清除 freeTextValue 的语义），输入新文本 `Enter` 覆盖
7. **底部帮助行**：上下文相关的键提示（`theme.fg("dim")`）

### FR-5: Submit 视图（多问题专用）

Submit tab 渲染：
- 标题：全答完 `Ready to submit`（success）/ 未答完 `Unanswered`（warning）
- 列出每个问题的 `header: answer`，未答显示 `—`
- 全答完：`Press Enter to submit`；未答完：`Still needed: <未答 headers>`
- `Esc` 取消整个问答

### FR-6: 输入处理

| 键 | 上下文 | 行为 |
|----|--------|------|
| `↑/↓` | 选项列表 | 移动光标（不记录答案） |
| `Enter` | 单选选项 | 确认选择。allowComment=true 时进入评论输入行；否则（单问题）submit 或（多问题）advance |
| `Space` | 多选选项 | toggle checkbox |
| `Enter` | 多选（已有选择） | 确认选择；同时把光标所在普通选项加入选中（与单选 Enter = 选中光标项对称）。allowComment=true 时进入评论输入行；否则 advance |
| `Space/Tab` | Other 行 | 打开内联编辑器（自由文本模式） |
| `Enter` | 自由文本编辑器（有文本） | 保存 freeTextValue，关闭编辑器。allowComment=true 时进入评论输入行 |
| `Enter` | 自由文本编辑器（空） | 清除已存 freeTextValue，关闭编辑器 |
| `Enter` | 评论输入行（有文本） | 保存 commentValue，前进（单问题 submit / 多问题 advance） |
| `Enter` | 评论输入行（空） | 跳过评论（commentValue 保持 null/原值），前进 |
| `Esc` | 评论输入行 | 跳过评论，前进（不丢弃已存 commentValue——Esc 在此=跳过而非清除；清除用 Enter 空） |
| `Esc` | 自由文本编辑器 | 丢弃输入并返回选项列表 |
| `←/→` | 多问题 Tab bar | 切 tab（离开 tab 时若有答案则 auto-confirm；auto-confirm 跳过评论输入行，仅 Enter 确认路径才进评论。允许的权衡：←/→ 是导航意图，弹编辑器会打断流） |
| `Enter` | Submit tab（全答完） | 提交所有答案 |
| `Esc` | 选项列表 / Submit tab | 取消整个问答 |

**光标 ≠ 选择**：移动光标不记录答案，必须显式 `Enter`（单选）或 `Space`（多选）。

### FR-7: 结果返回

```typescript
// execute 返回值
{
  content: [{ type: "text", text: "<每问题答案摘要，每行 header: answer>" }],
  details: {
    questions: [...],           // 回传 schema（含 header/description，供 renderResult）
    answers: {                  // question 文本 → 答案字符串
      [question]: "label",           // 单选
      [question]: "A, B",            // 多选：常规选项按 index 序 join
      [question]: "A, 自定义文本",    // 多选 + Other：常规项按 index 序，Other 自由文本追加末尾
      [question]: "自由文本",         // 仅 Other 输入
      [question]: "label — 评论",     // 带评论时（allowComment），评论以 " — " 分隔追加
    },
    cancelled: boolean,         // Esc 取消
  }
}
```

- 取消（Esc）：`answers: {}`, `cancelled: true`, content = "User cancelled"
- `details` 是 `renderResult` 唯一数据源
- multiSelect + Other 组装顺序：先按 selectedIndices 数字序排常规选项，再把 Other 自由文本追加末尾

### FR-8: Headless 处理

- `ctx.hasUI === false`：返回 `{ isError: true, content: "ask_user requires interactive session" }` + `pi.setActiveTools(pi.getAllTools().map(t => t.name).filter(n => n !== "ask_user"))` 禁用工具防 LLM 重试
- **不做** dialog 降级（`ctx.ui.select/input`），不做 RPC 适配

### FR-9: 自定义渲染

- `renderCall(args, theme)`：显示 `ask_user <headers>` + 问题数 + 选项数摘要。返回 `TruncatedText`（防长 header 溢出）
- `renderResult(result, options, theme)`：
  - 取消：`Cancelled`（warning）
  - 正常：用 `Box` + 多个 `TruncatedText`，每问题一行 `✓ <header>: <answer>`（success + accent + text）
  - `options.expanded`：展开显示所有选项 + `●/○` 选中标记 + 评论

### FR-10: Signal abort 处理

- execute 入口检查 `signal?.aborted`，已 abort 直接返回 cancelled
- custom factory 内 `signal?.addEventListener("abort", () => done(null), { once: true })`
- agent 被 abort（goal 取消/compact/session 切换）时 TUI 立即关闭，不挂死

### FR-11: Comment 状态存储

- QuestionState 新增字段 `commentValue: string | null`（null=未输入/已清除）
- commentValue 随 confirm 持久；切 tab 再回来保留
- buildResult() 时若 commentValue 非空，以 ` — <comment>` 分隔追加到该问题 answer 末尾

### FR-12: 防重入守卫

- 组件 `_resolved: boolean` 标志，初始 false
- submit() / cancel() 调 done() 前置 `_resolved = true`
- handleInput(data) 入口 `if (this._resolved) return`——防止 signal abort 触发 done 后用户按键再次触发 done（竞态）

### FR-13: execute 顶层错误兜底

- execute 内 `try { ... ctx.ui.custom(...) ... } catch (err) { return { isError: true, content: "ask_user failed: <msg>" } }`
- custom factory 内异常（Editor 构造、theme 读取等）不带崩 Pi

### FR-14: 答案回改（多问题）

- 已确认 tab（`■` 标记）可被用户重新进入并修改答案
- 重新选择/toggle 后 confirmed 标志保持 true（仍算已答），但 Tab bar 视觉标记更新为新选择
- Submit tab 的 allConfirmed 检查基于 confirmed 标志，回改不影响提交门

## Acceptance Criteria

- **AC-1**：`pi install npm:@zhushanwen/pi-ask-user` 后扩展自动加载，LLM 可调用 `ask_user`
- **AC-2**：单问题调用渲染无 Tab bar，答完即返回
- **AC-3**：多问题（2-4）调用渲染 Tab bar + Submit tab，全答完才能提交
- **AC-4**：宽终端（≥84 列）单选显示左右分屏（选项 + Markdown 预览）；窄终端单列
- **AC-5**：Other 选项的内联编辑器就地展开，Enter 保存/Esc 返回
- **AC-6**：`allowComment: true` 的问题选中后可输入评论，评论出现在返回结果
- **AC-7**：无 UI 会话返回 isError + 禁用工具，LLM 不重试
- **AC-8**：参数校验（重复 question/label）返回 isError
- **AC-9**：单测覆盖以下场景并通过；`tsc --noEmit` + ESLint（无 any）通过：
  - 单问题单选/多选确认 + 结果结构
  - 多问题 Tab 导航 + Submit 提交
  - Other 自由文本输入/清除
  - allowComment 评论输入/跳过/清除
  - 无 UI 返回 isError
  - 参数校验（重复 question/label、多问缺 header）返回 isError
  - signal abort 返回 cancelled
  - render(width) 缓存 + invalidate
- **AC-10**：单文件 ≤500 行，单函数 ≤80 行
- **AC-11**：spec-clarify/coding-workflow-brainstorming/plan 等 skill 调用 `ask_user` 零修改可用
- **AC-12**：`allowComment: true` 的单问题，选中选项后显示评论输入行，Enter 可跳过或输入评论
- **AC-13**：重复 question/label 或多问题缺 header 返回 `isError: true`，LLM 可修正重试
- **AC-14**：agent abort（signal）时 TUI 立即关闭返回 cancelled，不挂死
- **AC-15**：execute 内任何异常被捕获返回 isError，不带崩 Pi
- **AC-16**：多问题已确认 tab 可回改答案，Tab bar 标记更新
- **AC-17**：`allowComment: true` 时选中选项后进入评论输入行；Enter（空）跳过、Enter（有文本）附上评论、Esc 跳过；复用 Other 的 Editor 实例
- **AC-18**：多选+allowComment 时需 Enter 确认选择后才进入评论行（非 toggle 即时触发）

## Constraints

- **技术栈**：TypeScript (ESM)，Pi Extension API（`@mariozechner/pi-coding-agent` peerDep），typebox schema，pi-tui 组件（`@earendil-works/pi-tui` optional peerDep）
- **质量门控**：`tsc --noEmit` 通过；ESLint 无 `any`；单文件 ≤1000 行（P0）/ ≤500 行（P2 指南）；vitest 通过
- **包规范**：`@zhushanwen/pi-ask-user`，`type: module`，`pi.extensions: ["./index.ts"]`，`keywords` 含 `pi-package`，`files` 含 `index.ts` + `src/**/*.ts`
- **入口**：顶层 `index.ts` re-export `src/index.ts`
- **状态**：工厂闭包内，无模块级 let（每次 `ctx.ui.custom` 创建新组件实例，天然隔离）
- **颜色**：`theme.fg(token, text)` 语义 token，不硬编码 ANSI
- **Markdown 安全降级**：`safeMarkdownTheme()` 包裹，异常降级纯文本
- **路径**：无硬编码路径（本扩展无 fs 操作）
- **渲染缓存**：组件 `render(width)` 缓存 + `invalidate()`
- **并发**：Pi 运行时串行化 tool execute（function calling 协议）+ custom UI 单组件显示，并发 ask_user 自然排队，无需额外处理

## Decisions made

| 决策 | 选择 | 推理 |
|------|------|------|
| 替换 vs 并存 pi-ask-user | 替换 | 用户指定，避免工具重复 |
| 工具名 | `ask_user` | 4 个 skill 硬编码引用，零修改兼容 |
| 渲染模式 | 纯 inline | 用户指定，简化实现（去掉 overlay/隐藏键/onTerminalInput） |
| 选项数 | 2-4 严格 | LLM 易构造；据此去掉搜索过滤 |
| 不内嵌 skill | YAGNI | 靠 description + promptSnippet |
| 不发事件 | YAGNI | 代码验证无监听者 |
| 分层架构 | 5 文件 | 每文件 <300 行，可独立单测 |
| Headless 最简 | 无视用户需求 | 无 UI → isError + 禁用工具 |
| Comment 触发 | 选中后停顿输评论 | 统一单/多问题流程，解决单问题路径断裂（G-013） |
| 校验失败返回 | isError:true | LLM 可修正重试（G-008） |
| 答案回改 | 允许回改 | confirmed 标记更新，容错好（G-012） |
| header 必填性 | schema Optional + 运行时校验 | typebox 无法表达条件必填（G-009） |
| signal abort | 必须处理 | Pi 规范 4.2/14.2 强制，防挂死（G-001） |
| Timeout | **移除（YAGNI）** | 超时需用户显式开启，默认不开启；当前无此需求，移除 timeout 参数。goal 卡死由 goal 自身的 stall 检测处理，非 ask_user 职责 |

## 业务用例

> 纯技术性工具扩展，无直接业务用例。以下为典型使用场景。

### UC-1: spec-clarify 逐个澄清需求
- **Actor**: spec-clarify skill（主 agent）
- **场景**: 需求澄清阶段，发现 K/D 类 gap 需问用户
- **预期结果**: 调用 `ask_user`（单问题），用户在 inline TUI 选择/输入，答案返回给 LLM 继续

### UC-2: 批量澄清多个独立决策
- **Actor**: LLM
- **场景**: 启动新功能前需确认 3 个独立偏好（框架/样式/测试策略）
- **预期结果**: 调用 `ask_user`（questions 数组 3 项），用户 Tab 逐个回答，Submit tab 汇总提交
