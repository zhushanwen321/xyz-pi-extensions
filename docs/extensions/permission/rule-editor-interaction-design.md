# Rule Editor 交互设计

## 核心原则

1. **每个状态都有明确的输入处理** — 不允许出现"按什么都没反应"的情况
2. **每个状态都有退出路径** — Esc 始终能返回上一级
3. **状态转换可预测** — 用户能预期按 Enter/Esc 后会发生什么

## 状态机

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Rule Editor 状态机                          │
└─────────────────────────────────────────────────────────────────────┘

                              ┌──────────┐
                              │   LIST   │ ← 初始状态 / 最终状态
                              └────┬─────┘
                                   │ [+ Add rule]
                                   ▼
                              ┌──────────┐
                              │ TEMPLATE │ ← 选择模板
                              └────┬─────┘
                                   │ 选择模板类型
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
              ┌──────────┐  ┌──────────┐  ┌──────────┐
              │ COMMAND  │  │  CUSTOM  │  │ (其他)   │
              │ (搜索)   │  │  (表单)  │  └──────────┘
              └────┬─────┘  └──────────┘
                   │ 选择命令
                   ▼
              ┌──────────┐
              │  SCOPE   │ ← 选择范围
              └────┬─────┘
                   │
            ┌──────┴──────┐
            ▼             ▼
       ┌─────────┐  ┌──────────┐
       │ (all)   │  │ SUBCMD   │ ← 输入子命令
       │ → LIST  │  └────┬─────┘
       └─────────┘       │ → LIST
```

## 各状态详细设计

### S1: LIST（规则列表）

**显示**：
```
[pi-permission] Permission Rules

▶ [allow] npm *
  [deny] rm -rf *
  [+ Add rule]
  [Done]
```

**输入处理**：
| 输入 | 行为 |
|------|------|
| ↑/↓ | 移动光标 |
| Enter | 选中当前项 |
| Esc | 等同于 [Done] |
| 其他 | 忽略 |

**状态转换**：
- 选中规则 → S6（Edit 模式）
- 选中 [+ Add rule] → S2
- 选中 [Done] 或 Esc → 结束，返回 ops

---

### S2: TEMPLATE（选择模板）

**显示**：
```
[pi-permission] Add Rule — Select Template

▶ Allow command family
  Deny command family
  Ask before command
  Allow specific subcommand
  Custom (advanced)
```

**输入处理**：
| 输入 | 行为 |
|------|------|
| ↑/↓ | 移动光标 |
| Enter | 选中模板 |
| Esc | 返回 S1 |

**状态转换**：
- 选中 allow-family/ask-before → S3
- 选中 deny-family → S3（cmd 阶段）
- 选中 allow-subcmd → S3
- 选中 custom → S5
- Esc → S1

---

### S3: COMMAND（选择命令）— 带搜索

**显示**：
```
[pi-permission] Select command
Type to search · Tab to switch · Enter to select

> npm                              ← 搜索框（默认焦点）
───────────────────────────────────
▶ npm — Package Managers           ← 列表（过滤后）
  node — Runtime
  [Type command manually]          ← 始终在顶部
```

**输入处理**：
| 焦点在搜索框 | 焦点在列表 |
|-------------|-----------|
| 字符 → 输入并过滤 | 字符 → 无效 |
| Tab → 切换到列表 | Tab → 切换到搜索框 |
| Enter → 选中第一个匹配 | Enter → 选中当前项 |
| Esc → 返回上一级 | Esc → 返回上一级 |

**状态转换**：
- 选中命令 → S4（Scope 选择）
- 选中 [Type command manually] → S3b（手动输入）
- Esc → S2

---

### S3b: INPUT_COMMAND（手动输入命令名）

**显示**：
```
[pi-permission] Enter command name

> my-command
```

**输入处理**：
| 输入 | 行为 |
|------|------|
| 字符 | 输入 |
| Enter | 提交，进入 S4 |
| Esc | 返回 S3 |

**状态转换**：
- Enter → S4（如果需要 scope）或直接提交回 S1
- Esc → S3

---

### S4: SCOPE（选择范围）

**显示**：
```
[pi-permission] Select scope for npm

▶ npm * (all subcommands)
  npm <subcommand> * (specific)
```

**输入处理**：
| 输入 | 行为 |
|------|------|
| ↑/↓ | 移动光标 |
| Enter | 选中 |
| Esc | 返回 S3 |

**状态转换**：
- 选中 all → 提交，返回 S1
- 选中 specific → S4b
- Esc → S3

---

### S4b: INPUT_SUBCMD（输入子命令）

**显示**：
```
[pi-permission] Enter subcommand name

> install
```

**输入处理**：
| 输入 | 行为 |
|------|------|
| 字符 | 输入 |
| Enter | 提交，返回 S1 |
| Esc | 返回 S4 |

---

### S5: CUSTOM（自定义表单）

**显示**：
```
[pi-permission] Custom Rule (Tab to switch fields)

Pattern (wildcard, e.g. 'npm *')
> npm install *

Action
▶ allow
  deny
  ask

Tool
▶ bash

Description (optional)
>

▶ [Submit]
  [Cancel]
  [Delete this rule]  ← 仅 Edit 模式
```

**输入处理**：
| 输入 | 行为 |
|------|------|
| Tab | 切换到下一个字段 |
| Shift+Tab | 切换到上一个字段（TODO） |
| ↑/↓ | 在选择列表中移动 |
| Enter | 在选择列表中选中 / 在输入框中确认 |
| Esc | 返回 S1 |

**字段焦点索引**：
- 0: Pattern 输入框
- 1: Action 选择列表
- 2: Tool 选择列表
- 3: Description 输入框
- 4: Submit/Cancel 选择列表
- 5: [Delete this rule]（仅 Edit 模式）

**状态转换**：
- Submit → 提交，返回 S1
- Cancel 或 Esc → S1
- Delete → 删除规则，返回 S1

---

### S6: EDIT（编辑现有规则）

等同于 S5，但：
- 标题显示 "Edit Rule"
- 预填充现有规则数据
- 多一个 [Delete this rule] 选项

---

## 关键设计决策

### 1. 搜索框 + 列表的双焦点模式

**问题**：用户可能想直接输入搜索，也可能想用方向键浏览。

**方案**：
- 默认焦点在搜索框（方便输入）
- Tab 切换到列表（方便浏览）
- 搜索框输入时实时过滤列表

### 2. Other 选项的位置

**问题**：31 个命令 + Other 在最下面，很难找到。

**方案**：
- Other 改名为 [Type command manually]
- 放在列表顶部
- 搜索框输入无匹配时自动进入手动输入

### 3. 命令选中后的二次确认

**问题**：选中 `npm` 后直接变成 `npm *`，用户可能想要 `npm install *`。

**方案**：
- 选中命令后弹出 Scope 选择
- 选项1: `npm * (all subcommands)`
- 选项2: `npm <subcommand> * (specific)`

### 4. 每个状态的退出路径

**原则**：Esc 始终返回上一级，不会卡住。

**实现**：
- 每个 SelectList 都有 onCancel 回调
- 每个 Input 都有 onEscape 回调
- 状态转换时清理旧状态（`this.clear()`）

---

## 实现检查清单

- [x] S1: LIST — Enter/Esc 处理正确
- [x] S2: TEMPLATE — Enter/Esc 处理正确
- [x] S3: COMMAND — 搜索 + Tab 切换 + Enter/Esc
- [x] S3b: INPUT_COMMAND — Enter 提交 + Esc 返回
- [x] S4: SCOPE — Enter/Esc 处理正确
- [x] S4b: INPUT_SUBCMD — Enter 提交 + Esc 返回
- [x] S5/S6: CUSTOM/EDIT — Tab 焦点 + Enter/Esc
- [x] 所有状态的 handleInput 都有明确的分支
- [x] 没有"死区"（输入被忽略的情况）

---

## 实现补充（W9 wave 1/2 引入的机制）

### _resetStageRefs()（C3 根因修复，wave 1）
Container.clear() 只清 children 数组，不清组件引用字段（_searchInput/_commandList/currentInput 等）。每个 switchTo*/startFill* 方法在 clear() 后调用 _resetStageRefs() 集中清理 6 个组件引用，杜绝手动清理遗漏导致的输入路由死锁。

### commitFill edit/new 分支（M1 修复，wave 2）
edit 模式走 custom form 但不设 fillTemplate，旧 commitFill 在 fillTemplate===null 时提前 return 导致 edit 操作静默丢失。现 edit 分支前置检查，直接从 fillSelections 构造 Rule，绕过 fillTemplate.build。

### _syncCustomFormValues()（M2 修复，wave 2）
pi-tui Input.onSubmit 仅在 Enter 时触发，Tab 切换焦点不触发。commitFill 入口调用 _syncCustomFormValues 兜底读取 Input.getValue() 刷新 fillSelections，覆盖 Tab/直接 Submit 所有路径。

### _injectFocusIndicator()（M4 修复，wave 2）
SelectList 无 focused 概念，custom form 4/5 字段无可视焦点。render() 后处理遍历输出行，给 customFocusIndex 对应的字段标签加 ▶ 前缀。

### 搜索过滤 startsWith 统一（M5 修复，wave 3）
实时过滤（SelectList.setFilter）和 Enter 选择（_filterCommands）统一用 startsWith 匹配，消除「显示空但 Enter 能匹配」的矛盾。__other__ 项始终保留。

---

## Followup（未在本轮修复，待后续）

1. **RPC edit flow 功能对等（M6）**：rpcEditFlow（rule-editor.ts）只提供 delete/cancel，不能编辑字段，与 TUI custom form 不对等。补齐涉及 rpcEditFlow 重写，工作量独立，建议单独建 slice。
2. **edit 分支 source 透传**：commitFill edit 分支硬编码 `source: "user"`。当前 edit 只针对 user 规则（builtin 不进 list），合理。未来若支持 builtin edit，需透传原 rule.source。
3. **搜索过滤升级为 contains**：当前 startsWith 匹配要求输入命令前缀（如搜 install 找不到 npm install）。待 pi-tui SelectList 支持自定义 filter 回调 API，升级为 contains 匹配。
4. **rule-editor-component.ts 文件拆分**：910 行（pre-commit WARN >500），建议按 list/add/fill stage 拆分到独立文件。

---

## 测试用例

> 注：下列测试用例中的 P1–P6 命名对应上文状态机的 S1–S6 命名（P 编号为旧版草稿命名，S 编号为本轮 W9 实现命名）。

### TC1: Add Rule — Allow command family
1. 进入 P1，选择 [+ Add rule]
2. 进入 P2，选择 "Allow command family"
3. 进入 P3，输入 "npm" 搜索
4. Tab 切换到列表，选择 "npm"
5. 进入 P4，选择 "npm * (all subcommands)"
6. 提交并返回 P1

### TC2: Add Rule — Deny specific subcommand
1. 进入 P1，选择 [+ Add rule]
2. 进入 P2，选择 "Deny command family"
3. 进入 P3，输入 "git" 搜索
4. Tab 切换到列表，选择 "git"
5. 进入 P5，选择 "[Specific subcommand]"
6. 进入 P4b，输入 "push"
7. 提交并返回 P1

### TC3: Add Rule — Custom
1. 进入 P1，选择 [+ Add rule]
2. 进入 P2，选择 "Custom (advanced)"
3. 进入 P6，Tab 切换焦点填写表单
4. 选择 Submit
5. 返回 P1

### TC4: Edit Rule
1. 进入 P1，选择一条规则
2. 进入 P6 (Edit 模式)
3. Tab 切换焦点修改字段
4. 选择 Submit 或 Delete
5. 返回 P1

### TC5: 搜索并手动输入
1. 进入 P3，输入 "xyz" (不存在的命令)
2. 按 Enter
3. 进入 P3b，显示 "xyz" 已填入
4. 按 Enter 确认
5. 进入 P4 或提交
