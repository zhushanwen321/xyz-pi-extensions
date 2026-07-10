---
reviewer: independent-arch-reviewer
target: system-architecture.md (mid-plan Step 2)
mode: refactor
verdict: CHANGES_REQUESTED
---

## Verdict

**CHANGES_REQUESTED** — 架构方向正确（parseKey 白名单 + draftText 归位 + handleInput 拆分，三项均有根因支撑），但有 1 个 must_fix（D-2 预填公式行为不等价，会导致真实回改场景污染 freeform 编辑器）、2 个 should_fix（§6 分层图术语失真、AC-4 grep 命令对 public 方法无法匹配）、若干 nit。无 D-001~D-004 需推翻项。

---

## must_fix

### MF-1 [F] §10 D-2 预填公式 `state.draftText = state.freeTextValue ?? state.commentValue ?? ""` 行为不等价

D-2 声称迁移后「与现状等价」，但合二为一的公式引入了现有代码没有的 fallback 链，在真实回改场景下会污染 freeform 编辑器。

**现状（component.ts，严格分流）：**
- L258 进入 freeform：`this.editorText = state.freeTextValue ?? ""`
- L460 进入 comment：`this.editorText = state.commentValue ?? ""`
- 两处入口互斥（同一次 handleInput 不会同时进 freeform 和 comment），各自只读对应的 value。

**D-2 公式的缺陷：** 进入 freeform 入口时，若 `freeTextValue === null`（已被 L283 单选 Enter / L362 空 Enter 清空），公式 fallback 到 `commentValue`。当用户在回改流程中已经填过 comment（`commentValue !== null`）后再重开 freeform 编辑器，**现有逻辑预填 `""`，D-2 公式预填 commentValue 的旧内容** —— 行为不等价。

**可达场景（已验证）：**
1. 用户在普通选项 Enter → afterConfirm 进 comment（L455-461）
2. 用户填 comment → Enter 保存（commentValue = "note"，L375）→ advance
3. 用户 Esc 回退到该 tab（escBackOrConfirm）
4. 用户 ↓ 到 Other 行 Enter → 进 freeform（L256-258）
5. 此时 freeTextValue 可能为 null（步骤 1 选普通选项时 L283 清了），commentValue = "note"
6. **现状**：editorText = ""（正确，freeform 是全新输入）
7. **D-2 公式**：draftText = "note"（错误，把评论内容预填进答案编辑器）

**修复方向（二选一，均保留 D-2 的归属归位意图）：**
- (a) 预填逻辑保持两处分流，分别赋值（`freeform` 入口 `draftText = freeTextValue ?? ""`，`comment` 入口 `draftText = commentValue ?? ""`）——与现状严格等价，推荐。
- (b) 若坚持单一赋值点，公式改为带 mode 判定：`draftText = mode === "freeform" ? (freeTextValue ?? "") : (commentValue ?? "")`。

D-2 的核心价值（editorText 从组件级单实例迁到 state.draftText）不受影响，只是预填公式要修正。这不是推翻 D-002（那是 modifier 覆盖决策），是修正 §10 D-2 的实现公式。

---

## should_fix

### SF-1 [F] §6 分层图把 parse-key.ts 画成独立「Parse 层」过度拔高其架构地位

parse-key.ts 是**纯函数模块**，不是「层」。

**判定依据（证伪三连）：**
- **Delete**：把 parseKey 内联回 component 作为 private 方法，复杂度会部分坍缩（损失独立单测便利、终端协议变化耦合进 component.ts）。边界有存在价值，但价值是**模块卫生**（可测性 + 变化轴隔离），非架构性。
- **Invert**：parseKey → matchesKey(pi-tui)，component → parseKey，单向不可反转。成立。
- **Move**：边界可滑动（component 私有方法 / 独立文件 / types.ts）。当前停靠点（独立纯函数文件）合理。

边界的存在合理（独立模块 + 可单测 + 变化轴隔离），但「层」(layer) 在架构语境里指有独立职责边界、单向依赖、可整体替换的计算分层。parseKey 是被 component 同步调用的纯函数，无独立运行态、无反转可能、无替换契约——它是 **Component 层内部的一个协作模块**，与 question-view.ts（纯渲染函数模块）同级。

**当前 §6 图暗示 parseKey 是与 Component 平级的层**，这会让下游 issues 拆分误以为 parse-key.ts 是独立交付单元、需要独立的接口契约设计。实际它就是 component 的一个被调用模块。

**修复建议：** §6 分层图把 parse-key.ts 收进 Component 层内部（作为 component 调用的纯函数模块标注），或在图下显式注明「Parse 层 = 纯函数模块，非可替换层；独立文件仅为可测性，非架构分层」。§7 模块划分表已正确表述（「纯函数模块」），与 §6 图自相矛盾，需对齐。

### SF-2 [F] §11 AC-4 的 awk 命令匹配模式错误，机器不可检查

AC-4 验收命令：
```
awk '/private handleInput/,/^	}/' extensions/ask-user/src/component.ts | wc -l
```

**两个 bug：**
1. `handleInput` 是 `Component` 接口的 public 方法（component.ts L188 `handleInput(data: string): void`，无 `private` 修饰符），重构后也不能改 private（pi-tui 的 `Component` 接口要求 public）。`/private handleInput/` 永远匹配 0 行，awk 输出 0，`0 ≤ 40` 恒真——**AC-4 形同虚设**。
2. 结束模式 `/^\t}/`（tab + `}`）依赖函数体用 tab 缩进且闭括号独占一行。重构后若 handleInput 内调用 handleOptionsInput，闭括号仍是 tab 缩进独占行，这部分尚可，但前提是起始模式能匹配。

**已验证：** 在当前 component.ts 上跑该命令返回 0（见审查日志）。

**修复建议：** 起始模式改为 `/^\thandleInput\(data/`（匹配行首 tab + `handleInput(data`），或更稳妥用 `sed -n '/^\thandleInput(data/,/^\t}/p'`。AC-4 的本意（handleInput ≤ 40 行纯路由）正确，只是 grep 写错。

### SF-3 [F] §11 AC-1 grep 逻辑在 component.ts 上语义失效

AC-1：`grep -n "matchesKey" component.ts | grep -v parseKey`

`grep -v parseKey` 的意图是「排除 parseKey 内部的合法调用」。但 AC-1 grep 的目标文件是 `component.ts`，而 parseKey 会在 `parse-key.ts`（不在 component.ts）。所以 `grep -v parseKey` 对 component.ts 的输出**不过滤任何东西**（component.ts 不含 "parseKey" 字面量，除非 component 调用 parseKey 时变量名也叫 parseKey——若如此则把合法调用也排除了）。

**实际效果：** 重构后 component.ts 里 handleEditorInput 调用 `parseKey(data)`，该行含 "parseKey" 字面量，会被 `grep -v parseKey` 排除（正确）；但 handleSubmitTabInput / handleOptionsInput 里若还残留 matchesKey 散调，AC-1 只检查 handleEditorInput 吗？AC-1 描述说「handleEditorInput 内不应再有」，但 grep 命令作用于整个 component.ts 文件，无法定位到 handleEditorInput 函数体内部。

**修复建议：** AC-1 应明确「编辑器输入路径」的 matchesKey 消除。两个方向：
- (a) 若目标是「handleEditorInput 内无 matchesKey」，用 awk/sed 定位到 handleEditorInput 函数体范围再 grep。
- (b) 若目标是「所有编辑器相关输入走 parseKey」（更符合 G2「消除散调」本意），则 component.ts 里应**零** matchesKey（除 import 行），grep 命令改为 `grep -c "matchesKey" component.ts` 期望 ≤ 1（仅 import）。注意 handleOptionsInput/handleSubmitTabInput 是否也走 parseKey 需在架构里明确——见下方 Q-1。

### SF-4 [K / 待澄清] parseKey 的适用范围：仅 freeform/comment 编辑器，还是全覆盖（options/submit 路径）？

§10 D-1 和 §11 AC-1 的语境都聚焦「编辑器内」（freeform/comment），但 G2 的目标是「消除散调 matchesKey」「新键种不再因某模式忘了处理而泄漏」。当前 component.ts 有 **19 处** matchesKey 散调，分布在 handleInput（options 分支：escape/right/left/up/down/enter/space）、handleSubmitTabInput（left/right/escape/tab/enter）、handleEditorInput（escape/enter/backspace）。

若 parseKey 只服务编辑器路径，options/submit 路径仍保留散调 matchesKey——这没解决 G2「新键种忘了处理」的根因（只是编辑器不泄漏了，options 路径未来加新键种仍可能漏）。但 options 路径当前不泄漏（方向键有处理、未识别键自然 no-op 不进文本），所以不泄漏不是问题，问题是「架构一致性」。

这是范围决策，不是错误。但架构文档没明确「parseKey 覆盖哪些路径」，会让 issues 拆分时范围摇摆。**建议 §7 或 §10 显式声明 parseKey 的覆盖范围**（仅编辑器 / 全模式），并与 AC-1 的验收口径对齐。若仅编辑器，需说明为何 options/submit 不纳入（理由：它们不持有自由文本 buffer，未识别键不泄漏）。

---

## nit

### N-1 [D-可逆] §4 KeyPressedEvent 不变式「printable.text 只含 ≥ U+0020 的 code point」与 BC-3 措辞需统一

§4 不变式写 `≥ U+0020`，BC-3 写 `c >= " "`。两者等价（空格 = U+0020），但 §10 D-1 又说「printable 提取仍保留 c >= 空格过滤控制字符」。三处措辞不统一（U+0020 / " " / 空格）。建议统一为 `code point >= U+0020`，避免下游实现时对「空格」是 ` ` 还是全角空格产生歧义。

### N-2 [F] §10 BC-1 与 D-1 的执行顺序描述存在潜在歧义

BC-1：bracketed paste 剥离「迁移到 parseKey 内，printable 提取前剥离」。
D-1：parseKey「先判 special key，不匹配的才进 printable 提取」。

两段没说清 **special 判定 vs bracketed paste 剥离** 的先后。实现者可能把「special 优先」理解成「special 阶段先消费 ESC 前缀字节」，导致 `\x1b[200~` 的 `\x1b` 在 special 阶段被处理掉、剩余 `[200~` 进 printable 残留。

**实际正确顺序（已分析，两者结果一致但需写明）：** matchesKey 对整个 `data` 字符串做布尔判定（`\x1b[200~hello\x1b[201~` 不是已知 special key → false），不消费字节；随后剥离 replace；最后 printable 提取。建议 BC-1 明确：「剥离 replace 在 special 判定之后、printable 提取之前执行；special 判定是纯布尔匹配，不消费字节」。否则 C-PASTE-6/C-PASTE-7 回归测试可能在实现顺序错误时仍通过（取决于 matchesKey 对 `\x1b[200~` 的实际返回值，本地无法验证 pi-tui 实现）。

### N-3 [F] §9 泳道图注释「editorText/draftText 不变」应统一为 draftText

泳道图 Note 写 `editorText/draftText 不变`，但迁移后字段名是 `draftText`（§3 统一语言、§4 模型）。保留 `editorText` 会让人误以为两个字段并存。改为 `draftText 不变`。

### N-4 [F] §4 模型不变式「draftText 非空 ⟺ 该问题编辑器有未提交草稿」过强

`⟺`（当且仅当）意味着 draftText 空时必无草稿、有草稿时 draftText 必非空。但进入编辑器预填空串时 draftText = ""（空），此刻编辑器已打开（有「未提交草稿」的潜在状态，只是内容为空）。用 `⟺` 会把「编辑器打开但空输入」判为违反不变式。建议改 `⟹`（draftText 非空 ⟹ 编辑器有未提交草稿），或细化表述。

---

## 交叉核查结论

| 核查项 | 结论 |
|--------|------|
| parse-key.ts 独立模块合理性 | ✅ 合理（纯函数 + 可单测 + 变化轴隔离），但非「层」（SF-1） |
| Port 清单「无真 port」降级理由 | ✅ 成立（pi-tui 纯函数 import 非 port，无跨系统边界，不引伪 port） |
| parseKey/routeInput/render 正交性 | ✅ 三轴正交（终端协议 / 交互模式 / 渲染样式），§7 归位正确 |
| KeyPressedEvent 判别联合设计 | ✅ 合理（kind 判别 + printable/special 二分，消费方不再猜字节流） |
| QuestionState 加 draftText 破坏不变式 | ⚠️ 不破坏现有不变式，但 §4 新不变式措辞过强（N-4） |
| BC-1~BC-7 行为契约登记 | ✅ 逐条登记完整，BC-7 变更标注与 requirements UC-2 一致 |
| BC-1 bracketed paste 跨 chunk | ✅ 无退化（C-PASTE-7 非真跨 chunk 拆分，requirements §8 已声明 out-of-scope） |
| D-2 预填逻辑等价性 | ❌ 不等价（MF-1） |
| AC-1~AC-4 机器可检查 | ⚠️ AC-2/AC-3 可检查，AC-1 语义失效（SF-3），AC-4 命令错误（SF-2） |

---

## 给 Step 3（issues 拆分）的输入修正建议

1. draftText 迁移 issue 必须用分流预填（MF-1），不能用 §10 D-2 的合二为一公式。
2. parse-key.ts issue 是「新建纯函数模块」（非「新建架构层」），交付边界与 question-view.ts 同级。
3. AC-1/AC-4 grep 验收脚本需在 issues 阶段修正命令后才能作为机器门（SF-2/SF-3）。
4. parseKey 覆盖范围（仅编辑器 / 全模式）需在 issues 前明确（SF-4），否则拆分时范围摇摆。
