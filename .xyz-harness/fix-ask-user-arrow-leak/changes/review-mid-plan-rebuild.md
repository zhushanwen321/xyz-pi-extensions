# mid-plan 重建审查（独立 reviewer，未读初稿前重建）

- 审查对象：requirements.md + system-architecture.md
- 审查方法：先读源码（component.ts / types.ts / question-view.ts / submit-view.ts / component.test.ts）+ decisions.md 独立重建认知帧，再读两份初稿做 diff
- 决策账本纪律：D-001~D-004 status=confirmed，不重报

---

## Verdict

**CHANGES_REQUESTED**

存在 1 条 must_fix（D-可逆，refactor 行为等价缺口，会导致 BC 漏改）+ 3 条 should_fix。

核心问题：BC 清单（system-architecture §12）漏登了两类「editorText 进出编辑器的预填/清空时机」行为。这是 refactor 模式的硬伤——BC 清单是「现有代码有但 requirements 没写」的兜底，漏登意味着 implementer 迁移到 draftText 时会丢失这些隐式行为，测试套件无覆盖则会静默退化。

---

## 重建结果

### Actor / 用例（需求层面）

**Actor**：终端用户（通过 TUI 操作 ask-user 表单）

**核心用例（从源码行为重建，非从初稿）**：

| UC | 描述 | 源码依据 |
|----|------|---------|
| UC-A | 单选：光标移到普通选项按 Enter → selectedIndex=cursorIndex、freeTextValue 清空、confirmed=true，若 allowComment 进 comment 模式否则 advance | component.ts `handleInput` 单选 Enter 分支 + `afterConfirm` |
| UC-B | 多选：普通选项 Space toggle；普通选项 Enter 把光标项加入 selectedIndices 再确认（与单选 Enter 对称） | component.ts 多选 Space/Enter 分支 |
| UC-C | Other（末选项）Enter → 进 freeform 编辑器，editorText 预填 `state.freeTextValue ?? ""` | component.ts `onOther && matchesKey(data,"enter")` 分支 |
| UC-D | freeform 编辑器内：可打印字符追加（按 code point，剥 bracketed paste 标记，过滤 < U+0020）；Backspace 删末尾；Enter 有文本→保存 freeTextValue+清 selectedIndex+回 options+afterConfirm；Enter 空文本→清 freeTextValue+回 options+重置 confirmed（若全无答案）；Esc→回 options 丢弃 editorText | component.ts `handleEditorInput` |
| UC-E | comment 模式：进编辑器时 editorText 预填 `state.commentValue ?? ""`；Enter 有文本→存 commentValue+advance；Enter 空→commentValue=null+advance；Esc→mode=options+清 editorText+advance（保留已有 commentValue） | component.ts `afterConfirm`(comment 预填) + `handleEditorInput` comment 分支 |
| UC-F | ←/→ 在问题 tab 间导航（多问题，options 模式）；→ 在末问题进 Submit tab；← 在首问题不环绕；离开 tab 时 auto-confirm 已答问题 | component.ts `handleInput` left/right 分支 + `gotoTab` |
| UC-G | Esc 在非首问题回退一 tab；在首问题进确认取消覆盖层；覆盖层内 Esc 确认取消、任意其他键退出覆盖层 | component.ts `escBackOrConfirm` + `handleInput` pendingCancel 分支 |
| UC-H | Submit tab：←/→ 导航（→ 环绕到首问题、← 到末问题）；Tab 切 submitTabFocus（Submit↔Cancel 单键双向）；Enter 触发 focus 项（Submit 需 allConfirmed、Cancel 直接 cancel）；Esc 回退到末问题 | component.ts `handleSubmitTabInput` |
| UC-I | 单问题模式：无 tab 栏、无 Submit tab、Enter 直接 submit；advance 在单问题下直接 submit | component.ts `isSingle` 守卫 + `advance` |

### 模型 / 边界 / 状态机（架构层面）

**QuestionState 不变式（从源码重建）**：
- `confirmed=true` ⟹ 有答案（selectedIndex≠null ∨ selectedIndices.size>0 ∨ freeTextValue≠null）。被三处维护：toggleIndex 清空后重置、freeform 空 Enter 清空后重置、单选 Enter 回改清 freeTextValue
- `mode=freeform` 时 editorText 是渲染源且是 freeform 编辑器的工作副本；`mode=comment` 时 editorText 是 comment 编辑器的工作副本
- editorText 是**组件级单实例**（`private editorText: string = ""`），非 per-question。靠「进入编辑器时重赋值」维持正确：进 freeform 时 `editorText = state.freeTextValue ?? ""`，进 comment 时 `editorText = state.commentValue ?? ""`

**mode 状态机**：
```
options --[Other+Enter]--> freeform --[Esc|Enter]--> options
options --[confirm+allowComment]--> comment --[Esc|Enter]--> options
```
mode 可循环，无终态。终态由组件级 `_resolved` 守卫：`_resolved=true` 后 handleInput 和 cancel 均 no-op（防重入，FR-12 竞态：signal abort 可能在 submit 后触发）。

**submitTabFocus 状态机**：`"submit"|"cancel"`，Tab 单键双向切换，默认 "submit"。仅 Submit tab 上有意义。

**pendingCancel 状态**：boolean，Esc 在首个问题时置 true 进入覆盖层，覆盖层内 Esc→cancel()、任意其他键→置 false 退出。

---

## diff（MISSING / PHANTOM / MISMATCH）

### MISSING-1 [D-可逆] — BC 清单漏登 comment 模式进入时 editorText 预填 commentValue（must_fix）

**源码行为**：`afterConfirm` 中进 comment 模式时 `this.editorText = state.commentValue ?? ""`（component.ts:460）。即用户已输入过评论、回改答案重新进 comment 编辑器时，预填上次的评论文本。

**初稿**：system-architecture §12 BC 清单只登记了 freeform 进入时预填（隐含在 BC-4/BC-5 上下文），但 **comment 进入时预填 commentValue 这一行没有任何 BC 条目**。BC-5 只说「comment Esc 保留已有 commentValue」，没覆盖「进 comment 时 editorText 预填 commentValue」这个独立行为。

**refactor 风险**：迁移到 `state.draftText` 后，§10 D-2 给的预填公式是 `state.draftText = state.freeTextValue ?? state.commentValue ?? ""`。这公式本身能覆盖 comment 预填，**但前提是 implementer 知道进 comment 时也要预填**。由于 BC 清单漏登这一条，且测试套件（C-36 系列）只测了「Esc 丢弃 typed text」「Enter 空 skip」，没有测「回改答案后重进 comment 看到上次评论预填」——这个行为是源码有、测试无覆盖、BC 无登记的三重盲区。implementer 若按 D-2 公式实现能撞对，但若只看 BC 清单实现就会漏。

**判定**：must_fix。BC 清单必须补一条 BC-X 登记此行为，并在测试计划加一条覆盖（回改答案→重进 comment→预填旧评论）。

### MISSING-2 [D-可逆] — BC 清单漏登 freeform 保存成功后清空 editorText + selectedIndex 清空（should_fix）

**源码行为**：freeform Enter 有文本时：`state.freeTextValue = text; state.selectedIndex = null; state.mode = "options"; this.editorText = ""`（component.ts:354-358）。其中 `selectedIndex = null` 是关键——保存 Other 文本时显式清空单选的普通选项，维持「单选答案唯一」不变式。

**初稿**：BC-4 只登记了「空 Enter 清 freeTextValue + 重置 confirmed」，**没有登记「有文本 Enter 时清空 selectedIndex」**。D-2 给的迁移公式也没提 selectedIndex 清空。

**refactor 风险**：迁移 draftText 时若只关注 editorText 字段，容易漏掉 `selectedIndex = null` 这一行（它不在 editorText 路径上，但在同一个 Enter 分支里）。selectedIndex 残留会导致 freeTextValue 和 selectedIndex 同时非 null，`getAnswerText` 会把两者都输出（submit-view.ts 中 parts 同时 push label 和 freeTextValue）。

**判定**：should_fix。BC 清单应补一条覆盖 freeform 有文本 Enter 时的 selectedIndex 清空。

### MISSING-3 [D-可逆] — requirements UC-3 描述与源码行为不符：方向键在 freeform 下现状是「泄漏」而非「no-op」（should_fix，接近 PHANTOM）

**源码行为**：现状 freeform 模式下，方向键（如 `\x1b[C`）落入 `handleEditorInput` 的 printable 分支，`\x1b` 被 `c >= " "` 过滤，但 `[` 和 `C` 追加进 editorText → 泄漏成 `[C` 文本。这是 bug。

**初稿**：requirements UC-3 主流程第 2 步写「按 ←/→ 切到 Q2（注意：freeform 模式下方向键被 no-op，用户需 Esc 先退出编辑器）」。这句话把 freeform 下方向键描述为「被 no-op」，这是**修复后的目标行为**，不是现状行为。虽然 system-architecture §12 BC-7 正确标注了「现状是泄漏，修复后 no-op」，但 requirements UC-3 的措辞会让读者误以为现状就是 no-op，模糊了「修复前 vs 修复后」的边界。

**判定**：should_fix。requirements UC-3 应明确「现状 freeform 下方向键泄漏成文本（bug），修复后 no-op」，避免与 BC-7 表述冲突。

### MISMATCH-1 [K] — handleSubmitTabInput 的 Tab 消费：初稿标注「候选/需运行验证」，但源码已实际消费且测试覆盖

**源码行为**：`handleSubmitTabInput` 中 `if (matchesKey(data, "tab"))` 已实际实现 Tab 切 focus（component.ts:~307），且有 C-NEW-3 测试覆盖（Tab → Cancel → Tab → Submit）。

**初稿**：system-architecture §1 搭便车改造表把「handleSubmitTabInput 的 Tab 消费优先级确认」标为「候选（⑤运行验证）」，措辞像未定/待验证。

**判定**：should_fix。Tab 消费已是已实现+已测试行为，不是候选。初稿应明确这是「保持现状」而非「待验证」。注释里的怀疑（pi 全局拦截 Tab）已被 C-NEW-3 测试证伪（测试绿即说明 Tab 到达了组件）。不过这属于表述精度问题，不影响 refactor。

### PHANTOM-1 [K] — system-architecture §7 LOC 预估「question-view.ts ~340」与实际不符（轻微）

**实际**：question-view.ts 当前行数需核实，但初稿给的预估是 refactor 后的预估，非现状。这是预估偏差不是行为 phantom，降级为提示。

**判定**：不阻断，提示性。implementer 以实际行数为准。

---

## must_fix

### MF-1 [D-可逆]：BC 清单补登 comment 进入时 editorText 预填 commentValue

对应 MISSING-1。system-architecture §12 BC 清单新增一条：

| 字段 | 内容 |
|------|------|
| 源码位置 | `component.ts:afterConfirm` comment 分支 `this.editorText = state.commentValue ?? ""` |
| 处理 | **保持**（迁移到 draftText 后，进 comment 时 `state.draftText = state.commentValue ?? ""`） |
| 冲突 | 无 |

同时 requirements 测试计划应加一条：allowComment 问题，选答案进 comment 输入 "note" → Enter 保存 → 回改答案重进 comment → editorText 应预填 "note"。

**理由**：这是 refactor 行为等价的硬约束。BC 清单的存在意义就是兜底「源码有但 requirements 没写」的行为。漏登这一条 = implementer 无指引 = 行为退化风险。且测试套件无覆盖，退化会静默通过。

---

## should_fix

### SF-1 [D-可逆]：BC 清单补登 freeform 有文本 Enter 时清空 selectedIndex

对应 MISSING-2。BC 清单新增：

| 字段 | 内容 |
|------|------|
| 源码位置 | `component.ts:handleEditorInput` freeform 有文本 Enter 分支 `state.selectedIndex = null` |
| 处理 | **保持**（draftText 迁移不影响此行，但它与 editorText 在同一分支，refactor 时易漏） |
| 冲突 | 无 |

### SF-2 [K]：requirements UC-3 方向键措辞修正

对应 MISSING-3。UC-3 主流程第 2 步改为：「按 ←/→ 切到 Q2（**现状：freeform 模式下方向键泄漏成文本，是本次修复的 bug；修复后方向键在编辑器内 no-op，用户需 Esc 先退出编辑器才能切 tab**）」。

### SF-3 [K]：system-architecture §1 Tab 消费状态修正

对应 MISMATCH-1。搭便车改造表「handleSubmitTabInput 的 Tab 消费优先级确认」状态从「候选（⑤运行验证）」改为「已实现保持现状（C-NEW-3 覆盖）」。

---

## 附：审查范围说明

本次审查基于源码独立重建，未读初稿前完成认知帧。重建覆盖：Actor/用例/数据流（需求层）、模型/边界/状态机（架构层）。diff 聚焦 reviewer 指定的四个核查点：

1. **handleEditorInput 里 editorText 在 freeform 进出时的预填/清空时机** → 发现 MISSING-1（comment 预填漏登）+ MISSING-2（selectedIndex 清空漏登）
2. **handleSubmitTabInput 的 Tab 键消费** → 发现 MISMATCH-1（已实现被标候选）
3. **_resolved 守卫在 handleInput 和 cancel 两处的语义** → 初稿 BC-6 正确登记，无 gap
4. **multi-select 的 selectedIndices / freeTextValue / confirmed 三者不变式关系** → 初稿通过 D-2/BC-4 间接覆盖，但 confirmed 重置的三处维护点（toggleIndex/freeform 空 Enter/单选 Enter 回改）只在 BC-4 登记了一处，建议补全（已隐含在 SF-1 上下文，不单独列 must_fix）

decisions.md D-001~D-004 均 status=confirmed，未重报。
