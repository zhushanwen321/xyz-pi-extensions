---
verdict: changes_requested
reviewer: redteam (反过度设计路)
mode: mid-plan review (Step 1 认知帧审查 + deletion test)
reviewed:
  - requirements.md
  - system-architecture.md
  - decisions.md (D-001~D-004, 全部 confirmed)
  - extensions/ask-user/src/component.ts (现状源码)
  - @mariozechner/pi-tui dist/keys.js (SDK 真实实现)
---

# 红队审查：ask-user 键码泄漏修复 + 架构重构

## Verdict

**CHANGES_REQUESTED**

核心结论：本次设计在一个**真实的、复现成本极低的 bug**（编辑器内方向键泄漏 `[A/B/C/D`）上，叠加了三层架构野心（parseKey 白名单 + draftText 状态迁移 + handleInput 拆分 + UC-4 提示行），其中**至少两项是过度设计**，且最严重的一项（自建 parseKey + KeyPressedEvent 判别联合）是在**无视 SDK 已提供等价公共 API** 的情况下设计的。

Bug 本身的根因诊断正确：编辑器 printable 分支在 `matchesKey(escape/enter/backspace)` 全部不命中后，把 `\x1b[C`（右箭头）逐字符灌进 `for (const c of cleaned)`，`\x1b` 被 `c >= " "` 滤掉，但 `[` 和 `C` 残留。修复这个只需在 printable 分支前加一道 special-key 拦截。

但 D-001 把「最小拦截」升级为「架构重构」是用户已拍板（confirmed_by: ask_user），按账本纪律不重报为 gap。以下只对**已确认决策的过度设计面**和**未被账本覆盖的新增设计元素**做 [REVISIT] 与 must_fix。

---

## must_fix（过度设计项）

### MF-1 [过度设计] [REVISIT of D-001/D-002]：自建 parseKey + KeyPressedEvent 判别联合，复造了 SDK 已有的 `parseKey` 轮子

**新证据（账本决策时未知）：** `@mariozechner/pi-tui` 已导出公共函数 `parseKey(data: string): string | undefined`（`dist/keys.d.ts:166`，实现见 `dist/keys.js:999`）。该函数：

- 已覆盖全部 special key（up/down/left/right/home/end/delete/insert/pageUp/pageDown/f1-f12）
- 已覆盖 modifier 组合（alt+x / ctrl+shift+arrow / alt+enter / alt+backspace / ctrl+alt+letter 等）—— 即 D-002 要求的全部范围
- 对未识别输入返回 `undefined`
- 已封装 legacy / Kitty / modifyOtherKeys 三套终端协议差异
- 对 bare printable（单字符 code 32-126）返回该字符本身

system-architecture.md §6 和 §7 设计的「新建 `parse-key.ts`（~60 LOC）+ `KeyPressedEvent` 判别联合（`{kind:"printable",text}` | `{kind:"special",keyId}`）」与 SDK 的 `parseKey` 功能几乎完全重叠。D-001 的 rationale「根因是缺失解析层」成立，但**解析层 SDK 已经有了**，缺的只是 ask-user 侧调用它。

**Deletion test：** 删掉 `parse-key.ts` 和 `KeyPressedEvent` 联合，改为：

```ts
// component.ts handleEditorInput 开头
const keyId = parseKey(data);          // SDK 公共 API，已含 modifier
if (keyId !== undefined) {
  // 命中任意已知键（special + modifier 组合 + bare printable 单字符）
  // 编辑器语义：escape/enter/backspace 各自有分支，其余 special 全 no-op
  if (matchesKey(data, "escape")) { ... }
  else if (matchesKey(data, "enter")) { ... }
  else if (matchesKey(data, "backspace")) { ... }
  else { return; }  // ← 方向键/功能键/modifier 组合键全部在此坍缩为 no-op
  return;
}
// keyId === undefined：未识别的多字符 chunk（粘贴），走 printable 提取
const cleaned = data.replace(/\x1b\[200~|\x1b\[201~/g, "");
for (const c of cleaned) { if (c >= " ") this.editorText += c; }
```

复杂度坍缩：删掉 1 个新文件（~60 LOC）+ 删掉 1 个判别联合类型 + 删掉 1 套独立单测。**Bug 仍修复，且 modifier 覆盖范围不减反增**（SDK 的 modifier 覆盖比手写枚举更全）。

**比例性质疑：** 一个 60 LOC 的纯函数 + 判别联合 + 独立单测，用来替代「调一次 SDK 函数 + 一个 if」。这是教科书级的过度抽象——为了「架构归位」新建一个层，而该层 SDK 已提供。

**类型标注：** 过度设计（红队专属）。账本里 D-001/D-002 是 `confirmed`，但决策时显然未知 SDK 已有 `parseKey`，属于**基于错误前提的确认**，故标 [REVISIT] 并要求走 ask_user 重新确认。

**建议：** 改为直接 `import { parseKey } from "@mariozechner/pi-tui"`，删掉自建 parse-key.ts 和 KeyPressedEvent。若坚持要本地封装，须在 decisions.md 补一条新决策说明「为何不复用 SDK 的 parseKey」（如返回值语义不满足、需要判别联合等），并附具体不满足点。

---

### MF-2 [过度设计]：UC-4 编辑器操作提示行（G4）属 YAGNI

**Deletion test：** 删掉 UC-4 + G4 + F4 + AC-4.1/4.2 + C-HINT-1。Bug 修复（方向键 no-op）与 draftText 迁移均不受影响。复杂度坍缩：少一个渲染分支、少一个 AC、少一个测试用例。

**必要性质疑：** requirements.md 自己在 UC-4 主流程写道「用户理解编辑器是 append-only，不会困惑方向键无效」。但修复后方向键是 **no-op**（静默不响应），不是「报错」。用户按方向键没反应 = 跟在任何输入框按错键一样，这是终端 TUI 的默认心智模型，不构成「困惑」。提示行解决的是一个**未被证据支撑的 UX 问题**——没有任何用户反馈说「我不知道编辑器是 append-only」。

**比例性：** 一个 bug 修复 PR 顺手加 UX 提示行，属于「修 bug 时顺手改产品」。CLAUDE.md 全局规则明确：「不加推测性功能——未来可能需要的，等未来再说」。提示行是推测性 UX 增强，应独立成 feature。

**类型标注：** 过度设计（红队专属）。此项未被账本决策覆盖（D-001~D-004 均未提 UC-4），可直接标 must_fix，无需走 REVISIT。

**建议：** 从本次范围移除 UC-4/G4/F4/AC-4.1/4.2/C-HINT-1。如需提示行，另开 feature。

---

## should_fix

### SF-1 [REVISIT of D-004]：handleInput 拆分是搭便车，比例性边界

**事实核查：** 现状 `handleInput` 含注释空行 101 行，**纯代码行 75 行**；`handleEditorInput` 纯代码 61 行。CLAUDE.md 函数行数上限是「不超过 80 行」——75 行确实踩边缘但**未超**。

**Deletion test：** 不拆 handleInput，bug 仍修复（special-key 拦截加在 handleEditorInput 内即可）。拆分是**纯架构整洁**收益，无行为收益。

**判定：** D-004 已 confirmed，不强制回退。但标注：这是「修 bug 时顺手重构」的典型，改动面（抽 handleOptionsInput + 改三个调用点 + 改测试）与 bug 修复无直接因果。若 review 时间紧张，可推迟到独立 refactor PR。不阻断，但 should_fix 级提醒：**拆分必须保证 181 个现有测试全绿**，任何因拆分引入的行为差异都说明拆分越界。

**类型标注：** D-可逆（账本 confirmed，但可降级为「本次不拆，后续 refactor」）。

### SF-2 [过度设计]：反模式检查 AC-1~AC-4 grep 验收清单偏重

**Deletion test：** 删掉 AC-1~AC-4，保留行为测试（C-ARROW-* / C-KEYMAP-* / C-PASTE-*）。Bug 是否仍被验收？是——行为测试直接断言 editorText 无残留，比 grep 源码结构更强。

**比例性：** 4 条 grep 脚本验收（「无散调 matchesKey」「无组件级 editorText」「parse-key.ts 存在」「handleInput ≤40 行」）是在**锁死实现方式**而非锁死行为。若 MF-1 采纳（复用 SDK parseKey，不自建 parse-key.ts），AC-3 直接失效；若 SF-1 不拆 handleInput，AC-4 失效。grep 清单与具体实现强耦合，违反「验收应面向行为而非实现」。

**类型标注：** 过度设计（红队专属）。建议：保留行为级 AC（C-ARROW / C-KEYMAP / C-PASTE / C-DRAFT），删掉实现级 grep AC-1~4，或降级为「推荐检查」非阻断。

### SF-3 [K]：modifier 组合键覆盖（D-002）的真实复现路径未在 requirements 举证

**核查：** D-002 rationale 是「matchesKey 已支持 modifier；不覆盖则 alt+x 仍泄漏 x」。但 requirements 未给出「用户在 ask-user 编辑器里按 alt+x 导致 x 泄漏」的**实际复现**，只在 UC-2 替代流程假设。D-003 标注「用户确认 Q2 必须覆盖，间接说明按潜在风险处理」——即用户自己也没复现，是按潜在风险决策的。

**SDK 证据：** pi-tui `parseKey` 对 `alt+x`（`\x1bx`）返回 `"alt+x"`（keys.js:1063-1068 legacy alt+letter 分支）。所以**只要采纳 MF-1（复用 SDK parseKey），modifier 覆盖自动获得**，D-002 的争议性随 MF-1 坍缩。若不采纳 MF-1，则 D-002 的组合枚举确实有爆炸风险（18 个 special × 4 modifier × 3 组合 = 上百种），但那是自建 parseKey 的自找麻烦。

**类型标注：** K（知识缺口，但随 MF-1 解决而消解）。不单独阻断。

---

## 保留理由（哪些删不得）

### 保留-1：方向键/功能键 no-op 拦截（核心修复）删不得

删掉 special-key 拦截，bug 立即回归：`\x1b[C` 的 `[` 和 `C` 进 printable 分支。这是本次存在的全部理由，不可删。**但实现方式可坍缩**（见 MF-1：用 SDK parseKey 替代自建层）。

### 保留-2：bracketed paste 标记剥离（BC-1）删不得

`data.replace(/\x1b\[200~|\x1b\[201~/g, "")` 删掉后，启用 bracketed paste 的终端粘贴时 `[200~`/`[201~` 残留。这是现有行为（BC-1 已标「保持」），不可退化。

### 保留-3：多字符粘贴按 code point 迭代（BC-2）删不得

`for (const c of cleaned)` 的 code point 迭代是 emoji（代理对）正确捕获的前提。删掉改 `data[0]` 会丢 surrogate pair。现有测试 C-PASTE-2（emoji）会红。不可删。

### 保留-4：控制字符过滤 `c >= " "`（BC-3）删不得

删掉后 `\x1b` 等控制字符进 editorText。这是 printable 提取的最低守卫。不可删。

### 保留-5：draftText 迁移（D-001/G3）——有条件保留

**Deletion test：** 删掉 draftText 迁移，只修方向键泄漏。Bug 是否仍修复？**是**。editorText 单实例 + 进入编辑器时重赋值的「隐式不变式」在单 session 下行为正确（现状就是这么跑的，181 测试绿）。

**但保留理由成立：** system-architecture.md §10 D-2 论证了 draftText 是「把隐式持有变显式持有」，归属归位是长期合理（CLAUDE.md「状态必须存储在 session_start 重建的闭包变量或 ctx 中」——组件级 `private editorText` 在多 session 下确实违反隔离规范）。这不是过度设计，是**技术债偿还**，且改动面可控（component + view 签名 + 少量测试）。

**判定：** 保留，但**非阻断**——若 review 时间紧张，draftText 迁移可推迟到独立 PR，本次只做 bug 修复（MF-1 的 SDK parseKey 拦截）。长期方案优先，但不绑死在 bug 修复 PR 里。

**类型标注：** 保留（长期合理），但允许解耦交付。

---

## 汇总

| 项 | 类型 | 判定 | 动作 |
|----|------|------|------|
| MF-1 自建 parseKey + 判别联合 | 过度设计 [REVISIT D-001/D-002] | must_fix | 走 ask_user：复用 SDK `parseKey`，删 parse-key.ts + KeyPressedEvent |
| MF-2 UC-4 提示行 | 过度设计（YAGNI） | must_fix | 移出本次范围 |
| SF-1 handleInput 拆分 [REVISIT D-004] | D-可逆 | should_fix | 可推迟，不阻断；拆则保 181 测试全绿 |
| SF-2 grep 验收 AC-1~4 | 过度设计 | should_fix | 删实现级 grep，保留行为级 AC |
| SF-3 modifier 覆盖举证 [D-002] | K | should_fix | 随 MF-1 消解 |
| 保留-1~5 核心修复 + BC + draftText | 必要/长期合理 | 保留 | 不可删；draftText 允许解耦交付 |

**最小正确修复面（红队建议）：**
1. handleEditorInput 开头加 `const keyId = parseKey(data); if (keyId !== undefined && !matchesKey(data,"escape") && !matchesKey(data,"enter") && !matchesKey(data,"backspace")) return;`（4 行，复用 SDK）
2. 保留 BC-1/BC-2/BC-3 不动
3. 加 C-ARROW / C-KEYMAP 行为测试
4. draftText 迁移 + handleInput 拆分 + UC-4 提示行 → 全部移出，独立 PR

这样 bug 修复 PR 的 diff < 20 行，且 modifier 覆盖自动获得（SDK parseKey 已含）。
