---
verdict: APPROVED
reviewer: 红队（反过度设计路）
scope: mid-detail-plan（issues.md / non-functional-design.md / code-architecture.md / execution-plan.md / code-skeleton/）
date: 2026-07-09
---

# 红队评审报告 — ask-user 键码泄漏修复 + 路由重构（反过度设计路）

## Verdict: **APPROVED**

逐项做 deletion test 与比例性质疑后，核心设计站得住。**无 must_fix（过度设计项）**；3 项 should_fix（局部瘦身，不阻断）。5 项设计元素经 deletion test 判定为「删不得」（见末节）。

### 总体比例感

3 文件改动（component/types/question-view）+ ~30 测试 + 1 个 bug 修复 + 1 个归位重构 + 1 个行数修复 + 1 个 UX 提示。工作量与主题匹配。mid-detail-plan 的完整 deliverables（issues+nfr+code-arch+skeleton+exec-plan）是 CW tier 流程要求，非主题自身臃肿。

---

## 账本纪律澄清（先于正题）

任务描述称「D-001~D-008 status=confirmed」。**实测 decisions.md：D-001 status=`revisited`(superseded_by D-005)，D-002 status=`revisited`(superseded_by D-006)**，非 confirmed。D-003~D-008 为 confirmed。本报告据实处理：D-001/D-002 已被取代，无可重报；对 D-005/D-006（实际取代项）的红队质疑照常进行。

---

## must_fix（过度设计项）

**无。**

红队的本职是「找过度设计砍掉」。本轮逐项 deletion test，没有一项构成「砍掉后复杂度坍缩且 bug 仍修复」的过度设计。具体见下节「保留理由」与「should_fix」。

---

## should_fix（局部瘦身建议，不阻断 APPROVED）

### SF-1 [过度设计·轻微]：C-KEYMAP-MOD 18 用例可压缩，但不可删

**质疑（红队原始怀疑）**：18 modifier 用例（ctrl/alt/shift/super × 4 方向 + 2 组合）对单文件改动是否过度防御？modifier 泄漏是真实复现还是理论？

**Deletion test 结论**：**保留全部 modifier 覆盖，但建议用参数化压缩实现。**

证据（红队自查，非引用设计文档）：
- 现有 `handleEditorInput`（component.ts:334-404）对 `alt+x`（`\x1bx`）的真实路径：`matchesKey(data,"escape"|"enter"|"backspace")` 三判全 false → 落入 `for (const c of cleaned)` → `\x1b` 被 `c >= " "` 滤掉，但 `x` 满足 `c >= " "` → **追加进 editorText**。
- 即 **modifier 泄漏是真实可复现的 bug**，不是理论风险。D-002 rationale（"不覆盖则 alt+x 仍泄漏可见字符 x，未根治"）成立。

但 18 条独立 test case 是**实现层面的冗余**，不是**覆盖面的冗余**：
- 测试要验证的核心契约只有一条：`parseKey` 命中任意带 modifier 的 keyId（非 undefined）→ 走 special 分支 no-op，不进 printable 追加。
- 4 个方向键 × 4 modifier 的笛卡尔积里，`parseKey` 的拦截路径是**同一段代码**（骨架 handleEditorInput 的 `return` 那行）。18 条断言测的是同一条分支。
- 真正有覆盖增量的是 **modifier 种类**（ctrl/alt/shift/super 各 1 条验证 keyId 前缀格式不同时 parseKey 仍命中）+ **2-mod 组合**（验证 `ctrl+shift+` 这种复合前缀 parseKey 仍解析），共 ~6 条足矣。

**建议**：实现时用 `describe.each` / `it.each` 把 18 用例压成 1 个参数化表（fixtures 里给数组，test 里循环断言）。验收清单（AC-5.3）照常算 18 覆盖，但代码行数从 18 × ~8 行降到 ~15 行。**不强制**——若 implementer 觉得 18 条显式 case 更可读，可保留，不构成 should_fix。

**类型**：过度设计（轻微，实现层而非设计层）。**不阻断**。

### SF-2 [过度设计·轻微]：3 张时序图可删 1 张，但当前的 3 张各自有价值

**质疑**：时序图1（parseKey 拦截）+ 时序图2（多字符粘贴）+ 时序图3（分流预填），对 3 文件改动是否 mermaid 过重？

**Deletion test**：
- **删时序图2（多字符粘贴）**：时序图1 的 `parseKey === undefined → printable 提取` 分支已经把这条路径画进去了（时序图1 的 else 分支）。时序图2 把同一段 printable 提取逻辑再画一遍 + 加 emoji/控制字符 alt。**重复度最高**。但——时序图2 唯一独占的是「emoji 代理对 for...of 迭代」的注释框，而这一点在 BC-2 + C-PASTE-2 里已锁。删掉时序图2，C-PASTE 回归测试 + BC-2 契约不变，无信息损失。
- **删时序图3（分流预填）**：失去 freeform vs comment 入口预填的分流视觉。D-2「禁 fallback 链」是 review MF-1 证伪后的关键约束，时序图3 的两个 alt 分支（freeform 读 freeTextValue / comment 读 commentValue）是这条约束的可视化锚点。**删不得**。
- **删时序图1（parseKey 拦截）**：这是 #1 核心 bug 修复的主路径，三态路由（语义键/单字符/special no-op）全在这图里。**删不得**。

**建议**：可删时序图2，内容并入时序图1 的 `parseKey===undefined` 分支注释（已基本如此）。收益小（少一张 mermaid），不强制。**当前 3 张不算比例失当**——bug 修复 + 行为等价 refactor + 数据迁移三类路径各一张，信息密度合理。

**类型**：过度设计（极轻微，文档美观度）。**不阻断**。

### SF-3 [比例性]：骨架 360 行 component.ts 偏重，但骨架价值成立

**质疑**：4 骨架文件 + 独立 tsconfig 验证一个 bug 修复，骨架 360 行 component.ts 是否过重？骨架验证的核心价值（parseKey import 可达、draftText 字段自洽）是否值得？

**Deletion test**：
- **删整个骨架**：mid tier 流程要求骨架（CW gate 强制）。不能删。
- **骨架里大量 `throw new Error("SKELETON...")` 占位**：9 处叶子 throw（renderTabBar/renderButtonBar/handleOptionsInput/handleSubmitTabInput/toggleIndex/autoConfirmIfAnswered/escBackOrConfirm/advance + handleEditorInput 的 escape/enter 两分支）。**这些 throw 是否说明骨架价值低于声明？**

关键判断：骨架的接线密度不均匀——
- **高价值接线**（真实调用链，非 throw）：constructor→createQuestionState、render→renderQuestionView(透传 state.draftText)、handleInput 三 handler 分发、handleEditorInput 的 parseKey 四态路由（**含单字符追加 + special no-op 的真实分支逻辑**）、afterConfirm 分流预填、gotoTab/cancel/submit。这部分 ~63 处 `this.` 真实调用，是 Tier 2「parseKey import 可达 + draftText 字段自洽」证伪的真实载体。**删不得**。
- **低价值 throw**：renderTabBar/renderButtonBar/toggleIndex 等不变方法，骨架复制了签名 + throw。这部分是为「签名表逐行覆盖」服务，tsc 层面它们不验证任何新接线（全是原样方法）。

**建议（可选瘦身，不阻断）**：骨架可删去不变方法的 throw 占位（renderTabBar/renderButtonBar/toggleIndex/autoConfirmIfAnswered/escBackOrConfirm/advance/handleSubmitTabInput），只保留**本次改动的接线方法**（handleInput 拆分后路由 / handleEditorInput parseKey 四态 / afterConfirm 分流预填 / render 透传 draftText / constructor 初始化）。骨架从 360 行降到 ~180 行，核心价值（parseKey import 可达 + draftText 接线）不变。但若骨架已通过 `tsc --noEmit` 且交付，重写收益低于风险，**建议 implementer 知晓即可，不回改**。

**类型**：比例性（骨架密度可优化）。**不阻断**。

---

## 对 D-004 / D-006 的红队质疑（[REVISIT]）

### [REVISIT of D-004] handleInput 拆分是否超出 bug 修复范围？

**红队结论：拆分必要，不超范围。质疑不成立。**

设计文档称「现有 handleInput ~80 行踩 CLAUDE.md 行数上限边缘」。红队实测（component.ts:188-330）：**handleInput 实际 143 行**（含 options 分支内联），远超 80 行限制。设计文档的「~80 行」描述**低估了实际行数**（可能只算了纯路由部分，漏了 options 内联逻辑）。

但结论方向正确：handleInput 确实超限，拆分是规范遵守，不是顺手过头。D-004 confirmed 合理。

**附带发现（F 类，非过度设计）**：issues.md #3 / code-architecture §3 称「现有 handleInput ~80 行」与实测 143 行不符。建议 implementer/dev 阶段订正描述（不影响决策，D-004 仍成立——143 行比 80 行更需要拆）。不阻断。

### [REVISIT of D-006] 编辑器提示行是否 YAGNI？

**红队结论：不 YAGNI，但证据链可加强。质疑部分成立。**

D-006 confirmed_by=`ask_user`，用户拍板。mid-plan 已 ask_user，流程合规。红队可质疑的是**证据强度**：

- 提示行的理由是「方向键修复后是 no-op，提示行避免用户困惑」。这个 UX 论证成立——append-only 编辑器里按方向键无任何视觉反馈，用户会以为键盘坏了，提示行是合理的 discoverability 兜底。
- 但 G4（requirements）的优先级与 bug 修复（G1/G2）耦合在同一个主题里，**提示行严格说是独立 feature，不是 bug 修复的一部分**。若极致反过度设计，可 argue 提示行应拆独立 topic。

**红队不坚持拆分**：提示行改动极小（question-view.ts help 行扩文案，纯渲染，无状态），与 draftText 迁移（#2）共享 question-view.ts 改动面，拆独立 topic 反而增加跨 topic 的文件冲突。合并到本主题的边际成本 < 拆分的协调成本。D-006 成立。

**类型**：D-可逆（若用户后续认为提示行多余，可砍 #4，不影响 #1/#2/#3/#5）。当前不砍。

---

## 保留理由（哪些删不得）

以下 5 项经 deletion test 判定为「删掉则 bug 不修复或契约失守」，红队**反对删除**：

1. **#1 parseKey 拦截（issues #1）**：删掉 → 方向键/功能键/modifier 泄漏 bug 复现（实测 alt+x 泄漏 x）。核心。删不得。
2. **#2 draftText 归位（issues #2）**：删掉 → editorText 维持组件级单实例，违反 CLAUDE.md 会话隔离（D-001 rationale 的架构债）。虽不阻塞单 session，但 D-001 是 D-不可逆的架构归位决策。删不得。
3. **骨架的 parseKey import 真引 SDK**：删掉（改 throw）→ Tier 2「parseKey import 可达」证伪失效，SDK 路径解析无 tsc 兜底，SDK 升级换导出名时静默断链。删不得。
4. **骨架的 handleEditorInput 四态路由接线**：删掉（改 throw）→ 单字符 printable 追加 vs special no-op 的关键区分无骨架验证，`parseKey("a")==="a"` 这个 SDK 返回语义（code-architecture §1 实测修正）无接线锚点。删不得。
5. **分流预填（禁 fallback 链）+ BC-4c 回改测试（C-BC4C）**：删 fallback 链禁令 → review MF-1 证伪的回改污染场景（commentValue 预填进 freeform）复现。C-BC4C 是补现有测试盲区。删不得。

---

## 汇总

| 项 | 类型 | 处置 |
|----|------|------|
| SF-1 C-KEYMAP-MOD 18 用例 | 过度设计（轻微，实现层） | 建议参数化压缩，不强制 |
| SF-2 时序图2 多字符粘贴 | 过度设计（极轻微，文档） | 可删，收益小，不强制 |
| SF-3 骨架 360 行 + 9 throw | 比例性 | 可瘦身，已交付不回改 |
| [REVISIT D-004] handleInput 拆分 | — | 质疑不成立（实测 143 行），D-004 confirmed 合理 |
| [REVISIT D-006] 提示行 YAGNI | D-可逆 | 质疑部分成立（证据可加强），不坚持拆分 |
| F-1 issues #3「~80 行」描述 | F | 与实测 143 行不符，建议 dev 阶段订正 |
| parseKey 拦截 / draftText 归位 / 骨架核心接线 / 分流预填 | — | 删不得，红队反对删除 |

**Verdict: APPROVED。** 可进入 dev 阶段。无阻断性过度设计。3 项 should_fix 为可选优化，implementer 自行裁量。
