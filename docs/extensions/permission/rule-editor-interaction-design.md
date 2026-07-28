# Rule Editor 交互设计文档

## 状态机概览

```
┌─────────────────────────────────────────────────────────────────┐
│                     RuleEditorComponent                         │
├─────────────────────────────────────────────────────────────────┤
│  stage: "list" | "add" | "fill"                                 │
│  fillKind: "command-select" | "deny-family" | "allow-subcmd"   │
│           | "custom"                                            │
│  fillEditMode: boolean                                          │
└─────────────────────────────────────────────────────────────────┘
```

## 页面状态定义

### P1: Rule List（规则列表）

**stage**: `list`

**显示内容**:
- 标题: `[pi-permission] Permission Rules`
- 规则列表: `[action] pattern` 格式
- 操作项: `[+ Add rule]`、`[Done]`

**交互**:
| 按键 | 行为 |
|------|------|
| ↑/↓ | 移动光标 |
| Enter | 选中当前项 |
| Esc | 完成并退出 |

**选中规则** → 进入 P6 (Edit Rule)
**选中 [+ Add rule]** → 进入 P2 (Select Template)
**选中 [Done]** → 返回 ops
**Esc** → 返回 ops

---

### P2: Select Template（选择模板）

**stage**: `add`

**显示内容**:
- 标题: `[pi-permission] Add Rule — Select Template`
- 模板列表:
  - Allow command family
  - Deny command family
  - Ask before command
  - Allow specific subcommand
  - Custom (advanced)

**交互**:
| 按键 | 行为 |
|------|------|
| ↑/↓ | 移动光标 |
| Enter | 选中模板 |
| Esc | 返回 P1 |

**选中模板** → 进入对应的 P3/P4/P5/P6
**Esc** → 返回 P1

---

### P3: Select Command（选择命令）— 带搜索

**stage**: `fill`, **fillKind**: `command-select` / `deny-family` / `allow-subcmd`

**显示内容**:
- 标题: `[pi-permission] Select command`
- 提示: `Type to search · Tab to switch focus · Enter to select`
- 搜索输入框
- 命令列表（带 `[Type command manually]` 在顶部）

**交互**:
| 按键 | 焦点在搜索框 | 焦点在列表 |
|------|-------------|-----------|
| 字符键 | 输入字符，实时过滤列表 | 无效 |
| Tab | 切换到列表 | 切换到搜索框 |
| ↑/↓ | 无效 | 移动光标 |
| Enter | 选中第一个匹配项 | 选中当前项 |
| Esc | 返回上一级 | 返回上一级 |

**搜索框获焦时**:
- 输入字符 → 实时过滤列表
- Enter → 选中第一个匹配项（如果有），否则进入 P3b (Manual Input)

**列表获焦时**:
- Enter → 选中当前项
- 如果选中 `[Type command manually]` → 进入 P3b

**选中命令** → 进入 P4 (Select Scope) 或直接提交
**Esc** → 返回 P2 或 P1

---

### P3b: Manual Input（手动输入命令名）

**stage**: `fill`, 使用 `Input` 组件

**显示内容**:
- 标题: `[pi-permission] Enter command name`
- 输入框

**交互**:
| 按键 | 行为 |
|------|------|
| 字符键 | 输入字符 |
| Enter | 提交输入，继续后续流程 |
| Esc | 返回 P3 |

**Enter** → 根据上下文进入 P4 或提交
**Esc** → 返回 P3

---

### P4: Select Scope（选择范围）

**stage**: `fill`, 使用 `SelectList` 组件

**显示内容**:
- 标题: `[pi-permission] Select scope for <command>`
- 选项:
  - `<command> * (all subcommands)`
  - `<command> <subcommand> * (specific)`

**交互**:
| 按键 | 行为 |
|------|------|
| ↑/↓ | 移动光标 |
| Enter | 选中当前项 |
| Esc | 返回 P3 |

**选中 all subcommands** → 提交并返回 P1
**选中 specific** → 进入 P4b (Enter Subcommand)
**Esc** → 返回 P3

---

### P4b: Enter Subcommand（输入子命令名）

**stage**: `fill`, 使用 `Input` 组件

**显示内容**:
- 标题: `[pi-permission] Enter subcommand name`
- 输入框

**交互**:
| 按键 | 行为 |
|------|------|
| 字符键 | 输入字符 |
| Enter | 提交输入，返回 P1 |
| Esc | 返回 P4 |

**Enter** → 提交并返回 P1
**Esc** → 返回 P4

---

### P5: Deny Scope（Deny 范围选择）

**stage**: `fill`, **fillKind**: `deny-family`, **denySubStage**: `subcmd`

**显示内容**:
- 标题: `[pi-permission] Deny <command> — Select scope`
- 选项:
  - `[Any subcommand]`
  - `[Specific subcommand]`

**交互**:
| 按键 | 行为 |
|------|------|
| ↑/↓ | 移动光标 |
| Enter | 选中当前项 |
| Esc | 返回 P3 |

**选中 Any** → 提交并返回 P1
**选中 Specific** → 进入 P4b
**Esc** → 返回 P3

---

### P6: Edit Rule / Custom Form（编辑规则 / 自定义表单）

**stage**: `fill`, **fillKind**: `custom`

**显示内容**:
- 标题: `[pi-permission] Edit Rule (Tab to switch fields)` 或 `Custom Rule (Tab to switch fields)`
- 表单项:
  1. Pattern (wildcard): 输入框
  2. Action: 选择列表 (allow/deny/ask)
  3. Tool: 选择列表 (bash)
  4. Description: 输入框
  5. Submit/Cancel: 选择列表
  6. [Delete this rule] (仅 Edit 模式)

**交互**:
| 按键 | 行为 |
|------|------|
| Tab | 切换焦点到下一个字段 |
| Shift+Tab | 切换焦点到上一个字段 (TODO) |
| 字符键 | 在输入框中输入 |
| ↑/↓ | 在选择列表中移动 |
| Enter | 在选择列表中选中 / 在输入框中提交 |
| Esc | 返回 P1 |

**焦点索引** (customFocusIndex):
- 0: Pattern 输入框
- 1: Action 选择列表
- 2: Tool 选择列表
- 3: Description 输入框
- 4: Submit/Cancel 选择列表
- 5: [Delete this rule] (仅 Edit 模式)

**问题**: 当前 `customFocusIndex % 5` 只覆盖前 5 个，Edit 模式下第 6 个 `[Delete this rule]` 无法通过 Tab 到达。

**修复方案**: 根据 `fillEditMode` 动态计算模数：
- New mode: `customFocusIndex % 5`
- Edit mode: `customFocusIndex % 6`

---

## 问题分析与修复

### 问题 1: Edit Rule 界面无法操作

**原因**: 
- Edit Rule 使用 `startFillCustom()` 创建表单
- 表单有 6 个子组件（Edit 模式），但 Tab 焦点路由使用 `customFocusIndex % 5`
- 第 6 个组件 `[Delete this rule]` 无法通过 Tab 到达
- 可能存在其他焦点同步问题

**修复**:
1. 根据 `fillEditMode` 动态计算模数
2. 确保 `syncCustomFocus` 正确同步所有组件的焦点状态

### 问题 2: Add Rule 输入不存在命令后卡住

**原因**:
- 用户在 P3b (Manual Input) 输入命令名后按 Enter
- `startCommandInput` 的 `onSubmit` 回调调用 `commitFill()`
- `commitFill()` 中检查 `fillTemplate === null`，如果为 null 则调用 `switchToListStage()`
- 但可能 `fillTemplate` 没有正确设置，或者 `switchToListStage()` 没有正确更新 UI

**修复**:
1. 确保 `fillTemplate` 在进入 `startCommandInput` 前已设置
2. 确保 `commitFill()` 正确处理所有情况
3. 添加错误处理和日志

### 问题 3: 状态转换不完整

**原因**:
- 某些状态转换没有正确处理边界情况
- 例如：从 P3b 返回时，应该返回到 P3，但可能返回到了错误的状态

**修复**:
1. 明确定义每个状态的返回目标
2. 确保所有 `onCancel` 回调都正确设置
3. 添加状态转换日志用于调试

---

## 测试用例

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

---

## 实现检查清单

- [ ] P1: Rule List — 正确处理 Enter/Esc
- [ ] P2: Select Template — 正确处理 Enter/Esc
- [ ] P3: Select Command — 搜索过滤 + Tab 切换 + Enter 选择
- [ ] P3b: Manual Input — Enter 提交 + Esc 返回
- [ ] P4: Select Scope — Enter 选择 + Esc 返回
- [ ] P4b: Enter Subcommand — Enter 提交 + Esc 返回
- [ ] P5: Deny Scope — Enter 选择 + Esc 返回
- [ ] P6: Edit/Custom Form — Tab 焦点 + Enter/Esc
- [ ] 所有状态转换都有明确的返回目标
- [ ] 所有 onCancel 回调都正确设置
- [ ] Edit 模式下 Tab 焦点覆盖所有字段（包括 Delete）
