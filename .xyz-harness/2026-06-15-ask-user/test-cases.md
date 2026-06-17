# @zhushanwen/pi-ask-user 测试用例文档

> 目标：系统化覆盖 spec 的 14 个 FR、18 个 AC。按测试层（validate / types / question-view / submit-view / component / index.execute）分层组织，每条用例标注对应的 FR/AC，并标记现有覆盖状态（✅ 已有 / ➕ 待补）。

## 测试键码约定（所有 component/execute 测试复用）

```typescript
const ENTER  = "\r";      // Key.enter
const SPACE  = " ";       // Key.space
const ESC    = "\x1b";    // Key.escape
const UP     = "\x1b[A";  // Key.up
const DOWN   = "\x1b[B";  // Key.down
const RIGHT  = "\x1b[C";  // Key.right
const LEFT   = "\x1b[D";  // Key.left
const TAB    = "\t";      // Key.tab
const BKSP   = "\x7f";    // Key.backspace (多数终端)
```

## 通用 fixture（建议抽到 `__tests__/fixtures.ts`）

```typescript
const stubTheme: ThemeLike = {
  fg: (_t: string, s: string) => s,
  bg: (_t: string, s: string) => s,
  bold: (s: string) => s,
};
const mockTui = { requestRender: (): void => {} };

const singleQ: Question = {
  question: "Which DB?",
  options: [
    { label: "Postgres", description: "Battle-tested" },
    { label: "SQLite", description: "Embedded" },
  ],
};
const singleQWithComment: Question = {
  ...singleQ,
  question: "Which DB? (with comment)",
  allowComment: true,
};
const multiQ: Question[] = [
  { question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
  { question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }], multiSelect: true },
  { question: "Q3", header: "Third", options: [{ label: "M" }, { label: "N" }] },
];
```

---

## 层 1: validate.ts 输入校验（FR-2 / AC-8 / AC-13）

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| V-1 | 合法单问题 | `[q()]` | null | ✅ |
| V-2 | 合法多问题（有 header） | 2 个不同 question + 不同 header | null | ✅ |
| V-3 | 单问题无 header | header 缺失 | null（header 仅多问题必填） | ✅ |
| V-4 | 重复 question 文本 | 两个相同 question | 含 "Duplicate question" | ✅ |
| V-5 | 同问题重复 option label | `[{label:"A"},{label:"A"}]` | 含 "Duplicate option label" | ✅ |
| V-6 | 多问题缺 header | 第 2 个无 header | 含 "requires a non-empty header" | ✅ |
| V-7 | 单问题空白 header | `header: "  "` | null（单问题 header 不校验） | ✅ |
| V-8 | 多问题空字符串 header | `header: "  "` | 含 "header" | ✅ |
| V-9 ➕ | 4 个问题上限 | 4 个合法问题 | null | ➕ |
| V-10 ➕ | 边界：正好重复的 header（不同 question） | 两问题 header 同、question 不同 | null（header 可重） | ➕ |
| V-11 ➕ | option description 不参与唯一性 | 两 option label 不同但 description 同 | null | ➕ |

---

## 层 2: types.ts 类型与工厂（FR-2 / AC-9）

| # | 用例 | 断言 | 状态 |
|---|------|------|------|
| T-1 | InputSchema 定义 questions 属性 | properties.questions 存在 | ✅ |
| T-2 | OTHER_LABEL 常量 | `"Other"` | ✅ |
| T-3 | SPLIT_PANE_MIN_WIDTH | `84` | ✅ |
| T-4 | createQuestionState 初始值 | cursorIndex=0, selectedIndex=null, confirmed=false, mode="options" | ✅ |
| T-5 ➕ | createQuestionState 每次返回独立 Set | 两次调用，`s1.selectedIndices !== s2.selectedIndices` | ➕ |
| T-6 ➕ | QuestionSchema options minItems/maxItems | minItems=2, maxItems=4 | ➕ |
| T-7 ➕ | InputSchema questions minItems/maxItems | minItems=1, maxItems=4 | ➕ |

---

## 层 3: question-view.ts 渲染（FR-4 / AC-4 / AC-12）

### 3a. 基础渲染

| # | 用例 | 输入/操作 | 期望 | 状态 |
|---|------|-----------|------|------|
| Q-1 | 渲染问题文本 | width=60 | 含问题字符串 | ✅ |
| Q-2 | 渲染所有选项 + Other | 默认 state | 含所有 label + "Other" | ✅ |
| Q-3 | 光标 `>` 在首项 | cursorIndex=0 | 首行含 `>` | ✅ |
| Q-4 | 单选已选显示 `✓` | selectedIndex=1 | SQLite 行含 `✓` | ✅ |
| Q-5 | 多选 checkbox | selectedIndices={0} | `[✓]` + `[ ]` 各一 | ✅ |
| Q-6 | description muted 显示 | 默认 | 含 "Battle-tested" | ✅ |

### 3b. 分屏（AC-4）

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| Q-7 | getSplitPaneWidths 窄终端 | width=60 | null | ✅ |
| Q-8 | getSplitPaneWidths 宽终端 | width=100 | `{left>0, right>0}` | ✅ |
| Q-9 ➕ | 分屏左列隐藏 description | width=100 | 左列无 description 文本 | ➕ |
| Q-10 ➕ | 分屏右列显示聚焦项 detail | cursorIndex=0, width=100 | 右列含 "Postgres" + "Battle-tested" | ➕ |
| Q-11 ➕ | 分屏右列聚焦 Other 时 | cursorIndex=末项 | 右列含 "enter a custom answer" | ➕ |
| Q-12 ➕ | 分屏边界 width=83 | width=83 | null（< 84） | ➕ |
| Q-13 ➕ | 分屏边界 width=84 | width=84 | 非 null | ➕ |
| Q-14 ➕ | 单列模式显示缩进 description | width=60 | description 缩进显示 | ➕ |

### 3c. Other 编辑器模式（FR-4.5 / AC-5）

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| Q-15 ➕ | freeform 模式渲染编辑器 | mode="freeform", editorText="draft" | 含 "Your answer:" + "draft" + `█` | ➕ |
| Q-16 ➕ | Other 已输入文本回显 | mode="options", freeTextValue="custom" | Other 行含 `✓` + 引号预览 | ➕ |
| Q-17 ➕ | Other 行帮助提示 | cursorIndex=末项 | 含 "Space/Tab open editor" | ➕ |

### 3d. 评论模式（FR-4.6 / FR-11 / AC-6 / AC-12 / AC-17）

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| Q-18 | comment 模式渲染 | mode="comment", editorText="note" | 含 "comment" + "note" | ✅ |
| Q-19 ➕ | 评论提示为 optional | mode="comment" | 含 "(optional)" | ➕ |

### 3e. 帮助行（FR-4.7）

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| Q-20 ➕ | 单选帮助行 | 默认 | 含 "Enter select" | ➕ |
| Q-21 ➕ | 多选帮助行 | multiSelect=true | 含 "Space toggle · Enter confirm" | ➕ |
| Q-22 ➕ | 单问题无 tab 切换提示 | isSingle=true | 不含 "switch tabs" | ➕ |
| Q-23 ➕ | 多问题有 tab 切换提示 | isSingle=false | 含 "switch tabs" | ➕ |

### 3f. 上下文（FR-4.2）

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| Q-24 ➕ | 有 context 时渲染 | q.context="背景说明" | 含 "背景说明" | ➕ |
| Q-25 ➕ | 无 context 时不渲染空行冗余 | context 缺失 | 不含 context 文本 | ➕ |

### 3g. 边界

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| Q-26 ➕ | 极窄终端 width=20 | width=20 | 不崩，内容被截断 | ➕ |
| Q-27 ➕ | 选项 label 超长 | label="A".repeat(50) | 被 truncateToWidth 截断 | ➕ |

---

## 层 4: submit-view.ts（FR-5 / AC-3）

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| S-1 | 全答完显示 Ready | states 全 confirmed | 含 "Ready to submit" + "Press Enter" | ✅ |
| S-2 | 未答完显示 Unanswered | 有未答 | 含 "Unanswered" | ✅ |
| S-3 | 列出 header: answer | selectedIndex=0 | 含 "Database" + "Postgres" | ✅ |
| S-4 | 未答显示 — | confirmed=false | 含 "—" | ✅ |
| S-5 ➕ | getAnswerText 单选 | selectedIndex=0 | "Postgres" | ➕ |
| S-6 ➕ | getAnswerText 多选 | selectedIndices={0,1} | "Postgres, SQLite"（index 序） | ➕ |
| S-7 ➕ | getAnswerText 多选乱序 toggle | selectedIndices={1,0} | 仍 "Postgres, SQLite"（按 index 排序） | ➕ |
| S-8 ➕ | getAnswerText + Other | freeTextValue="custom" | 含 "custom" | ➕ |
| S-9 ➕ | getAnswerText + 评论 | commentValue="note" | 含 " — note" | ➕ |
| S-10 ➕ | getAnswerText 未答 | confirmed=false | null | ➕ |
| S-11 ➕ | buildResult 正常 | states 全答 | answers 含各 question→answer | ➕ |
| S-12 ➕ | buildResult 部分未答 | 有未答 question | 该 question 不在 answers 中 | ➕ |
| S-13 ➕ | Submit 帮助行 | 任意 | 含 "switch tabs" + "Esc cancel" | ➕ |

---

## 层 5: component.ts 状态机（FR-3 / FR-6 / FR-11 / FR-12 / FR-14 / AC-2/3/5/6/12/14/16/17/18）

### 5a. 单问题（AC-2）

| # | 用例 | 操作序列 | 期望 | 状态 |
|---|------|----------|------|------|
| C-1 | 无 Tab bar | render | 不含 "Submit" | ✅ |
| C-2 | Enter 选首项即提交 | ENTER | resolved, answers["Which DB?"]="Postgres" | ✅ |
| C-3 | ↓ + Enter 选第二项 | DOWN, ENTER | answers="SQLite" | ✅ |
| C-4 | Esc 取消 | ESC | resolved=null | ✅ |
| C-5 ➕ | ↑ 在首项不越界 | UP | cursorIndex 仍 0 | ➕ |
| C-6 ➕ | ↓ 越过 Other 后不越界 | DOWN ×3（2 选项+Other=3 行） | cursorIndex=2 | ➕ |

### 5b. 多问题 Tab 导航（AC-3 / AC-16）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| C-7 | 渲染 Tab bar | render | 含各 header + "Submit" | ✅ |
| C-8 | 完整答题→提交 | 见代码 | answers 全填 | ✅ |
| C-9 | Submit 未全答 Enter 阻塞 | RIGHT×2, ENTER | 未 resolved | ✅ |
| C-10 ➕ | RIGHT 循环（Submit→Q1） | 在 Submit tab 按 RIGHT | activeTab=0 | ➕ |
| C-11 ➕ | LEFT 循环（Q1→Submit） | 在 Q1 按 LEFT | activeTab=末尾 Submit | ➕ |
| C-12 ➕ | 已答 tab 显示 ■ | 答完 Q1 | Tab bar Q1 行含 ■ | ➕ |
| C-13 ➕ | 未答 tab 显示 □ | 未答 Q1 | Tab bar Q1 行含 □ | ➕ |
| C-14 ➕ | Submit tab 高亮 bg | activeTab=Submit | Submit 行含 selectedBg | ➕ |
| C-15 ➕ | 离开多选 tab 自动确认 | Q2 toggle 后 RIGHT | states[1].confirmed=true | ➕ |
| C-16 ➕ | **AC-16 回改**：已确认 tab 重选 | 答完 Q1→LEFT 回 Q1→选 B→回 Submit | answers["Q1"]="B" | ➕ |

### 5c. 单选选择（FR-6）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| C-17 ➕ | 光标移动不记录答案 | DOWN | selectedIndex 仍 null | ➕ |
| C-18 ➕ | Enter 后 selectedIndex 更新 | ENTER | selectedIndex=cursorIndex | ➕ |
| C-19 ➕ | 重选清除 freeText | 先 Other 输文本→回选常规项 Enter | freeTextValue=null | ➕ |

### 5d. 多选 toggle（FR-6 / AC-18）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| C-20 ➕ | Space toggle 加入 | SPACE | selectedIndices 含 cursorIndex | ➕ |
| C-21 ➕ | Space toggle 移除 | SPACE 两次 | selectedIndices 不含 | ➕ |
| C-22 ➕ | 多选无选择 Enter 不确认 | 多选 tab 不 toggle 直接 ENTER | 不 confirmed | ➕ |
| C-23 ➕ | 多选 toggle 后 Enter 确认 | SPACE, ENTER | confirmed=true | ➕ |
| C-24 ➕ | **AC-18**：多选 toggle 不触发评论 | multiSelect+allowComment, SPACE | 不进入 comment 模式 | ➕ |

### 5e. Other 自由文本（FR-4.5 / AC-5）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| C-25 ➕ | Space 在 Other 行打开编辑器 | 光标在 Other, SPACE | mode="freeform" | ➕ |
| C-26 ➕ | Tab 在 Other 行打开编辑器 | 光标在 Other, TAB | mode="freeform" | ➕ |
| C-27 ➕ | 编辑器输入字符 | "a","b" | editorText="ab" | ➕ |
| C-28 ➕ | 编辑器 Backspace | BKSP | editorText 末字符删 | ➕ |
| C-29 ➕ | 编辑器 Enter 有文本保存 | 输入 "custom", ENTER | freeTextValue="custom", mode 回 options | ➕ |
| C-30 ➕ | 编辑器 Enter 空清除 | 不输入, ENTER | freeTextValue=null | ➕ |
| C-31 ➕ | 编辑器 Esc 返回 | ESC | mode 回 options, editorText 清空 | ➕ |
| C-32 ➕ | Other 已存文本回编辑器续编 | freeTextValue="x"→打开 | editorText="x"（预填） | ➕ |

### 5f. 评论流程（FR-4.6 / FR-11 / AC-6 / AC-12 / AC-17）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| C-33 ➕ | 单选 + allowComment Enter 进评论 | allowComment, ENTER | mode="comment" | ➕ |
| C-34 ➕ | **AC-12**：评论 Enter 空跳过 | 进评论→ENTER | commentValue=null, 前进/提交 | ➕ |
| C-35 ➕ | 评论 Enter 有文本保存 | 输 "note", ENTER | commentValue="note" | ➕ |
| C-36 ➕ | **AC-17**：评论 Esc 跳过（不清除） | 已有 commentValue→进评论→ESC | commentValue 保持原值 | ➕ |
| C-37 ➕ | 评论 + 答案合成 "label — note" | 选 Postgres + 评论 "fast" | answers 含 "Postgres — fast" | ➕ |
| C-38 ➕ | 多选 + allowComment Enter 后进评论 | multiSelect+allowComment, SPACE, ENTER | mode="comment" | ➕ |
| C-39 ➕ | Other + allowComment 流程 | Other 输文本→Enter→进评论→Enter | freeText + comment 均存 | ➕ |

### 5g. 防重入（FR-12）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| C-40 ➕ | resolved 后忽略后续输入 | ENTER（提交）→再 ENTER | 第二次 done 不触发 | ➕ |
| C-41 ➕ | cancel 后忽略后续输入 | ESC→ENTER | 第二次无效 | ➕ |

### 5h. 渲染缓存（FR 性能）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| C-42 | 同 width 返回同引用 | render×2 | `===` | ✅ |
| C-43 | 输入后失效 | 输入→render | 新引用 | ✅ |
| C-44 ➕ | 不同 width 失效 | render(60)→render(80) | 新引用 | ➕ |

### 5i. Submit tab 交互（FR-5）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| C-45 ➕ | Submit Enter 未全答无效 | 未答+ENTER | 不 resolved | ✅(C-9) |
| C-46 ➕ | Submit Enter 全答提交 | 全答+ENTER | resolved | ✅(C-8) |
| C-47 ➕ | Submit Esc 取消 | Submit tab+ESC | resolved=null | ➕ |

---

## 层 6: index.ts execute 编排（FR-7 / FR-8 / FR-9 / FR-10 / FR-13 / AC-7/8/13/14/15）

> 此层需要 mock `ctx`、`pi.registerTool`、`ctx.ui.custom`。建议新建 `__tests__/index.test.ts`。

### 6a. 参数校验（AC-8 / AC-13）

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| I-1 ➕ | 重复 question → isError | 重复 question | isError=true, 含 "Duplicate" | ➕ |
| I-2 ➕ | 重复 label → isError | 重复 label | isError=true | ➕ |
| I-3 ➕ | 多问题缺 header → isError | 缺 header | isError=true | ➕ |
| I-4 ➕ | 校验错误 details.cancelled=true | 同上 | details.cancelled=true | ➕ |

### 6b. Headless（FR-8 / AC-7）

| # | 用例 | ctx.hasUI | 期望 | 状态 |
|---|------|-----------|------|------|
| I-5 ➕ | hasUI=false 返回 isError | false | isError=true, 含 "requires an interactive session" | ➕ |
| I-6 ➕ | hasUI=false 禁用工具 | false | 调用 setActiveTools 过滤掉 ask_user | ➕ |
| I-7 ➕ | hasUI=false details.cancelled=true | false | details.cancelled=true | ➕ |

### 6c. Signal abort（FR-10 / AC-14）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| I-8 ➕ | 入口 signal 已 aborted | signal.aborted=true（执行前） | 直接返回 cancelled | ➕ |
| I-9 ➕ | 执行中 abort 触发 done(null) | custom 渲染中 abort | done(null) 被调用, 返回 cancelled | ➕ |

### 6d. 错误兜底（FR-13 / AC-15）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| I-10 ➕ | ui.custom 抛异常 | mock custom reject | isError=true, 含 "ask_user failed" | ➕ |
| I-11 ➕ | 异常 details 含 error 字段 | 同上 | details.error 为 message | ➕ |

### 6e. 正常返回（FR-7）

| # | 用例 | 操作 | 期望 | 状态 |
|---|------|------|------|------|
| I-12 ➕ | 单问题返回答案 | mock custom 返回 result | content 含 "header: answer" | ➕ |
| I-13 ➕ | details 回传 questions+answers | 正常 | details.questions/cancelled 完整 | ➕ |
| I-14 ➕ | 取消返回 "User cancelled" | custom 返回 null | content="User cancelled", cancelled=true | ➕ |
| I-15 ➕ | result.cancelled=true 视为取消 | custom 返回 {cancelled:true} | 同上 | ➕ |

### 6f. renderCall / renderResult（FR-9）

| # | 用例 | 输入 | 期望 | 状态 |
|---|------|------|------|------|
| I-16 ➕ | renderCall 显示工具名+topics | args 含 questions | Text 含 "ask_user" + headers | ➕ |
| I-17 ➕ | renderResult 正常列出答案 | details 有 answers | Box 含各 "✓ header: answer" | ➕ |
| I-18 ➕ | renderResult 取消显示 Cancelled | cancelled=true | Text 含 "Cancelled" | ➕ |
| I-19 ➕ | renderResult 错误显示 ✗ | details.error | Text 含 "✗" | ➕ |

---

## 覆盖矩阵（FR × 测试层）

| FR | validate | types | question-view | submit-view | component | index | 覆盖率 |
|----|----------|-------|---------------|-------------|-----------|-------|--------|
| FR-1 工具注册 | | | | | | I-12~I-19 | 部分（需 index 层） |
| FR-2 参数 schema | V-1~V-11 | T-1,T-6,T-7 | | | | I-1~I-4 | ✅ |
| FR-3 自适应渲染 | | | Q-22,Q-23 | | C-1,C-7 | | ✅ |
| FR-4 问题视图 | | | Q-1~Q-27 | | | | ✅ |
| FR-5 Submit 视图 | | | | S-1~S-13 | C-45~C-47 | | ✅ |
| FR-6 输入处理 | | | | | C-2~C-39 | | ✅ |
| FR-7 结果返回 | | | | S-5~S-12 | | I-12~I-15 | ✅ |
| FR-8 Headless | | | | | | I-5~I-7 | 需 index 层 |
| FR-9 自定义渲染 | | | | | | I-16~I-19 | 需 index 层 |
| FR-10 Signal abort | | | | | | I-8,I-9 | 需 index 层 |
| FR-11 Comment 存储 | | | Q-18,Q-19 | S-9 | C-33~C-39 | | ✅ |
| FR-12 防重入 | | | | | C-40,C-41 | | ✅ |
| FR-13 错误兜底 | | | | | | I-10,I-11 | 需 index 层 |
| FR-14 答案回改 | | | | | C-16 | | ✅ |

---

## AC 对照表

| AC | 关键用例 | 状态 |
|----|----------|------|
| AC-1 安装加载 | （手动验收：`pi install` + 重启） | 手动 |
| AC-2 单问题无 Tab | C-1, C-2 | ✅ |
| AC-3 多问题 Tab+Submit | C-7, C-8, C-9 | ✅ |
| AC-4 分屏 | Q-7~Q-14 | 部分（需补 9-14） |
| AC-5 Other 编辑器 | C-25~C-32, Q-15~Q-17 | 需补 |
| AC-6 评论 | C-33~C-39, S-9 | 需补 |
| AC-7 Headless | I-5~I-7 | 需 index 层 |
| AC-8 校验 isError | V-4~V-8, I-1~I-4 | ✅(validate) / 需 index |
| AC-9 单测+tsc+ESLint | （CI 门） | ✅ |
| AC-10 行数限制 | （CI 门） | ✅ |
| AC-11 skill 兼容 | （手动：4 skill 调用） | 手动 |
| AC-12 评论跳过 | C-34 | 需补 |
| AC-13 校验可重试 | I-1~I-4 | 需 index 层 |
| AC-14 abort | I-8, I-9 | 需 index 层 |
| AC-15 异常兜底 | I-10, I-11 | 需 index 层 |
| AC-16 回改 | C-16 | 需补 |
| AC-17 评论 Esc/Enter | C-34~C-36 | 需补 |
| AC-18 多选+评论时机 | C-24, C-38 | 需补 |

---

## 优先级建议

**P0（核心交互路径，必须补）**：
- C-16 回改（AC-16）
- C-24, C-38 多选+评论时机（AC-18）
- C-33~C-37 评论完整流程（AC-6/12/17）
- C-25~C-31 Other 编辑器（AC-5）

**P1（index 层，覆盖 FR-7/8/9/10/13）**：
- I-1~I-19 全部（需 mock ctx/pi）

**P2（渲染细节，增强信心）**：
- Q-9~Q-14 分屏内容
- Q-20~Q-25 帮助行/上下文
- S-5~S-13 getAnswerText/buildResult 各组合
