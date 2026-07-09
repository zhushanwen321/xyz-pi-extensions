# 独立 Reviewer 复审 — code-architecture §6 test-matrix（禁读重建路）

> **方法**：独立从 §4 时序图 alt/else 分支 + nfr 回灌表 重建应有的测试用例集合，再与 §6 test-matrix 做 diff。
> **决策账本纪律**：D-001~D-008 confirmed，不当 gap 重报。D-005（复用 SDK parseKey）为既定决策，本 review 不重开。
> **实测补强**：除静态重建外，本 reviewer 实跑了 `@mariozechner/pi-tui` 的 `parseKey` 验证返回语义（见下文 F-1 证据），用于交叉证伪骨架的单字符判定逻辑。

## Verdict

**CHANGES_REQUESTED**

存在 1 个 F（缺陷）级发现（F-1：空格字符在 parseKey 路由下被 no-op 丢弃，是回归 bug，骨架代码与 test-matrix 双重遗漏）+ 2 个 MISSING（BC-4b 无测试、语义键 escape/enter/backspace 无专项负向测试）。F-1 必须在 dev Wave 前修正骨架逻辑与 test-matrix，否则 #1 修复会引入新的输入丢失。

test-matrix 整体结构合理（UC 归类清晰、测试层标注正确、parallelGroup/dependsOn 完备），无 PHANTOM、无 MISMATCH。主要缺陷集中在「parseKey 四态路由」的边界态（空格态）未被 test-matrix 覆盖，以及 BC-4b 的验收标准（issues.md AC-2.3）未落地为用例。

---

## 重建结果（从 §4 时序图 alt/else + nfr 回灌表独立重建）

### 时序图 1（功能 1：方向键 parseKey 拦截）应有的用例

时序图 1 的 alt/else 有 4 个分支态：

| 分支态 | parseKey 返回 | 应有用例 |
|--------|--------------|---------|
| (a) 编辑器语义键 escape/enter/backspace | `"escape"`/`"enter"`/`"backspace"` | 每键各需正向测试（escape 走 BC-5 保留/freeform discard；enter 走 BC-4/BC-4b/BC-4c/comment save；backspace 删末尾） |
| (b) 单字符 printable（code 32-126） | 该字符本身（如 `"a"`） | 单字符追加测试（C-PASTE-5 可复用，但需显式断言 parseKey 路径） |
| (c) 其他 special key（方向键/功能键/modifier 组合） | `"right"`/`"f1"`/`"ctrl+shift+right"` 等 | no-op 集合遍历（C-KEYMAP-*）+ modifier 矩阵（C-KEYMAP-MOD） |
| (d) undefined | undefined | 多字符粘贴（时序图 2 覆盖） |

**独立重建额外发现**：parseKey 对 `" "`（空格 U+0020）返回 `"space"`（非空格字符，实测见 F-1）。空格在 code 32-126 区间但 parseKey 不返回单字符——这是「单字符 printable」分支态的一个边界子态，test-matrix 未覆盖。

### 时序图 2（功能 2：多字符粘贴）应有的用例

| alt/else 分支 | 应有用例 |
|--------------|---------|
| parseKey undefined → bracketed paste 剥离 + code point 迭代 + c>=" " 过滤 | C-PASTE-1（多字符完整捕获） |
| 含 emoji（代理对） | C-PASTE-2（emoji 保留） |
| 纯控制字符 → changed=false no-op | C-PASTE-3（控制字符过滤）+ C-PASTE-4（空输入 no-op） |
| 单字符 backward-compat | C-PASTE-5（"x" 追加） |
| bracketed paste 序列 | C-PASTE-6/7 |

时序图 2 的用例覆盖完整。

### 时序图 3（功能 3：draftText 分流预填）应有的用例

| alt/else 分支 | 应有用例 |
|--------------|---------|
| onOther + enter → freeform 预填 freeTextValue | C-DRAFT-1（Q1 freeform 草稿 + 切走回来） |
| q.allowComment → comment 预填 commentValue（BC-4c） | C-BC4C |
| Q1/Q3 各自草稿独立 | C-DRAFT-2 |
| **freeform 有文本 Enter 清 selectedIndex=null（BC-4b）** | **应有用例（issues.md AC-2.3 标注），test-matrix 无** |
| !allowComment → advance | 现有 180 测试覆盖（C-REG-ALL） |

### NFR 回灌表映射（10 条缓解项）

回灌表 9 条「代码测试」+ 1 条「骨架约束」。逐条核对落地用例：

| 回灌项 | 落地用例（test-matrix） | 状态 |
|--------|----------------------|------|
| BC-3 控制字符过滤 | C-PASTE-1~7 | ✅ |
| parseKey 命中 special no-op | C-ARROW-1/2 | ✅ |
| no-op 集合遍历 | AC-1.3（C-KEYMAP-*） | ✅ |
| modifier 矩阵 18 用例 | AC-1.4（C-KEYMAP-MOD） | ✅ |
| 单字符 printable 追加 | C-PASTE-1（注：实际是 C-PASTE-5） | ⚠️ 引用错位（C-PASTE-1 是多字符，C-PASTE-5 才是单字符） |
| BC-1/BC-2 bracketed paste | C-PASTE-2~7 | ✅ |
| draftText 初始化 "" | 骨架约束（types.ts） | ✅ |
| AC-2.5 grep 无 this.editorText | AC-2.5 | ✅ |
| 分流预填 freeform/comment | AC-2.1/2.2 + AC-2.4 | ✅ |
| handleInput ≤ 40 行 | AC-3.1 | ✅ |

---

## diff

### MISSING（时序图 alt/else 有但 test-matrix 漏的用例）

#### MISSING-1 [F-可逆，缺陷级] 空格字符输入在 parseKey 路由下被 no-op 丢弃

**类型：F（缺陷）— 骨架逻辑 + test-matrix 双重遗漏**

**证据（实测）**：`parseKey(" ")` 返回 `"space"`（length=5），不是空格字符 `" "`。

```
$ node -e 'const {parseKey}=require("@mariozekner/pi-tui");console.log(JSON.stringify(parseKey(" ")))'
"space"
```

**骨架代码路径（code-skeleton/component.ts:289-292）**：

```typescript
const keyId = parseKey(data);
if (keyId !== undefined) {
  ...
  if (matchesKey(data, "escape")) { ... }
  if (matchesKey(data, "enter")) { ... }
  if (matchesKey(data, "backspace")) { ... }
  if (keyId.length === 1 && keyId >= " " && keyId <= "~") {
    state.draftText += keyId;  // ← 空格不命中（keyId="space" length=5）
    return;
  }
  return;  // ← 空格落入此处，no-op（不追加！）
}
```

空格输入走 `parseKey(" ")` → `"space"`（非 undefined）→ 进 if 块 → escape/enter/backspace 都不匹配 → `keyId.length === 1` 为 false → **return（no-op）**。空格不进 draftText。

**回归影响**：
- 现状（无 parseKey）：空格走 printable 遍历，`" " >= " "` 为 true，追加进 editorText。用户能输入带空格的文本（如 "hello world" 中的空格）。
- 骨架（有 parseKey）：单字符输入时，空格被 parseKey 拦截为 "space"，走 no-op。**用户无法在 freeform/comment 编辑器输入空格**。
- C-PASTE-1 测试用 "hello world"（含空格）作为多字符粘贴 chunk，parseKey 返回 undefined（走 printable 遍历，空格保留），**该测试不会暴露此 bug**（因为多字符 chunk 走另一分支）。只有单字符空格输入才暴露。

**与 CLAUDE.md 规范的关系**：CLAUDE.md「导航键用 matchesKey」规范针对的是功能键（方向键/Enter/Esc），空格在编辑器语境是 printable 字符（append-only 编辑器要追加），不是导航键。骨架机械套用 `keyId.length === 1` 守卫遗漏了 parseKey 对空格的特判。

**修复方向（dev Wave 前必须定）**：
- 方案 1（推荐）：在单字符 printable 判定前，先判 `matchesKey(data, "space")` → `state.draftText += " "`。
- 方案 2：把单字符 printable 判定改为 `keyId.length === 1 && keyId >= " " && keyId <= "~"` 之外，加 OR 条件 `|| matchesKey(data, "space")`。
- 方案 3：用 `data.length === 1 && data >= " " && data <= "~"`（直接判原始 data，绕过 parseKey 的 space 特判）—— 但这违反「parseKey 先拦截」的结构。

**test-matrix 补漏**：UC-2 表需新增 `C-KEYMAP-SPACE`（或 UC-1 表的单字符细分），断言单字符空格输入进 freeform/comment 编辑器后 draftText 含空格。该用例应标 dependsOn=#1，parallelGroup=key-leak。

**判定**：F-1 是阻塞项。骨架逻辑与 test-matrix 必须在 dev Wave 前修正，否则 #1 的修复（防方向键泄漏）会引入空格输入丢失的新回归。

---

#### MISSING-2 [F-可逆] BC-4b（freeform 有文本 Enter 清 selectedIndex=null）无测试用例

**类型：F（缺陷）— issues.md AC-2.3 标注了验收标准，但 test-matrix 未落地为用例**

**证据**：
- issues.md #2 AC-2.3：`[回归]（trace: §12 BC-4b）: freeform 有文本 Enter 后 selectedIndex=null（不残留）`，状态未勾。
- §6 test-matrix UC-3 表只有 C-DRAFT-1、C-DRAFT-2、C-BC4C 三条，无 BC-4b 对应用例。
- 现状代码（src/component.ts handleEditorInput enter 分支 freeform 有文本）：`state.selectedIndex = null` 确实存在，但无测试守护。
- §6「覆盖完整性自检」第 3 条声称「UC-3 正常 + 边界 + 回归齐全」，但 BC-4b 未落地。

**回归风险**：draftText 迁移（#2）改 `this.editorText` → `state.draftText` 时，enter 分支的 `state.selectedIndex = null` 这行可能被误删或误改（它紧邻 editorText 重置行）。无测试守护 = 无回归防线。

**修复**：UC-3 表新增 `C-BC4B`，场景「单选先选 option 0（selectedIndex=0）→ 进 Other freeform 输文本 → Enter」，断言 `state.selectedIndex === null`。dependsOn=#2，parallelGroup=draft。

---

#### MISSING-3 [D-可逆] 编辑器语义键 escape/enter/backspace 无专项「路由命中」测试

**类型：D（设计补强）— 时序图 1 的 else 分支（keyId === escape/enter/backspace）无专项测试**

**分析**：时序图 1 有 else 分支「keyId === escape/enter/backspace → 走编辑器语义键分支」。test-matrix 的 C-ARROW/C-KEYMAP 全是 no-op 负向用例，C-PASTE 是 printable 正向，C-DRAFT/C-BC4C 是分流预填。**没有一条用例显式验证「parseKey 返回 escape/enter/backspace 时走语义键分支（而非 no-op）」**。

现状的 C-27（editor accepts printable）、C-28（Backspace deletes）、C-29（Enter saves）、C-31（Esc returns）是行为测试，但它们验证的是「最终行为正确」，不验证「parseKey 路由命中正确分支」。如果 parseKey 路由的 escape/enter/backspace 判定顺序出错（例如 backspace 被误判为先命中 no-op），行为测试可能因其他路径巧合通过。

**严重度**：中。现有行为测试提供一定兜底，但 parseKey 路由是 #1 的核心改动，应有路由级专项测试。

**修复建议**：UC-2 表可新增 `C-KEYMAP-SEMANTIC`（或在 C-KEYMAP-* 系列补注），明确断言 escape/enter/backspace 在编辑器内**不**走 no-op（即 state 有变更或 mode 有切换）。非阻塞，should_fix。

---

### PHANTOM（test-matrix 有但时序图不覆盖的用例）

**无。**

test-matrix 所有用例都能追溯到 §4 时序图或 nfr 回灌表：
- C-ARROW-1/2 ← 时序图 1（方向键 no-op）
- C-KEYMAP-* ← 时序图 1（special key no-op）+ nfr AC-1.3
- C-KEYMAP-MOD ← 时序图 1（modifier 组合 no-op）+ nfr AC-1.4
- C-PASTE-1~7 ← 时序图 2（多字符粘贴）
- C-DRAFT-1/2 ← 时序图 3（分流预填）
- C-BC4C ← 时序图 3（comment 回改预填，BC-4c）
- C-HINT-1/2 ← UC-4（#4 提示行，时序图未画但 issues #4 + nfr 覆盖）
- C-REG-ALL ← #3 拆分回归（纯移动，时序图未画但 issues #3 覆盖）

C-HINT 和 C-REG-ALL 严格说不在 §4 三张时序图的 alt/else 内，但它们对应 issues #3/#4，且 nfr 回灌表未遗漏，不算 PHANTOM（是 test-matrix 对 issues 的合理扩展覆盖）。

---

### MISMATCH（测试层标注错误）

**无。**

逐条核对测试层标注：
- C-ARROW/C-KEYMAP/C-KEYMAP-MOD/C-PASTE/C-DRAFT/C-BC4C/C-HINT 全标 `unit` — 正确。ask-user 是进程内 TUI 组件，mock pi-tui 纯函数即可验全部逻辑，无集成环境依赖（无 DB/网络/跨进程），不需要 integration/e2e 层。
- C-REG-ALL 标 `unit` — 正确（现有 component.test.ts 本就是 unit 测试）。

「全 unit」的判断与 nfr 回灌表「无 perf-chaos 项」一致，测试层选择合理。

---

## 重点核查项逐条结论

| 核查项 | 结论 |
|--------|------|
| parseKey 四态路由每态有测试覆盖 | ⚠️ **部分**。语义键态/单字符 printable 态/special no-op 态/undefined 态有覆盖，但**空格子态（parseKey(" ")="space"）漏**（F-1） |
| 单字符 printable 追加（parseKey("a")="a"）有专门测试 | ✅ C-PASTE-5（"x" → draftText === "x"）足够，且 nfr 回灌表显式提及。但回灌表引用写作「C-PASTE-1（单字符输入）」是笔误（C-PASTE-1 是多字符，C-PASTE-5 才是单字符） |
| modifier 采样矩阵 18 用例完整无重叠 | ✅ 4×4（ctrl/alt/shift/super × up/down/left/right）+ 2（ctrl+shift+up/down）= 18，无重叠。实测 parseKey 对 18 个编码全返回非 undefined（命中 special），走 no-op 符合设计 |
| 分流预填 freeform/comment 两入口各有测试 | ✅ freeform 入口（C-DRAFT-1）、comment 入口（C-BC4C）各有用例 |
| BC-4b（freeform Enter 清 selectedIndex）有测试 | ❌ **无**。issues.md AC-2.3 标注但 test-matrix 漏（MISSING-2） |

---

## must_fix（阻塞 dev Wave）

### must_fix-1 [对应 F-1]：空格输入丢失 — 骨架逻辑 + test-matrix 双修

**问题**：`parseKey(" ")` 返回 `"space"`（实测），骨架 `keyId.length === 1` 守卫不命中，空格走 no-op 被丢弃。这是 #1 修复引入的新回归（现状空格能输入）。

**必做**：
1. **骨架修正**（code-skeleton/component.ts handleEditorInput）：在单字符 printable 判定分支前，增加 `matchesKey(data, "space")` → `state.draftText += " "` 的处理；或在单字符判定中 OR 上 space 命中。修正后骨架需重跑 `npx tsc --noEmit -p tsconfig.json` 验编译。
2. **test-matrix 补漏**（code-architecture.md §6 UC-2 表）：新增 `C-KEYMAP-SPACE`（unit，场景：freeform 编辑器单字符空格输入，断言 draftText 含空格），dependsOn=#1，parallelGroup=key-leak。
3. **nfr 回灌表补条**（non-functional-design.md 回灌表）：新增「单字符空格输入仍追加（parseKey space 特判）」缓解项，落地为 C-KEYMAP-SPACE，验收方式=代码测试。

**验证**：修正后空格在编辑器内可输入，C-PASTE-1（多字符含空格）与新增 C-KEYMAP-SPACE（单字符空格）双路径绿。

---

### must_fix-2 [对应 MISSING-2]：BC-4b 补测试用例

**问题**：issues.md AC-2.3（BC-4b: freeform 有文本 Enter 清 selectedIndex=null）在 test-matrix 无对应用例。

**必做**：code-architecture.md §6 UC-3 表新增 `C-BC4B`（unit，场景：单选先选 option 0 → 进 Other freeform 输文本 → Enter，断言 state.selectedIndex === null），dependsOn=#2，parallelGroup=draft。

**验证**：BC-4b 回归有测试守护，#2 迁移时误删 selectedIndex=null 行会被测试捕获。

---

## should_fix（非阻塞，建议 dev/test Wave 处理）

### should_fix-1 [对应 MISSING-3]：编辑器语义键路由命中专项测试

**建议**：UC-2 表新增 `C-KEYMAP-SEMANTIC` 或在 C-KEYMAP-* 系列补注，显式断言 escape/enter/backspace 在编辑器内不走 no-op（state 有变更/mode 有切换）。验证 parseKey 路由的语义键分支判定顺序正确。

**理由**：parseKey 路由是 #1 核心改动，现有行为测试（C-27/28/29/31）验证最终行为但不验证路由命中。路由级专项测试能捕获「判定顺序错位」类 bug。

---

### should_fix-2：nfr 回灌表「单字符 printable 追加」引用笔误

**问题**：nfr 回灌表第 5 条「单字符 printable 输入仍正确追加」落地写作「C-PASTE-1（单字符输入）」，但 C-PASTE-1 是多字符 chunk（"hello world"），单字符是 C-PASTE-5。

**建议**：non-functional-design.md 回灌表该条落地列改为「C-PASTE-5（单字符输入）」。纯文档修正，不影响测试覆盖（C-PASTE-5 确实存在且覆盖单字符）。

---

### should_fix-3：C-KEYMAP-MOD 编码基准建议在 fixtures.ts 固化

**建议**：C-KEYMAP-MOD 的 18 用例依赖具体的 modifier 编码序列（如 `\x1b[1;5A` = ctrl+up）。本 reviewer 实测确认这些编码 parseKey 全部命中 special（见重建结果），但不同终端协议（legacy/Kitty/modifyOtherKeys）编码可能不同。建议 fixtures.ts 显式列出 18 个编码常量并注释「已实测 parseKey 命中」，避免 dev 时编码选错导致用例变 no-op 误判。

**理由**：modifier 编码是测试可靠性的隐含前提，固化后未来 SDK 升级时易于回归验证。

---

## 附：parseKey 实测返回语义（本 reviewer 独立验证，用于交叉证伪）

| 输入 | parseKey 返回 | 路由态 | test-matrix 覆盖 |
|------|--------------|--------|-----------------|
| `"a"` / `"A"` / `"1"` / `"~"` / `"!"` | 该字符本身 | 单字符 printable | C-PASTE-5 ✅ |
| `" "`（空格） | `"space"` | **special（非单字符！）** | **❌ 漏（F-1）** |
| `"\t"`（tab） | `"tab"` | special | n/a（编辑器不消费 tab） |
| `"\x1b[C"` 等 | `"right"` 等 | special no-op | C-KEYMAP-* ✅ |
| `"\x1b[1;5C"` 等 modifier | `"ctrl+right"` 等 | special no-op | C-KEYMAP-MOD ✅ |
| `"hello"` / `""` / bracketed paste | `undefined` | printable 提取 | C-PASTE-1~7 ✅ |
| `"\x1b"` | `"escape"` | 语义键 | 行为测试（C-31）⚠️ 路由级缺（MISSING-3） |
| `"\x7f"` / `"\x08"` | `"backspace"` | 语义键 | 行为测试（C-28）⚠️ 路由级缺 |
| `"\r"` / `"\n"` | （未实测，推断 `"enter"`） | 语义键 | 行为测试（C-29/30）⚠️ 路由级缺 |

> 实测脚本：`node -e 'const {parseKey}=require("@mariozekner/pi-tui"); console.log(JSON.stringify(parseKey(" ")))'` 于 `@mariozekner/pi-tui`（pi-tui dist/keys.js）。

---

## 总结

test-matrix 的骨架结构（UC 归类、测试层、parallelGroup、dependsOn）质量高，无 PHANTOM/MISMATCH。主要缺陷是 **parseKey 四态路由的边界态（空格）未被覆盖**，这是 #1 核心改动的盲区——空格在 parseKey 下返回 "space" 而非单字符，骨架的 length===1 守卫会把它当 no-op 丢弃，引入新的输入丢失回归。配合 BC-4b 测试缺失（issues AC 标注但未落地），共 2 个 must_fix。

修正 must_fix-1（骨架 + test-matrix + nfr 三处）+ must_fix-2（test-matrix 补 C-BC4B）后，test-matrix 可流转至 dev Wave。should_fix 三项建议在 dev/test Wave 顺手处理。
