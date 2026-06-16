# ask-user 验收用例（手动 E2E）

> 目标：在真实 Pi session 中调用 `ask_user`，通过用户实际操作验收 spec 功能。
> 用法：先 `pi install npm:@zhushanwen/pi-ask-user` 重启 Pi，把对应 prompt 贴给 LLM 触发调用，按"操作"列点选/输入，最后对照"期望"列逐项勾选。

## 启动准备

```bash
# 1. 安装/刷新扩展
pi install npm:@zhushanwen/pi-ask-user

# 2. 启 Pi
pi

# 3. 验证扩展已加载
/help-tools 2>/dev/null | grep ask_user   # 看到 ask_user 即 OK
```

每个用例的 prompt 是**直接发给 LLM 的请求**，LLM 会自行决定是否调用 `ask_user`、如何构造参数。验收时如发现 LLM 调用的参数与"期望参数"不一致，说明 prompt 不够精确，把"期望参数"用更直白的措辞加到 prompt 里重试。

---

## 用例清单

### A-1: 单问题单选 — 默认 Enter 提交

**Prompt**:
```
Use ask_user to ask me which database to use, with two options: Postgres (battle-tested) and SQLite (embedded).
```

**期望参数**（LLM 应构造出）:
```json
{ "questions": [{ "question": "Which database?",
  "options": [{"label":"Postgres","description":"Battle-tested"},
              {"label":"SQLite","description":"Embedded"}] }] }
```

**操作**: 直接按 Enter（不移动光标）

**期望**:
- [ ] 渲染无 Tab bar
- [ ] 光标在 Postgres 行（`>`）
- [ ] Enter 后立即返回，content 含 `"Postgres"`
- [ ] 不显示评论输入行（无 allowComment）

**覆盖**: AC-2, FR-1/3/6/7

---

### A-2: 单问题 + allowComment — 评论拼接

**Prompt**:
```
Use ask_user to ask my framework preference. Set allowComment: true so I can add a note.
Two options: Vue 3 (Composition API) and Svelte 5 (runes).
```

**期望参数**: `allowComment: true`

**操作**: ↓ 移到 Svelte → Enter → 输入 "考虑迁移成本" → Enter

**期望**:
- [ ] 选 Svelte 后不立即提交，弹出评论输入行
- [ ] 评论行提示 "Your comment (optional)"
- [ ] 输入 "考虑迁移成本" → Enter 后返回
- [ ] content 含 `"Svelte 5 (runes) — 考虑迁移成本"`

**覆盖**: AC-6, AC-12, AC-17, FR-4.6/11

---

### A-3: 单问题 + allowComment — Enter 空评论跳过

**Prompt**: 同 A-2

**操作**: Enter 选 Vue → Enter（评论行不输任何字符）

**期望**:
- [ ] 返回 content 含 `"Vue 3 (Composition API)"`（**不含** " — "）
- [ ] 不阻塞、不报错

**覆盖**: AC-12

---

### A-4: 多问题 Tab 导航 + Submit

**Prompt**:
```
Use ask_user to confirm three decisions in one call:
1. Database: Postgres vs SQLite
2. Language: TypeScript vs Python
3. Test framework: Vitest vs Jest
Use header "DB" / "Lang" / "Test" (≤12 chars each).
```

**操作**:
1. Enter 选 Postgres（Q1）
2. → 切到 Lang, Enter 选 TypeScript
3. → 切到 Test, Enter 选 Vitest
4. → 切到 Submit tab, Enter 提交

**期望**:
- [ ] 顶部 Tab bar 显示 "DB" "Lang" "Test" "Submit"（激活 tab 高亮）
- [ ] 已答 tab 显示 ■，未答 □
- [ ] Submit tab 标题 "Ready to submit"，列出三行 `header: answer`
- [ ] 返回 content 含三个 answer

**覆盖**: AC-3, FR-5/7

---

### A-5: 多问题 — Submit 未答完 Enter 阻塞

**Prompt**: 同 A-4

**操作**:
1. Enter 选 Postgres
2. → Lang, Enter 选 TypeScript（跳过 Test）
3. → Submit tab, Enter

**期望**:
- [ ] Submit tab 标题 "Unanswered"，显示 "Still needed: Test"
- [ ] Enter 不提交（仍停留在 Submit tab）
- [ ] ← 回 Test, Enter 选 Vitest, → 切回 Submit, Enter 提交成功

**覆盖**: FR-5, AC-3

---

### A-6: 多问题回改已答答案（AC-16）

**Prompt**: 同 A-4

**操作**:
1. Enter 选 Postgres
2. → Lang, Enter 选 TypeScript
3. → Test, Enter 选 Vitest
4. → Submit tab（不按 Enter）
5. ← ← ← 回到 DB tab
6. ↓ 移到 SQLite, Enter
7. → → → Submit, Enter

**期望**:
- [ ] DB tab 重新可选（■ 标记保留）
- [ ] 最终 content 的 DB 答案 = "SQLite"（**不是** Postgres）
- [ ] Lang / Test 答案保持 TypeScript / Vitest

**覆盖**: AC-16, FR-14

---

### A-7: 多选 + allowComment — toggle 多项 + 评论

**Prompt**:
```
Use ask_user to ask which features I want. multiSelect: true, allowComment: true.
Options: Auth, Search, Cache, Realtime.
```

**操作**:
1. Space 选 Auth
2. Space 选 Realtime（跳过中间）
3. Enter 确认
4. 输入 "MVP 阶段" 评论
5. Enter

**期望**:
- [ ] Space 后该行变成 `[✓]`
- [ ] Enter 后**不**立即返回，弹出评论行
- [ ] 返回 content 含 `"Auth, Realtime — MVP 阶段"`（按 index 顺序）

**覆盖**: AC-18, FR-6, FR-11

---

### A-8: 多选 + allowComment — 仅 toggle 不 Enter 不会触发评论

**Prompt**: 同 A-7

**操作**:
1. Space 选 Auth
2. Space 选 Realtime
3. （**不**按 Enter，再 Space 取消 Auth）

**期望**:
- [ ] 仍在多选问题 tab 内
- [ ] 评论输入行**未**出现（toggle 不触发评论）

**覆盖**: AC-18

---

### A-9: Other 自由文本 — 输入 + 保存

**Prompt**:
```
Use ask_user to ask my custom note. Two options: "Standard plan" and "Custom plan".
```

**操作**:
1. ↓ 移到 Other（最末项）
2. Space 打开内联编辑器
3. 输入 "需要私有部署"
4. Enter 保存

**期望**:
- [ ] Other 行提示 "Space/Tab open editor"
- [ ] 编辑器就地展开在选项列表下方
- [ ] Enter 后返回 content 含 `"需要私有部署"`

**覆盖**: AC-5, FR-4.5

---

### A-10: Other 自由文本 — 空 Enter 清除

**Prompt**: 同 A-9

**操作**:
1. ↓ 到 Other, Space 打开编辑器
2. 不输入任何字符, Enter

**期望**:
- [ ] 编辑器关闭, 回到选项列表
- [ ] **不**调用 done（仍停在问题 tab）
- [ ] 此时按 Esc 才取消整个问答

**覆盖**: FR-4.5, FR-6

---

### A-11: Other 自由文本 — Esc 丢弃编辑

**Prompt**: 同 A-9

**操作**:
1. ↓ 到 Other, Space 打开编辑器
2. 输入 "abc"
3. Esc

**期望**:
- [ ] 回到选项列表
- [ ] freeTextValue 未保存（重新打开编辑器应为空）

**覆盖**: FR-6

---

### A-12: 宽终端分屏（≥84 列）

**Prompt**:
```
Use ask_user to pick a frontend approach with detailed descriptions.
Options:
- Vue 3: "Composition API + Pinia + Vue Router"
- Svelte 5: "Runes + built-in stores"
- Solid: "Fine-grained reactivity"
```

**操作**: 在宽终端（≥84 列）观察渲染

**期望**:
- [ ] 左列显示选项列表（无 description）
- [ ] 右列显示当前光标项的 description（Markdown 预览）
- [ ] 移动光标时右列实时更新

**覆盖**: AC-4, FR-4.4

---

### A-13: 窄终端降级单列

**Prompt**: 同 A-12

**操作**: 把终端窗口拖到 < 84 列宽，再触发同 prompt

**期望**:
- [ ] 降级为单列，description 缩进显示在 option 下方
- [ ] 无右侧预览

**覆盖**: AC-4, FR-4.4

---

### A-14: Esc 取消

**Prompt**: A-1 任何一种

**操作**: 渲染后立即按 Esc

**期望**:
- [ ] TUI 立即关闭
- [ ] content = "User cancelled"
- [ ] LLM 收到 cancelled 反馈，可继续对话

**覆盖**: FR-7, FR-12

---

### A-15: 校验 — 重复 question 文案

**Prompt**:
```
Use ask_user to ask two questions but make both questions the same text "Pick one" with different options.
```

**期望**:
- [ ] LLM 应在 spec 引导下避免，但若 LLM 真的调出重复 question：
- [ ] 收到 isError，content 含 "Duplicate question"
- [ ] LLM 可自动修正重试

**覆盖**: AC-8, AC-13, FR-2

> **注意**: 此用例可能因 LLM 自身约束而无法触达错误路径。如需强制复现，可手动构造 payload 喂给扩展（见文末"补充：直接调用工具"）。

---

### A-16: 校验 — 重复 option label

**Prompt**:
```
Use ask_user with one question that has options ["Yes", "Yes", "No"].
```

**期望**: 同 A-15，content 含 "Duplicate option label"

**覆盖**: AC-8, AC-13

---

### A-17: 校验 — 多问题缺 header

**Prompt**:
```
Use ask_user to ask two questions. Don't set header on the second one.
```

**期望**: content 含 "header" 错误

**覆盖**: AC-8, AC-13, FR-2

---

### A-18: 4 个问题上限（maxItems）

**Prompt**:
```
Use ask_user to ask 4 questions in one call. All under header labels: "A", "B", "C", "D".
```

**期望**:
- [ ] 4 个 Tab + Submit tab 共 5 个
- [ ] 全部答完后 Submit 可提交

**覆盖**: FR-2 (maxItems:4), AC-3

---

### A-19: signal abort（手动难复现，作为加分项）

**触发方式**: 在 `ask_user` 渲染中（任意用例），按 `Ctrl+C` 中断 Pi

**期望**:
- [ ] TUI 立即关闭
- [ ] 不挂死
- [ ] 重新 `pi` 进入新 session 时状态干净

**覆盖**: AC-14, FR-10

---

## 验收记录模板

```markdown
# ask-user 验收 — YYYY-MM-DD

| 用例 | 通过 | 失败原因 |
|------|------|----------|
| A-1  |      |          |
| A-2  |      |          |
| A-3  |      |          |
| A-4  |      |          |
| A-5  |      |          |
| A-6  |      |          |
| A-7  |      |          |
| A-8  |      |          |
| A-9  |      |          |
| A-10 |      |          |
| A-11 |      |          |
| A-12 |      |          |
| A-13 |      |          |
| A-14 |      |          |
| A-15 |      |          |
| A-16 |      |          |
| A-17 |      |          |
| A-18 |      |          |
| A-19 |      |          |
```

---

## 补充：直接调用工具（绕过 LLM 决策）

如需绕过 LLM 决策直接验证错误路径，创建一个测试 skill 或临时 prompt 模板，强制 LLM 透传参数：

```
Use ask_user with EXACTLY this payload (do not modify):
{"questions": [{"question": "Q", "options": [{"label":"A"},{"label":"A"}]}]}
```

或更可靠的方式：在 spec-clarify / 任意调用 `ask_user` 的 skill 入口处粘贴 JSON 模板。

---

## 覆盖矩阵

| AC | 用例 |
|----|------|
| AC-1 安装加载 | 启动准备 |
| AC-2 单问题无 Tab | A-1 |
| AC-3 多问题 Tab+Submit | A-4, A-5, A-18 |
| AC-4 分屏 | A-12, A-13 |
| AC-5 Other 编辑器 | A-9 |
| AC-6 评论 | A-2, A-7 |
| AC-7 Headless | （手动难验，单元测试覆盖） |
| AC-8 校验 isError | A-15, A-16, A-17 |
| AC-12 评论跳过 | A-3 |
| AC-14 abort | A-19 |
| AC-16 回改 | A-6 |
| AC-17 评论 Enter/Esc | A-2, A-3 |
| AC-18 多选+评论时机 | A-7, A-8 |

**AC-7 / AC-9 / AC-10 / AC-11**: 安装、单元测试、行数、skill 兼容——非交互验收，不在本表。
